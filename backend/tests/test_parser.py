"""Regression tests for Amibrave's text-based PDF question parser.

Run from the backend directory:
    python -m unittest discover -s tests -p "test_*.py" -v

These tests generate small PDFs in memory. They do not depend on a particular
GATE paper or institution-specific header/footer wording.
"""

import tempfile
import unittest
from pathlib import Path

import pymupdf

from parser import detect_question_marker, extract_questions


class ParserRegressionTests(unittest.TestCase):
    @staticmethod
    def make_pdf(pages: list[list[tuple[float, float, str]]]) -> bytes:
        """Create a PDF from (x, y, text) placements, one list per page."""
        document = pymupdf.open()
        for placements in pages:
            page = document.new_page(width=612, height=792)
            for x, y, text in placements:
                page.insert_text((x, y), text)
        pdf_bytes = document.tobytes()
        document.close()
        return pdf_bytes

    @staticmethod
    def extract(pdf_bytes: bytes) -> dict:
        result, status = extract_questions(pdf_bytes)
        if status != 200:
            raise AssertionError(f"Expected HTTP 200, got {status}: {result}")
        return result

    def test_cross_page_question_is_one_logical_question(self):
        pdf_bytes = self.make_pdf([
            [
                (72, 72, "Q.12 Which statements about the system are correct?"),
                (90, 102, "(A) First option"),
                (90, 122, "(B) Second option"),
            ],
            [
                (90, 72, "(C) Third option continued on the next page"),
                (90, 92, "(D) Fourth option"),
                (72, 142, "Q.13 Calculate the numerical value of x."),
            ],
        ])

        result = self.extract(pdf_bytes)
        self.assertEqual(result["meta"]["total_questions"], 2)

        question_12, question_13 = result["questions"]
        self.assertEqual(question_12["num"], 12)
        self.assertEqual(question_12["source_pages"], [1, 2])
        self.assertEqual(len(question_12["options"]), 4)
        self.assertEqual(len(question_12["question_regions"]), 2)

        self.assertEqual(question_13["num"], 13)
        self.assertEqual(question_13["type"], "nat")
        self.assertEqual(question_13["options"], [])

    def test_question_range_headings_are_not_questions(self):
        for heading in (
            "Q.1 - Q.5 Carry ONE mark Each",
            "Q.1 – Q.5",
            "Q1 to Q5",
            "1 - 5",
        ):
            with self.subTest(heading=heading):
                self.assertIsNone(detect_question_marker(heading))

        result = self.extract(self.make_pdf([[
            (72, 90, "Q.1 – Q.5 Carry ONE mark Each"),
            (72, 150, "Q.1 Which statement is correct?"),
            (72, 220, "Q.2 Calculate the value of x."),
        ]]))
        self.assertEqual([q["num"] for q in result["questions"]], [1, 2])

    def test_repeated_headers_and_footers_are_ignored_dynamically(self):
        pages = []
        for number in range(1, 4):
            pages.append([
                (72, 28, "Department of Advanced Computing and Systems"),
                (72, 150, f"Q.{number} Find the value of variable x."),
                (72, 760, f"Technical Assessment 2026 Page {number}"),
            ])

        result = self.extract(self.make_pdf(pages))
        self.assertEqual([q["num"] for q in result["questions"]], [1, 2, 3])
        combined_text = " ".join(q["text"] for q in result["questions"])
        self.assertNotIn("Department of Advanced Computing", combined_text)
        self.assertNotIn("Technical Assessment", combined_text)

    def test_repeated_text_in_question_body_is_preserved(self):
        repeated_sentence = "Assume the system is in a stable state."
        pages = [
            [
                (72, 150, "Q.1 " + repeated_sentence),
                (72, 180, "Find the output for the given input."),
            ],
            [
                (72, 150, "Q.2 " + repeated_sentence),
                (72, 180, "Calculate the corresponding value."),
            ],
        ]

        result = self.extract(self.make_pdf(pages))
        self.assertEqual(len(result["questions"]), 2)
        for question in result["questions"]:
            self.assertIn(repeated_sentence, question["text"])

    def test_two_column_questions_are_kept_in_column_reading_order(self):
        result = self.extract(self.make_pdf([[
            (55, 120, "Q.1 First column question."),
            (55, 150, "Its first-column continuation."),
            (340, 120, "Q.2 Second column question."),
            (340, 150, "Its second-column continuation."),
        ]]))

        self.assertEqual([q["num"] for q in result["questions"]], [1, 2])
        self.assertIn("first-column continuation", result["questions"][0]["text"])
        self.assertIn("second-column continuation", result["questions"][1]["text"])

    def test_option_continuation_across_pages_is_preserved(self):
        result = self.extract(self.make_pdf([
            [
                (72, 100, "Q.1 Select the correct option."),
                (90, 130, "(A) This option begins on page one"),
            ],
            [
                (110, 72, "and continues on page two"),
                (90, 100, "(B) Another option"),
                (72, 160, "Q.2 Find the numerical answer."),
            ],
        ]))

        question_1 = result["questions"][0]
        self.assertEqual(question_1["num"], 1)
        self.assertEqual(len(question_1["options"]), 2)
        self.assertIn(
            "continues on page two",
            question_1["options"][0]["text"],
        )
        self.assertEqual(question_1["source_pages"], [1, 2])

    def test_mathematical_and_special_characters_are_preserved(self):
        expected = "Find x² + y² = 25 and evaluate ±5."
        result = self.extract(self.make_pdf([[
            (72, 120, "Q.1 " + expected),
        ]]))

        self.assertIn("x²", result["questions"][0]["text"])
        self.assertIn("y² = 25", result["questions"][0]["text"])
        self.assertIn("±5", result["questions"][0]["text"])

    def test_duplicate_question_numbers_generate_warning(self):
        result = self.extract(self.make_pdf([[
            (72, 100, "Q.1 First occurrence of this question."),
            (72, 180, "Q.1 Duplicate occurrence of this question."),
        ]]))

        self.assertEqual(result["meta"]["total_questions"], 1)
        self.assertTrue(
            any("Question number 1 appears more than once" in warning
                for warning in result["warnings"])
        )

    def test_renderer_produces_one_image_per_page_region(self):
        """Renderer integration test; uses a portable temporary directory."""
        from image_renderer import render_question_images

        pdf_bytes = self.make_pdf([
            [
                (72, 72, "Q.12 Which statements are correct?"),
                (90, 102, "(A) First option"),
                (90, 122, "(B) Second option"),
            ],
            [
                (90, 72, "(C) Third option"),
                (90, 92, "(D) Fourth option"),
                (72, 142, "Q.13 Calculate x."),
            ],
        ])
        result = self.extract(pdf_bytes)

        with tempfile.TemporaryDirectory(prefix="amibrave-test-") as temp_dir:
            root = Path(temp_dir)
            pdf_path = root / "source.pdf"
            output_dir = root / "images"
            pdf_path.write_bytes(pdf_bytes)

            images = render_question_images(
                pdf_path,
                result["question_regions"],
                output_dir,
                dpi=120,
            )

            # Q12 spans two pages and Q13 occupies one page.
            self.assertEqual(len(images), 3)
            self.assertTrue(all(Path(item["path"]).is_file() for item in images))
            self.assertTrue(
                all(item["mime_type"] == "image/jpeg" for item in images)
            )


if __name__ == "__main__":
    unittest.main()
