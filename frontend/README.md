# Amibrave frontend

React 19 + Vite frontend for the Amibrave GATE practice-paper workflow.

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Leave `VITE_API_BASE_URL` blank to use `http://127.0.0.1:5000` during development and `https://amibrave.onrender.com` in production. Set it explicitly when your Flask API runs elsewhere. Restart Vite after changing the value. Set `VITE_BASE_PATH` to `/` for a custom domain or user site. For a GitHub Pages project site, set it to `/<repository-name>/` before building.

## Flask CORS

Allow the exact Vite origins `http://localhost:5173` and `http://127.0.0.1:5173` during local development. Keep the deployed GitHub Pages origin in the allowlist if that is where this frontend is hosted.

## Frontend workflow

1. Select a question-paper PDF and optionally an answer-key PDF.
2. Process the paper through `POST /api/exams/process`; process an optional key through `POST /extract-key`.
3. Review, edit, add, or remove extracted questions.
4. Start a timed exam. MCQ, MSQ, and NAT answer controls are supported when the API supplies the corresponding question type.
5. Answers and the deadline are autosaved locally. Refreshing or reopening the browser restores an unfinished exam and the timer continues against its original deadline.
6. Submit to see attempt statistics. Correctness and score are shown only when at least one question has a usable answer-key entry.
7. Download the JSON export. Detailed local exam data is retained until the user confirms that the download step is complete. The lifetime solved-paper count is kept separately.

## Local data lifecycle

- IndexedDB stores the active exam, original question-paper PDF, extracted question data, and source-image Blobs.
- The original PDF is cleared on submission. Detailed exam data and source images remain until the user confirms export cleanup.
- JSON export includes question metadata, selected answers, review flags, source pages, image-part references, and summary statistics. It does not embed image bytes or the original PDF.
- Discarding an unfinished paper clears its detailed data without changing the solved-paper count.
- **Clear all app data** resets the active exam, lifetime count, and saved theme preference.
- No login or server-side exam-history storage is implemented by this frontend.

## Known boundaries

- Upload progress is measurable. The current Flask endpoint processes a request synchronously and does not expose server-side stage progress, so the loading screen waits at the upload-complete stage until the response arrives. True extraction progress requires a backend job/status or streaming endpoint.
- The frontend does not infer MSQ from the number of options. The API must return `type: "msq"` explicitly. GATE-style negative marking is applied only to MCQ questions; MSQ and NAT incorrect responses do not receive a negative penalty.
- GATE marking in this UI currently applies the displayed fixed `+2 / -0.67` values. It does not infer the real per-question 1-mark/2-mark allocation from the PDF.
- NAT answers are compared numerically for exact equality. A configurable tolerance is not implemented.
- Browser storage is local to the current browser profile and can be removed by browser settings or private-browsing cleanup. It is not a cross-device backup.

## Build

```bash
npm run build
npm run preview
```
