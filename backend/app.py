"""
Amibrave — Flask Application Entry Point
Handles routing, bounded upload validation, concurrent request limiting,
question-image rendering, and CORS.
"""

import os
import base64
import logging
import threading
import tempfile
from pathlib import Path
from datetime import datetime, timezone
from functools import wraps

from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv

from errors import (
    err_file_notuploaded,
    err_file_too_large,
    err_invalid_pdf,
    err_too_many_requests,
    err_server,
    err_image_render_failed,
    warn_file_near_limit,
)
from parser import extract_questions
from image_renderer import render_question_images, ImageRenderError

load_dotenv()
# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

load_dotenv()
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# CORS — whitelist your GitHub Pages domain and localhost for development
allowed_origins = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
]

CORS(app, 
    origins=allowed_origins,
    supports_credentials=False
    )

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MAX_FILE_SIZE_MB    = 10
WARN_FILE_SIZE_MB   = 8
MAX_CONCURRENT      = 3          # Per Gunicorn worker process
DEFAULT_RENDER_DPI  = 150
app.config["MAX_CONTENT_LENGTH"] = MAX_FILE_SIZE_MB * 1024 * 1024

_active_requests    = 0
_lock               = threading.Lock()

VERSION             = "1.2.0"

# ---------------------------------------------------------------------------
# Decorators
# ---------------------------------------------------------------------------

def with_concurrency_limit(f):
    """Reject requests when too many are already being processed."""
    @wraps(f)
    def decorated(*args, **kwargs):
        global _active_requests
        with _lock:
            if _active_requests >= MAX_CONCURRENT:
                body, status = err_too_many_requests()
                return jsonify(body), status
            _active_requests += 1
        try:
            return f(*args, **kwargs)
        finally:
            with _lock:
                _active_requests -= 1
    return decorated


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def validate_pdf_upload(field_name: str = "file") -> tuple:
    """
    Validate uploaded PDF file.
    Returns (pdf_bytes, warnings, error_response) where error_response
    is (dict, status) if invalid, else None.
    """
    if field_name not in request.files:
        body, status = err_file_notuploaded()
        return None, [], (jsonify(body), status)

    file = request.files[field_name]

    if not file.filename or not file.filename.lower().endswith(".pdf"):
        body, status = err_invalid_pdf()
        return None, [], (jsonify(body), status)

    # Read at most one byte beyond the configured limit. This prevents an
    # oversized upload from being fully copied into application memory.
    pdf_bytes = file.stream.read(MAX_FILE_SIZE_MB * 1024 * 1024 + 1)
    size_mb   = len(pdf_bytes) / (1024 * 1024)

    if size_mb > MAX_FILE_SIZE_MB:
        body, status = err_file_too_large(size_mb)
        return None, [], (jsonify(body), status)

    upload_warnings = []
    if size_mb >= WARN_FILE_SIZE_MB:
        upload_warnings.append(warn_file_near_limit(size_mb))

    # Basic PDF magic bytes check
    if not pdf_bytes.startswith(b"%PDF"):
        body, status = err_invalid_pdf()
        return None, [], (jsonify(body), status)

    return pdf_bytes, upload_warnings, None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/health", methods=["GET"])
def health():
    """
    GET /health
    Returns server status, version, active request count, and timestamp.
    """
    return jsonify({
        "status"        : "ok",
        "version"       : VERSION,
        "active_requests": _active_requests,
        "max_concurrent": MAX_CONCURRENT,
        "timestamp"     : datetime.now(timezone.utc).isoformat()
    }), 200


@app.route("/extract", methods=["POST"])
@with_concurrency_limit
def extract():
    """
    POST /extract
    Body: multipart/form-data with field 'file' (PDF)
    Returns: structured question JSON
    """
    pdf_bytes, upload_warnings, error = validate_pdf_upload("file")
    if error:
        return error

    logger.info(f"Starting /extract — file size: {len(pdf_bytes) / 1024:.1f}KB")

    response_body, status = extract_questions(pdf_bytes)

    if status == 200 and upload_warnings:
        response_body.setdefault("warnings", [])
        response_body["warnings"] = upload_warnings + response_body["warnings"]

    return jsonify(response_body), status


@app.route("/api/exams/process", methods=["POST"])
@with_concurrency_limit
def process_exam():
    """Extract questions and return their page-region images in one response.

    Image bytes are transported as base64 for this request only. The frontend
    should decode them to Blob objects and persist those Blobs in IndexedDB.
    No exam files or images are retained on the server after the request.
    """
    pdf_bytes, upload_warnings, error = validate_pdf_upload("file")
    if error:
        return error

    response_body, status = extract_questions(pdf_bytes)
    if status != 200 or not response_body.get("success"):
        return jsonify(response_body), status

    question_regions = response_body.get("question_regions", [])
    if not question_regions:
        body, error_status = err_image_render_failed()
        return jsonify(body), error_status

    try:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir) 
            pdf_path = temp_path / "source.pdf"
            image_dir = temp_path / "question-images"
            pdf_path.write_bytes(pdf_bytes)

            rendered = render_question_images(
                    pdf_path=pdf_path,
                    question_regions=question_regions,
                    output_dir=image_dir,
                    dpi=DEFAULT_RENDER_DPI,
            )

            images = []
            for item in rendered:
                image_bytes = Path(item["path"]).read_bytes()
                images.append({
                        "question_number": item["question_number"],
                        "part": item["part"],
                        "page_number": item["page_number"],
                        "width": item["width"],
                        "height": item["height"],
                        "format": item["format"],
                        "mime_type": item["mime_type"],
                        "data": base64.b64encode(image_bytes).decode("ascii"),
                })

        response_body["images"] = images
        response_body["meta"]["rendered_image_count"] = len(images)
        response_body["meta"]["render_dpi"] = DEFAULT_RENDER_DPI
        if upload_warnings:
            response_body.setdefault("warnings", [])
            response_body["warnings"] = upload_warnings + response_body["warnings"]

        return jsonify(response_body), 200

    except (ImageRenderError, OSError) as error:
        logger.exception("Question image rendering failed: %s", error)
        body, error_status = err_image_render_failed()
        return jsonify(body), error_status


@app.route("/extract-key", methods=["POST"])
@with_concurrency_limit
def extract_key():
    """
    POST /extract-key
    Body: multipart/form-data with field 'file' (PDF answer key)
    Returns: answer key JSON mapping question numbers to answers
    """
    pdf_bytes, upload_warnings, error = validate_pdf_upload("file")
    if error:
        return error

    logger.info(f"Starting /extract-key — file size: {len(pdf_bytes) / 1024:.1f}KB")

    response_body, status = extract_answer_key(pdf_bytes)

    if status == 200 and upload_warnings:
        response_body.setdefault("warnings", [])
        response_body["warnings"] = upload_warnings + response_body["warnings"]

    return jsonify(response_body), status


# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------

@app.errorhandler(404)
def not_found(e):
    return jsonify({
        "success": False,
        "error"  : {
            "code"   : "ERR_404",
            "message": "Endpoint not found.",
            "detail" : "Available endpoints: GET /health, POST /extract, POST /api/exams/process, POST /extract-key."
        }
    }), 404


@app.errorhandler(405)
def method_not_allowed(e):
    return jsonify({
        "success": False,
        "error"  : {
            "code"   : "ERR_405",
            "message": "Method not allowed.",
            "detail" : "Check the HTTP method for this endpoint. See API.md for details."
        }
    }), 405


@app.errorhandler(413)
def request_too_large(e):
    body, status = err_file_too_large(MAX_FILE_SIZE_MB + 1)
    return jsonify(body), status


@app.errorhandler(500)
def internal_error(e):
    body, status = err_server(str(e))
    return jsonify(body), status


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    debug = os.getenv("FLASK_ENV", "production") == "development"
    logger.info(f"Amibrave backend starting on port {port} (debug={debug})")
    app.run(host="0.0.0.0", port=port, debug=debug)