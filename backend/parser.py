"""
Amibrave — Adaptive Coordinate-Based PDF Parser
Uses pdfplumber extract_words() with full dynamic layout detection:
  - Column boundaries from gap analysis
  - Line grouping from median word height
  - Question markers from incremental token patterns
  - Option patterns from consistent repeating tokens
  - 70% detection rate from marker rhythm
  - Fallback: OCR (pytesseract) → Gemini Vision
"""

import re
import io
import random
import logging
import statistics
from typing import Optional

import pdfplumber
import fitz
from PIL import Image
import pytesseract

from errors import (
    err_invalid_pdf, err_password_protected, err_no_pages,
    err_unreadable_file, err_blank_pdf,
    warn_pages_skipped, warn_low_confidence, warn_answer_key_partial
)
from gemini import extract_page_with_gemini, init_gemini

logger = logging.getLogger(__name__)

THRESHOLD_RATIO     = 0.30
DETECTION_THRESHOLD = 0.70
RANDOM_SAMPLE_COUNT = 6


# ── Coordinate utilities ─────────────────────────────────────────────────────

def dynamic_line_tolerance(words: list[dict]) -> float:
    """
    Derive line-grouping tolerance from median word height on this page.
    Avoids hardcoding px values that break across font sizes.
    """
    if not words:
        return 5.0
    logger.info(f"First word sample: {words[:3]}")
    heights = [
        w["bottom"] - w["top"]
        for w in words
        if "top" in w and "bottom" in w
    ]

    return max(3, min(int(sum(heights)/len(heights)*0.6),12)) if heights else 5


def detect_columns(words: list[dict], page_width: float) -> list[float]:
    """
    Detect column boundaries dynamically using x0 gap analysis.
    Returns sorted list of x0 boundary values that separate columns.
    No fixed percentages — boundaries emerge from the data.
    """
    if not words:
        return []

    # Collect all x0 positions rounded to nearest integer
    x0_values = sorted(set(round(w["x0"]) for w in words))
    if len(x0_values) < 2:
        return []

    # Compute gaps between consecutive x0 positions
    gaps = [
        (x0_values[i + 1] - x0_values[i], x0_values[i + 1])
        for i in range(len(x0_values) - 1)
    ]
    if not gaps:
        return []

    gap_sizes   = [g[0] for g in gaps]
    median_gap  = statistics.median(gap_sizes)

    # A gap 3x larger than median signals a column boundary
    boundaries = [
        x_pos for gap_size, x_pos in gaps
        if gap_size > median_gap * 3
    ]

    # Filter boundaries too close to page edges (noise)
    edge_margin = page_width * 0.05
    boundaries  = [b for b in boundaries if edge_margin < b < page_width - edge_margin]

    return sorted(boundaries)


def assign_column(x0: float, boundaries: list[float]) -> int:
    """Return 0-indexed column number for a given x0 position."""
    for i, boundary in enumerate(boundaries):
        if x0 < boundary:
            return i
    return len(boundaries)


def group_words_into_lines(words: list[dict], tolerance: float) -> list[dict]:
    """
    Group words into lines using dynamic y0 proximity tolerance.
    Each line: { y0, column, words: [...], text: str }
    """
    if not words:
        return []

    lines = []
    for word in words:
        placed = False
        for line in lines:
            if (line["column"] == word.get("column", 0) and
                    abs(word["top"] - line["top"]) <= tolerance):
                line["words"].append(word)
                placed = True
                break
        if not placed:
            lines.append({
                "top"    : word["top"],
                "column": word.get("column", 0),
                "words" : [word],
            })

    # Sort words within each line left to right
    for line in lines:
        line["words"].sort(key=lambda w: w["x0"])
        line["text"] = " ".join(w["text"] for w in line["words"])

    # Sort lines top to bottom, then left column before right column
    lines.sort(key=lambda l: (round(l["top"] / 10), l["column"]))
    return lines


# ── Question marker detection ─────────────────────────────────────────────────

# All known GATE question numbering formats
Q_MARKER_PATTERNS = [
    r"^Q\.?\s*(\d+)\s*[\.\):]?\s*$",   # Q.56  Q56  Q.56.
    r"^(\d+)\s*\.\s*$",                  # 56.
    r"^(\d+)\s*\)\s*$",                  # 56)
    r"^Q\.?\s*(\d+)\s*[\.\):]",          # Q.56 followed by text
    r"^(\d+)\s*[\.\)]\s+\S",             # 56. text  or  56) text
]

def detect_question_marker(text: str) -> Optional[int]:
    """Return question number if line is a question marker, else None."""
    t = text.strip()
    for pat in Q_MARKER_PATTERNS:
        m = re.match(pat, t, re.IGNORECASE)
        if m:
            try:
                return int(m.group(1))
            except (IndexError, ValueError):
                pass
    return None


def detect_marker_pattern_statistically(lines: list[dict]) -> list[int]:
    """
    Scan all lines for incrementing numeric tokens.
    Confirms a pattern only if 3+ consecutive increments found.
    Returns list of line indices that are question markers.
    """
    candidates = {}  # line_index → question_number
    for i, line in enumerate(lines):
        num = detect_question_marker(line["text"])
        if num is not None:
            candidates[i] = num

    if len(candidates) < 2:
        return list(candidates.keys())

    # Find runs of incrementing numbers
    indices = sorted(candidates.keys())
    confirmed = set()
    run = [indices[0]]

    for i in range(1, len(indices)):
        prev_idx = indices[i - 1]
        curr_idx = indices[i]
        prev_num = candidates[prev_idx]
        curr_num = candidates[curr_idx]
        if curr_num == prev_num + 1 or curr_num == prev_num + 2:
            run.append(curr_idx)
        else:
            if len(run) >= 3:
                confirmed.update(run)
            run = [curr_idx]

    if len(run) >= 3:
        confirmed.update(run)

    # Fall back to all candidates if no confirmed run found
    return sorted(confirmed) if confirmed else list(candidates.keys())


# ── Option pattern detection ──────────────────────────────────────────────────

OPTION_PATTERNS = [
    (r"^\(([1-4])\)\s*",        "numeric_paren"),   # (1) (2) (3) (4)
    (r"^\(([A-Da-d])\)\s*",     "alpha_paren"),     # (A) (B) (C) (D)
    (r"^([A-Da-d])\.\s+",       "alpha_dot"),       # A. B. C. D.
    (r"^([A-Da-d])\)\s+",       "alpha_bracket"),   # A) B) C) D)
    (r"^([1-4])\.\s+",          "numeric_dot"),     # 1. 2. 3. 4.
    (r"^([1-4])\)\s+",          "numeric_bracket"), # 1) 2) 3) 4)
]

def detect_option_marker(text: str) -> Optional[tuple[str, str, str]]:
    """
    Returns (label, remaining_text, pattern_type) if line is an option, else None.
    """
    t = text.strip()
    for pat, ptype in OPTION_PATTERNS:
        m = re.match(pat, t, re.IGNORECASE)
        if m:
            label     = m.group(1).upper()
            remaining = t[m.end():].strip()
            return label, remaining, ptype
    return None


def detect_dominant_option_pattern(lines: list[dict]) -> Optional[str]:
    """
    Find which option pattern appears most in a question block.
    Returns the dominant pattern_type or None.
    """
    counts = {}
    for line in lines:
        result = detect_option_marker(line["text"])
        if result:
            _, _, ptype = result
            counts[ptype] = counts.get(ptype, 0) + 1
    if not counts:
        return None
    return max(counts.items(), key=lambda item: item[1])[0]


# ── Core page parser ──────────────────────────────────────────────────────────

def parse_page_with_coordinates(page) -> tuple[list[dict], list[str], float]:
    """
    Full coordinate-based parsing of one pdfplumber page.
    Returns (questions, warnings, detection_rate).
    """
    warnings = []

    words = page.extract_words(
        x_tolerance    = 3,
        y_tolerance    = 3,
        keep_blank_chars= False,
        use_text_flow  = False,
    )

    if not words:
        return [], ["Page returned no words"], 0.0

    # ── Dynamic tolerance ────────────────────────────────────────────────────
    tolerance = dynamic_line_tolerance(words)

    # ── Dynamic column detection ─────────────────────────────────────────────
    boundaries = detect_columns(words, page.width)

    # Assign column to each word
    for word in words:
        word["column"] = assign_column(word["x0"], boundaries)

    # ── Group into lines ─────────────────────────────────────────────────────
    lines = group_words_into_lines(words, tolerance)

    if not lines:
        return [], ["No lines reconstructed from words"], 0.0

    # ── Detect question markers statistically ────────────────────────────────
    marker_line_indices = detect_marker_pattern_statistically(lines)

    if not marker_line_indices:
        warnings.append("No question markers detected on this page")
        return [], warnings, 0.0

    # ── Estimate expected questions from marker rhythm ───────────────────────
    if len(marker_line_indices) >= 2:
        marker_y   = [lines[i]["top"] for i in marker_line_indices]
        diffs      = [marker_y[j+1] - marker_y[j] for j in range(len(marker_y)-1)]
        avg_gap    = statistics.median(diffs) if diffs else page.height
        expected   = max(1, round(page.height / avg_gap))
    else:
        expected = 1

    # ── Split lines into question blocks ─────────────────────────────────────
    questions = []
    for idx, marker_idx in enumerate(marker_line_indices):
        q_num_match = detect_question_marker(lines[marker_idx]["text"])
        if q_num_match is None:
            continue

        # Collect lines belonging to this question
        block_start = marker_idx + 1
        block_end   = marker_line_indices[idx + 1] if idx + 1 < len(marker_line_indices) else len(lines)
        block_lines = lines[block_start:block_end]

        # First line may have question text after the marker
        first_line_text = re.sub(
            r"^Q?\.?\s*\d+\s*[\.\):]?\s*", "",
            lines[marker_idx]["text"], flags=re.IGNORECASE
        ).strip()

        q, w = build_question_from_block(
            q_num_match,
            first_line_text,
            block_lines,
            page.page_number
        )
        warnings.extend(w)
        if q:
            questions.append(q)

    detected      = len(questions)
    detection_rate = detected / expected if expected > 0 else 0.0

    if detection_rate < DETECTION_THRESHOLD and detected > 0:
        warnings.append(
            f"Page {page.page_number}: Detection rate {detection_rate:.0%} "
            f"({detected}/{expected}) — low confidence"
        )

    return questions, warnings, detection_rate


def build_question_from_block(
    num: int,
    first_line: str,
    block_lines: list[dict],
    page_num: int
) -> tuple[Optional[dict], list[str]]:
    """
    Given a question number and its block of lines,
    separate question text from options dynamically.
    """
    warnings    = []
    q_text_parts= [first_line] if first_line else []
    options     = []
    current_opt = None

    # Find dominant option pattern in this block
    dominant_pattern = detect_dominant_option_pattern(block_lines)

    for line in block_lines:
        opt_result = detect_option_marker(line["text"]) if dominant_pattern else None

        if opt_result and opt_result[2] == dominant_pattern:
            # Save previous option
            if current_opt:
                options.append(current_opt)
            label, text, _ = opt_result
            current_opt = {"label": label, "text": text}
        elif current_opt:
            # Continuation of current option text
            current_opt["text"] += " " + line["text"]
        else:
            # Still in question text body
            q_text_parts.append(line["text"])

    # Save last option
    if current_opt:
        options.append(current_opt)

    q_text = " ".join(q_text_parts).strip()
    q_text = re.sub(r"\s{2,}", " ", q_text)  # collapse extra spaces

    if not q_text or len(q_text) < 5:
        warnings.append(f"Q{num} page {page_num}: text too short, skipped")
        return None, warnings

    q_type = "mcq" if len(options) >= 2 else "nat"

    return {
        "num"    : num,
        "text"   : q_text[:800],
        "type"   : q_type,
        "options": options,
        "source" : "pdfplumber",
    }, warnings


# ── Page image for OCR / Gemini ───────────────────────────────────────────────

def page_to_image(pdf_bytes: bytes, page_index: int, dpi: int = 200) -> Image.Image:
    """Render a PDF page to PIL Image using PyMuPDF at given DPI."""
    doc  = fitz.open(stream=pdf_bytes, filetype="pdf")
    page = doc[page_index]
    mat  = fitz.Matrix(dpi / 72, dpi / 72)
    pix  = page.get_pixmap(matrix=mat)
    img  = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    doc.close()
    return img


# ── OCR fallback ──────────────────────────────────────────────────────────────

def ocr_page(image: Image.Image) -> str:
    """Run pytesseract OCR on a page image, return extracted text."""
    try:
        config = "--oem 3 --psm 6"
        return pytesseract.image_to_string(image, config=config)
    except Exception as e:
        logger.warning(f"OCR failed: {e}")
        return ""


def parse_ocr_text(text: str, page_num: int) -> tuple[list[dict], list[str]]:
    """
    Parse OCR text output using the same coordinate-free regex approach.
    OCR gives cleaner joined text than raw pdfplumber, so regex works better here.
    """
    warnings  = []
    questions = []
    lines     = [l.strip() for l in text.splitlines() if l.strip()]

    # Reconstruct question blocks
    blocks      = {}
    current_num = None
    current_buf = []

    for line in lines:
        num = detect_question_marker(line)
        if num is not None:
            if current_num is not None:
                blocks[current_num] = current_buf
            current_num = num
            # Strip marker from line
            remainder = re.sub(r"^Q?\.?\s*\d+\s*[\.\):]?\s*", "", line, flags=re.IGNORECASE).strip()
            current_buf = [remainder] if remainder else []
        elif current_num is not None:
            current_buf.append(line)

    if current_num is not None:
        blocks[current_num] = current_buf

    for num, buf_lines in blocks.items():
        fake_lines = [{"text": l, "top": i * 20, "column": 0} for i, l in enumerate(buf_lines)]
        q, w = build_question_from_block(num, "", fake_lines, page_num)
        warnings.extend(w)
        if q:
            q["source"] = "ocr"
            questions.append(q)

    return questions, warnings


# ── Main extraction pipeline ──────────────────────────────────────────────────

def extract_questions(pdf_bytes: bytes) -> tuple[dict, int]:
    """
    Full adaptive extraction pipeline:
      Phase 1 → coordinate parse page 1
      Phase 2 → if page 1 fails, random sample
      Phase 3 → resume sequential from first hit
      Per page → coordinate parse → OCR fallback → Gemini fallback
      Post     → 70% check, dedup, sort
    """
    # ── Validate ─────────────────────────────────────────────────────────────
    try:
        pdf = pdfplumber.open(io.BytesIO(pdf_bytes))
    except Exception as e:
        if "password" in str(e).lower() or "encrypt" in str(e).lower():
            return err_password_protected()
        return err_invalid_pdf()

    total_pages = len(pdf.pages)
    if total_pages == 0:
        pdf.close()
        return err_no_pages()

    logger.info(f"Starting extraction: {total_pages} pages")

    gemini_model  = None
    all_questions = []
    all_warnings  = []
    skipped_pages = []
    low_conf_pages= []

    # ── Phase 1: try page 1 ───────────────────────────────────────────────────
    qs, ws, rate = parse_page_with_coordinates(pdf.pages[0])
    page1_success = rate >= DETECTION_THRESHOLD or len(qs) > 0

    if page1_success:
        logger.info(f"Page 1 success (rate={rate:.0%}) — sequential mode")
        all_questions.extend(qs)
        all_warnings.extend(ws)
        start_from = 1  # continue from page 2
        qs2, ws2, skipped, low_conf, gemini_model = sequential_extract(
            pdf, pdf_bytes, range(start_from, total_pages), gemini_model
        )
        all_questions.extend(qs2)
        all_warnings.extend(ws2)
        skipped_pages.extend(skipped)
        low_conf_pages.extend(low_conf)

    else:
        # ── Phase 2: random sampling ──────────────────────────────────────────
        logger.info("Page 1 failed — random sampling")
        skip_first   = min(2, total_pages - 1)
        sample_pool  = list(range(skip_first, total_pages))
        sample_size  = min(RANDOM_SAMPLE_COUNT, len(sample_pool))
        sample_pages = sorted(random.sample(sample_pool, sample_size))

        first_hit = None
        for page_idx in sample_pages:
            qs, ws, rate = parse_page_with_coordinates(pdf.pages[page_idx])
            if rate >= DETECTION_THRESHOLD or len(qs) > 0:
                first_hit = page_idx
                all_questions.extend(qs)
                all_warnings.extend(ws)
                logger.info(f"Random hit on page {page_idx + 1} (rate={rate:.0%})")
                break

        if first_hit is None:
            # ── Phase 3: 30% threshold check ─────────────────────────────────
            checked = skip_first + sample_size
            if checked / total_pages >= THRESHOLD_RATIO:
                pdf.close()
                return err_unreadable_file(checked, total_pages)

            # Try Gemini on sampled pages
            logger.info("Random sampling failed — trying Gemini on samples")
            try:
                gemini_model = init_gemini()
            except Exception as e:
                pdf.close()
                return err_unreadable_file(skip_first + sample_size, total_pages)

            gemini_hit = False
            for page_idx in sample_pages:
                img = page_to_image(pdf_bytes, page_idx)
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

            if not gemini_hit:
                pdf.close()
                return err_unreadable_file(skip_first + sample_size, total_pages)

            remaining = [i for i in range(total_pages) if i not in sample_pages]
            qs2, ws2, skipped, low_conf, gemini_model = sequential_extract(
                pdf, pdf_bytes, remaining, gemini_model
            )
            all_questions.extend(qs2)
            all_warnings.extend(ws2)
            skipped_pages.extend(skipped)
            low_conf_pages.extend(low_conf)

        else:
            # ── Phase 4: resume sequential from first hit ─────────────────────
            logger.info(f"Resuming sequential from page {first_hit + 1}")
            remaining = [i for i in range(first_hit + 1, total_pages)
                         if i not in sample_pages]
            qs2, ws2, skipped, low_conf, gemini_model = sequential_extract(
                pdf, pdf_bytes, remaining, gemini_model
            )
            all_questions.extend(qs2)
            all_warnings.extend(ws2)
            skipped_pages.extend(skipped)
            low_conf_pages.extend(low_conf)

    pdf.close()

    if not all_questions:
        return err_blank_pdf()

    # ── Dedup and sort ────────────────────────────────────────────────────────
    seen = {}
    for q in all_questions:
        # Prefer gemini > ocr > pdfplumber for same question number
        source_rank = {"gemini": 3, "ocr": 2, "pdfplumber": 1, "manual": 0}
        existing    = seen.get(q["num"])
        if not existing or source_rank.get(q["source"], 0) > source_rank.get(existing["source"], 0):
            seen[q["num"]] = q

    final = sorted(seen.values(), key=lambda q: q["num"])

    # ── Build warnings ────────────────────────────────────────────────────────
    response_warnings = []
    if skipped_pages:
        response_warnings.append(warn_pages_skipped(skipped_pages))
    if low_conf_pages:
        response_warnings.append(warn_low_confidence(low_conf_pages))

    logger.info(f"Done: {len(final)} questions, {len(response_warnings)} warnings")

    return {
        "success"  : True,
        "questions": final,
        "meta"     : {
            "total_questions": len(final),
            "mcq_count"      : sum(1 for q in final if q["type"] == "mcq"),
            "nat_count"      : sum(1 for q in final if q["type"] == "nat"),
            "total_pages"    : total_pages,
            "skipped_pages"  : len(skipped_pages),
            "gemini_used"    : gemini_model is not None,
        },
        "warnings" : response_warnings,
    }, 200


def sequential_extract(
    pdf, pdf_bytes: bytes,
    page_range,
    gemini_model
) -> tuple[list[dict], list[str], list[int], list[int], object]:
    """
    Process pages in range:
      coordinate parse → OCR fallback → Gemini fallback
    Returns (questions, warnings, skipped_pages, low_conf_pages, gemini_model).
    """
    questions   = []
    warnings    = []
    skipped     = []
    low_conf    = []

    for page_idx in page_range:
        page_num = page_idx + 1

        # ── Coordinate parse ──────────────────────────────────────────────────
        try:
            qs, ws, rate = parse_page_with_coordinates(pdf.pages[page_idx])
        except Exception as e:
            logger.warning(f"Coordinate parse error page {page_num}: {e}")
            qs, ws, rate = [], [f"Page {page_num}: coordinate parse failed"], 0.0

        warnings.extend(ws)

        if rate >= DETECTION_THRESHOLD and qs:
            questions.extend(qs)
            continue

        if qs and rate > 0:
            low_conf.append(page_num)
            questions.extend(qs)
            continue

        # ── OCR fallback ──────────────────────────────────────────────────────
        logger.info(f"Page {page_num}: coordinate parse rate={rate:.0%} — trying OCR")
        try:
            img      = page_to_image(pdf_bytes, page_idx)
            ocr_text = ocr_page(img)
            ocr_qs, ocr_ws = parse_ocr_text(ocr_text, page_num)
            warnings.extend(ocr_ws)
        except Exception as e:
            logger.warning(f"OCR failed page {page_num}: {e}")
            ocr_qs = []

        # Estimate OCR detection rate
        if ocr_qs:
            ocr_rate = len(ocr_qs) / max(1, len(ocr_qs))
            if ocr_rate >= DETECTION_THRESHOLD:
                logger.info(f"Page {page_num}: OCR success ({len(ocr_qs)} questions)")
                questions.extend(ocr_qs)
                continue
            else:
                low_conf.append(page_num)
                questions.extend(ocr_qs)
                continue

        # ── Gemini fallback ───────────────────────────────────────────────────
        logger.info(f"Page {page_num}: OCR failed — trying Gemini")
        if gemini_model is None:
            try:
                gemini_model = init_gemini()
            except Exception as e:
                logger.error(f"Gemini init failed: {e}")
                skipped.append(page_num)
                warnings.append(f"Page {page_num}: all fallbacks failed, skipped")
                continue

        try:
            img = page_to_image(pdf_bytes, page_idx)
        except Exception as e:
            skipped.append(page_num)
            warnings.append(f"Page {page_num}: image render failed — {e}")
            continue

        gem_qs, gem_ws, fatal = extract_page_with_gemini(gemini_model, img, page_num)
        warnings.extend(gem_ws)

        if fatal:
            skipped.append(page_num)
            warnings.append(f"Page {page_num}: Gemini fatal error, skipped")
            continue

        if gem_qs:
            questions.extend(gem_qs)
        else:
            skipped.append(page_num)
            warnings.append(f"Page {page_num}: all extraction methods failed")

    return questions, warnings, skipped, low_conf, gemini_model


# ── Answer key extraction ─────────────────────────────────────────────────────

def extract_answer_key(pdf_bytes: bytes) -> tuple[dict, int]:
    """
    Extract answer key using coordinate-based parsing first,
    then regex on full text as fallback.
    """
    try:
        pdf = pdfplumber.open(io.BytesIO(pdf_bytes))
    except Exception:
        return err_invalid_pdf()

    key      = {}
    warnings = []

    for page in pdf.pages:
        words = page.extract_words(x_tolerance=3, y_tolerance=3)
        if not words:
            continue

        tolerance  = dynamic_line_tolerance(words)
        boundaries = detect_columns(words, page.width)
        for word in words:
            word["column"] = assign_column(word["x0"], boundaries)
        lines = group_words_into_lines(words, tolerance)

        for line in lines:
            # Match patterns like: "1. A", "Q1 - B", "(1) C", "1→D"
            m = re.search(
                r"(?:Q\.?\s*)?(\d+)\s*[\.\-:→\)]\s*([A-Da-d1-4])\b",
                line["text"]
            )
            if m:
                q_num = int(m.group(1))
                ans   = m.group(2).upper()
                if q_num not in key:
                    key[q_num] = ans

    pdf.close()

    if not key:
        # Fallback: raw text regex
        try:
            pdf2 = pdfplumber.open(io.BytesIO(pdf_bytes))
            full = "".join(p.extract_text() or "" for p in pdf2.pages)
            pdf2.close()
            for m in re.finditer(r"(?:Q\.?\s*)?(\d+)\s*[\.\-:→\)]\s*([A-Da-d1-4])\b", full):
                q_num = int(m.group(1))
                if q_num not in key:
                    key[q_num] = m.group(2).upper()
        except Exception:
            pass

    if not key:
        return {
            "success"   : True,
            "answer_key": {},
            "meta"      : {"matched": 0},
            "warnings"  : [warn_answer_key_partial(0, 0)],
        }, 200

    return {
        "success"   : True,
        "answer_key": key,
        "meta"      : {"matched": len(key)},
        "warnings"  : warnings,
    }, 200
