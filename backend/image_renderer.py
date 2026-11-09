"""
Image renderer module for Amibrave backend.
This module provides functionality to render images from PDF files, which is essential for processing examination documents.

sample input data:
question_regions = [
    {
        "question_number": 1,
        "regions": [
            {
                "page_index": 0,
                "bbox": [72, 120, 520, 280]
            }
        ]
    },
    {
        "question_number": 2,
        "regions": [
            {
                "page_index": 0,
                "bbox": [72, 300, 520, 700]
            },
            {
                "page_index": 1,
                "bbox": [72, 50, 520, 180]
            }
        ]
    }
]
"""

from typing import Any
from pathlib import Path
import re
import pymupdf  # PyMuPDF

DEFAULT_DPI = 180
DEFAULT_PADDING = 12 
MAX_DPI = 300

class ImageRenderError(Exception):
    """Custom exception for image rendering errors."""
    pass

def _img_filename(question_number:int, region_index: int) -> str:
    """name given to rendered image"""
    return f"q-{question_number}-r{region_index}.png"

def _validate_bbox(bbox: list, page_rect: pymupdf.Rect) -> pymupdf.Rect:
    """Validate bounding box format."""
    if not isinstance(bbox, (list,tuple)) or len(bbox) != 4:
        raise ImageRenderError(f"Invalid bbox format: {bbox}. Expected a list or tuple of four numbers.")
        

    try:
        rect = pymupdf.Rect(*map(float, bbox))
    except (TypeError, ValueError) as e:
        raise ImageRenderError(f"Invalid bbox values: {bbox}. All values must be numbers.") from e

    coordinates = (rect.x0, rect.y0, rect.x1, rect.y1)
    if not all(
        value == value and abs(value) != float("inf")
        for value in coordinates
    ):
        raise ImageRenderError(f"Invalid bbox values: {bbox}. Values must be finite numbers.")

    if rect.is_empty or rect.is_infinite:
        raise ImageRenderError(f"Invalid bbox values: {bbox}. Bounding box cannot be empty or infinite.")

    # prevents from extending beyond the page boundaries
    rect = rect&page_rect
    if rect.is_empty:
        raise ImageRenderError(f"Bounding box {bbox} is outside the page boundaries {page_rect}.")
    return rect

def render_question_images(
        pdf_path: str|Path,
        question_regions: list[dict[str,Any]],
        output_dir: str|Path,
        dpi: int = DEFAULT_DPI,
        padding: int = DEFAULT_PADDING
) -> list[dict[str,Any]]:
    pdf_path = Path(pdf_path)
    output_dir = Path(output_dir)

    if not pdf_path.is_file():
        raise ImageRenderError(f"PDF file not found: {pdf_path}")

    if not 72<=dpi<=MAX_DPI:
        raise ImageRenderError(f"DPI must be between 72 and {MAX_DPI}. Given: {dpi}")

    if padding < 0:
        raise ImageRenderError(f"Padding must be non-negative. Given: {padding}")

    output_dir.mkdir(parents=True, exist_ok=True)
    rendered_images = []
    try:
        with pymupdf.open(pdf_path) as document:
            if document.is_encrypted:
                raise ImageRenderError(f"PDF file is encrypted: {pdf_path}")
            for question in question_regions:
                question_number = question.get("question_number")
                regions = question.get("regions")

                if not isinstance(question_number, int) or question_number < 1:
                    raise ImageRenderError("Question number must be a positive integer.")

                if not isinstance(regions, list) or not regions:
                    raise ImageRenderError(f"Question {question_number} has no regions.")

                for region_index, region in enumerate(regions, start=1):

                    page_index = region.get("page_index")
                    bbox = region.get("bbox")

                    if not isinstance(page_index, int):
                        raise ImageRenderError("Page index must be an integer.")

                    if not 0 <= page_index < len(document):
                        raise ImageRenderError(f"Invalid page index: {page_index}")

                    page = document.load_page(page_index)

                    rect = _validate_bbox(bbox, page.rect)

                    # Expand crop slightly so text near boundaries
                    # is not accidentally clipped.
                    rect = pymupdf.Rect(
                        rect.x0 - padding,
                        rect.y0 - padding,
                        rect.x1 + padding,
                        rect.y1 + padding,
                    )

                    rect = rect & page.rect

                    matrix = pymupdf.Matrix(
                        dpi / 72,
                        dpi / 72
                    )

                    pixmap = page.get_pixmap(
                        matrix=matrix,
                        clip=rect,
                        colorspace=pymupdf.csRGB,
                        alpha=False,
                    )

                    filename = _img_filename(
                        question_number,
                        region_index
                    )

                    output_path = output_dir / filename

                    pixmap.save(output_path)

                    rendered_images.append({
                        "question_number": question_number,
                        "part": region_index,
                        "page_number": page_index + 1,
                        "filename": filename,
                        "path": str(output_path),
                        "width": pixmap.width,
                        "height": pixmap.height,
                        "format": "JPEG",
                        "mime_type": "image/jpeg",
                    })

    except ImageRenderError:
        raise

    except Exception as error:
        raise ImageRenderError(
            f"Unable to render PDF question images: {error}"
        ) from error

    return rendered_images
