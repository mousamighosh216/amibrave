# Amibrave — Contributing Guide

Code structure, design decisions, and guidance for extending the project.

---

## Backend

### File responsibilities

| File          | Responsibility                                                                 |
|---------------|--------------------------------------------------------------------------------|
| `app.py`      | Flask routes, CORS, request validation, concurrency limiting, timeout wrapper  |
| `parser.py`   | Full adaptive extraction pipeline — pdfplumber, regex parser, phase switching  |
| `gemini.py`   | Gemini Vision API client — image conversion, prompt, response parsing          |
| `errors.py`   | Single source of truth for all error/warning dicts and HTTP status codes       |

### Adding a new error

1. Open `errors.py`
2. Add a new function following the existing pattern:
```python
def err_my_new_error(some_param: str):
    """ERR_012 — Description of when this fires."""
    return _base(
        "ERR_012",
        "Short user-facing message.",
        f"Detailed explanation with {some_param}.",
        422   # appropriate HTTP status
    )
```
3. Import and call it in the relevant file
4. Document it in `ERRORS.md`

### Adding a new endpoint

1. Define the route in `app.py`
2. Always apply `@with_concurrency_limit` and `@with_timeout` decorators
3. Use `validate_pdf_upload()` for any PDF-accepting endpoint
4. Document in `API.md`

### Modifying the parsing pipeline

The adaptive flow lives in `parser.py`:

```
extract_questions()         ← main entry point
  │
  ├── Phase 1: sequential  ← calls _sequential_extract()
  ├── Phase 2: random      ← random.sample() + _is_page_relevant()
  ├── Phase 3: Gemini scan ← extract_page_with_gemini()
  └── Phase 4: resume      ← _sequential_extract() from first_hit

_sequential_extract()       ← per-page loop, calls should_use_gemini()
_parse_text_to_questions()  ← regex question splitting
_extract_single_question()  ← regex option detection per chunk
```

The Gemini trigger logic (`should_use_gemini`) is in `gemini.py`. To adjust thresholds:
```python
# gemini.py
if clean_chars < 50:           # ← adjust minimum clean characters
if garbled_ratio > 0.30:       # ← adjust garbled unicode threshold
```

---

## Frontend

### File responsibilities

| File          | Responsibility                                                              |
|---------------|-----------------------------------------------------------------------------|
| `index.html`  | Screen markup, semantic HTML, ARIA labels, external script/style imports    |
| `style.css`   | All visual design — tokens, layout, components, responsive breakpoints      |
| `script.js`   | All runtime logic — upload, API calls, exam engine, scoring, download       |

### Design tokens

All visual values are CSS custom properties in `:root {}` at the top of `style.css`. Change colours, spacing, radii, and fonts there — never hardcode values elsewhere.

```css
/* Example — changing accent colour */
:root {
  --accent      : #6674f4;   /* ← change this */
  --accent-hover: #7b88f6;   /* ← and this */
}
```

### Adding a new screen

1. Add `<section id="s-myscreen" class="screen">` in `index.html`
2. Call `goScreen("s-myscreen")` from JS to navigate to it
3. Call `goScreen("s-upload")` or another screen to navigate away

### App state

All runtime data lives in the `state` object at the top of `script.js`. Never store data outside this object — it makes `resetAll()` reliable.

```js
const state = {
  questions   : [],    // parsed question objects
  answers     : {},    // { questionIndex: ["A", "C"] }
  answerKey   : {},    // { questionNum: "B" }
  ...
};
```

### Extending scoring

Scoring logic is in `calcScore()` and `getMark()` in `script.js`. To add a new marking scheme:

1. Add an `<option>` to the `#marking` select in `index.html`
2. Handle the new value in `getMark()`:
```js
function getMark(type, isCorrect) {
  if (state.marking === "my-scheme") return isCorrect ? 3 : -1;
  ...
}
```

---

## Responsive breakpoints

| Breakpoint   | Width       | What changes                                          |
|--------------|-------------|-------------------------------------------------------|
| Mobile small | ≤ 480px     | Single-column layout, full-width buttons, smaller type|
| Mobile large | ≤ 600px     | Upload grid collapses to 1 column                     |
| Tablet+      | > 600px     | Full 2-column upload grid, side-by-side actions       |

---

## Environment variables reference

| Variable         | Required | Default                   | Description                          |
|------------------|----------|---------------------------|--------------------------------------|
| `GEMINI_API_KEY` | Yes      | —                         | Google Gemini API key                |
| `ALLOWED_ORIGINS`| No       | localhost variants        | Comma-separated CORS allowed origins |
| `FLASK_ENV`      | No       | `production`              | Set to `development` for debug mode  |
| `PORT`           | No       | `5000`                    | Server port (auto-set by Render)     |
