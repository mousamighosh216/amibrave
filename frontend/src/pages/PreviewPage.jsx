import { useEffect, useMemo } from 'react';
import QuestionPreviewCard from '../components/preview/QuestionPreviewCard.jsx';

export default function PreviewPage({ active = false, questions, images, warnings, onQuestionsChange, onStartExam, onDiscard }) {
  useEffect(() => {
    if (typeof window.renderMathInElement === 'function') {
      document.querySelectorAll('.pq-text').forEach(element => {
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
  }, [questions]);


  const counts = useMemo(() => ({
    total: questions.length,
    mcq: questions.filter(question => question.type === 'mcq').length,
    msq: questions.filter(question => question.type === 'msq').length,
    nat: questions.filter(question => question.type === 'nat').length,
  }), [questions]);

  function updateQuestion(index, updatedQuestion) {
    onQuestionsChange(current => current.map((question, questionIndex) => (
      questionIndex === index ? updatedQuestion : question
    )));
  }

  function deleteQuestion(index) {
    onQuestionsChange(current => current.filter((_, questionIndex) => questionIndex !== index));
  }

  function addQuestion() {
    const nextNumber = Math.max(0, ...questions.map(question => Number(question.num) || 0)) + 1;
    onQuestionsChange(current => [...current, {
      num: nextNumber,
      text: 'Enter question here',
      type: 'nat',
      options: [],
      source: 'manual',
    }]);
  }

  return (
    <main className={`screen${active ? ' active' : ''}`}>
      <header className="preview-header">
        <div className="preview-title-row">
          <div className="preview-title">Review Extracted Questions</div>
          <div className="preview-sub">Edit or remove questions before starting the exam</div>
        </div>
        <div className="preview-actions">
          <button className="btn-nta btn-ghost" type="button" onClick={addQuestion}>
            <i className="ph ph-plus" aria-hidden="true" /> Add Question
          </button>
          <button className="btn-nta btn-white" type="button" onClick={onDiscard}>Discard paper</button>
          <button className="btn-nta btn-green" type="button" onClick={onStartExam} disabled={!questions.length}>
            <i className="ph ph-play" aria-hidden="true" /> Start Exam
          </button>
        </div>
      </header>

      <section className="preview-stats" aria-label="Question counts">
        <Stat value={counts.total} label="Total" />
        <Stat value={counts.mcq} label="MCQ" tone="orange" />
        <Stat value={counts.msq} label="MSQ" tone="blue" />
        <Stat value={counts.nat} label="NAT" tone="blue" />
      </section>

      {warnings.length > 0 && (
        <div className="warn-panel">
          {warnings.map((warning, index) => (
            <div className="warn-item" key={`${warning.message || 'warning'}-${index}`}>
              <i className="ph ph-warning" aria-hidden="true" />
              <div>
                <div className="warn-title">{warning.message || 'Processing warning'}</div>
                {warning.detail && <div className="warn-detail">{warning.detail}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {questions.length ? questions.map((question, index) => (
        <QuestionPreviewCard
          key={`${question.num}-${index}`}
          question={question}
          index={index}
          images={images
            .filter(image => String(image.question_number) === String(question.num))
            .sort((left, right) => Number(left.part) - Number(right.part))}
          onUpdate={updateQuestion}
          onDelete={deleteQuestion}
        />
      )) : (
        <div className="pq-card">No questions remain. Add a question or upload another paper.</div>
      )}
    </main>
  );
}

function Stat({ value, label, tone }) {
  return (
    <div className="stat-box">
      <div className={`stat-num${tone ? ` stat-${tone}` : ''}`}>{value}</div>
      <div className="stat-lbl">{label}</div>
    </div>
  );
}
