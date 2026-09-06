// Service workers do not import the content-script files. Chromium loads
// this file alone; Safari's `background.scripts` list loads file-types.js
// first. The importScripts call covers Chromium.
if (typeof importScripts === "function" && typeof gariaIsFileUrl !== "function") {
  importScripts("file-types.js");
}

const api = globalThis.browser?.runtime ? globalThis.browser : globalThis.chrome;
const recent = new Map();

function alreadySent(url) {
  const now = Date.now();
  for (const [key, at] of recent) {
    if (now - at > 2500) recent.delete(key);
  }
  if (recent.has(url)) return true;
  recent.set(url, now);
  return false;
}

function sendToGaria(url, extras = {}) {
  if (!url || alreadySent(url)) return;
  const params = new URLSearchParams();
  params.set("url", url);
  params.set("from", extras.from || "extension");
  if (extras.name) params.set("name", extras.name);
  if (extras.referrer) params.set("referrer", extras.referrer);
  if (extras.confirm) params.set("confirm", "1");
  const handoff = api.runtime.getURL(`handoff.html?${params.toString()}`);
  const opened = api.tabs.create({ url: handoff, active: false });
  Promise.resolve(opened).then((tab) => {
    if (!tab?.id) return;
    setTimeout(() => {
      api.tabs.remove(tab.id).catch(() => {});
    }, 1500);
  }).catch(() => {});
}

function installMenus() {
  api.contextMenus.removeAll(() => {
    api.contextMenus.create({
      id: "garia-link",
      title: "Download with Garia",
      contexts: ["link"],
    });
    api.contextMenus.create({
      id: "garia-selection",
      title: "Download with Garia",
      contexts: ["selection"],
    });
    api.contextMenus.create({
      id: "garia-page",
      title: "Send this page to Garia",
      contexts: ["page", "frame", "video", "audio"],
    });
  });
}

api.runtime.onInstalled.addListener(installMenus);
if (api.runtime.onStartup) api.runtime.onStartup.addListener(installMenus);
installMenus();

api.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "garia-link" && info.linkUrl) {
    const name = gariaIsFileUrl(info.linkUrl) ? gariaBasenameFromUrl(info.linkUrl) : "";
    sendToGaria(info.linkUrl, {
      from: "extension",
      name,
      referrer: info.pageUrl || tab?.url || "",
      confirm: gariaIsFileUrl(info.linkUrl),
    });
    return;
  }
  if (info.menuItemId === "garia-selection") {
    const url = urlFromSelection(info.selectionText || "");
    if (url) {
      sendToGaria(url, {
        from: "extension",
        name: gariaIsFileUrl(url) ? gariaBasenameFromUrl(url) : "",
        referrer: info.pageUrl || tab?.url || "",
        confirm: gariaIsFileUrl(url),
      });
    }
    return;
  }
  if (info.menuItemId === "garia-page") {
    const url = info.pageUrl || tab?.url;
    if (url && gariaIsHttpUrl(url)) sendToGaria(url, { from: "extension" });
  }
});

api.action.onClicked.addListener((tab) => {
  const url = tab?.url;
  if (url && gariaIsHttpUrl(url)) sendToGaria(url, { from: "extension" });
});

api.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "capture" || !message.url) return;
  sendToGaria(message.url, {
    from: "extension",
    name: message.name || gariaBasenameFromUrl(message.url),
    referrer: message.referrer || "",
    confirm: true,
  });
});

function urlFromSelection(text) {
  for (const raw of String(text).split(/\s+/)) {
    const token = raw.replace(/^[<"'“‘]+|[>"'”’,]+$/g, "");
    if (token.startsWith("magnet:") || gariaIsHttpUrl(token)) return token;
  }
  return "";
}

function shouldTakeDownload(item) {
  const url = item.finalUrl || item.url || "";
  if (item.byExtensionId) return false;
  if (!gariaIsHttpUrl(url)) return false;
  const filename = item.filename || "";
  if (/\.(html?|css|js)$/i.test(filename)) return false;
  if (gariaIsFileUrl(url)) return true;
  const mime = String(item.mime || "").toLowerCase();
  if (!mime || mime.startsWith("text/html") || mime.startsWith("text/css")) return false;
  if (mime.startsWith("application/xhtml") || mime.includes("javascript")) return false;
  if (mime.startsWith("video/") || mime.startsWith("audio/")) return true;
  if (mime === "application/pdf" || mime.includes("zip") || mime.includes("bittorrent")) return true;
  if (mime === "application/octet-stream") return true;
  if (mime.startsWith("application/") && filename) return true;
  return false;
}

async function takeOverDownload(item) {
  const url = item.finalUrl || item.url;
  if (!url) return;
  try { await api.downloads.cancel(item.id); } catch { /* already gone */ }
  try { await api.downloads.erase({ id: item.id }); } catch { /* already gone */ }
  sendToGaria(url, {
    from: "extension",
    name: gariaBasename(item.filename) || gariaBasenameFromUrl(url),
    referrer: item.referrer || "",
    confirm: true,
  });
}

if (api.downloads?.onCreated) {
  api.downloads.onCreated.addListener((item) => {
    if (!shouldTakeDownload(item)) return;
    takeOverDownload(item);
  });
}
