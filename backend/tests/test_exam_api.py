
import base64
import json
import sys
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

API_URL = "http://127.0.0.1:5000/api/exams/process"


def test_exam_api(pdf_path):
    pdf_path = Path(pdf_path)

    if not pdf_path.is_file():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")

    boundary = "----AmibraveTestBoundary"
    pdf_bytes = pdf_path.read_bytes()

    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{pdf_path.name}"\r\n'
        "Content-Type: application/pdf\r\n\r\n"
    ).encode() + pdf_bytes + f"\r\n--{boundary}--\r\n".encode()

    request = Request(
        API_URL,
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}"
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=120) as response:
            result = json.loads(response.read())
            print(f"HTTP status: {response.status}")

    except HTTPError as error:
        print(f"API returned HTTP {error.code}")
        print(error.read().decode(errors="replace"))
        return

    except URLError as error:
        print(f"Could not connect to Flask: {error}")
        return

    questions = result.get("questions", [])
    images = result.get("images", [])
    meta = result.get("meta", {})

    print("\n--- API SUMMARY ---")
    print("Questions:", len(questions))
    print("Images:", len(images))
    print("Metadata:", meta)

    image_map = {}

    for image in images:
        key = (image["question_number"], image["part"])
        image_map[key] = image

        image_bytes = base64.b64decode(image["data"], validate=True)

        assert image_bytes.startswith(b"\x89PNG\r\n\x1a\n"), (
            f"Invalid PNG image: {key}"
        )

        assert image["mime_type"] == "image/png"
        assert image["format"] == "png"

    print("\n--- MAPPING VALIDATION ---")

    expected_images = 0

    for question in questions:
        question_number = question["num"]
        regions = question.get("question_regions", [])

        expected_images += len(regions)

        for part, region in enumerate(regions, start=1):
            key = (question_number, part)

            assert key in image_map, (
                f"Missing image for question {question_number}, part {part}"
            )

            image = image_map[key]

            assert image["page_number"] == region["page_index"] + 1, (
                f"Page mismatch for {key}"
            )

    assert len(images) == expected_images, (
        f"Expected {expected_images} images, received {len(images)}"
    )

    print("All question-to-image mappings are valid.")
    print("All returned images contain valid PNG data.")
    print("END-TO-END API TEST PASSED")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python test_exam_api.py <path-to-pdf>")
        sys.exit(1)

    test_exam_api(sys.argv[1])
