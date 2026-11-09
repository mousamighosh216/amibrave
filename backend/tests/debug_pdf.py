import pymupdf

PDF_PATH = "../CS12025.pdf"

doc = pymupdf.open(PDF_PATH)

for page_number, page in enumerate(doc.pages(), start=1):
    text = page.get_text("text")

    print(f"\n{'=' * 60}")
    print(f"PAGE {page_number}")
    print("=" * 60)

    print(repr(text[:1200]))