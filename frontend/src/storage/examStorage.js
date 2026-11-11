const DB_NAME = 'amibrave-local';
const DB_VERSION = 1;
const EXAM_STORE = 'exams';
const META_STORE = 'meta';
const ACTIVE_EXAM_KEY = 'active';
const SOLVED_COUNT_KEY = 'solved-paper-count';

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('This browser does not support local exam storage. Please use a modern browser.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(EXAM_STORE)) {
        database.createObjectStore(EXAM_STORE, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local exam storage.'));
  });
}

async function withStore(storeName, mode, operation) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let result;
    try {
      result = operation(store);
    } catch (error) {
      database.close();
      reject(error);
      return;
    }
    transaction.oncomplete = () => {
      database.close();
      resolve(result?.result);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error('Local storage operation failed.'));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error || new Error('Local storage operation was cancelled.'));
    };
  });
}

export function saveActiveExam(exam) {
  return withStore(EXAM_STORE, 'readwrite', store => store.put({ ...exam, id: ACTIVE_EXAM_KEY, updatedAt: Date.now() }));
}

export async function loadActiveExam() {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(EXAM_STORE, 'readonly');
    const request = transaction.objectStore(EXAM_STORE).get(ACTIVE_EXAM_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('Could not restore the saved exam.'));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
  });
}

export function clearActiveExam() {
  return withStore(EXAM_STORE, 'readwrite', store => store.delete(ACTIVE_EXAM_KEY));
}

export async function getSolvedPaperCount() {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(META_STORE, 'readonly');
    const request = transaction.objectStore(META_STORE).get(SOLVED_COUNT_KEY);
    request.onsuccess = () => resolve(Number(request.result?.value || 0));
    request.onerror = () => reject(request.error || new Error('Could not read exam count.'));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error('Could not read exam count.'));
    };
  });
}

export async function submitActiveExam(exam) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([EXAM_STORE, META_STORE], 'readwrite');
    const examStore = transaction.objectStore(EXAM_STORE);
    const metaStore = transaction.objectStore(META_STORE);
    const countRequest = metaStore.get(SOLVED_COUNT_KEY);
    let nextCount = 0;
    countRequest.onsuccess = () => {
      nextCount = Number(countRequest.result?.value || 0);
      if (!exam.counted) {
        nextCount += 1;
        metaStore.put({ key: SOLVED_COUNT_KEY, value: nextCount });
      }
      examStore.put({ ...exam, id: ACTIVE_EXAM_KEY, counted: true, updatedAt: Date.now() });
    };
    transaction.oncomplete = () => {
      database.close();
      resolve(nextCount);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error('Could not save the submitted exam.'));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error || new Error('Exam submission was cancelled.'));
    };
  });
}

export async function clearAllAppData() {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([EXAM_STORE, META_STORE], 'readwrite');
    transaction.objectStore(EXAM_STORE).clear();
    transaction.objectStore(META_STORE).clear();
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error('Could not clear app data.'));
    };
  });
}
