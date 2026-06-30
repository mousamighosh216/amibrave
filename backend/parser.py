"""
Amibrave — Adaptive PDF Parser
Implements the full adaptive parsing strategy:
  Sequential → Random sampling → Resume sequential → Gemini fallback → ERR_005
"""

import re
import random
import logging
from typing import Optional

import pdfplumber
import fitz  # PyMuPDF — used for page-to-image conversion for Gemini
from PIL import Image
import io

from errors import (
    err_invalid_pdf, err_password_protected, err_no_pages,
    err_unreadable_file, err_blank_pdf,
    warn_pages_skipped, warn_low_confidence, warn_answer_key_partial
)
from gemini import should_use_gemini, extract_page_with_gemini, init_gemini

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

THRESHOLD_RATIO        = 0.30   # 30% of pages must yield data before termination
RANDOM_SAMPLE_COUNT    = 6      # Pages to sample when page 1 fails
MIN_QUESTIONS_PER_PAGE = 1      # Minimum questions to consider a page "successful"


# ---------------------------------------------------------------------------
# Text quality helpers
# ---------------------------------------------------------------------------

def _clean_char_count(text: str) -> int:
    return len([c for c in text if c.isalnum() or c in " .,;:?!()-+=/"])


def _is_page_relevant(text: str) -> bool:
    """
    A page is relevant if it contains at least one question-like pattern
    and has enough clean characters.
    """
    if not text or _clean_char_count(text) < 50:
        return False
    patterns = [
        r"\b(?:Q\.?\s*)?\d+[\.\)]\s",
        r"\([A-Da-d]\)\s",
        r"[A-Da-d][\.\)]\s",
        r"\(Q\.\s*\d+\)",
    ]
    return any(re.search(p, text) for p in patterns)


# ---------------------------------------------------------------------------
# Question regex parser
# ---------------------------------------------------------------------------

def _parse_text_to_questions(text: str, page_num: int) -> tuple[list[dict], list[str]]:
    """
    Parse raw extracted text into structured question dicts.
    Returns (questions, warnings).
    """
    questions  = []
    warnings   = []
    full_text  = "\n".join(line.strip() for line in text.splitlines() if line.strip())

    # Try multiple question numbering patterns in priority order
    q_patterns = [
        r"(?:^|\n)\s*Q\.?\s*(\d+)\s*[\.\)]\s*",
        r"(?:^|\n)\s*(\d+)\s*[\.\)]\s*",
        r"(?:^|\n)\s*\((\d+)\)\s*",
    ]

    matches = []
    for pat in q_patterns:
        found = [(m.start(), int(m.group(1)), m.end()) for m in re.finditer(pat, full_text, re.MULTILINE)]
        if len(found) >= 1:
            matches = found
            break

    if not matches:
        warnings.append(f"Page {page_num}: No question patterns detected")
        return [], warnings

    for i, (start_idx, q_num, content_start) in enumerate(matches):
        content_end = matches[i + 1][0] if i + 1 < len(matches) else len(full_text)
        chunk       = full_text[content_start:content_end].strip()
        q, w        = _extract_single_question(chunk, q_num, page_num)
        warnings.extend(w)
        if q:
            questions.append(q)

    return questions, warnings


def _extract_single_question(chunk: str, num: int, page_num: int) -> tuple[Optional[dict], list[str]]:
    """Extract one question and its options from a text chunk."""
    warnings = []

    # Option patterns in priority order
    opt_patterns = [
        r"(?:^|\n)\s*\(([A-Da-d])\)\s*",
        r"(?:^|\n)\s*([A-Da-d])\.\s+",
        r"(?:^|\n)\s*([A-Da-d])\)\s+",
        r"(?:^|\n)\s*\(([1-4])\)\s*",
    ]

    opt_matches = []
    for pat in opt_patterns:
        found = [(m.start(), m.group(1).upper(), m.end()) for m in re.finditer(pat, chunk, re.MULTILINE)]
        if len(found) >= 2:
            opt_matches = found
            break

    q_text  = chunk
    options = []
    q_type  = "nat"

    if len(opt_matches) >= 2:
        q_text = chunk[: opt_matches[0][0]].strip()
        for j, (o_start, label, o_content_start) in enumerate(opt_matches):
            o_end  = opt_matches[j + 1][0] if j + 1 < len(opt_matches) else len(chunk)
            o_text = chunk[o_content_start:o_end].strip()
            if o_text:
                options.append({"label": label, "text": o_text[:300]})
        if len(options) >= 2:
            q_type = "mcq"

    if not q_text or len(q_text.strip()) < 5:
        warnings.append(f"Page {page_num}, Q{num}: Question text too short, skipped")
        return None, warnings

    if len(q_text) > 50 and _clean_char_count(q_text) / len(q_text) < 0.5:
        warnings.append(f"Page {page_num}, Q{num}: Low confidence — high garbled character ratio")

    return {
        "num"    : num,
        "text"   : q_text.strip()[:800],
        "type"   : q_type,
        "options": options,
        "source" : "pdfplumber"
    }, warnings


# ---------------------------------------------------------------------------
# Page-to-image for Gemini
# ---------------------------------------------------------------------------

def _page_to_image(pdf_bytes: bytes, page_index: int, dpi: int = 150) -> Image.Image:
    """Render a PDF page to a PIL Image using PyMuPDF."""
    doc  = fitz.open(stream=pdf_bytes, filetype="pdf")
    page = doc[page_index]
    mat  = fitz.Matrix(dpi / 72, dpi / 72)
    pix  = page.get_pixmap(matrix=mat)
    img  = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    doc.close()
    return img


# ---------------------------------------------------------------------------
# Main extraction entry point
# ---------------------------------------------------------------------------

def extract_questions(pdf_bytes: bytes) -> tuple[dict, int]:
    """
    Full adaptive extraction pipeline.
    Returns (response_dict, http_status).
    """
    # --- Validate PDF ---
    try:
        pdf = pdfplumber.open(io.BytesIO(pdf_bytes))
    except Exception as e:
        if "password" in str(e).lower() or "encrypt" in str(e).lower():
            return err_password_protected()
        return err_invalid_pdf()

    if pdf.metadata and pdf.metadata.get("encryption"):
        pdf.close()
        return err_password_protected()

    total_pages = len(pdf.pages)
    if total_pages == 0:
        pdf.close()
        return err_no_pages()

    logger.info(f"Starting extraction: {total_pages} pages")

    # --- Init Gemini (lazy, only used if needed) ---
    gemini_model  = None
    all_questions = []
    all_warnings  = []
    skipped_pages = []
    low_conf_pages= []

    # -----------------------------------------------------------------------
    # PHASE 1 — Sequential extraction starting from page 1
    # -----------------------------------------------------------------------
    page1_text = pdf.pages[0].extract_text() or ""
    page1_relevant = _is_page_relevant(page1_text)

    if page1_relevant:
        logger.info("Page 1 is relevant — starting sequential extraction")
        all_questions, all_warnings = _sequential_extract(
            pdf, pdf_bytes, total_pages, range(total_pages),
            gemini_model, skipped_pages, low_conf_pages
        )

    else:
        # -------------------------------------------------------------------
        # PHASE 2 — Page 1 failed, switch to random sampling
        # -------------------------------------------------------------------
        logger.info("Page 1 not relevant — switching to random sampling")

        skip_first_n = min(2, total_pages - 1)
        sample_pool  = list(range(skip_first_n, total_pages))
        sample_size  = min(RANDOM_SAMPLE_COUNT, len(sample_pool))
        sample_pages = sorted(random.sample(sample_pool, sample_size))

        first_hit    = None
        for page_idx in sample_pages:
            text = pdf.pages[page_idx].extract_text() or ""
            if _is_page_relevant(text):
                first_hit = page_idx
                logger.info(f"Random sampling hit on page {page_idx + 1}")
                break

        if first_hit is None:
            # ---------------------------------------------------------------
            # PHASE 3 — Random sampling also failed, check 30% threshold
            # ---------------------------------------------------------------
            checked = skip_first_n + sample_size
            if checked / total_pages >= THRESHOLD_RATIO:
                pdf.close()
                return err_unreadable_file(checked, total_pages)

            # Try Gemini on sampled pages as last resort
            logger.info("Random sampling found nothing — trying Gemini on samples")
            try:
                gemini_model = init_gemini()
            except Exception as e:
                logger.error(f"Gemini init failed: {e}")
                pdf.close()
                return err_unreadable_file(checked, total_pages)

            gemini_hit = False
            for page_idx in sample_pages:
                img    = _page_to_image(pdf_bytes, page_idx)
                qs, ws, fatal = extract_page_with_gemini(gemini_model, img, page_idx + 1)
                if fatal:
                    pdf.close()
                    return fatal
                if qs:
                    gemini_hit = True
                    all_questions.extend(qs)
                    all_warnings.extend(ws)
                else:
                    skipped_pages.append(page_idx + 1)
                    all_warnings.extend(ws)

            if not gemini_hit:
                pdf.close()
                return err_unreadable_file(checked, total_pages)

            # Gemini found data in samples — do full sequential with Gemini
            remaining = [i for i in range(total_pages) if i not in sample_pages]
            qs, ws = _sequential_extract(
                pdf, pdf_bytes, total_pages, remaining,
                gemini_model, skipped_pages, low_conf_pages
            )
            all_questions.extend(qs)
            all_warnings.extend(ws)

        else:
            # ---------------------------------------------------------------
            # PHASE 4 — Random hit found, resume sequential from first_hit
            # ---------------------------------------------------------------
            logger.info(f"Resuming sequential extraction from page {first_hit + 1}")
            resume_range = range(first_hit, total_pages)
            all_questions, all_warnings = _sequential_extract(
                pdf, pdf_bytes, total_pages, resume_range,
                gemini_model, skipped_pages, low_conf_pages
            )

    pdf.close()

    # --- Post-processing ---
    if not all_questions:
        return err_blank_pdf()

    # Deduplicate by question number (keep last seen — Gemini preferred)
    seen    = {}
    for q in all_questions:
        seen[q["num"]] = q
    unique_questions = list(seen.values())
    unique_questions.sort(key=lambda q: q["num"])

    # Build warnings list
    response_warnings = []
    if skipped_pages:
        response_warnings.append(warn_pages_skipped(skipped_pages))
    if low_conf_pages:
        response_warnings.append(warn_low_confidence(low_conf_pages))

    logger.info(f"Extraction complete: {len(unique_questions)} questions, {len(response_warnings)} warnings")

    return {
        "success"  : True,
        "questions": unique_questions,
        "meta"     : {
            "total_questions": len(unique_questions),
            "mcq_count"      : sum(1 for q in unique_questions if q["type"] == "mcq"),
            "nat_count"      : sum(1 for q in unique_questions if q["type"] == "nat"),
            "total_pages"    : total_pages,
            "skipped_pages"  : len(skipped_pages),
            "gemini_used"    : gemini_model is not None,
        },
        "warnings" : response_warnings
    }, 200


def _sequential_extract(
    pdf, pdf_bytes: bytes, total_pages: int,
    page_range,
    gemini_model,
    skipped_pages: list,
    low_conf_pages: list
) -> tuple[list[dict], list[str]]:
    """
    Sequentially extract questions from pages in page_range.
    Uses Gemini fallback per page when text quality is poor.
    Returns (questions, warnings).
    """
    questions = []
    warnings  = []

    for page_idx in page_range:
        try:
            text = pdf.pages[page_idx].extract_text() or ""
        except Exception as e:
            logger.warning(f"pdfplumber failed on page {page_idx + 1}: {e}")
            skipped_pages.append(page_idx + 1)
            warnings.append(f"Page {page_idx + 1}: pdfplumber extraction failed")
            continue

        use_gemini, reason = should_use_gemini(text)

        if use_gemini:
            logger.info(f"Page {page_idx + 1} triggering Gemini: {reason}")
            if gemini_model is None:
                try:
                    gemini_model = init_gemini()
                except Exception as e:
                    logger.error(f"Gemini init failed: {e}")
                    skipped_pages.append(page_idx + 1)
                    warnings.append(f"Page {page_idx + 1}: Gemini unavailable, skipped")
                    continue

            img = _page_to_image(pdf_bytes, page_idx)
            qs, ws, fatal = extract_page_with_gemini(gemini_model, img, page_idx + 1)

            if fatal:
                # Non-fatal at sequential level — skip page, add warning
                skipped_pages.append(page_idx + 1)
                warnings.append(f"Page {page_idx + 1}: Gemini fallback failed, page skipped")
                continue

            questions.extend(qs)
            warnings.extend(ws)
            if not qs:
                skipped_pages.append(page_idx + 1)

        else:
            qs, ws = _parse_text_to_questions(text, page_idx + 1)
            warnings.extend(ws)

            if not qs:
                skipped_pages.append(page_idx + 1)
            else:
                # Check for low confidence
                low_conf = any("low confidence" in w.lower() for w in ws)
                if low_conf:
                    low_conf_pages.append(page_idx + 1)
                questions.extend(qs)

    return questions, warnings


# ---------------------------------------------------------------------------
# Answer key extraction
# ---------------------------------------------------------------------------

def extract_answer_key(pdf_bytes: bytes) -> tuple[dict, int]:
    """
    Extract answer key from a PDF.
    Matches patterns like: Q1 - A, 1. B, (1) C, Q.1 → D
    Returns (response_dict, http_status).
    """
    try:
        pdf = pdfplumber.open(io.BytesIO(pdf_bytes))
    except Exception:
        return err_invalid_pdf()

    full_text = ""
    for page in pdf.pages:
        full_text += (page.extract_text() or "") + "\n"
    pdf.close()

    if not full_text.strip():
        return err_blank_pdf()

    key = {}
    patterns = [
        r"(?:Q\.?\s*)?(\d+)\s*[.\-:→)]\s*([A-Da-d1-4])\b",
        r"\((\d+)\)\s*([A-Da-d1-4])\b",
        r"(\d+)\s*\)\s*([A-Da-d])\b",
    ]

    for pat in patterns:
        for m in re.finditer(pat, full_text, re.MULTILINE):
            q_num = int(m.group(1))
            ans   = m.group(2).upper()
            if q_num not in key:
                key[q_num] = ans

    warnings = []
    if not key:
        return {
            "success"   : True,
            "answer_key": {},
            "meta"      : {"matched": 0},
            "warnings"  : [warn_answer_key_partial(0, 0)]
        }, 200

    return {
        "success"   : True,
        "answer_key": key,
        "meta"      : {"matched": len(key)},
        "warnings"  : warnings
    }, 200
