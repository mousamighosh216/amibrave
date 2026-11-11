import { useState } from 'react';

function getQuestionTypeLabel(question) {
  if (question.type === 'nat') return 'NAT';
  if (question.type === 'msq') return 'MSQ';
  return 'MCQ';
}

export default function QuestionPreviewCard({ question, index, images, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [showImages, setShowImages] = useState(false);
  const [draftText, setDraftText] = useState(question.text || '');
  const [draftOptions, setDraftOptions] = useState(() => question.options.map(option => ({ ...option })));

  const typeLabel = getQuestionTypeLabel(question);
  const typeClass = typeLabel === 'MCQ' ? 'badge-orange' : 'badge-blue';

  function beginEditing() {
    setDraftText(question.text || '');
    setDraftOptions(question.options.map(option => ({ ...option })));
    setEditing(true);
  }

  function saveEditing() {
    onUpdate(index, {
      ...question,
      text: draftText,
      options: draftOptions,
    });
    setEditing(false);
  }

  function toggleType() {
    const nextType = question.type === 'nat' ? 'mcq' : 'nat';
    onUpdate(index, {
      ...question,
      type: nextType,
      options: nextType === 'nat' ? [] : question.options,
    });
  }

  function addOption() {
    const labels = 'ABCDEFGH';
    setDraftOptions(current => [...current, {
      label: labels[current.length] || '?',
      text: '',
    }]);
  }

  return (
    <article className="pq-card">
      <div className="pq-meta">
        <span className="pq-num">Question {question.num}</span>
        <div className="pq-badges">
          <span className={`badge ${typeClass}`}>{typeLabel}</span>
          {question.correctAnswer != null && question.correctAnswer !== '' && (
            <span className="badge badge-green"><i className="ph ph-key" aria-hidden="true" /> Key: {String(question.correctAnswer)}</span>
          )}
          {question.source === 'gemini' && <span className="badge badge-grey">Gemini</span>}
          {question.source === 'ocr' && <span className="badge badge-grey">OCR</span>}
        </div>
      </div>

      {images.length > 0 && (
        <div className="question-image-section">
          <button className="question-image-toggle" type="button" onClick={() => setShowImages(value => !value)} aria-expanded={showImages}>
            <i className={`ph ${showImages ? 'ph-eye-slash' : 'ph-eye'}`} aria-hidden="true" />
            {showImages ? 'Hide source image' : 'View source image'}
          </button>
          {showImages && (
            <div className="question-image-list">
              {images.map((image, imageIndex) => (
                <figure className="question-image" key={`${image.page_number}-${image.part}-${imageIndex}`}>
                  <img
                    src={image.src}
                    alt={`Question ${question.num} source image ${imageIndex + 1}`}
                    width={image.width}
                    height={image.height}
                  />
                  {Number(image.part) > 1 && <figcaption>Part {image.part}</figcaption>}
                </figure>
              ))}
            </div>
          )}
        </div>
      )}

      {!editing ? (
        <>
          <div className="pq-text">{question.text}</div>
          {question.type === 'msq' && <div className="answer-instruction">Select all that apply.</div>}
          {question.type === 'nat' ? (
            <div className="nat-type-note"><i className="ph ph-input-numeric" aria-hidden="true" /> Numerical answer type</div>
          ) : question.options.map((option, optionIndex) => (
            <div className="pq-option" key={`${option.label}-${optionIndex}`}>
              <span className="pq-opt-lbl">{option.label}.</span>
              <span>{option.text}</span>
            </div>
          ))}
        </>
      ) : (
        <div className="pq-edit-panel">
          <label className="edit-lbl" htmlFor={`question-text-${index}`}>Question text</label>
          <textarea
            id={`question-text-${index}`}
            className="edit-textarea"
            value={draftText}
            onChange={event => setDraftText(event.target.value)}
          />
          {question.type !== 'nat' && (
            <div style={{ marginTop: 10 }}>
              <label className="edit-lbl">Options</label>
              {draftOptions.map((option, optionIndex) => (
                <div className="opt-edit-row" key={`${option.label}-${optionIndex}`}>
                  <span className="opt-edit-lbl">{option.label}.</span>
                  <input
                    className="field-inp"
                    type="text"
                    aria-label={`Option ${option.label}`}
                    value={option.text}
                    onChange={event => setDraftOptions(current => current.map((item, itemIndex) => (
                      itemIndex === optionIndex ? { ...item, text: event.target.value } : item
                    )))}
                  />
                </div>
              ))}
              <button className="add-opt-btn" type="button" onClick={addOption}>
                <i className="ph ph-plus" aria-hidden="true" /> Add option
              </button>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn-nta btn-green" type="button" onClick={saveEditing}>Save</button>
            <button className="btn-nta btn-white" type="button" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}

      {!editing && (
        <div className="pq-actions">
          <button className="btn-nta btn-ghost" type="button" style={{ fontSize: 12, padding: '5px 11px' }} onClick={beginEditing}>
            <i className="ph ph-pencil" aria-hidden="true" /> Edit
          </button>
          <button className="btn-nta btn-ghost" type="button" style={{ fontSize: 12, padding: '5px 11px' }} onClick={toggleType}>
            <i className="ph ph-arrows-left-right" aria-hidden="true" /> Toggle Type
          </button>
          <button className="btn-nta btn-delete" type="button" onClick={() => onDelete(index)}>
            <i className="ph ph-trash" aria-hidden="true" /> Remove
          </button>
        </div>
      )}
    </article>
  );
}
