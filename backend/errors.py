"""
Amibrave — Error & Warning Definitions
All application-level errors and warnings are defined here.
Import this module in any file that needs to raise or return errors.
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
# ERRORS — Fatal, terminate processing and return to client
# ---------------------------------------------------------------------------

def err_file_too_large(size_mb: float):
    """ERR_001 — Uploaded file exceeds the 10MB limit."""
    return _base(
        "ERR_001",
        "File too large.",
        f"Uploaded file is {size_mb:.2f}MB. Maximum allowed size is 10MB. "
        "Compress the PDF or split it into smaller parts.",
        413
    )


def err_invalid_pdf():
    """ERR_002 — File is not a valid PDF."""
    return _base(
        "ERR_002",
        "Invalid file format.",
        "The uploaded file could not be read as a PDF. "
        "Ensure the file is a valid .pdf document and is not corrupted.",
        415
    )


def err_password_protected():
    """ERR_003 — PDF is password protected."""
    return _base(
        "ERR_003",
        "PDF is password protected.",
        "Amibrave cannot read encrypted or password-protected PDFs. "
        "Remove the password protection and re-upload.",
        422
    )


def err_no_pages():
    """ERR_004 — PDF has no pages."""
    return _base(
        "ERR_004",
        "PDF appears to be empty.",
        "The uploaded PDF contains no readable pages. "
        "Verify the file is complete and not corrupted.",
        422
    )


def err_unreadable_file(pages_checked: int, total_pages: int):
    """ERR_005 — 30% threshold hit, file is unreadable."""
    return _base(
        "ERR_005",
        "File could not be parsed.",
        f"Amibrave sampled {pages_checked} of {total_pages} pages and could not "
        "extract any readable question data. The PDF may be entirely image-based "
        "with no embedded text. Try a digitally-created PDF for best results.",
        422
    )


def err_gemini_failed(page_num: int, reason: str):
    """ERR_006 — Gemini API failed on a specific fallback page."""
    return _base(
        "ERR_006",
        "AI fallback failed.",
        f"Gemini could not process page {page_num}. Reason: {reason}. "
        "Check your Gemini API key or try again.",
        502
    )


def err_gemini_quota():
    """ERR_007 — Gemini API quota exceeded."""
    return _base(
        "ERR_007",
        "AI quota exceeded.",
        "The Gemini API free-tier quota has been reached. "
        "Wait a few minutes and try again, or check your quota at "
        "https://aistudio.google.com.",
        429
    )


def err_blank_pdf():
    """ERR_008 — All pages returned empty text."""
    return _base(
        "ERR_008",
        "PDF contains no text.",
        "Every page in the uploaded PDF returned empty content. "
        "The file may be a blank document or contain only non-extractable elements.",
        422
    )


def err_timeout():
    """ERR_009 — Request exceeded 60 second processing limit."""
    return _base(
        "ERR_009",
        "Processing timed out.",
        "The PDF took longer than 60 seconds to process. "
        "Try a smaller file or a PDF with fewer pages.",
        504
    )


def err_too_many_requests():
    """ERR_010 — Server is busy, concurrent request limit hit."""
    return _base(
        "ERR_010",
        "Server is busy.",
        "Amibrave is currently processing another request. "
        "Please wait a moment and try again.",
        429
    )


def err_server(detail: str):
    """ERR_011 — Unexpected internal server error."""
    return _base(
        "ERR_011",
        "Internal server error.",
        f"An unexpected error occurred: {detail}. "
        "If this persists, check server logs or file an issue.",
        500
    )


# ---------------------------------------------------------------------------
# WARNINGS — Non-fatal, attached to successful responses
# ---------------------------------------------------------------------------

def warn_file_near_limit(size_mb: float) -> dict:
    """WARN_001 — File is between 8MB and 10MB."""
    return _warn(
        "WARN_001",
        "File is close to the size limit.",
        f"File size is {size_mb:.2f}MB (limit: 10MB). "
        "Processing will continue, but consider compressing for faster uploads."
    )


def warn_pages_skipped(skipped: list[int]) -> dict:
    """WARN_002 — Some pages could not be processed and were skipped."""
    pages = ", ".join(str(p) for p in skipped)
    return _warn(
        "WARN_002",
        f"{len(skipped)} page(s) were skipped.",
        f"Pages {pages} could not be parsed and were excluded from results. "
        "These pages may be image-only or contain unsupported content."
    )


def warn_low_confidence(pages: list[int]) -> dict:
    """WARN_003 — Some pages parsed but with low confidence."""
    pg = ", ".join(str(p) for p in pages)
    return _warn(
        "WARN_003",
        f"Low confidence parse on {len(pages)} page(s).",
        f"Pages {pg} were parsed but may contain errors. "
        "Review these questions carefully in the preview editor."
    )


def warn_answer_key_partial(matched: int, total: int) -> dict:
    """WARN_004 — Answer key only partially matched question numbers."""
    return _warn(
        "WARN_004",
        "Answer key partially matched.",
        f"Only {matched} of {total} questions were matched in the answer key. "
        "Unmatched questions will not be auto-scored. "
        "Verify the answer key format uses matching question numbers."
    )
