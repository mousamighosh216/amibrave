# Amibrave — API Documentation

Base URL: `https://your-app.onrender.com`

All endpoints return JSON. All POST endpoints accept `multipart/form-data`.

---

## GET /health

Returns server status and diagnostics.

**Request**
```
GET /health
```

**Response 200**
```json
{
  "status": "ok",
  "version": "1.0.0",
  "active_requests": 0,
  "max_concurrent": 3,
  "timestamp": "2026-06-30T10:00:00"
}
```

---

## POST /extract

Extract questions from a question paper PDF.

**Request**
```
POST /extract
Content-Type: multipart/form-data

file: <PDF file, max 10MB>
```

**Response 200 — success**
```json
{
  "success": true,
  "questions": [
    {
      "num": 1,
      "text": "Which of the following statements is correct?",
      "type": "mcq",
      "options": [
        { "label": "A", "text": "Option text one" },
        { "label": "B", "text": "Option text two" },
        { "label": "C", "text": "Option text three" },
        { "label": "D", "text": "Option text four" }
      ],
      "source": "pdfplumber"
    },
    {
      "num": 2,
      "text": "Find the value of $\\int_0^1 x^2 dx$",
      "type": "nat",
      "options": [],
      "source": "gemini"
    }
  ],
  "meta": {
    "total_questions": 65,
    "mcq_count": 55,
    "nat_count": 10,
    "total_pages": 46,
    "skipped_pages": 2,
    "gemini_used": true
  },
  "warnings": [
    {
      "code": "WARN_002",
      "message": "2 page(s) were skipped.",
      "detail": "Pages 3, 7 could not be parsed and were excluded from results.",
      "timestamp": "2026-06-30T10:00:00"
    }
  ]
}
```

**Error responses** — see [ERRORS.md](./ERRORS.md)

---

## POST /extract-key

Extract an answer key from a PDF.

**Request**
```
POST /extract-key
Content-Type: multipart/form-data

file: <PDF file, max 10MB>
```

Supported answer key formats in the PDF:
```
Q1 - A       Q.1 → B      (1) C
1. B         1) D          Q1: A
```

**Response 200 — success**
```json
{
  "success": true,
  "answer_key": {
    "1": "A",
    "2": "C",
    "3": "B",
    "65": "D"
  },
  "meta": {
    "matched": 65
  },
  "warnings": []
}
```

**Response 200 — partial match**
```json
{
  "success": true,
  "answer_key": { "1": "A", "3": "C" },
  "meta": { "matched": 2 },
  "warnings": [
    {
      "code": "WARN_004",
      "message": "Answer key partially matched.",
      "detail": "Only 2 of 65 questions were matched in the answer key.",
      "timestamp": "2026-06-30T10:00:00"
    }
  ]
}
```

---

## Error response format

All errors follow this structure:

```json
{
  "success": false,
  "error": {
    "code": "ERR_001",
    "message": "File too large.",
    "detail": "Uploaded file is 12.4MB. Maximum allowed size is 10MB.",
    "timestamp": "2026-06-30T10:00:00"
  }
}
```

---

## Question types

| type  | description                          | options field       |
|-------|--------------------------------------|---------------------|
| `mcq` | Multiple choice (one or more correct)| Array of A–D objects|
| `nat` | Numerical answer type                | Empty array `[]`    |

---

## Source field

| source       | meaning                                         |
|--------------|-------------------------------------------------|
| `pdfplumber` | Extracted via text layer, regex parsed          |
| `gemini`     | Page was image-based, processed via Gemini API  |
| `manual`     | Added manually by user in the preview editor    |

---

## Rate limits & constraints

| constraint         | value                        |
|--------------------|------------------------------|
| Max file size      | 10 MB                        |
| Request timeout    | 60 seconds                   |
| Max concurrent     | 3 simultaneous requests      |
| Gemini fallback    | 15 req/min (free tier limit) |
