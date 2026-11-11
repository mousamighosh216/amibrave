import { useCallback, useEffect, useRef, useState } from 'react';
import UploadPage from './pages/UploadPage.jsx';
import LoadingPage from './pages/LoadingPage.jsx';
import PreviewPage from './pages/PreviewPage.jsx';
import ExamPage from './pages/ExamPage.jsx';
import ResultsPage from './pages/ResultsPage.jsx';
import { processExamFiles, restoreImageUrls, revokeImageUrls } from './services/examApi.js';
import { clearActiveExam, clearAllAppData, getSolvedPaperCount, loadActiveExam, saveActiveExam, submitActiveExam } from './storage/examStorage.js';

const DEFAULT_SETTINGS = { duration: 180, marking: 'gate', customMarks: { correct: 1, wrong: 0 } };

export default function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem('amibrave-theme') || 'light');
  const [screen, setScreen] = useState('restoring');
  const [loading, setLoading] = useState({ message: 'Preparing PDF…', percent: 0 });
  const [exam, setExam] = useState(null);
  const [images, setImages] = useState([]);
  const [solvedCount, setSolvedCount] = useState(0);
  const [error, setError] = useState('');
  const [storageWarning, setStorageWarning] = useState('');
  const imageUrlsRef = useRef([]);
  const hydratedRef = useRef(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('amibrave-theme', theme);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    async function restore() {
      try {
        const [savedExam, count] = await Promise.all([loadActiveExam(), getSolvedPaperCount()]);
        if (cancelled) return;
        let currentCount = count;
        if (savedExam?.status === 'submitted' && !savedExam.counted) {
          try {
            currentCount = await submitActiveExam(savedExam);
            savedExam.counted = true;
          } catch (countError) {
            setStorageWarning(`The submitted exam is restored, but its lifetime count could not be reconciled: ${countError.message}`);
          }
        }
        setSolvedCount(currentCount);
        if (savedExam) {
          const restoredImages = restoreImageUrls(savedExam.images || []);
          imageUrlsRef.current = restoredImages;
          setImages(restoredImages);
          setExam(savedExam);
          setScreen(savedExam.status === 'submitted' ? 'results' : savedExam.status === 'in-progress' ? 'exam' : 'preview');
        } else {
          setScreen('upload');
        }
      } catch (restoreError) {
        if (!cancelled) {
          setStorageWarning(`Local exam storage could not be opened: ${restoreError.message}`);
          setScreen('upload');
        }
      } finally {
        if (!cancelled) hydratedRef.current = true;
      }
    }
    restore();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => () => revokeImageUrls(imageUrlsRef.current), []);

  useEffect(() => {
    if (!hydratedRef.current || !exam) return;
    const timer = window.setTimeout(() => {
      const persisted = {
        ...exam,
        images: images.map(({ src, ...image }) => image),
      };
      saveActiveExam(persisted).catch(saveError => setStorageWarning(`Autosave failed: ${saveError.message}`));
    }, 120);
    return () => window.clearTimeout(timer);
  }, [exam, images]);

  const replaceImages = useCallback(nextImages => {
    revokeImageUrls(imageUrlsRef.current);
    imageUrlsRef.current = nextImages;
    setImages(nextImages);
  }, []);

  async function handleProcess(filesAndSettings) {
    setError('');
    setScreen('loading');
    setLoading({ message: 'Preparing PDF…', percent: 2 });
    try {
      const result = await processExamFiles({
        questionFile: filesAndSettings.questionFile,
        answerKeyFile: filesAndSettings.answerKeyFile,
        onProgress: setLoading,
      });
      replaceImages(result.images);
      const nextExam = {
        status: 'preview',
        questions: result.questions,
        settings: filesAndSettings.settings || DEFAULT_SETTINGS,
        originalPdf: filesAndSettings.questionFile,
        originalPdfName: filesAndSettings.questionFile.name,
        originalPdfSize: filesAndSettings.questionFile.size,
        images: result.images.map(({ src, ...image }) => image),
        warnings: result.warnings,
        meta: result.meta,
        createdAt: Date.now(),
        startedAt: null,
        deadlineAt: null,
        submittedAt: null,
        results: null,
        counted: false,
      };
      await saveActiveExam(nextExam);
      setExam(nextExam);
      setScreen('preview');
    } catch (processingError) {
      setError(processingError.message || 'Something went wrong while processing the PDF.');
      setScreen('upload');
    }
  }

  function updateQuestions(updater) {
    setExam(current => current ? {
      ...current,
      questions: typeof updater === 'function' ? updater(current.questions) : updater,
    } : current);
  }

  async function startExam() {
    if (!exam?.questions?.length) return;
    const startedAt = Date.now();
    const durationMs = Number(exam.settings?.duration || DEFAULT_SETTINGS.duration) * 60 * 1000;
    const nextExam = {
      ...exam,
      status: 'in-progress',
      startedAt,
      deadlineAt: startedAt + durationMs,
      questions: exam.questions.map(question => ({ ...question, selectedAnswer: question.selectedAnswer ?? null, markedForReview: Boolean(question.markedForReview) })),
    };
    try {
      await saveActiveExam({ ...nextExam, images: images.map(({ src, ...image }) => image) });
    } catch (saveError) {
      setStorageWarning(`Exam could not be saved, so the timed session was not started: ${saveError.message}`);
      return;
    }
    setExam(nextExam);
    setScreen('exam');
  }

  function updateAnswer(questionNumber, answer) {
    setExam(current => current ? {
      ...current,
      questions: current.questions.map(question => String(question.num) === String(questionNumber) ? { ...question, selectedAnswer: answer } : question),
    } : current);
  }

  function toggleReview(questionNumber) {
    setExam(current => current ? {
      ...current,
      questions: current.questions.map(question => String(question.num) === String(questionNumber) ? { ...question, markedForReview: !question.markedForReview } : question),
    } : current);
  }

  async function submitExam() {
    if (!exam || exam.status !== 'in-progress') return;
    const results = calculateResults(exam.questions, exam.settings);
    let submitted = { ...exam, status: 'submitted', submittedAt: Date.now(), results, counted: false, originalPdf: null };
    try {
      const nextCount = await submitActiveExam(submitted);
      setSolvedCount(nextCount);
      submitted = { ...submitted, counted: true };
    } catch (saveError) {
      setStorageWarning(`Your result is ready, but the lifetime count could not be updated: ${saveError.message}`);
    }
    setExam(submitted);
    setScreen('results');
  }

  async function discardExam() {
    if (!window.confirm('Discard this paper and all its current answers? The solved-paper count will stay unchanged.')) return;
    await clearActiveExam();
    replaceImages([]);
    setExam(null);
    setScreen('upload');
  }

  async function finishAndClear() {
    await clearActiveExam();
    replaceImages([]);
    setExam(null);
    setScreen('upload');
  }

  async function clearEverything() {
    if (!window.confirm('Clear all Amibrave data on this browser, including the lifetime solved-paper count?')) return;
    await clearAllAppData();
    localStorage.removeItem('amibrave-theme');
    setTheme('light');
    replaceImages([]);
    setExam(null);
    setSolvedCount(0);
    setScreen('upload');
  }

  if (screen === 'restoring') {
    return <main className="screen active"><div className="loading-center"><div className="nta-spinner" role="status" /><div className="loading-title">Restoring your workspace…</div></div></main>;
  }

  return (
    <>
      <div className="toggle">
        <button id="theme-toggle" className="theme-toggle" type="button" aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} aria-pressed={theme === 'dark'} onClick={() => setTheme(current => current === 'light' ? 'dark' : 'light')}>
          <i className={`ph ${theme === 'light' ? 'ph-moon' : 'ph-sun'}`} aria-hidden="true" />
          {screen === 'upload' && <span className="theme-toggle-label">{theme === 'light' ? 'Dark mode' : 'Light mode'}</span>}
        </button>
      </div>

      {storageWarning && <div className="storage-warning" role="status">{storageWarning}</div>}
      <UploadPage active={screen === 'upload'} onProcess={handleProcess} initialError={error} solvedCount={solvedCount} onClearAll={clearEverything} />
      <LoadingPage active={screen === 'loading'} message={loading.message} progress={loading.percent} />
      {exam && <PreviewPage active={screen === 'preview'} questions={exam.questions} images={images} warnings={exam.warnings || []} onQuestionsChange={updateQuestions} onStartExam={startExam} onDiscard={discardExam} />}
      {exam && screen === 'exam' && <ExamPage exam={exam} images={images} onAnswer={updateAnswer} onToggleReview={toggleReview} onSubmit={submitExam} onDiscard={discardExam} />}
      {exam && screen === 'results' && <ResultsPage exam={exam} onConfirmCleanup={finishAndClear} />}
    </>
  );
}

function calculateResults(questions, settings) {
  const attempted = questions.filter(question => hasAnswer(question.selectedAnswer)).length;
  const unattempted = questions.length - attempted;
  const markedForReview = questions.filter(question => question.markedForReview).length;
  const keyed = questions.filter(question => question.correctAnswer !== undefined && question.correctAnswer !== null && question.correctAnswer !== '');
  let correct = 0;
  let wrong = 0;
  let score = 0;
  const marks = settings?.marking === 'custom'
    ? settings.customMarks || { correct: 1, wrong: 0 }
    : settings?.marking === 'simple'
      ? { correct: 1, wrong: 0 }
      : { correct: 2, wrong: -0.67 };

  questions.forEach(question => {
    if (!hasAnswer(question.selectedAnswer) || question.correctAnswer == null || question.correctAnswer === '') return;
    if (answersMatch(question.selectedAnswer, question.correctAnswer, question.type)) {
      correct += 1;
      score += Number(marks.correct) || 0;
    } else {
      wrong += 1;
      if (question.type === 'mcq') score += Number(marks.wrong) || 0;
    }
  });

  return {
    total: questions.length,
    attempted,
    unattempted,
    markedForReview,
    correct: keyed.length ? correct : null,
    wrong: keyed.length ? wrong : null,
    score: keyed.length ? Number(score.toFixed(2)) : null,
    keyedQuestions: keyed.length,
    marking: settings?.marking || 'gate',
  };
}

function hasAnswer(answer) {
  if (Array.isArray(answer)) return answer.length > 0;
  return answer !== null && answer !== undefined && String(answer).trim() !== '';
}

function answersMatch(selected, correct, type) {
  if (type === 'msq') {
    const normalize = value => (Array.isArray(value) ? value : String(value).split(/[,;\s]+/)).map(item => String(item).trim().toUpperCase()).filter(Boolean).sort();
    const left = normalize(selected);
    const right = normalize(correct);
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  if (type === 'nat') return Number.isFinite(Number(selected)) && Number.isFinite(Number(correct)) && Number(selected) === Number(correct);
  return String(selected).trim().toUpperCase() === String(correct).trim().toUpperCase();
}
