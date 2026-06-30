/**
 * Amibrave — script.js
 * Frontend logic: upload handling, API calls, exam engine,
 * scoring, math rendering, PDF download, toast notifications.
 */

"use strict";

// ── Config ──────────────────────────────────────────────────────────────────
const BACKEND_URL = "https://your-render-app.onrender.com"; // update after deploy
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// ── App state ────────────────────────────────────────────────────────────────
const state = {
  questions   : [],
  answers     : {},       // { questionIndex: [label, ...] }
  answerKey   : {},       // { questionNum: "A" }
  timeLimit   : 180,      // minutes
  marking     : "gate",
  customMarks : { correct: 1, wrong: 0 },
  timerInterval: null,
  timeLeft    : 0,
  totalTime   : 0,
  warnings    : [],
};

// ── Screen navigation ────────────────────────────────────────────────────────
function goScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ── Toast notifications ──────────────────────────────────────────────────────
let toastWrap = null;

function getToastWrap() {
  if (!toastWrap) {
    toastWrap = document.createElement("div");
    toastWrap.className = "toast-wrap";
    document.body.appendChild(toastWrap);
  }
  return toastWrap;
}

function toast(type, title, detail = "", duration = 5000) {
  const icons = { error: "ph-x-circle", warn: "ph-warning", success: "ph-check-circle", info: "ph-info" };
  const wrap  = getToastWrap();
  const el    = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `
    <i class="ph ${icons[type] || icons.info}" aria-hidden="true"></i>
    <div>
      <div class="toast-title">${escHTML(title)}</div>
      ${detail ? `<div class="toast-detail">${escHTML(detail)}</div>` : ""}
    </div>
  `;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ── Upload handling ──────────────────────────────────────────────────────────
function handleQFile(input) {
  const file = input.files[0];
  if (!file) return;
  state.qFile = file;
  showFileBadge("q-badge", file.name, file.size);
  styleZone("qz", "done");
  document.getElementById("process-btn").disabled = false;
}

function handleAFile(input) {
  const file = input.files[0];
  if (!file) return;
  state.aFile = file;
  showFileBadge("a-badge", file.name, file.size);
  styleZone("az", "done");
}

function showFileBadge(id, name, size) {
  const mb  = (size / 1024 / 1024).toFixed(2);
  const el  = document.getElementById(id);
  el.innerHTML = `<span class="badge badge-success"><i class="ph ph-check" aria-hidden="true"></i>${escHTML(name)} · ${mb} MB</span>`;
}

function styleZone(id, cls) {
  const z = document.getElementById(id);
  z.classList.remove("done", "dragging");
  if (cls) z.classList.add(cls);
}

// ── Drag and drop ────────────────────────────────────────────────────────────
["qz", "az"].forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener("dragover", e => { e.preventDefault(); el.classList.add("dragging"); });
  el.addEventListener("dragleave", () => el.classList.remove("dragging"));
  el.addEventListener("drop", e => {
    e.preventDefault();
    el.classList.remove("dragging");
    const file = e.dataTransfer.files[0];
    if (!file?.name.endsWith(".pdf")) { toast("error", "Invalid file", "Only PDF files are accepted."); return; }
    const inputId = id === "qz" ? "qf" : "af";
    const dt = new DataTransfer();
    dt.items.add(file);
    document.getElementById(inputId).files = dt.files;
    id === "qz" ? handleQFile(document.getElementById("qf")) : handleAFile(document.getElementById("af"));
  });
});

// ── Settings change ───────────────────────────────────────────────────────────
document.getElementById("marking").addEventListener("change", function () {
  state.marking = this.value;
  document.getElementById("custom-fields").style.display =
    this.value === "custom" ? "block" : "none";
});

// ── Processing entry point ───────────────────────────────────────────────────
async function startProcessing() {
  state.timeLimit   = parseInt(document.getElementById("time-limit").value) || 180;
  state.marking     = document.getElementById("marking").value;
  state.customMarks = {
    correct: parseFloat(document.getElementById("mark-correct")?.value || 1),
    wrong  : parseFloat(document.getElementById("mark-wrong")?.value   || 0),
  };

  goScreen("s-loading");
  setLoad("Uploading PDF to server…", 10);

  try {
    // ── Extract questions via backend ────────────────────────────────────────
    const qResult = await uploadPDF("/extract", state.qFile, (pct) => setLoad(`Processing PDF… ${pct}%`, 10 + pct * 0.5));
    if (!qResult.success) {
      handleServerError(qResult.error);
      goScreen("s-upload");
      return;
    }

    state.questions = qResult.questions;
    state.warnings  = qResult.warnings || [];

    setLoad("Questions extracted.", 60);

    // ── Extract answer key if provided ───────────────────────────────────────
    if (state.aFile) {
      setLoad("Processing answer key…", 65);
      const aResult = await uploadPDF("/extract-key", state.aFile);
      if (!aResult.success) {
        toast("warn", "Answer key skipped", aResult.error?.message || "Could not parse answer key.");
      } else {
        state.answerKey = aResult.answer_key || {};
        const aw = aResult.warnings || [];
        state.warnings.push(...aw);
        applyAnswerKeyToQuestions();
      }
    }

    setLoad("Building preview…", 90);
    await sleep(300);
    renderPreview();
    setLoad("Done", 100);
    goScreen("s-preview");

  } catch (err) {
    toast("error", "Connection failed", err.message);
    goScreen("s-upload");
  }
}

// ── Upload helper ─────────────────────────────────────────────────────────────
async function uploadPDF(endpoint, file, onProgress) {
  const form = new FormData();
  form.append("file", file);

  // Use XMLHttpRequest for progress tracking
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", BACKEND_URL + endpoint);

    xhr.upload.addEventListener("progress", e => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener("load", () => {
      try {
        resolve(JSON.parse(xhr.responseText));
      } catch {
        reject(new Error("Invalid server response"));
      }
    });

    xhr.addEventListener("error", () => reject(new Error("Network error — is the backend running?")));
    xhr.addEventListener("timeout", () => reject(new Error("Request timed out")));
    xhr.timeout = 90000; // 90s client-side timeout

    xhr.send(form);
  });
}

function handleServerError(error) {
  if (!error) return;
  toast("error", error.message || "Server error", error.detail || "", 8000);
}

// ── Apply answer key to questions ────────────────────────────────────────────
function applyAnswerKeyToQuestions() {
  let matched = 0;
  state.questions.forEach(q => {
    if (state.answerKey[q.num]) {
      q.correctAnswer = state.answerKey[q.num];
      matched++;
    }
  });
  if (matched < state.questions.length && matched > 0) {
    state.warnings.push({
      code   : "WARN_004",
      message: "Answer key partially matched.",
      detail : `${matched} of ${state.questions.length} questions matched.`,
    });
  }
}

// ── Progress helper ───────────────────────────────────────────────────────────
function setLoad(msg, pct) {
  document.getElementById("load-msg").textContent = msg;
  document.getElementById("load-bar").style.width = pct + "%";
  const bar = document.getElementById("progress-bar-wrap");
  if (bar) bar.setAttribute("aria-valuenow", pct);
}

// ── Preview rendering ─────────────────────────────────────────────────────────
function renderPreview() {
  const qs   = state.questions;
  const mcq  = qs.filter(q => q.type === "mcq").length;
  const nat  = qs.filter(q => q.type === "nat").length;

  document.getElementById("preview-stats").innerHTML = `
    <div class="stat-card"><div class="stat-number">${qs.length}</div><div class="stat-label">Total</div></div>
    <div class="stat-card"><div class="stat-number stat-accent">${mcq}</div><div class="stat-label">MCQ</div></div>
    <div class="stat-card"><div class="stat-number stat-warning">${nat}</div><div class="stat-label">NAT</div></div>
  `;

  renderWarningsPanel(state.warnings);

  const list = document.getElementById("preview-list");
  list.innerHTML = "";
  qs.forEach((q, i) => list.appendChild(buildPreviewCard(q, i)));
  renderMath();
}

function renderWarningsPanel(warnings) {
  const panel = document.getElementById("warnings-panel");
  if (!warnings || warnings.length === 0) { panel.innerHTML = ""; return; }
  panel.innerHTML = `<div class="warnings-panel">
    ${warnings.map(w => `
      <div class="warn-item">
        <i class="ph ph-warning" aria-hidden="true"></i>
        <div>
          <div class="warn-title">${escHTML(w.message)}</div>
          <div class="warn-detail">${escHTML(w.detail || "")}</div>
        </div>
      </div>`).join("")}
  </div>`;
}

function buildPreviewCard(q, i) {
  const div     = document.createElement("div");
  div.className = "q-card";
  div.id        = "pq-" + i;

  const typeBadge = q.type === "mcq"
    ? `<span class="badge badge-accent">MCQ</span>`
    : `<span class="badge badge-warn">NAT</span>`;

  const keyBadge = q.correctAnswer
    ? `<span class="badge badge-success">Key: ${escHTML(q.correctAnswer)}</span>`
    : "";

  const sourceBadge = q.source === "gemini"
    ? `<span class="badge badge-accent"><i class="ph ph-sparkle" aria-hidden="true"></i> Gemini</span>`
    : "";

  const optsHTML = q.type === "mcq" && q.options.length > 0
    ? q.options.map(o => `
        <div class="option" style="cursor:default">
          <span class="option-label">${escHTML(o.label)}.</span>
          <span>${escHTML(o.text)}</span>
        </div>`).join("")
    : `<p class="muted" style="font-size:13px">Numerical answer type — student enters a value</p>`;

  div.innerHTML = `
    <div class="q-meta">
      <span class="q-num">Question ${q.num}</span>
      <div class="q-badges">${typeBadge}${keyBadge}${sourceBadge}</div>
    </div>
    <div class="q-text" id="qtext-${i}">${escHTML(q.text)}</div>
    <div id="qopts-${i}">${optsHTML}</div>
    <div class="q-actions">
      <button class="btn btn-ghost btn-sm" onclick="toggleEdit(${i})">
        <i class="ph ph-pencil" aria-hidden="true"></i> Edit
      </button>
      <button class="btn btn-ghost btn-sm" onclick="toggleType(${i})">
        <i class="ph ph-arrows-left-right" aria-hidden="true"></i> Toggle Type
      </button>
      <button class="btn btn-danger btn-sm" style="margin-left:auto" onclick="deleteQ(${i})">
        <i class="ph ph-trash" aria-hidden="true"></i> Remove
      </button>
    </div>
    <div class="edit-panel" id="edit-panel-${i}" style="display:none">
      <label class="edit-label">Question text</label>
      <textarea class="edit-textarea" id="edit-text-${i}">${escHTML(q.text)}</textarea>
      ${q.type === "mcq" ? `
        <div style="margin-top:12px">
          <label class="edit-label">Options</label>
          <div id="edit-opts-${i}">
            ${q.options.map((o, oi) => `
              <div class="opt-edit-row">
                <span class="opt-edit-lbl">${o.label}.</span>
                <input type="text" class="field-input" id="edit-opt-${i}-${oi}" value="${escHTML(o.text)}" />
              </div>`).join("")}
          </div>
          <button class="add-opt-btn" onclick="addOption(${i})">
            <i class="ph ph-plus" aria-hidden="true"></i> Add option
          </button>
        </div>` : ""}
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-primary btn-sm" onclick="saveEdit(${i})">
          <i class="ph ph-check" aria-hidden="true"></i> Save
        </button>
        <button class="btn btn-ghost btn-sm" onclick="toggleEdit(${i})">Cancel</button>
      </div>
    </div>
  `;
  return div;
}

function toggleEdit(i) {
  const p = document.getElementById("edit-panel-" + i);
  p.style.display = p.style.display === "none" ? "block" : "none";
}

function saveEdit(i) {
  const q       = state.questions[i];
  const newText = document.getElementById(`edit-text-${i}`)?.value;
  if (newText !== undefined) q.text = newText;
  if (q.type === "mcq") {
    q.options.forEach((o, oi) => {
      const inp = document.getElementById(`edit-opt-${i}-${oi}`);
      if (inp) o.text = inp.value;
    });
  }
  document.getElementById("pq-" + i).replaceWith(buildPreviewCard(q, i));
  renderMath();
  toast("success", "Question saved");
}

function toggleType(i) {
  const q = state.questions[i];
  q.type  = q.type === "mcq" ? "nat" : "mcq";
  if (q.type === "nat") q.options = [];
  document.getElementById("pq-" + i).replaceWith(buildPreviewCard(q, i));
}

function deleteQ(i) {
  state.questions.splice(i, 1);
  renderPreview();
  toast("warn", "Question removed");
}

function addOption(i) {
  const q      = state.questions[i];
  const labels = "ABCDEFGH";
  q.options.push({ label: labels[q.options.length] || "?", text: "" });
  document.getElementById("pq-" + i).replaceWith(buildPreviewCard(q, i));
  toggleEdit(i);
}

function addBlankQuestion() {
  const num = (state.questions.at(-1)?.num || 0) + 1;
  state.questions.push({ num, text: "Enter question here", type: "nat", options: [], source: "manual" });
  renderPreview();
  document.getElementById(`pq-${state.questions.length - 1}`)
    ?.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ── Exam engine ───────────────────────────────────────────────────────────────
function startExam() {
  if (state.questions.length === 0) { toast("error", "No questions", "Add at least one question to start."); return; }
  state.answers     = {};
  state.timeLeft    = state.timeLimit * 60;
  state.totalTime   = state.timeLeft;
  goScreen("s-exam");
  renderExam();
  startTimer();
}

function renderExam() {
  const qs = state.questions;
  document.getElementById("total-count").textContent = qs.length;
  document.getElementById("ans-count").textContent   = 0;
  document.getElementById("timer-bar").style.width   = "100%";
  document.getElementById("timer-bar").className     = "timer-fill";

  // Nav dots
  const dots = document.getElementById("nav-dots");
  dots.innerHTML = "";
  qs.forEach((q, i) => {
    const d       = document.createElement("div");
    d.className   = "dot" + (i === 0 ? " current" : "");
    d.id          = "dot-" + i;
    d.textContent = q.num;
    d.setAttribute("role", "button");
    d.setAttribute("aria-label", `Go to question ${q.num}`);
    d.onclick     = () => document.getElementById("eq-" + i)?.scrollIntoView({ behavior: "smooth", block: "center" });
    dots.appendChild(d);
  });

  // Question cards
  const container     = document.getElementById("exam-questions");
  container.innerHTML = "";
  qs.forEach((q, i) => container.appendChild(buildExamCard(q, i)));
  renderMath();

  // Intersection observer for active dot
  const obs = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        const idx = parseInt(e.target.dataset.idx);
        document.querySelectorAll(".dot").forEach(d => d.classList.remove("current"));
        document.getElementById("dot-" + idx)?.classList.add("current");
      }
    });
  }, { threshold: 0.4 });

  qs.forEach((_, i) => {
    const el = document.getElementById("eq-" + i);
    if (el) { el.dataset.idx = i; obs.observe(el); }
  });
}

function buildExamCard(q, i) {
  const div     = document.createElement("div");
  div.className = "q-card";
  div.id        = "eq-" + i;

  const badge = q.type === "mcq"
    ? `<span class="badge badge-accent">MCQ</span>`
    : `<span class="badge badge-warn">NAT</span>`;

  const body = q.type === "mcq" && q.options.length > 0
    ? q.options.map((o, oi) => `
        <div class="option" id="opt-${i}-${oi}" onclick="selectOption(${i},${oi})" role="checkbox" aria-checked="false" tabindex="0"
          onkeydown="if(event.key===' ')selectOption(${i},${oi})">
          <input type="checkbox" id="cb-${i}-${oi}" onclick="event.stopPropagation();selectOption(${i},${oi})" aria-label="Option ${o.label}">
          <span class="option-label">${escHTML(o.label)}.</span>
          <span>${escHTML(o.text)}</span>
        </div>`).join("")
    : `<div class="nat-wrap">
        <p class="nat-label">Enter your numerical answer</p>
        <input type="text" class="field-input nat-input" id="nat-${i}"
          placeholder="e.g. 3.14" oninput="saveNAT(${i})" aria-label="Numerical answer for question ${q.num}" />
      </div>`;

  div.innerHTML = `
    <div class="q-meta">
      <span class="q-num">Question ${q.num}</span>
      <div class="q-badges">${badge}</div>
    </div>
    <div class="q-text">${escHTML(q.text)}</div>
    ${body}
  `;
  return div;
}

function selectOption(qi, oi) {
  const q   = state.questions[qi];
  if (!state.answers[qi]) state.answers[qi] = [];
  const ans   = state.answers[qi];
  const label = q.options[oi].label;
  const idx   = ans.indexOf(label);
  idx >= 0 ? ans.splice(idx, 1) : ans.push(label);

  q.options.forEach((_, j) => {
    const opt = document.getElementById(`opt-${qi}-${j}`);
    const cb  = document.getElementById(`cb-${qi}-${j}`);
    if (!opt || !cb) return;
    const sel = ans.includes(q.options[j].label);
    opt.classList.toggle("selected", sel);
    opt.setAttribute("aria-checked", sel);
    cb.checked = sel;
  });

  document.getElementById("eq-" + qi)?.classList.toggle("answered", ans.length > 0);
  document.getElementById("dot-" + qi)?.classList.toggle("answered", ans.length > 0);
  updateAnsCount();
}

function saveNAT(qi) {
  const val       = document.getElementById("nat-" + qi)?.value?.trim();
  state.answers[qi] = val ? [val] : [];
  const answered    = !!val;
  document.getElementById("eq-" + qi)?.classList.toggle("answered", answered);
  document.getElementById("dot-" + qi)?.classList.toggle("answered", answered);
  updateAnsCount();
}

function updateAnsCount() {
  const count = Object.values(state.answers).filter(a => a?.length > 0).length;
  document.getElementById("ans-count").textContent = count;
}

// ── Timer ─────────────────────────────────────────────────────────────────────
function startTimer() {
  updateTimerDisplay();
  state.timerInterval = setInterval(() => {
    state.timeLeft--;
    updateTimerDisplay();
    const pct  = (state.timeLeft / state.totalTime) * 100;
    const bar  = document.getElementById("timer-bar");
    const disp = document.getElementById("timer-display");
    bar.style.width = pct + "%";

    if (pct <= 10) {
      bar.className  = "timer-fill danger";
      disp.className = "timer-display danger";
    } else if (pct <= 25) {
      bar.className  = "timer-fill warn";
      disp.className = "timer-display warn";
    } else {
      bar.className  = "timer-fill";
      disp.className = "timer-display";
    }

    if (state.timeLeft === 300) toast("warn", "5 minutes remaining");
    if (state.timeLeft <= 0)    { clearInterval(state.timerInterval); submitExam(); }
  }, 1000);
}

function updateTimerDisplay() {
  const h = Math.floor(state.timeLeft / 3600);
  const m = Math.floor((state.timeLeft % 3600) / 60);
  const s = state.timeLeft % 60;
  document.getElementById("timer-display").textContent =
    `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function submitExam() {
  clearInterval(state.timerInterval);
  const elapsed = state.totalTime - state.timeLeft;
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  const subtitle = `Completed in ${h}h ${m}m ${s}s`;
  renderResults(subtitle);
  goScreen("s-result");
}

// ── Scoring ───────────────────────────────────────────────────────────────────
function calcScore() {
  let score = 0, correct = 0, wrong = 0, unattempted = 0;
  state.questions.forEach((q, i) => {
    const ans    = state.answers[i] || [];
    const keyAns = q.correctAnswer;
    if (!ans.length) { unattempted++; return; }
    if (!keyAns)     return;
    const userStr = [...ans].sort().join("");
    const keyArr  = Array.isArray(keyAns) ? keyAns : [keyAns];
    const keyStr  = [...keyArr].sort().join("");
    if (userStr === keyStr) { correct++; score += getMark(q.type, true); }
    else                    { wrong++;   score += getMark(q.type, false); }
  });
  return { score: Math.round(score * 100) / 100, correct, wrong, unattempted };
}

function getMark(type, isCorrect) {
  if (state.marking === "gate")   return isCorrect ? 2 : (type === "mcq" ? -0.67 : 0);
  if (state.marking === "simple") return isCorrect ? 1 : 0;
  return isCorrect ? state.customMarks.correct : -Math.abs(state.customMarks.wrong);
}

// ── Results rendering ─────────────────────────────────────────────────────────
function renderResults(subtitle) {
  document.getElementById("result-subtitle").textContent = subtitle;
  const hasKey = state.questions.some(q => q.correctAnswer);

  if (hasKey) {
    const { score, correct, wrong, unattempted } = calcScore();
    document.getElementById("result-stats").innerHTML = `
      <div class="stat-card"><div class="stat-number stat-accent">${score}</div><div class="stat-label">Score</div></div>
      <div class="stat-card"><div class="stat-number stat-success">${correct}</div><div class="stat-label">Correct</div></div>
      <div class="stat-card"><div class="stat-number stat-danger">${wrong}</div><div class="stat-label">Wrong</div></div>
    `;
  } else {
    const attempted = Object.values(state.answers).filter(a => a?.length > 0).length;
    document.getElementById("result-stats").innerHTML = `
      <div class="stat-card"><div class="stat-number">${state.questions.length}</div><div class="stat-label">Total</div></div>
      <div class="stat-card"><div class="stat-number stat-accent">${attempted}</div><div class="stat-label">Attempted</div></div>
      <div class="stat-card"><div class="stat-number stat-warning">${state.questions.length - attempted}</div><div class="stat-label">Skipped</div></div>
    `;
  }

  const list = document.getElementById("result-list");
  list.innerHTML = "";

  state.questions.forEach((q, i) => {
    const ans    = state.answers[i] || [];
    const keyAns = q.correctAnswer;
    let cls      = "skip";

    if (ans.length > 0 && keyAns) {
      const userStr = [...ans].sort().join("");
      const keyStr  = [...(Array.isArray(keyAns) ? keyAns : [keyAns])].sort().join("");
      cls = userStr === keyStr ? "ok" : "bad";
    } else if (ans.length > 0) {
      cls = "";
    }

    const statusLabel = cls === "ok" ? "Correct" : cls === "bad" ? "Wrong" : ans.length > 0 ? "Answered" : "Skipped";
    const statusBadge = cls === "ok"
      ? `<span class="badge badge-success">${statusLabel}</span>`
      : cls === "bad"
        ? `<span class="badge badge-danger">${statusLabel}</span>`
        : `<span class="badge badge-warn">${statusLabel}</span>`;

    const div     = document.createElement("div");
    div.className = `review-item ${cls}`;
    div.innerHTML = `
      <div style="flex:1;min-width:0">
        <div class="review-meta">Q${q.num} · ${q.type.toUpperCase()}</div>
        <div class="review-text">${escHTML(q.text.slice(0, 160))}${q.text.length > 160 ? "…" : ""}</div>
        ${ans.length > 0 ? `<div class="review-ans">Your answer: <strong>${escHTML(ans.join(", "))}</strong></div>` : ""}
        ${keyAns ? `<div class="review-ans ${cls === "ok" ? "review-correct" : "review-wrong"}">Correct: <strong>${escHTML(Array.isArray(keyAns) ? keyAns.join(", ") : keyAns)}</strong></div>` : ""}
      </div>
      <div style="flex-shrink:0">${statusBadge}</div>
    `;
    list.appendChild(div);
  });

  renderMath();
}

// ── PDF Download ──────────────────────────────────────────────────────────────
function downloadPDF() {
  const hasKey = state.questions.some(q => q.correctAnswer);
  const { score, correct, wrong } = hasKey ? calcScore() : { score: "—", correct: "—", wrong: "—" };

  const rows = state.questions.map((q, i) => {
    const ans    = state.answers[i] || [];
    const keyAns = q.correctAnswer;
    let status   = ans.length === 0 ? "Skipped" : "Answered";
    if (ans.length > 0 && keyAns) {
      const userStr = [...ans].sort().join("");
      const keyStr  = [...(Array.isArray(keyAns) ? keyAns : [keyAns])].sort().join("");
      status = userStr === keyStr ? "✓ Correct" : "✗ Wrong";
    }
    return `<tr>
      <td>${q.num}</td>
      <td>${escHTML(q.text.slice(0, 120))}${q.text.length > 120 ? "…" : ""}</td>
      <td>${escHTML(ans.join(", ") || "—")}</td>
      <td>${escHTML(keyAns || "—")}</td>
      <td>${status}</td>
    </tr>`;
  }).join("");

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>Amibrave — Results</title>
  <style>
    body{font-family:'Inter',Arial,sans-serif;max-width:900px;margin:0 auto;padding:2rem;font-size:13px;color:#1a1a1a}
    h1{font-size:20px;font-weight:600;margin-bottom:4px}
    .sub{color:#666;font-size:13px;margin-bottom:1.5rem}
    .stats{display:flex;gap:1rem;margin-bottom:1.5rem;flex-wrap:wrap}
    .stat{padding:0.75rem 1.25rem;background:#f5f5f5;border-radius:8px;text-align:center;min-width:80px}
    .stat-n{font-size:22px;font-weight:700}
    .stat-l{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.3px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th{background:#f0f0f0;padding:8px 10px;text-align:left;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.3px;border-bottom:2px solid #ddd}
    td{padding:8px 10px;border-bottom:1px solid #eee;vertical-align:top}
    tr:nth-child(even) td{background:#fafafa}
  </style></head><body>
  <h1>Amibrave — Exam Results</h1>
  <p class="sub">Generated ${new Date().toLocaleString()}</p>
  ${hasKey ? `<div class="stats">
    <div class="stat"><div class="stat-n">${score}</div><div class="stat-l">Score</div></div>
    <div class="stat"><div class="stat-n" style="color:#16a34a">${correct}</div><div class="stat-l">Correct</div></div>
    <div class="stat"><div class="stat-n" style="color:#dc2626">${wrong}</div><div class="stat-l">Wrong</div></div>
  </div>` : ""}
  <table>
    <thead><tr><th>#</th><th>Question</th><th>Your Answer</th><th>Correct</th><th>Result</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  </body></html>`;

  const w = window.open("", "_blank");
  if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 600); }
  else   toast("warn", "Pop-up blocked", "Allow pop-ups for this site to download results.");
}

// ── Reset ─────────────────────────────────────────────────────────────────────
function resetAll() {
  clearInterval(state.timerInterval);
  Object.assign(state, {
    questions: [], answers: {}, answerKey: {}, warnings: [],
    timeLimit: 180, marking: "gate", timerInterval: null, timeLeft: 0, totalTime: 0,
  });
  document.getElementById("qf").value = "";
  document.getElementById("af").value = "";
  document.getElementById("q-badge").innerHTML = "";
  document.getElementById("a-badge").innerHTML = "";
  document.getElementById("process-btn").disabled = true;
  styleZone("qz", "");
  styleZone("az", "");
  goScreen("s-upload");
}

// ── KaTeX rendering ───────────────────────────────────────────────────────────
function renderMath() {
  if (!window.katexReady || typeof renderMathInElement === "undefined") {
    setTimeout(renderMath, 300);
    return;
  }
  try {
    renderMathInElement(document.body, {
      delimiters: [
        { left: "$$", right: "$$", display: true  },
        { left: "$",  right: "$",  display: false },
        { left: "\\(", right: "\\)", display: false },
        { left: "\\[", right: "\\]", display: true  },
      ],
      throwOnError: false,
    });
  } catch (e) {
    console.warn("KaTeX render error:", e);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function escHTML(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── File input change listeners (wired here for separation from HTML) ─────────
document.getElementById("qf").addEventListener("change", function () { handleQFile(this); });
document.getElementById("af").addEventListener("change", function () { handleAFile(this); });
