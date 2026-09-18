(() => {
  "use strict";

  const FORMAT = "revint";
  const VERSION = 1;
  const PAGE_SIZE = 20;
  const OPEN_DELAY = 6000;
  const BATCH_DELAY = 1200;

  let revintBusy = false;
  window.addEventListener("beforeunload", (event) => {
    if (!revintBusy) return;
    event.preventDefault();
    event.returnValue = "";
  });
  const ITEM_LINK = 'a[href*="/items/"]';
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const cleanMultiline = (value) => String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const norm = (value) => clean(value).toLocaleLowerCase("de-DE");

  const TLD_LANGUAGE = {
    com: "en", uk: "en", ie: "en", de: "de", at: "de",
    fr: "fr", lu: "fr", be: "nl", nl: "nl", es: "es", it: "it",
    pl: "pl", lt: "lt", lv: "lv", ee: "et", cz: "cs", sk: "sk",
    hu: "hu", ro: "ro", se: "sv", dk: "da", fi: "fi",
    pt: "pt", gr: "el", hr: "hr", bg: "bg", si: "sl"
  };

  let MESSAGES = {};
  let messagesReady = false;

  function languageFromHostname(hostname) {
    const host = String(hostname || "").replace(/^www\./, "");
    if (host.endsWith("vinted.co.uk")) return "en";
    return TLD_LANGUAGE[host.split(".").pop()] || "en";
  }

  async function detectLanguage() {
    return languageFromHostname(location.hostname) || (navigator.language || "en").slice(0, 2).toLowerCase();
  }

  async function fetchMessages(code) {
    const response = await fetch(chrome.runtime.getURL(`lang/${code}.json`));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function loadMessages() {
    let english = {};
    try { english = await fetchMessages("en"); } catch (_) {}
    const code = await detectLanguage();
    let chosen = english;
    if (code && code !== "en") {
      try { chosen = await fetchMessages(code); } catch (_) { chosen = english; }
    }
    MESSAGES = { ...english, ...chosen };
    messagesReady = true;
  }

  function t(key, params) {
    let text = MESSAGES[key] || key;
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        text = text.replace(new RegExp(`\\{${name}\\}`, "g"), String(value));
      }
    }
    return text;
  }

  function message(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : response);
        });
      } catch (error) {
        resolve({ ok: false, error: error.message });
      }
    });
  }

  function allJson(root) {
    const values = [];
    for (const script of root.querySelectorAll('script[type="application/json"], script[type="application/ld+json"], script[id*="state" i], script[id*="data" i]')) {
      try { values.push(JSON.parse(script.textContent)); } catch (_) { /* non-JSON script */ }
    }
    return values;
  }

  function deepFind(value, keys, seen = new WeakSet()) {
    if (!value || typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (keys.includes(key) && (typeof child === "string" || typeof child === "number")) return child;
    }
    for (const child of Object.values(value)) {
      const found = deepFind(child, keys, seen);
      if (found !== undefined) return found;
    }
  }

  function deepCollectUrls(value, out = new Set(), seen = new WeakSet()) {
    if (!value || typeof value !== "object" || seen.has(value)) return out;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && /^https:\/\//.test(child) && /(photo|image|url)/i.test(key) && (/vinted\.net/i.test(child) || /\.(jpe?g|png|webp)(\?|$)/i.test(child))) out.add(child);
      else if (child && typeof child === "object") deepCollectUrls(child, out, seen);
    }
    return out;
  }

  function findItemObject(value, itemId, seen = new WeakSet(), candidates = []) {
    if (!value || typeof value !== "object" || seen.has(value)) return candidates;
    seen.add(value);
    if (!Array.isArray(value)) {
      let score = 0;
      if (String(value.id) === itemId) score += 20;
      if (typeof value.title === "string") score += 3;
      if (typeof value.description === "string") score += 3;
      if (Array.isArray(value.photos)) score += 8;
      if (value.catalog || value.category) score += 2;
      if (value.status || value.condition) score += 2;
      if (value.price || value.price_numeric) score += 2;
      if (score >= 8) candidates.push({ value, score });
    }
    Object.values(value).forEach((child) => findItemObject(child, itemId, seen, candidates));
    return candidates;
  }

  function displayValue(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "string" || typeof value === "number") return clean(value);
    return clean(value.title || value.name || value.label || value.value || "");
  }

  function listValues(value) {
    const list = Array.isArray(value) ? value : value ? [value] : [];
    return list.map(displayValue).filter(Boolean);
  }

  function photoUrl(photo) {
    if (typeof photo === "string") return photo;
    if (!photo || typeof photo !== "object") return "";
    const preferred = ["url_full_size", "full_size_url", "url_high_resolution", "original_url", "url"];
    for (const key of preferred) if (typeof photo[key] === "string") return photo[key];
    const urls = [...deepCollectUrls(photo)];
    return urls.sort((a, b) => {
      const score = (url) => /full|original|large|f800|f1600/i.test(url) ? 1 : 0;
      return score(b) - score(a);
    })[0] || "";
  }

  function largestImageFromElement(image) {
    const srcset = image.getAttribute("srcset") || image.getAttribute("data-srcset") || "";
    const candidates = srcset.split(",").map((entry) => {
      const match = entry.trim().match(/^(\S+)(?:\s+(\d+)(?:w|x))?$/);
      return match ? { url: match[1], size: Number(match[2] || 0) } : null;
    }).filter(Boolean).sort((a, b) => b.size - a.size);
    return candidates[0]?.url || image.getAttribute("data-src") || image.getAttribute("data-original") || image.getAttribute("src") || "";
  }

  function labeledValues(doc) {
    const result = {};
    const labels = {
      brand: ["marke", "brand"], size: ["größe", "size"], condition: ["zustand", "condition"],
      color: ["farbe", "color"], category: ["kategorie", "category"], material: ["material"],
      parcelSize: ["paketgröße", "parcel size"], isbn: ["isbn"]
    };
    const nodes = [...doc.querySelectorAll("dt, th, [data-testid*='details'], [class*='details']")];
    for (const node of nodes) {
      const text = norm(node.textContent);
      for (const [field, candidates] of Object.entries(labels)) {
        if (result[field] || !candidates.some((label) => text === label || text.startsWith(`${label}:`))) continue;
        const sibling = node.nextElementSibling;
        const ownValue = text.includes(":") ? clean(node.textContent).split(":").slice(1).join(":") : "";
        result[field] = clean(ownValue || sibling?.textContent);
      }
    }
    return result;
  }

  function categoryPathFromDoc(doc) {
    const links = [...doc.querySelectorAll('a[href*="/catalog/"]')].filter((link) => /referrer=item-crumbs/.test(link.getAttribute("href") || ""));
    const seen = new Set();
    const path = [];
    for (const link of links) {
      const match = (link.getAttribute("href") || "").match(/\/catalog\/(\d+)/);
      const title = clean(link.textContent);
      if (!match || !title || /\/brand\//.test(link.getAttribute("href") || "") || seen.has(match[1])) continue;
      seen.add(match[1]);
      path.push({ id: Number(match[1]), title });
    }
    return path;
  }

  function platformsFromDoc(doc) {
    const links = doc.querySelectorAll("[data-testid='item-attributes-video_game_platform'] a, [itemprop='video_game_platform'] a");
    const platforms = [];
    for (const link of links) {
      const title = clean(link.textContent);
      if (!title) continue;
      const match = decodeURIComponent(link.getAttribute("href") || "").match(/video_game_platform_ids\[\]=(\d+)/);
      platforms.push({ id: match ? Number(match[1]) : null, title });
    }
    if (platforms.length) return platforms;
    const value = doc.querySelector("[itemprop='video_game_platform']");
    const title = clean(value?.textContent);
    return title ? [{ id: null, title }] : [];
  }

  function parseItemPage(html, sourceUrl, card) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const json = allJson(doc);
    const product = json.find((entry) => entry?.["@type"] === "Product") || json.find((entry) => Array.isArray(entry?.["@graph"]))?.["@graph"]?.find((x) => x?.["@type"] === "Product") || {};
    const state = json.length === 1 ? json[0] : json;
    const itemId = sourceUrl.match(/\/items\/(\d+)/)?.[1] || "";
    const candidates = findItemObject(state, itemId).sort((a, b) => b.score - a.score);
    const hydratedItem = candidates[0]?.value || {};
    const meta = (name) => doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content || "";
    const details = labeledValues(doc);
    const title = clean(hydratedItem.title || product.name || meta("og:title") || card.title);
    const description = cleanMultiline(hydratedItem.description || product.description || meta("og:description") || "");
    const itemPrice = hydratedItem.price_numeric || hydratedItem.price?.amount || hydratedItem.price;
    const priceRaw = itemPrice || product.offers?.price || card.price;
    const imageUrls = new Set();
    const productImages = Array.isArray(product.image) ? product.image : [product.image];
    // Only the item's own photo array is allowed here. Walking the complete
    // item object also reaches the owner's avatar and recommendation images.
    const itemPhotos = Array.isArray(hydratedItem.photos) ? hydratedItem.photos : [];
    itemPhotos.map(photoUrl).filter(Boolean).forEach((url) => imageUrls.add(url));
    // Vinted also server-renders the complete gallery in this dedicated box,
    // even when its hydrated item state only exposes the cover photo.
    const galleryUrls = new Set();
    doc.querySelectorAll('[class*="item-photos"] img, [class*="item-photo-box"] img').forEach((image) => {
      const url = largestImageFromElement(image);
      if (url) galleryUrls.add(new URL(url, sourceUrl).href);
    });
    if (galleryUrls.size) {
      imageUrls.clear();
      galleryUrls.forEach((url) => imageUrls.add(url));
    }
    if (!imageUrls.size) {
      productImages.filter(Boolean).forEach((image) => {
        const url = typeof image === "string" ? image : image.url || image.contentUrl;
        if (url) imageUrls.add(url);
      });
      const socialImage = meta("og:image");
      if (socialImage) imageUrls.add(socialImage);
    }
    const sizeValue = clean(doc.querySelector("[data-testid='item-attributes-size'] [itemprop='size'], [itemprop='size']")?.textContent);
    const ageRating = clean(doc.querySelector("[data-testid='item-attributes-video_game_rating'] [itemprop='video_game_rating'], [itemprop='video_game_rating']")?.textContent);
    const isbnValue = clean(doc.querySelector("[data-testid='item-attributes-isbn_nav-link'], [itemprop='isbn_nav']")?.textContent);
    const brandRow = doc.querySelector("[data-testid='item-attributes-brand-menu-button']")?.closest(".details-list__item");
    const brandValue = clean(brandRow?.querySelector("a[href*='/brand/'] [itemprop='name'], a[href*='/brand/']")?.textContent)
      || clean(doc.querySelector("a[href*='/brand/'] [itemprop='name']")?.textContent);
    const conditionValue = clean(doc.querySelector("[data-testid='item-attributes-status'] [itemprop='status'], [itemprop='status']")?.textContent);
    const colorValue = clean(doc.querySelector("[data-testid='item-attributes-color'] [itemprop='color'], [itemprop='color']")?.textContent);
    const materialValue = clean(doc.querySelector("[data-testid='item-attributes-material'] [itemprop='material'], [itemprop='material']")?.textContent);
    const linkText = (part) => clean(doc.querySelector(`a[href*="${part}"]`)?.textContent);
    const category = hydratedItem.catalog || hydratedItem.category || linkText("/catalog/");
    const brand = hydratedItem.brand || linkText("/brand/");
    const size = hydratedItem.size || linkText("size_id") || linkText("size_ids");
    const condition = hydratedItem.status || hydratedItem.condition || linkText("status_id") || linkText("status_ids");
    const colors = hydratedItem.colors || hydratedItem.color;
    const materials = hydratedItem.materials || hydratedItem.material;
    const parcelSize = hydratedItem.package_size || hydratedItem.parcel_size;
    let categoryPath = categoryPathFromDoc(doc);
    if (!categoryPath.length) {
      const leafTitle = details.category || displayValue(category) || clean(deepFind(hydratedItem, ["catalog_title", "category_title"]));
      const leafId = hydratedItem.catalog_id ?? hydratedItem.catalog?.id ?? deepFind(hydratedItem, ["catalog_id"]);
      if (leafTitle) categoryPath = [{ id: leafId ? Number(leafId) : null, title: leafTitle }];
    }
    return {
      sourceUrl, title, description, price: clean(priceRaw).replace(/[^\d,.]/g, ""),
      currency: clean(product.offers?.priceCurrency || "EUR"),
      category: categoryPath.at(-1)?.title || details.category || displayValue(category) || clean(deepFind(hydratedItem, ["catalog_title", "category_title"])),
      categoryPath,
      platforms: platformsFromDoc(doc),
      brand: brandValue || details.brand || displayValue(brand) || clean(product.brand?.name || product.brand || deepFind(hydratedItem, ["brand_title"])),
      size: sizeValue || details.size || displayValue(size) || clean(deepFind(hydratedItem, ["size_title"])),
      ageRating,
      condition: conditionValue || details.condition || displayValue(condition) || clean(deepFind(hydratedItem, ["status_title", "condition_title"])),
      colors: colorValue ? [colorValue] : details.color ? details.color.split(/,|\//).map(clean).filter(Boolean) : listValues(colors),
      material: materialValue || details.material || listValues(materials).join(", ") || clean(deepFind(hydratedItem, ["material_title"])),
      parcelSize: details.parcelSize || displayValue(parcelSize) || clean(deepFind(hydratedItem, ["package_size_title"])),
      isbn: isbnValue || details.isbn || "",
      tags: [],
      imageUrls: [...imageUrls].filter((url) => !/avatar|profile|icon|logo/i.test(url)).slice(0, 20)
    };
  }

  async function embedImages(urls, status) {
    const images = [];
    for (let i = 0; i < urls.length; i++) {
      status(`Bild ${i + 1}/${urls.length} wird lokal gespeichert …`);
      const response = await message({ type: "fetch-image", url: urls[i] });
      if (response?.ok) images.push({ name: `image-${i + 1}.${extension(response.image.type)}`, ...response.image });
      else console.error(`[ReVint] Bild ${i + 1} konnte nicht gespeichert werden:`, response?.error || "Unbekannter Fehler", urls[i]);
    }
    if (!urls.length) console.error("[ReVint] Keine Bild-URLs in der Relisting-Seite gefunden.");
    return images;
  }

  function extension(type) {
    return ({ "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg" })[type] || "jpg";
  }

  function isItemLink(link) {
    try { return /^\/items\/\d+(?:-|\/|$)/.test(new URL(link.href, location.href).pathname); }
    catch (_) { return false; }
  }

  function nearestItemLink(button) {
    try {
      const buttonRect = button.getBoundingClientRect?.();
      if (!buttonRect) return null;
      let best = null;
      let bestDistance = Infinity;
      for (const candidate of [...document.querySelectorAll(ITEM_LINK)].filter(isItemLink)) {
        const rect = candidate.getBoundingClientRect?.();
        if (!rect) continue;
        const vertical = rect.bottom <= buttonRect.top
          ? buttonRect.top - rect.bottom
          : Math.abs((rect.top + rect.bottom) / 2 - (buttonRect.top + buttonRect.bottom) / 2) + 1000;
        const horizontal = Math.abs((rect.left + rect.right) / 2 - (buttonRect.left + buttonRect.right) / 2);
        const distance = vertical + horizontal * 0.25;
        if (distance < bestDistance) { bestDistance = distance; best = candidate; }
      }
      return best;
    } catch (error) {
      console.warn("[ReVint] Kartenfindung (Fallback) fehlgeschlagen:", error);
      return null;
    }
  }

  function findCardAndLink(button) {
    if (!button) return { card: null, link: null };
    const cardByTestId = button.closest?.('[data-testid^="product-item-id-"]');
    if (cardByTestId) {
      const link = [...cardByTestId.querySelectorAll(ITEM_LINK)].find(isItemLink);
      if (link) return { card: cardByTestId, link };
    }

    // Vinted uses generated class names containing "item" on small inner
    // controls. Walk upwards until a real listing URL proves this is the card.
    let ancestor = button.parentElement;
    for (let depth = 0; ancestor && depth < 14; depth++, ancestor = ancestor.parentElement) {
      const links = [...ancestor.querySelectorAll(ITEM_LINK)].filter(isItemLink);
      const itemUrls = new Set(links.map((link) => new URL(link.href, location.href).pathname));
      if (itemUrls.size === 1) return { card: ancestor, link: links[0] };
      // A larger grid contains many listings; do not accidentally export a neighbour.
      if (itemUrls.size > 1) break;
    }

    // Some Vinted layouts render the image link and action area as siblings.
    // Pick the closest listing link vertically, preferring one above the button.
    const link = nearestItemLink(button);
    const card = link?.closest?.("article, li") || link?.parentElement || button.parentElement || null;
    return { card, link };
  }

  function describeCard(card, link) {
    const image = card?.querySelector("img");
    const text = clean(card?.innerText);
    return {
      url: link ? new URL(link.href, location.href).href : "",
      title: clean(image?.alt || link?.getAttribute("title")),
      price: text.match(/\d+[,.]\d{2}\s*€/i)?.[0] || "",
      stateText: text
    };
  }

  function cardData(button) {
    const { card, link } = findCardAndLink(button);
    return describeCard(card, link);
  }

  function cardDataFromLink(link) {
    let card = link.parentElement;
    for (let depth = 0; card && depth < 10; depth++, card = card.parentElement) {
      const urls = new Set([...card.querySelectorAll(ITEM_LINK)].filter(isItemLink).map((itemLink) => new URL(itemLink.href, location.href).pathname));
      if (urls.size === 1 && /€|verkauft|sold|verborgen|versteckt|hidden/i.test(card.innerText || "")) break;
      if (urls.size > 1) { card = card.parentElement; break; }
    }
    return describeCard(card || link.parentElement, link);
  }

  async function exportCard(card, setStatus) {
    if (!card.url) throw new Error("Relisting-Link wurde nicht gefunden");
    setStatus("Daten werden gelesen …");
    const page = await message({ type: "fetch-text", url: card.url });
    if (!page?.ok) throw new Error(page?.error || "Relisting-Seite konnte nicht gelesen werden");
    const item = parseItemPage(page.text, page.url || card.url, card);
    console.info("[ReVint] Erkannte Relisting-Daten:", item);
    item.images = await embedImages(item.imageUrls, setStatus);
    delete item.imageUrls;
    const bundle = { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), item };
    const safeTitle = (item.title || "artikel").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80);
    const filename = `${safeTitle}.revint.json`;
    const contents = JSON.stringify(bundle);

    const saved = await message({ type: "save-file", filename, contents, sourceUrl: item.sourceUrl || card.url });
    if (!saved?.ok) throw new Error(saved?.error || "Speichern fehlgeschlagen");
  }

  async function exportItem(button) {
    const original = button.textContent;
    const setStatus = (text) => { button.textContent = text; };
    button.disabled = true;
    try {
      const card = cardData(button);
      await exportCard(card, setStatus);
      document.querySelector(".revint-panel")?.refresh?.();
      setStatus("Gespeichert ✓");
      await wait(1500);
    } catch (error) {
      console.error("[ReVint] Export fehlgeschlagen:", error, error?.stack || "");
      setStatus(`Fehler: ${error.message}`);
      await wait(3500);
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  function listedMemberItems() {
    const byPath = new Map();
    for (const link of [...document.querySelectorAll(ITEM_LINK)].filter(isItemLink)) {
      if (!link.offsetParent || link.closest("header, nav, footer")) continue;
      const path = new URL(link.href, location.href).pathname;
      if (!byPath.has(path)) byPath.set(path, cardDataFromLink(link));
    }
    return [...byPath.values()];
  }

  async function batchExport(activeOnly, progress) {
    const inactive = /verkauft|sold|verborgen|versteckt|ausgeblendet|hidden/i;
    const allItems = listedMemberItems();
    const items = activeOnly ? allItems.filter((item) => !inactive.test(item.stateText)) : allItems;
    if (!items.length) {
      console.error("[ReVint] Keine passenden Relistings auf der aktuell geladenen Seite gefunden.");
      return;
    }
    let succeeded = 0;
    let done = 0;
    const failed = [];
    const exportOne = async (item) => {
      try {
        await exportCard(item, () => {});
        succeeded++;
        done++;
        progress?.update(done, items.length);
      } catch (error) {
        failed.push(item);
        console.error(`[ReVint] Batch-Export fehlgeschlagen (${item.url}):`, error, error?.stack || "");
      }
    };
    progress?.start(items.length);
    try {
      for (let index = 0; index < items.length; index++) {
        await exportOne(items[index]);
        if (index < items.length - 1) await wait(BATCH_DELAY);
      }
      if (failed.length) {
        const retry = failed.splice(0, failed.length);
        for (let index = 0; index < retry.length; index++) {
          await exportOne(retry[index]);
          await wait(BATCH_DELAY * 2);
        }
      }
      console.info(`[ReVint] ${succeeded}/${items.length} gespeichert${failed.length ? `, ${failed.length} fehlgeschlagen` : ""}.`);
      await wait(1500);
    } finally {
      progress?.finish();
    }
  }

  function newItemUrl() {
    return `${location.origin}/items/new`;
  }

  function findMemberUrl() {
    const link = [...document.querySelectorAll('a[href*="/member/"]')]
      .find((element) => /\/member\/\d+/.test(element.getAttribute("href") || ""));
    return link ? new URL(link.href, location.href).href : `${location.origin}/member`;
  }

  async function enqueueAutoImport(name) {
    const stored = await chrome.storage.local.get("revintPendingQueue");
    const queue = stored.revintPendingQueue || [];
    queue.push({ name, at: Date.now() });
    await chrome.storage.local.set({ revintPendingQueue: queue });
  }

  async function consumeAutoImport() {
    const stored = await chrome.storage.local.get("revintPendingQueue");
    const queue = stored.revintPendingQueue || [];
    let pending = "";
    while (queue.length) {
      const entry = queue.shift();
      if (entry && Date.now() - entry.at < 120000) { pending = entry.name; break; }
    }
    if (queue.length) await chrome.storage.local.set({ revintPendingQueue: queue });
    else await chrome.storage.local.remove("revintPendingQueue");
    return pending;
  }

  function addPanel(mode) {
    const existing = document.querySelector(".revint-panel");
    if (existing && existing.dataset.mode === mode) return;
    existing?.remove();
    if (!document.body) return;

    if (mode === "home") {
      const home = document.createElement("div");
      home.className = "revint-panel revint-panel--home revint-collapsed";
      home.dataset.mode = mode;
      home.innerHTML = [
        '<div class="revint-panel-head">',
        '<div class="revint-panel-title">ReVint</div>',
        '<button type="button" class="revint-collapse-button" aria-label="Panel ein-/ausklappen">▾</button>',
        '</div>',
        '<div class="revint-body revint-home-body">',
        `<div class="revint-home-hint">${t("homeHint")} <button type="button" class="revint-home-button">${t("homeButton")}</button></div>`,
        '</div>'
      ].join("");
      const collapse = home.querySelector(".revint-collapse-button");
      collapse.addEventListener("click", () => {
        const collapsed = home.classList.toggle("revint-collapsed");
        collapse.textContent = collapsed ? "▾" : "▴";
      });
      home.querySelector(".revint-home-button").addEventListener("click", () => location.assign(findMemberUrl()));
      document.body.appendChild(home);
      return;
    }

    const panel = document.createElement("div");
    panel.className = "revint-panel revint-collapsed";
    panel.dataset.mode = mode;
    if (revintBusy) panel.classList.add("revint-busy");
    panel.innerHTML = [
      '<div class="revint-panel-head">',
      '<div class="revint-panel-title">ReVint</div>',
      '<button type="button" class="revint-collapse-button" aria-label="Panel ein-/ausklappen">▾</button>',
      '</div>',
      '<div class="revint-body">',
      '<div class="revint-toolbar">',
      `<label class="revint-select-all"><input type="checkbox" class="revint-check-all"> ${t("selectAll")}</label>`,
      '<div class="revint-progress"><div class="revint-progress-bar"></div></div>',
      '<span class="revint-progress-label"></span>',
      '</div>',
      `<div class="revint-busy-note" hidden>${t("busy")}</div>`,
      '<div class="revint-list"></div>',
      '<div class="revint-pager" hidden>',
      '<button type="button" class="revint-page-button revint-page-prev">‹</button>',
      '<span class="revint-page-label">1/1</span>',
      '<button type="button" class="revint-page-button revint-page-next">›</button>',
      '</div>',
      '<div class="revint-selection-actions">',
      `<button type="button" class="revint-button revint-open-selected" disabled>${t("relistSelected")}</button>`,
      `<button type="button" class="revint-button revint-delete-selected" disabled>${t("deleteSelected")}</button>`,
      '</div>',
      mode === "member"
        ? `<button type="button" class="revint-button revint-export-all">${t("saveAll")}</button><button type="button" class="revint-button revint-export-active">${t("saveListed")}</button>`
        : `<button type="button" class="revint-button revint-manual-button">${t("manual")}</button><input type="file" accept=".json,.revint.json,application/json" hidden>`,
      '</div>'
    ].join("");

    const list = panel.querySelector(".revint-list");
    const pager = panel.querySelector(".revint-pager");
    const pageLabel = panel.querySelector(".revint-page-label");
    const prevButton = panel.querySelector(".revint-page-prev");
    const nextButton = panel.querySelector(".revint-page-next");
    const checkAll = panel.querySelector(".revint-check-all");
    const openButton = panel.querySelector(".revint-open-selected");
    const deleteButton = panel.querySelector(".revint-delete-selected");
    const progressBar = panel.querySelector(".revint-progress-bar");
    const progressLabel = panel.querySelector(".revint-progress-label");
    const busyNote = panel.querySelector(".revint-busy-note");
    const report = (text) => console.info(`[ReVint] ${text}`);

    const progress = {
      start(total) {
        revintBusy = true;
        panel.classList.add("revint-busy");
        busyNote.hidden = false;
        progressBar.style.width = "0%";
        progressLabel.textContent = `0/${total}`;
      },
      update(done, total) {
        progressBar.style.width = `${Math.min(100, Math.round((done / total) * 100))}%`;
        progressLabel.textContent = `${Math.min(done, total)}/${total}`;
      },
      finish() {
        revintBusy = false;
        panel.classList.remove("revint-busy");
        busyNote.hidden = true;
        progressBar.style.width = "0%";
        progressLabel.textContent = "";
      }
    };

    const collapseButton = panel.querySelector(".revint-collapse-button");
    collapseButton.addEventListener("click", () => {
      const collapsed = panel.classList.toggle("revint-collapsed");
      collapseButton.textContent = collapsed ? "▾" : "▴";
    });

    let files = [];

    let page = 0;
    let selected = new Set();

    const totalPages = () => Math.max(1, Math.ceil(files.length / PAGE_SIZE));

    const updateSelectionState = () => {
      checkAll.checked = files.length > 0 && selected.size === files.length;
      checkAll.indeterminate = selected.size > 0 && selected.size < files.length;
      openButton.disabled = selected.size === 0;
      deleteButton.disabled = selected.size === 0;
    };

    const hint = (text) => {
      const element = document.createElement("div");
      element.className = "revint-list-hint";
      element.textContent = text;
      list.appendChild(element);
    };

    const importFileByName = async (name) => {
      const loaded = await message({ type: "read-file", name });
      if (!loaded?.ok) {
        console.error("[ReVint] Datei konnte nicht gelesen werden:", loaded?.error);
        return;
      }
      try {
        await fillForm(JSON.parse(loaded.text), report);
      } catch (error) {
        console.error("[ReVint] Import fehlgeschlagen:", error, error?.stack || "");
      }
    };

    const openItem = (name) => {
      if (mode === "member") {
        enqueueAutoImport(name).then(() => message({ type: "open-tab", url: newItemUrl(), active: true }));
        return;
      }
      if (formHasContent()) {
        sessionStorage.setItem("revintPending", name);
        location.reload();
        return;
      }
      importFileByName(name);
    };

    const render = () => {
      list.innerHTML = "";
      pager.hidden = true;

      if (!files.length) {
        hint(t("noFiles"));
        updateSelectionState();
        return;
      }

      const pages = totalPages();
      page = Math.min(Math.max(0, page), pages - 1);
      const start = page * PAGE_SIZE;
      for (const file of files.slice(start, start + PAGE_SIZE)) {
        const row = document.createElement("div");
        row.className = "revint-row";
        const check = document.createElement("input");
        check.type = "checkbox";
        check.className = "revint-check";
        check.checked = selected.has(file.name);
        check.addEventListener("change", () => {
          if (check.checked) selected.add(file.name);
          else selected.delete(file.name);
          updateSelectionState();
        });
        const item = document.createElement("button");
        item.type = "button";
        item.className = "revint-item";
        item.textContent = file.name.replace(/\.revint\.json$/i, "");
        item.title = file.name;
        item.addEventListener("click", () => openItem(file.name));
        row.append(check, item);
        list.appendChild(row);
      }

      if (pages > 1) {
        pager.hidden = false;
        pageLabel.textContent = `${page + 1}/${pages}`;
        prevButton.disabled = page === 0;
        nextButton.disabled = page >= pages - 1;
      }
      updateSelectionState();
    };

    const refresh = async () => {
      const response = await message({ type: "list-files" });
      if (!response?.ok) {
        console.error("[ReVint] Relistings konnten nicht gelesen werden:", response?.error);
        render();
        return;
      }
      files = response.files || [];
      page = 0;
      selected = new Set();
      render();
    };
    panel.refresh = refresh;

    prevButton.addEventListener("click", () => { if (page > 0) { page--; render(); } });
    nextButton.addEventListener("click", () => { if (page < totalPages() - 1) { page++; render(); } });

    checkAll.addEventListener("change", () => {
      selected = checkAll.checked ? new Set(files.map((file) => file.name)) : new Set();
      render();
    });

    openButton.addEventListener("click", async () => {
      const names = files.filter((file) => selected.has(file.name)).map((file) => file.name);
      if (!names.length) return;
      const original = openButton.textContent;
      openButton.disabled = true;
      progress.start(names.length);
      try {
        for (let index = 0; index < names.length; index++) {
          openButton.textContent = t("opening", { done: index + 1, total: names.length });
          await enqueueAutoImport(names[index]);
          await message({ type: "open-tab", url: newItemUrl(), active: false });
          progress.update(index + 1, names.length);
          if (index < names.length - 1) await wait(OPEN_DELAY);
        }
      } catch (error) {
        console.error("[ReVint] Öffnen fehlgeschlagen:", error, error?.stack || "");
      } finally {
        progress.finish();
        openButton.textContent = original;
        updateSelectionState();
      }
    });

    deleteButton.addEventListener("click", async () => {
      const names = [...selected];
      if (!names.length) return;
      if (!confirm(t("confirmDelete", { count: names.length }))) return;
      deleteButton.disabled = true;
      try {
        const response = await message({ type: "delete-files", names });
        if (!response?.ok) {
          console.error(`[ReVint] ${t("deleteFailed")}`, response?.error);
          return;
        }
        if (response.failed?.length) console.error(`[ReVint] ${t("notDeleted")}`, response.failed);
        if (!response.deleted?.length) {
          console.warn(`[ReVint] ${t("noneDeleted")}`);
          return;
        }
        response.deleted.forEach((name) => selected.delete(name));
        await refresh();
      } catch (error) {
        console.error(`[ReVint] ${t("deleteFailed")}`, error, error?.stack || "");
      } finally {
        updateSelectionState();
      }
    });

    if (mode === "member") {
      const allButton = panel.querySelector(".revint-export-all");
      const activeButton = panel.querySelector(".revint-export-active");
      const exportButtons = [allButton, activeButton];
      const runExport = async (activeOnly) => {
        exportButtons.forEach((button) => { button.disabled = true; });
        try {
          await batchExport(activeOnly, progress);
          await refresh();
        } finally {
          exportButtons.forEach((button) => { button.disabled = false; });
        }
      };
      allButton.addEventListener("click", () => runExport(false));
      activeButton.addEventListener("click", () => runExport(true));
    } else {
      const manualButton = panel.querySelector(".revint-manual-button");
      const input = panel.querySelector("input[type=file]");
      manualButton.addEventListener("click", () => input.click());
      input.addEventListener("change", async () => {
        try {
          const bundle = JSON.parse(await input.files[0].text());
          await fillForm(bundle, report);
        } catch (error) {
          console.error("[ReVint] Import fehlgeschlagen:", error, error?.stack || "");
        }
        input.value = "";
      });
    }

    document.body.appendChild(panel);
    refresh();

    if (mode === "new") {
      const local = sessionStorage.getItem("revintPending");
      if (local) {
        sessionStorage.removeItem("revintPending");
        importFileByName(local);
      } else {
        consumeAutoImport().then((pending) => { if (pending) importFileByName(pending); });
      }
    }
  }

  function addSaveButtons() {
    const buttons = [...document.querySelectorAll("button, a")].filter((el) =>
      el.matches?.('button[data-testid="bump-button"]') || /^(pushen|push|artikel pushen)$/i.test(clean(el.textContent))
    );
    for (const push of buttons) {
      const container = push.parentElement;
      if (!container || container.querySelector(":scope > .revint-button")) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "revint-button revint-inline";
      button.textContent = t("saveOne");
      try {
        const style = getComputedStyle(push);
        button.style.fontFamily = style.fontFamily;
        button.style.fontSize = style.fontSize;
        button.style.fontWeight = style.fontWeight;
        button.style.lineHeight = style.lineHeight;
        button.style.letterSpacing = style.letterSpacing;
      } catch (_) {}
      button.addEventListener("click", () => exportItem(button));
      push.insertAdjacentElement("afterend", button);
    }
  }

  function fieldBy(hints) {
    const fields = [...document.querySelectorAll("input:not([type=file]), textarea")];
    let best = null;
    let bestScore = 0;
    for (const field of fields) {
      const strong = norm(`${field.name || ""} ${field.id || ""} ${field.dataset?.testid || ""}`);
      const weak = norm(`${field.placeholder || ""} ${field.getAttribute("aria-label") || ""}`);
      let score = 0;
      for (const hint of hints) {
        if (strong.split(/\s+/).includes(hint)) score = Math.max(score, 3);
        else if (strong.includes(hint)) score = Math.max(score, 2);
        else if (weak.includes(hint)) score = Math.max(score, 1);
      }
      if (score > bestScore) {
        best = field;
        bestScore = score;
      }
    }
    return best;
  }

  function setField(field, value) {
    if (!field || value === undefined || value === null || value === "") return false;
    try { field.focus(); } catch (_) {}
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set.call(field, String(value));
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function isInteractable(element) {
    if (!element || element.disabled || element.type === "hidden") return false;
    if (element.getAttribute?.("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    return !style || (style.display !== "none" && style.visibility !== "hidden");
  }

  function firstBySelectors(selectors) {
    for (const selector of selectors) {
      const found = [...document.querySelectorAll(selector)].find(isInteractable);
      if (found) return found;
    }
    return null;
  }

  const matchText = (value) => String(value == null ? "" : value)
    .toLocaleLowerCase("de-DE")
    .replace(/[^a-z0-9äöüß]+/g, " ")
    .trim();

  function categorySearchInput() {
    const inputs = document.querySelectorAll("input[type='text'], input[type='search'], input:not([type])");
    for (const input of inputs) {
      if (!isInteractable(input)) continue;
      const text = matchText(`${input.placeholder} ${input.getAttribute("aria-label") || ""}`);
      if (!/kategorie|category/.test(text)) continue;
      if (/finde|find/.test(text) || input.closest("[role='dialog'], [aria-modal='true']")) return input;
    }
    return null;
  }

  function dropdownOpener(label, testidHints, avoidWords) {
    const direct = firstBySelectors(testidHints || []);
    if (direct) return direct;
    const needle = matchText(label);
    let best = null;
    let bestPenalty = 9;
    let bestKids = Infinity;
    const candidates = document.querySelectorAll("[role='button'], button, [tabindex], input[readonly], li, div");
    for (const element of candidates) {
      if (!isInteractable(element)) continue;
      if (element.closest("a[href], header, nav, [role='navigation'], [role='tablist'], [role='tab'], .revint-panel")) continue;
      if (element.querySelector("input, textarea")) continue;
      const text = matchText(element.textContent || element.getAttribute("placeholder") || element.value || "");
      if (text !== needle && !(text.includes(needle) && text.length <= needle.length + 14)) continue;
      const context = matchText((element.closest("fieldset, section, [class*='Cell'], [class*='ield'], [class*='ow']") || element.parentElement || element).textContent || "");
      const penalty = avoidWords?.some((word) => context.includes(word)) ? 1 : 0;
      const kids = element.getElementsByTagName("*").length;
      if (penalty < bestPenalty || (penalty === bestPenalty && kids < bestKids)) {
        best = element;
        bestPenalty = penalty;
        bestKids = kids;
      }
    }
    if (avoidWords?.length && bestPenalty > 0) return null;
    return best;
  }

  function categoryOpener() {
    return dropdownOpener("kategorie", [
      "[data-testid='catalog-select-dropdown-input']",
      "[data-testid='catalog-select-dropdown-chevron']",
      "[data-testid='catalog-select-dropdown']"
    ]);
  }

  function pickerContainer() {
    const content = document.querySelector("[data-testid='catalog-select-dropdown-content']");
    if (content) return content;
    const search = categorySearchInput();
    if (!search) return null;
    const explicit = search.closest("[role='dialog'], [aria-modal='true'], [class*='odal'], [class*='ialog'], [class*='heet'], [class*='rawer']");
    if (explicit) return explicit;
    let element = search;
    let best = search.parentElement || search;
    while (element?.parentElement && element.parentElement !== document.body) {
      best = element.parentElement;
      element = element.parentElement;
    }
    return best;
  }

  function clickableTarget(element) {
    return element.closest?.("button, li, [role='button'], [role='option'], [role='menuitem'], [role='radio'], [role='checkbox'], label, div[tabindex], [class*='Cell__cell'], [class*='Cell__default']") || element;
  }

  function robustClick(element) {
    let target = clickableTarget(element);
    if (target === element) {
      const child = element.querySelector?.("[role='checkbox'], [role='radio'], [role='button'], [role='option'], button, div[tabindex], [class*='filter-grid__option'], [class*='Cell__cell'], label");
      if (child) target = child;
    }
    const input = target.querySelector?.("input[type='radio'], input[type='checkbox']")
      || element.querySelector?.("input[type='radio'], input[type='checkbox']");
    if (input) { input.click(); return; }
    const options = { bubbles: true, cancelable: true, view: window };
    target.dispatchEvent(new MouseEvent("mousedown", options));
    target.dispatchEvent(new MouseEvent("mouseup", options));
    try { target.click(); } catch (_) { target.dispatchEvent(new MouseEvent("click", options)); }
  }

  function rowMatch(root, name) {
    const target = matchText(name);
    if (!target) return null;
    const exact = [];
    let partial = null;
    const nodes = root.querySelectorAll("button, li, div, span, p, [role='button'], [role='option'], [role='menuitem']");
    for (const element of nodes) {
      if (!isInteractable(element)) continue;
      if (element.closest(".revint-panel, a[href], header, nav, footer, [role='navigation'], [role='tablist'], [role='tab'], [data-testid^='catalog-navigation']")) continue;
      if (element.querySelector("input, textarea, a[href]")) continue;
      const text = matchText(element.textContent);
      if (!text) continue;
      if (text === target) exact.push(element);
      else if (!partial && text.includes(target) && text.length <= target.length + 16) partial = element;
    }
    exact.sort((a, b) => a.getElementsByTagName("*").length - b.getElementsByTagName("*").length);
    return exact[0] || partial;
  }

  async function clickCategoryLevel(id, name) {
    for (let attempt = 0; attempt < 16; attempt++) {
      const container = pickerContainer();
      if (container && id) {
        const icon = container.querySelector(`[data-testid='catalog-icon-${id}']`);
        if (icon && isInteractable(icon)) { clickableTarget(icon).click(); return true; }
      }
      const row = (container && rowMatch(container, name)) || rowMatch(document.body, name);
      if (row) { clickableTarget(row).click(); return true; }
      await wait(350);
    }
    return false;
  }

  function dropdownSaveButton() {
    const direct = firstBySelectors([
      "[data-testid='input-dropdown-save-button']",
      "button[data-testid*='dropdown-save']"
    ]);
    if (direct) return direct;
    for (const element of document.querySelectorAll("button, [role='button']")) {
      if (!isInteractable(element) || element.closest("a[href], header, nav, [role='navigation'], .revint-panel")) continue;
      const text = matchText(element.textContent);
      if (text === "fertig" || text === "done") return element;
    }
    return null;
  }

  function pickerVisible() {
    const search = categorySearchInput();
    if (!search || search.offsetParent === null) return false;
    const rect = search.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  async function fillCategory(item, status = () => {}) {
    const path = (item?.categoryPath || []).filter((segment) => segment?.title || segment?.id != null);
    if (!path.length) return 0;

    if (!pickerContainer()) {
      const opener = categoryOpener();
      if (!opener) {
        console.warn("[ReVint] Kategorie-Feld wurde nicht gefunden.");
        return 0;
      }
      for (let attempt = 0; attempt < 16 && !pickerContainer(); attempt++) {
        opener.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        opener.click();
        opener.focus?.();
        await wait(300);
      }
    }
    if (!pickerContainer()) {
      console.warn("[ReVint] Kategorie-Auswahl ließ sich nicht öffnen.");
      return 0;
    }

    let filled = 0;
    for (let index = 0; index < path.length; index++) {
      if (!location.pathname.startsWith("/items/new")) {
        console.warn("[ReVint] Formular wurde verlassen, Kategorie abgebrochen.");
        break;
      }
      const segment = path[index];
      status(`Kategorie ${index + 1}/${path.length}: ${segment.title || segment.id} …`);
      if (!await clickCategoryLevel(segment.id ?? null, segment.title || "")) {
        console.warn("[ReVint] Kategorie-Ebene nicht gefunden:", segment);
        break;
      }
      filled++;
      await wait(450);
    }

    if (filled < path.length) {
      const leaf = path.at(-1)?.title || "";
      const search = categorySearchInput();
      if (search && leaf) {
        status(`Kategorie: Suche nach ${leaf} …`);
        setField(search, leaf);
        search.dispatchEvent(new Event("keyup", { bubbles: true }));
        for (let attempt = 0; attempt < 12; attempt++) {
          await wait(300);
          const result = rowMatch(pickerContainer() || document.body, leaf);
          if (result) { clickableTarget(result).click(); filled = path.length; break; }
        }
      }
    }

    if (filled > 0) {
      await wait(300);
      const save = dropdownSaveButton();
      if (save) robustClick(save);
      for (let attempt = 0; attempt < 16 && pickerVisible(); attempt++) await wait(300);
    }

    if (!filled) {
      console.warn("[ReVint] Kategorie konnte nicht automatisch gesetzt werden.");
      return 0;
    }
    status(`Kategorie: ${filled}/${path.length} Ebenen gesetzt.`);
    return filled;
  }

  function exactRowMatch(root, name) {
    const target = matchText(name);
    if (!target) return null;
    let best = null;
    const nodes = root.querySelectorAll("button, li, div, span, p, [role='button'], [role='option'], [role='menuitem']");
    for (const element of nodes) {
      if (!isInteractable(element)) continue;
      if (element.closest(".revint-panel, a[href], header, nav, footer, [role='navigation'], [role='tablist'], [role='tab'], [data-testid^='catalog-navigation']")) continue;
      if (element.querySelector("input, textarea, a[href]")) continue;
      if (matchText(element.textContent) !== target) continue;
      if (!best || element.getElementsByTagName("*").length < best.getElementsByTagName("*").length) best = element;
    }
    return best;
  }

  const VINTED_CONDITIONS = {
    neu: ["Neu ohne Preisschild", "Neu ohne Etikett", "Neu mit Preisschild", "Neu mit Etikett", "Neu"],
    "neu mit etikett": ["Neu mit Etikett", "Neu"],
    "neu ohne etikett": ["Neu ohne Etikett", "Neu ohne Preisschild", "Neu"],
    neuwertig: ["Sehr gut"],
    "sehr gut": ["Sehr gut"],
    gut: ["Gut"],
    zufriedenstellend: ["Zufriedenstellend", "Befriedigend"],
    befriedigend: ["Zufriedenstellend", "Befriedigend"]
  };

  function conditionCandidates(value) {
    return [...new Set([value, ...(VINTED_CONDITIONS[norm(value)] || [])].filter(Boolean))];
  }

  async function fillVintedDropdown(label, testidHints, candidates, logName, status = () => {}, avoidWords) {
    const values = (candidates || []).filter(Boolean);
    if (!values.length) return false;
    const opener = dropdownOpener(label, testidHints, avoidWords);
    if (!opener) {
      console.warn(`[ReVint] ${logName}-Feld wurde nicht gefunden.`);
      return false;
    }
    const beforeText = matchText(opener.textContent || opener.value || "");
    let picked = null;
    for (let attempt = 0; attempt < 3 && !picked; attempt++) {
      try {
        opener.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        opener.click();
        opener.focus?.();
      } catch (_) {}
      for (let poll = 0; poll < 8 && !picked; poll++) {
        await wait(300);
        for (const value of values) {
          const row = exactRowMatch(pickerContainer() || document.body, value) || exactRowMatch(document.body, value);
          if (row) { picked = { row, value }; break; }
        }
      }
    }
    if (!picked) {
      console.warn(`[ReVint] ${logName}: Option ${values.join(" / ")} nicht gefunden.`);
      return false;
    }
    status(`${logName}: ${picked.value} …`);
    robustClick(picked.row);
    await wait(300);
    const save = dropdownSaveButton();
    if (save) { try { clickableTarget(save).click(); } catch (_) {} await wait(300); }
    await wait(150);
    const after = dropdownOpener(label, testidHints, avoidWords);
    const afterText = after ? matchText(after.textContent || after.value || "") : beforeText;
    const number = (matchText(picked.value).match(/\d+/) || [""])[0];
    const verified = afterText !== beforeText
      || (number && afterText.includes(number))
      || afterText.includes(matchText(picked.value));
    if (!verified) console.warn(`[ReVint] ${logName}: Auswahl wurde nicht übernommen.`);
    opener.blur?.();
    await dismissOverlays();
    return verified;
  }

  function attributeSelectors(code) {
    const alternate = code.endsWith("s") ? code.slice(0, -1) : `${code}s`;
    const selectors = [];
    for (const name of [code, alternate]) {
      selectors.push(
        `[name="${name}"]`,
        `#${name}`,
        `[data-testid='category-${name}-single-list-input']`,
        `[data-testid='category-${name}-single-list_search-input']`,
        `[data-testid='category-${name}-multi-list-input']`,
        `[data-testid='${name}-select-dropdown-input']`,
        `[data-testid='${name}-select-dropdown-chevron']`
      );
    }
    return selectors;
  }

  async function fillAttribute(code, label, candidates, status, avoidWords) {
    const values = (candidates || []).filter(Boolean);
    if (!values.length) return false;
    return fillVintedDropdown(label, attributeSelectors(code), values, label, status, avoidWords);
  }

  function sizeCandidates(value) {
    const text = String(value || "").trim();
    if (!text) return [];
    const parts = text.split(/[\/,|]| - |–/).map((part) => part.trim()).filter(Boolean);
    const numbers = text.match(/\d{2,3}/g) || [];
    return [...new Set([text, ...parts, ...numbers].filter(Boolean))];
  }

  async function fillPlatforms(item, status = () => {}) {
    const names = [...new Set((item?.platforms || []).map((platform) => platform?.title || platform).filter(Boolean))];
    if (!names.length) return false;
    let filled = false;
    for (const name of names) {
      const direct = exactRowMatch(document.body, name);
      if (direct) {
        status(`Plattform: ${name} …`);
        robustClick(direct);
        await wait(300);
        filled = true;
        continue;
      }
      if (await fillAttribute("video_game_platform", "Plattform", [name], status)) filled = true;
    }
    return filled;
  }

  async function fillBrand(item, status = () => {}) {
    const brand = clean(item?.brand);
    if (!brand) return false;
    const opener = dropdownOpener("marke", ["[data-testid='brand-select-dropdown-input']", "[name='brand']"]);
    if (!opener) return false;
    const isInput = opener instanceof HTMLInputElement || opener instanceof HTMLTextAreaElement;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        opener.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        opener.click();
        opener.focus?.();
      } catch (_) {}
      if (isInput) {
        setField(opener, brand);
        opener.dispatchEvent(new Event("keyup", { bubbles: true }));
      }
      for (let poll = 0; poll < 10; poll++) {
        await wait(250);
        const row = exactRowMatch(pickerContainer() || document.body, brand) || exactRowMatch(document.body, brand);
        if (!row) continue;
        status(`Marke: ${brand} …`);
        robustClick(row);
        await wait(300);
        const save = dropdownSaveButton();
        if (save) { try { clickableTarget(save).click(); } catch (_) {} await wait(300); }
        return true;
      }
    }
    console.warn(`[ReVint] Marke „${brand}“ nicht gefunden.`);
    return false;
  }

  function rowByAnyText(root, name) {
    const target = matchText(name);
    if (!target) return null;
    let exact = null;
    let partial = null;
    const nodes = root.querySelectorAll("button, li, div, span, p, label, [role='option'], [role='button'], [role='menuitem'], [aria-label]");
    for (const element of nodes) {
      if (!isInteractable(element)) continue;
      if (element.closest(".revint-panel, a[href], header, nav, footer, [role='navigation']")) continue;
      if (element.querySelector("input, textarea, a[href]")) continue;
      const values = [element.textContent, element.getAttribute("aria-label"), element.getAttribute("title"), element.dataset?.value];
      const texts = values.filter(Boolean).map(matchText);
      if (texts.includes(target)) {
        if (!exact || element.getElementsByTagName("*").length < exact.getElementsByTagName("*").length) exact = element;
      } else if (!partial && texts.some((text) => text.includes(target) && text.length <= target.length + 16)) {
        partial = element;
      }
    }
    return exact || partial;
  }

  async function dismissOverlays() {
    for (let attempt = 0; attempt < 2; attempt++) {
      const escape = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true });
      (document.activeElement || document.body).dispatchEvent(escape);
      document.dispatchEvent(escape);
      if (attempt === 0) {
        document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      }
      await wait(200);
    }
  }

  async function fillColor(item, status = () => {}) {
    const colors = [...new Set((item?.colors || []).filter(Boolean))].slice(0, 2);
    if (!colors.length) return false;
    const opener = dropdownOpener("farbe", attributeSelectors("color"));
    if (!opener) {
      console.warn("[ReVint] Farbfeld wurde nicht gefunden.");
      return false;
    }
    const current = matchText(opener.value || opener.textContent || "");
    const remaining = colors.filter((color) => !current.includes(matchText(color)));
    if (!remaining.length) return true;

    try {
      opener.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      opener.click();
      opener.focus?.();
    } catch (_) {}

    for (let poll = 0; poll < 12 && remaining.length; poll++) {
      await wait(250);
      const color = remaining[0];
      const row = rowByAnyText(pickerContainer() || document.body, color) || rowByAnyText(document.body, color);
      if (!row) continue;
      status(`Farbe: ${color} …`);
      robustClick(clickableTarget(row));
      remaining.splice(0, 1);
      await wait(300);
    }

    const save = dropdownSaveButton();
    if (save) { try { clickableTarget(save).click(); } catch (_) {} await wait(300); }
    opener.blur?.();
    await dismissOverlays();

    const selected = matchText(opener.value || opener.textContent || "");
    const applied = colors.some((color) => selected.includes(matchText(color)));
    if (!applied) console.warn(`[ReVint] Farbe ${colors.join(" / ")} konnte nicht gesetzt werden.`);
    return applied;
  }

  function materialCandidates(value) {
    return [...new Set(String(value || "").split(/[,;\/]/).map((part) => part.trim()).filter(Boolean))];
  }

  function formatPrice(value) {
    const raw = String(value == null ? "" : value).replace(/[^\d.,]/g, "").replace(",", ".");
    if (!raw) return "";
    const number = Number(raw);
    return Number.isFinite(number) ? String(number) : raw;
  }

  async function setTextWhenReady(hints, value, timeout = 5000) {
    if (!value) return false;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const field = fieldBy(hints);
      if (field) return setField(field, value);
      await wait(200);
    }
    return false;
  }

  async function setPrice(value) {
    const price = formatPrice(value);
    if (!price) {
      console.warn("[ReVint] Keine Preisangabe in der ReVint-Datei.");
      return false;
    }
    let field = null;
    for (let attempt = 0; attempt < 12 && !field; attempt++) {
      field = fieldBy(["preis", "price"]) || fieldBy(["0,00"]);
      if (!field) await wait(300);
    }
    if (!field) {
      console.warn("[ReVint] Preisfeld wurde nicht gefunden.");
      return false;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      setField(field, price);
      await wait(250);
      if (String(field.value) === price) return true;
      field = fieldBy(["preis", "price"]) || field;
    }
    console.warn("[ReVint] Preis konnte nicht gesetzt werden.");
    return false;
  }

  function dataUrlFile(image) {
    const bytes = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0));
    return new File([bytes], image.name, { type: image.type });
  }

  async function fillForm(bundle, status) {
    if (bundle?.format !== FORMAT || bundle?.version !== VERSION || !bundle.item) throw new Error("Keine gültige ReVint-Datei");
    const item = bundle.item;
    console.info("[ReVint] Zu importierende Relisting-Daten:", item);
    let filled = 0;
    if (await setTextWhenReady(["titel", "title"], item.title, 8000)) filled++;
    if (await setTextWhenReady(["beschreibung", "description"], item.description, 8000)) filled++;

    const fileInput = [...document.querySelectorAll('input[type="file"]')].find((input) => input !== document.querySelector(".revint-panel input"));
    if (fileInput && item.images?.length) {
      const transfer = new DataTransfer();
      item.images.forEach((image) => transfer.items.add(dataUrlFile(image)));
      fileInput.files = transfer.files;
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      filled += item.images.length;
      await wait(800);
    } else if (!item.images?.length) console.error("[ReVint] Die ReVint-Datei enthält keine Bilder. Bitte das Relisting erneut exportieren.");
    else console.error("[ReVint] Vinteds Datei-Eingabefeld wurde nicht gefunden.");

    const categories = await fillCategory(item);
    const condition = await fillVintedDropdown("zustand", [
      "[data-testid='condition-select-dropdown-input']",
      "[data-testid='condition-select-dropdown-chevron']",
      "[data-testid='status-select-dropdown-input']"
    ], conditionCandidates(item.condition), "Zustand", status);
    const platforms = await fillPlatforms(item, status);
    const size = await fillAttribute("size", "Größe", sizeCandidates(item.size), status,
      ["versand", "paket", "pushen", "schneller", "sichtbarkeit", "spotlight"]);
    const ageRating = await fillAttribute("video_game_ratings", "Altersbeschränkung", [item.ageRating], status);
    const brand = await fillBrand(item, status);
    const colors = await fillColor(item, status);
    const material = await fillAttribute("material", "Material", materialCandidates(item.material), status);
    const isbn = await setTextWhenReady(["isbn"], item.isbn);
    if (isbn) filled++;
    const price = await setPrice(item.price);
    if (price) filled++;
    const notes = [
      categories ? `${categories} Kategorie-Ebene(n)` : "Kategorie bitte selbst wählen",
      condition ? "Zustand" : "Zustand bitte selbst wählen"
    ];
    if (item.brand) notes.push(brand ? "Marke" : "Marke bitte selbst wählen");
    if (item.colors?.length) notes.push(colors ? "Farbe" : "Farbe bitte selbst wählen");
    if (item.material) notes.push(material ? "Material" : "Material bitte selbst wählen");
    if (item.platforms?.length) notes.push(platforms ? "Plattform" : "Plattform bitte selbst wählen");
    if (item.size) notes.push(size ? "Größe" : "Größe bitte selbst wählen");
    if (item.ageRating) notes.push(ageRating ? "Altersbeschränkung" : "Altersbeschränkung bitte selbst wählen");
    if (item.isbn) notes.push(isbn ? "ISBN" : "ISBN bitte selbst eingeben");
    if (!price) notes.push("Preis bitte selbst eingeben");
    status(`${filled} Angaben eingefügt (${notes.join(", ")}). Auswahlfelder bitte prüfen.`);
    document.activeElement?.blur?.();
    await dismissOverlays();
  }

  function formHasContent() {
    const fields = document.querySelectorAll("input:not([type=file]):not([type=hidden]), textarea");
    for (const field of fields) {
      if (field.closest(".revint-panel")) continue;
      if (clean(field.value)) return true;
    }
    return false;
  }

  async function run() {
    if (!messagesReady) await loadMessages();
    if (location.pathname.startsWith("/items/new")) {
      addPanel("new");
    } else if (location.pathname.startsWith("/member")) {
      addPanel("member");
      addSaveButtons();
    } else if (location.pathname === "/") {
      addPanel("home");
    }
  }

  let runScheduled = false;
  const scheduleRun = () => {
    if (runScheduled) return;
    runScheduled = true;
    setTimeout(() => { runScheduled = false; run(); }, 50);
  };
  console.info(`[ReVint] content script geladen (v${chrome.runtime?.getManifest?.().version || "?"})`);
  run();
  new MutationObserver(scheduleRun).observe(document.documentElement, { childList: true, subtree: true });
})();
