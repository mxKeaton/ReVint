const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const DB_NAME = "revint";
const DB_VERSION = 3;
const STORE = "relists";
const META_STORE = "meta";

let databasePromise = null;

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        const transaction = request.transaction;
        if (database.objectStoreNames.contains("handles")) database.deleteObjectStore("handles");
        if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: "name" });
        if (!database.objectStoreNames.contains(META_STORE)) {
          const meta = database.createObjectStore(META_STORE, { keyPath: "name" });
          if (database.objectStoreNames.contains(STORE)) {
            transaction.objectStore(STORE).openCursor().onsuccess = (event) => {
              const cursor = event.target.result;
              if (!cursor) return;
              const entry = cursor.value || {};
              if (entry.name) {
                meta.put({
                  name: entry.name,
                  sourceUrl: entry.sourceUrl || "",
                  title: entry.title || entry.name,
                  createdAt: entry.createdAt || Date.now()
                });
              }
              cursor.continue();
            };
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { databasePromise = null; reject(request.error); };
    });
  }
  return databasePromise;
}

function storeRequest(store, mode, run) {
  return openDatabase().then((database) => new Promise((resolve, reject) => {
    const request = run(database.transaction(store, mode).objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

function metaGet(name) { return storeRequest(META_STORE, "readonly", (store) => store.get(name)); }
function metaAll() { return storeRequest(META_STORE, "readonly", (store) => store.getAll()); }
function bundleGet(name) { return storeRequest(STORE, "readonly", (store) => store.get(name)); }

async function saveEntry(entry) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE, META_STORE], "readwrite");
    transaction.objectStore(STORE).put({ name: entry.name, bundle: entry.bundle });
    transaction.objectStore(META_STORE).put({
      name: entry.name,
      sourceUrl: entry.sourceUrl,
      title: entry.title,
      createdAt: entry.createdAt
    });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function deleteEntry(name) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE, META_STORE], "readwrite");
    transaction.objectStore(STORE).delete(name);
    transaction.objectStore(META_STORE).delete(name);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function resolveName(base, sourceUrl) {
  const stem = base.replace(/\.revint\.json$/i, "");
  for (let counter = 1; counter <= 100; counter++) {
    const candidate = counter === 1 ? base : `${stem}-${counter}.revint.json`;
    const existing = await metaGet(candidate);
    if (!existing) return candidate;
    if (sourceUrl && existing.sourceUrl === sourceUrl) return candidate;
  }
  return `${stem}-${Date.now()}.revint.json`;
}

const MIN_REQUEST_GAP = 120;
const MAX_CONCURRENT_REQUESTS = 4;
const MAX_FETCH_ATTEMPTS = 4;

let activeRequests = 0;
let lastRequestAt = 0;
const requestQueue = [];

function pumpRequests() {
  if (activeRequests >= MAX_CONCURRENT_REQUESTS || !requestQueue.length) return;
  const gap = MIN_REQUEST_GAP - (Date.now() - lastRequestAt);
  if (gap > 0) {
    setTimeout(pumpRequests, gap);
    return;
  }
  const job = requestQueue.shift();
  activeRequests++;
  lastRequestAt = Date.now();
  Promise.resolve()
    .then(job.run)
    .then(job.resolve, job.reject)
    .finally(() => {
      activeRequests--;
      pumpRequests();
    });
}

function scheduleRequest(run) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ run, resolve, reject });
    pumpRequests();
  });
}

function throttledFetch(url) {
  return scheduleRequest(() => fetch(url, { credentials: "include" }));
}

function retryDelay(attempt, response) {
  const header = Number(response?.headers?.get?.("retry-after"));
  const delay = Number.isFinite(header) && header > 0 ? header * 1000 : 700 * attempt;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function fetchWithCredentials(url, attempt = 1) {
  let response;
  try {
    response = await throttledFetch(url);
  } catch (error) {
    if (attempt < MAX_FETCH_ATTEMPTS) {
      await retryDelay(attempt);
      return fetchWithCredentials(url, attempt + 1);
    }
    throw error;
  }
  if ((response.status === 429 || response.status >= 500) && attempt < MAX_FETCH_ATTEMPTS) {
    await retryDelay(attempt, response);
    return fetchWithCredentials(url, attempt + 1);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

const latin1Decoder = new TextDecoder("latin1");

function toBase64(bytes) {
  return btoa(latin1Decoder.decode(bytes));
}

const handlers = {
  "fetch-text": async ({ url }) => {
    const response = await fetchWithCredentials(url);
    return { text: await response.text(), url: response.url };
  },

  "fetch-image": async ({ url }) => {
    const response = await fetchWithCredentials(url);
    const blob = await response.blob();
    if (blob.size > MAX_IMAGE_BYTES) throw new Error("Bild ist größer als 15 MB");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { image: { data: toBase64(bytes), type: blob.type || "image/jpeg" } };
  },

  "list-files": async () => {
    const entries = await metaAll();
    const files = entries.map((entry) => ({ name: entry.name, lastModified: entry.createdAt || 0 }));
    files.sort((a, b) => b.lastModified - a.lastModified);
    return { files };
  },

  "read-file": async ({ name }) => {
    const entry = await bundleGet(name);
    if (!entry) throw new Error("NOT_FOUND");
    return { name, bundle: entry.bundle };
  },

  "save-file": async ({ filename, bundle, sourceUrl }) => {
    if (!bundle) throw new Error("INVALID_BUNDLE");
    const name = await resolveName(filename, sourceUrl || bundle?.item?.sourceUrl);
    await saveEntry({
      name,
      sourceUrl: sourceUrl || bundle?.item?.sourceUrl || "",
      title: bundle?.item?.title || name,
      createdAt: Date.now(),
      bundle
    });
    return { filename: name };
  },

  "delete-files": async ({ names }) => {
    const deleted = [];
    const failed = [];
    for (const name of names || []) {
      try {
        await deleteEntry(name);
        const existing = await metaGet(name);
        if (existing) failed.push({ name, error: "noch vorhanden" });
        else deleted.push(name);
      } catch (error) {
        failed.push({ name, error: error.message });
      }
    }
    return { deleted, failed };
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return;
  Promise.resolve(handler(message))
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
