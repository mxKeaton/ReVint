const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const DB_NAME = "revint";
const DB_VERSION = 2;
const STORE = "relists";
const PENDING_BUNDLE = "__revint_pending__.json";

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

function throttledFetch(url, options) {
  const result = requestChain.then(async () => {
    const gap = MIN_REQUEST_GAP - (Date.now() - lastRequestAt);
    if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
    lastRequestAt = Date.now();
    return fetch(url, { credentials: "include", ...options });
  });
  requestChain = result.then(() => {}, () => {});
  return result;
}

function retryDelay(attempt, response) {
  const header = Number(response?.headers?.get?.("retry-after"));
  const delay = Number.isFinite(header) && header > 0 ? header * 1000 : 700 * attempt;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function fetchWithCredentials(url, attempt = 1, options) {
  let response;
  try {
    response = await throttledFetch(url, options);
  } catch (error) {
    if (attempt < MAX_FETCH_ATTEMPTS) {
      await retryDelay(attempt);
      return fetchWithCredentials(url, attempt + 1, options);
    }
    throw error;
  }
  if ((response.status === 429 || response.status >= 500) && attempt < MAX_FETCH_ATTEMPTS) {
    await retryDelay(attempt, response);
    return fetchWithCredentials(url, attempt + 1, options);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

const IMAGE_CONCURRENCY = 4;
let activeImages = 0;
const imageWaiters = [];

function withImageSlot(task) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeImages++;
      const release = () => {
        activeImages--;
        const next = imageWaiters.shift();
        if (next) next();
      };
      task().then(
        (value) => { release(); resolve(value); },
        (error) => { release(); reject(error); }
      );
    };
    if (activeImages < IMAGE_CONCURRENCY) run();
    else imageWaiters.push(run);
  });
}

async function fetchImage(url, attempt = 1) {
  let response;
  try {
    response = await fetch(url, { credentials: "include" });
  } catch (error) {
    if (attempt < MAX_FETCH_ATTEMPTS) {
      await retryDelay(attempt);
      return fetchImage(url, attempt + 1);
    }
    throw error;
  }
  if ((response.status === 429 || response.status >= 500) && attempt < MAX_FETCH_ATTEMPTS) {
    await retryDelay(attempt, response);
    return fetchImage(url, attempt + 1);
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
    const response = await withImageSlot(() => fetchImage(url));
    const blob = await response.blob();
    if (blob.size > MAX_IMAGE_BYTES) throw new Error("Image is larger than 15 MB");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { image: { data: toBase64(bytes), type: blob.type || "image/jpeg" } };
  },

  "delete-item": async ({ url, csrfToken }) => {
    const response = await fetchWithCredentials(url, 1, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Platform": "web",
        "X-CSRF-Token": csrfToken,
        "X-Next-App": "marketplace-web"
      }
    });
    return { status: response.status };
  },

  "open-tab": async ({ url, active }) => {
    const tab = await chrome.tabs.create({ url, active: active !== false });
    return { tabId: tab.id };
  },

  "list-files": async () => {
    const entries = await storeAll();
    const files = entries
      .filter((entry) => entry.name !== PENDING_BUNDLE)
      .map((entry) => ({ name: entry.name, lastModified: entry.createdAt || 0 }));
    files.sort((a, b) => b.lastModified - a.lastModified);
    return { files };
  },

  "stash-bundle": async ({ bundle }) => {
    await storePut({
      name: PENDING_BUNDLE,
      createdAt: Date.now(),
      sourceUrl: bundle?.item?.sourceUrl || "",
      title: bundle?.item?.title || PENDING_BUNDLE,
      bundle
    });
    return {};
  },

  "take-bundle": async () => {
    const entry = await storeGet(PENDING_BUNDLE);
    if (entry) await storeDelete(PENDING_BUNDLE);
    return { bundle: entry?.bundle || null };
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

  // Vinted's custom widgets ignore synthetic events for their submitted form
  // model, so fields like price/brand/colour/isbn reach the server empty. Let
  // the UI fill what it accepts and patch the outgoing upload request in the
  // page, injecting only the values it dropped just before it is sent.
  "install-upload-patch": async ({ values }, sender) => {
    const tabId = sender?.tab?.id;
    if (tabId == null) return { ok: false, error: "no-tab" };
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [values || {}],
      func: (patch) => {
        window.__revintPatch = patch || {};
        if (window.__revintPatchInstalled) return { installed: true, updated: true };
        window.__revintPatchInstalled = true;

        const applyPatch = (payload) => {
          const valuesNow = window.__revintPatch;
          if (!valuesNow || !payload || typeof payload !== "object") return false;
          const item = payload.item && typeof payload.item === "object" ? payload.item : payload;
          if (!item || typeof item !== "object") return false;
          if (!("price" in item) && !("brand_id" in item) && !("assigned_photos" in item)) return false;
          let changed = false;
          if (valuesNow.price != null && (item.price == null || item.price === "" || item.price === 0)) {
            item.price = valuesNow.price;
            changed = true;
          }
          if (valuesNow.brandId != null && item.brand_id == null) {
            item.brand_id = valuesNow.brandId;
            changed = true;
          }
          if (Array.isArray(valuesNow.colorIds) && valuesNow.colorIds.length && (!item.color_ids || !item.color_ids.length)) {
            item.color_ids = valuesNow.colorIds;
            changed = true;
          }
          if (valuesNow.isbn && !item.isbn) {
            item.isbn = valuesNow.isbn;
            changed = true;
          }
          return changed;
        };

        const looksLikeUpload = (url, body) =>
          /item_upload|upload_session|assigned_photos/i.test(`${url} ${body || ""}`);

        const originalFetch = window.fetch;
        window.fetch = function (input, init) {
          try {
            const url = typeof input === "string" ? input : (input && input.url) || "";
            const method = (init && init.method) || (input && input.method) || "GET";
            if (/POST/i.test(method) && init && typeof init.body === "string" && looksLikeUpload(url, init.body)) {
              const json = JSON.parse(init.body);
              if (applyPatch(json)) init = { ...init, body: JSON.stringify(json) };
            }
          } catch (_) {}
          return arguments.length > 1 ? originalFetch.call(this, input, init) : originalFetch.call(this, input);
        };

        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
          this.__revintMethod = method;
          this.__revintUrl = url;
          return originalOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function (body) {
          try {
            if (/POST/i.test(this.__revintMethod || "") && typeof body === "string" && looksLikeUpload(this.__revintUrl, body)) {
              const json = JSON.parse(body);
              if (applyPatch(json)) body = JSON.stringify(json);
            }
          } catch (_) {}
          return originalSend.call(this, body);
        };
        return { installed: true };
      }
    });
    return { result: results?.[0]?.result ?? null };
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return;
  Promise.resolve(handler(message, sender))
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
