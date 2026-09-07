// A Download chip on a video page. It sends the *page* to Garia — never
// the stream. IDM sniffs <video src> and media requests, which is why it
// has to play first and cannot do playlists. yt-dlp already reads the
// page; this is just the button that means you do not have to copy it.
//
// Top frame only. Direct file URLs are already a download intercept.

if (window === window.top) {

const api = globalThis.browser?.runtime ? globalThis.browser : globalThis.chrome;
const dismissed = new Set();
const FEED = /^\/(feed|home|explore|timeline|search|results|trending|subscriptions|directory|popular|discover)(\/|$)/i;
const GENERIC_WATCH = /^\/(watch|video|videos|embed|player|clip|clips|episode|episodes)(\/|$)/i;
const PLAYER_SEL = [
  "#movie_player",
  "ytd-player",
  ".html5-video-player",
  ".vp-video-wrapper",
  ".video-js",
  ".jwplayer",
].join(",");

function pageKey(href = location.href) {
  return String(href || "").split("#")[0];
}

function isWatchUrl(href) {
  let url;
  try { url = new URL(href); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  const path = url.pathname;
  const q = url.searchParams;

  if (host === "youtu.be") return path.length > 1;
  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    if (path === "/watch" && q.has("v")) return true;
    if (/^\/(shorts|embed|live|clip)\//.test(path)) return true;
    if (path === "/playlist" && q.has("list")) return true;
    return false;
  }
  if (host === "vimeo.com" || host.endsWith(".vimeo.com")) {
    return /^\/\d+/.test(path) || /^\/(video|channels)\//.test(path);
  }
  if (host === "twitch.tv" || host.endsWith(".twitch.tv")) {
    return /^\/videos\/\d+/.test(path) || /\/clip\//.test(path);
  }
  if (host === "dailymotion.com" || host.endsWith(".dailymotion.com")) {
    return path.startsWith("/video/");
  }
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
    return /\/video\//.test(path);
  }
  if (host === "twitter.com" || host === "x.com") {
    return /\/status\/\d+/.test(path);
  }
  if (host === "instagram.com" || host.endsWith(".instagram.com")) {
    return /^\/(reel|reels|p|tv)\//.test(path);
  }
  if (host === "reddit.com" || host.endsWith(".reddit.com")) {
    return /\/comments\//.test(path);
  }
  if (host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.watch") {
    return host === "fb.watch" || /\/(watch|reel|videos)\//.test(path);
  }
  if (host === "bilibili.com" || host.endsWith(".bilibili.com")) {
    return path.startsWith("/video/");
  }
  if (host === "ted.com" || host.endsWith(".ted.com")) {
    return path.startsWith("/talks/");
  }
  if (host === "rumble.com") {
    return /\.html$/i.test(path);
  }
  if (FEED.test(path) || path === "/" || path === "") return false;
  return GENERIC_WATCH.test(path);
}

function playerRect() {
  for (const el of document.querySelectorAll(PLAYER_SEL)) {
    const r = el.getBoundingClientRect();
    if (r.width >= 240 && r.height >= 140) return r;
  }
  let best = null;
  let bestArea = 0;
  for (const v of document.querySelectorAll("video")) {
    const r = v.getBoundingClientRect();
    if (r.width < 240 || r.height < 140) continue;
    if (r.bottom < 40 || r.top > innerHeight - 40) continue;
    const area = r.width * r.height;
    if (area > bestArea) {
      bestArea = area;
      best = r;
    }
  }
  return best;
}

function isVideoPage(href = location.href) {
  if (typeof gariaIsFileUrl === "function" && gariaIsFileUrl(href)) return false;
  if (isWatchUrl(href)) return true;
  let url;
  try { url = new URL(href); } catch { return false; }
  if (FEED.test(url.pathname) || url.pathname === "/" || url.pathname === "") return false;
  return !!playerRect();
}

globalThis.gariaIsWatchUrl = isWatchUrl;
globalThis.gariaIsVideoPage = isVideoPage;

const host = document.createElement("div");
host.setAttribute("data-garia", "download-chip");
const shadow = host.attachShadow({ mode: "open" });

const style = document.createElement("style");
style.textContent = `
  :host {
    all: initial;
    position: fixed;
    z-index: 2147483646;
    display: none;
    width: max-content;
    pointer-events: none;
  }
  .row {
    display: flex;
    align-items: stretch;
    pointer-events: auto;
    font: 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #f5f5f7;
    -webkit-font-smoothing: antialiased;
    user-select: none;
    -webkit-user-select: none;
    border-radius: 8px;
    overflow: hidden;
    background: rgba(22, 22, 24, 0.88);
    -webkit-backdrop-filter: blur(16px);
    backdrop-filter: blur(16px);
  }
  button {
    appearance: none;
    border: 0;
    margin: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
  }
  .action {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 7px 10px 7px 9px;
  }
  .hide {
    padding: 7px 8px;
    color: #c7c7cc;
    opacity: 0.9;
  }
  .action:hover, .hide:hover {
    background: rgba(255, 255, 255, 0.08);
  }
  :host([data-compact]) .label { display: none; }
  :host([data-compact]) .action { padding: 7px 8px; }
  svg { display: block; flex: none; }
`;

function svgEl(name, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

const icon = svgEl("svg", { width: "16", height: "16", viewBox: "0 0 16 16", "aria-hidden": "true" });
const iconPath = svgEl("path", {
  fill: "currentColor",
  d: "M8 2.25a.75.75 0 0 1 .75.75v6.19l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 0 1 1.06-1.06l2.22 2.22V3a.75.75 0 0 1 .75-.75zm-4.75 9a.75.75 0 0 1 .75.75v.5h7.5v-.5a.75.75 0 0 1 1.5 0v.5A1.75 1.75 0 0 1 11.25 14h-6.5A1.75 1.75 0 0 1 3 12.25v-.5a.75.75 0 0 1 .75-.75z",
});
icon.appendChild(iconPath);

const action = document.createElement("button");
action.type = "button";
action.className = "action";
action.setAttribute("aria-label", "Download with Garia");
action.title = "Send this page to Garia";
const label = document.createElement("span");
label.className = "label";
label.textContent = "Download";
action.appendChild(icon);
action.appendChild(label);

const hide = document.createElement("button");
hide.type = "button";
hide.className = "hide";
hide.setAttribute("aria-label", "Hide download button");
hide.title = "Hide";
hide.textContent = "×";

const row = document.createElement("div");
row.className = "row";
row.appendChild(action);
row.appendChild(hide);
shadow.appendChild(style);
shadow.appendChild(row);

let sentUntil = 0;
let attached = false;

function ensureHost() {
  if (attached && host.isConnected) return;
  const root = document.documentElement;
  if (!root) return;
  root.appendChild(host);
  attached = true;
}

function place() {
  ensureHost();
  const href = pageKey();
  const showingSent = Date.now() < sentUntil;
  if (!showingSent && dismissed.has(href)) {
    host.style.display = "none";
    return;
  }
  if (document.fullscreenElement) {
    host.style.display = "none";
    return;
  }
  if (!isVideoPage(href)) {
    host.style.display = "none";
    return;
  }

  const r = playerRect();
  host.style.display = "block";
  host.style.bottom = "auto";
  host.style.left = "auto";
  if (r) {
    const compact = r.width < 300;
    host.toggleAttribute("data-compact", compact);
    host.style.top = `${Math.round(Math.max(8, r.top + 12))}px`;
    host.style.right = `${Math.round(Math.max(8, innerWidth - r.right + 12))}px`;
  } else {
    host.toggleAttribute("data-compact", false);
    host.style.top = "auto";
    host.style.bottom = "20px";
    host.style.right = "20px";
  }
}

let raf = 0;
function schedule() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    place();
  });
}

action.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  const url = pageKey();
  if (!url || typeof api?.runtime?.sendMessage !== "function") return;
  api.runtime.sendMessage({ type: "send-page", url });
  label.textContent = "Sent";
  sentUntil = Date.now() + 1100;
  place();
  setTimeout(() => {
    dismissed.add(url);
    label.textContent = "Download";
    place();
  }, 1100);
});

hide.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  dismissed.add(pageKey());
  sentUntil = 0;
  place();
});

for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
  host.addEventListener(type, (event) => event.stopPropagation());
}

window.addEventListener("scroll", schedule, true);
window.addEventListener("resize", schedule);
document.addEventListener("fullscreenchange", schedule);
document.addEventListener("yt-navigate-finish", schedule);

let lastHref = pageKey();
setInterval(() => {
  const href = pageKey();
  if (href === lastHref) return;
  lastHref = href;
  label.textContent = "Download";
  sentUntil = 0;
  schedule();
}, 400);

let moTimer = 0;
new MutationObserver(() => {
  if (moTimer) return;
  moTimer = setTimeout(() => {
    moTimer = 0;
    place();
  }, 250);
}).observe(document.documentElement, { childList: true, subtree: true });

place();

}
