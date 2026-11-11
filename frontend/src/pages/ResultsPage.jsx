import { useState } from 'react';

export default function ResultsPage({ exam, onConfirmCleanup }) {
  const [downloadStarted, setDownloadStarted] = useState(false);
  const results = exam.results || {};
  const hasAnswerKey = Number(results.keyedQuestions) > 0;

  function downloadJson() {
    const exportData = {
      application: 'Amibrave',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      exam: {
        createdAt: exam.createdAt ? new Date(exam.createdAt).toISOString() : null,
        startedAt: exam.startedAt ? new Date(exam.startedAt).toISOString() : null,
        submittedAt: exam.submittedAt ? new Date(exam.submittedAt).toISOString() : null,
        durationMinutes: exam.settings?.duration ?? null,
        markingScheme: exam.settings?.marking ?? null,
        questionCount: results.total ?? exam.questions.length,
        sourcePdf: {
          fileName: exam.originalPdfName || null,
          fileSizeBytes: exam.originalPdfSize ?? null,
          pageCount: exam.meta?.total_pages ?? null,
        },
      },
      summary: {
        attempted: results.attempted ?? 0,
        unattempted: results.unattempted ?? 0,
        markedForReview: results.markedForReview ?? 0,
        correct: results.correct,
        wrong: results.wrong,
        score: results.score,
        keyedQuestions: results.keyedQuestions ?? 0,
      },
      questions: exam.questions.map(question => ({
        number: question.num,
        type: question.type,
        text: question.text,
        options: question.options || [],
        selectedAnswer: question.selectedAnswer ?? null,
        markedForReview: Boolean(question.markedForReview),
        sourcePages: question.source_pages || [],
        sourceImageParts: (exam.images || [])
          .filter(image => String(image.question_number) === String(question.num))
          .map(image => ({ pageNumber: image.page_number, part: image.part, format: image.format, mimeType: image.mime_type })),
        visualContentNote: 'Original source image is not embedded in this JSON export.',
      })),
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `amibrave-exam-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDownloadStarted(true);
  }

  return (
    <main className="screen active results-screen">
      <div className="results-card">
        <div className="results-kicker">Practice session complete</div>
        <h1>Exam submitted</h1>
        <p className="results-subtitle">Your answers are saved in this browser until you confirm the export step.</p>

        <div className="results-stats">
          <ResultStat label="Total questions" value={results.total ?? exam.questions.length} />
          <ResultStat label="Attempted" value={results.attempted ?? 0} />
          <ResultStat label="Unattempted" value={results.unattempted ?? 0} />
          <ResultStat label="Marked for review" value={results.markedForReview ?? 0} />
        </div>

        {hasAnswerKey ? (
          <div className="results-score">
            <div><span>Score from available answer key</span><strong>{results.score}</strong></div>
            <div className="results-score-detail">{results.correct} correct · {results.wrong} incorrect · {results.keyedQuestions} questions had an answer key</div>
          </div>
        ) : (
          <div className="results-no-key">No usable answer key was available, so Amibrave has not calculated correctness or a score. Your responses are still included in the JSON export.</div>
        )}

        <div className="results-actions">
          <button type="button" className="btn-nta btn-green" onClick={downloadJson}><i className="ph ph-download-simple" aria-hidden="true" /> Download JSON</button>
          {downloadStarted && <button type="button" className="btn-nta btn-white" onClick={onConfirmCleanup}>I have downloaded it. Clear this exam.</button>}
        </div>
        <p className="results-retention">The detailed exam data remains in this browser until you confirm cleanup. The solved-paper count is kept separately.</p>
      </div>
    </main>
  );
}

function ResultStat({ label, value }) {
  return <div className="results-stat"><strong>{value}</strong><span>{label}</span></div>;
}
