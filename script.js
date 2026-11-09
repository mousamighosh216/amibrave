/**
 * Amibrave — script.js
 * NTA-style exam engine: one question at a time, palette navigation,
 * 5-state question tracking, Mark for Review, backend API integration.
 */

"use strict";

// ── Config ────────────────────────────────────────────────────────────────────
const BACKEND_URL =  "https://amibrave.onrender.com";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// ── Question status constants (NTA) ───────────────────────────────────────────
const STATUS = {
  NOT_VISITED      : "notvisited",
  NOT_ANSWERED     : "notanswered",
  ANSWERED         : "answered",
  REVIEW           : "review",
  ANSWERED_REVIEW  : "answeredreview",
};

// ── App state ─────────────────────────────────────────────────────────────────
const state = {
  questions    : [],
  images       : [],
  imageVisibility: {},
  answers      : {},    // { idx: ["A"] | ["3.14"] }
  statuses     : {},    // { idx: STATUS.xxx }
  marked       : {},    // { idx: true } — marked for review
  currentIdx   : 0,
  timeLimit    : 180,
  totalTime    : 0,
  timeLeft     : 0,
  timerInterval: null,
  marking      : "gate",
  customMarks  : { correct: 1, wrong: 0 },
  warnings     : [],
  phase        : null,
  lifetimeCount: 0,
  submitted    : false,
};

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isMultiSelect(question) {
  return question.type === "mcq" && (question.options || []).length === 4;
}

function questionTypeLabel(question) {
  if (question.type === "nat") return "NAT";
  return isMultiSelect(question) ? "MSQ" : "MCQ";
}

function normalizeImages(images) {
  return images.map(image => {
    const binary = atob(image.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    const blob = new Blob([bytes], { type: image.mime_type });
    const normalized = {
      ...image,
      blob,
      src: URL.createObjectURL(blob),
    };
    delete normalized.data;
    return normalized;
  });
}

function imagesForQuestion(questionNumber) {
  return state.images
    .filter(image => String(image.question_number) === String(questionNumber))
    .sort((left, right) => Number(left.part) - Number(right.part));
}

function questionImagesMarkup(questionNumber, questionIndex, context) {
  const images = imagesForQuestion(questionNumber);
  if (!images.length) return "";

  const visible = Boolean(state.imageVisibility[questionIndex]);
  const panelId = `question-images-${context}-${questionIndex}`;
  return `
    <div class="question-image-section">
      <button class="question-image-toggle" type="button"
        data-question-index="${questionIndex}"
        aria-controls="${panelId}" aria-expanded="${visible}"
        aria-label="${visible ? "Hide" : "View"} original image for question ${esc(questionNumber)}"
        onclick="toggleQuestionImage(${questionIndex}, '${panelId}')">
        <i class="ph ${visible ? "ph-eye-slash" : "ph-eye"}" aria-hidden="true"></i>
        ${visible ? "Hide source image" : "View source image"}
      </button>
      <div class="question-image-list" id="${panelId}"${visible ? "" : " hidden"}>
        ${images.map((image, index) => `
          <figure class="question-image">
            <img src="${esc(image.src)}"
              alt="Question ${esc(questionNumber)} image ${index + 1}"
              width="${esc(image.width)}" height="${esc(image.height)}" />
            ${image.part > 1 ? `<figcaption>Part ${esc(image.part)}</figcaption>` : ""}
          </figure>`).join("")}
      </div>
    </div>`;
}

function toggleQuestionImage(questionIndex, panelId) {
  const visible = !state.imageVisibility[questionIndex];
  state.imageVisibility[questionIndex] = visible;
  const panel = document.getElementById(panelId);
  if (panel) panel.hidden = !visible;

  document.querySelectorAll(
    `.question-image-toggle[data-question-index="${questionIndex}"]`
  ).forEach(button => {
    button.setAttribute("aria-expanded", String(visible));
    button.setAttribute(
      "aria-label",
      `${visible ? "Hide" : "View"} original image for question ${state.questions[questionIndex].num}`
    );
    button.innerHTML = `<i class="ph ${visible ? "ph-eye-slash" : "ph-eye"}" aria-hidden="true"></i>
      ${visible ? "Hide source image" : "View source image"}`;
  });
  schedulePersistence();
}

function goScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

let persistenceTimer = null;
let persistenceChain = Promise.resolve();
let persistenceReady = false;

function activeExamSnapshot() {
  return {
    phase: state.phase,
    questions: state.questions,
    imageVisibility: state.imageVisibility,
    answers: state.answers,
    statuses: state.statuses,
    marked: state.marked,
    currentIdx: state.currentIdx,
    timeLimit: state.timeLimit,
    totalTime: state.totalTime,
    timeLeft: state.timeLeft,
    marking: state.marking,
    customMarks: state.customMarks,
    warnings: state.warnings,
  };
}

function flushPersistence() {
  if (!persistenceReady || !state.phase) return persistenceChain;
  clearTimeout(persistenceTimer);
  const snapshot = JSON.parse(JSON.stringify(activeExamSnapshot()));
  persistenceChain = persistenceChain
    .catch(() => {})
    .then(() => ExamStorage.saveActiveExam(snapshot))
    .catch(error => {
      console.error("Exam progress could not be saved:", error);
      toast("error", "Progress save failed", error.message);
    });
  return persistenceChain;
}

function schedulePersistence(delay = 300) {
  if (!persistenceReady || !state.phase) return;
  clearTimeout(persistenceTimer);
  persistenceTimer = setTimeout(flushPersistence, delay);
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(type, title, detail = "", ms = 4500) {
  const icons = { error:"ph-x-circle", warn:"ph-warning-circle", success:"ph-check-circle", info:"ph-info" };
  const wrap  = document.getElementById("toast-container");
  const el    = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<i class="ph ${icons[type]||icons.info}" aria-hidden="true"></i>
    <div><div class="toast-title">${esc(title)}</div>${detail?`<div class="toast-detail">${esc(detail)}</div>`:""}</div>`;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ── File upload handling ──────────────────────────────────────────────────────
document.getElementById("qf").addEventListener("change", function() { handleQFile(this); });
document.getElementById("af").addEventListener("change", function() { handleAFile(this); });

function handleQFile(inp) {
  const f = inp.files[0]; if (!f) return;
  state.qFile = f;
  setFileBadge("q-info", f);
  styleZone("qz", "done");
  document.getElementById("process-btn").disabled = false;
}
function handleAFile(inp) {
  const f = inp.files[0]; if (!f) return;
  state.aFile = f;
  setFileBadge("a-info", f);
  styleZone("az", "done");
}
function setFileBadge(id, file) {
  const mb = (file.size/1024/1024).toFixed(2);
  document.getElementById(id).innerHTML =
    `<span class="file-badge"><i class="ph ph-check-circle" aria-hidden="true"></i>${esc(file.name)} · ${mb} MB</span>`;
}
function styleZone(id, cls) {
  const z = document.getElementById(id);
  z.classList.remove("done","dragging");
  if (cls) z.classList.add(cls);
}

// Drag & drop
["qz","az"].forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener("dragover", e => { e.preventDefault(); el.classList.add("dragging"); });
  el.addEventListener("dragleave", () => el.classList.remove("dragging"));
  el.addEventListener("drop", e => {
    e.preventDefault(); el.classList.remove("dragging");
    const f = e.dataTransfer.files[0];
    if (!f?.name.endsWith(".pdf")) { toast("error","Invalid file","Only PDF files accepted."); return; }
    const inputId = id==="qz" ? "qf" : "af";
    const dt = new DataTransfer(); dt.items.add(f);
    document.getElementById(inputId).files = dt.files;
    id==="qz" ? handleQFile(document.getElementById("qf")) : handleAFile(document.getElementById("af"));
  });
});

document.getElementById("marking").addEventListener("change", function() {
  state.marking = this.value;
  document.getElementById("custom-fields").style.display = this.value==="custom" ? "block" : "none";
});

// ── Processing ─────────────────────────────────────────────────────────────────
async function startProcessing() {
  state.timeLimit   = parseInt(document.getElementById("time-limit").value) || 180;
  state.marking     = document.getElementById("marking").value;
  state.customMarks = {
    correct: parseFloat(document.getElementById("mark-correct")?.value || 1),
    wrong  : parseFloat(document.getElementById("mark-wrong")?.value   || 0),
  };
  goScreen("s-loading");
  setLoad("Uploading PDF to server…", 10);
  let savingExam = false;
  try {
    const qRes = await uploadPDF("/api/exams/process", state.qFile, pct => setLoad(`Processing PDF… ${pct}%`, 10 + pct*0.5));
    if (!qRes.success) { toast("error", qRes.error?.message||"Server error", qRes.error?.detail||""); goScreen("s-upload"); return; }
    const previousImages = state.images;
    state.questions = qRes.questions;
    state.imageVisibility = {};
    state.images = normalizeImages(qRes.images || []);
    state.warnings  = qRes.warnings || [];
    setLoad("Questions and reference image extracted.", 65);

    if (state.aFile) {
      setLoad("Processing answer key…", 70);
      const aRes = await uploadPDF("/extract-key", state.aFile);
      if (!aRes.success) {
        toast("warn","Answer key skipped", aRes.error?.message||"");
      } else {
        applyAnswerKey(aRes.answer_key || {});
        state.warnings.push(...(aRes.warnings||[]));
      }
    }
    state.phase = "preview";
    savingExam = true;
    await ExamStorage.replaceActiveExam(activeExamSnapshot(), state.images);
    persistenceReady = true;
    previousImages.forEach(image => URL.revokeObjectURL(image.src));
    savingExam = false;
    setLoad("Building preview…", 92);
    await sleep(250);
    renderPreview();
    setLoad("Done", 100);
    goScreen("s-preview");
  } catch(e) {
    toast("error", savingExam ? "Could not save this exam" : "Connection failed", e.message);
    goScreen("s-upload");
  }
}

async function uploadPDF(endpoint, file, onProgress) {
  const form = new FormData();
  form.append("file", file);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", BACKEND_URL + endpoint);
    xhr.upload.addEventListener("progress", e => { if (e.lengthComputable && onProgress) onProgress(Math.round(e.loaded/e.total*100)); });
    xhr.addEventListener("load",    () => { try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error("Invalid server response")); } });
    xhr.addEventListener("error",   () => reject(new Error("Network error — sorry for interuption")));
    xhr.addEventListener("timeout", () => reject(new Error("Request timed out")));
    xhr.timeout = 90000;
    xhr.send(form);
  });
}

function setLoad(msg, pct) {
  document.getElementById("load-msg").textContent = msg;
  document.getElementById("load-bar").style.width  = pct + "%";
}

function applyAnswerKey(key) {
  state.questions.forEach(q => {
    const k = key[q.num] || key[String(q.num)];
    if (k) q.correctAnswer = k;
  });
}

// ── Preview ───────────────────────────────────────────────────────────────────
function renderPreview() {
  const qs  = state.questions;
  const msq = qs.filter(isMultiSelect).length;
  const mcq = qs.filter(q=>q.type==="mcq" && !isMultiSelect(q)).length;
  const nat = qs.filter(q=>q.type==="nat").length;
  document.getElementById("preview-stats").innerHTML = `
    <div class="stat-box"><div class="stat-num">${qs.length}</div><div class="stat-lbl">Total</div></div>
    <div class="stat-box"><div class="stat-num stat-orange">${mcq}</div><div class="stat-lbl">MCQ</div></div>
    <div class="stat-box"><div class="stat-num stat-blue">${msq}</div><div class="stat-lbl">MSQ</div></div>
    <div class="stat-box"><div class="stat-num stat-blue">${nat}</div><div class="stat-lbl">NAT</div></div>
  `;
  renderWarnPanel(state.warnings);
  const list = document.getElementById("preview-list");
  list.innerHTML = "";
  qs.forEach((q,i) => list.appendChild(buildPreviewCard(q,i)));
  renderMath();
}

function renderWarnPanel(warnings) {
  const el = document.getElementById("warn-panel");
  if (!warnings?.length) { el.innerHTML=""; return; }
  el.innerHTML = `<div class="warn-panel">${warnings.map(w=>`
    <div class="warn-item">
      <i class="ph ph-warning" aria-hidden="true"></i>
      <div><div class="warn-title">${esc(w.message)}</div><div class="warn-detail">${esc(w.detail||"")}</div></div>
    </div>`).join("")}</div>`;
}

function buildPreviewCard(q, i) {
  const div = document.createElement("div");
  div.className = "pq-card"; div.id = "pq-"+i;
  const typeBadge = q.type==="mcq"
    ? `<span class="badge ${isMultiSelect(q) ? "badge-blue" : "badge-orange"}">${questionTypeLabel(q)}</span>`
    : `<span class="badge badge-blue">NAT</span>`;
  const keyBadge = q.correctAnswer ? `<span class="badge badge-green"><i class="ph ph-key" aria-hidden="true"></i> Key: ${esc(q.correctAnswer)}</span>` : "";
  const srcBadge = q.source==="gemini" ? `<span class="badge badge-grey"><i class="ph ph-sparkle" aria-hidden="true"></i> Gemini</span>`
                 : q.source==="ocr"    ? `<span class="badge badge-grey"><i class="ph ph-scan" aria-hidden="true"></i> OCR</span>` : "";
  const optsHTML = q.type==="mcq" && q.options.length
    ? q.options.map(o=>`<div class="pq-option"><span class="pq-opt-lbl">${esc(o.label)}.</span><span>${esc(o.text)}</span></div>`).join("")
    : `<div class="nat-type-note"><i class="ph ph-input-numeric" aria-hidden="true"></i> Numerical answer type</div>`;

  div.innerHTML = `
    <div class="pq-meta">
      <span class="pq-num">Question ${q.num}</span>
      <div class="pq-badges">${typeBadge}${keyBadge}${srcBadge}</div>
    </div>
    ${questionImagesMarkup(q.num, i, "preview")}
    <div class="pq-text">${esc(q.text)}</div>
    ${isMultiSelect(q) ? `<div class="answer-instruction">Select all that apply.</div>` : ""}
    <div id="popts-${i}">${optsHTML}</div>
    <div class="pq-actions">
      <button class="btn-nta btn-ghost" style="font-size:12px;padding:5px 11px" onclick="toggleEdit(${i})">
        <i class="ph ph-pencil" aria-hidden="true"></i> Edit
      </button>
      <button class="btn-nta btn-ghost" style="font-size:12px;padding:5px 11px" onclick="toggleType(${i})">
        <i class="ph ph-arrows-left-right" aria-hidden="true"></i> Toggle Type
      </button>
      <button class="btn-nta btn-delete" onclick="deleteQ(${i})">
        <i class="ph ph-trash" aria-hidden="true"></i> Remove
      </button>
    </div>
    <div class="pq-edit-panel" id="ep-${i}" style="display:none">
      <label class="edit-lbl">Question text</label>
      <textarea class="edit-textarea" id="et-${i}">${esc(q.text)}</textarea>
      ${q.type==="mcq" ? `
        <div style="margin-top:10px">
          <label class="edit-lbl">Options</label>
          <div id="eo-${i}">${q.options.map((o,oi)=>`
            <div class="opt-edit-row">
              <span class="opt-edit-lbl">${esc(o.label)}.</span>
              <input type="text" class="field-inp" id="eo-${i}-${oi}" value="${esc(o.text)}" />
            </div>`).join("")}</div>
          <button class="add-opt-btn" onclick="addOption(${i})"><i class="ph ph-plus" aria-hidden="true"></i> Add option</button>
        </div>` : ""}
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn-nta btn-green" style="font-size:12px;padding:5px 12px" onclick="saveEdit(${i})">
          <i class="ph ph-check" aria-hidden="true"></i> Save
        </button>
        <button class="btn-nta btn-white" style="font-size:12px;padding:5px 12px" onclick="toggleEdit(${i})">Cancel</button>
      </div>
    </div>`;
  return div;
}

function toggleEdit(i) {
  const p = document.getElementById("ep-"+i);
  p.style.display = p.style.display==="none" ? "block" : "none";
}
function saveEdit(i) {
  const q = state.questions[i];
  const t = document.getElementById("et-"+i)?.value; if (t!==undefined) q.text=t;
  if (q.type==="mcq") q.options.forEach((o,oi)=>{ const inp=document.getElementById(`eo-${i}-${oi}`); if(inp) o.text=inp.value; });
  document.getElementById("pq-"+i).replaceWith(buildPreviewCard(q,i));
  renderMath(); schedulePersistence(); toast("success","Question saved");
}
function toggleType(i) {
  const q = state.questions[i];
  q.type  = q.type==="mcq" ? "nat" : "mcq";
  if (q.type==="nat") q.options=[];
  document.getElementById("pq-"+i).replaceWith(buildPreviewCard(q,i));
  schedulePersistence();
}
function deleteQ(i) {
  state.questions.splice(i,1);
  renderPreview();
  schedulePersistence();
  toast("warn","Question removed");
}
function addOption(i) {
  const q=state.questions[i], labels="ABCDEFGH";
  q.options.push({label:labels[q.options.length]||"?",text:""});
  document.getElementById("pq-"+i).replaceWith(buildPreviewCard(q,i));
  toggleEdit(i);
  schedulePersistence();
}
function addBlankQuestion() {
  const num=(state.questions.at(-1)?.num||0)+1;
  state.questions.push({num,text:"Enter question here",type:"nat",options:[],source:"manual"});
  renderPreview();
  document.getElementById(`pq-${state.questions.length-1}`)?.scrollIntoView({behavior:"smooth",block:"center"});
  schedulePersistence();
}

// ── Exam engine ───────────────────────────────────────────────────────────────
function startExam() {
  if (!state.questions.length) { toast("error","No questions","Add at least one question."); return; }
  state.answers     = {};
  state.statuses    = {};
  state.marked      = {};
  state.currentIdx  = 0;
  state.timeLeft    = state.timeLimit * 60;
  state.totalTime   = state.timeLeft;
  state.phase       = "exam";
  state.submitted   = false;
  // Init all as not-visited
  state.questions.forEach((_,i) => state.statuses[i] = STATUS.NOT_VISITED);
  goScreen("s-exam");
  buildPalette();
  renderQuestion(0);
  startTimer();
  schedulePersistence(0);
}

function renderQuestion(idx) {
  state.currentIdx = idx;
  const q = state.questions[idx];

  // Mark as visited if not already answered/reviewed
  if (state.statuses[idx] === STATUS.NOT_VISITED) {
    state.statuses[idx] = STATUS.NOT_ANSWERED;
  }

  document.getElementById("q-label").textContent = `Question ${q.num}:`;

  const body = document.getElementById("question-body");
  body.innerHTML = "";

  // Question text
  const qtDiv = document.createElement("div");
  qtDiv.className = "question-text";
  qtDiv.style.marginBottom = "18px";
  qtDiv.innerHTML = `<div>${esc(q.text)}</div>${questionImagesMarkup(q.num, idx, "exam")}${
    isMultiSelect(q) ? `<div class="answer-instruction">Select all that apply.</div>` : ""
  }`;
  body.appendChild(qtDiv);

  // Options or NAT
  if (q.type==="mcq" && q.options.length) {
    const ans = state.answers[idx] || [];
    const multiSelect = isMultiSelect(q);
    q.options.forEach((o,oi) => {
      const opt = document.createElement("div");
      opt.className = "exam-option" + (ans.includes(o.label) ? " selected" : "");
      opt.id = `opt-${idx}-${oi}`;
      opt.setAttribute("role", multiSelect ? "checkbox" : "radio");
      opt.setAttribute("aria-checked", ans.includes(o.label));
      opt.setAttribute("tabindex","0");
      opt.setAttribute("aria-label",`Option ${o.label}: ${o.text}`);
      opt.innerHTML = `
        <input type="${multiSelect ? "checkbox" : "radio"}" id="cb-${idx}-${oi}" ${ans.includes(o.label)?"checked":""} aria-hidden="true" onclick="event.stopPropagation();toggleOption(${idx},${oi})">
        <span class="exam-opt-lbl">${esc(o.label)}.</span>
        <span>${esc(o.text)}</span>`;
      opt.onclick = () => toggleOption(idx, oi);
      opt.onkeydown = e => { if (e.key===" ") { e.preventDefault(); toggleOption(idx,oi); } };
      body.appendChild(opt);
    });
  } else {
    const nat  = document.createElement("div");
    nat.className = "nat-wrap";
    const val = state.answers[idx]?.[0] || "";
    nat.innerHTML = `
      <div class="nat-lbl"><i class="ph ph-input-numeric" aria-hidden="true"></i> Enter numerical answer</div>
      <input type="text" class="nat-input" id="nat-${idx}" value="${esc(val)}"
        placeholder="e.g. 3.14" oninput="saveNAT(${idx})"
        aria-label="Numerical answer for question ${q.num}" />`;
    body.appendChild(nat);
  }

  updatePalette();
  renderMath();
  body.scrollTop = 0;
  schedulePersistence();
}

function toggleOption(qi, oi) {
  const q   = state.questions[qi];
  if (!state.answers[qi]) state.answers[qi] = [];
  const ans = state.answers[qi];
  const lbl = q.options[oi].label;
  const ix  = ans.indexOf(lbl);
  if (!isMultiSelect(q)) {
    state.answers[qi] = [lbl];
  } else if (ix >= 0) {
    ans.splice(ix,1);
  } else {
    ans.push(lbl);
  }
  const selected = state.answers[qi];

  // Update option visuals
  q.options.forEach((_,j) => {
    const opt = document.getElementById(`opt-${qi}-${j}`);
    const cb  = document.getElementById(`cb-${qi}-${j}`);
    if (!opt||!cb) return;
    const sel = selected.includes(q.options[j].label);
    opt.classList.toggle("selected", sel);
    opt.setAttribute("aria-checked", sel);
    cb.checked = sel;
  });

  // Update status
  updateStatus(qi);
  updatePalette();
  schedulePersistence();
}

function saveNAT(qi) {
  const val = document.getElementById("nat-"+qi)?.value?.trim();
  state.answers[qi] = val ? [val] : [];
  updateStatus(qi);
  updatePalette();
  schedulePersistence();
}

function updateStatus(qi) {
  const ans     = state.answers[qi] || [];
  const marked  = state.marked[qi];
  const hasAns  = ans.length > 0;

  if (hasAns && marked)       state.statuses[qi] = STATUS.ANSWERED_REVIEW;
  else if (hasAns)            state.statuses[qi] = STATUS.ANSWERED;
  else if (marked)            state.statuses[qi] = STATUS.REVIEW;
  else                        state.statuses[qi] = STATUS.NOT_ANSWERED;
}

// ── NTA Action buttons ────────────────────────────────────────────────────────
function saveAndNext() {
  updateStatus(state.currentIdx);
  const next = state.currentIdx + 1;
  if (next < state.questions.length) renderQuestion(next);
  else {
    schedulePersistence();
    toast("info","Last question","You have reached the end of the paper.");
  }
}

function clearResponse() {
  state.answers[state.currentIdx] = [];
  state.marked[state.currentIdx]  = false;
  updateStatus(state.currentIdx);
  renderQuestion(state.currentIdx);
}

function saveAndMarkReview() {
  state.marked[state.currentIdx] = true;
  updateStatus(state.currentIdx);
  const next = state.currentIdx + 1;
  if (next < state.questions.length) renderQuestion(next);
  else schedulePersistence();
}

function markReviewAndNext() {
  state.marked[state.currentIdx] = true;
  if (!(state.answers[state.currentIdx]?.length)) {
    state.statuses[state.currentIdx] = STATUS.REVIEW;
  } else {
    state.statuses[state.currentIdx] = STATUS.ANSWERED_REVIEW;
  }
  const next = state.currentIdx + 1;
  if (next < state.questions.length) renderQuestion(next);
  else schedulePersistence();
}

function prevQuestion() {
  if (state.currentIdx > 0) renderQuestion(state.currentIdx - 1);
}
function nextQuestion() {
  if (state.currentIdx < state.questions.length-1) renderQuestion(state.currentIdx+1);
}

function scrollQTop()    { document.getElementById("question-body").scrollTop = 0; }
function scrollQBottom() { const b=document.getElementById("question-body"); b.scrollTop=b.scrollHeight; }

// ── Palette ───────────────────────────────────────────────────────────────────
function buildPalette() {
  const grid = document.getElementById("palette-grid");
  grid.innerHTML = "";
  state.questions.forEach((q,i) => {
    const dot = document.createElement("div");
    dot.className = "pal-dot status-notvisited";
    dot.id        = "pdot-"+i;
    dot.textContent = q.num;
    dot.setAttribute("role","button");
    dot.setAttribute("aria-label",`Question ${q.num}`);
    dot.onclick   = () => renderQuestion(i);
    grid.appendChild(dot);
  });
}

function updatePalette() {
  const counts = { notvisited:0, notanswered:0, answered:0, review:0, answeredreview:0 };
  state.questions.forEach((_,i) => {
    const s   = state.statuses[i] || STATUS.NOT_VISITED;
    const dot = document.getElementById("pdot-"+i);
    if (dot) {
      dot.className = `pal-dot status-${s}${i===state.currentIdx?" current":""}`;
    }
    counts[s] = (counts[s]||0)+1;
  });
  document.getElementById("cnt-notvisited").textContent     = counts.notvisited     || 0;
  document.getElementById("cnt-notanswered").textContent    = counts.notanswered    || 0;
  document.getElementById("cnt-answered").textContent       = counts.answered       || 0;
  document.getElementById("cnt-review").textContent         = counts.review         || 0;
  document.getElementById("cnt-answeredreview").textContent = counts.answeredreview || 0;
}

// ── Timer ─────────────────────────────────────────────────────────────────────
function startTimer() {
  updateTimerDisplay();
  state.timerInterval = setInterval(() => {
    state.timeLeft--;
    updateTimerDisplay();
    const pct  = state.timeLeft / state.totalTime;
    const box  = document.querySelector(".exam-timer-box");
    if (pct <= 0.08)      box.className = "exam-timer-box danger";
    else if (pct <= 0.20) box.className = "exam-timer-box warn";
    else                  box.className = "exam-timer-box";
    if (state.timeLeft === 300) toast("warn","5 minutes remaining","Save your answers.");
    if (state.timeLeft % 5 === 0) schedulePersistence(0);
    if (state.timeLeft <= 0)   { clearInterval(state.timerInterval); submitExam(); }
  }, 1000);
}

function updateTimerDisplay() {
  const h=Math.floor(state.timeLeft/3600);
  const m=Math.floor((state.timeLeft%3600)/60);
  const s=state.timeLeft%60;
  document.getElementById("timer-display").textContent =
    `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

// ── Submit ────────────────────────────────────────────────────────────────────
function confirmSubmit() {
  const counts = { notvisited:0, notanswered:0, answered:0, review:0, answeredreview:0 };
  state.questions.forEach((_,i) => {
    const s = state.statuses[i] || STATUS.NOT_VISITED;
    counts[s] = (counts[s]||0)+1;
  });
  document.getElementById("modal-body").innerHTML = `
    <div class="modal-stat"><span>Total Questions</span><strong>${state.questions.length}</strong></div>
    <div class="modal-stat"><span><i class="ph ph-circle state-answered" aria-hidden="true"></i> Answered</span><strong>${counts.answered+counts.answeredreview}</strong></div>
    <div class="modal-stat"><span><i class="ph ph-circle state-notanswered" aria-hidden="true"></i> Not Answered</span><strong>${counts.notanswered}</strong></div>
    <div class="modal-stat"><span><i class="ph ph-circle state-review" aria-hidden="true"></i> Marked for Review</span><strong>${counts.review+counts.answeredreview}</strong></div>
    <div class="modal-stat"><span><i class="ph ph-circle state-notvisited" aria-hidden="true"></i> Not Visited</span><strong>${counts.notvisited}</strong></div>
    <div class="modal-confirm-note">Are you sure you want to submit? This action cannot be undone.</div>`;
  document.getElementById("modal-overlay").style.display = "flex";
}

function closeModal() {
  document.getElementById("modal-overlay").style.display = "none";
}

async function submitExam() {
  if (state.submitted || state.submitting) return;
  state.submitting = true;
  clearInterval(state.timerInterval);
  closeModal();
  clearTimeout(persistenceTimer);
  try {
    await persistenceChain;
    state.lifetimeCount = await ExamStorage.completeActiveExam();
    state.submitted = true;
    state.phase = null;
    persistenceReady = false;
  } catch (error) {
    state.submitting = false;
    console.error("Exam submission cleanup failed:", error);
    toast("error", "Could not submit exam", error.message);
    if (state.timeLeft > 0) startTimer();
    return;
  }
  state.submitting = false;
  const elapsed = state.totalTime - state.timeLeft;
  const h=Math.floor(elapsed/3600), m=Math.floor((elapsed%3600)/60), s=elapsed%60;
  renderResults(`Time taken: ${h}h ${m}m ${s}s`);
  goScreen("s-result");
}

// ── Scoring ───────────────────────────────────────────────────────────────────
function calcScore() {
  let score=0, correct=0, wrong=0, unattempted=0;
  state.questions.forEach((q,i) => {
    const ans    = state.answers[i] || [];
    const keyAns = q.correctAnswer;
    if (!ans.length) { unattempted++; return; }
    if (!keyAns) return;
    const userStr = [...ans].sort().join("");
    const keyStr  = [...(Array.isArray(keyAns)?keyAns:[keyAns])].sort().join("");
    if (userStr===keyStr) { correct++; score+=getMark(q,true); }
    else                  { wrong++;   score+=getMark(q,false); }
  });
  return { score:Math.round(score*100)/100, correct, wrong, unattempted };
}

function getMark(question, ok) {
  if (state.marking==="gate") {
    return ok ? 2 : (question.type==="mcq" && !isMultiSelect(question) ? -0.67 : 0);
  }
  if (state.marking==="simple") return ok ? 1 : 0;
  return ok ? state.customMarks.correct : -Math.abs(state.customMarks.wrong);
}

// ── Results ───────────────────────────────────────────────────────────────────
function renderResults(subtitle) {
  document.getElementById("result-sub").textContent = subtitle;
  const hasKey = state.questions.some(q=>q.correctAnswer);

  if (hasKey) {
    const {score,correct,wrong,unattempted} = calcScore();
    document.getElementById("result-stats").innerHTML = `
      <div class="stat-box"><div class="stat-num stat-orange">${score}</div><div class="stat-lbl">Score</div></div>
      <div class="stat-box"><div class="stat-num stat-green">${correct}</div><div class="stat-lbl">Correct</div></div>
      <div class="stat-box"><div class="stat-num stat-wrong">${wrong}</div><div class="stat-lbl">Wrong</div></div>
      <div class="stat-box"><div class="stat-num stat-muted">${unattempted}</div><div class="stat-lbl">Skipped</div></div>
      <div class="stat-box"><div class="stat-num">${state.lifetimeCount}</div><div class="stat-lbl">Lifetime submissions</div></div>`;
  } else {
    const attempted = Object.values(state.answers).filter(a=>a?.length>0).length;
    document.getElementById("result-stats").innerHTML = `
      <div class="stat-box"><div class="stat-num">${state.questions.length}</div><div class="stat-lbl">Total</div></div>
      <div class="stat-box"><div class="stat-num stat-orange">${attempted}</div><div class="stat-lbl">Attempted</div></div>
      <div class="stat-box"><div class="stat-num stat-muted">${state.questions.length-attempted}</div><div class="stat-lbl">Skipped</div></div>
      <div class="stat-box"><div class="stat-num stat-review">${Object.values(state.marked).filter(Boolean).length}</div><div class="stat-lbl">Reviewed</div></div>
      <div class="stat-box"><div class="stat-num">${state.lifetimeCount}</div><div class="stat-lbl">Lifetime submissions</div></div>`;
  }

  const list = document.getElementById("result-list");
  list.innerHTML = "";
  state.questions.forEach((q,i) => {
    const ans    = state.answers[i] || [];
    const keyAns = q.correctAnswer;
    let cls = "skip";
    if (ans.length && keyAns) {
      const userStr = [...ans].sort().join("");
      const keyStr  = [...(Array.isArray(keyAns)?keyAns:[keyAns])].sort().join("");
      cls = userStr===keyStr ? "ok" : "bad";
    } else if (ans.length) cls = "";

    const statusBadge = cls==="ok"
      ? `<span class="badge badge-green"><i class="ph ph-check-circle" aria-hidden="true"></i> Correct</span>`
      : cls==="bad"
        ? `<span class="badge badge-wrong"><i class="ph ph-x-circle" aria-hidden="true"></i> Wrong</span>`
        : `<span class="badge badge-grey"><i class="ph ph-minus-circle" aria-hidden="true"></i> ${ans.length?"Answered":"Skipped"}</span>`;

    const div = document.createElement("div");
    div.className = `result-item ${cls}`;
    div.innerHTML = `
      <div style="flex:1;min-width:0">
        <div class="result-qmeta">Q${q.num} · ${questionTypeLabel(q)} ${state.marked[i]?"· <i class='ph ph-flag' aria-hidden='true'></i> Marked":""}</div>
        <div class="result-qtext">${esc(q.text.slice(0,160))}${q.text.length>160?"…":""}</div>
        ${questionImagesMarkup(q.num, i, "result")}
        ${ans.length ? `<div class="result-ans">Your answer: <strong>${esc(ans.join(", "))}</strong></div>`:""}
        ${keyAns ? `<div class="result-ans ${cls==="ok"?"result-correct":"result-wrong"}">Correct: <strong>${esc(Array.isArray(keyAns)?keyAns.join(", "):keyAns)}</strong></div>`:""}
      </div>
      <div style="flex-shrink:0">${statusBadge}</div>`;
    list.appendChild(div);
  });
  renderMath();
}

// ── PDF Download ──────────────────────────────────────────────────────────────
function downloadPDF() {
  const hasKey = state.questions.some(q=>q.correctAnswer);
  const {score,correct,wrong} = hasKey ? calcScore() : {score:"—",correct:"—",wrong:"—"};
  const rows = state.questions.map((q,i) => {
    const ans    = state.answers[i]||[];
    const keyAns = q.correctAnswer;
    let status="Skipped";
    if (ans.length && keyAns) {
      const u=[...ans].sort().join(""), k=[...(Array.isArray(keyAns)?keyAns:[keyAns])].sort().join("");
      status = u===k ? "✓ Correct" : "✗ Wrong";
    } else if (ans.length) status="Answered";
    return `<tr><td>${q.num}</td><td>${esc(q.text.slice(0,120))}${q.text.length>120?"…":""}</td><td>${esc(ans.join(", ")||"—")}</td><td>${esc(keyAns||"—")}</td><td>${status}</td></tr>`;
  }).join("");

  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Amibrave Results</title>
  <style>body{font-family:Arial,sans-serif;max-width:900px;margin:0 auto;padding:2rem;font-size:13px}
  h1{font-size:20px;color:#e55b00;margin-bottom:4px}.sub{color:#666;font-size:12px;margin-bottom:1.5rem}
  .stats{display:flex;gap:1rem;margin-bottom:1.5rem;flex-wrap:wrap}
  .stat{padding:.75rem 1.25rem;background:#f5f5f5;border-radius:4px;text-align:center}
  .stat-n{font-size:22px;font-weight:700}.stat-l{font-size:11px;color:#888;text-transform:uppercase}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{background:#e55b00;color:#fff;padding:8px 10px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.3px}
  td{padding:7px 10px;border-bottom:1px solid #eee;vertical-align:top}
  tr:nth-child(even) td{background:#fafafa}</style></head><body>
  <h1>Amibrave — Exam Results</h1>
  <p class="sub">Generated ${new Date().toLocaleString()}</p>
  ${hasKey?`<div class="stats">
    <div class="stat"><div class="stat-n" style="color:#e55b00">${score}</div><div class="stat-l">Score</div></div>
    <div class="stat"><div class="stat-n" style="color:#2e7d32">${correct}</div><div class="stat-l">Correct</div></div>
    <div class="stat"><div class="stat-n" style="color:#c62828">${wrong}</div><div class="stat-l">Wrong</div></div>
  </div>`:""}
  <table><thead><tr><th>#</th><th>Question</th><th>Your Answer</th><th>Correct</th><th>Result</th></tr></thead>
  <tbody>${rows}</tbody></table></body></html>`;

  const w=window.open("","_blank");
  if (w) { w.document.write(html); w.document.close(); setTimeout(()=>w.print(),600); }
  else toast("warn","Pop-up blocked","Allow pop-ups to download results.");
}

function downloadJSON() {
  const hasKey = state.questions.some(question => question.correctAnswer);
  const score = hasKey ? calcScore() : null;
  const attempted = Object.values(state.answers).filter(answer => answer?.length).length;
  const report = {
    format: "amibrave-exam-results",
    version: 1,
    submittedAt: new Date().toISOString(),
    lifetimeSubmissionCount: state.lifetimeCount,
    durationSeconds: Math.max(0, state.totalTime - state.timeLeft),
    settings: {
      marking: state.marking,
      customMarks: state.customMarks,
    },
    summary: {
      totalQuestions: state.questions.length,
      attempted,
      skipped: state.questions.length - attempted,
      markedForReview: Object.values(state.marked).filter(Boolean).length,
      score: score?.score ?? null,
      correct: score?.correct ?? null,
      wrong: score?.wrong ?? null,
    },
    questions: state.questions.map((question, index) => ({
      number: question.num,
      type: questionTypeLabel(question),
      text: question.text,
      options: question.options || [],
      answer: state.answers[index] || [],
      correctAnswer: question.correctAnswer ?? null,
      markedForReview: Boolean(state.marked[index]),
      sourcePages: question.source_pages || [],
    })),
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `amibrave-results-${new Date().toISOString().slice(0,10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Reset ─────────────────────────────────────────────────────────────────────
function resetAll() {
  clearInterval(state.timerInterval);
  clearTimeout(persistenceTimer);
  state.images.forEach(image => URL.revokeObjectURL(image.src));
  state.images = [];
  Object.assign(state,{questions:[],imageVisibility:{},answers:{},statuses:{},marked:{},warnings:[],phase:null,
    timeLimit:180,marking:"gate",timerInterval:null,timeLeft:0,totalTime:0,currentIdx:0});
  persistenceReady = false;
  document.getElementById("qf").value="";
  document.getElementById("af").value="";
  document.getElementById("q-info").innerHTML="";
  document.getElementById("a-info").innerHTML="";
  document.getElementById("process-btn").disabled=true;
  styleZone("qz",""); styleZone("az","");
  goScreen("s-upload");
}

async function restoreSavedExam() {
  try {
    state.lifetimeCount = await ExamStorage.getLifetimeCount();
    const saved = await ExamStorage.getActiveExam();
    if (!saved) return;

    Object.assign(state, saved.exam);
    state.imageVisibility = saved.exam.imageVisibility || {};
    state.timerInterval = null;
    state.images = saved.images.map(image => ({
      ...image,
      src: URL.createObjectURL(image.blob),
    }));
    persistenceReady = true;

    if (state.phase === "exam") {
      const elapsedWhileClosed = Math.floor((Date.now() - saved.exam.savedAt) / 1000);
      state.timeLeft = Math.max(0, state.timeLeft - elapsedWhileClosed);
      if (state.timeLeft === 0) {
        await submitExam();
        return;
      }
      buildPalette();
      renderQuestion(state.currentIdx);
      goScreen("s-exam");
      startTimer();
      toast("info", "Exam resumed", "Your saved answers and remaining time were restored.");
      return;
    }

    if (state.phase === "preview") {
      renderPreview();
      goScreen("s-preview");
      toast("info", "Exam restored", "Your saved preview is ready to continue.");
      return;
    }

    throw new Error("Saved exam has an unsupported state.");
  } catch (error) {
    console.error("Saved exam could not be restored:", error);
    toast("error", "Could not restore exam", error.message);
  }
}

// ── KaTeX ─────────────────────────────────────────────────────────────────────
function renderMath() {
  if (!window.katexReady || typeof renderMathInElement==="undefined") { setTimeout(renderMath,300); return; }
  try {
    renderMathInElement(document.body, {
      delimiters:[
        {left:"$$",right:"$$",display:true},
        {left:"$",right:"$",display:false},
        {left:"\\(",right:"\\)",display:false},
        {left:"\\[",right:"\\]",display:true},
      ],
      throwOnError:false,
    });
  } catch(e) { console.warn("KaTeX:",e); }
}


// ── Theme switcher ────────────────────────────────────────────────────────────
(function initThemeSwitcher() {
  const toggle = document.getElementById("theme-toggle");
  if (!toggle) return;

  const root = document.documentElement;
  const storageKey = "amibrave-theme";

  function applyTheme(theme) {
    const isDark = theme === "dark";
    root.dataset.theme = isDark ? "dark" : "light";
    toggle.setAttribute("aria-pressed", String(isDark));
    toggle.setAttribute("aria-label", isDark ? "Switch to light theme" : "Switch to dark theme");
    toggle.innerHTML = isDark
      ? '<i class="ph ph-sun" aria-hidden="true"></i><span class="theme-toggle-label">Light mode</span>'
      : '<i class="ph ph-moon" aria-hidden="true"></i><span class="theme-toggle-label">Dark mode</span>';
  }

  let savedTheme = "light";
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === "dark" || stored === "light") savedTheme = stored;
  } catch (error) {
    console.warn("Theme preference could not be read:", error);
  }
  applyTheme(savedTheme);

  toggle.addEventListener("click", () => {
    const nextTheme = root.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
    try {
      localStorage.setItem(storageKey, nextTheme);
    } catch (error) {
      console.warn("Theme preference could not be saved:", error);
    }
  });
})();

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushPersistence();
});
window.addEventListener("pagehide", flushPersistence);
void restoreSavedExam();
