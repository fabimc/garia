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
};

const ACTION_TITLES = { stop: "Pause", resume: "Resume", reveal: "Show in Finder" };

// Each row gets one primary pill (the verb you'd reach for) and, when the file
// exists on disk and isn't already the pill, a secondary reveal icon.
function actionsFor(dl) {
  const out = [];
  const path = dl.files?.[0]?.path || "";
  if (dl.status === "active" || dl.status === "waiting") {
    out.push({ action: "stop", kind: "pill", tone: "accent", label: "Pause" });
  } else if (dl.status === "paused") {
    out.push({ action: "resume", kind: "pill", tone: "accent", label: "Resume" });
  } else if (dl.status === "complete" && path) {
    out.push({ action: "reveal", kind: "pill", tone: "success", label: "Reveal" });
  }
  if (path && !out.some(a => a.action === "reveal")) {
    out.push({ action: "reveal", kind: "icon" });
  }
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
const KEYS = ["gid", "status", "totalLength", "completedLength", "downloadSpeed", "files"];

const VIEW_TITLES = {
  all: "All Downloads",
  active: "Downloading",
  waiting: "Queued",
  paused: "Paused",
  complete: "Completed",
  error: "Failed",
};

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
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

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
      await rpc("aria2.addTorrent", [b64]);
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
      await rpc("aria2.addUri", [[url]]);
      closeModal();
      await pollAndSync();
    } catch (err) {
      const unreachable = err.message.includes("Failed to fetch") || err.message.includes("Load failed");
      modalError.textContent = unreachable
        ? "aria2 is not ready yet — is it running? Try: brew install aria2"
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
    try {
      if (action === "stop")   await rpc("aria2.pause",   [gid]);
      if (action === "resume") await rpc("aria2.unpause", [gid]);
      if (action === "reveal") await window.__TAURI__.opener.revealItemInDir(path);
      if (action !== "reveal") await pollAndSync();
    } catch (err) { console.error(err); }
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
      try { await rpc("aria2.addTorrent", [b64]); } catch (err) { console.error(err); }
    } else {
      const text = e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("text/uri-list");
      const urls = text.split(/\s+/).map(u => u.trim()).filter(u => u.startsWith("http"));
      for (const url of urls) {
        try { await rpc("aria2.addUri", [[url]]); } catch (err) { console.error(err); }
      }
    }
    await pollAndSync();
  });

  pollAndSync();
  setInterval(pollAndSync, 1000);
});
