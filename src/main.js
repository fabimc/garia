const RPC_URL = "http://localhost:6800/jsonrpc";
let rpcId = 1;

async function rpc(method, params = []) {
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

  const actions = [];
  if (dl.status === "active" || dl.status === "waiting") {
    actions.push(`<button class="dl-btn stop-btn" data-gid="${dl.gid}" data-action="stop">Stop</button>`);
  }
  if (dl.status === "paused") {
    actions.push(`<button class="dl-btn resume-btn" data-gid="${dl.gid}" data-action="resume">Resume</button>`);
  }

  const isIndeterminate = dl.status === "active" && total === 0;
  const barClass = isIndeterminate ? "dl-bar-fill indeterminate" : "dl-bar-fill";
  const barStyle = isIndeterminate ? "" : `style="width:${pct}%"`;

  return `
    <div class="dl-name" title="${fileName(dl)}">${fileName(dl)}</div>
    <div class="dl-bar-track"><div class="${barClass}" ${barStyle}></div></div>
    <div class="dl-row">
      <span class="dl-meta">${sizeInfo}${speed ? " · " + speed : ""}${total > 0 ? " · " + pct + "%" : ""}</span>
      <span class="dl-status ${statusClass}">${statusLabel(dl.status)}</span>
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
    if (match) visible++;
  }
  emptyEl.classList.toggle("hidden", visible > 0);
}

function setBadge(badge, state) {
  badge.className = `conn-badge conn-${state}`;
  badge.textContent = state === "ok" ? "Connected" : state === "error" ? "Disconnected" : "Connecting…";
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
  } catch {
    setBadge(badge, "error");
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const form    = document.getElementById("download-form");
  const input   = document.getElementById("url-input");
  const errorEl = document.getElementById("error-msg");
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

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.classList.add("hidden");
    const url = input.value.trim();
    try {
      await rpc("aria2.addUri", [[url]]);
      input.value = "";
    } catch (err) {
      const unreachable = err.message.includes("Failed to fetch") || err.message.includes("Load failed");
      errorEl.textContent = unreachable
        ? "aria2 is not ready yet — is it installed? Try: brew install aria2"
        : err.message;
      errorEl.classList.remove("hidden");
    }
  });

  listEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const { gid, action } = btn.dataset;
    try {
      if (action === "stop")   await rpc("aria2.pause",   [gid]);
      if (action === "resume") await rpc("aria2.unpause", [gid]);
      await poll(listEl, emptyEl);
    } catch (err) {
      console.error(err);
    }
  });

  poll(listEl, emptyEl, badge);
  setInterval(() => poll(listEl, emptyEl, badge), 1000);
});
