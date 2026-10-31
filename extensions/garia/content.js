// Safari has no chrome.downloads, so a click on a file link is the
// intercept. Chromium has both: preventDefault here so the browser never
// starts a download the background would then have to cancel. Hold Option
// (or Alt) to leave the file with the browser. Options → Click capture
// turns the whole intercept off.

const api = globalThis.browser?.runtime ? globalThis.browser : globalThis.chrome;

let clickCapture = true;

function refreshPrefs() {
  if (typeof gariaLoadPrefs !== "function") return;
  gariaLoadPrefs().then(({ prefs }) => {
    clickCapture = prefs.clickCapture !== false;
  }).catch(() => {});
}

refreshPrefs();
if (api?.storage?.onChanged) {
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.prefs) refreshPrefs();
  });
}

function sendFileCapture(href, name) {
  api.runtime.sendMessage({
    type: "capture",
    url: href,
    name,
    referrer: location.href,
  });
}

document.addEventListener("click", (event) => {
  if (!clickCapture) return;
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const a = event.target.closest?.("a[href]");
  if (a) {
    let href;
    try { href = new URL(a.href, document.baseURI).href; } catch { return; }
    if (typeof gariaIsFileUrl !== "function" || !gariaIsFileUrl(href)) return;

    event.preventDefault();
    event.stopPropagation();

    const name = a.getAttribute("download") || gariaBasenameFromUrl(href);
    sendFileCapture(href, name);
    return;
  }

  const video = event.target.closest?.("video");
  const src = video?.currentSrc || video?.src;
  if (!src) return;
  let href;
  try { href = new URL(src, document.baseURI).href; } catch { return; }
  if (typeof gariaIsFileUrl !== "function" || !gariaIsFileUrl(href)) return;

  event.preventDefault();
  event.stopPropagation();
  sendFileCapture(href, gariaBasenameFromUrl(href));
}, true);

function absoluteUrl(raw) {
  if (!raw) return "";
  try { return new URL(raw, document.baseURI).href; } catch { return ""; }
}

function collectSrcsetUrls(value) {
  const out = [];
  for (const part of String(value || "").split(",")) {
    const url = absoluteUrl(part.trim().split(/\s+/)[0]);
    if (url) out.push(url);
  }
  return out;
}

function collectMetaVideos() {
  const out = [];
  for (const meta of document.querySelectorAll(
    'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]',
  )) {
    const url = absoluteUrl(meta.getAttribute("content"));
    if (url) out.push(url);
  }
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent || "null");
      const stack = Array.isArray(data) ? data.slice() : [data];
      while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== "object") continue;
        if (typeof node.contentUrl === "string") {
          const url = absoluteUrl(node.contentUrl);
          if (url) out.push(url);
        }
        if (typeof node.embedUrl === "string") {
          const url = absoluteUrl(node.embedUrl);
          if (url) out.push(url);
        }
        for (const value of Object.values(node)) {
          if (value && typeof value === "object") stack.push(value);
        }
      }
    } catch { /* ignore bad JSON-LD */ }
  }
  return out;
}

function collectPageLinks() {
  const links = [];
  for (const a of document.querySelectorAll("a[href]")) {
    try { links.push(new URL(a.href, document.baseURI).href); } catch { /* skip */ }
  }
  const media = [];
  const downloadHrefs = [];
  const srcsetUrls = [];
  const streamUrls = [];
  const nodes = document.querySelectorAll(
    "video[src], audio[src], video source[src], audio source[src], video[srcset], source[srcset]",
  );
  for (const node of nodes) {
    const raw = node.currentSrc || node.getAttribute("src") || "";
    const url = absoluteUrl(raw);
    if (url) media.push(url);
    if (node.getAttribute("srcset")) srcsetUrls.push(...collectSrcsetUrls(node.getAttribute("srcset")));
  }
  for (const a of document.querySelectorAll("a[download][href]")) {
    const url = absoluteUrl(a.href);
    if (url) downloadHrefs.push(url);
  }
  for (const a of document.querySelectorAll("a[href]")) {
    const url = absoluteUrl(a.href);
    if (url && /\.m3u8(\?|#|$)/i.test(url)) streamUrls.push(url);
  }
  const metaVideos = collectMetaVideos();
  if (typeof gariaCaptureTargets === "function") {
    return gariaCaptureTargets({
      pageUrl: location.href,
      links,
      media,
      metaVideos,
      downloadHrefs,
      srcsetUrls,
      streamUrls,
    });
  }
  return links;
}

if (window === window.top) {
  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "collect-links") return;
    sendResponse({ urls: collectPageLinks() });
  });
}
