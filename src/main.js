const RPC_URL = "http://127.0.0.1:6800/jsonrpc";
let rpcId = 1;

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
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / 1024 ** i).toFixed(1) + " " + units[i];
}

function formatSpeed(bytesPerSec) {
  const b = Number(bytesPerSec);
  return b > 0 ? formatBytes(b) + "/s" : "";
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

function renderItem(dl) {
  const total = Number(dl.totalLength);
  const done  = Number(dl.completedLength);
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
  const speed = formatSpeed(dl.downloadSpeed);
  const statusClass = dl.status === "complete" ? "complete"
    : dl.status === "error"   ? "error"
    : dl.status === "active"  ? "active"
    : dl.status === "paused"  ? "paused"
    : "waiting";

  const sizeInfo = total > 0
    ? `${formatBytes(done)} / ${formatBytes(total)}`
    : done > 0 ? formatBytes(done) : "";

  const filePath = dl.files?.[0]?.path || "";
  const actions = [];
  if (dl.status === "active" || dl.status === "waiting") {
    actions.push(`<button class="dl-btn" data-gid="${dl.gid}" data-action="stop" title="Pause">⏸</button>`);
  }
  if (dl.status === "paused") {
    actions.push(`<button class="dl-btn" data-gid="${dl.gid}" data-action="resume" title="Resume">↻</button>`);
  }
  if (filePath) {
    actions.push(`<button class="dl-btn" data-action="reveal" data-path="${filePath}" title="Show in Finder"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button>`);
  }

  const isIndeterminate = dl.status === "active" && total === 0;
  const barClass = isIndeterminate ? "dl-bar-fill indeterminate" : "dl-bar-fill";
  const barStyle = isIndeterminate ? "" : `style="width:${pct}%"`;

  return `
    <div class="dl-content">
      <div class="dl-name" title="${fileName(dl)}">${fileName(dl)}</div>
      <div class="dl-bar-track"><div class="${barClass}" ${barStyle}></div></div>
      <div class="dl-row">
        <span class="dl-meta">${sizeInfo}${speed ? " · " + speed : ""}${total > 0 ? " · " + pct + "%" : ""}</span>
        <span class="dl-status ${statusClass}">${statusLabel(dl.status)}</span>
      </div>
    </div>
    ${actions.length ? `<div class="dl-actions">${actions.join("")}</div>` : ""}
  `;
}

const KEYS = ["gid", "status", "totalLength", "completedLength", "downloadSpeed", "files"];
let activeFilter = "all";
let nameFilter   = "";

function applyFilter(listEl, emptyEl) {
  const items = listEl.querySelectorAll(".dl-item");
  const needle = nameFilter.toLowerCase();
  let visible = 0;
  for (const li of items) {
    const statusMatch = activeFilter === "all" || li.dataset.status === activeFilter;
    const nameMatch   = !needle || li.dataset.name.toLowerCase().includes(needle);
    const match = statusMatch && nameMatch;
    li.classList.toggle("hidden", !match);
    if (match) {
      li.classList.toggle("zebra-odd",  visible % 2 === 0);
      li.classList.toggle("zebra-even", visible % 2 === 1);
      visible++;
    }
  }
  emptyEl.classList.toggle("hidden", visible > 0);
}

function setBadge(badge, state) {
  badge.className = `conn-badge conn-${state}`;
  badge.textContent = state === "ok" ? "Connected" : state === "error" ? "Disconnected" : "Connecting…";
  badge.title = state === "ok"
    ? "Connected to aria2"
    : state === "error"
      ? `Cannot reach aria2 JSON-RPC at ${RPC_URL}`
      : "Connecting to aria2…";
}

async function poll(listEl, emptyEl, badge) {
  try {
    const [active, waiting, stopped] = await Promise.all([
      rpc("aria2.tellActive",  [KEYS]),
      rpc("aria2.tellWaiting", [0, 100, KEYS]),
      rpc("aria2.tellStopped", [0, 100, KEYS]),
    ]);

    setBadge(badge, "ok");

    const all = [...active, ...waiting, ...stopped];
    emptyEl.classList.toggle("hidden", all.length > 0);

    for (const dl of all) {
      let li = listEl.querySelector(`[data-gid="${dl.gid}"]`);
      if (!li) {
        li = document.createElement("li");
        li.className = "dl-item";
        li.dataset.gid = dl.gid;
        listEl.prepend(li);
      }
      li.dataset.status = dl.status;
      li.dataset.name   = fileName(dl);

      li.innerHTML = renderItem(dl);
    }
    applyFilter(listEl, emptyEl);
  } catch (err) {
    console.error(err);
    setBadge(badge, "error");
    if (err?.message) badge.title = `${badge.title} — ${err.message}`;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const listEl  = document.getElementById("download-list");
  const emptyEl = document.getElementById("empty-state");
  const badge      = document.getElementById("conn-badge");
  const filterBar  = document.getElementById("filter-bar");
  const nameSearch = document.getElementById("name-filter");

  filterBar.addEventListener("click", (e) => {
    const btn = e.target.closest(".filter-btn");
    if (!btn) return;
    filterBar.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeFilter = btn.dataset.filter;
    applyFilter(listEl, emptyEl);
  });

  nameSearch.addEventListener("input", () => {
    nameFilter = nameSearch.value.trim();
    applyFilter(listEl, emptyEl);
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

  // Per-row buttons and row selection
  listEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (btn) {
      // Per-row pause / resume button
      const { gid, action, path } = btn.dataset;
      try {
        if (action === "stop")   await rpc("aria2.pause",   [gid]);
        if (action === "resume") await rpc("aria2.unpause", [gid]);
        if (action === "reveal") await window.__TAURI__.opener.revealItemInDir(path);
        if (action !== "reveal") await pollAndSync();
      } catch (err) { console.error(err); }
      return;
    }

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

  // Drop zone
  const dropZone = document.getElementById("drop-zone");

  async function pollAndSync() {
    await poll(listEl, emptyEl, badge);
  }

  let dragCounter = 0;
  document.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragCounter++;
    dropZone.classList.add("drag-over");
  });
  document.addEventListener("dragleave", () => {
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; dropZone.classList.remove("drag-over"); }
  });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropZone.classList.remove("drag-over");

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
