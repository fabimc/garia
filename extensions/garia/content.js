// Safari has no chrome.downloads, so a click on a file link is the
// intercept. Chromium has both: preventDefault here so the browser never
// starts a download the background would then have to cancel. Hold Option
// (or Alt) to leave the file with the browser.
document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const a = event.target.closest?.("a[href]");
  if (!a) return;

  let href;
  try { href = new URL(a.href, document.baseURI).href; } catch { return; }
  if (typeof gariaIsFileUrl !== "function" || !gariaIsFileUrl(href)) return;

  event.preventDefault();
  event.stopPropagation();

  const api = globalThis.browser?.runtime ? globalThis.browser : globalThis.chrome;
  const name = a.getAttribute("download") || gariaBasenameFromUrl(href);
  api.runtime.sendMessage({
    type: "capture",
    url: href,
    name,
    referrer: location.href,
  });
}, true);

const api = globalThis.browser?.runtime ? globalThis.browser : globalThis.chrome;

function collectPageLinks() {
  const page = location.href.split("#")[0];
  const seen = new Set();
  const urls = [];
  for (const a of document.querySelectorAll("a[href]")) {
    let href;
    try { href = new URL(a.href, document.baseURI).href; } catch { continue; }
    if (!(href.startsWith("magnet:") || /^https?:/i.test(href))) continue;
    const bare = href.split("#")[0];
    if (bare === page) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    urls.push(href);
  }
  return urls;
}

if (window === window.top) {
  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "collect-links") return;
    sendResponse({ urls: collectPageLinks() });
  });
}
