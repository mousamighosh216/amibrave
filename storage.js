(() => {
  "use strict";

  const DB_NAME = "amibrave";
  const DB_VERSION = 1;
  const ACTIVE_EXAM_ID = "active";
  let databasePromise;

  function openDatabase() {
    if (databasePromise) return databasePromise;

    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("exams")) {
          database.createObjectStore("exams", { keyPath: "id" });
        }
        if (!database.objectStoreNames.contains("images")) {
          database.createObjectStore("images", { keyPath: "id" });
        }
        if (!database.objectStoreNames.contains("metadata")) {
          database.createObjectStore("metadata", { keyPath: "key" });
        }
      };

      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => {
        databasePromise = null;
        reject(request.error || new Error("Could not open exam storage."));
      };
      request.onblocked = () => {
        databasePromise = null;
        reject(new Error("Exam storage is blocked by another open page."));
      };
    });

    return databasePromise;
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(
        transaction.error || new Error("Exam storage transaction failed.")
      );
      transaction.onabort = () => reject(
        transaction.error || new Error("Exam storage transaction was aborted.")
      );
    });
  }

  function imageRecord(image) {
    const questionNumber = image.question_number;
    const part = image.part ?? 0;
    const pageNumber = image.page_number ?? 0;
    return {
      id: `${questionNumber}:${part}:${pageNumber}`,
      questionNumber,
      part,
      pageNumber,
      width: image.width,
      height: image.height,
      format: image.format,
      mimeType: image.mime_type,
      blob: image.blob,
    };
  }

  async function replaceActiveExam(exam, images) {
    const database = await openDatabase();
    const transaction = database.transaction(["exams", "images"], "readwrite");
    const done = transactionDone(transaction);
    const examStore = transaction.objectStore("exams");
    const imageStore = transaction.objectStore("images");

    imageStore.clear();
    images.forEach(image => imageStore.put(imageRecord(image)));
    examStore.put({
      id: ACTIVE_EXAM_ID,
      ...exam,
      savedAt: Date.now(),
    });
    await done;
  }

  async function saveActiveExam(exam) {
    const database = await openDatabase();
    const transaction = database.transaction("exams", "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore("exams").put({
      id: ACTIVE_EXAM_ID,
      ...exam,
      savedAt: Date.now(),
    });
    await done;
  }

  async function getActiveExam() {
    const database = await openDatabase();
    const transaction = database.transaction(["exams", "images"], "readonly");
    const done = transactionDone(transaction);
    const examRequest = transaction.objectStore("exams").get(ACTIVE_EXAM_ID);
    const imagesRequest = transaction.objectStore("images").getAll();

    const examPromise = new Promise((resolve, reject) => {
      examRequest.onsuccess = () => resolve(examRequest.result || null);
      examRequest.onerror = () => reject(examRequest.error);
    });
    const imagesPromise = new Promise((resolve, reject) => {
      imagesRequest.onsuccess = () => resolve(imagesRequest.result || []);
      imagesRequest.onerror = () => reject(imagesRequest.error);
    });
    const [exam, images] = await Promise.all([
      examPromise,
      imagesPromise,
    ]);
    await done;

    if (!exam) return null;
    return {
      exam,
      images: images.map(image => ({
        question_number: image.questionNumber,
        part: image.part,
        page_number: image.pageNumber,
        width: image.width,
        height: image.height,
        format: image.format,
        mime_type: image.mimeType,
        blob: image.blob,
      })),
    };
  }

  async function completeActiveExam() {
    const database = await openDatabase();
    const transaction = database.transaction(
      ["exams", "images", "metadata"],
      "readwrite"
    );
    const done = transactionDone(transaction);
    const examStore = transaction.objectStore("exams");
    const metadataStore = transaction.objectStore("metadata");
    const activeRequest = examStore.get(ACTIVE_EXAM_ID);
    const countRequest = metadataStore.get("lifetimeExamCount");
    let lifetimeCount = null;
    let ready = 0;

    function finishIfReady() {
      ready++;
      if (ready !== 2) return;

      const activeExam = activeRequest.result;
      if (!activeExam) {
        transaction.abort();
        return;
      }

      lifetimeCount = (countRequest.result?.value || 0) + 1;
      metadataStore.put({ key: "lifetimeExamCount", value: lifetimeCount });
      examStore.delete(ACTIVE_EXAM_ID);
      transaction.objectStore("images").clear();
    }

    activeRequest.onsuccess = finishIfReady;
    countRequest.onsuccess = finishIfReady;
    activeRequest.onerror = () => transaction.abort();
    countRequest.onerror = () => transaction.abort();

    await done;
    if (lifetimeCount === null) {
      throw new Error("There is no active exam to submit.");
    }
    return lifetimeCount;
  }

  async function getLifetimeCount() {
    const database = await openDatabase();
    const transaction = database.transaction("metadata", "readonly");
    const done = transactionDone(transaction);
    const request = transaction.objectStore("metadata").get("lifetimeExamCount");
    const count = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result?.value || 0);
      request.onerror = () => reject(request.error);
    });
    await done;
    return count;
  }

  window.ExamStorage = {
    replaceActiveExam,
    saveActiveExam,
    getActiveExam,
    completeActiveExam,
    getLifetimeCount,
  };
})();