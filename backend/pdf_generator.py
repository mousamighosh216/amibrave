"""
Amibrave — PDF Generator
Builds a styled exam results PDF using WeasyPrint.
Receives questions + answers from frontend, returns PDF bytes.
No data is stored — everything processed in memory.
"""

import logging
from datetime import datetime
from typing import Optional

from weasyprint import HTML, CSS

logger = logging.getLogger(__name__)

# ── NTA color palette ─────────────────────────────────────────────────────────
NTA_ORANGE   = "#e55b00"
NTA_GREEN    = "#2e7d32"
NTA_DARKBLUE = "#003399"
NTA_RED      = "#c62828"
NTA_PURPLE   = "#6a1b9a"


# ── Scoring ───────────────────────────────────────────────────────────────────

def calc_score(questions: list, answers: dict, marking: str, custom_marks: dict) -> dict:
    """
    Calculate score from questions and answers.
    answers keyed by string index matching question list position.
    """
    score       = 0.0
    correct     = 0
    wrong       = 0
    unattempted = 0

    for i, q in enumerate(questions):
        ans     = answers.get(str(i), [])
        key_ans = q.get("correctAnswer")

        if not ans:
            unattempted += 1
            continue

        if not key_ans:
            continue

        user_str = "".join(sorted(ans))
        key_list = key_ans if isinstance(key_ans, list) else [key_ans]
        key_str  = "".join(sorted(key_list))

        if user_str == key_str:
            correct += 1
            score   += get_mark(q.get("type","nat"), True, marking, custom_marks)
        else:
            wrong += 1
            score += get_mark(q.get("type","nat"), False, marking, custom_marks)

    return {
        "score"      : round(score * 100) / 100,
        "correct"    : correct,
        "wrong"      : wrong,
        "unattempted": unattempted,
    }


def get_mark(q_type: str, correct: bool, marking: str, custom_marks: dict) -> float:
    if marking == "gate":
        return 2.0 if correct else (-0.67 if q_type == "mcq" else 0.0)
    if marking == "simple":
        return 1.0 if correct else 0.0
    # custom
    if correct:
        return float(custom_marks.get("correct", 1))
    return -abs(float(custom_marks.get("wrong", 0)))


# ── HTML builder ──────────────────────────────────────────────────────────────

def build_html(
    questions : list,
    answers   : dict,
    marked    : dict,
    statuses  : dict,
    marking   : str,
    custom_marks: dict,
    time_taken: str,
) -> str:
    """Build complete HTML string for PDF rendering."""

    has_key  = any(q.get("correctAnswer") for q in questions)
    score_data = calc_score(questions, answers, marking, custom_marks) if has_key else None

    # ── Header ────────────────────────────────────────────────────────────────
    score_html = ""
    if score_data:
        score_html = f"""
        <div class="score-row">
            <div class="score-box">
                <div class="score-num" style="color:{NTA_ORANGE}">{score_data['score']}</div>
                <div class="score-lbl">Score</div>
            </div>
            <div class="score-box">
                <div class="score-num" style="color:{NTA_GREEN}">{score_data['correct']}</div>
                <div class="score-lbl">Correct</div>
            </div>
            <div class="score-box">
                <div class="score-num" style="color:{NTA_RED}">{score_data['wrong']}</div>
                <div class="score-lbl">Wrong</div>
            </div>
            <div class="score-box">
                <div class="score-num" style="color:#888">{score_data['unattempted']}</div>
                <div class="score-lbl">Skipped</div>
            </div>
        </div>"""

    # ── Question rows ─────────────────────────────────────────────────────────
    rows_html = ""
    for i, q in enumerate(questions):
        ans     = answers.get(str(i), [])
        key_ans = q.get("correctAnswer")
        is_marked = marked.get(str(i), False)

        # Determine result
        result_cls   = "skip"
        result_label = "Skipped"
        result_color = "#888888"

        if ans and key_ans:
            user_str = "".join(sorted(ans))
            key_list = key_ans if isinstance(key_ans, list) else [key_ans]
            key_str  = "".join(sorted(key_list))
            if user_str == key_str:
                result_cls   = "correct"
                result_label = "✓ Correct"
                result_color = NTA_GREEN
            else:
                result_cls   = "wrong"
                result_label = "✗ Wrong"
                result_color = NTA_RED
        elif ans:
            result_cls   = "answered"
            result_label = "Answered"
            result_color = NTA_DARKBLUE

        ans_str = ", ".join(ans) if ans else "—"
        key_str_display = ", ".join(key_ans if isinstance(key_ans, list) else [key_ans]) if key_ans else "—"

        mark_flag = " 🔖" if is_marked else ""

        # Options HTML
        opts_html = ""
        if q.get("type") == "mcq" and q.get("options"):
            for o in q["options"]:
                selected   = o["label"] in ans
                is_correct = key_ans and o["label"] in (key_ans if isinstance(key_ans,list) else [key_ans])
                opt_style  = ""
                if selected and is_correct:
                    opt_style = f"background:#e8f5e9;border-color:{NTA_GREEN};color:{NTA_GREEN}"
                elif selected and not is_correct and key_ans:
                    opt_style = f"background:#fdecea;border-color:{NTA_RED};color:{NTA_RED}"
                elif not selected and is_correct and key_ans:
                    opt_style = f"background:#e8f5e9;border-color:{NTA_GREEN};color:{NTA_GREEN}"

                tick = ""
                if selected: tick = " ●"
                opts_html += f"""
                <div class="opt-row" style="{opt_style}">
                    <span class="opt-lbl">{o['label']}.</span>
                    <span>{escape_html(o.get('text',''))}{tick}</span>
                </div>"""

        rows_html += f"""
        <div class="q-block {result_cls}">
            <div class="q-top">
                <div class="q-meta">
                    Q{q['num']} &nbsp;·&nbsp; {q.get('type','').upper()}{mark_flag}
                </div>
                <div class="q-result" style="color:{result_color};border-color:{result_color}">
                    {result_label}
                </div>
            </div>
            <div class="q-text">{escape_html(q.get('text',''))}</div>
            {opts_html}
            <div class="ans-row">
                <span class="ans-label">Your answer:</span>
                <strong>{escape_html(ans_str)}</strong>
                {('<span style="margin:0 6px">|</span><span class="ans-label">Correct:</span> <strong style="color:' + (NTA_GREEN if result_cls == 'correct' else NTA_RED) + '">' + escape_html(key_str_display) + '</strong>') if key_ans else ''}
            </div>
        </div>"""

    # ── Full HTML ─────────────────────────────────────────────────────────────
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

  * {{ box-sizing: border-box; margin: 0; padding: 0; }}

  body {{
    font-family: 'Inter', Arial, sans-serif;
    font-size: 12px;
    color: #1a1a1a;
    background: #ffffff;
    padding: 0;
  }}

  /* ── Page header ── */
  .page-header {{
    background: #ffffff;
    border-bottom: 3px solid {NTA_ORANGE};
    padding: 16px 28px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }}
  .brand {{
    font-size: 20px;
    font-weight: 700;
    color: {NTA_ORANGE};
    letter-spacing: -0.3px;
  }}
  .brand-sub {{
    font-size: 11px;
    color: #888;
    margin-top: 2px;
  }}
  .report-meta {{
    text-align: right;
    font-size: 11px;
    color: #666;
    line-height: 1.7;
  }}

  /* ── Score row ── */
  .score-row {{
    display: flex;
    gap: 12px;
    padding: 16px 28px;
    background: #f8f8f8;
    border-bottom: 1px solid #dddddd;
  }}
  .score-box {{
    flex: 1;
    background: #ffffff;
    border: 1px solid #dddddd;
    border-radius: 3px;
    padding: 10px;
    text-align: center;
  }}
  .score-num {{
    font-size: 22px;
    font-weight: 700;
    font-family: 'JetBrains Mono', monospace;
  }}
  .score-lbl {{
    font-size: 10px;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    margin-top: 3px;
  }}

  /* ── Time info bar ── */
  .time-bar {{
    padding: 8px 28px;
    background: #fff8f5;
    border-bottom: 1px solid #ffd5b8;
    font-size: 11px;
    color: #888;
    display: flex;
    justify-content: space-between;
  }}
  .time-bar strong {{ color: {NTA_ORANGE}; }}

  /* ── Section title ── */
  .section-title {{
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #555;
    padding: 14px 28px 6px;
    border-bottom: 1px solid #eeeeee;
  }}

  /* ── Question block ── */
  .q-block {{
    padding: 14px 28px;
    border-bottom: 1px solid #eeeeee;
    border-left: 4px solid #cccccc;
    page-break-inside: avoid;
  }}
  .q-block.correct  {{ border-left-color: {NTA_GREEN}; }}
  .q-block.wrong    {{ border-left-color: {NTA_RED}; }}
  .q-block.answered {{ border-left-color: {NTA_DARKBLUE}; }}
  .q-block.skip     {{ border-left-color: #cccccc; }}

  .q-top {{
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 7px;
  }}
  .q-meta {{
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #888;
    font-weight: 500;
  }}
  .q-result {{
    font-size: 11px;
    font-weight: 700;
    padding: 2px 8px;
    border: 1px solid;
    border-radius: 2px;
  }}
  .q-text {{
    font-size: 13px;
    line-height: 1.75;
    color: #1a1a1a;
    margin-bottom: 10px;
  }}

  /* ── Options ── */
  .opt-row {{
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 5px 10px;
    border: 1px solid #dddddd;
    border-radius: 2px;
    margin-bottom: 4px;
    font-size: 12px;
    line-height: 1.55;
  }}
  .opt-lbl {{
    font-family: 'JetBrains Mono', monospace;
    font-weight: 600;
    min-width: 18px;
    color: #666;
    flex-shrink: 0;
  }}

  /* ── Answer row ── */
  .ans-row {{
    font-size: 12px;
    color: #555;
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px dashed #dddddd;
  }}
  .ans-label {{
    color: #888;
    font-weight: 500;
  }}

  /* ── Page footer ── */
  .page-footer {{
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 8px 28px;
    background: #f8f8f8;
    border-top: 1px solid #dddddd;
    font-size: 10px;
    color: #aaa;
    display: flex;
    justify-content: space-between;
  }}

  @page {{
    margin: 0 0 36px 0;
    size: A4;
  }}
</style>
</head>
<body>

<div class="page-header">
  <div>
    <div class="brand">Amibrave</div>
    <div class="brand-sub">GATE Practice Paper — Results Report</div>
  </div>
  <div class="report-meta">
    Generated: {datetime.now().strftime('%d %b %Y, %I:%M %p')}<br>
    Time taken: {time_taken}<br>
    Total questions: {len(questions)}
  </div>
</div>

{score_html}

<div class="time-bar">
  <span>Marking scheme: <strong>{marking.upper()}</strong></span>
  <span>Questions attempted: <strong>{sum(1 for i in range(len(questions)) if answers.get(str(i)))}</strong> / {len(questions)}</span>
</div>

<div class="section-title">Question-wise Summary</div>

{rows_html}

<div class="page-footer">
  <span>Amibrave — GATE Practice</span>
  <span>Confidential — For personal use only</span>
</div>

</body>
</html>"""


def escape_html(text: str) -> str:
    if not text:
        return ""
    return (str(text)
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;"))


# ── Main entry point ──────────────────────────────────────────────────────────

def generate_pdf(payload: dict) -> tuple[Optional[bytes], Optional[str]]:
    """
    Generate PDF from exam payload.
    Returns (pdf_bytes, error_message).
    """
    try:
        questions    = payload.get("questions", [])
        answers      = payload.get("answers", {})
        marked       = payload.get("marked", {})
        statuses     = payload.get("statuses", {})
        marking      = payload.get("marking", "gate")
        custom_marks = payload.get("customMarks", {"correct": 1, "wrong": 0})
        time_taken   = payload.get("timeTaken", "—")

        if not questions:
            return None, "No questions provided"

        html_str = build_html(
            questions, answers, marked, statuses,
            marking, custom_marks, time_taken
        )

        pdf_bytes = HTML(string=html_str).write_pdf()
        logger.info(f"PDF generated: {len(pdf_bytes)//1024}KB, {len(questions)} questions")
        return pdf_bytes, None

    except Exception as e:
        logger.error(f"PDF generation failed: {e}")
        return None, str(e)
