// A Download chip on a video page. It sends the *page* to Garia — never
// the stream. IDM sniffs <video src> and media requests, which is why it
// has to play first and cannot do playlists. yt-dlp already reads the
// page; this is just the button that means you do not have to copy it.
//
// Top frame only. Direct file URLs are already a download intercept.

if (window === window.top) {

const api = globalThis.browser?.runtime ? globalThis.browser : globalThis.chrome;
const dismissed = [];
const DISMISS_CAP = 40;
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

function hostOf(url) {
  return url.hostname.replace(/^www\./i, "").toLowerCase();
}

function hostIs(host, name) {
  return host === name || host.endsWith(`.${name}`);
}

const WATCH_HOSTS = [
  {
    match: (h) => h === "youtu.be",
    watch: (_h, path) => path.length > 1,
  },
  {
    match: (h) => h === "youtube.com" || h === "m.youtube.com" || h === "music.youtube.com",
    watch: (_h, path, q) =>
      (path === "/watch" && q.has("v")) ||
      /^\/(shorts|embed|live|clip)\//.test(path) ||
      (path === "/playlist" && q.has("list")),
  },
  {
    match: (h) => hostIs(h, "vimeo.com"),
    watch: (_h, path) => /^\/\d+/.test(path) || /^\/(video|channels)\//.test(path),
  },
  {
    match: (h) => hostIs(h, "twitch.tv"),
    watch: (_h, path) => /^\/videos\/\d+/.test(path) || /\/clip\//.test(path),
  },
  {
    match: (h) => hostIs(h, "dailymotion.com"),
    watch: (_h, path) => path.startsWith("/video/"),
  },
  {
    match: (h) => hostIs(h, "tiktok.com"),
    watch: (_h, path) => /\/video\//.test(path),
  },
  {
    match: (h) => h === "twitter.com" || h === "x.com",
    watch: (_h, path) => /\/status\/\d+/.test(path),
  },
  {
    match: (h) => hostIs(h, "instagram.com"),
    watch: (_h, path) => /^\/(reel|reels|p|tv)\//.test(path),
  },
  {
    match: (h) => hostIs(h, "reddit.com"),
    watch: (_h, path) => /\/comments\//.test(path),
  },
  {
    match: (h) => h === "fb.watch" || hostIs(h, "facebook.com"),
    watch: (h, path) => h === "fb.watch" || /\/(watch|reel|videos)\//.test(path),
  },
  {
    match: (h) => hostIs(h, "bilibili.com"),
    watch: (_h, path) => path.startsWith("/video/"),
  },
  {
    match: (h) => hostIs(h, "ted.com"),
    watch: (_h, path) => path.startsWith("/talks/"),
  },
  {
    match: (h) => h === "rumble.com",
    watch: (_h, path) => /\.html$/i.test(path),
  },
];

function isWatchUrl(href) {
  let url;
  try { url = new URL(href); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = hostOf(url);
  const rule = WATCH_HOSTS.find((r) => r.match(host));
  if (rule) return rule.watch(host, url.pathname, url.searchParams);
  return false;
}

function isKnownHost(href) {
  try { return WATCH_HOSTS.some((r) => r.match(hostOf(new URL(href)))); }
  catch { return false; }
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
  // Unknown hosts only get the chip when a real player is on the page —
  // a generic /watch path is not enough on its own.
  if (GENERIC_WATCH.test(url.pathname) || !isKnownHost(href)) return !!playerRect();
  return false;
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

function isDismissed(href) {
  return dismissed.includes(href);
}

function dismiss(href) {
  const at = dismissed.indexOf(href);
  if (at >= 0) dismissed.splice(at, 1);
  dismissed.push(href);
  if (dismissed.length > DISMISS_CAP) dismissed.shift();
}

function place() {
  ensureHost();
  const href = pageKey();
  const showingSent = Date.now() < sentUntil;
  if (!showingSent && isDismissed(href)) {
    host.style.display = "none";
    syncObserver(false);
    return;
  }
  if (document.fullscreenElement) {
    host.style.display = "none";
    syncObserver(false);
    return;
  }
  if (!isVideoPage(href)) {
    host.style.display = "none";
    syncObserver(false);
    return;
  }
  syncObserver(true);

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
    dismiss(url);
    label.textContent = "Download";
    place();
  }, 1100);
});

hide.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  dismiss(pageKey());
  sentUntil = 0;
  place();
});

for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
  host.addEventListener(type, (event) => event.stopPropagation());
}

window.addEventListener("scroll", schedule, true);
window.addEventListener("resize", schedule);
document.addEventListener("fullscreenchange", schedule);

let lastHref = pageKey();
function onNavigate() {
  const href = pageKey();
  if (href === lastHref) {
    schedule();
    return;
  }
  lastHref = href;
  label.textContent = "Download";
  sentUntil = 0;
  schedule();
}

document.addEventListener("yt-navigate-finish", onNavigate);
window.addEventListener("popstate", onNavigate);

const youtubeHost = /(?:^|\.)youtube\.com$|^youtu\.be$/i.test(location.hostname);
if (!youtubeHost) {
  setInterval(onNavigate, 800);
}

let moTimer = 0;
let observing = false;
const mo = new MutationObserver(() => {
  if (moTimer) return;
  moTimer = setTimeout(() => {
    moTimer = 0;
    place();
  }, 250);
});

function syncObserver(on) {
  if (on && !observing) {
    mo.observe(document.documentElement, { childList: true, subtree: true });
    observing = true;
  } else if (!on && observing) {
    mo.disconnect();
    observing = false;
  }
}

place();

}
