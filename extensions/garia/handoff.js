// chrome.tabs.create cannot open a custom scheme on every Chromium build.
// Navigating this extension page to garia:// can, and then the tab is closed
// from the background script.
const params = new URLSearchParams(location.search);
if (params.get("url")) {
  location.href = `garia://add?${params.toString()}`;
}
