(() => {
  "use strict";

  const FORMAT = "revint";
  const VERSION = 1;
  const PAGE_SIZE = 20;
  const OPEN_DELAY = 6000;
  const BATCH_DELAY = 1200;
  const IMAGE_CONCURRENCY = 4;

  let revintBusy = false;
  let contextInvalidated = false;
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
  const norm = (value) => clean(value).toLowerCase();

  const TLD_LANGUAGE = {
    com: "en", uk: "en", ie: "en", de: "de", at: "de",
    fr: "fr", lu: "fr", be: "nl", nl: "nl", es: "es", it: "it",
    pl: "pl", lt: "lt", lv: "lv", ee: "et", cz: "cs", sk: "sk",
    hu: "hu", ro: "ro", se: "sv", dk: "da", fi: "fi",
    pt: "pt", gr: "el", hr: "hr", bg: "bg", si: "sl"
  };

  let MESSAGES = {};
  let messagesReady = false;
  let messagesLoading = null;
  let detectedLanguage = "";

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

  function loadMessages() {
    if (!messagesLoading) {
      messagesLoading = (async () => {
        let english = {};
        try { english = await fetchMessages("en"); } catch (_) {}
        const code = await detectLanguage();
        let chosen = english;
        if (code && code !== "en") {
          try { chosen = await fetchMessages(code); } catch (_) { chosen = english; }
        }
        MESSAGES = { ...english, ...chosen };
        detectedLanguage = code || "en";
        messagesReady = true;
      })();
    }
    return messagesLoading;
  }

  function t(key, params) {
    let text = MESSAGES[key] || key;
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        text = text.split(`{${name}}`).join(String(value));
      }
    }
    return text;
  }

  function noteContextError(error) {
    const text = String(error?.message || error || "");
    if (!contextInvalidated && /extension context invalidated/i.test(text)) {
      contextInvalidated = true;
      revintBusy = false;
      console.warn(`[ReVint] ${t("logContextInvalidated")}`);
    }
    return text;
  }

  function message(payload) {
    return new Promise((resolve) => {
      if (contextInvalidated) {
        resolve({ ok: false, error: t("logContextInvalidated") });
        return;
      }
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          try {
            if (chrome.runtime.lastError) resolve({ ok: false, error: noteContextError(chrome.runtime.lastError) });
            else resolve(response);
          } catch (error) {
            resolve({ ok: false, error: noteContextError(error) });
          }
        });
      } catch (error) {
        resolve({ ok: false, error: noteContextError(error) });
      }
    });
  }

  // The relist form drops price/brand/colour/isbn from its submitted model
  // (their widgets ignore synthetic events). Hand those values to the page so
  // it can inject them into the outgoing upload request.
  let uploadPatchValues = null;
  function setUploadPatch(item) {
    uploadPatchValues = {
      price: item?.price != null && item.price !== "" ? Number(formatPrice(item.price)) : null,
      brandId: item?.brandId ?? null,
      colorIds: Array.isArray(item?.colorIds) ? item.colorIds : [],
      isbn: item?.isbn || ""
    };
  }

  async function installUploadPatch() {
    if (!uploadPatchValues) return;
    return message({ type: "install-upload-patch", values: uploadPatchValues });
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
    // Internal ids the relist form model refuses to accept from synthetic
    // events; reused to patch the upload request instead.
    const brandHref = brandRow?.querySelector("a[href*='/brand/']")?.getAttribute("href")
      || doc.querySelector("a[href*='/brand/']")?.getAttribute("href") || "";
    const brandIdValue = Number((brandHref.match(/\/brand\/(\d+)/) || [])[1])
      || Number(deepFind(hydratedItem, ["brand_id"]) ?? hydratedItem.brand?.id) || null;
    const colorIdValues = [...new Set([
      ...(Array.isArray(hydratedItem.color_ids) ? hydratedItem.color_ids : []),
      ...(Array.isArray(hydratedItem.colors) ? hydratedItem.colors.map((entry) => (entry && typeof entry === "object" ? entry.id : null)) : []),
      ...[...doc.querySelectorAll("[data-testid='item-attributes-color'] a[href]")].map((anchor) => ((anchor.getAttribute("href") || "").match(/(\d+)/) || [])[1])
    ].map(Number).filter(Boolean))];
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
      brandId: brandIdValue,
      colorIds: colorIdValues,
      size: sizeValue || details.size || displayValue(size) || clean(deepFind(hydratedItem, ["size_title"])),
      ageRating,
      condition: conditionValue || details.condition || displayValue(condition) || clean(deepFind(hydratedItem, ["status_title", "condition_title"])),
      colors: colorValue ? colorValue.split(/,|\/|;/).map(clean).filter(Boolean) : details.color ? details.color.split(/,|\/|;/).map(clean).filter(Boolean) : listValues(colors),
      material: materialValue || details.material || listValues(materials).join(", ") || clean(deepFind(hydratedItem, ["material_title"])),
      parcelSize: details.parcelSize || displayValue(parcelSize) || clean(deepFind(hydratedItem, ["package_size_title"])),
      isbn: isbnValue || details.isbn || "",
      tags: [],
      imageUrls: [...imageUrls].filter((url) => !/avatar|profile|icon|logo/i.test(url)).slice(0, 20)
    };
  }

  async function embedImages(urls, status) {
    if (!urls.length) {
      console.error(`[ReVint] ${t("logNoImageUrls")}`);
      return [];
    }
    const results = new Array(urls.length);
    let next = 0;
    let finished = 0;
    const worker = async () => {
      for (;;) {
        const index = next++;
        if (index >= urls.length) return;
        const response = await message({ type: "fetch-image", url: urls[index] });
        finished++;
        status(t("statusImage", { done: finished, total: urls.length }));
        if (response?.ok) results[index] = { name: `image-${index + 1}.${extension(response.image.type)}`, ...response.image };
        else console.error(`[ReVint] ${t("statusImageFailed", { index: index + 1 })}`, response?.error || t("statusUnknown"), urls[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, urls.length) }, worker));
    return results.filter(Boolean);
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
      console.warn(`[ReVint] ${t("logCardFindFailed")}`, error);
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

  async function buildBundle(card, setStatus) {
    if (!card.url) throw new Error(t("errNoLink"));
    setStatus(t("statusReading"));
    const page = await message({ type: "fetch-text", url: card.url });
    if (!page?.ok) throw new Error(page?.error || t("errPageRead"));
    const item = parseItemPage(page.text, page.url || card.url, card);
    console.info(`[ReVint] ${t("logParsed")}`, item);
    item.images = await embedImages(item.imageUrls, setStatus);
    delete item.imageUrls;
    const bundle = { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), item };
    const safeTitle = (item.title || "relisting").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80);
    return { filename: `${safeTitle}.revint.json`, bundle, sourceUrl: item.sourceUrl || card.url };
  }

  async function exportCard(card, setStatus) {
    const { filename, bundle, sourceUrl } = await buildBundle(card, setStatus);
    const saved = await message({ type: "save-file", filename, contents: JSON.stringify(bundle), sourceUrl });
    if (!saved?.ok) throw new Error(saved?.error || t("errSave"));
  }

  async function pickSaveDirectory() {
    if (typeof window.showDirectoryPicker !== "function") {
      console.warn(`[ReVint] ${t("logManualUnsupported")}`);
      return null;
    }
    try {
      return await window.showDirectoryPicker({ mode: "readwrite" });
    } catch (error) {
      if (error?.name === "AbortError") return null;
      console.error(`[ReVint] ${t("logManualFolderFailed")}`, error?.message || error);
      return null;
    }
  }

  async function uniqueDirectoryFilename(dirHandle, filename) {
    const stem = filename.replace(/\.revint\.json$/i, "");
    for (let counter = 1; counter <= 100; counter++) {
      const candidate = counter === 1 ? filename : `${stem}-${counter}.revint.json`;
      try {
        await dirHandle.getFileHandle(candidate);
      } catch (_) {
        return candidate;
      }
    }
    return `${stem}-${Date.now()}.revint.json`;
  }

  async function saveCardToDirectory(card, setStatus, dirHandle) {
    const { filename, bundle } = await buildBundle(card, setStatus);
    const name = await uniqueDirectoryFilename(dirHandle, filename);
    const handle = await dirHandle.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(bundle));
    await writable.close();
    return name;
  }

  async function exportItem(button) {
    const original = button.textContent;
    const setStatus = (text) => { button.textContent = text; };
    button.disabled = true;
    try {
      const card = cardData(button);
      await exportCard(card, setStatus);
      document.querySelector(".revint-panel")?.refresh?.();
      setStatus(t("statusSaved"));
      await wait(1500);
    } catch (error) {
      console.error(`[ReVint] ${t("logExportFailed")}`, error, error?.stack || "");
      setStatus(t("statusError", { message: error.message }));
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

  function memberItems(activeOnly) {
    const inactive = /verkauft|sold|verborgen|versteckt|ausgeblendet|hidden/i;
    const allItems = listedMemberItems();
    return activeOnly ? allItems.filter((item) => !inactive.test(item.stateText)) : allItems;
  }

  async function batchExport(items, progress, saveItem) {
    if (!items.length) {
      console.error(`[ReVint] ${t("logNoItems")}`);
      return;
    }
    let succeeded = 0;
    let done = 0;
    const failed = [];
    const exportOne = async (item) => {
      try {
        if (saveItem) await saveItem(item);
        else await exportCard(item, () => {});
        succeeded++;
        done++;
        progress?.update(done, items.length);
      } catch (error) {
        failed.push(item);
        // When the extension is reloaded mid-run every request fails with the
        // same "context invalidated" error; log it once instead of per item.
        if (!contextInvalidated) console.error(`[ReVint] ${t("logBatchFailed", { url: item.url })}`, error, error?.stack || "");
      }
    };
    progress?.start(items.length);
    try {
      for (let index = 0; index < items.length && !contextInvalidated; index++) {
        await exportOne(items[index]);
        if (index < items.length - 1) await wait(BATCH_DELAY);
      }
      if (failed.length && !contextInvalidated) {
        const retry = failed.splice(0, failed.length);
        for (let index = 0; index < retry.length && !contextInvalidated; index++) {
          await exportOne(retry[index]);
          await wait(BATCH_DELAY * 2);
        }
      }
      if (!contextInvalidated) {
        console.info(`[ReVint] ${t("logSummary", { done: succeeded, total: items.length, extra: failed.length ? t("logSavedExtra", { count: failed.length }) : "" })}`);
        await wait(1500);
      }
    } finally {
      progress?.finish(contextInvalidated ? t("contextInvalidated") : "");
    }
  }

  function newItemUrl() {
    return `${location.origin}/items/new`;
  }

  function findMemberUrl() {
    const link = [...document.querySelectorAll('a[href*="/member/"]')]
      .find((element) => /\/member\/\d+/.test(element.getAttribute("href") || ""));
    return link ? new URL(link.href, location.href).href : "";
  }

  function userMenuTrigger() {
    return document.querySelector('[data-testid="user-menu-button"]')
      || document.querySelector('[data-testid*="user-menu"]')
      || document.querySelector('[data-testid*="avatar"], [data-testid*="profile"]')
      || [...document.querySelectorAll("button, [role='button']")].find((element) =>
        /profil|profile|konto|account|menü|menu|χρήστ|λογαριασ/i.test(element.getAttribute("aria-label") || "")
      )
      || null;
  }

  function userIdFromPayload(data) {
    if (!data || typeof data !== "object") return null;
    for (const candidate of [data.user, data.current_user, data.data, data]) {
      if (candidate && (typeof candidate.id === "number" || typeof candidate.id === "string")) return candidate.id;
    }
    return null;
  }

  async function findMemberUrlFromApi() {
    try {
      const response = await message({ type: "fetch-text", url: `${location.origin}/api/v2/users/current` });
      if (!response?.ok) return "";
      const id = userIdFromPayload(JSON.parse(response.text));
      return id ? `${location.origin}/member/${id}` : "";
    } catch (_) {
      return "";
    }
  }

  async function openMemberPage() {
    let url = findMemberUrl();
    if (!url) {
      const trigger = userMenuTrigger();
      if (trigger) {
        trigger.click();
        for (let attempt = 0; attempt < 12 && !url; attempt++) {
          await wait(150);
          url = findMemberUrl();
        }
      }
    }
    if (!url) url = await findMemberUrlFromApi();
    if (url) location.assign(url);
    else console.warn(`[ReVint] ${t("logNoMember")}`);
  }

  async function enqueueAutoImport(name) {
    try {
      const stored = await chrome.storage.local.get("revintPendingQueue");
      const queue = stored.revintPendingQueue || [];
      queue.push({ name, at: Date.now() });
      await chrome.storage.local.set({ revintPendingQueue: queue });
    } catch (error) {
      noteContextError(error);
    }
  }

  async function consumeAutoImport() {
    try {
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
    } catch (error) {
      noteContextError(error);
      return "";
    }
  }

  async function consumePendingBundle() {
    const response = await message({ type: "take-bundle" });
    return response?.ok ? response.bundle : null;
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
        `<button type="button" class="revint-collapse-button" aria-label="${t("togglePanel")}">▾</button>`,
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
      home.querySelector(".revint-home-button").addEventListener("click", openMemberPage);
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
      `<button type="button" class="revint-collapse-button" aria-label="${t("togglePanel")}">▾</button>`,
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
        ? [
            '<div class="revint-button-row">',
            `<button type="button" class="revint-button revint-export-all">${t("saveAll")}</button>`,
            `<button type="button" class="revint-button revint-export-active">${t("saveListed")}</button>`,
            '</div>',
            `<button type="button" class="revint-button revint-relist-file">${t("relistFromFile")}</button>`,
            '<input type="file" class="revint-relist-file-input" accept=".json,.revint.json,application/json" hidden>',
            '<div class="revint-button-row">',
            `<button type="button" class="revint-button revint-export-all-manual">${t("saveAllManual")}</button>`,
            `<button type="button" class="revint-button revint-export-active-manual">${t("saveListedManual")}</button>`,
            '</div>'
          ].join("")
        : `<button type="button" class="revint-button revint-manual-button">${t("manual")}</button><input type="file" accept=".json,.revint.json,application/json" hidden>`,
      '</div>',
      '<div class="revint-import-view" hidden>',
      '<div class="revint-progress revint-progress--import"><div class="revint-progress-bar"></div></div>',
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
    const importView = panel.querySelector(".revint-import-view");
    const importTrack = panel.querySelector(".revint-progress--import");
    const importBar = panel.querySelector(".revint-progress--import .revint-progress-bar");
    const report = (text) => console.info(`[ReVint] ${text}`);

    let wasCollapsed = true;
    panel.showProgress = () => {
      wasCollapsed = panel.classList.contains("revint-collapsed");
      panel.classList.add("revint-collapsed");
      const collapsedWidth = Math.round(panel.getBoundingClientRect().width);
      panel.classList.add("revint-importing");
      if (collapsedWidth) panel.style.width = `${collapsedWidth}px`;
      importView.hidden = false;
      importView.style.display = "flex";
      importTrack.style.display = "block";
      importBar.style.width = "0%";
    };
    panel.setProgress = (done, total) => {
      importBar.style.width = `${Math.min(100, Math.round((done / total) * 100))}%`;
    };
    panel.hideProgress = () => {
      panel.classList.remove("revint-importing");
      panel.style.width = "";
      importView.hidden = true;
      importView.style.display = "";
      importTrack.style.display = "";
      if (!wasCollapsed) panel.classList.remove("revint-collapsed");
    };

    const progress = {
      start(total) {
        revintBusy = true;
        panel.classList.add("revint-busy");
        busyNote.textContent = t("busy");
        busyNote.hidden = false;
        progressBar.style.width = "0%";
        progressLabel.textContent = `0/${total}`;
      },
      update(done, total) {
        progressBar.style.width = `${Math.min(100, Math.round((done / total) * 100))}%`;
        progressLabel.textContent = `${Math.min(done, total)}/${total}`;
      },
      finish(notice) {
        revintBusy = false;
        panel.classList.remove("revint-busy");
        if (notice) {
          busyNote.textContent = notice;
          busyNote.hidden = false;
        } else {
          busyNote.textContent = t("busy");
          busyNote.hidden = true;
        }
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

    const importBundle = async (bundle, name) => {
      panel.showProgress();
      try {
        rememberOriginal(bundle, name);
        await fillForm(bundle, report, (done, total) => panel.setProgress(done, total));
      } catch (error) {
        console.error(`[ReVint] ${t("logImportFailed")}`, error, error?.stack || "");
      } finally {
        panel.hideProgress();
        await refresh();
      }
    };

    const importFileByName = async (name) => {
      const loaded = await message({ type: "read-file", name });
      if (!loaded?.ok) {
        if (!contextInvalidated) console.error(`[ReVint] ${t("logFileReadFailed")}`, loaded?.error);
        return;
      }
      await importBundle(JSON.parse(loaded.text), name);
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
        if (!contextInvalidated) console.error(`[ReVint] ${t("logListFailed")}`, response?.error);
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
        for (let index = 0; index < names.length && !contextInvalidated; index++) {
          openButton.textContent = t("opening", { done: index + 1, total: names.length });
          await enqueueAutoImport(names[index]);
          await message({ type: "open-tab", url: newItemUrl(), active: false });
          progress.update(index + 1, names.length);
          if (index < names.length - 1) await wait(OPEN_DELAY);
        }
      } catch (error) {
        if (!contextInvalidated) console.error(`[ReVint] ${t("logOpenFailed")}`, error, error?.stack || "");
      } finally {
        progress.finish(contextInvalidated ? t("contextInvalidated") : "");
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
      const allManualButton = panel.querySelector(".revint-export-all-manual");
      const activeManualButton = panel.querySelector(".revint-export-active-manual");
      const exportButtons = [allButton, activeButton];
      const runExport = async (activeOnly) => {
        exportButtons.forEach((button) => { button.disabled = true; });
        try {
          await batchExport(memberItems(activeOnly), progress);
          await refresh();
        } finally {
          exportButtons.forEach((button) => { button.disabled = false; });
        }
      };
      allButton.addEventListener("click", () => runExport(false));
      activeButton.addEventListener("click", () => runExport(true));

      const manualButtons = [allManualButton, activeManualButton];
      const runManualExport = async (activeOnly) => {
        const items = memberItems(activeOnly);
        if (!items.length) {
          console.error(`[ReVint] ${t("logNoItems")}`);
          return;
        }
        manualButtons.forEach((button) => { button.disabled = true; });
        try {
          // The directory picker must run inside the click gesture, so it is
          // the first await after the synchronous item lookup above.
          const dirHandle = await pickSaveDirectory();
          if (!dirHandle) return;
          await batchExport(items, progress, (item) => saveCardToDirectory(item, () => {}, dirHandle));
        } finally {
          manualButtons.forEach((button) => { button.disabled = false; });
        }
      };
      allManualButton.addEventListener("click", () => runManualExport(false));
      activeManualButton.addEventListener("click", () => runManualExport(true));

      const relistFileButton = panel.querySelector(".revint-relist-file");
      const relistFileInput = panel.querySelector(".revint-relist-file-input");
      relistFileButton.addEventListener("click", () => relistFileInput.click());
      relistFileInput.addEventListener("change", async () => {
        const file = relistFileInput.files[0];
        relistFileInput.value = "";
        if (!file) return;
        try {
          const bundle = JSON.parse(await file.text());
          if (bundle?.format !== FORMAT || bundle?.version !== VERSION || !bundle.item) throw new Error(t("errInvalidFile"));
          const stored = await message({ type: "stash-bundle", bundle });
          if (!stored?.ok) throw new Error(stored?.error || t("errSave"));
          await message({ type: "open-tab", url: newItemUrl(), active: true });
        } catch (error) {
          console.error(`[ReVint] ${t("logImportFailed")}`, error, error?.stack || "");
        }
      });
    } else {
      const manualButton = panel.querySelector(".revint-manual-button");
      const input = panel.querySelector("input[type=file]");
      manualButton.addEventListener("click", () => input.click());
      input.addEventListener("change", async () => {
        panel.showProgress();
        try {
          const bundle = JSON.parse(await input.files[0].text());
          rememberOriginal(bundle, input.files[0].name);
          await fillForm(bundle, report, (done, total) => panel.setProgress(done, total));
        } catch (error) {
          console.error(`[ReVint] ${t("logImportFailed")}`, error, error?.stack || "");
        } finally {
          panel.hideProgress();
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
        consumePendingBundle().then((bundle) => {
          if (bundle) { importBundle(bundle); return; }
          consumeAutoImport().then((pending) => { if (pending) importFileByName(pending); });
        });
      }
    }
  }

  // Vinted renders button labels inside an inner element that carries the
  // webfont, so the font must be read from (and written to) that host rather
  // than the outer <button>.
  function textHost(element) {
    const original = clean(element.textContent);
    const nodes = [...element.querySelectorAll("*")];
    const exact = nodes.find((el) => !el.querySelector("*") && clean(el.textContent) === original);
    if (exact) return exact;
    const withText = nodes.filter((el) => clean(el.textContent));
    return withText.length ? withText[withText.length - 1] : element;
  }

  function applyTextStyle(target, source) {
    try {
      const style = getComputedStyle(source);
      target.style.fontFamily = style.fontFamily;
      target.style.fontSize = style.fontSize;
      target.style.fontWeight = style.fontWeight;
      target.style.fontStyle = style.fontStyle;
      target.style.lineHeight = style.lineHeight;
      target.style.letterSpacing = style.letterSpacing;
      target.style.textTransform = style.textTransform;
    } catch (_) {}
  }

  function setButtonLabel(button, label) {
    textHost(button).textContent = label;
  }

  function addSaveButtons() {
    const candidates = document.querySelectorAll("button:not([data-revint-scanned]), a:not([data-revint-scanned])");
    for (const push of candidates) {
      push.dataset.revintScanned = "1";
      if (!(push.matches?.('button[data-testid="bump-button"]') || /^(pushen|push|artikel pushen)$/i.test(clean(push.textContent)))) continue;
      const container = push.parentElement;
      if (!container || container.querySelector(":scope > .revint-button")) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "revint-button revint-inline";
      button.textContent = t("saveOne");
      applyTextStyle(button, textHost(push));
      button.addEventListener("click", () => exportItem(button));
      push.insertAdjacentElement("afterend", button);
    }
  }

  const STORAGE_ORIGINAL = "revintOriginal";
  const STORAGE_PENDING_DELETE = "revintDeleteAfterPublish";
  const PENDING_DELETE_TTL = 5 * 60 * 1000;

  const DRAFT_ACTION_LABELS = [
    "entwurf speichern", "save draft", "save as draft", "guardar borrador",
    "enregistrer le brouillon", "salva bozza", "opslaan als concept",
    "zapisz szkic", "salvesta mustand", "ulozit koncept", "mentés",
    "spara utkast", "gem kladde", "tallenna luonnos", "guardar rascunho",
    "saglabat melnrakstu", "issaugoti juodrasti", "salveaza ca ciorna",
    "shrani osnutek"
  ];
  const SUBMIT_ACTION_LABELS = [
    "hochladen", "upload", "publish", "publicar", "publier", "carica",
    "opublikuj", "δημοσίευση", "nahrát", "nahrať", "julkaise", "publica",
    "objavi", "публикуване", "ladda upp", "læg op", "lataa",
    "augšupielādēt", "įkelti", "încarcă", "naloži", "опубликовать"
  ];

  let formLabelsCache = null;

  function readJsonStorage(key) {
    try {
      const value = sessionStorage.getItem(key);
      return value ? JSON.parse(value) : null;
    } catch (_) {
      return null;
    }
  }

  function readOriginal() {
    const info = readJsonStorage(STORAGE_ORIGINAL);
    return info?.id ? info : null;
  }

  function rememberOriginal(bundle, filename) {
    const url = bundle?.item?.sourceUrl || "";
    const match = String(url).match(/\/items\/(\d+)/);
    if (!match) return;
    try {
      sessionStorage.setItem(STORAGE_ORIGINAL, JSON.stringify({ id: match[1], url, file: filename || "", at: Date.now() }));
    } catch (_) {}
    schedulePublishButton();
  }

  let publishButtonTimer = null;
  function schedulePublishButton() {
    if (document.querySelector(".revint-publish-delete")) return;
    if (!readOriginal()) return;
    addPublishDeleteButton();
    if (document.querySelector(".revint-publish-delete")) return;
    if (publishButtonTimer) return;
    let attempts = 0;
    publishButtonTimer = setInterval(() => {
      if (document.querySelector(".revint-publish-delete") || !readOriginal() || ++attempts > 30) {
        clearInterval(publishButtonTimer);
        publishButtonTimer = null;
        return;
      }
      addPublishDeleteButton();
    }, 500);
  }

  function csrfToken() {
    for (const script of document.scripts) {
      const text = script.textContent || "";
      const match = text.match(/CSRF_TOKEN\\?":\\?"([0-9A-Fa-f-]+)/);
      if (match) return match[1];
    }
    return "";
  }

  async function deleteOriginalItem(pending) {
    const token = csrfToken();
    if (!token) {
      console.warn(`[ReVint] ${t("logNoCsrf")}`);
      return false;
    }
    let origin = location.origin;
    try { origin = new URL(pending.url).origin; } catch (_) {}
    const response = await message({ type: "delete-item", url: `${origin}/api/v2/items/${pending.id}/delete`, csrfToken: token });
    return Boolean(response?.ok);
  }

  let consumingPendingDelete = false;
  async function consumePendingDelete() {
    if (consumingPendingDelete) return;
    const pending = readJsonStorage(STORAGE_PENDING_DELETE);
    if (!pending?.id) return;
    if (Date.now() - (pending.at || 0) > PENDING_DELETE_TTL) {
      try { sessionStorage.removeItem(STORAGE_PENDING_DELETE); } catch (_) {}
      return;
    }
    if (location.pathname.startsWith("/items/new")) return;
    consumingPendingDelete = true;
    try { sessionStorage.removeItem(STORAGE_PENDING_DELETE); } catch (_) {}
    try {
      if (await deleteOriginalItem(pending)) console.info(`[ReVint] ${t("logDeletedOriginal", { id: pending.id })}`);
      else console.error(`[ReVint] ${t("logDeleteOriginalFailed", { id: pending.id })}`);
    } finally {
      consumingPendingDelete = false;
    }
  }

  function vintedLabel(key) {
    for (const script of document.scripts) {
      const text = script.textContent || "";
      const index = text.indexOf(key);
      if (index === -1) continue;
      const match = text.slice(index + key.length).match(/^\\?":\\?"([^"\\]+)/);
      if (match) return match[1];
    }
    return "";
  }

  function formLabels() {
    if (!formLabelsCache) {
      formLabelsCache = {
        draft: vintedLabel("item_upload.form_actions.save_draft"),
        submit: vintedLabel("item_upload.form_actions.submit")
      };
    }
    return formLabelsCache;
  }

  function buttonMatchesText(button, labels) {
    const text = matchText(button.textContent);
    if (!text) return false;
    return labels.some((label) => {
      const target = matchText(label);
      return target.length > 2 && (text === target || text.includes(target));
    });
  }

  function findFormActionButtons() {
    const buttons = [...document.querySelectorAll("button, [role='button'], a[href]")]
      .filter(isInteractable)
      .filter((button) => !button.closest("header, nav, [role='navigation'], [role='tablist'], [role='tab'], .revint-panel, .revint-publish-delete"));
    const testId = (button) => button.getAttribute("data-testid") || "";
    const { draft: draftLabel, submit: submitLabel } = formLabels();
    const bottomOf = (button) => {
      try { return button.getBoundingClientRect().bottom; } catch (_) { return 0; }
    };
    const isDraft = (button) => {
      if (/draft/i.test(testId(button))) return true;
      const text = matchText(button.textContent);
      if (draftLabel && text === matchText(draftLabel)) return true;
      return buttonMatchesText(button, DRAFT_ACTION_LABELS);
    };
    const submitScore = (button) => {
      if (isDraft(button)) return 0;
      const text = matchText(button.textContent);
      if (submitLabel && text === matchText(submitLabel)) return 3;
      if (/submit|upload/i.test(testId(button))) return 2;
      return buttonMatchesText(button, SUBMIT_ACTION_LABELS) ? 1 : 0;
    };
    // The real publish button is the best-scoring, bottom-most candidate so a
    // top toolbar "save/upload" control cannot win over the footer bar.
    const submit = buttons
      .map((button) => ({ button, score: submitScore(button) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || bottomOf(b.button) - bottomOf(a.button))[0]?.button || null;
    let draft = null;
    if (submit?.parentElement) {
      draft = [...submit.parentElement.querySelectorAll("button, [role='button'], a[href]")].find(isDraft) || null;
    }
    if (!draft) draft = buttons.find(isDraft) || null;
    return { draft, submit };
  }

  function addPublishDeleteButton() {
    if (!readOriginal()) return;
    if (document.querySelector(".revint-publish-delete")) return;
    const { draft, submit } = findFormActionButtons();
    if (!submit) return;
    // Clone a native button so all layout/typography classes match exactly,
    // then only override the colours to signal the destructive action.
    const button = (draft || submit).cloneNode(true);
    button.type = "button";
    button.classList.add("revint-publish-delete");
    button.removeAttribute("data-testid");
    button.removeAttribute("id");
    button.removeAttribute("aria-label");
    button.removeAttribute("disabled");
    button.disabled = false;
    setButtonLabel(button, t("publishDelete"));
    button.style.setProperty("background", "#fff", "important");
    button.style.setProperty("border-color", "#c62828", "important");
    button.style.setProperty("color", "#c62828", "important");
    button.style.setProperty("flex", "0 0 auto", "important");
    button.addEventListener("click", () => uploadAndDelete(button));
    // Sit directly next to the real publish button in the footer action bar.
    submit.insertAdjacentElement("beforebegin", button);
    // Whatever layout Vinted uses, make the gaps around the new middle button
    // match so the spacing stays visually even.
    let gaps = null;
    try {
      if (draft) {
        const ours = button.getBoundingClientRect();
        const draftRect = draft.getBoundingClientRect();
        const submitRect = submit.getBoundingClientRect();
        if (ours.width && draftRect.width && submitRect.width) {
          const delta = (ours.left - draftRect.right) - (submitRect.left - ours.right);
          if (delta > 0.5) {
            const current = parseFloat(getComputedStyle(button).marginRight) || 0;
            button.style.setProperty("margin-right", `${current + delta}px`, "important");
          } else if (delta < -0.5) {
            const current = parseFloat(getComputedStyle(button).marginLeft) || 0;
            button.style.setProperty("margin-left", `${current - delta}px`, "important");
          }
          const after = button.getBoundingClientRect();
          const submitAfter = submit.getBoundingClientRect();
          gaps = { left: Math.round(after.left - draftRect.right), right: Math.round(submitAfter.left - after.right) };
        }
      }
    } catch (_) {}
    const parentStyle = submit.parentElement ? getComputedStyle(submit.parentElement) : null;
    console.info(`[ReVint] ${t("logSellActions")}`, {
      draft: clean(draft?.textContent),
      submit: clean(submit.textContent),
      display: parentStyle?.display,
      gap: parentStyle?.gap,
      draftMarginRight: draft ? getComputedStyle(draft).marginRight : "",
      submitMarginLeft: getComputedStyle(submit).marginLeft,
      gaps
    });
  }

  async function uploadAndDelete(button) {
    const original = readOriginal();
    const { submit } = findFormActionButtons();
    if (!original?.id || !submit) {
      console.warn(`[ReVint] ${t("logNoOriginal")}`);
      return;
    }
    try {
      sessionStorage.setItem(STORAGE_PENDING_DELETE, JSON.stringify({ ...original, at: Date.now() }));
    } catch (_) {}
    button.disabled = true;
    setButtonLabel(button, t("publishDeleteWorking"));
    await installUploadPatch();
    robustClick(submit);
    await wait(15000);
    if (document.body.contains(button)) {
      try { sessionStorage.removeItem(STORAGE_PENDING_DELETE); } catch (_) {}
      button.disabled = false;
      setButtonLabel(button, t("publishDelete"));
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

  // Like setField but also accepts an empty string (used to purge a field that
  // has latched onto an invalid value before retyping it).
  function forceValue(field, value) {
    if (!field) return false;
    try {
      const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")?.set.call(field, String(value));
    } catch (_) {
      try { field.value = String(value); } catch (_) {}
    }
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function lastDigitIndex(text) {
    for (let index = text.length - 1; index >= 0; index--) if (/\d/.test(text[index])) return index;
    return -1;
  }

  // React controlled inputs can show a value in the DOM while their internal
  // state stays empty; validation then treats the field as missing (the price
  // screenshots "at least 1.0 €" even though "3,00 €" is visible). Re-type the
  // last digit through real input events so the framework registers the value —
  // the same effect as deleting and retyping it by hand.
  function nudgeField(field) {
    if (!field) return;
    const before = String(field.value == null ? "" : field.value);
    const index = lastDigitIndex(before);
    if (index < 0) return;
    try {
      field.focus();
      field.setSelectionRange(index, index + 1);
      const deleted = document.execCommand("delete");
      const inserted = document.execCommand("insertText", false, before[index]);
      if (!deleted || !inserted || String(field.value) !== before) setField(field, before);
    } catch (_) {
      // Number inputs reject selection APIs; bounce the value instead.
      const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      try {
        Object.getOwnPropertyDescriptor(prototype, "value")?.set.call(field, "");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      } catch (_) {}
      setField(field, before);
    }
  }

  // Masked / controlled inputs (like Vinted's price field) sometimes ignore a
  // programmatic value but accept real text insertion, so simulate typing.
  function typeIntoField(field, value, options = {}) {
    if (!field || value === undefined || value === null || value === "") return false;
    const text = String(value);
    const read = () => String(field.value == null ? "" : field.value);
    try { field.focus(); } catch (_) {}
    try { field.setSelectionRange(0, field.value.length); } catch (_) {}
    let inserted = false;
    try { inserted = document.execCommand("insertText", false, text); } catch (_) { inserted = false; }
    if (!inserted || !read()) setField(field, text);
    if (options.nudge) nudgeField(field);
    return true;
  }

  async function clearField(field) {
    try { field.focus(); } catch (_) {}
    for (let attempt = 0; attempt < 8 && String(field.value || ""); attempt++) {
      try { field.setSelectionRange(0, field.value.length); } catch (_) {}
      let deleted = false;
      try { deleted = document.execCommand("delete"); } catch (_) { deleted = false; }
      if (!deleted) break;
      await wait(30);
    }
    if (String(field.value || "")) forceValue(field, "");
  }

  // Delete the current value and retype it through real edits so the widget's
  // own change handler runs (native value setters are ignored by some widgets).
  async function retypeField(field, text) {
    const target = String(text);
    await clearField(field);
    for (let attempt = 0; attempt < 2; attempt++) {
      try { field.focus(); field.setSelectionRange(0, field.value.length); } catch (_) {}
      let inserted = false;
      try { inserted = document.execCommand("insertText", false, target); } catch (_) { inserted = false; }
      if (inserted && String(field.value) === target) return;
      await wait(40);
    }
    forceValue(field, target);
  }

  // Some masks only commit when characters arrive one at a time.
  async function typeFieldCharByChar(field, text) {
    await clearField(field);
    let ok = false;
    try {
      for (const char of String(text)) {
        if (!document.execCommand("insertText", false, char)) { ok = false; break; }
        ok = true;
        await wait(30);
      }
    } catch (_) { ok = false; }
    if (!ok || String(field.value) !== String(text)) forceValue(field, text);
  }

  // Heuristic: does the widget currently show a validation error for this field?
  function priceErrorShown(field) {
    if (!field) return false;
    if (field.getAttribute("aria-invalid") === "true") return true;
    const scope = field.closest("div, section, form") || field.parentElement;
    if (!scope) return false;
    const nodes = scope.querySelectorAll("[role='alert'], [class*='error' i], [class*='invalid' i], [class*='danger' i], [data-testid*='error' i]");
    for (const node of nodes) {
      if (node.closest(".revint-panel")) continue;
      if (clean(node.textContent)) return true;
    }
    return false;
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
    .toLowerCase()
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

  // Matchers are intentionally multilingual: the sell form labels come from
  // Vinted in the marketplace language, while t(...) only knows the few UI
  // languages ReVint ships. Test-ids are tried first and are language-neutral.
  const FIELD_LABELS = {
    category: ["kategorie", "category", "categoría", "catégorie", "categoria", "categorie", "kategoria", "κατηγορία", "kategória", "kategorija", "категория"],
    condition: ["zustand", "condition", "estado", "état", "stato", "condizione", "staat", "conditie", "stan", "kunto", "skick", "stav", "állapot", "stare", "seisukord", "būklė", "stāvoklis", "starea", "stanje", "κατάσταση", "състояние"],
    brand: ["marke", "brand", "marca", "marque", "merk", "brend", "znamka", "märke", "mærke", "brändi", "μάρκα", "марка"],
    color: ["farbe", "colour", "color", "kleur", "couleur", "colore", "kolor", "värv", "krāsa", "spalva", "culoare", "barva", "färg", "farve", "väri", "χρώμα", "цвят"],
    platform: ["plattform", "platform", "plataforma", "plateforme", "piattaforma", "platforma", "platvorm", "platformă", "πλατφόρμα", "платформа"],
    size: ["größe", "groesse", "size", "talla", "taille", "taglia", "maat", "rozmiar", "suurus", "izmērs", "dydis", "mărime", "velikost", "storlek", "størrelse", "koko", "μέγεθος", "размер"],
    rating: ["altersbeschränkung", "age rating", "clasificación", "classification", "classificazione", "leeftijdsclassificatie", "klasyfikacja", "vanusepiirang", "vecuma ierobežojums", "amžiaus reitingas", "clasificare", "starostna omejitev", "åldersgräns", "aldersgrænse", "ikäraja", "ηλικιακή διαβάθμιση", "възрастова оценка"],
    material: ["material"]
  };

  function dropdownOpener(label, testidHints, avoidWords) {
    const direct = firstBySelectors(testidHints || []);
    if (direct) return direct;
    const needles = (Array.isArray(label) ? label : [label]).map(matchText).filter(Boolean);
    if (!needles.length) return null;
    let best = null;
    let bestPenalty = 9;
    let bestKids = Infinity;
    const candidates = document.querySelectorAll("[role='button'], button, [tabindex], input[readonly], li, div");
    for (const element of candidates) {
      if (!isInteractable(element)) continue;
      if (element.closest("a[href], header, nav, [role='navigation'], [role='tablist'], [role='tab'], .revint-panel")) continue;
      if (element.querySelector("input, textarea")) continue;
      const text = matchText(element.textContent || element.getAttribute("placeholder") || element.value || "");
      const matched = needles.some((needle) => text === needle || (text.includes(needle) && text.length <= needle.length + 14));
      if (!matched) continue;
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

  async function waitForDropdownOpener(label, testidHints, avoidWords, timeout = 4000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const opener = dropdownOpener(label, testidHints, avoidWords);
      if (opener) return opener;
      if (Date.now() >= deadline) return null;
      await wait(150);
    }
  }

  function categoryOpener() {
    return dropdownOpener(FIELD_LABELS.category, [
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
    const nodes = root.querySelectorAll("button, li, div, span, p, a[href*='/catalog/'], [role='button'], [role='option'], [role='menuitem'], [aria-label]");
    for (const element of nodes) {
      if (!isInteractable(element)) continue;
      if (element.closest(".revint-panel, header, nav, footer, [role='navigation'], [role='tablist'], [role='tab'], [data-testid^='catalog-navigation']")) continue;
      if (element.closest("a[href]:not([href*='/catalog/'])")) continue;
      if (element.querySelector("input, textarea")) continue;
      const texts = [element.textContent, element.getAttribute("aria-label"), element.getAttribute("title"), element.dataset?.value]
        .filter(Boolean).map(matchText).filter(Boolean);
      if (!texts.length) continue;
      if (texts.some((text) => text === target)) exact.push(element);
      else if (!partial && texts.some((text) => text.includes(target) && text.length <= target.length + 24)) partial = element;
    }
    exact.sort((a, b) => a.getElementsByTagName("*").length - b.getElementsByTagName("*").length);
    return exact[0] || partial;
  }

  async function clickCategoryLevel(id, name) {
    const nameParts = String(name || "").split(/[,/|]/).map((part) => part.trim()).filter(Boolean);
    for (let attempt = 0; attempt < 20; attempt++) {
      const container = pickerContainer();
      if (container && id) {
        const icon = container.querySelector(`[data-testid='catalog-icon-${id}']`)
          || container.querySelector(`[data-testid*='catalog-icon-${id}']`)
          || container.querySelector(`[data-value='${id}'], [value='${id}']`);
        if (icon && isInteractable(icon)) { clickableTarget(icon).click(); return true; }
      }
      for (const part of nameParts.length ? nameParts : [name]) {
        const row = (container && rowMatch(container, part)) || rowMatch(document.body, part);
        if (row) { clickableTarget(row).click(); return true; }
      }
      await wait(150);
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
        console.warn(`[ReVint] ${t("logNoCategoryField")}`);
        return 0;
      }
      for (let attempt = 0; attempt < 16 && !pickerContainer(); attempt++) {
        opener.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        opener.click();
        opener.focus?.();
        await wait(120);
      }
    }
    if (!pickerContainer()) {
      console.warn(`[ReVint] ${t("logNoCategoryPicker")}`);
      return 0;
    }

    let filled = 0;
    for (let index = 0; index < path.length; index++) {
      if (!location.pathname.startsWith("/items/new")) {
        console.warn(`[ReVint] ${t("logLeftForm")}`);
        break;
      }
      const segment = path[index];
      status(t("catLevelStatus", { done: index + 1, total: path.length, name: segment.title || segment.id }));
      if (!await clickCategoryLevel(segment.id ?? null, segment.title || "")) {
        console.warn(`[ReVint] ${t("logCategoryLevel")}`, segment);
        break;
      }
      filled++;
      await wait(170);
    }

    if (filled < path.length) {
      const leaf = path.at(-1)?.title || "";
      const search = categorySearchInput();
      if (search && leaf) {
        status(t("catSearch", { name: leaf }));
        setField(search, leaf);
        search.dispatchEvent(new Event("keyup", { bubbles: true }));
        for (let attempt = 0; attempt < 12; attempt++) {
          await wait(120);
          const result = rowMatch(pickerContainer() || document.body, leaf);
          if (result) { clickableTarget(result).click(); filled = path.length; break; }
        }
      }
    }

    if (filled > 0) {
      await wait(120);
      const save = dropdownSaveButton();
      if (save) robustClick(save);
      for (let attempt = 0; attempt < 16 && pickerVisible(); attempt++) await wait(120);
    }

    if (!filled) {
      console.warn(`[ReVint] ${t("logCategoryFail")}`);
      return 0;
    }
    status(t("catDone", { done: filled, total: path.length }));
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
    const opener = await waitForDropdownOpener(label, testidHints, avoidWords);
    if (!opener) {
      console.warn(`[ReVint] ${t("logFieldNotFound", { name: logName })}`);
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
      console.warn(`[ReVint] ${t("logOptionNotFound", { name: logName, options: values.join(" / ") })}`);
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
    if (!verified) console.warn(`[ReVint] ${t("logNotApplied", { name: logName })}`);
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
        `[name="item[${name}]"]`,
        `#${name}`,
        `[data-testid='category-${name}-single-list-input']`,
        `[data-testid='category-${name}-single-list_search-input']`,
        `[data-testid='category-${name}-multi-list-input']`,
        `[data-testid='${name}-select-dropdown-input']`,
        `[data-testid='${name}-select-dropdown-chevron']`,
        `[data-testid='${name}-select-dropdown']`,
        `[data-testid='${name}-select']`
      );
    }
    return selectors;
  }

  async function fillAttribute(code, labels, candidates, status, avoidWords, logName) {
    const values = (candidates || []).filter(Boolean);
    if (!values.length) return false;
    return fillVintedDropdown(labels, attributeSelectors(code), values, logName || labels[0], status, avoidWords);
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
        status(`${t("notePlatform")}: ${name} …`);
        robustClick(direct);
        await wait(300);
        filled = true;
        continue;
      }
      if (await fillAttribute("video_game_platform", FIELD_LABELS.platform, [name], status, undefined, t("notePlatform"))) filled = true;
    }
    return filled;
  }

  async function fillBrand(item, status = () => {}) {
    const brand = clean(item?.brand);
    if (!brand) return false;
    const opener = await waitForDropdownOpener(FIELD_LABELS.brand, ["[data-testid='brand-select-dropdown-input']", "[name='brand']"]);
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
        await wait(100);
        const row = exactRowMatch(pickerContainer() || document.body, brand) || exactRowMatch(document.body, brand);
        if (!row) continue;
        status(`${t("noteBrand")}: ${brand} …`);
        robustClick(row);
        await wait(120);
        const save = dropdownSaveButton();
        if (save) { try { clickableTarget(save).click(); } catch (_) {} await wait(120); }
        return true;
      }
    }
    console.warn(`[ReVint] ${t("logBrandNotFound", { name: brand })}`);
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
      await wait(100);
    }
  }

  async function fillColor(item, status = () => {}) {
    const colors = [...new Set((item?.colors || [])
      .flatMap((value) => String(value).split(/[,;/]/))
      .map((value) => value.trim())
      .filter(Boolean))].slice(0, 2);
    if (!colors.length) return false;
    const opener = await waitForDropdownOpener(FIELD_LABELS.color, attributeSelectors("color"));
    if (!opener) {
      console.warn(`[ReVint] ${t("logNoColorField")}`);
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
      await wait(100);
      const color = remaining[0];
      const row = rowByAnyText(pickerContainer() || document.body, color) || rowByAnyText(document.body, color);
      if (!row) continue;
      status(`${t("noteColor")}: ${color} …`);
      robustClick(clickableTarget(row));
      remaining.splice(0, 1);
      await wait(120);
    }

    const save = dropdownSaveButton();
    if (save) { try { clickableTarget(save).click(); } catch (_) {} await wait(120); }
    opener.blur?.();
    await dismissOverlays();

    const selected = matchText(opener.value || opener.textContent || "");
    const applied = colors.some((color) => selected.includes(matchText(color)));
    if (!applied) console.warn(`[ReVint] ${t("logColorFail", { name: colors.join(" / ") })}`);
    return applied;
  }

  function materialCandidates(value) {
    return [...new Set(String(value || "").split(/[,;\/]/).map((part) => part.trim()).filter(Boolean))];
  }

  function formatPrice(value) {
    let raw = String(value == null ? "" : value).replace(/[^\d.,]/g, "");
    if (!raw) return "";
    const lastComma = raw.lastIndexOf(",");
    const lastDot = raw.lastIndexOf(".");
    if (lastComma !== -1 && lastDot !== -1) {
      raw = lastComma > lastDot ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(/,/g, "");
    } else if (lastComma !== -1) {
      raw = raw.length - lastComma - 1 === 3 ? raw.replace(/,/g, "") : raw.replace(",", ".");
    } else if (lastDot !== -1) {
      if (raw.length - lastDot - 1 === 3) raw = raw.replace(/\./g, "");
    }
    const number = Number(raw);
    return Number.isFinite(number) ? String(number) : raw;
  }

  function priceField() {
    const fields = [...document.querySelectorAll("input:not([type=file]), textarea")].filter(isInteractable);
    const exclude = /original|discount|strikethrough|shipping|parcel|versand|rabatt|metav|μεταφορ|έκπτωσ|αρχικ/i;
    const labeled = fields.find((field) => {
      const label = norm(`${field.name || ""} ${field.id || ""} ${field.dataset?.testid || ""}`);
      return /price|preis|τιμ/.test(label) && !exclude.test(label);
    });
    return labeled || fieldBy(["0,00"]) || fieldBy(["0.00"]) || null;
  }

  async function setTextWhenReady(hints, value, timeout = 5000) {
    if (!value) return false;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const field = fieldBy(hints);
      if (field) return typeIntoField(field, value, { nudge: true });
      await wait(200);
    }
    return false;
  }



  async function setPrice(value) {
    const price = formatPrice(value);
    if (!price) {
      console.warn(`[ReVint] ${t("logNoPrice")}`);
      return false;
    }
    let field = null;
    for (let attempt = 0; attempt < 12 && !field; attempt++) {
      field = priceField();
      if (!field) await wait(300);
    }
    if (!field) {
      console.warn(`[ReVint] ${t("logNoPriceField")}`);
      return false;
    }
    const numeric = Number(price);
    if (!Number.isFinite(numeric)) {
      console.warn(`[ReVint] ${t("logPriceFail")}`, { value, reason: "not a number" });
      return false;
    }
    // Vinted parses the raw input with Number(), so a comma yields NaN and its
    // own preview renders "NaN €". Only ever write the dot form ("3", "12.5");
    // never the locale separator.
    const canonical = String(numeric);
    const parse = (input) => {
      const text = String(input == null ? "" : input).replace(/[^\d.,-]/g, "").replace(",", ".");
      if (!text) return NaN;
      const number = Number(text);
      return Number.isFinite(number) ? number : NaN;
    };
    const isBad = (input) => /nan/i.test(String(input == null ? "" : input));
    const good = () => !isBad(field.value) && parse(field.value) === numeric;

    // Vinted's price widget keeps its own state; a plain programmatic value can
    // leave validation complaining even though the text is visible. Always go
    // through a real clear + retype (what works by hand), then re-check the
    // widget's own error state.
    for (let attempt = 0; attempt < 3; attempt++) {
      await retypeField(field, canonical);
      await wait(220);
      try { field.blur?.(); } catch (_) {}
      await wait(160);
      if (good() && !priceErrorShown(field)) return true;
      if (attempt === 0) {
        await typeFieldCharByChar(field, canonical);
        try { field.blur?.(); } catch (_) {}
        await wait(220);
        if (good() && !priceErrorShown(field)) return true;
      }
      field = priceField() || field;
    }
    console.warn(`[ReVint] ${t("logPriceFail")}`, {
      value, numeric: canonical, current: field?.value, errorShown: priceErrorShown(field)
    });
    return false;
  }

  async function waitForFileInput(timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const input = [...document.querySelectorAll('input[type="file"]')].find((element) => !element.closest(".revint-panel"));
      if (input) return input;
      await wait(200);
    }
    return null;
  }

  function dataUrlFile(image) {
    const bytes = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0));
    return new File([bytes], image.name, { type: image.type });
  }

  async function fillForm(bundle, status, progress = () => {}) {
    if (bundle?.format !== FORMAT || bundle?.version !== VERSION || !bundle.item) throw new Error(t("errInvalidFile"));
    const item = bundle.item;
    console.info(`[ReVint] ${t("logImportData")}`, item);
    // Let the page patch the values its widgets refuse to submit.
    setUploadPatch(item);
    await installUploadPatch();
    const total =
      3 +
      1 +
      1 +
      (item.platforms?.length ? 1 : 0) +
      (item.size ? 1 : 0) +
      (item.ageRating ? 1 : 0) +
      (item.brand ? 1 : 0) +
      (item.colors?.length ? 1 : 0) +
      (item.material ? 1 : 0) +
      (item.isbn ? 1 : 0) +
      (item.price ? 1 : 0);
    let done = 0;
    const step = () => progress(++done, total);

    let filled = 0;
    step();
    if (await setTextWhenReady(["titel", "title"], item.title, 8000)) filled++;
    step();
    if (await setTextWhenReady(["beschreibung", "description"], item.description, 8000)) filled++;

    step();
    const fileInput = await waitForFileInput();
    if (fileInput && item.images?.length) {
      const transfer = new DataTransfer();
      item.images.forEach((image) => transfer.items.add(dataUrlFile(image)));
      fileInput.files = transfer.files;
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      filled += item.images.length;
      await wait(800);
    } else if (!item.images?.length) console.error(`[ReVint] ${t("logNoImages")}`);
    else console.error(`[ReVint] ${t("logNoFileInput")}`);

    step();
    const categories = await fillCategory(item);
    step();
    const condition = await fillVintedDropdown(FIELD_LABELS.condition, [
      "[data-testid='condition-select-dropdown-input']",
      "[data-testid='condition-select-dropdown-chevron']",
      "[data-testid='status-select-dropdown-input']"
    ], conditionCandidates(item.condition), t("noteCondition"), status);
    step();
    const platforms = await fillPlatforms(item, status);
    step();
    const size = await fillAttribute("size", FIELD_LABELS.size, sizeCandidates(item.size), status,
      ["versand", "paket", "pushen", "schneller", "sichtbarkeit", "spotlight", "shipping", "parcel", "bump", "faster", "visibility"], t("noteSize"));
    step();
    const ageRating = await fillAttribute("video_game_ratings", FIELD_LABELS.rating, [item.ageRating], status, undefined, t("noteRating"));
    step();
    const brand = await fillBrand(item, status);
    step();
    const colors = await fillColor(item, status);
    step();
    const material = await fillAttribute("material", FIELD_LABELS.material, materialCandidates(item.material), status, undefined, t("noteMaterial"));
    step();
    const isbn = await setTextWhenReady(["isbn"], item.isbn);
    if (isbn) filled++;
    step();
    const price = await setPrice(item.price);
    if (price) filled++;
    const note = (key, ok) => t(ok ? key : "noteManual", { name: t(key) });
    const notes = [
      categories ? t("noteCategoryLevels", { count: categories }) : t("noteManual", { name: t("noteCategory") }),
      note("noteCondition", condition)
    ];
    if (item.brand) notes.push(note("noteBrand", brand));
    if (item.colors?.length) notes.push(note("noteColor", colors));
    if (item.material) notes.push(note("noteMaterial", material));
    if (item.platforms?.length) notes.push(note("notePlatform", platforms));
    if (item.size) notes.push(note("noteSize", size));
    if (item.ageRating) notes.push(note("noteRating", ageRating));
    if (item.isbn) notes.push(note("noteIsbn", isbn));
    if (!price) notes.push(t("notePriceManual"));
    status(t("noteSummary", { count: filled, notes: notes.join(", ") }));
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

  let loadedLogged = false;
  let newFormDebugLogged = false;
  function logNewFormDebug() {
    if (newFormDebugLogged) return;
    newFormDebugLogged = true;
    setTimeout(() => {
      try {
        const buttons = [...document.querySelectorAll("button, [role='button'], a[href]")]
          .filter(isInteractable)
          .map((button) => `${clean(button.textContent).slice(0, 24)}|${button.getAttribute("data-testid") || ""}`);
        console.info("[ReVint] new-form debug", {
          host: location.hostname,
          language: detectedLanguage,
          publishLabel: MESSAGES.publishDelete,
          original: readOriginal(),
          hasButton: !!document.querySelector(".revint-publish-delete"),
          labels: formLabels(),
          buttons: buttons.slice(0, 40)
        });
      } catch (_) {}
    }, 3000);
  }

  async function run() {
    if (!messagesReady) await loadMessages();
    if (!loadedLogged) {
      loadedLogged = true;
      console.info(`[ReVint] ${t("logLoaded", { version: chrome.runtime?.getManifest?.().version || "?" })}`, { language: detectedLanguage, host: location.hostname });
    }
    consumePendingDelete();
    if (location.pathname.startsWith("/items/new")) {
      addPanel("new");
      addPublishDeleteButton();
      logNewFormDebug();
    } else if (location.pathname.startsWith("/member")) {
      addPanel("member");
      addSaveButtons();
    } else if (location.pathname === "/") {
      addPanel("home");
    }
  }

  let runScheduled = false;
  let lastRunAt = 0;
  const scheduleRun = () => {
    if (runScheduled) return;
    runScheduled = true;
    const delay = Math.max(0, 200 - (Date.now() - lastRunAt));
    setTimeout(() => {
      runScheduled = false;
      lastRunAt = Date.now();
      run();
    }, delay);
  };
  const hasElementAdditions = (mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) if (node.nodeType === 1) return true;
    }
    return false;
  };
  run();
  new MutationObserver((mutations) => { if (hasElementAdditions(mutations)) scheduleRun(); })
    .observe(document.documentElement, { childList: true, subtree: true });
})();
