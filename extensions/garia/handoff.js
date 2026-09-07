// chrome.tabs.create cannot open a custom scheme on every Chromium build.
// Navigating this extension page to garia:// can, and then the tab is closed
// from the background script.
//
// A long "download all" list will not fit in the scheme, so it arrives in
// the hash and is copied to the clipboard. Garia reads that dump when the
// link is batch=1 with no urls.
(async function handoff() {
  const params = new URLSearchParams(location.search);
  const packed = location.hash.startsWith("#")
    ? decodeURIComponent(location.hash.slice(1))
    : "";
  if (packed && !params.get("urls")) {
    try { await navigator.clipboard.writeText(packed); } catch { /* scheme still opens */ }
    params.set("batch", "1");
    if (!params.get("from")) params.set("from", "extension");
  }
  if (params.get("url") || params.get("urls") || params.get("batch")) {
    location.href = `garia://add?${params.toString()}`;
  }
})();
