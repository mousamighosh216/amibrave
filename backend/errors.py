"""
Amibrave — Error & Warning Definitions
All application-level errors and warnings are defined here.
"""

from datetime import datetime


# ---------------------------------------------------------------------------
# Base response builders
# ---------------------------------------------------------------------------

def _base(code: str, message: str, detail: str, http_status: int) -> tuple[dict, int]:
    return {
        "success": False,
        "error": {
            "code": code,
            "message": message,
            "detail": detail,
            "timestamp": datetime.utcnow().isoformat()
        }
    }, http_status


def _warn(code: str, message: str, detail: str) -> dict:
    return {
        "code": code,
        "message": message,
        "detail": detail,
        "timestamp": datetime.utcnow().isoformat()
    }


# ---------------------------------------------------------------------------
# Canonical README error contract
# ---------------------------------------------------------------------------

def err_file_notuploaded(size_mb: float | None = None):
    """ERR_001 — No file uploaded."""
    return _base(
        "ERR_001",
        "No file uploaded.",
        "No file was uploaded in the request. Ensure the form field is named 'file' and contains a valid PDF.",
        400,
    )


def err_invalid_pdf():
    """ERR_002 — File is not a valid PDF."""
    return _base(
        "ERR_002",
        "Invalid file format.",
        "The uploaded file could not be read as a PDF. Ensure the file is a valid .pdf document and is not corrupted.",
        415,
    )


def err_pdf_maxsize(size_mb: float | None = None):
    """ERR_003 — PDF exceeds maximum size."""
    size_text = f" Detected size: {size_mb:.2f}MB." if size_mb is not None else ""
    return _base(
        "ERR_003",
        "PDF exceeds maximum size.",
        f"The uploaded PDF is larger than the allowed limit of 10MB.{size_text}",
        422,
    )


def err_file_too_large(size_mb: float | None = None):
    """Compatibility alias for the file-size error contract."""
    return err_pdf_maxsize(size_mb)


def err_pdf_corrupted():
    """ERR_004 — Corrupted or unreadable PDF."""
    return _base(
        "ERR_004",
        "Corrupted or unreadable PDF.",
        "The uploaded PDF contains no readable pages. Verify the file is complete and not corrupted.",
        422,
    )


def err_no_extractable_questions():
    """ERR_005 — No extractable questions detected."""
    return _base(
        "ERR_005",
        "No extractable questions detected.",
        "Amibrave could not identify enough readable question content to generate a valid exam. "
        "Try a cleaner PDF or check whether the file is image-only or structurally unsupported.",
        422,
    )


def err_unreadable_file(pages_checked: int, total_pages: int):
    """Compatibility alias for unreadable extraction failures."""
    return _base(
        "ERR_005",
        "No extractable questions detected.",
        f"Amibrave sampled {pages_checked} of {total_pages} pages and could not extract any readable question data. "
        "The PDF may be entirely image-based or contain unsupported structure.",
        422,
    )


def err_question_boundaries_unidentified():
    """ERR_006 — Question boundaries could not be identified."""
    return _base(
        "ERR_006",
        "Question boundaries could not be identified.",
        "The document structure is too unclear to reliably separate questions and options. "
        "Try a cleaner scan or use image-first/manual boundary review.",
        422,
    )


def err_image_render_failed():
    """ERR_007 — Image rendering failed."""
    return _base(
        "ERR_007",
        "Image rendering failed.",
        "Amibrave could not render the required question image region from the PDF. "
        "Check whether the page content is valid and supported by the current renderer.",
        500,
    )


def err_unsupported_question_structure():
    """ERR_008 — Unsupported question structure."""
    return _base(
        "ERR_008",
        "Unsupported question structure.",
        "The uploaded PDF contains a question layout that cannot be processed safely by the current parser.",
        422,
    )


def err_invalid_examination_submission():
    """ERR_009 — Invalid examination submission."""
    return _base(
        "ERR_009",
        "Invalid examination submission.",
        "The submitted examination payload is incomplete or invalid. Verify required fields and answer data before submitting.",
        400,
    )


def err_server(detail: str):
    """Generic fallback internal error for unexpected application failures."""
    return _base(
        "ERR_011",
        "Internal server error.",
        f"An unexpected error occurred: {detail}. If this persists, check server logs or file an issue.",
        500,
    )


def err_timeout():
    """Compatibility timeout response retained for backend request limits."""
    return _base(
        "ERR_009",
        "Processing timed out.",
        "The PDF took longer than 60 seconds to process. Try a smaller file or a PDF with fewer pages.",
        504,
    )


def err_too_many_requests():
    """Compatibility concurrency limit response retained for request throttling."""
    return _base(
        "ERR_010",
        "Server is busy.",
        "Amibrave is currently processing another request. Please wait a moment and try again.",
        429,
    )


# ---------------------------------------------------------------------------
# README warning contract
# ---------------------------------------------------------------------------

def warn_page_contains_no_text() -> dict:
    """WARN_001 — Page contains no extractable text."""
    return _warn(
        "WARN_001",
        "Page contains no extractable text.",
        "This page has no usable extracted text and may need to be treated as image-first content."
    )


def warn_question_displayed_using_image() -> dict:
    """WARN_002 — Question is displayed using original image."""
    return _warn(
        "WARN_002",
        "Question is displayed using original image.",
        "The question was rendered from the original PDF image because extracted text was incomplete or unreliable."
    )


def warn_question_requires_manual_boundary_verification() -> dict:
    """WARN_003 — Question requires manual boundary verification."""
    return _warn(
        "WARN_003",
        "Question requires manual boundary verification.",
        "The parser could not confidently determine the exact region boundaries and a manual check may be required."
    )


def warn_visual_content_requires_image_first() -> dict:
    """WARN_004 — Mathematical or visual content may require image-first mode."""
    return _warn(
        "WARN_004",
        "Mathematical or visual content may require image-first mode.",
        "The content may rely on diagrams, equations, or formatting that is clearer when displayed as an original image."
    )


def warn_answer_key_unavailable() -> dict:
    """WARN_005 — Answer key unavailable; automatic scoring disabled."""
    return _warn(
        "WARN_005",
        "Answer key unavailable; automatic scoring disabled.",
        "No answer key was provided or matched, so automatic correctness scoring is disabled."
    )


# ---------------------------------------------------------------------------
# Backwards-compatible legacy aliases kept for existing callers
# ---------------------------------------------------------------------------

def warn_file_near_limit(size_mb: float) -> dict:
    """Legacy alias for WARN_001-style soft warning."""
    return _warn(
        "WARN_001",
        "Page contains no extractable text.",
        f"File size is {size_mb:.2f}MB and may be close to the practical limit for reliable parsing."
    )


def warn_pages_skipped(skipped: list[int]) -> dict:
    """Legacy alias for image-first fallback warnings."""
    pages = ", ".join(str(p) for p in skipped)
    return _warn(
        "WARN_002",
        "Question is displayed using original image.",
        f"Pages {pages} could not be parsed and were handled using the original image workflow."
    )


def warn_low_confidence(pages: list[int]) -> dict:
    """Legacy alias for manual verification reminders."""
    pg = ", ".join(str(p) for p in pages)
    return _warn(
        "WARN_003",
        "Question requires manual boundary verification.",
        f"Pages {pg} were parsed with low confidence and may require a manual review."
    )


def warn_answer_key_partial(matched: int, total: int) -> dict:
    """Legacy alias for answer-key warning."""
    return _warn(
        "WARN_005",
        "Answer key unavailable; automatic scoring disabled.",
        f"Only {matched} of {total} questions were matched in the answer key. Automatic scoring has been disabled."
    )


def err_password_protected():
    """Compatibility alias for encrypted PDFs."""
    return _base(
        "ERR_004",
        "Corrupted or unreadable PDF.",
        "The uploaded PDF is encrypted or protected by a password and cannot be processed without removing the password.",
        422,
    )


def err_no_pages():
    """Compatibility alias for empty document handling."""
    return err_no_extractable_questions()


def err_blank_pdf():
    """Compatibility alias for empty-text extraction failure."""
    return err_no_extractable_questions()

