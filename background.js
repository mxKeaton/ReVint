const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const DB_NAME = "revint";
const DB_VERSION = 2;
const STORE = "relists";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (database.objectStoreNames.contains("handles")) database.deleteObjectStore("handles");
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: "name" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeGet(name) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(STORE, "readonly").objectStore(STORE).get(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

async function storeAll() {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(STORE, "readonly").objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

async function storePut(entry) {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(entry);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

async function storeDelete(name) {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).delete(name);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

async function resolveName(base, sourceUrl) {
  const stem = base.replace(/\.revint\.json$/i, "");
  for (let counter = 1; counter <= 100; counter++) {
    const candidate = counter === 1 ? base : `${stem}-${counter}.revint.json`;
    const existing = await storeGet(candidate);
    if (!existing) return candidate;
    if (sourceUrl && existing.sourceUrl === sourceUrl) return candidate;
  }
  return `${stem}-${Date.now()}.revint.json`;
}

const MIN_REQUEST_GAP = 200;
const MAX_FETCH_ATTEMPTS = 4;

let requestChain = Promise.resolve();
let lastRequestAt = 0;

function throttledFetch(url) {
  const result = requestChain.then(async () => {
    const gap = MIN_REQUEST_GAP - (Date.now() - lastRequestAt);
    if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
    lastRequestAt = Date.now();
    return fetch(url, { credentials: "include" });
  });
  requestChain = result.then(() => {}, () => {});
  return result;
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

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
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

  "open-tab": async ({ url, active }) => {
    const tab = await chrome.tabs.create({ url, active: active !== false });
    return { tabId: tab.id };
  },

  "list-files": async () => {
    const entries = await storeAll();
    const files = entries.map((entry) => ({ name: entry.name, lastModified: entry.createdAt || 0 }));
    files.sort((a, b) => b.lastModified - a.lastModified);
    return { files };
  },

  "read-file": async ({ name }) => {
    const entry = await storeGet(name);
    if (!entry) throw new Error("NOT_FOUND");
    return { name, text: JSON.stringify(entry.bundle) };
  },

  "save-file": async ({ filename, contents, sourceUrl }) => {
    const bundle = JSON.parse(contents);
    const name = await resolveName(filename, sourceUrl || bundle?.item?.sourceUrl);
    const entry = {
      name,
      sourceUrl: sourceUrl || bundle?.item?.sourceUrl || "",
      title: bundle?.item?.title || name,
      createdAt: Date.now(),
      bundle
    };
    await storePut(entry);
    return { filename: name };
  },

  "delete-files": async ({ names }) => {
    const deleted = [];
    const failed = [];
    for (const name of names || []) {
      try {
        await storeDelete(name);
        const existing = await storeGet(name);
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
