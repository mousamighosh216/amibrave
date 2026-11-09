"""Text-based GATE PDF question extraction for Amibrave.

The parser deliberately does not use OCR or AI. It extracts the PDF text layer,
keeps page coordinates, and groups page fragments into logical questions.
"""

import io
import logging
import re
import statistics
from typing import Optional

import pdfplumber

from errors import (
    err_invalid_pdf,
    err_password_protected,
    err_no_pages,
    err_blank_pdf,
    warn_answer_key_partial,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Text and coordinate helpers
# ---------------------------------------------------------------------------


def dynamic_line_tolerance(words: list[dict]) -> float:
    """Derive line grouping tolerance from the median word height."""
    heights = [
        word["bottom"] - word["top"]
        for word in words
        if word.get("bottom", 0) > word.get("top", 0)
    ]
    return statistics.median(heights) * 0.5 if heights else 5.0


def detect_columns(words: list[dict], page_width: float) -> list[float]:
    """Detect persistent vertical gutters between text columns.

    The union of word bounding boxes across the whole page is used so that
    ordinary spaces between words do not masquerade as column boundaries.
    """
    if len(words) < 8:
        return []

    intervals = sorted((float(word["x0"]), float(word["x1"])) for word in words)
    merged: list[list[float]] = []
    for x0, x1 in intervals:
        if not merged or x0 > merged[-1][1] + 1.0:
            merged.append([x0, x1])
        else:
            merged[-1][1] = max(merged[-1][1], x1)

    edge_margin = page_width * 0.05
    minimum_gutter = max(24.0, page_width * 0.035)
    boundaries = []
    for left, right in zip(merged, merged[1:]):
        gap = right[0] - left[1]
        midpoint = (right[0] + left[1]) / 2
        if gap >= minimum_gutter and edge_margin < midpoint < page_width - edge_margin:
            boundaries.append(midpoint)
    return boundaries


def assign_column(x0: float, boundaries: list[float]) -> int:
    for index, boundary in enumerate(boundaries):
        if x0 < boundary:
            return index
    return len(boundaries)


def group_words_into_lines(words: list[dict], tolerance: float) -> list[dict]:
    """Group extracted words into lines while retaining their coordinates."""
    lines: list[dict] = []
    for word in sorted(words, key=lambda item: (item.get("top", 0), item.get("x0", 0))):
        y = word.get("top", word.get("y0", 0))
        column = word.get("column", 0)
        target = next(
            (
                line for line in lines
                if line["column"] == column and abs(line["y0"] - y) <= tolerance
            ),
            None,
        )
        if target is None:
            target = {"y0": y, "column": column, "words": []}
            lines.append(target)
        target["words"].append(word)

    for line in lines:
        line["words"].sort(key=lambda item: item.get("x0", 0))
        line["text"] = " ".join(word["text"] for word in line["words"]).strip()
        line["bbox"] = [
            min(word["x0"] for word in line["words"]),
            min(word.get("top", word.get("y0", 0)) for word in line["words"]),
            max(word["x1"] for word in line["words"]),
            max(word.get("bottom", word.get("y1", 0)) for word in line["words"]),
        ]

    # Preserve column reading order, then vertical order within each column.
    lines.sort(key=lambda line: (line["column"], line["y0"]))
    return lines


# ---------------------------------------------------------------------------
# Question and option markers
# ---------------------------------------------------------------------------


# A range such as "Q.1 - Q.5 Carry ONE mark Each" is a section heading,
# not the beginning of question 1. Keep this generic: papers use different
# punctuation, spacing, and wording for section headings.
QUESTION_RANGE_HEADING = re.compile(
    r"^\s*(?:Q\s*\.?\s*)?\d{1,3}\s*"
    r"(?:[-–—]|\bto\b)\s*"
    r"(?:Q\s*\.?\s*)?\d{1,3}\b",
    re.IGNORECASE,
)
QUESTION_MARKER_PATTERNS = re.compile(
    r"^\s*Q\s*\.?\s*(\d{1,3})\b",
    re.IGNORECASE,
)


def _is_section_heading_line(text: str) -> bool:
    """Return True for question-number ranges used as section headings."""
    return QUESTION_RANGE_HEADING.match(text.strip()) is not None


def detect_question_marker(text: str) -> Optional[int]:
    candidate = text.strip()
    if _is_section_heading_line(candidate):
        return None

    match = QUESTION_MARKER_PATTERNS.match(candidate)
    if match:
        try:
            return int(match.group(1))
        except (IndexError, ValueError):
            return None
    return None


def _normalise_page_furniture(text: str) -> str:
    """Create a comparison key without paper-specific metadata assumptions."""
    value = text.casefold()
    value = re.sub(r"\d+", "#", value)
    value = re.sub(r"[^\w#]+", " ", value, flags=re.UNICODE)
    return re.sub(r"\s+", " ", value).strip()


def _detect_repeated_page_furniture(
    page_lines: list[list[dict]],
    page_sizes: list[tuple[float, float]],
) -> list[set[int]]:
    """Find recurring text in page-edge bands using repetition and coordinates.

    No institution, exam title, or page-number wording is hardcoded. A line is
    considered page furniture only when its normalised text recurs on several
    pages and it consistently appears near the top or bottom edge.
    """
    occurrences: dict[str, set[int]] = {}
    edge_positions: dict[tuple[int, str], bool] = {}

    for page_index, lines in enumerate(page_lines):
        page_width, page_height = page_sizes[page_index]
        for line in lines:
            text = line.get("text", "").strip()
            if not text or _is_section_heading_line(text):
                continue

            y0, y1 = line["bbox"][1], line["bbox"][3]
            near_edge = y0 <= page_height * 0.12 or y1 >= page_height * 0.90
            if not near_edge:
                continue

            signature = _normalise_page_furniture(text)
            if len(signature) < 5:
                continue

            occurrences.setdefault(signature, set()).add(page_index)
            edge_positions[(page_index, signature)] = True

    page_count = len(page_lines)
    repeat_threshold = max(2, min(5, int(page_count * 0.10 + 0.999)))
    repeated_signatures = {
        signature
        for signature, pages in occurrences.items()
        if len(pages) >= repeat_threshold
    }

    return [
        {
            index
            for index, line in enumerate(lines)
            if _normalise_page_furniture(line.get("text", "")) in repeated_signatures
            and (page_index, _normalise_page_furniture(line.get("text", ""))) in edge_positions
        }
        for page_index, lines in enumerate(page_lines)
    ]


OPTION_PATTERNS = (
    (r"^\(([1-4])\)\s*", "numeric_paren"),
    (r"^\(([A-D])\)\s*", "alpha_paren"),
    (r"^([A-D])\.\s+", "alpha_dot"),
    (r"^([A-D])\)\s+", "alpha_bracket"),
    (r"^([1-4])\.\s+", "numeric_dot"),
    (r"^([1-4])\)\s+", "numeric_bracket"),
)


def detect_option_marker(text: str) -> Optional[tuple[str, str, str]]:
    candidate = text.strip()
    for pattern, pattern_type in OPTION_PATTERNS:
        match = re.match(pattern, candidate, flags=re.IGNORECASE)
        if match:
            return match.group(1).upper(), candidate[match.end():].strip(), pattern_type
    return None


def _is_question_marker_line(text: str) -> bool:
    """Recognize question starts; numeric option runs are filtered separately."""
    candidate = text.strip()
    # Parenthesized 1-4 labels are a common option format, not question numbers.
    if re.match(r"^\([1-4]\)\s*", candidate):
        return False
    return detect_question_marker(candidate) is not None


def _filter_numeric_option_runs(lines: list[dict], marker_indexes: list[int]) -> list[int]:
    """Remove compact 1,2,3,4 numeric-option sequences from marker candidates.

    Numeric question numbers 1-4 are ambiguous with numeric options. A compact
    ascending run on adjacent lines is treated as an option list; question
    starts are normally separated by the body of the preceding question.
    """
    remove: set[int] = set()
    position = 0
    while position < len(marker_indexes):
        run = [marker_indexes[position]]
        previous_number = detect_question_marker(lines[run[0]]["text"])
        cursor = position + 1
        while cursor < len(marker_indexes):
            current_index = marker_indexes[cursor]
            current_number = detect_question_marker(lines[current_index]["text"])
            previous_text = lines[run[-1]]["text"].strip()
            current_text = lines[current_index]["text"].strip()
            numeric_labels_only = (
                re.match(r"^[1-4]\s*[.)]", previous_text) is not None
                and re.match(r"^[1-4]\s*[.)]", current_text) is not None
            )
            if (
                numeric_labels_only
                and previous_number in (1, 2, 3)
                and current_number is not None
                and current_number == previous_number + 1
                and current_number <= 4
                and current_index - run[-1] <= 2
            ):
                run.append(current_index)
                previous_number = current_number
                cursor += 1
            else:
                break
        if len(run) >= 2:
            remove.update(run)
        position = max(cursor, position + 1)
    return [index for index in marker_indexes if index not in remove]


def _line_remainder(text: str, question_number: int) -> str:
    patterns = (
        rf"^Q\.?\s*{question_number}\s*[.):]?\s*",
        rf"^Question\s+{question_number}\s*[.):]?\s*",
        rf"^{question_number}\s*[.)]\s*",
    )
    remainder = text.strip()
    for pattern in patterns:
        updated = re.sub(pattern, "", remainder, count=1, flags=re.IGNORECASE)
        if updated != remainder:
            return updated.strip()
    return remainder


def _merge_line_into_question(question: dict, line: dict, page_index: int) -> None:
    question["lines"].append(line)
    page_region = question["regions_by_page"].get(page_index)
    x0, y0, x1, y1 = line["bbox"]
    if page_region is None:
        question["regions_by_page"][page_index] = [x0, y0, x1, y1]
    else:
        page_region[0] = min(page_region[0], x0)
        page_region[1] = min(page_region[1], y0)
        page_region[2] = max(page_region[2], x1)
        page_region[3] = max(page_region[3], y1)


def _finalize_question(question: dict) -> dict:
    lines = question["lines"]
    option_pattern_counts: dict[str, int] = {}
    for line in lines:
        marker = detect_option_marker(line["text"])
        if marker:
            option_pattern_counts[marker[2]] = option_pattern_counts.get(marker[2], 0) + 1

    dominant_pattern = max(option_pattern_counts, key=lambda pattern: option_pattern_counts[pattern]) if option_pattern_counts else None
    text_parts: list[str] = []
    options: list[dict] = []
    current_option: Optional[dict] = None

    for line in lines:
        marker = detect_option_marker(line["text"]) if dominant_pattern else None
        if marker and marker[2] == dominant_pattern:
            if current_option:
                options.append(current_option)
            current_option = {"label": marker[0], "text": marker[1]}
        elif current_option is not None:
            current_option["text"] = f"{current_option['text']} {line['text']}".strip()
        elif line["text"]:
            text_parts.append(line["text"])

    if current_option:
        options.append(current_option)

    question_text = re.sub(r"\s+", " ", " ".join(text_parts)).strip()
    page_indexes = sorted(question["regions_by_page"])
    regions = [
        {"page_index": page_index, "bbox": question["regions_by_page"][page_index]}
        for page_index in page_indexes
    ]

    return {
        "num": question["num"],
        "text": question_text,
        "type": "mcq" if len(options) >= 2 else "nat",
        "options": options,
        "source": "pdfplumber",
        "source_pages": [page_index + 1 for page_index in page_indexes],
        "question_regions": regions,
    }


def _extract_page_lines(page) -> list[dict]:
    words = page.extract_words(
        x_tolerance=3,
        y_tolerance=3,
        keep_blank_chars=False,
        use_text_flow=False,
    )
    if not words:
        return []

    boundaries = detect_columns(words, page.width)
    for word in words:
        word["column"] = assign_column(word["x0"], boundaries)
    return group_words_into_lines(words, dynamic_line_tolerance(words))


# ---------------------------------------------------------------------------
# Main text-only extraction pipeline
# ---------------------------------------------------------------------------


def extract_questions(pdf_bytes: bytes) -> tuple[dict, int]:
    """Extract logical questions and their page crop coordinates.

    A question can own multiple ordered page regions. Text before the first
    question marker on a later page is treated as continuation of the previous
    question. Section-range headings are ignored, and recurring page-edge text
    is detected dynamically from the PDF rather than by paper-specific names.
    """
    try:
        pdf = pdfplumber.open(io.BytesIO(pdf_bytes))
    except Exception as error:
        message = str(error).lower()
        if "password" in message or "encrypt" in message:
            return err_password_protected()
        return err_invalid_pdf()

    try:
        total_pages = len(pdf.pages)
        if total_pages == 0:
            return err_no_pages()

        extracted: list[dict] = []
        active_question: Optional[dict] = None
        warnings: list[str] = []

        # Analyse all pages first so recurring headers/footers can be identified
        # from this PDF itself, rather than from institution-specific keywords.
        page_lines = [_extract_page_lines(page) for page in pdf.pages]
        page_sizes = [(page.width, page.height) for page in pdf.pages]
        page_furniture = _detect_repeated_page_furniture(page_lines, page_sizes)

        for page_index, original_lines in enumerate(page_lines):
            if not original_lines:
                warnings.append(f"Page {page_index + 1} has no extractable text.")
                continue

            ignored_indexes = page_furniture[page_index]
            lines = [
                line for index, line in enumerate(original_lines)
                if index not in ignored_indexes and not _is_section_heading_line(line["text"])
            ]
            if not lines:
                warnings.append(f"Page {page_index + 1} contains only page furniture or section headings.")
                continue

            marker_indexes = [
                index for index, line in enumerate(lines)
                if _is_question_marker_line(line["text"])
            ]
            marker_indexes = _filter_numeric_option_runs(lines, marker_indexes)

            if not marker_indexes:
                # A page without a new marker may contain the continuation of
                # the question that began on the preceding page.
                if active_question is not None:
                    for line in lines:
                        _merge_line_into_question(active_question, line, page_index)
                else:
                    warnings.append(f"Page {page_index + 1}: no question marker detected.")
                continue

            # Lines before the first marker continue the previous question.
            if active_question is not None:
                for line in lines[:marker_indexes[0]]:
                    _merge_line_into_question(active_question, line, page_index)

            for marker_position, marker_index in enumerate(marker_indexes):
                if active_question is not None:
                    extracted.append(_finalize_question(active_question))
                    active_question = None

                marker_line = lines[marker_index]
                number = detect_question_marker(marker_line["text"])
                if number is None:
                    continue

                active_question = {
                    "num": number,
                    "lines": [],
                    "regions_by_page": {},
                }
                remainder = _line_remainder(marker_line["text"], number)
                if remainder:
                    marker_line = dict(marker_line)
                    marker_line["text"] = remainder
                    _merge_line_into_question(active_question, marker_line, page_index)

                next_marker = (
                    marker_indexes[marker_position + 1]
                    if marker_position + 1 < len(marker_indexes)
                    else len(lines)
                )
                for line in lines[marker_index + 1:next_marker]:
                    _merge_line_into_question(active_question, line, page_index)

        if active_question is not None:
            extracted.append(_finalize_question(active_question))

        # Keep first occurrence of a number. Duplicate numbering is ambiguous,
        # so flag it rather than silently merging unrelated content.
        unique_questions: list[dict] = []
        seen_numbers: set[int] = set()
        for question in extracted:
            if question["num"] in seen_numbers:
                warnings.append(
                    f"Question number {question['num']} appears more than once; later occurrence skipped."
                )
                continue
            seen_numbers.add(question["num"])
            if not question["text"]:
                warnings.append(f"Question {question['num']} has no extractable text.")
                continue
            unique_questions.append(question)

        unique_questions.sort(key=lambda item: item["num"])
        if not unique_questions:
            return err_blank_pdf()

        question_regions = [
            {
                "question_number": question["num"],
                "regions": question["question_regions"],
            }
            for question in unique_questions
        ]

        return {
            "success": True,
            "questions": unique_questions,
            "question_regions": question_regions,
            "meta": {
                "total_questions": len(unique_questions),
                "mcq_count": sum(question["type"] == "mcq" for question in unique_questions),
                "nat_count": sum(question["type"] == "nat" for question in unique_questions),
                "total_pages": total_pages,
                "text_only_extraction": True,
            },
            "warnings": warnings,
        }, 200
    finally:
        pdf.close()


# ---------------------------------------------------------------------------
# Answer-key extraction retained for the existing /extract-key endpoint.
# ---------------------------------------------------------------------------


def extract_answer_key(pdf_bytes: bytes) -> tuple[dict, int]:
    """Extract a simple answer-key mapping from a text-based PDF."""
    try:
        pdf = pdfplumber.open(io.BytesIO(pdf_bytes))
    except Exception:
        return err_invalid_pdf()

    answer_key: dict[int, str] = {}
    try:
        for page in pdf.pages:
            text = page.extract_text() or ""
            for match in re.finditer(
                r"(?:Q\.?\s*)?(\d+)\s*[.\-:→)]\s*([A-Da-d1-4])\b",
                text,
            ):
                number = int(match.group(1))
                answer_key.setdefault(number, match.group(2).upper())
    finally:
        pdf.close()

    warnings = [] if answer_key else [warn_answer_key_partial(0, 0)]
    return {
        "success": True,
        "answer_key": answer_key,
        "meta": {"matched": len(answer_key)},
        "warnings": warnings,
    }, 200
