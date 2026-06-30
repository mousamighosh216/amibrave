# Amibrave — Error & Warning Reference

---

## Errors

Fatal errors terminate processing and return a non-2xx HTTP status.

| Code    | HTTP | Title                        | Cause                                               | Fix                                                    |
|---------|------|------------------------------|-----------------------------------------------------|--------------------------------------------------------|
| ERR_001 | 413  | File too large               | PDF exceeds 10MB                                    | Compress PDF or split into parts                       |
| ERR_002 | 415  | Invalid file format          | Not a valid PDF, or file is corrupted               | Re-export or re-download the PDF                       |
| ERR_003 | 422  | PDF is password protected    | PDF has encryption or password set                  | Remove password protection before uploading            |
| ERR_004 | 422  | PDF appears to be empty      | PDF has no pages                                    | Check the file is complete and not corrupted           |
| ERR_005 | 422  | File could not be parsed     | 30% of pages sampled returned no readable data      | Use a digitally-created PDF; scanned PDFs need Gemini  |
| ERR_006 | 502  | AI fallback failed           | Gemini API returned an error for a specific page    | Check GEMINI_API_KEY is valid; try again               |
| ERR_007 | 429  | AI quota exceeded            | Gemini free tier daily/minute limit reached         | Wait and retry; check quota at aistudio.google.com     |
| ERR_008 | 422  | PDF contains no text         | Every page returned empty content                   | Ensure PDF has text layer; not a blank document        |
| ERR_009 | 504  | Processing timed out         | Extraction exceeded 60 second limit                 | Use a smaller PDF; reduce page count                   |
| ERR_010 | 429  | Server is busy               | Max concurrent requests (3) already being processed | Wait a moment and retry                                |
| ERR_011 | 500  | Internal server error        | Unexpected unhandled exception                      | Check server logs; file an issue                       |

---

## Warnings

Non-fatal. Attached to successful `200` responses in the `warnings` array. Processing continues.

| Code     | Title                        | Cause                                                      | Action                                                  |
|----------|------------------------------|------------------------------------------------------------|---------------------------------------------------------|
| WARN_001 | File close to size limit     | File is between 8MB and 10MB                               | Consider compressing for faster uploads                 |
| WARN_002 | Pages skipped                | Specific pages could not be parsed (image-only or corrupt) | Review questions in preview editor; affected pages listed|
| WARN_003 | Low confidence parse         | Pages parsed but with high garbled character ratio         | Carefully review listed questions in the preview editor |
| WARN_004 | Answer key partially matched | Some question numbers in key did not match extracted Q nums| Check answer key format uses matching question numbers  |

---

## Example error response

```json
{
  "success": false,
  "error": {
    "code": "ERR_005",
    "message": "File could not be parsed.",
    "detail": "Amibrave sampled 14 of 46 pages and could not extract any readable question data. The PDF may be entirely image-based with no embedded text. Try a digitally-created PDF for best results.",
    "timestamp": "2026-06-30T10:00:00"
  }
}
```

## Example warning in response

```json
{
  "success": true,
  "questions": [...],
  "warnings": [
    {
      "code": "WARN_002",
      "message": "3 page(s) were skipped.",
      "detail": "Pages 5, 12, 23 could not be parsed and were excluded from results. These pages may be image-only or contain unsupported content.",
      "timestamp": "2026-06-30T10:00:00"
    }
  ]
}
```
