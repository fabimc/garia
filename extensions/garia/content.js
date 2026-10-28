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

function collectPageLinks() {
  const links = [];
  for (const a of document.querySelectorAll("a[href]")) {
    try { links.push(new URL(a.href, document.baseURI).href); } catch { /* skip */ }
  }
  const media = [];
  const nodes = document.querySelectorAll(
    "video[src], audio[src], video source[src], audio source[src], a[download][href]",
  );
  for (const node of nodes) {
    const raw = node.currentSrc || node.getAttribute("src") || node.href || "";
    if (!raw) continue;
    try { media.push(new URL(raw, document.baseURI).href); } catch { /* skip */ }
  }
  if (typeof gariaCaptureTargets === "function") {
    return gariaCaptureTargets({ pageUrl: location.href, links, media });
  }
  return links;
}

if (window === window.top) {
  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "collect-links") return;
    sendResponse({ urls: collectPageLinks() });
  });
}
