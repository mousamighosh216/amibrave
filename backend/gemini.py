"""
Amibrave — Gemini Fallback Handler
Handles image-based or unreadable PDF pages by sending them to
Google Gemini Vision API and returning structured question JSON.
"""

import os
import re
import json
import base64
import logging
from typing import Optional, cast

from google import genai
from google.genai import types
from PIL import Image
import io

from errors import err_gemini_failed, err_gemini_quota

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Gemini client setup
# ---------------------------------------------------------------------------

def init_gemini():
    """Initialise Gemini client using API key from environment."""
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise EnvironmentError(
            "GEMINI_API_KEY is not set. Add it to your .env file."
        )
    return genai.Client(api_key=api_key)

# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

EXTRACTION_PROMPT = """
You are an expert exam paper parser specialised in GATE (Graduate Aptitude Test in Engineering) papers.

Analyse this exam paper page image and extract ALL questions present.

Return ONLY a valid JSON object with this exact structure — no preamble, no explanation, no markdown fences:

{
  "questions": [
    {
      "num": 1,
      "text": "Full question text including any mathematical expressions in LaTeX format enclosed in $ signs",
      "type": "mcq",
      "options": [
        {"label": "A", "text": "Option text with LaTeX if needed e.g. $x^2$"},
        {"label": "B", "text": "Option text"},
        {"label": "C", "text": "Option text"},
        {"label": "D", "text": "Option text"}
      ]
    },
    {
      "num": 2,
      "text": "Numerical answer type question text",
      "type": "nat",
      "options": []
    }
  ],
  "page_warnings": []
}

Rules:
- type must be exactly "mcq" or "nat"
- For MCQ questions always include all options A, B, C, D
- Write all mathematical expressions in LaTeX enclosed in $ for inline or $$ for display
- If a question spans multiple lines, join them into a single text string
- If no questions found on this page, return {"questions": [], "page_warnings": ["No questions detected on this page"]}
- Never include answer information
- Preserve question numbers exactly as shown
- page_warnings is an array of strings describing any issues encountered
"""


# ---------------------------------------------------------------------------
# Core functions
# ---------------------------------------------------------------------------

def image_to_base64(image: Image.Image) -> str:
    """Convert a PIL Image to low-color black-and-white base64 string for Gemini."""
    bw_image = image.convert("L").point(lambda x: 255 if cast(int, x) > 128 else 0, "1")
    buffer = io.BytesIO()
    bw_image.save(buffer, format="PNG", optimize=True)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def parse_gemini_response(response_text: str) -> Optional[dict]:
    """
    Safely parse Gemini's JSON response.
    Strips markdown fences if present before parsing.
    """
    text = response_text.strip()

    # Strip markdown code fences if Gemini includes them
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    text = text.strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        logger.warning(f"Gemini response JSON parse failed: {e}")
        logger.debug(f"Raw response: {text[:500]}")
        return None


def extract_page_with_gemini(
    client,
    page_image: Image.Image,
    page_num: int
) -> tuple[list[dict], list[str], Optional[tuple[dict, int]]]:
    """
    Send a single page image to Gemini for question extraction.

    Returns:
        questions   — list of parsed question dicts
        warnings    — list of warning strings from this page
        error       — (error_dict, http_status) tuple if fatal, else None
    """
    try:
        buffer = io.BytesIO()
        page_image.save(buffer, format="PNG")

        image_bytes = buffer.getvalue()

        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[
                EXTRACTION_PROMPT,
                types.Part.from_bytes(data=image_bytes,mime_type="image/png")
            ]
        )

        if not response or not response.text:
            logger.warning(f"Gemini returned empty response for page {page_num}")
            return [], [f"Gemini returned empty response for page {page_num}"], None

        parsed = parse_gemini_response(response.text)

        if parsed is None:
            logger.warning(f"Could not parse Gemini JSON for page {page_num}")
            return [], [  f"Could not parse Gemini output for page {page_num}" ], None

        questions = parsed.get("questions", [])
        page_warnings = parsed.get("page_warnings", [])

        clean_questions = []

        for q in questions:
            if not isinstance(q, dict): continue

            if not q.get("text") or not q.get("num"): continue

            q["type"] = q.get("type","nat").lower()

            if q["type"] not in ("mcq", "nat"):
                q["type"] = "nat"
            q["options"] = q.get("options", [])
            q["source"] = "gemini"

            clean_questions.append(q)

        return clean_questions, page_warnings, None


    except Exception as e:
        error_str = str(e).lower()

        if "quota" in error_str or "rate" in error_str or "429" in error_str:
            logger.error(f"Gemini quota exceeded on page {page_num}: {e}")
            return [], [], err_gemini_quota()

        logger.error(f"Gemini error on page {page_num}: {e}")
        return [], [f"Gemini failed on page {page_num}: {str(e)}"], None


def should_use_gemini(text: str) -> tuple[bool, str]:
    """
    Determine whether a page's extracted text is poor enough to
    warrant Gemini fallback. Uses Option C:
      - Less than 50 clean characters, AND
      - More than 30% garbled unicode symbols

    Returns:
        (should_fallback: bool, reason: str)
    """
    if not text or not text.strip():
        return True, "Page returned no text"

    clean_chars = len([c for c in text if c.isalnum() or c in " .,;:?!()-+=/"])
    if clean_chars < 50:
        return True, f"Only {clean_chars} clean characters extracted"

    # Count garbled unicode: replacement chars, private use area, control chars
    total = len(text)
    garbled = sum(
        1 for c in text
        if ord(c) > 127 and c not in "αβγδεζηθικλμνξπρστυφχψωΩ"
                                      "∫∑∏√∞≤≥≠±×÷∂∇∈∉⊂⊃∪∩"
                                      "→←↑↓⇒⇔"
                                      "°′″"
    )

    garbled_ratio = garbled / total if total > 0 else 0
    if garbled_ratio > 0.30:
        return True, f"Garbled unicode ratio is {garbled_ratio:.0%}"

    return False, "Text quality acceptable"
