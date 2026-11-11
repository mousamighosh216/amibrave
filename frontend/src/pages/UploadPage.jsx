import { useEffect, useRef, useState } from 'react';

const MAX_FILE_SIZE = 10 * 1024 * 1024;

function FileUploadCard({ title, icon, optional = false, hint, file, onFileChange, inputId, onError }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  function acceptFile(candidate) {
    if (!candidate) return;
    if (!candidate.name.toLowerCase().endsWith('.pdf') || candidate.type && candidate.type !== 'application/pdf') {
      onError('Invalid file', 'Only PDF files are accepted.');
      return;
    }
    if (candidate.size > MAX_FILE_SIZE) {
      onError('File too large', 'The maximum PDF size is 10 MB.');
      return;
    }
    onFileChange(candidate);
  }

  return (
    <div className="upload-card">
      <div className="upload-card-title">
        <i className={`ph ${icon}`} aria-hidden="true" />
        {title}
        {optional && <span className="opt-tag">Optional</span>}
      </div>
      <div
        className={`drop-zone${dragging ? ' dragging' : ''}${file ? ' done' : ''}`}
        tabIndex={0}
        role="button"
        aria-label={`Upload ${title} PDF`}
        onClick={() => inputRef.current?.click()}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={event => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={event => {
          event.preventDefault();
          setDragging(false);
          acceptFile(event.dataTransfer.files?.[0]);
        }}
      >
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept="application/pdf,.pdf"
          onChange={event => { acceptFile(event.target.files?.[0]); event.target.value = ''; }}
        />
        <i className={`ph ${file ? 'ph-check-circle' : 'ph-upload-simple'} drop-icon`} aria-hidden="true" />
        <div className="drop-label">Drop PDF or <span className="drop-link">browse</span></div>
        <div className="drop-hint">{hint}</div>
      </div>
      <div className="file-info">
        {file && (
          <span className="file-badge">
            <i className="ph ph-check-circle" aria-hidden="true" />
            {file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB
          </span>
        )}
      </div>
    </div>
  );
}

export default function UploadPage({ active = false, onProcess, initialError = '', solvedCount = 0, onClearAll }) {
  const [questionFile, setQuestionFile] = useState(null);
  const [answerKeyFile, setAnswerKeyFile] = useState(null);
  const [duration, setDuration] = useState(180);
  const [marking, setMarking] = useState('gate');
  const [correctMarks, setCorrectMarks] = useState(1);
  const [wrongMarks, setWrongMarks] = useState(0);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    setNotice(initialError ? { title: 'Processing failed', detail: initialError } : null);
  }, [initialError]);

  function showError(title, detail) {
    setNotice({ title, detail });
    window.setTimeout(() => setNotice(null), 4500);
  }

  function handleSubmit(event) {
    event.preventDefault();
    const durationValue = Number(duration);
    if (!questionFile) {
      showError('Question paper required', 'Choose a question paper PDF before continuing.');
      return;
    }
    if (!Number.isFinite(durationValue) || durationValue < 5 || durationValue > 360) {
      showError('Invalid duration', 'Choose a duration between 5 and 360 minutes.');
      return;
    }
    if (marking === 'custom' && (!Number.isFinite(Number(correctMarks)) || !Number.isFinite(Number(wrongMarks)))) {
      showError('Invalid marking scheme', 'Enter valid numbers for both correct and incorrect answers.');
      return;
    }
    setNotice(null);
    onProcess?.({
      questionFile,
      answerKeyFile,
      settings: {
        duration: durationValue,
        marking,
        customMarks: { correct: Number(correctMarks), wrong: Number(wrongMarks) },
      },
    });
  }

  return (
    <main className={`screen${active ? ' active' : ''}`}>
      <form className="upload-page" onSubmit={handleSubmit}>
        <div className="upload-brand">
          <i className="ph ph-atom" aria-hidden="true" />
          <div>
            <div className="upload-brand-name">Amibrave</div>
            {/* <div className="upload-brand-sub">GATE Practice Paper Generator</div> */}
          </div>
        </div>

        <div className="upload-dashboard-row">
          <div className="solved-count"><strong>{solvedCount}</strong><span>papers solved on this browser</span></div>
          {solvedCount > 0 && <button className="clear-data-link" type="button" onClick={onClearAll}>Clear all app data</button>}
        </div>

        <div className="upload-cards">
          <FileUploadCard
            title="Question Paper"
            icon="ph-file-pdf"
            hint="Digital PDFs · Max 10 MB"
            inputId="question-paper"
            file={questionFile}
            onFileChange={setQuestionFile}
            onError={showError}
          />
          <FileUploadCard
            title="Answer Key"
            icon="ph-key"
            optional
            hint="Skip if unavailable"
            inputId="answer-key"
            file={answerKeyFile}
            onFileChange={setAnswerKeyFile}
            onError={showError}
          />
        </div>

        <section className="upload-card" style={{ marginTop: 16 }}>
          <div className="upload-card-title">
            <i className="ph ph-sliders-horizontal" aria-hidden="true" />
            Settings
          </div>
          <div className="settings-row">
            <div className="field-group">
              <label className="field-lbl" htmlFor="time-limit">Duration (minutes)</label>
              <input
                id="time-limit"
                className="field-inp"
                type="number"
                min="5"
                max="360"
                value={duration}
                onChange={event => setDuration(event.target.value)}
              />
            </div>
            <div className="field-group">
              <label className="field-lbl" htmlFor="marking">Marking Scheme</label>
              <select id="marking" className="field-inp" value={marking} onChange={event => setMarking(event.target.value)}>
                <option value="gate">GATE Standard (+2 / −0.67)</option>
                <option value="simple">Simple (+1 / 0)</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            {marking === 'custom' && (
              <div className="field-group">
                <label className="field-lbl">Custom Marks</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="field-inp" type="number" aria-label="Marks for correct answer" placeholder="Correct" value={correctMarks} onChange={event => setCorrectMarks(event.target.value)} />
                  <input className="field-inp" type="number" aria-label="Marks for wrong answer" placeholder="Wrong" value={wrongMarks} onChange={event => setWrongMarks(event.target.value)} />
                </div>
              </div>
            )}
          </div>
        </section>

        <div className="upload-action">
          <button className="btn-extract" type="submit" disabled={!questionFile}>
            <i className="ph ph-arrows-clockwise" aria-hidden="true" />
            Extract Questions
          </button>
        </div>
      </form>
      {notice && (
        <div className="toast-container" role="status" aria-live="polite">
          <div className="toast info">
            <i className="ph ph-info" aria-hidden="true" />
            <div>
              <div className="toast-title">{notice.title}</div>
              <div className="toast-detail">{notice.detail}</div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
