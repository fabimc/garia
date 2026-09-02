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
  catchClipboard: true,
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

function catchLabel(url) {
  if (url.startsWith("magnet:")) return "this magnet link";
  const path = url.split(/[?#]/, 1)[0];
  let name = path.split("/").pop() || "";
  try { name = decodeURIComponent(name); } catch {}
  return name || url;
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

// ── Video downloads (yt-dlp) ─────────────────────────────────────────────
// aria2 downloads files, and a video page is not a file. yt-dlp is what turns
// one into the other: it reads the page, and hands back the real media URLs —
// which aria2 then fetches in parallel like anything else, so a video download
// is as fast, as resumable, and as visible in the list as every other row.

// What the backend found to work with, asked for once at launch.
let videoTools = { version: "", source: "", ffmpeg: false };

async function loadVideoTools() {
  const invoker = window.__TAURI__?.core?.invoke;
  if (typeof invoker !== "function") return;
  try {
    videoTools = await invoker("video_tools");
  } catch (err) {
    console.error(err);
  }
  renderVideoTools();
}

function renderVideoTools() {
  const el = document.getElementById("settings-video");
  if (!el) return;
  if (!videoTools.version) {
    el.textContent =
      "No yt-dlp found, so video pages download as pages. Install one with " +
      "`brew install yt-dlp`, or a python3 3.10 or newer for the copy garia ships.";
    return;
  }
  const where = videoTools.source === "bundled" ? "the bundled copy" : "your own";
  const merge = videoTools.ffmpeg
    ? "ffmpeg is here, so the qualities that arrive as separate video and audio can be merged."
    : "No ffmpeg, so only qualities that come as a single file are offered — `brew install ffmpeg` for the rest.";
  el.textContent = `yt-dlp ${videoTools.version} (${where}). ${merge}`;
}

// Extensions that mean the URL already *is* the file. Probing one of these
// would cost seconds to be told what the URL already said.
const DIRECT_EXTS = new Set([
  ...Object.values(FOLDERS).flat(),
  "exe", "msi", "deb", "rpm", "apk", "jar", "bin", "img", "torrent",
  "json", "xml", "svg", "png", "jpg", "jpeg", "gif", "webp", "dat", "xip",
]);

// Worth asking yt-dlp about? Anything that isn't already a file, a magnet, or
// a torrent. Getting this wrong in the cautious direction costs a probe that
// finds nothing; getting it wrong the other way downloads an HTML page.
function looksLikeAPage(url) {
  if (!/^https?:\/\//i.test(url)) return false;
  const ext = extensionOf(url);
  return !ext || !DIRECT_EXTS.has(ext);
}

// ffmpeg will remux almost anything into Matroska, but MP4 and WebM each only
// take their own kind of audio — so a mismatched pair lands in .mkv rather
// than failing at the merge, after both halves have already downloaded.
const CONTAINER = {
  mp4: "mp4", m4v: "mp4", m4a: "mp4", mov: "mp4",
  webm: "webm", opus: "webm", oga: "webm", ogg: "webm",
};

function containerOf(ext) {
  return CONTAINER[ext] || "";
}

// One row per quality *per container*. Listing 1080p five times because
// YouTube encodes it in five codecs is noise; listing 240p once when the site
// offers it as an 11 MB MOV and a 4.7 MB WebM throws away the choice that
// actually matters. The container is the line between the two.
function choiceKey(label, ext) {
  return `${label}/${containerOf(ext) || ext}`;
}

function mergedExt(videoExt, audioExt) {
  const v = containerOf(videoExt);
  return v && v === containerOf(audioExt) ? videoExt : "mkv";
}

function qualityLabel(f) {
  if (!f.height) return "Video";
  const fps = Math.round(f.fps);
  return fps >= 50 ? `${f.height}p${fps}` : `${f.height}p`;
}

// One entry per quality the user could actually end up with. Three sources,
// in the order they're preferred: a single file that already has both streams,
// the same picture merged out of two halves, and sound on its own.
function buildChoices(info, canMerge) {
  const choices = [];
  const seen = new Set();   // one row per quality — the best way to get it wins

  const complete = info.formats.filter((f) => f.kind === "complete");
  const videos = info.formats.filter((f) => f.kind === "video");
  const audios = info.formats.filter((f) => f.kind === "audio");

  for (const f of complete) {
    const label = qualityLabel(f);
    const key = choiceKey(label, f.ext);
    if (seen.has(key)) continue;
    seen.add(key);
    choices.push({
      label,
      detail: [f.ext.toUpperCase(), "one file", f.note].filter(Boolean).join(" · "),
      bytes: f.filesize,
      formats: [f],
      ext: f.ext,
    });
  }

  if (canMerge && audios.length) {
    for (const v of videos) {
      const label = qualityLabel(v);
      const key = choiceKey(label, v.ext);
      if (seen.has(key)) continue;
      // Same container first, so the merge is a copy into the format the site
      // already chose rather than a fallback into Matroska.
      const audio =
        audios.find((a) => containerOf(a.ext) === containerOf(v.ext)) || audios[0];
      seen.add(key);
      const ext = mergedExt(v.ext, audio.ext);
      choices.push({
        label,
        detail: `${ext.toUpperCase()} · video + audio, merged`,
        bytes: (v.filesize || 0) + (audio.filesize || 0),
        formats: [v, audio],
        ext,
      });
    }
  }

  // Tallest first, and within one quality the biggest file first — which is
  // also the most compatible codec, since the small ones are the new ones.
  choices.sort(
    (a, b) =>
      (parseInt(b.label, 10) || 0) - (parseInt(a.label, 10) || 0) ||
      (b.bytes || 0) - (a.bytes || 0),
  );

  if (audios.length) {
    const a = audios[0];
    choices.push({
      label: "Audio",
      detail: [a.ext.toUpperCase(), a.bitrate ? `${Math.round(a.bitrate)} kbps` : "", "sound only"]
        .filter(Boolean).join(" · "),
      bytes: a.filesize,
      formats: [a],
      ext: a.ext,
    });
  }

  return choices;
}

// What's on the page but out of reach, said plainly rather than left as a
// quality that mysteriously isn't listed.
function missingNote(info, choices, canMerge) {
  const notes = [];
  const videos = info.formats.filter((f) => f.kind === "video");
  if (!canMerge && videos.length) {
    const best = Math.max(...videos.map((f) => f.height || 0));
    notes.push(
      `Higher qualities here${best ? ` — up to ${best}p` : ""} arrive as separate ` +
      "video and audio. Install ffmpeg (`brew install ffmpeg`) and garia will merge them.",
    );
  }
  if (!choices.length) {
    notes.push("Nothing on this page can be downloaded as a plain file — it's a live or segmented stream.");
  }
  return notes.join(" ");
}

// Filenames come from a page title, which can hold anything at all.
function safeName(title) {
  return (title || "")
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .replace(/\.+$/, "");
}

function formatDuration(secs) {
  const s = Math.round(Number(secs) || 0);
  if (!s) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

// ── Merge jobs ───────────────────────────────────────────────────────────
// A merged quality is two aria2 downloads that have to end up as one file and
// one row. The pairing lives here, and on disk: it has to survive a quit, or a
// relaunch would show two mystery halves with no way to finish them.
const JOBS_KEY = "garia:merge-jobs";

function loadJobs() {
  try {
    const raw = JSON.parse(localStorage.getItem(JOBS_KEY) || "[]");
    const map = new Map(raw);
    // A quit during the merge leaves the job mid-flight. Both halves are on
    // disk and complete, so putting it back means it merges on the next poll.
    for (const job of map.values()) {
      if (job.state === "muxing") job.state = "downloading";
    }
    return map;
  } catch {
    return new Map();
  }
}

const jobs = loadJobs();

function saveJobs() {
  try {
    localStorage.setItem(JOBS_KEY, JSON.stringify([...jobs]));
  } catch {}
}

// Every aria2 gid a row stands for. One for an ordinary download; two for a
// merged video, whose second half deliberately has no row of its own.
function gidsFor(gid) {
  const job = jobs.get(gid);
  return job ? [gid, job.audioGid] : [gid];
}

function pathDir(path) {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "";
}

// aria2 forgets a finished download when it restarts, so a half can go missing
// between one launch and the next while its file sits on disk, complete. That
// is not a lost download — it is the normal end of one.
const FINISHED = { status: "complete", totalLength: 0, completedLength: 0, downloadSpeed: 0 };

// The two halves shown as the one thing the user asked for: one name, one bar,
// one status. Both rows are aria2's business; only this one is the user's.
function mergedRow(gid, video, audio, job) {
  const halves = [video || FINISHED, audio || FINISHED];
  const errored = halves.find((d) => d.status === "error");

  let status;
  if (job.state === "failed" || errored) status = "error";
  else if (job.state === "done") status = "complete";
  else if (halves.every((d) => d.status === "complete")) status = "merging";
  else if (halves.some((d) => d.status === "active")) status = "active";
  else if (halves.some((d) => d.status === "waiting")) status = "waiting";
  else if (halves.every((d) => d.status === "paused")) status = "paused";
  else status = halves[0].status;

  const path = job.outPath || "";
  return {
    gid,
    status,
    // Both halves together, because that's the wait the bar is measuring.
    totalLength: halves.reduce((n, d) => n + Number(d.totalLength || 0), 0),
    completedLength: halves.reduce((n, d) => n + Number(d.completedLength || 0), 0),
    downloadSpeed: halves.reduce((n, d) => n + Number(d.downloadSpeed || 0), 0),
    // The name is the file that will exist when this is over, from the first
    // second — not the half that happens to be downloading.
    files: [{ path: path || (job.dir ? `${job.dir}/${job.out}` : job.out), uris: [] }],
    dir: job.dir,
    errorMessage: job.error || errored?.errorMessage || "",
    errorCode: errored?.errorCode,
    // Marks the row as a pair, for the handlers that have to act on both.
    job: { ...job, videoGid: gid, audioGid: job.audioGid },
    // Reveal only works once there's something to reveal.
    onDisk: job.state === "done",
  };
}

// Folds every merge job's two rows into one. A job outlives a half going
// missing — only losing both means the pair is gone, which is what deleting
// the row does.
function collapseJobs(all) {
  if (!jobs.size) return all;

  const byGid = new Map(all.map((d) => [d.gid, d]));
  const claimed = new Set();
  const merged = [];
  let changed = false;

  for (const [videoGid, job] of [...jobs]) {
    const video = byGid.get(videoGid);
    const audio = byGid.get(job.audioGid);
    if (!video && !audio) {
      jobs.delete(videoGid);
      changed = true;
      continue;
    }
    claimed.add(videoGid);
    claimed.add(job.audioGid);
    merged.push(mergedRow(videoGid, video, audio, job));
  }
  if (changed) saveJobs();

  // Order doesn't matter here — the poll sorts every row by status after this.
  return [...merged, ...all.filter((d) => !claimed.has(d.gid))];
}

// Both halves are down: stitch them. Started, not awaited — ffmpeg takes
// seconds on a short clip and minutes on a long one, and the poll runs every
// second. The state flips to "muxing" before the call, which is what stops the
// next tick from starting a second ffmpeg on the same two files.
function runPendingMerges(rows) {
  const invoker = window.__TAURI__?.core?.invoke;
  if (typeof invoker !== "function") return;

  for (const row of rows) {
    if (row.status !== "merging" || row.job?.state !== "downloading") continue;

    const job = jobs.get(row.gid);
    if (!job || job.state !== "downloading") continue;

    // The paths were written down when the job was made, so the merge never
    // depends on aria2 still remembering either half.
    const videoPath = job.videoPath || snapshotPath(row.gid);
    const audioPath = job.audioPath || snapshotPath(job.audioGid);
    if (!videoPath || !audioPath) continue;

    job.state = "muxing";
    saveJobs();

    const outPath = `${pathDir(videoPath) || job.dir}/${job.out}`;
    invoker("mux_video", { videoPath, audioPath, outPath })
      .then((path) => {
        job.outPath = path;
        job.state = "done";
      })
      .catch((err) => {
        console.error(err);
        job.state = "failed";
        const message = String(err?.message || err);
        job.error = message === "no-ffmpeg"
          ? "Both halves downloaded, but there's no ffmpeg to merge them"
          : `Could not merge the two halves: ${message}`;
      })
      .finally(saveJobs);
  }
}

// The path aria2 last reported for a gid. Reading it back from the raw poll is
// what keeps the merge honest about where the files actually landed.
const rawPaths = new Map();

function snapshotPath(gid) {
  return rawPaths.get(gid) || "";
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
  const map = { active: "Downloading", merging: "Merging", waiting: "Queued", paused: "Paused", complete: "Complete", error: "Error", removed: "Removed" };
  return map[status] || status;
}

// "merging" is garia's own: aria2 is done and the file isn't there yet. It
// borrows the active row's look, because that is what it is to the user.
function statusClass(status) {
  if (status === "merging") return "active";
  return ["complete", "error", "active", "paused"].includes(status) ? status : "waiting";
}

// Row order: what's moving first, what's finished last.
const STATUS_RANK = { active: 0, merging: 0.5, waiting: 1, paused: 2, error: 3, complete: 4, removed: 5 };

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
  reprobe: BTN_OPEN + '<polyline points="21 4 21 10 15 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L21 10"/></svg>',
  remove: BTN_OPEN + '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
};

const ACTION_TITLES = {
  stop: "Pause",
  resume: "Resume",
  reveal: "Show in Finder",
  retry: "Retry download",
  reprobe: "Read the page again and pick a quality",
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
  // A merged row names a file that doesn't exist until ffmpeg has run, so it
  // says so rather than offering to reveal a path that isn't there yet.
  const path = dl.job && !dl.onDisk ? "" : dl.files?.[0]?.path || "";
  if (dl.status === "merging") {
    // Nothing to pause: aria2 is finished and ffmpeg is a few seconds.
  } else if (dl.status === "active" || dl.status === "waiting") {
    out.push({ action: "stop", kind: "pill", tone: "accent", label: "Pause" });
  } else if (dl.status === "paused") {
    out.push({ action: "resume", kind: "pill", tone: "accent", label: "Resume" });
  } else if (dl.status === "error" && dl.job?.webpageUrl) {
    // The media URLs a site hands out expire — often within hours — so a
    // failed video download is re-read from the page, not re-queued.
    out.push({ action: "reprobe", kind: "pill", tone: "accent", label: "Retry" });
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
  const reprobe = li.querySelector('[data-action="reprobe"]');
  if (reprobe) reprobe.dataset.url = dl.job?.webpageUrl || "";
}

// ── Section headers ──────────────────────────────────────────────────────
const SECTION_LABELS = {
  active: "Downloading",
  merging: "Merging",
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
    const rowStatus = el.dataset.status === "merging" ? "active" : el.dataset.status;
    const statusMatch = activeFilter === "all" || rowStatus === activeFilter;
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

    const raw = [...active, ...waiting, ...stopped];
    // Where each half actually landed, kept before the pairs are folded away —
    // the merge needs both paths, and only aria2 knows them.
    rawPaths.clear();
    for (const dl of raw) {
      const path = dl.files?.[0]?.path;
      if (path) rawPaths.set(dl.gid, path);
    }

    const all = collapseJobs(raw);
    runPendingMerges(all);
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

      const counted = dl.status === "merging" ? "active" : dl.status;
      if (tally[counted] !== undefined) tally[counted]++;
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

  const modalBusy     = document.getElementById("modal-busy");
  const modalBusyText  = document.getElementById("modal-busy-text");
  const modalPlain    = document.getElementById("modal-plain");
  const modalOk       = document.getElementById("modal-ok");
  const modalTitle    = document.getElementById("modal-title");
  const videoPanel    = document.getElementById("video-panel");
  const videoChoices  = document.getElementById("video-choices");
  const videoNote     = document.getElementById("video-note");

  // The dialog is one of three things at a time: asking for a URL, waiting on
  // yt-dlp, or offering qualities. Every widget belongs to exactly one of them,
  // so the state is set in one place rather than toggled six.
  let modalMode = "url";
  let probed = null;      // the last successful probe, and its choices
  let probeToken = 0;     // a probe the user has moved on from must not land

  function setModalMode(mode) {
    modalMode = mode;
    const isUrl = mode === "url";
    document.querySelector(".modal-input-row").classList.toggle("hidden", !isUrl);
    document.querySelector('label[for="modal-url-input"]').classList.toggle("hidden", !isUrl);
    modalBusy.classList.toggle("hidden", mode !== "busy");
    videoPanel.classList.toggle("hidden", mode !== "video");
    modalOk.classList.toggle("hidden", mode === "busy");
    modalOk.textContent = mode === "video" ? "Download" : "OK";
    modalTitle.textContent = mode === "video" ? "Download video" : "Add download";
  }

  function openModal(url = "") {
    probeToken++;
    probed = null;
    modalUrlInput.value = url;
    torrentInput.value  = "";
    modalError.classList.add("hidden");
    modalPlain.classList.add("hidden");
    setModalMode("url");
    overlay.classList.remove("hidden");
    setTimeout(() => modalUrlInput.focus(), 50);
  }
  function closeModal() {
    probeToken++;   // whatever yt-dlp is doing, it is no longer wanted
    overlay.classList.add("hidden");
  }

  document.getElementById("open-modal-btn").addEventListener("click", () => openModal());
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

  // Hands the URL to aria2 exactly as typed. This is what the dialog has
  // always done, and it stays the fallback for everything yt-dlp declines.
  async function addPlainUrl(url, options = addOptions(url)) {
    modalError.classList.add("hidden");
    try {
      await rpc("aria2.addUri", [[url], options]);
      closeModal();
      await pollAndSync();
    } catch (err) {
      const unreachable = err.message.includes("Failed to fetch") || err.message.includes("Load failed");
      modalError.textContent = unreachable
        ? "aria2 isn't answering yet — give it a moment and try again"
        : err.message;
      modalError.classList.remove("hidden");
      setModalMode("url");
    }
  }

  // A URL that isn't obviously a file gets shown to yt-dlp first. When there's
  // no yt-dlp, or the URL is plainly a file, nothing changes from before.
  async function submitUrl() {
    const url = modalUrlInput.value.trim();
    if (!url) return;
    modalError.classList.add("hidden");
    modalPlain.classList.add("hidden");

    if (!videoTools.version || !looksLikeAPage(url)) {
      await addPlainUrl(url);
      return;
    }

    const token = ++probeToken;
    modalBusyText.textContent = "Looking for video…";
    setModalMode("busy");

    let info;
    try {
      info = await window.__TAURI__.core.invoke("video_probe", { url });
    } catch (err) {
      if (token !== probeToken) return;
      const message = String(err?.message || err);
      setModalMode("url");
      // yt-dlp's own diagnosis — it knows the difference between a login wall,
      // a private video, and a page with nothing on it.
      modalError.textContent = message === "no-ytdlp"
        ? "No yt-dlp to read that page with — see Settings"
        : message;
      modalError.classList.remove("hidden");
      // The page may still be a perfectly good file. Offer, don't assume.
      modalPlain.classList.remove("hidden");
      return;
    }
    if (token !== probeToken) return;

    showPicker(info, url);
  }

  // ── The quality picker ──────────────────────────────────────────────────
  function showPicker(info, sourceUrl) {
    const choices = buildChoices(info, videoTools.ffmpeg);
    probed = { info: { ...info, webpageUrl: info.webpageUrl || sourceUrl }, choices, selected: 0 };

    document.getElementById("video-title").textContent = info.title || sourceUrl;
    const sub = [info.uploader, formatDuration(info.duration), info.extractor]
      .filter(Boolean).join(" · ");
    document.getElementById("video-sub").textContent = sub;

    const thumb = document.getElementById("video-thumb");
    thumb.classList.toggle("hidden", !info.thumbnail);
    if (info.thumbnail) thumb.src = info.thumbnail;

    videoChoices.textContent = "";
    choices.forEach((c, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "video-choice";
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", String(i === 0));
      btn.dataset.index = String(i);
      btn.innerHTML =
        `<span class="video-choice-label"></span>` +
        `<span class="video-choice-detail"></span>` +
        `<span class="video-choice-size"></span>`;
      btn.querySelector(".video-choice-label").textContent = c.label;
      btn.querySelector(".video-choice-detail").textContent = c.detail;
      // An estimate is still worth showing — it's the difference between a
      // 40 MB clip and a 4 GB one — but it shouldn't read as a promise.
      btn.querySelector(".video-choice-size").textContent = c.bytes ? formatBytes(c.bytes) : "";
      videoChoices.appendChild(btn);
    });

    const note = missingNote(info, choices, videoTools.ffmpeg);
    videoNote.textContent = note;
    videoNote.classList.toggle("hidden", !note);

    modalOk.disabled = choices.length === 0;
    modalPlain.classList.toggle("hidden", choices.length > 0);
    setModalMode("video");
  }

  videoChoices.addEventListener("click", (e) => {
    const btn = e.target.closest(".video-choice");
    if (!btn || !probed) return;
    probed.selected = Number(btn.dataset.index);
    for (const el of videoChoices.querySelectorAll(".video-choice")) {
      el.setAttribute("aria-checked", String(el === btn));
    }
  });

  // Queue what the picker chose. One format is one download; two are two, and
  // a merge job that turns them back into one file and one row.
  async function submitVideo() {
    if (!probed) return;
    const { info, choices, selected } = probed;
    const choice = choices[selected];
    if (!choice) return;

    const base = safeName(info.title) || "video";
    // Routed by what the file will be, not by the page URL — which has no
    // extension at all, and would land every video in the base folder.
    const dir = targetDir(`x.${choice.ext}`);
    const common = dir ? { dir } : {};
    // Some sites mint a URL for one User-Agent and 403 every other.
    const referer = info.webpageUrl ? { referer: info.webpageUrl } : {};

    modalBusyText.textContent = "Queueing…";
    setModalMode("busy");

    try {
      if (choice.formats.length === 1) {
        const f = choice.formats[0];
        await rpc("aria2.addUri", [[f.url], {
          ...common, ...referer, out: `${base}.${f.ext}`, header: f.headers,
        }]);
      } else {
        const [v, a] = choice.formats;
        // yt-dlp's own naming for the halves, so a leftover part is
        // recognisable for what it is.
        const videoName = `${base}.f${v.id}.${v.ext}`;
        const audioName = `${base}.f${a.id}.${a.ext}`;
        const videoGid = await rpc("aria2.addUri", [[v.url], {
          ...common, ...referer, out: videoName, header: v.headers,
        }]);
        const audioGid = await rpc("aria2.addUri", [[a.url], {
          ...common, ...referer, out: audioName, header: a.headers,
        }]);
        jobs.set(videoGid, {
          audioGid,
          dir,
          out: `${base}.${choice.ext}`,
          // Written down now rather than read back later: aria2 forgets a
          // finished download across a restart, and the merge still has to
          // know where its halves are.
          videoPath: dir ? `${dir}/${videoName}` : "",
          audioPath: dir ? `${dir}/${audioName}` : "",
          title: info.title,
          webpageUrl: info.webpageUrl,
          state: "downloading",
        });
        saveJobs();
      }
      closeModal();
      await pollAndSync();
    } catch (err) {
      setModalMode("video");
      modalError.textContent = String(err?.message || err);
      modalError.classList.remove("hidden");
    }
  }

  modalOk.addEventListener("click", () => {
    if (modalMode === "video") submitVideo();
    else submitUrl();
  });
  modalPlain.addEventListener("click", () => addPlainUrl(modalUrlInput.value.trim()));
  modalUrlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitUrl(); });

  // Per-row buttons and section "View all" links
  listEl.addEventListener("click", async (e) => {
    const link = e.target.closest(".dl-section-link");
    if (link) { setFilter(link.dataset.filter); return; }

    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const { gid, action, path, url } = btn.dataset;
    // Delete opens a dialog rather than acting, so it returns before the poll.
    if (action === "remove") { openConfirm(gid); return; }
    // So does retrying a video: the URLs have expired, so the page has to be
    // read again and a quality picked, which is the add dialog's job.
    if (action === "reprobe") {
      if (url) { openModal(url); submitUrl(); }
      return;
    }

    // The two halves of a merged download move together or the pair is
    // meaningless — one paused half stalls the merge indefinitely.
    const gids = gidsFor(gid);

    try {
      if (action === "stop")   await Promise.all(gids.map(g => rpc("aria2.pause",   [g])));
      if (action === "resume") await Promise.all(gids.map(g => rpc("aria2.unpause", [g])));
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
    const gids = gidsFor(gid);

    for (const g of gids) {
      const half = g === gid ? dl : null;
      // Only a running download has to be stopped first; a finished one
      // already has a result to purge.
      const status = half ? half.status : "active";
      if (["active", "waiting", "paused", "merging"].includes(status)) {
        try { await rpc("aria2.remove", [g]); } catch (err) { /* already stopped */ }
      }
      await purgeResult(g);
    }

    if (alsoTrash) {
      // A merged download can have left three files behind: the two halves and
      // the merged one. Whichever of them survive, they all go.
      const paths = dl?.job
        ? [
            dl.job.videoPath || snapshotPath(gid),
            dl.job.audioPath || snapshotPath(dl.job.audioGid),
            dl.job.outPath,
          ].filter(Boolean)
        : (dl?.files || []).map(f => f.path).filter(Boolean);
      const invoker = window.__TAURI__?.core?.invoke;
      if (paths.length && typeof invoker === "function") {
        try { await invoker("trash_files", { paths }); } catch (err) { console.error(err); }
      }
    }

    if (jobs.delete(gid)) saveJobs();
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
    const onDisk = Number(dl.completedLength) > 0 &&
      (dl.job ? Boolean(dl.job.videoPath || snapshotPath(gid))
              : (dl.files || []).some(f => f.path));
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
    const all = gids.flatMap(gidsFor);
    await Promise.allSettled(all.map(gid => rpc(method, [gid])));
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
  const settingsCatch   = document.getElementById("settings-catch");
  const settingsError   = document.getElementById("settings-error");

  const MB = 1024 * 1024;

  function openSettings() {
    settingsError.classList.add("hidden");
    loadVideoTools();
    settingsDir.value = settings.downloadDir || "";
    const bytes = Number(settings.maxOverallDownloadLimit) || 0;
    // Bytes per second is what aria2 wants; MB/s is what a person thinks in.
    settingsLimit.value = bytes ? String(Math.round((bytes / MB) * 100) / 100) : "0";
    settingsConc.value = String(settings.maxConcurrentDownloads || 5);
    settingsNotify.checked = settings.notifyOnComplete !== false;
    settingsSmart.checked = settings.smartFolders === true;
    settingsCatch.checked = settings.catchClipboard !== false;
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
      catchClipboard: settingsCatch.checked,
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
  document.getElementById("catch-bookmarklet").addEventListener("click", (e) => {
    // The link is for dragging onto the bookmarks bar, not for clicking here.
    e.preventDefault();
  });
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

  // ── Catch from elsewhere ────────────────────────────────────────────────
  // Two ways a URL arrives without being typed: copied (an offer) and sent
  // on the garia:// scheme (an instruction). The first clipboard contents
  // at launch are ignored on the Rust side, so a leftover copy doesn't
  // greet you.
  const catchBanner = document.getElementById("catch-banner");
  const catchText   = document.getElementById("catch-text");
  let offeredUrl = "";
  const recentlyCaught = new Set();

  function hideCatch() {
    offeredUrl = "";
    catchBanner.classList.add("hidden");
  }

  async function ingestUrl(url) {
    hideCatch();
    if (!videoTools.version) await loadVideoTools();
    // A file (or magnet) can go straight in; a page still needs the picker.
    if (!looksLikeAPage(url) || url.startsWith("magnet:")) {
      try {
        await rpc("aria2.addUri", [[url], addOptions(url)]);
        await pollAndSync();
      } catch (err) {
        openModal(url);
        modalError.textContent = String(err?.message || err);
        modalError.classList.remove("hidden");
      }
      return;
    }
    openModal(url);
    await submitUrl();
  }

  async function notifyCatch(url) {
    const n = notifications();
    if (!n) return;
    try {
      if (!(await n.ready)) return;
      n.api.sendNotification({
        title: "Download this file?",
        body: catchLabel(url),
      });
    } catch (err) {
      console.error(err);
    }
  }

  function handleCatch({ url, source } = {}) {
    if (!url) return;
    const key = `${source}:${url}`;
    if (recentlyCaught.has(key)) return;
    recentlyCaught.add(key);
    setTimeout(() => recentlyCaught.delete(key), 2500);

    if (source === "scheme") {
      ingestUrl(url);
      return;
    }
    if (settings.catchClipboard === false) return;
    offeredUrl = url;
    catchText.textContent = `Download ${catchLabel(url)}?`;
    catchBanner.classList.remove("hidden");
    if (!document.hasFocus()) notifyCatch(url);
  }

  document.getElementById("catch-add").addEventListener("click", () => {
    if (offeredUrl) ingestUrl(offeredUrl);
  });
  document.getElementById("catch-ignore").addEventListener("click", hideCatch);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideCatch();
  });

  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen === "function") {
    listen("catch-url", (event) => handleCatch(event.payload));
  }
  const invoker = window.__TAURI__?.core?.invoke;
  if (typeof invoker === "function") {
    invoker("take_pending_catch").then((pending) => {
      for (const event of pending || []) handleCatch(event);
    }).catch(() => {});
  }

  loadSettings();
  loadVideoTools();
  pollAndSync();
  setInterval(pollAndSync, 1000);
});
