# [Amibrave](https://amibrave-frontend.vercel.app/)

# GATE Practice Paper Generator

Upload a PDF and turn it into an interactive, timed GATE practice examination with question navigation, answer selection, scoring, and PDF download.

**No login. No AI APIs. No external AI services. No permanent storage of uploaded question papers.**

Amibrave uses a deterministic Python-based PDF extraction pipeline. It extracts question text and options wherever possible and preserves mathematical equations, diagrams, graphs, and other complex visual content using original PDF image references.

---

## 1. Project Structure

```text
amibrave/
├── backend/
│   ├── app.py                 # Flask entry point, routes, middleware
│   ├── parser.py              # Main adaptive PDF extraction pipeline
│   ├── question_parser.py     # Question and option identification
│   ├── image_renderer.py      # PDF rendering and question-region cropping
│   ├── errors.py              # Error and warning definitions
│   ├── requirements.txt       # Python dependencies
│   └── .env.example           # Environment configuration
│
├── frontend/
│   ├── index.html             # Application shell and screen markup
│   ├── style.css              # Responsive styles and design tokens
│   └── script.js              # Exam interface and application logic
│
├── README.md
└── .gitignore
```

### Module responsibilities

**`app.py`**
- Initializes the Flask application.
- Handles PDF uploads.
- Exposes extraction and examination APIs.
- Validates requests and handles errors.
- Manages temporary files and cleanup.

**`parser.py`**
- Coordinates the entire extraction pipeline.
- Processes PDF pages sequentially.
- Determines whether a page has extractable text.
- Calls the question parser and image renderer.
- Combines extracted content into structured question objects.

**`question_parser.py`**
- Detects question numbers.
- Identifies question boundaries.
- Extracts question statements and options.
- Associates extracted text with its corresponding page and coordinates.
- Identifies numerical and short-answer questions.
- Detects obviously incomplete or missing extracted content.

**`image_renderer.py`**
- Renders original PDF pages using PyMuPDF.
- Extracts page images and renders vector-based diagrams.
- Crops question-specific regions using page coordinates.
- Preserves mathematical equations, tables, graphs, and diagrams.
- Provides page-level image references when question-level boundaries cannot be determined.

**`errors.py`**
- Defines extraction errors, warnings, and validation responses.

---

## 2. Technology Stack

| Component | Technology | Purpose |
|---|---|---|
| Backend | Python 3.11+ | Application logic |
| API | Flask | Backend endpoints |
| PDF processing | PyMuPDF (`fitz`) | Text extraction, coordinates, rendering |
| Image processing | Pillow | Image manipulation and cropping |
| Frontend | HTML, CSS, JavaScript | Exam interface |
| HTTP communication | Fetch API | Frontend/backend communication |
| Deployment | Render | Backend hosting |
| Static hosting | GitHub Pages | Frontend hosting |

No AI model, LLM API, OCR service, or external vision API is required.

### Python dependencies

```text
Flask
Flask-Cors
PyMuPDF
Pillow
python-dotenv
gunicorn
```

---

## 3. Backend Setup

### Prerequisites

- Python 3.14+
- pip
- Git

PyMuPDF handles PDF rendering internally. Poppler is not required.

### Install dependencies

```bash
cd backend

python -m venv venv

# Linux / macOS
source venv/bin/activate

# Windows
venv\Scripts\activate

pip install -r requirements.txt
```

### Configure environment

```bash
cp .env.example .env
```

Example `.env`:

```env
FLASK_ENV=development
PORT=5000
MAX_CONTENT_LENGTH=20971520
ALLOWED_ORIGINS=http://localhost:5500
```

There is no `GEMINI_API_KEY` or other AI API configuration.

### Run locally

```bash
python app.py
```

Backend:

```text
http://localhost:5000
```

---

## 4. Frontend Setup

The frontend is a React application built with Vite. Run Vite so it can transform
the JSX modules; do not serve the source with `python -m http.server`.

```bash
cd frontend
npm install
npm run dev
```

Open the URL printed by Vite (by default, `http://localhost:5173`).

---

## 5. How the PDF Extraction Pipeline Works

The extraction system follows a deterministic, adaptive pipeline.

```text
                USER UPLOADS PDF
                       |
                       v
              Validate PDF file
                       |
                       v
               Open using PyMuPDF
                       |
                       v
              Process pages in order
                       |
                       v
             Extract text and blocks
             with page coordinates
                       |
                       v
              Check text availability
                       |
             +---------+---------+
             |                   |
          TEXT FOUND          NO TEXT
             |                   |
             v                   v
       Text quality check   Render original
             |              page as image
             |                   |
       +-----+-----+             v
       |           |        Image reference
     GOOD        POOR       / manual region
       |           |           selection
       v           v
   Parse text   Image-first
   and options   fallback
       |           |
       +-----+-----+
             |
             v
      Detect question anchors
      and question boundaries
             |
             v
      Associate text with
      corresponding page regions
             |
             v
      Render question-specific
      image crops when needed
             |
             v
      Build structured question
      objects
             |
             v
       Return JSON response
             |
             v
        FRONTEND EXAM
```

### Step 1: PDF validation

The backend validates:

- File extension and PDF signature.
- File size.
- Whether the PDF can be opened.
- Whether the document contains readable pages.

Invalid or corrupted PDFs return appropriate error responses.

### Step 2: Extract text and coordinates

PyMuPDF extracts text from each page.

```python
import fitz

document = fitz.open("question_paper.pdf")

for page_number, page in enumerate(document):
    blocks = page.get_text("blocks")

    for block in blocks:
        x0, y0, x1, y1 = block[:4]
        text = block[4]

        print(page_number, x0, y0, x1, y1, text)
```

The coordinates allow the system to associate extracted text with its original position.

### Step 3: Text quality assessment

Each page is checked for:

- Available text length.
- Empty or missing text.
- Excessive garbled characters.
- Unusually incomplete text blocks.

A configurable quality threshold determines whether extracted text is suitable for parsing.

A page with insufficient or unreliable text is routed to image-first handling.

### Step 4: Question identification

The question parser identifies question-number patterns and option labels.

Examples:

```text
Q.1
Q1.
Question 1
1.
```

The parser uses the document's reading order and text coordinates to identify question boundaries.

For example:

```text
Page 1:

Q.1 Question statement...
A. Option one
B. Option two
C. Option three
D. Option four

Q.2 Next question...
```

The content between consecutive question anchors is associated with the corresponding question.

Question boundaries can span multiple pages. Therefore, page number and vertical position must both be considered.

### Step 5: Image-based question preservation

This is a core feature of Amibrave.

The system must not depend on successful mathematical equation or diagram extraction.

Whenever question content is missing, incomplete, or visually complex, the original PDF region can be used as the question reference.

The image renderer:

1. Identifies the question's page region.
2. Uses PyMuPDF to render that region.
3. Preserves equations, diagrams, graphs, tables, and formatting.
4. Stores the rendered image temporarily.
5. Associates the image reference with the corresponding question.

This avoids reconstructing equations through potentially inaccurate text conversion.

### Step 6: Image-first fallback

If extracted text is missing or obviously incomplete:

- The original question image becomes the primary question display.
- Extracted text is not required to display the question.
- The printed options remain visible inside the image.
- The frontend presents selectable answer labels: A, B, C, D.
- The user selects the answer without needing the question to be reconstructed as text.

Example:

```json
{
  "id": 2,
  "type": "mcq",
  "displayMode": "image",
  "stem": null,
  "options": [
    {"label": "A"},
    {"label": "B"},
    {"label": "C"},
    {"label": "D"}
  ],
  "image": "/temporary/question-2.png",
  "sourcePage": 2
}
```

For successfully extracted questions:

```json
{
  "id": 3,
  "type": "mcq",
  "displayMode": "text",
  "stem": "Which of the following statements is correct?",
  "options": [
    {"label": "A", "text": "Option one"},
    {"label": "B", "text": "Option two"},
    {"label": "C", "text": "Option three"},
    {"label": "D", "text": "Option four"}
  ],
  "image": "/temporary/question-3.png",
  "sourcePage": 3
}
```

### Step 7: Manual image-first override

Automatic text-quality checks cannot reliably detect every partially missing mathematical expression.

Therefore, every question must have an option to switch to image-first mode manually.

The frontend should provide:

```text
[ ] Use original image as the question
```

When enabled:

- Hide the extracted question statement.
- Display the original question crop.
- Display independent answer labels.
- Preserve the user's selected answer.

When disabled, return to the extracted text representation.

### Important extraction limitation

Without OCR or AI, a scanned PDF containing no text layer cannot always be automatically divided into individual questions.

For such documents, Amibrave must provide a page-image workflow with manual region selection, or explicitly use a whole-page image when individual boundaries are unavailable.

It must never silently assign an entire page to an incorrectly identified question.

---

## 6. Question Data Structure

All extracted questions should follow a consistent schema.

```json
{
  "id": 1,
  "type": "mcq",
  "displayMode": "text",
  "stem": "Question statement",
  "options": [
    {
      "label": "A",
      "text": "Option A"
    },
    {
      "label": "B",
      "text": "Option B"
    },
    {
      "label": "C",
      "text": "Option C"
    },
    {
      "label": "D",
      "text": "Option D"
    }
  ],
  "image": null,
  "sourcePage": 1,
  "sourceRegion": {
    "x0": 50,
    "y0": 100,
    "x1": 550,
    "y1": 400
  },
  "requiresManualReview": false
}
```

Supported question types:

- MCQ
- MSQ
- NAT (Numerical Answer Type)
- Short-answer questions

For image-first questions, the question image contains the original content, while the answer labels remain independently selectable.

---

## 7. Examination Features

The frontend will provide:

### Exam interface

- Timed examination.
- Question navigation.
- Previous and next controls.
- Question palette.
- Answer selection.
- Mark for review.
- Answered and unanswered indicators.
- Image zoom for mathematical questions and diagrams.
- Automatic progress tracking.

### Answer handling

- MCQ: Single-answer selection.
- MSQ: Multiple-answer selection.
- NAT: Numerical input.
- Short-answer: Text input where applicable.

### Scoring

Scoring must be configurable according to the examination's marking scheme.

The system should support:

- Correct-answer marks.
- Incorrect-answer penalties.
- Zero-mark questions.
- Partial marking where applicable.

An answer key must be available before correctness-based scoring can be performed. It can be supplied separately or configured for the examination.

If no answer key is available, the system can still conduct the timed examination and record responses, but must not invent correctness or scores.

### Results

After submission:

- Total attempted questions.
- Unattempted questions.
- Correct and incorrect answers, when an answer key exists.
- Total score, when scoring information exists.
- Time taken.
- Question-wise response review.

### PDF download

Users can download their examination responses and results as a PDF.

The exported document should include:

- Examination details.
- Question numbers.
- Selected answers.
- Correct answers, if available.
- Marks obtained, if available.
- Final score, if available.

---

## 8. API Structure

Suggested backend endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/upload` | Upload and process a PDF |
| GET | `/api/exam/:id` | Retrieve generated examination |
| GET | `/api/question/:examId/:questionId` | Retrieve a question |
| POST | `/api/submit/:examId` | Submit examination responses |
| GET | `/api/results/:examId` | Retrieve examination results |
| GET | `/api/export/:examId` | Generate and download result PDF |

These are proposed endpoint contracts. Their implementation should follow the same question schema throughout the application.

---

## 9. Error Handling

Suggested error codes:

| Code | Description |
|---|---|
| ERR_001 | No file uploaded |
| ERR_002 | Invalid file format |
| ERR_003 | PDF exceeds maximum size |
| ERR_004 | Corrupted or unreadable PDF |
| ERR_005 | No extractable questions detected |
| ERR_006 | Question boundaries could not be identified |
| ERR_007 | Image rendering failed |
| ERR_008 | Unsupported question structure |
| ERR_009 | Invalid examination submission |
| WARN_001 | Page contains no extractable text |
| WARN_002 | Question is displayed using original image |
| WARN_003 | Question requires manual boundary verification |
| WARN_004 | Mathematical or visual content may require image-first mode |
| WARN_005 | Answer key unavailable; automatic scoring disabled |

Warnings should not unnecessarily prevent examination generation.

---

## 10. Privacy and Temporary File Management

Amibrave does not require user accounts.

The intended processing flow is:

```text
PDF Upload
    |
    v
Temporary Processing
    |
    v
Question Extraction
    |
    v
Temporary Image Rendering
    |
    v
Examination Generation
    |
    v
User Takes Examination
    |
    v
Export Results
    |
    v
Temporary Files Deleted
```

Requirements:

- Uploaded PDFs must not be permanently stored.
- Generated question images must be temporary.
- Temporary files must be deleted after the examination session expires or is completed.
- No third-party AI services receive uploaded documents.
- No personal account information is required.
- Do not log uploaded document contents.

For a genuinely no-persistent-storage design, temporary files should use isolated session directories and cleanup must be implemented on success, failure, timeout, and application restart.

---

## 11. Deployment

### Backend: Render

1. Push the project to GitHub.
2. Open Render.
3. Select New → Web Service.
4. Connect the repository.
5. Configure:

**Build command**

```bash
pip install -r backend/requirements.txt
```

**Start command**

```bash
cd backend && gunicorn app:app
```

**Environment**

```text
Python 3.11
```

Configure `ALLOWED_ORIGINS` with the deployed frontend URL.

### Frontend: GitHub Pages

1. Push the frontend folder to a GitHub repository.
2. Open repository Settings.
3. Select Pages.
4. Deploy from the `main` branch and the appropriate folder.
5. Configure the production backend URL in `script.js`.

---

## 12. Development Principles

The following rules guide implementation:

1. No Gemini, OpenAI, or other AI API fallback.
2. No external OCR service.
3. Prefer native PDF text extraction and coordinate-based parsing.
4. Preserve original mathematical and visual content through PDF rendering.
5. Do not discard questions simply because their text extraction failed.
6. Use image-first fallback for missing or incomplete extracted content.
7. Provide manual image-first override for every question.
8. Never fabricate extracted text or answer options.
9. Keep question parsing separate from image rendering.
10. Keep examination logic independent of PDF extraction.
11. Handle multi-page questions and multiple questions per page.
12. Validate extraction results before generating the examination.
13. Do not store uploaded papers or user responses permanently.

---

## 13. Future Improvements

Potential improvements without introducing AI dependencies:

- Visual question-boundary detection.
- Manual crop editor for scanned papers.
- Improved mathematical-content detection.
- More question-numbering pattern support.
- Multiple answer-key formats.
- Configurable GATE marking schemes.
- Better extraction validation.
- Client-side examination autosave for the current session.
- Support for additional competitive examination formats.

**Core philosophy:** Extract what can be extracted reliably. Preserve what cannot be extracted accurately. Never sacrifice the original question's meaning for a cleaner-looking text representation.
