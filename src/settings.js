const MB = 1024 * 1024;
const PANE_KEY = "garia:settings-pane";
const LOGINS_KEY = "garia:logins";
const MODES = ["full", "medium", "light"];

let settings = {
  downloadDir: "",
  maxConcurrentDownloads: 5,
  trafficMode: "full",
  mediumLimit: 2 * MB,
  lightLimit: 512 * 1024,
  maxOverallDownloadLimit: 0,
  seedRatio: 1,
  seedTimeMinutes: 0,
  smartFolders: false,
  notifyOnComplete: true,
  catchClipboard: true,
  inOrder: false,
  cookieFile: "",
  remoteControl: false,
  scheduleEnabled: false,
  scheduleStart: 2 * 60,
  scheduleEnd: 8 * 60,
};

let logins = [];
let videoTools = { version: "", source: "", ffmpeg: false, ffmpegSource: "" };
let editingHost = "";
let saving = false;
let saveQueued = false;

const invoker = () => window.__TAURI__?.core?.invoke;

function modeLimit(mode) {
  if (mode === "medium") return Number(settings.mediumLimit) || 0;
  if (mode === "light") return Number(settings.lightLimit) || 0;
  return 0;
}

function currentMode() {
  return MODES.includes(settings.trafficMode) ? settings.trafficMode : "full";
}

function inMB(bytes) {
  return String(Math.round((Number(bytes) / MB) * 100) / 100);
}

function toBytes(text) {
  const mb = parseFloat(text);
  return Number.isFinite(mb) && mb > 0 ? Math.round(mb * MB) : 0;
}

function hhmm(minute) {
  const m = ((Math.round(minute) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function minutesOf(value) {
  const [h, m] = String(value || "").split(":").map((n) => parseInt(n, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return (((h * 60 + m) % 1440) + 1440) % 1440;
}

function clockLabel(minute) {
  const at = new Date();
  at.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function siteOf(input) {
  let s = String(input || "").trim();
  const scheme = s.indexOf("://");
  if (scheme >= 0) s = s.slice(scheme + 3);
  s = s.split(/[/?#]/)[0];
  const at = s.lastIndexOf("@");
  if (at >= 0) s = s.slice(at + 1);
  let host;
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    host = end > 0 ? s.slice(0, end + 1) : s;
  } else {
    host = s.split(":")[0];
  }
  return host.trim().replace(/\.+$/, "").toLowerCase();
}

function loginSummary(login) {
  const bits = [];
  if (login.username) bits.push(login.username);
  if (login.hasPassword) {
    bits.push(login.viaHeader ? "password as a header" : "password in netrc");
  }
  const count = (login.headers || []).length;
  if (count) bits.push(count === 1 ? "1 header" : `${count} headers`);
  return bits.join(" · ") || "nothing saved";
}

async function copyText(text) {
  const invoke = invoker();
  if (typeof invoke === "function") return invoke("copy_text", { text });
  return navigator.clipboard.writeText(text);
}

const settingsError = document.getElementById("settings-error");
const settingsDir = document.getElementById("settings-dir");
const settingsMedium = document.getElementById("settings-medium");
const settingsLight = document.getElementById("settings-light");
const settingsConc = document.getElementById("settings-concurrency");
const settingsRatio = document.getElementById("settings-seed-ratio");
const settingsSeedFor = document.getElementById("settings-seed-time");
const settingsNotify = document.getElementById("settings-notify");
const settingsAutostart = document.getElementById("settings-autostart");
const settingsSmart = document.getElementById("settings-smart-folders");
const settingsCatch = document.getElementById("settings-catch");
const settingsInOrder = document.getElementById("settings-in-order");
const settingsCookies = document.getElementById("settings-cookies");
const settingsRemote = document.getElementById("settings-remote");
const settingsSched = document.getElementById("settings-schedule");
const settingsSchedFrom = document.getElementById("settings-schedule-start");
const settingsSchedTo = document.getElementById("settings-schedule-end");
const settingsSchedSum = document.getElementById("settings-schedule-sum");
const settingsLogins = document.getElementById("settings-logins");

const schedFrom = () => minutesOf(settingsSchedFrom.value) ?? 2 * 60;
const schedTo = () => minutesOf(settingsSchedTo.value) ?? 8 * 60;

function showError(err) {
  settingsError.textContent = String(err?.message || err);
  settingsError.classList.remove("hidden");
}

function hideError() {
  settingsError.classList.add("hidden");
}

function renderScheduleSummary() {
  const from = schedFrom();
  const to = schedTo();
  if (!settingsSched.checked) {
    settingsSchedSum.textContent = "Downloads run whenever Garia is running.";
    return;
  }
  if (from === to) {
    settingsSchedSum.textContent =
      "Those are the same time, which is not a window — the schedule stays off until they differ.";
    return;
  }
  const width = ((to - from) + 1440) % 1440;
  const hours = Math.floor(width / 60);
  const mins = width % 60;
  const span = [hours ? `${hours}h` : "", mins ? `${mins}m` : ""].filter(Boolean).join(" ");
  settingsSchedSum.textContent =
    `${span} a day, ${to < from ? "overnight, from" : "from"} ${clockLabel(from)} to ${clockLabel(to)}.`;
}

function renderVideoTools() {
  const el = document.getElementById("settings-video");
  if (!el) return;
  if (!videoTools.version) {
    el.textContent =
      "No yt-dlp found, so video pages download as pages. Install one with " +
      "`brew install yt-dlp`, or a python3 3.10 or newer for the copy Garia ships.";
    return;
  }
  const where = videoTools.source === "bundled" ? "the bundled copy" : "your own";
  const merge = !videoTools.ffmpeg
    ? "No ffmpeg — the bundled one is missing, so only qualities that come as a single file are offered."
    : videoTools.ffmpegSource === "system"
      ? "Merging uses your own ffmpeg; the copy Garia ships didn't run."
      : "Merging uses the ffmpeg Garia ships, so the split video-and-audio qualities are all on offer.";
  el.textContent = `yt-dlp ${videoTools.version} (${where}). ${merge}`;
}

function fillForm() {
  settingsDir.value = settings.downloadDir || "";
  settingsMedium.value = inMB(modeLimit("medium"));
  settingsLight.value = inMB(modeLimit("light"));
  settingsConc.value = String(settings.maxConcurrentDownloads || 5);
  settingsRatio.value = String(Number(settings.seedRatio) || 0);
  settingsSeedFor.value = String(Number(settings.seedTimeMinutes) || 0);
  settingsNotify.checked = settings.notifyOnComplete !== false;
  settingsSmart.checked = settings.smartFolders === true;
  settingsCatch.checked = settings.catchClipboard !== false;
  settingsInOrder.checked = settings.inOrder === true;
  settingsCookies.value = settings.cookieFile || "";
  settingsRemote.checked = settings.remoteControl === true;
  settingsSched.checked = settings.scheduleEnabled === true;
  settingsSchedFrom.value = hhmm(Number(settings.scheduleStart) || 0);
  settingsSchedTo.value = hhmm(Number(settings.scheduleEnd) || 0);
  renderScheduleSummary();
}

function formSettings() {
  const files = parseInt(settingsConc.value, 10);
  return {
    ...settings,
    downloadDir: settingsDir.value.trim(),
    maxConcurrentDownloads: Number.isFinite(files) ? Math.min(Math.max(files, 1), 16) : 5,
    trafficMode: currentMode(),
    mediumLimit: toBytes(settingsMedium.value),
    lightLimit: toBytes(settingsLight.value),
    seedRatio: Math.min(Math.max(parseFloat(settingsRatio.value) || 0, 0), 100),
    seedTimeMinutes: Math.max(parseInt(settingsSeedFor.value, 10) || 0, 0),
    smartFolders: settingsSmart.checked,
    notifyOnComplete: settingsNotify.checked,
    catchClipboard: settingsCatch.checked,
    inOrder: settingsInOrder.checked,
    cookieFile: settingsCookies.value.trim(),
    remoteControl: settingsRemote.checked,
    scheduleEnabled: settingsSched.checked && schedFrom() !== schedTo(),
    scheduleStart: schedFrom(),
    scheduleEnd: schedTo(),
  };
}

function settingsDiffer(a, b) {
  const keys = [
    "downloadDir", "maxConcurrentDownloads", "mediumLimit", "lightLimit",
    "seedRatio", "seedTimeMinutes", "smartFolders", "notifyOnComplete",
    "catchClipboard", "inOrder", "cookieFile", "remoteControl",
    "scheduleEnabled", "scheduleStart", "scheduleEnd",
  ];
  return keys.some((k) => a[k] !== b[k]);
}

async function persistSettings() {
  if (saving) {
    saveQueued = true;
    return;
  }
  const next = formSettings();
  if (!settingsDiffer(next, settings)) return;

  saving = true;
  hideError();
  const opening = next.remoteControl && settings.remoteControl !== true;
  try {
    const invoke = invoker();
    if (typeof invoke !== "function") {
      settings = {
        ...next,
        mediumLimit: next.mediumLimit || 2 * MB,
        lightLimit: next.lightLimit || 512 * 1024,
      };
      settings.maxOverallDownloadLimit = modeLimit(currentMode());
      fillForm();
      await loadRemote();
      return;
    }
    settings = await invoke("save_settings", { settings: next });
    fillForm();
    await loadRemote();
    if (opening) showPane("access");
  } catch (err) {
    showError(err);
    fillForm();
    await loadRemote();
  } finally {
    saving = false;
    if (saveQueued) {
      saveQueued = false;
      persistSettings();
    }
  }
}

async function loadSettings() {
  const invoke = invoker();
  if (typeof invoke !== "function") return;
  try {
    settings = await invoke("get_settings");
  } catch (err) {
    console.error(err);
  }
}

async function loadLogins() {
  const invoke = invoker();
  if (typeof invoke !== "function") {
    try { logins = JSON.parse(localStorage.getItem(LOGINS_KEY)) || []; } catch { logins = []; }
    return;
  }
  try {
    logins = await invoke("get_logins");
  } catch (err) {
    console.error(err);
  }
}

async function loadVideoTools() {
  const invoke = invoker();
  if (typeof invoke !== "function") {
    renderVideoTools();
    return;
  }
  try {
    videoTools = await invoke("video_tools");
  } catch (err) {
    console.error(err);
  }
  renderVideoTools();
}

async function loadAutostart() {
  const invoke = invoker();
  if (typeof invoke !== "function") {
    settingsAutostart.closest(".field")?.classList.add("hidden");
    return;
  }
  try {
    settingsAutostart.checked = await invoke("autostart_enabled");
  } catch (err) {
    console.error(err);
    settingsAutostart.closest(".field")?.classList.add("hidden");
  }
}

async function persistAutostart() {
  const invoke = invoker();
  if (typeof invoke !== "function") return;
  hideError();
  try {
    await invoke("set_autostart", { enabled: settingsAutostart.checked });
  } catch (err) {
    showError(err);
    await loadAutostart();
  }
}

function showPane(name) {
  const panes = document.querySelectorAll(".prefs-pane");
  const items = document.querySelectorAll(".prefs-item");
  let found = false;
  for (const pane of panes) {
    const on = pane.dataset.pane === name;
    pane.classList.toggle("hidden", !on);
    if (on) found = true;
  }
  if (!found) {
    name = "general";
    for (const pane of panes) {
      pane.classList.toggle("hidden", pane.dataset.pane !== name);
    }
  }
  for (const item of items) {
    item.classList.toggle("active", item.dataset.pane === name);
  }
  try { localStorage.setItem(PANE_KEY, name); } catch { /* ignore */ }
}

// ── Remote ─────────────────────────────────────────────────────────────
const remotePair = document.getElementById("remote-pair");
const remoteNote = document.getElementById("remote-note");
const remoteHost = document.getElementById("remote-host");
const remotePort = document.getElementById("remote-port");
const remoteSecret = document.getElementById("remote-secret");
const remoteQr = document.getElementById("remote-qr");

const QUIET = 4;
function qrSvg(width, modules) {
  const side = width + QUIET * 2;
  const rects = [];
  for (let y = 0; y < width; y++) {
    let run = 0;
    for (let x = 0; x <= width; x++) {
      if (x < width && modules[y * width + x]) { run++; continue; }
      if (run) {
        rects.push(`<rect x="${x - run + QUIET}" y="${y + QUIET}" width="${run}" height="1"/>`);
        run = 0;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" role="img" aria-label="The pairing secret as a QR code" shape-rendering="crispEdges">`
    + `<rect width="${side}" height="${side}" fill="#ffffff"/>`
    + `<g fill="#000000">${rects.join("")}</g></svg>`;
}

async function loadRemote() {
  const wanted = settingsRemote.checked;
  const invoke = invoker();
  let info = null;
  if (typeof invoke === "function") {
    try { info = await invoke("remote_info"); } catch (err) { console.error(err); }
  }

  const open = Boolean(info?.enabled);
  const paired = open && wanted && Boolean(info.host);
  remotePair.classList.toggle("hidden", !paired);

  if (paired) {
    remoteHost.textContent = info.host;
    remotePort.textContent = String(info.port);
    remoteSecret.textContent = info.secret;
    document.getElementById("remote-copy").dataset.value = info.secret;
    remoteQr.innerHTML = info.qrWidth > 0 ? qrSvg(info.qrWidth, info.qrModules) : "";
  }

  const said = [];
  if (saving && wanted !== open) {
    said.push("Restarting the download engine…");
  } else if (wanted && !open) {
    said.push("The port is not open yet — Garia is restarting the download engine.");
  } else if (!wanted && open) {
    said.push("Still open until the download engine comes back. Turning this off deletes the secret.");
  } else if (open && !info.host) {
    said.push("This machine isn't on a network Garia can find an address for, so there is nothing for another device to connect to.");
  } else if (paired && !info.defaultPort) {
    said.push(`Something else had aria2's usual port when Garia started, so it took ${info.port} instead. The pairing works, but the number can be different next launch.`);
  }
  remoteNote.textContent = said.join(" ");
  remoteNote.classList.toggle("hidden", said.length === 0);
}

// ── Logins ─────────────────────────────────────────────────────────────
const loginOverlay = document.getElementById("login-overlay");
const loginTitle = document.getElementById("login-title");
const loginHost = document.getElementById("login-host");
const loginUser = document.getElementById("login-user");
const loginPass = document.getElementById("login-pass");
const loginPassHint = document.getElementById("login-pass-hint");
const loginHeadersEl = document.getElementById("login-headers");
const loginDelete = document.getElementById("login-delete");
const loginError = document.getElementById("login-error");

function renderLogins() {
  settingsLogins.textContent = "";
  if (!logins.length) {
    const li = document.createElement("li");
    li.className = "login-empty";
    li.textContent = "No sites yet.";
    settingsLogins.append(li);
    return;
  }
  for (const login of logins) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "login-row";
    btn.innerHTML = '<span class="login-host"></span><span class="login-what"></span>';
    btn.querySelector(".login-host").textContent = login.host;
    btn.querySelector(".login-what").textContent = loginSummary(login);
    btn.addEventListener("click", () => openLogin(login.host));
    li.append(btn);
    settingsLogins.append(li);
  }
}

function renderPassHint(login) {
  if (login?.hasPassword && login.viaHeader) {
    loginPassHint.textContent =
      "This one has a space in it, and netrc has no way to quote a space — so " +
      "Garia sends it as an Authorization header instead, which aria2 writes " +
      "into its session file. Leave the box empty to keep it.";
  } else if (login?.hasPassword) {
    loginPassHint.textContent =
      "Saved in a netrc file only aria2 reads. Leave the box empty to keep it.";
  } else {
    loginPassHint.textContent =
      "Kept in a netrc file aria2 reads for itself. A password with a space " +
      "in it can't go in a netrc — that one becomes a header, and says so here.";
  }
}

function openLogin(host = "") {
  const login = logins.find((l) => l.host === host);
  editingHost = login ? login.host : "";
  loginTitle.textContent = login ? "Edit site" : "Add a site";
  loginHost.value = login ? login.host : host;
  loginUser.value = login ? login.username : "";
  loginPass.value = "";
  loginHeadersEl.value = login ? (login.headers || []).join("\n") : "";
  loginDelete.classList.toggle("hidden", !login);
  loginError.classList.add("hidden");
  renderPassHint(login);
  loginOverlay.classList.remove("hidden");
  setTimeout(() => (login ? loginUser : loginHost).focus(), 50);
}

function closeLogin() { loginOverlay.classList.add("hidden"); }

function loginBusy(busy) {
  document.getElementById("login-save").disabled = busy;
  loginDelete.disabled = busy;
}

function mockLogins(entry, verb) {
  const host = siteOf(entry.host);
  const next = logins.filter((l) => l.host !== host);
  if (verb === "save") {
    if (!host) throw new Error("Which site is this for? Paste a URL or type a host name.");
    const was = logins.find((l) => l.host === host);
    const headers = (entry.headers || []).map((h) => h.trim()).filter(Boolean);
    for (const h of headers) {
      if (!h.split(":")[0]?.trim() || !h.includes(":")) {
        throw new Error(`"${h}" is not a header — write it as Name: value`);
      }
    }
    const username = entry.username;
    const password = entry.password === null ? (was?.password ?? "") : entry.password;
    if (!username && entry.password) throw new Error("A password needs a user name to go with it.");
    if (!username && !headers.length) {
      throw new Error("Nothing to save — give the site a user name, a header, or both.");
    }
    const kept = username ? password : "";
    const viaHeader = !!kept && /\s/.test(kept);
    next.push({
      host,
      username,
      password: kept,
      hasPassword: !!kept,
      viaHeader,
      headers,
      extraHeaders: viaHeader ? [`Authorization: Basic ${btoa(`${username}:${kept}`)}`] : [],
    });
    next.sort((a, b) => a.host.localeCompare(b.host));
  }
  localStorage.setItem(LOGINS_KEY, JSON.stringify(next));
  return next;
}

async function putLogin(entry) {
  const invoke = invoker();
  if (typeof invoke === "function") {
    logins = await invoke("save_login", entry);
    return;
  }
  logins = mockLogins(entry, "save");
}

async function dropLogin(host) {
  const invoke = invoker();
  if (typeof invoke === "function") {
    logins = await invoke("delete_login", { host });
    return;
  }
  logins = mockLogins({ host }, "delete");
}

async function saveLogin() {
  loginError.classList.add("hidden");
  loginBusy(true);
  try {
    const typed = loginPass.value;
    await putLogin({
      host: loginHost.value,
      username: loginUser.value.trim(),
      password: typed ? typed : (editingHost ? null : ""),
      headers: loginHeadersEl.value.split("\n"),
    });
    renderLogins();
    closeLogin();
  } catch (err) {
    loginError.textContent = String(err?.message || err);
    loginError.classList.remove("hidden");
  } finally {
    loginBusy(false);
  }
}

async function removeLogin() {
  loginError.classList.add("hidden");
  loginBusy(true);
  try {
    await dropLogin(editingHost || loginHost.value);
    renderLogins();
    closeLogin();
  } catch (err) {
    loginError.textContent = String(err?.message || err);
    loginError.classList.remove("hidden");
  } finally {
    loginBusy(false);
  }
}

function pickFolder() {
  return window.__TAURI__?.dialog?.open;
}

document.querySelector(".prefs-nav").addEventListener("click", (e) => {
  const item = e.target.closest(".prefs-item");
  if (!item) return;
  showPane(item.dataset.pane);
});

for (const input of [settingsNotify, settingsSmart, settingsCatch, settingsInOrder, settingsSched, settingsRemote]) {
  input.addEventListener("change", persistSettings);
}

for (const input of [settingsDir, settingsMedium, settingsLight, settingsConc, settingsRatio, settingsSeedFor, settingsCookies, settingsSchedFrom, settingsSchedTo]) {
  input.addEventListener("change", persistSettings);
}

settingsAutostart.addEventListener("change", persistAutostart);

for (const input of [settingsSched, settingsSchedFrom, settingsSchedTo]) {
  input.addEventListener("input", renderScheduleSummary);
}

document.getElementById("catch-bookmarklet").addEventListener("click", (e) => {
  e.preventDefault();
});

document.getElementById("settings-browse").addEventListener("click", async () => {
  const pick = pickFolder();
  if (typeof pick !== "function") {
    showError("No folder picker here — type the path instead.");
    return;
  }
  try {
    const chosen = await pick({
      directory: true,
      multiple: false,
      title: "Choose a download folder",
      defaultPath: settingsDir.value.trim() || undefined,
    });
    if (typeof chosen === "string" && chosen) {
      settingsDir.value = chosen;
      await persistSettings();
    }
  } catch (err) {
    console.error(err);
  }
});

document.getElementById("settings-cookies-browse").addEventListener("click", async () => {
  const pick = pickFolder();
  if (typeof pick !== "function") {
    showError("No file picker here — type the path instead.");
    return;
  }
  try {
    const chosen = await pick({
      multiple: false,
      title: "Choose a cookies.txt",
      filters: [{ name: "Cookies", extensions: ["txt"] }],
      defaultPath: settingsCookies.value.trim() || undefined,
    });
    if (typeof chosen === "string" && chosen) {
      settingsCookies.value = chosen;
      await persistSettings();
    }
  } catch (err) {
    console.error(err);
  }
});

document.getElementById("remote-copy").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  let copied = true;
  try {
    await copyText(btn.dataset.value || "");
  } catch (err) {
    copied = false;
    console.error(err);
  }
  btn.textContent = copied ? "Copied" : "Blocked";
  setTimeout(() => { btn.textContent = "Copy"; }, 1200);
});

document.getElementById("settings-login-add").addEventListener("click", () => openLogin());
document.getElementById("login-save").addEventListener("click", saveLogin);
document.getElementById("login-cancel").addEventListener("click", closeLogin);
document.getElementById("login-close").addEventListener("click", closeLogin);
loginDelete.addEventListener("click", removeLogin);
loginOverlay.addEventListener("click", (e) => { if (e.target === loginOverlay) closeLogin(); });
loginPass.addEventListener("keydown", (e) => { if (e.key === "Enter") saveLogin(); });
loginHost.addEventListener("keydown", (e) => { if (e.key === "Enter") saveLogin(); });

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!loginOverlay.classList.contains("hidden")) {
    closeLogin();
    return;
  }
});

document.querySelector(".prefs-main").addEventListener("click", (e) => {
  const link = e.target.closest("a[href]");
  if (!link || !window.__TAURI__?.opener?.openUrl) return;
  if (link.id === "catch-bookmarklet") return;
  e.preventDefault();
  window.__TAURI__.opener.openUrl(link.href).catch((err) => console.error(err));
});

const listen = window.__TAURI__?.event?.listen;
if (typeof listen === "function") {
  listen("settings-changed", (event) => {
    if (!event?.payload || saving) return;
    settings = event.payload;
    fillForm();
    loadRemote();
  });
  listen("logins-changed", (event) => {
    if (Array.isArray(event?.payload)) {
      logins = event.payload;
      renderLogins();
    }
  });
}

(async function boot() {
  let pane = "general";
  try { pane = localStorage.getItem(PANE_KEY) || "general"; } catch { /* ignore */ }
  showPane(pane);
  await loadSettings();
  fillForm();
  await Promise.all([loadLogins(), loadVideoTools(), loadAutostart(), loadRemote()]);
  renderLogins();
})();
