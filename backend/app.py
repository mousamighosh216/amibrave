"""
Amibrave — Flask Application Entry Point
Handles routing, request validation, timeout enforcement,
concurrent request limiting, and CORS.
"""

import os
import logging
import threading
from datetime import datetime
from functools import wraps

from flask import Flask, request, jsonify, send_file
import io
from flask_cors import CORS
from dotenv import load_dotenv

from errors import (
    err_file_too_large, err_invalid_pdf, err_timeout,
    err_too_many_requests, err_server,
    warn_file_near_limit
)
from parser import extract_questions, extract_answer_key
from pdf_generator import generate_pdf

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
ALLOWED_ORIGINS = os.getenv(
    "ALLOWED_ORIGINS",
    "http://localhost:5500,http://127.0.0.1:5500,https://yourusername.github.io"
).split(",")

CORS(app, origins=ALLOWED_ORIGINS, supports_credentials=False)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MAX_FILE_SIZE_MB    = 10
WARN_FILE_SIZE_MB   = 8
REQUEST_TIMEOUT_SEC = 60
MAX_CONCURRENT      = 3          # Max simultaneous PDF processing requests

_active_requests    = 0
_lock               = threading.Lock()

VERSION             = "1.0.0"

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


def with_timeout(f):
    """
    Run the handler in a thread and enforce REQUEST_TIMEOUT_SEC.
    Returns ERR_009 if processing exceeds the limit.
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        result: list[object | None] = [None]
        exception: list[Exception | None] = [None]

        def target():
            try:
                result[0] = f(*args, **kwargs)
            except Exception as e:
                exception[0] = e

        thread = threading.Thread(target=target)
        thread.start()
        thread.join(timeout=REQUEST_TIMEOUT_SEC)

        if thread.is_alive():
            logger.warning(f"Request timeout after {REQUEST_TIMEOUT_SEC}s")
            body, status = err_timeout()
            return jsonify(body), status

        if exception[0]:
            logger.error(f"Unhandled exception: {exception[0]}")
            body, status = err_server(str(exception[0]))
            return jsonify(body), status

        return result[0]
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
        body, status = err_invalid_pdf()
        return None, [], (jsonify(body), status)

    file = request.files[field_name]

    if not file.filename or not file.filename.lower().endswith(".pdf"):
        body, status = err_invalid_pdf()
        return None, [], (jsonify(body), status)

    pdf_bytes = file.read()
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
        "timestamp"     : datetime.utcnow().isoformat()
    }), 200


@app.route("/extract", methods=["POST"])
@with_concurrency_limit
# @with_timeout // not working with this
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


@app.route("/extract-key", methods=["POST"])
@with_concurrency_limit
# @with_timeout
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
# PDF generation endpoint
# ---------------------------------------------------------------------------

@app.route("/generate-pdf", methods=["POST"])
@with_concurrency_limit
@with_timeout
def generate_pdf_route():
    """
    POST /generate-pdf
    Body: JSON payload with questions, answers, marked, statuses,
          marking, customMarks, timeTaken
    Returns: PDF file download
    """
    if not request.is_json:
        body, status = err_server("Request must be JSON with Content-Type: application/json")
        return jsonify(body), status

    payload = request.get_json(silent=True)
    if not payload:
        body, status = err_server("Empty or invalid JSON payload")
        return jsonify(body), status

    questions = payload.get("questions", [])
    if not questions:
        body, status = err_server("No questions in payload")
        return jsonify(body), status

    logger.info(f"Generating PDF: {len(questions)} questions")

    pdf_bytes, error = generate_pdf(payload)

    if error:
        body, status = err_server(f"PDF generation failed: {error}")
        return jsonify(body), status

    return send_file(
        io.BytesIO(pdf_bytes),
        mimetype        = "application/pdf",
        as_attachment   = True,
        download_name   = f"amibrave_results_{__import__('datetime').datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf"
    )


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
            "detail" : f"No route matches the requested URL. Available: GET /health, POST /extract, POST /extract-key"
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