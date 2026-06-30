# Amibrave

**GATE Practice Paper Generator** — Upload a PDF, get a timed exam with scoring and PDF download. No login, no data stored.

---

## Project structure

```
amibrave/
├── backend/
│   ├── app.py              # Flask entry point, routes, middleware
│   ├── parser.py           # Adaptive PDF extraction pipeline
│   ├── gemini.py           # Gemini Vision API fallback handler
│   ├── errors.py           # All error and warning definitions
│   ├── requirements.txt    # Python dependencies
│   └── .env.example        # Environment variable template
└── frontend/
    ├── index.html          # App shell and screen markup
    ├── style.css           # Responsive styles, design tokens
    └── script.js           # All frontend logic
```

---

## Backend setup

### 1. Prerequisites
- Python 3.11+
- [Gemini API key](https://aistudio.google.com) (free tier)
- `poppler` installed on system (required by `pdf2image`)

```bash
# Ubuntu / Debian
sudo apt-get install poppler-utils

# macOS
brew install poppler
```

### 2. Install dependencies
```bash
cd backend
python -m venv venv
source venv/bin/activate       # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### 3. Configure environment
```bash
cp .env.example .env
# Edit .env and add your GEMINI_API_KEY
```

### 4. Run locally
```bash
python app.py
# Server starts at http://localhost:5000
```

---

## Frontend setup

No build step needed. Open `frontend/index.html` in a browser, or serve it with any static file server:

```bash
cd frontend
python -m http.server 5500
# Visit http://localhost:5500
```

Update `BACKEND_URL` in `script.js` to point to your running backend:
```js
const BACKEND_URL = "http://localhost:5000";  // local
const BACKEND_URL = "https://your-app.onrender.com";  // production
```

---

## Deploy to Render (free tier)

1. Push the `backend/` folder to a GitHub repository
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your repo
4. Set:
   - **Build command:** `pip install -r requirements.txt`
   - **Start command:** `gunicorn app:app`
   - **Environment:** Python 3.11
5. Add environment variables from `.env.example`
6. Deploy

## Deploy frontend to GitHub Pages

1. Push `frontend/` contents to a GitHub repo
2. Go to repo Settings → Pages → Deploy from branch `main` / `root`
3. Update `ALLOWED_ORIGINS` in Render environment variables to include your Pages URL
4. Update `BACKEND_URL` in `script.js` to your Render URL

---

## How it works

```
User uploads PDF
      │
      ▼
Backend: pdfplumber extracts text
      │
      ├─ Page 1 relevant? ──YES──► Sequential extraction
      │
      └─ NO ──► Random sampling (6 pages, skip first 2)
                    │
                    ├─ Hit found? ──YES──► Resume sequential from hit
                    │
                    └─ NO ──► Gemini Vision on sampled pages
                                  │
                                  ├─ Hit found? ──YES──► Sequential with Gemini
                                  │
                                  └─ NO ──► ERR_005 (unreadable)

Per page:
  pdfplumber text quality check
      │
      ├─ Good (≥50 clean chars, <30% garbled) ──► Regex parse
      │
      └─ Poor ──► Gemini Vision fallback
```

---

## Limitations

- Best results with digitally-created PDFs (not scanned)
- Mathematical equations in scanned pages require Gemini API
- Gemini free tier: 15 requests/minute, 1500/day
- Render free tier: sleeps after 15 min inactivity (30–50s cold start)
