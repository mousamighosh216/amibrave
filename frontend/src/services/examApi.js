const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? 'http://127.0.0.1:5000' : 'https://amibrave.onrender.com')).replace(/\/$/, '');

/** Upload one PDF using XHR so the UI can display upload progress. */
export function uploadPdf(endpoint, file, onProgress, onUploadComplete) {
  const formData = new FormData();
  formData.append('file', file);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE_URL}${endpoint}`);
    xhr.timeout = 180000;

    xhr.upload.addEventListener('progress', event => {
      if (event.lengthComputable && onProgress) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.upload.addEventListener('load', () => onUploadComplete?.());

    xhr.addEventListener('load', () => {
      let response;
      try {
        response = JSON.parse(xhr.responseText);
      } catch {
        reject(new Error('The server returned an unreadable response.'));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(response?.error?.detail || response?.error?.message || `Request failed (${xhr.status}).`));
        return;
      }
      resolve(response);
    });

    xhr.addEventListener('error', () => reject(new Error('Could not connect to the Amibrave server. Check your connection and try again.')));
    xhr.addEventListener('timeout', () => reject(new Error('PDF processing timed out. Please try again with a smaller or simpler PDF.')));
    xhr.send(formData);
  });
}

export async function processExamFiles({ questionFile, answerKeyFile = null, onProgress }) {
  if (!questionFile) throw new Error('Choose a question paper PDF first.');
  onProgress?.({ message: 'Uploading question paper…', percent: 8 });

  const result = await uploadPdf('/api/exams/process', questionFile, percent => {
    onProgress?.({ message: 'Uploading question paper…', percent: 8 + Math.round(percent * 0.42) });
  }, () => onProgress?.({ message: 'PDF uploaded. Extracting questions on the server…', percent: 50 }));

  if (!result?.success) {
    throw new Error(result?.error?.detail || result?.error?.message || 'Question extraction failed.');
  }
  if (!Array.isArray(result.questions)) {
    throw new Error('The server response is missing the questions array.');
  }

  const questions = result.questions.map(question => ({
    ...question,
    options: Array.isArray(question.options) ? question.options : [],
    selectedAnswer: null,
    markedForReview: false,
  }));
  const warnings = [...(result.warnings || [])];

  onProgress?.({ message: 'Preparing extracted questions and source images…', percent: 68 });

  if (answerKeyFile) {
    onProgress?.({ message: 'Processing answer key…', percent: 76 });
    try {
      const answerResult = await uploadPdf('/extract-key', answerKeyFile, percent => onProgress?.({ message: 'Uploading answer key…', percent: 76 + Math.round(percent * 0.06) }), () => onProgress?.({ message: 'Answer key uploaded. Reading answer key…', percent: 82 }));
      if (answerResult?.success) {
        applyAnswerKey(questions, answerResult.answer_key || {});
        warnings.push(...(answerResult.warnings || []));
      } else {
        warnings.push({
          message: 'Answer key could not be processed',
          detail: answerResult?.error?.detail || answerResult?.error?.message || 'The question paper was processed without an answer key.',
        });
      }
    } catch (error) {
      warnings.push({ message: 'Answer key could not be processed', detail: `${error.message} The question paper was processed without an answer key.` });
    }
  }

  const images = (result.images || []).map(normalizeImage);
  onProgress?.({ message: 'Building question preview…', percent: 100 });
  return { questions, images, warnings, meta: result.meta || {} };
}

function applyAnswerKey(questions, answerKey) {
  questions.forEach(question => {
    const answer = answerKey[question.num] ?? answerKey[String(question.num)];
    if (answer !== undefined && answer !== null && answer !== '') question.correctAnswer = answer;
  });
}

export function normalizeImage(image) {
  const metadata = { ...(image || {}) };
  const data = metadata.data;
  delete metadata.data;
  delete metadata.src;
  if (!data) {
    const blob = metadata.blob || null;
    return { ...metadata, blob, src: blob ? URL.createObjectURL(blob) : '' };
  }
  const binary = window.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const blob = new Blob([bytes], { type: metadata.mime_type || 'image/png' });
  return { ...metadata, blob, src: URL.createObjectURL(blob) };
}

export function restoreImageUrls(images = []) {
  return images.map(image => ({ ...image, src: image.blob ? URL.createObjectURL(image.blob) : '' }));
}

export function revokeImageUrls(images = []) {
  images.forEach(image => {
    if (image.src) URL.revokeObjectURL(image.src);
  });
}
