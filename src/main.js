const RPC_URL = "http://127.0.0.1:6800/jsonrpc";
let rpcId = 1;

// aria2 usually gets port 6800, but the backend falls back to a free one when
// something else already holds it — so the endpoint is asked for, not assumed.
let endpoint = "127.0.0.1:6800";

async function rpc(method, params = []) {
  // Prefer native IPC (Tauri command) to avoid WebView restrictions around
  // http://localhost fetches (mixed-content/CORS quirks).
  const invoker = window.__TAURI__?.core?.invoke;
  if (typeof invoker === "function") {
    const json = await invoker("aria2_rpc", { method, params });
    if (json?.error) throw new Error(json.error.message || "aria2 RPC error");
    return json?.result;
  }

  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

// The user's settings, mirrored from the Rust side, which owns the file they
// live in and pushes the aria2 ones into the running process. The folder is
// sent again with every download added here — aria2's global dir is only a
// default, and naming it per download is what smart folders route with.
let settings = {
  downloadDir: "",
  maxConcurrentDownloads: 5,
  maxOverallDownloadLimit: 0,
  smartFolders: false,
  notifyOnComplete: true,
};

async function loadSettings() {
  const invoker = window.__TAURI__?.core?.invoke;
  if (typeof invoker !== "function") return;   // browser dev mode: aria2's own defaults
  try {
    settings = await invoker("get_settings");
    renderLimitBadge();
  } catch (err) {
    console.error(err);
  }
}

// ── Smart folders ────────────────────────────────────────────────────────
// The routing table. Four kinds, because those are the four people actually
// sort by; anything else stays in the download folder itself rather than
// landing in a "Other" bucket nobody asked for.
const FOLDERS = {
  Video: ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "3gp", "ts"],
  Music: ["mp3", "flac", "wav", "aac", "ogg", "oga", "m4a", "wma", "opus", "aiff", "alac"],
  Documents: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
              "rtf", "txt", "csv", "epub", "mobi", "djvu"],
  Archives: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "iso", "dmg", "pkg"],
};

const FOLDER_BY_EXT = new Map();
for (const [folder, exts] of Object.entries(FOLDERS)) {
  for (const ext of exts) FOLDER_BY_EXT.set(ext, folder);
}

// The extension has to come out of a URL, not a filename: query strings and
// fragments both sit after the part that names the file.
function extensionOf(url) {
  const path = url.split(/[?#]/, 1)[0];
  const name = path.split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

// Where a download should be written. Torrents and magnets don't name a file
// until aria2 has the metadata, so they keep the base folder — routing on a
// guess would scatter a multi-file torrent worse than not routing at all.
function targetDir(url) {
  const base = (settings.downloadDir || "").replace(/\/+$/, "");
  if (!base || !settings.smartFolders || !url) return base;
  const folder = FOLDER_BY_EXT.get(extensionOf(url));
  return folder ? `${base}/${folder}` : base;
}

// Options every new download is added with. Retry passes the folder the failed
// download already had, so it isn't routed through here — a retry lands where
// the first attempt was going to, even if the rules have changed since.
function addOptions(url) {
  const dir = targetDir(url);
  return dir ? { dir } : {};
}

function formatBytes(bytes) {
  const b = Number(bytes);
  if (!b) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), units.length - 1);
  return (b / 1024 ** i).toFixed(1) + " " + units[i];
}

function formatSpeed(bytesPerSec) {
  const b = Number(bytesPerSec);
  return b > 0 ? formatBytes(b) + "/s" : "";
}

function formatEta(remaining, bytesPerSec) {
  const speed = Number(bytesPerSec);
  if (!(speed > 0) || !(remaining > 0)) return "";
  const secs = Math.round(remaining / speed);
  if (secs < 60) return `${secs}s left`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m left`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m left`;
}

function fileName(download) {
  const f = download.files?.[0];
  if (f?.path) return f.path.split("/").pop() || f.path;
  const uri = f?.uris?.[0]?.uri || "";
  return uri.split("/").pop() || uri || download.gid;
}

function statusLabel(status) {
  const map = { active: "Downloading", waiting: "Queued", paused: "Paused", complete: "Complete", error: "Error", removed: "Removed" };
  return map[status] || status;
}

function statusClass(status) {
  return ["complete", "error", "active", "paused"].includes(status) ? status : "waiting";
}

// Row order: what's moving first, what's finished last.
const STATUS_RANK = { active: 0, waiting: 1, paused: 2, error: 3, complete: 4, removed: 5 };

function statusRank(status) {
  const r = STATUS_RANK[status];
  return r === undefined ? 9 : r;
}

// ── Inline icons ─────────────────────────────────────────────────────────
const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">';

const STATUS_ICONS = {
  active:   SVG_OPEN + '<circle cx="12" cy="12" r="9"/><polyline points="8 12 12 16 16 12"/><line x1="12" y1="8" x2="12" y2="16"/></svg>',
  waiting:  SVG_OPEN + '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>',
  paused:   SVG_OPEN + '<circle cx="12" cy="12" r="9"/><line x1="10" y1="9" x2="10" y2="15"/><line x1="14" y1="9" x2="14" y2="15"/></svg>',
  complete: SVG_OPEN + '<circle cx="12" cy="12" r="9"/><polyline points="8.5 12.5 11 15 15.5 9.5"/></svg>',
  error:    SVG_OPEN + '<circle cx="12" cy="12" r="9"/><line x1="12" y1="7.5" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12.01" y2="16.5"/></svg>',
};

const BTN_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';

const ACTION_ICONS = {
  stop:   BTN_OPEN + '<line x1="9" y1="5" x2="9" y2="19"/><line x1="15" y1="5" x2="15" y2="19"/></svg>',
  resume: BTN_OPEN + '<polygon points="6 4 20 12 6 20 6 4"/></svg>',
  reveal: BTN_OPEN + '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  retry:  BTN_OPEN + '<polyline points="21 4 21 10 15 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L21 10"/></svg>',
  remove: BTN_OPEN + '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
};

const ACTION_TITLES = {
  stop: "Pause",
  resume: "Resume",
  reveal: "Show in Finder",
  retry: "Retry download",
  remove: "Delete download",
};

// Every URI aria2 still has on record for a download. A failed HTTP download
// keeps the one it was added with; a torrent's files carry none, which is
// exactly when there is nothing to retry from.
function retryUris(dl) {
  const uris = [];
  for (const f of dl.files || []) {
    for (const u of f.uris || []) {
      if (u.uri && !uris.includes(u.uri)) uris.push(u.uri);
    }
  }
  return uris;
}

// aria2 numbers the common failures and only sometimes writes a message, so
// the row would otherwise say "Failed" and stop there.
const ERROR_REASONS = {
  1: "Unknown error",
  2: "Timed out",
  3: "Not found on the server (404)",
  4: "Server returned 404 too many times",
  5: "Too slow — aria2 gave up",
  6: "Network problem",
  8: "Server does not support resuming",
  9: "Not enough disk space",
  10: "Piece length differs from the control file",
  11: "Already downloading this file",
  12: "Already downloading this torrent",
  13: "File already exists",
  14: "Could not rename the file",
  15: "Could not open the file",
  16: "Could not create the file",
  17: "Disk read/write error",
  18: "Could not create the folder",
  19: "Could not resolve the host name",
  22: "Bad response from the server",
  23: "Too many redirects",
  24: "Login required",
  26: "Torrent file is corrupt",
  27: "Bad magnet link",
  29: "Server is overloaded — try again later",
};

function errorReason(dl) {
  const message = (dl.errorMessage || "").trim();
  if (message) return message;
  const code = Number(dl.errorCode);
  if (code) return ERROR_REASONS[code] || `Failed with error ${code}`;
  return "Download failed";
}

// Each row gets one primary pill (the verb you'd reach for), a secondary reveal
// icon when the file exists on disk and isn't already the pill, and delete —
// which every row gets, because every row has to be removable.
function actionsFor(dl) {
  const out = [];
  const path = dl.files?.[0]?.path || "";
  if (dl.status === "active" || dl.status === "waiting") {
    out.push({ action: "stop", kind: "pill", tone: "accent", label: "Pause" });
  } else if (dl.status === "paused") {
    out.push({ action: "resume", kind: "pill", tone: "accent", label: "Resume" });
  } else if (dl.status === "error" && retryUris(dl).length) {
    out.push({ action: "retry", kind: "pill", tone: "accent", label: "Retry" });
  } else if (dl.status === "complete" && path) {
    out.push({ action: "reveal", kind: "pill", tone: "success", label: "Reveal" });
  }
  if (path && !out.some(a => a.action === "reveal")) {
    out.push({ action: "reveal", kind: "icon" });
  }
  out.push({ action: "remove", kind: "icon" });
  return out;
}

// ── Row rendering ────────────────────────────────────────────────────────
// Rows are built once and then updated field-by-field. A full innerHTML
// rewrite on every poll tick would kill hover state, transitions and focus.
function createItemEl(dl) {
  const li = document.createElement("li");
  li.className = "dl-item";
  li.dataset.gid = dl.gid;
  li.innerHTML = `
    <div class="dl-icon"></div>
    <div class="dl-content">
      <div class="dl-head">
        <span class="dl-name"></span>
        <span class="dl-status-pill"></span>
      </div>
      <div class="dl-bar-track"><div class="dl-bar-fill"></div></div>
      <div class="dl-meta"></div>
      <div class="dl-error hidden"></div>
    </div>
    <div class="dl-actions"></div>
  `;
  return li;
}

function updateItemEl(li, dl) {
  const total = Number(dl.totalLength);
  const done = Number(dl.completedLength);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const cls = statusClass(dl.status);
  const name = fileName(dl);

  li.dataset.status = dl.status;
  li.dataset.name = name;

  const iconEl = li.querySelector(".dl-icon");
  if (iconEl.dataset.status !== cls) {
    iconEl.dataset.status = cls;
    iconEl.innerHTML = STATUS_ICONS[cls] || STATUS_ICONS.waiting;
  }

  const nameEl = li.querySelector(".dl-name");
  if (nameEl.textContent !== name) {
    nameEl.textContent = name;
    nameEl.title = name;
  }

  // Downloading rows already say it twice over — the moving bar, the speed, and
  // the Pause button. The chip only earns its place on the other statuses.
  const pill = li.querySelector(".dl-status-pill");
  const showChip = dl.status !== "active";
  pill.className = showChip ? `dl-status-pill ${cls}` : "dl-status-pill hidden";
  if (showChip) pill.textContent = statusLabel(dl.status);

  // Progress bar
  const isIndeterminate = dl.status === "active" && total === 0;
  const fill = li.querySelector(".dl-bar-fill");
  fill.classList.toggle("indeterminate", isIndeterminate);
  fill.style.width = isIndeterminate ? "" : `${pct}%`;

  // Meta line: size · speed · percent · eta
  const parts = [];
  if (total > 0) parts.push(`${formatBytes(done)} / ${formatBytes(total)}`);
  else if (done > 0) parts.push(formatBytes(done));
  const speed = formatSpeed(dl.downloadSpeed);
  if (speed) parts.push(speed);
  if (total > 0) parts.push(`${pct}%`);
  if (dl.status === "active" && total > 0) {
    const eta = formatEta(total - done, dl.downloadSpeed);
    if (eta) parts.push(eta);
  }
  li.querySelector(".dl-meta").textContent = parts.join(" · ");

  // "Failed" on its own is a dead end — say what aria2 actually reported.
  const errEl = li.querySelector(".dl-error");
  const reason = dl.status === "error" ? errorReason(dl) : "";
  errEl.classList.toggle("hidden", !reason);
  if (reason && errEl.textContent !== reason) {
    errEl.textContent = reason;
    errEl.title = reason;
  }

  // Action buttons — rebuilt only when the available set actually changes
  const actions = actionsFor(dl);
  const key = actions.map(a => `${a.action}:${a.kind}`).join("|");
  if (li.dataset.actionKey !== key) {
    li.dataset.actionKey = key;
    const box = li.querySelector(".dl-actions");
    box.textContent = "";
    for (const a of actions) {
      const btn = document.createElement("button");
      btn.dataset.action = a.action;
      btn.dataset.gid = dl.gid;
      btn.title = ACTION_TITLES[a.action];
      btn.setAttribute("aria-label", ACTION_TITLES[a.action]);
      if (a.kind === "pill") {
        btn.className = `dl-action-pill tone-${a.tone}`;
        btn.innerHTML = ACTION_ICONS[a.action];
        btn.appendChild(document.createTextNode(a.label));
      } else {
        btn.className = "dl-btn";
        btn.innerHTML = ACTION_ICONS[a.action];
      }
      box.appendChild(btn);
    }
  }
  // Path can change between ticks even when the action set doesn't
  const reveal = li.querySelector('[data-action="reveal"]');
  if (reveal) reveal.dataset.path = dl.files?.[0]?.path || "";
}

// ── Section headers ──────────────────────────────────────────────────────
const SECTION_LABELS = {
  active: "Downloading",
  waiting: "Queued",
  paused: "Paused",
  error: "Failed",
  complete: "Completed",
};

// Reused across polls so a re-sort moves the same nodes rather than rebuilding.
const sectionEls = new Map();

function sectionEl(status) {
  let el = sectionEls.get(status);
  if (!el) {
    el = document.createElement("li");
    el.className = "dl-section";
    el.dataset.section = status;
    el.innerHTML = `
      <span class="dl-section-label"></span>
      <span class="dl-section-count"></span>
      <button class="dl-section-link" type="button">View all</button>
    `;
    el.querySelector(".dl-section-label").textContent = SECTION_LABELS[status] || status;
    el.querySelector(".dl-section-link").dataset.filter = status;
    sectionEls.set(status, el);
  }
  return el;
}

// ── Filtering / view state ───────────────────────────────────────────────
const KEYS = [
  "gid", "status", "totalLength", "completedLength", "downloadSpeed", "files",
  // dir survives a retry; the error pair is what lets a failed row say why.
  "dir", "errorCode", "errorMessage",
];

const VIEW_TITLES = {
  all: "All Downloads",
  active: "Downloading",
  waiting: "Queued",
  paused: "Paused",
  complete: "Completed",
  error: "Failed",
};

// The last payload for each gid. Retry needs its URIs and folder, delete needs
// its file paths — more than fits in a data- attribute, and all of it stale by
// the time the click lands unless it comes from the most recent poll.
const snapshot = new Map();

// The first poll is what the app was already looking at, not news: without
// this, every download finished in a previous session would announce itself
// again at launch.
let firstPoll = true;

let activeFilter = "all";
let nameFilter = "";
let connState = "waiting";

function applyFilter(listEl) {
  const items = listEl.querySelectorAll(".dl-item");
  const needle = nameFilter.toLowerCase();
  // Headers only earn their keep in the combined view; a single-status filter
  // would just repeat its own name.
  const showSections = activeFilter === "all";
  let visible = 0;
  let header = null;
  let inSection = 0;

  let lastShown = null;   // last visible row of the section being walked

  const closeSection = () => {
    if (header) {
      header.classList.toggle("hidden", !showSections || inSection === 0);
      header.querySelector(".dl-section-count").textContent = inSection;
    }
    // CSS alone can't find the last *visible* row once search hides some, so
    // the divider on it is turned off here instead.
    if (lastShown) lastShown.classList.add("is-last-shown");
    lastShown = null;
  };

  for (const el of listEl.children) {
    if (el.classList.contains("dl-section")) {
      closeSection();
      header = el;
      inSection = 0;
      continue;
    }
    const statusMatch = activeFilter === "all" || el.dataset.status === activeFilter;
    const nameMatch = !needle || el.dataset.name.toLowerCase().includes(needle);
    const match = statusMatch && nameMatch;
    el.classList.toggle("hidden", !match);
    el.classList.remove("is-last-shown");
    if (match) { visible++; inSection++; lastShown = el; }
  }
  closeSection();

  document.getElementById("view-count").textContent =
    visible === 1 ? "1 item" : `${visible} items`;

  const empty = document.getElementById("empty-state");
  empty.classList.toggle("hidden", visible > 0);
  if (visible === 0) {
    let title, sub;
    if (items.length > 0) {
      title = "Nothing matches this view";
      sub = "Try a different filter or clear the search field";
    } else if (connState === "error") {
      title = "Can't reach aria2";
      sub = "Start aria2 and garia will reconnect on its own";
    } else {
      title = "No downloads yet";
      sub = "Drag a URL or .torrent file anywhere, or hit Add download";
    }
    document.getElementById("empty-title").textContent = title;
    document.getElementById("empty-sub").textContent = sub;
  }
}

function renderCounts(tally) {
  for (const el of document.querySelectorAll(".nav-count")) {
    const n = tally[el.dataset.count] || 0;
    el.textContent = n;
    el.classList.toggle("hidden", n === 0);
  }

  const bits = [];
  if (tally.active) bits.push(`${tally.active} downloading`);
  if (tally.waiting) bits.push(`${tally.waiting} queued`);
  if (tally.paused) bits.push(`${tally.paused} paused`);
  if (tally.complete) bits.push(`${tally.complete} done`);
  if (tally.error) bits.push(`${tally.error} failed`);
  document.getElementById("stat-counts").textContent =
    bits.length ? bits.join(" · ") : "no downloads";

  const speed = formatSpeed(tally.speed);
  document.getElementById("stat-speed").textContent = speed ? `↓ ${speed}` : "";
}

// A cap explains a slow download, so it has to be visible without opening
// Settings to remember it's there.
function renderLimitBadge() {
  const el = document.getElementById("stat-limit");
  if (!el) return;
  const bytes = Number(settings.maxOverallDownloadLimit) || 0;
  el.classList.toggle("hidden", bytes <= 0);
  if (bytes > 0) el.textContent = `· capped at ${formatSpeed(bytes)}`;
}

// ── Completion notifications ─────────────────────────────────────────────
// A download that finishes while the window is buried behind a browser used to
// go entirely unannounced. Two signals, because they answer different
// questions: the notification says "this one just landed", the dock badge says
// "this many landed while you were away".
let notifyReady = null;   // a promise, resolved once, or null when unavailable

function notifications() {
  const api = window.__TAURI__?.notification;
  if (!api) return null;
  if (!notifyReady) {
    // macOS only ever asks once, and only when something actually wants to
    // notify — so the request is deferred to the first completed download
    // rather than fired at launch.
    notifyReady = api
      .isPermissionGranted()
      .then((granted) => (granted ? true : api.requestPermission().then((p) => p === "granted")))
      .catch(() => false);
  }
  return { api, ready: notifyReady };
}

async function notifyComplete(dl) {
  const n = notifications();
  if (!n) return;
  try {
    if (!(await n.ready)) return;
    const total = Number(dl.totalLength);
    n.api.sendNotification({
      title: "Download complete",
      body: total > 0 ? `${fileName(dl)} · ${formatBytes(total)}` : fileName(dl),
    });
  } catch (err) {
    console.error(err);
  }
}

// Cleared when the user comes back to the window — at that point they have
// seen the list, and the badge has said all it has to say.
let unseenCompletions = 0;

function setBadge(count) {
  const invoker = window.__TAURI__?.core?.invoke;
  if (typeof invoker !== "function") return;
  invoker("set_badge", { count }).catch((err) => console.error(err));
}

function countCompletion() {
  if (document.hasFocus()) return;
  unseenCompletions++;
  setBadge(unseenCompletions);
}

function clearBadge() {
  if (unseenCompletions === 0) return;
  unseenCompletions = 0;
  setBadge(0);
}

function setConn(state) {
  connState = state;
  const dot = document.getElementById("conn-dot");
  const text = document.getElementById("conn-text");
  dot.className = `conn-dot conn-${state}`;
  text.textContent = state === "ok"
    ? `aria2 · ${endpoint}`
    : state === "error"
      ? "aria2 unreachable"
      : "connecting…";
  text.title = state === "ok"
    ? "Connected to aria2"
    : state === "error"
      ? `Cannot reach aria2 JSON-RPC at ${endpoint}`
      : "Connecting to aria2…";
  return text;
}

async function poll(listEl) {
  try {
    const [active, waiting, stopped] = await Promise.all([
      rpc("aria2.tellActive", [KEYS]),
      rpc("aria2.tellWaiting", [0, 100, KEYS]),
      rpc("aria2.tellStopped", [0, 100, KEYS]),
    ]);

    setConn("ok");

    const all = [...active, ...waiting, ...stopped];
    const tally = { all: all.length, active: 0, waiting: 0, paused: 0, complete: 0, error: 0, speed: 0 };
    const seen = new Set();

    for (const dl of all) {
      seen.add(dl.gid);
      const before = snapshot.get(dl.gid);
      snapshot.set(dl.gid, dl);

      // The transition, not the state: a row sits at "complete" for as long as
      // it's on screen, and only the tick it arrived on is worth announcing.
      if (
        settings.notifyOnComplete &&
        !firstPoll &&
        dl.status === "complete" &&
        before?.status !== "complete"
      ) {
        notifyComplete(dl);
        countCompletion();
      }

      if (tally[dl.status] !== undefined) tally[dl.status]++;
      if (dl.status === "active") tally.speed += Number(dl.downloadSpeed) || 0;

      let li = listEl.querySelector(`[data-gid="${dl.gid}"]`);
      if (!li) {
        li = createItemEl(dl);
        listEl.appendChild(li);
      }
      updateItemEl(li, dl);
    }

    // Drop rows for downloads aria2 no longer reports
    for (const li of [...listEl.querySelectorAll(".dl-item")]) {
      if (!seen.has(li.dataset.gid)) li.remove();
    }
    for (const gid of snapshot.keys()) {
      if (!seen.has(gid)) snapshot.delete(gid);
    }

    // Reorder by status, stable within each group so aria2's own ordering shows
    // through, inserting a section header whenever the status changes. Only
    // touch the DOM when the sequence really changed — moving nodes every tick
    // would cancel hover state and in-flight transitions.
    const ordered = all.slice().sort((a, b) => statusRank(a.status) - statusRank(b.status));
    const desired = [];
    let lastStatus = null;
    for (const dl of ordered) {
      if (dl.status !== lastStatus) {
        lastStatus = dl.status;
        desired.push(sectionEl(dl.status));
      }
      const li = listEl.querySelector(`[data-gid="${dl.gid}"]`);
      if (li) desired.push(li);
    }

    const current = [...listEl.children];
    if (current.length !== desired.length || desired.some((n, i) => current[i] !== n)) {
      const frag = document.createDocumentFragment();
      for (const node of desired) frag.appendChild(node);
      listEl.textContent = "";   // drops headers for groups that no longer exist
      listEl.appendChild(frag);
    }

    renderCounts(tally);
    // Only a poll that actually reached aria2 counts as having seen the list;
    // a failed first attempt must not silence the real one.
    firstPoll = false;
  } catch (err) {
    console.error(err);
    const text = setConn("error");
    if (err?.message) text.title = `${text.title} — ${err.message}`;
  } finally {
    applyFilter(listEl);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  window.__TAURI__?.core
    ?.invoke("aria2_endpoint")
    .then((value) => { endpoint = value; })
    .catch(() => {});

  const listEl = document.getElementById("download-list");
  const filterBar = document.getElementById("filter-bar");
  const nameSearch = document.getElementById("name-filter");

  function setFilter(value) {
    activeFilter = value;
    for (const b of filterBar.querySelectorAll(".nav-item")) {
      b.classList.toggle("active", b.dataset.filter === value);
    }
    document.getElementById("view-title").textContent =
      VIEW_TITLES[value] || "Downloads";
    applyFilter(listEl);
  }

  filterBar.addEventListener("click", (e) => {
    const btn = e.target.closest(".nav-item");
    if (btn) setFilter(btn.dataset.filter);
  });

  nameSearch.addEventListener("input", () => {
    nameFilter = nameSearch.value.trim();
    applyFilter(listEl);
  });

  // ── Modal ────────────────────────────────────────────────────────────────
  const overlay       = document.getElementById("modal-overlay");
  const modalUrlInput = document.getElementById("modal-url-input");
  const modalError    = document.getElementById("modal-error");
  const torrentInput  = document.getElementById("torrent-file-input");

  function openModal() {
    modalUrlInput.value = "";
    torrentInput.value  = "";
    modalError.classList.add("hidden");
    overlay.classList.remove("hidden");
    setTimeout(() => modalUrlInput.focus(), 50);
  }
  function closeModal() { overlay.classList.add("hidden"); }

  document.getElementById("open-modal-btn").addEventListener("click", openModal);
  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("modal-cancel").addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeModal(); closeConfirm(); closeSettings(); }
  });

  // Browse → open native file picker for .torrent
  document.getElementById("browse-btn").addEventListener("click", () => torrentInput.click());

  // When a torrent file is chosen, submit immediately
  torrentInput.addEventListener("change", async () => {
    const file = torrentInput.files[0];
    if (!file) return;
    await submitTorrent(file);
  });

  async function submitTorrent(file) {
    modalError.classList.add("hidden");
    try {
      const buf = await file.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      await rpc("aria2.addTorrent", [b64, [], addOptions()]);
      closeModal();
      await pollAndSync();
    } catch (err) {
      modalError.textContent = err.message;
      modalError.classList.remove("hidden");
    }
  }

  async function submitUrl() {
    const url = modalUrlInput.value.trim();
    if (!url) return;
    modalError.classList.add("hidden");
    try {
      await rpc("aria2.addUri", [[url], addOptions(url)]);
      closeModal();
      await pollAndSync();
    } catch (err) {
      const unreachable = err.message.includes("Failed to fetch") || err.message.includes("Load failed");
      modalError.textContent = unreachable
        ? "aria2 isn't answering yet — give it a moment and try again"
        : err.message;
      modalError.classList.remove("hidden");
    }
  }

  document.getElementById("modal-ok").addEventListener("click", submitUrl);
  modalUrlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitUrl(); });

  // Per-row buttons and section "View all" links
  listEl.addEventListener("click", async (e) => {
    const link = e.target.closest(".dl-section-link");
    if (link) { setFilter(link.dataset.filter); return; }

    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const { gid, action, path } = btn.dataset;
    // Delete opens a dialog rather than acting, so it returns before the poll.
    if (action === "remove") { openConfirm(gid); return; }

    try {
      if (action === "stop")   await rpc("aria2.pause",   [gid]);
      if (action === "resume") await rpc("aria2.unpause", [gid]);
      if (action === "retry")  await retryDownload(gid);
      if (action === "reveal") await window.__TAURI__.opener.revealItemInDir(path);
      if (action !== "reveal") await pollAndSync();
    } catch (err) { console.error(err); }
  });

  // ── Retry and delete ─────────────────────────────────────────────────────
  // A stopped download sticks around in aria2's lists until its result is
  // purged, and a running one has to be stopped before it has a result at all.
  // The purge can lose a race with aria2 filing that result, hence the retries.
  async function purgeResult(gid) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await rpc("aria2.removeDownloadResult", [gid]);
        return;
      } catch (err) {
        if (attempt === 2) { console.error(err); return; }
        await new Promise(r => setTimeout(r, 120));
      }
    }
  }

  // aria2 has no retry — a failed attempt is a finished record. So the URIs it
  // was added with are queued again, into the same folder, and the dead record
  // is dropped so the list doesn't show the same file twice.
  async function retryDownload(gid) {
    const dl = snapshot.get(gid);
    const uris = dl ? retryUris(dl) : [];
    if (!uris.length) return;
    await rpc("aria2.addUri", [uris, dl.dir ? { dir: dl.dir } : {}]);
    await purgeResult(gid);
  }

  async function removeDownload(gid, alsoTrash) {
    const dl = snapshot.get(gid);
    if (dl && ["active", "waiting", "paused"].includes(dl.status)) {
      try { await rpc("aria2.remove", [gid]); } catch (err) { console.error(err); }
    }
    await purgeResult(gid);

    if (alsoTrash) {
      const paths = (dl?.files || []).map(f => f.path).filter(Boolean);
      const invoker = window.__TAURI__?.core?.invoke;
      if (paths.length && typeof invoker === "function") {
        try { await invoker("trash_files", { paths }); } catch (err) { console.error(err); }
      }
    }
    await pollAndSync();
  }

  const confirmOverlay = document.getElementById("confirm-overlay");
  const confirmName    = document.getElementById("confirm-name");
  const confirmFileRow = document.getElementById("confirm-file-row");
  const confirmTrash   = document.getElementById("confirm-trash");
  const confirmCancel  = document.getElementById("confirm-cancel");
  let confirmGid = null;

  function openConfirm(gid) {
    const dl = snapshot.get(gid);
    if (!dl) return;
    confirmGid = gid;
    confirmName.textContent = fileName(dl);
    // Nothing to offer when the download never wrote a byte.
    const onDisk = Number(dl.completedLength) > 0 && (dl.files || []).some(f => f.path);
    confirmFileRow.classList.toggle("hidden", !onDisk);
    confirmTrash.checked = false;
    confirmOverlay.classList.remove("hidden");
    setTimeout(() => confirmCancel.focus(), 50);
  }

  function closeConfirm() {
    confirmOverlay.classList.add("hidden");
    confirmGid = null;
  }

  confirmCancel.addEventListener("click", closeConfirm);
  confirmOverlay.addEventListener("click", (e) => {
    if (e.target === confirmOverlay) closeConfirm();
  });
  document.getElementById("confirm-delete").addEventListener("click", async () => {
    const gid = confirmGid;
    const alsoTrash = confirmTrash.checked && !confirmFileRow.classList.contains("hidden");
    closeConfirm();
    if (gid) await removeDownload(gid, alsoTrash);
  });

  // Bulk action helpers
  async function bulkAction(gids, action) {
    const method = action === "pause" ? "aria2.pause" : "aria2.unpause";
    await Promise.allSettled(gids.map(gid => rpc(method, [gid])));
    await pollAndSync();
  }

  document.getElementById("pause-all").addEventListener("click", () => {
    const gids = [...listEl.querySelectorAll(".dl-item[data-status='active']")].map(li => li.dataset.gid);
    bulkAction(gids, "pause");
  });
  document.getElementById("resume-all").addEventListener("click", () => {
    const gids = [...listEl.querySelectorAll(".dl-item[data-status='paused']")].map(li => li.dataset.gid);
    bulkAction(gids, "resume");
  });

  // ── Settings ─────────────────────────────────────────────────────────────
  const settingsOverlay = document.getElementById("settings-overlay");
  const settingsDir     = document.getElementById("settings-dir");
  const settingsLimit   = document.getElementById("settings-limit");
  const settingsConc    = document.getElementById("settings-concurrency");
  const settingsNotify  = document.getElementById("settings-notify");
  const settingsSmart   = document.getElementById("settings-smart-folders");
  const settingsError   = document.getElementById("settings-error");

  const MB = 1024 * 1024;

  function openSettings() {
    settingsError.classList.add("hidden");
    settingsDir.value = settings.downloadDir || "";
    const bytes = Number(settings.maxOverallDownloadLimit) || 0;
    // Bytes per second is what aria2 wants; MB/s is what a person thinks in.
    settingsLimit.value = bytes ? String(Math.round((bytes / MB) * 100) / 100) : "0";
    settingsConc.value = String(settings.maxConcurrentDownloads || 5);
    settingsNotify.checked = settings.notifyOnComplete !== false;
    settingsSmart.checked = settings.smartFolders === true;
    settingsOverlay.classList.remove("hidden");
    setTimeout(() => settingsDir.focus(), 50);
  }

  function closeSettings() { settingsOverlay.classList.add("hidden"); }

  async function saveSettings() {
    settingsError.classList.add("hidden");
    const mb    = parseFloat(settingsLimit.value);
    const files = parseInt(settingsConc.value, 10);
    const next = {
      downloadDir: settingsDir.value.trim(),
      maxConcurrentDownloads: Number.isFinite(files) ? Math.min(Math.max(files, 1), 16) : 5,
      maxOverallDownloadLimit: Number.isFinite(mb) && mb > 0 ? Math.round(mb * MB) : 0,
      smartFolders: settingsSmart.checked,
      notifyOnComplete: settingsNotify.checked,
    };

    // Switching notifications off should take the count on the dock with it.
    if (!next.notifyOnComplete) clearBadge();

    const invoker = window.__TAURI__?.core?.invoke;
    if (typeof invoker !== "function") {
      // Browser dev mode — nothing to persist to, but the dialog still behaves.
      settings = next;
      renderLimitBadge();
      closeSettings();
      return;
    }

    try {
      // Rust returns the settings as they were actually stored, clamped.
      settings = await invoker("save_settings", { settings: next });
      renderLimitBadge();
      closeSettings();
    } catch (err) {
      settingsError.textContent = String(err?.message || err);
      settingsError.classList.remove("hidden");
    }
  }

  document.getElementById("open-settings-btn").addEventListener("click", openSettings);
  document.getElementById("settings-close").addEventListener("click", closeSettings);
  document.getElementById("settings-cancel").addEventListener("click", closeSettings);
  document.getElementById("settings-save").addEventListener("click", saveSettings);
  settingsOverlay.addEventListener("click", (e) => {
    if (e.target === settingsOverlay) closeSettings();
  });
  settingsOverlay.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveSettings();
  });

  // The path stays typeable — the picker is the convenience, not the only way in.
  document.getElementById("settings-browse").addEventListener("click", async () => {
    const pick = window.__TAURI__?.dialog?.open;
    if (typeof pick !== "function") {
      // Only reachable outside the app (browser dev mode) — say so rather
      // than letting the button do nothing.
      settingsError.textContent = "No folder picker here — type the path instead.";
      settingsError.classList.remove("hidden");
      return;
    }
    try {
      const chosen = await pick({
        directory: true,
        multiple: false,
        title: "Choose a download folder",
        defaultPath: settingsDir.value.trim() || undefined,
      });
      if (typeof chosen === "string" && chosen) settingsDir.value = chosen;
    } catch (err) {
      console.error(err);
    }
  });

  // ── Sidebar collapse ─────────────────────────────────────────────────────
  const shell = document.querySelector(".app-shell");
  const SIDEBAR_KEY = "garia:sidebar-collapsed";

  function setSidebar(collapsed) {
    shell.classList.toggle("sidebar-collapsed", collapsed);
    try { localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0"); } catch {}
  }

  try { setSidebar(localStorage.getItem(SIDEBAR_KEY) === "1"); } catch {}

  document.getElementById("sidebar-toggle").addEventListener("click", () => setSidebar(true));
  document.getElementById("sidebar-show").addEventListener("click", () => setSidebar(false));

  // Coming back to the window is the user seeing the list, so the badge has
  // nothing left to tell them.
  window.addEventListener("focus", clearBadge);

  // ⌘F / Ctrl-F focuses the search field
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      nameSearch.focus();
      nameSearch.select();
    }
  });

  async function pollAndSync() {
    await poll(listEl);
  }

  // ── Drag & drop ──────────────────────────────────────────────────────────
  const dropOverlay = document.getElementById("drop-overlay");
  let dragCounter = 0;

  document.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragCounter++;
    dropOverlay.classList.remove("hidden");
  });
  document.addEventListener("dragleave", () => {
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.add("hidden"); }
  });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.classList.add("hidden");

    const file = e.dataTransfer.files[0];
    if (file && (file.name.endsWith(".torrent") || file.type === "application/x-bittorrent")) {
      const buf = await file.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      try { await rpc("aria2.addTorrent", [b64, [], addOptions()]); } catch (err) { console.error(err); }
    } else {
      const text = e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("text/uri-list");
      // A dropped magnet link used to be dropped on the floor — the modal took
      // it, the drop zone didn't.
      const urls = text.split(/\s+/).map(u => u.trim())
        .filter(u => u.startsWith("http") || u.startsWith("magnet:"));
      for (const url of urls) {
        try { await rpc("aria2.addUri", [[url], addOptions(url)]); } catch (err) { console.error(err); }
      }
    }
    await pollAndSync();
  });

  loadSettings();
  pollAndSync();
  setInterval(pollAndSync, 1000);
});
