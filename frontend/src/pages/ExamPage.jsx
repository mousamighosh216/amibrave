import { useEffect, useMemo, useRef, useState } from 'react';

export default function ExamPage({ exam, images, onAnswer, onToggleReview, onSubmit, onDiscard }) {
  const [now, setNow] = useState(Date.now());
  const [currentIndex, setCurrentIndex] = useState(0);
  const submittedRef = useRef(false);
  const questions = exam.questions || [];
  const question = questions[currentIndex];
  const remainingSeconds = Math.max(0, Math.ceil(((exam.deadlineAt || now) - now) / 1000));
  const minutes = Math.floor(remainingSeconds / 60).toString().padStart(2, '0');
  const seconds = (remainingSeconds % 60).toString().padStart(2, '0');
  const answeredCount = useMemo(() => questions.filter(item => hasAnswer(item.selectedAnswer)).length, [questions]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (typeof window.renderMathInElement === 'function') {
      document.querySelectorAll('.exam-question-text').forEach(element => {
        window.renderMathInElement(element, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false },
            { left: '\\[', right: '\\]', display: true },
          ],
          throwOnError: false,
        });
      });
    }
  }, [currentIndex, question?.text]);

  useEffect(() => {
    if (remainingSeconds === 0 && !submittedRef.current) {
      submittedRef.current = true;
      onSubmit();
    }
  }, [remainingSeconds, onSubmit]);

  if (!question) return <main className="screen active"><div className="exam-empty">No questions are available in this exam.</div></main>;

  const questionImages = images.filter(image => String(image.question_number) === String(question.num)).sort((a, b) => Number(a.part) - Number(b.part));
  const selected = question.selectedAnswer;
  const isMultiple = question.type === 'msq';

  function setOption(label, checked) {
    if (isMultiple) {
      const current = Array.isArray(selected) ? selected : [];
      onAnswer(question.num, checked ? [...new Set([...current, label])] : current.filter(value => value !== label));
    } else {
      onAnswer(question.num, label);
    }
  }

  function confirmSubmit() {
    const unanswered = questions.length - answeredCount;
    const message = unanswered > 0
      ? `You have ${unanswered} unanswered question(s). Submit the exam anyway?`
      : 'Submit your exam now? You cannot change answers after submission.';
    if (window.confirm(message) && !submittedRef.current) {
      submittedRef.current = true;
      onSubmit();
    }
  }

  return (
    <main className="screen active exam-screen">
      <header className="exam-topbar">
        <div><div className="exam-brand">Amibrave</div><div className="exam-caption">Practice session</div></div>
        <div className={`exam-timer${remainingSeconds < 300 ? ' urgent' : ''}`} aria-live="off"><span className="timer-label">Time left</span><strong>{minutes}:{seconds}</strong></div>
        <div className="exam-top-actions">
          <button type="button" className="btn-nta btn-ghost" onClick={onDiscard}>Discard exam</button>
          <button type="button" className="btn-nta btn-green" onClick={confirmSubmit}>Submit exam</button>
        </div>
      </header>

      <div className="exam-layout">
        <section className="exam-question-panel">
          <div className="exam-question-heading">
            <span>Question {question.num}</span>
            <span className="exam-type-pill">{question.type?.toUpperCase() || 'MCQ'}</span>
            <button type="button" className={`review-toggle${question.markedForReview ? ' selected' : ''}`} onClick={() => onToggleReview(question.num)}>
              {question.markedForReview ? 'Marked for review' : 'Mark for review'}
            </button>
          </div>
          <div className="exam-question-text">{question.text}</div>
          {questionImages.length > 0 && <div className="exam-source-images">{questionImages.map((image, index) => <img key={`${image.page_number}-${image.part}-${index}`} src={image.src} alt={`Source for question ${question.num}, part ${index + 1}`} />)}</div>}

          {question.type === 'nat' ? (
            <label className="exam-nat-field">Your numerical answer
              <input type="number" inputMode="decimal" value={selected ?? ''} onChange={event => onAnswer(question.num, event.target.value)} placeholder="Enter your answer" />
            </label>
          ) : (
            <div className="exam-options">
              {question.options.map((option, index) => {
                const checked = isMultiple ? (Array.isArray(selected) ? selected.includes(option.label) : false) : selected === option.label;
                return <label className={`exam-option${checked ? ' chosen' : ''}`} key={`${option.label}-${index}`}>
                  <input type={isMultiple ? 'checkbox' : 'radio'} name={`question-${question.num}`} checked={checked} onChange={event => setOption(option.label, event.target.checked)} />
                  <span className="exam-option-label">{option.label}</span><span>{option.text}</span>
                </label>;
              })}
              {isMultiple && <div className="exam-hint">Select all options that apply.</div>}
            </div>
          )}

          <div className="exam-navigation">
            <button type="button" className="btn-nta btn-white" disabled={currentIndex === 0} onClick={() => setCurrentIndex(index => index - 1)}>Previous</button>
            <button type="button" className="btn-nta btn-ghost" onClick={() => onAnswer(question.num, null)}>Clear response</button>
            <button type="button" className="btn-nta btn-green" disabled={currentIndex === questions.length - 1} onClick={() => setCurrentIndex(index => index + 1)}>Save &amp; Next</button>
          </div>
        </section>

        <aside className="exam-sidebar">
          <div className="exam-sidebar-title">Question palette</div>
          <div className="exam-progress-copy">{answeredCount} of {questions.length} answered</div>
          <div className="exam-palette">
            {questions.map((item, index) => {
              const answered = hasAnswer(item.selectedAnswer);
              return <button type="button" key={`${item.num}-${index}`} className={`palette-item${index === currentIndex ? ' current' : ''}${answered ? ' answered' : ''}${item.markedForReview ? ' flagged' : ''}`} onClick={() => setCurrentIndex(index)} aria-label={`Go to question ${item.num}${answered ? ', answered' : ', unanswered'}${item.markedForReview ? ', marked for review' : ''}`}>{item.num}</button>;
            })}
          </div>
          <div className="exam-legend"><span><i className="legend-dot answered" /> Answered</span><span><i className="legend-dot flagged" /> Review</span><span><i className="legend-dot" /> Unanswered</span></div>
          <button type="button" className="btn-nta btn-green exam-submit-side" onClick={confirmSubmit}>Submit exam</button>
        </aside>
      </div>
    </main>
  );
}

function hasAnswer(answer) {
  if (Array.isArray(answer)) return answer.length > 0;
  return answer !== null && answer !== undefined && String(answer).trim() !== '';
}
