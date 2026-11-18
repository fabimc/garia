// chrome.tabs.create cannot open a custom scheme on every Chromium build.
// Navigating this extension page to garia:// can. Keep the page open because
// the browser may need the user to approve the protocol handler.
//
// A long "download all" list will not fit in the scheme, so it arrives in
// the hash and is copied to the clipboard. Garia reads that dump when the
// link is batch=1 with no urls.
(function handoff() {
  const params = new URLSearchParams(location.search);
  const packed = location.hash.startsWith("#")
    ? decodeURIComponent(location.hash.slice(1))
    : "";
  async function open() {
    if (packed && !params.get("urls")) {
      try { await navigator.clipboard.writeText(packed); } catch { /* scheme still opens */ }
      params.set("batch", "1");
      if (!params.get("from")) params.set("from", "extension");
    }
    location.href = `garia://add?${params.toString()}`;
  }
  if (params.get("url") || params.get("urls") || params.get("batch") || packed) {
    const retry = document.getElementById("retry");
    retry.hidden = false;
    retry.addEventListener("click", open);
    open();
  }
})();
