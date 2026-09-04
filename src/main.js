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
  trafficMode: "full",
  mediumLimit: 2 * 1024 * 1024,
  lightLimit: 512 * 1024,
  maxOverallDownloadLimit: 0,
  seedRatio: 1,
  seedTimeMinutes: 0,
  smartFolders: false,
  notifyOnComplete: true,
  catchClipboard: true,
  inOrder: false,
  cookieFile: "",
  scheduleEnabled: false,
  scheduleStart: 2 * 60,
  scheduleEnd: 8 * 60,
};

async function loadSettings() {
  const invoker = window.__TAURI__?.core?.invoke;
  if (typeof invoker !== "function") return;   // browser dev mode: aria2's own defaults
  try {
    settings = await invoker("get_settings");
    renderTraffic();
  } catch (err) {
    console.error(err);
  }
}

// ── Traffic modes ────────────────────────────────────────────────────────
// One number is a setting; three named speeds are a control. Full is aria2's
// own "no limit"; the other two are whatever the user made them, and the same
// three can be aimed at a single download from its detail panel.
const MODES = ["full", "medium", "light"];
const MODE_LABELS = { full: "Full speed", medium: "Medium", light: "Light" };

function modeLimit(mode) {
  if (mode === "medium") return Number(settings.mediumLimit) || 0;
  if (mode === "light") return Number(settings.lightLimit) || 0;
  return 0;
}

function currentMode() {
  return MODES.includes(settings.trafficMode) ? settings.trafficMode : "full";
}

// A cap set when Light meant something else is still that many bytes, so the
// number is what a mode is recognised by — and a cap matching neither mode
// still has to be able to say what it is.
function modeOfLimit(bytes) {
  if (!(bytes > 0)) return "full";
  if (bytes === modeLimit("medium")) return "medium";
  if (bytes === modeLimit("light")) return "light";
  return "";
}

function limitLabel(bytes) {
  const mode = modeOfLimit(bytes);
  if (mode === "full") return "";
  return mode ? MODE_LABELS[mode] : formatSpeed(bytes);
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
  const options = dir ? { dir } : {};
  // Seeding rules cannot be pushed at a download that is already going, so
  // every torrent carries the rules that were in force when it was added.
  Object.assign(options, seedOptions());
  Object.assign(options, orderOptions());
  // Headers for a site with a login. A password is not here and never will
  // be: aria2 reads that out of its own netrc, per host, per request.
  Object.assign(options, loginOptions(url));
  return options;
}

// aria2 picks pieces to keep connections alive unless told otherwise, which is
// the right default for finishing fast and the wrong one for watching a file
// while it downloads. Like the seeding rules, this cannot be pushed at a
// download already in flight — so it rides on each one as it is added, and
// turning the setting on affects the next download rather than this one.
function orderOptions() {
  return settings.inOrder ? { "stream-piece-selector": "inorder" } : {};
}

// aria2 reads --seed-time=0 as "never seed", which is not what a blank field
// means, so no limit is the option's absence rather than a zero.
function seedOptions() {
  const options = { "seed-ratio": String(Number(settings.seedRatio) || 0) };
  const minutes = Number(settings.seedTimeMinutes) || 0;
  if (minutes > 0) options["seed-time"] = String(minutes);
  return options;
}

// ── Checksums ────────────────────────────────────────────────────────────
// aria2 hashes the bytes as they arrive and refuses to file a download whose
// digest doesn't match. So "verified" is not a state garia keeps: it is what
// `complete` already means on a download that was given a checksum, and the
// only thing to remember is that it had one.
//
// The seven digests and their lengths are aria2's, not a convention borrowed
// from elsewhere — it rejects a --checksum outright when the digit count and
// the named algorithm disagree. Which is also what lets a bare hash name its
// own algorithm: there is exactly one that could have produced it.
const CHECKSUM_ALGOS = {
  8: "adler32", 32: "md5", 40: "sha-1", 56: "sha-224",
  64: "sha-256", 96: "sha-384", 128: "sha-512",
};

const ALGO_LABELS = {
  adler32: "Adler-32", md5: "MD5", "sha-1": "SHA-1", "sha-224": "SHA-224",
  "sha-256": "SHA-256", "sha-384": "SHA-384", "sha-512": "SHA-512",
};

function algoDigits(algo) {
  return Number(Object.keys(CHECKSUM_ALGOS).find((n) => CHECKSUM_ALGOS[n] === algo)) || 0;
}

function normalizeAlgo(text) {
  const t = text.toLowerCase().replace(/-/g, "");
  return t === "adler32" || t === "md5" ? t : `sha-${t.slice(3)}`;
}

// What is actually in the clipboard when someone copies a hash: the digest on
// its own, a `sha256:` prefix in front of it, the whole `<hash>  <filename>`
// line out of a SHASUMS file, or certutil's two-digit groups. All four end up
// as the one string aria2 takes. Returns null for an empty field, an object
// with `error` for something unusable, and the parsed hash otherwise — the
// three answers the hint under the field has to tell apart.
function parseChecksum(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  // An algorithm the user named beats the one the length implies, so that a
  // disagreement between the two is caught here rather than by aria2 refusing
  // the download a moment later.
  const named = raw.match(/\b(adler-?32|md5|sha-?(?:224|256|384|512|1))\b[\s:=]*/i);
  const claimed = named ? normalizeAlgo(named[1]) : "";
  const rest = named ? raw.slice(named.index + named[0].length) : raw;

  const hex = (t) => /^[0-9a-f]+$/i.test(t);
  const tokens = rest.split(/[\s,]+/).filter(Boolean);
  let digest = tokens.find((t) => hex(t) && CHECKSUM_ALGOS[t.length]);
  // Joining the pieces is only safe when every one of them is hex — otherwise
  // the filename on a SHASUMS line would be swallowed into the digest.
  if (!digest && tokens.length > 1 && tokens.every(hex)) {
    const joined = tokens.join("");
    if (CHECKSUM_ALGOS[joined.length]) digest = joined;
  }
  if (!digest) {
    // Someone who named the algorithm has told us how long the digest should
    // be, so the count is the useful thing to say back rather than the list.
    const attempt = tokens.find(hex);
    if (claimed && attempt) {
      return { error: `A ${ALGO_LABELS[claimed]} hash is ${algoDigits(claimed)} hex digits long, and that one is ${attempt.length}.` };
    }
    return { error: "That isn't a hash garia can read. It takes 32, 40, 56, 64, 96 or 128 hex digits — on their own, or after something like sha256=." };
  }

  digest = digest.toLowerCase();
  const implied = CHECKSUM_ALGOS[digest.length];
  if (claimed && claimed !== implied) {
    return { error: `A ${ALGO_LABELS[claimed]} hash is ${algoDigits(claimed)} hex digits long, and that one is ${digest.length}.` };
  }
  const algo = claimed || implied;
  return { algo, digest, spec: `${algo}=${digest}`, label: ALGO_LABELS[algo] };
}

function checksumOption(parsed) {
  return parsed?.spec ? { checksum: parsed.spec } : {};
}

// The option as aria2 hands it back, taken apart for showing.
function splitChecksum(spec) {
  const text = String(spec || "");
  const at = text.indexOf("=");
  if (at < 1) return null;
  const algo = text.slice(0, at).toLowerCase();
  return { algo, digest: text.slice(at + 1), label: ALGO_LABELS[algo] || algo.toUpperCase(), spec: text };
}

// A hash is a claim about one file, and neither a torrent nor a magnet is one:
// they carry their own piece hashes, and aria2 takes --checksum on HTTP and FTP
// alone. Saying so by hiding the field beats saying so in a sentence nobody
// reads after the download has failed.
function takesChecksum(url) {
  return /^(https?|ftps?|sftp):/i.test(String(url || "").trim());
}

// ── Downloads behind a login ─────────────────────────────────────────────
// Three ways to prove who you are, and only one of them is garia's to send.
// A password lives in a netrc file that aria2 reads for itself — it is never
// an option on a download, which matters because an option on a download is
// written into aria2's session file and handed back by getOption. A cookie
// jar is a path aria2 reads at launch. What is left for this side is headers:
// the ones the user typed, and the Basic line Rust writes when a password has
// a space in it and netrc, which has no quoting, cannot hold it.
//
// Rust owns the list and never sends a password with it, so nothing here can
// leak one — the most this knows is that a site has one.
let logins = [];

// Browser dev mode has no Rust to keep them; the preview still has to be able
// to show both kinds of row.
const LOGINS_KEY = "garia:logins";

async function loadLogins() {
  const invoker = window.__TAURI__?.core?.invoke;
  if (typeof invoker !== "function") {
    try { logins = JSON.parse(localStorage.getItem(LOGINS_KEY)) || []; } catch { logins = []; }
    return;
  }
  try {
    logins = await invoker("get_logins");
  } catch (err) {
    console.error(err);
  }
}

// The host part of a URL, a host with a port, or a bare name. This mirrors
// host_of in Rust deliberately: the two have to agree about what "this site"
// means, or garia would attach a header where aria2 sends no password. (The
// detail panel's hostOf is a different thing — that one is for showing which
// server a byte came from, port and all.)
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

// Exact host, because that is what aria2 matches a netrc line against.
function loginFor(url) {
  const host = siteOf(url);
  return host ? logins.find(l => l.host === host) : undefined;
}

function loginHeaders(url) {
  const login = loginFor(url);
  if (!login) return [];
  return [...(login.headers || []), ...(login.extraHeaders || [])];
}

// What a download to this URL carries. The password is missing on purpose:
// aria2 already has it, from a file this side has never seen.
function loginOptions(url) {
  const header = loginHeaders(url);
  return header.length ? { header } : {};
}

// How a site's password is being sent, in the words the dialog uses.
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

// ── Video downloads (yt-dlp) ─────────────────────────────────────────────
// aria2 downloads files, and a video page is not a file. yt-dlp is what turns
// one into the other: it reads the page, and hands back the real media URLs —
// which aria2 then fetches in parallel like anything else, so a video download
// is as fast, as resumable, and as visible in the list as every other row.

// What the backend found to work with, asked for once at launch.
let videoTools = { version: "", source: "", ffmpeg: false, ffmpegSource: "" };

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
  // Garia ships its own ffmpeg, so the interesting case is no longer "have
  // you installed one" — it's which one answered. A "system" here means the
  // bundled binary didn't run, which is worth seeing before a merge fails.
  const merge = !videoTools.ffmpeg
    ? "No ffmpeg — the bundled one is missing, so only qualities that come as a single file are offered."
    : videoTools.ffmpegSource === "system"
      ? "Merging uses your own ffmpeg; the copy garia ships didn't run."
      : "Merging uses the ffmpeg garia ships, so the split video-and-audio qualities are all on offer.";
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

// A playlist's entries do not all offer the same formats — a list can hold a
// 4K lecture and a 360p phone clip — so a playlist cannot be given a chosen
// quality the way a single video can. It gets a rule instead, read against
// each entry once that entry has been probed.
const QUALITY_RULES = [
  { id: "best",  label: "Best available", detail: "The tallest each video has" },
  { id: "2160",  label: "Up to 2160p",    detail: "4K where there is one" },
  { id: "1440",  label: "Up to 1440p",    detail: "" },
  { id: "1080",  label: "Up to 1080p",    detail: "The usual answer" },
  { id: "720",   label: "Up to 720p",     detail: "" },
  { id: "480",   label: "Up to 480p",     detail: "" },
  { id: "audio", label: "Audio only",     detail: "Sound, no picture" },
];

// The rule applied to one entry's choices. `buildChoices` has already put the
// tallest first, so the first one inside the cap is the best one inside it —
// and a video whose every quality is over the cap still downloads, at its
// smallest, because refusing to fetch a 720p-only video under a 480p rule
// would be a silent hole in the list rather than a decision.
function pickByRule(choices, rule) {
  if (!choices.length) return null;
  const audio = choices.find((c) => c.label === "Audio");
  if (rule === "audio") return audio || choices[choices.length - 1];

  const pictures = choices.filter((c) => c !== audio);
  if (!pictures.length) return choices[0];
  if (rule === "best") return pictures[0];

  const cap = Number(rule);
  return (
    pictures.find((c) => (parseInt(c.label, 10) || 0) <= cap) ||
    pictures[pictures.length - 1]
  );
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
      "video and audio, and the ffmpeg that merges them isn't running — see Settings.",
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
  const rowFor = new Map();   // either half's gid → the one row they make
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
    const row = mergedRow(videoGid, video, audio, job);
    rowFor.set(videoGid, row);
    rowFor.set(job.audioGid, row);
    merged.push(row);
  }
  if (changed) saveJobs();

  // The pair stands where its first half stood. Status is what the poll sorts
  // on afterwards, but inside a status aria2's own order is what shows — and
  // for the queue that order is the one the user dragged the row into.
  const out = [];
  const placed = new Set();
  for (const dl of all) {
    const row = rowFor.get(dl.gid);
    if (!row) { out.push(dl); continue; }
    if (placed.has(row.gid)) continue;
    placed.add(row.gid);
    out.push(row);
  }
  // A job can outlive both of its halves for a tick — aria2 forgets a finished
  // download on restart, and the row is still the user's.
  for (const row of merged) {
    if (!placed.has(row.gid)) out.push(row);
  }
  return out;
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
          ? "Both halves downloaded, but the ffmpeg that merges them isn't running"
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

// "45s", "12m", "1h 20m". The row wants "left" on the end of it; the detail
// grid puts a label above the number and only wants the span.
function formatSpan(seconds) {
  const secs = Math.round(seconds);
  if (!(secs > 0)) return "";
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function formatEta(remaining, bytesPerSec) {
  const speed = Number(bytesPerSec);
  if (!(speed > 0) || !(remaining > 0)) return "";
  const span = formatSpan(remaining / speed);
  return span ? `${span} left` : "";
}

function fileName(download) {
  const f = download.files?.[0];
  if (f?.path) return f.path.split("/").pop() || f.path;
  const uri = f?.uris?.[0]?.uri || "";
  return uri.split("/").pop() || uri || download.gid;
}

function statusLabel(status) {
  const map = { active: "Downloading", merging: "Merging", seeding: "Seeding", waiting: "Queued", paused: "Paused", complete: "Complete", error: "Error", removed: "Removed" };
  return map[status] || status;
}

// "merging" is garia's own: aria2 is done and the file isn't there yet. It
// borrows the active row's look, because that is what it is to the user.
function statusClass(status) {
  if (status === "merging") return "active";
  return ["complete", "error", "active", "paused", "seeding"].includes(status) ? status : "waiting";
}

// Row order: what's moving first, what's finished last.
const STATUS_RANK = { active: 0, merging: 0.5, seeding: 0.75, waiting: 1, paused: 2, error: 3, complete: 4, removed: 5 };

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
  seeding:  SVG_OPEN + '<circle cx="12" cy="12" r="9"/><polyline points="8 12 12 8 16 12"/><line x1="12" y1="16" x2="12" y2="8"/></svg>',
  error:    SVG_OPEN + '<circle cx="12" cy="12" r="9"/><line x1="12" y1="7.5" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12.01" y2="16.5"/></svg>',
};

const BTN_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';

const ACTION_ICONS = {
  stop:   BTN_OPEN + '<line x1="9" y1="5" x2="9" y2="19"/><line x1="15" y1="5" x2="15" y2="19"/></svg>',
  resume: BTN_OPEN + '<polygon points="6 4 20 12 6 20 6 4"/></svg>',
  reveal: BTN_OPEN + '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  retry:  BTN_OPEN + '<polyline points="21 4 21 10 15 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L21 10"/></svg>',
  reprobe: BTN_OPEN + '<polyline points="21 4 21 10 15 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L21 10"/></svg>',
  unseed: BTN_OPEN + '<rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
  remove: BTN_OPEN + '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
};

// The handle for dragging a queued row somewhere else in the queue. It sits
// over the status icon and only surfaces on rows that can actually move.
const GRIP_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">'
  + '<circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/>'
  + '<circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>'
  + '<circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';

const ACTION_TITLES = {
  stop: "Pause",
  resume: "Resume",
  reveal: "Show in Finder",
  retry: "Retry download",
  reprobe: "Read the page again and pick a quality",
  unseed: "Stop uploading this torrent and file it as done — seeding it again means adding the torrent again",
  remove: "Delete download",
};

// Every URI aria2 still has on record for a download. A failed HTTP download
// keeps the one it was added with; a torrent's files carry none, which is
// exactly when there is nothing to retry from.
function sourceUrl(dl) {
  if (!dl) return "";
  if (dl.job?.webpageUrl) return dl.job.webpageUrl;
  return retryUris(dl)[0] || "";
}

function rowPath(dl) {
  if (!dl || (dl.job && !dl.onDisk)) return "";
  return dl.files?.[0]?.path || "";
}

function rowWroteBytes(dl) {
  if (!dl || Number(dl.completedLength) <= 0) return false;
  if (dl.job) {
    return Boolean(dl.job.videoPath || dl.job.outPath || dl.job.audioPath || snapshotPath(dl.gid));
  }
  return (dl.files || []).some((f) => f.path);
}

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
  32: "What arrived doesn't match the checksum",
};

function errorReason(dl) {
  // aria2 says "Authorization failed", which is true and leads nowhere. This
  // is the one failure with a fix inside the app, so the row names it.
  if (Number(dl.errorCode) === 24) return "Needs a login — add one in Settings";
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
  } else if (dl.status === "seeding") {
    // The download is over; what is left to stop is the upload.
    out.push({ action: "unseed", kind: "pill", tone: "success", label: "Stop seeding" });
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
  li.setAttribute("aria-selected", "false");
  li.tabIndex = -1;
  li.innerHTML = `
    <div class="dl-lead">
      <div class="dl-icon"></div>
      <span class="dl-grip" title="Drag to reorder the queue — or ⌥↑ / ⌥↓">${GRIP_ICON}</span>
    </div>
    <div class="dl-content">
      <div class="dl-head">
        <button type="button" class="dl-name"></button>
        <span class="dl-verified hidden">Verified</span>
        <span class="dl-cap hidden"></span>
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

function progressMeta(dl) {
  const total = Number(dl.totalLength);
  const done = Number(dl.completedLength);
  const parts = [];
  if (total > 0) parts.push(`${formatBytes(done)} / ${formatBytes(total)}`);
  else if (done > 0) parts.push(formatBytes(done));
  const speed = formatSpeed(dl.downloadSpeed);
  if (speed) parts.push(speed);
  if (total > 0) parts.push(`${Math.round((done / total) * 100)}%`);
  if (dl.status === "active" && total > 0) {
    const eta = formatEta(total - done, dl.downloadSpeed);
    if (eta) parts.push(eta);
  }
  return parts;
}

// A seeding row has no percentage left to report and no arrival to wait for.
// What it has is a size, an upload speed, and the ratio the seeding rules in
// Settings are counting towards.
function seedingMeta(dl) {
  const total = Number(dl.totalLength) || 0;
  const up = Number(dl.uploadLength) || 0;
  const parts = [];
  if (total > 0) parts.push(formatBytes(total));
  const speed = formatSpeed(dl.uploadSpeed);
  if (speed) parts.push(`↑ ${speed}`);
  parts.push(`${formatBytes(up)} shared`);
  if (total > 0) parts.push(`ratio ${(up / total).toFixed(2)}`);
  return parts;
}

function updateItemEl(li, dl) {
  const total = Number(dl.totalLength);
  const done = Number(dl.completedLength);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const cls = statusClass(dl.status);
  const name = fileName(dl);

  li.dataset.status = dl.status;
  li.dataset.name = name;
  li.classList.toggle(
    "is-file-draggable",
    (dl.status === "complete" || dl.status === "seeding") && Boolean(rowPath(dl)),
  );

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

  // A capped row is slower than the line on purpose, and the row is where that
  // has to be said — the alternative is a download that looks stuck.
  const capEl = li.querySelector(".dl-cap");
  const cap = LIMITABLE.has(dl.status) ? rowLimit(dl.gid) : 0;
  const capText = cap > 0 ? limitLabel(cap) : "";
  capEl.classList.toggle("hidden", !capText);
  if (capText && capEl.textContent !== capText) {
    capEl.textContent = capText;
    capEl.title = `This download is capped at ${formatSpeed(cap)}`;
  }

  // aria2 will not file a download as complete unless the checksum matched, so
  // the chip is not a claim garia is making — it is the one aria2 already made
  // by letting the download finish at all.
  const verifiedEl = li.querySelector(".dl-verified");
  const checked = dl.status === "complete" ? splitChecksum(rowChecksum(dl.gid)) : null;
  verifiedEl.classList.toggle("hidden", !checked);
  if (checked) {
    verifiedEl.title = `${checked.label} matched: ${checked.digest}`;
  }

  // Downloading rows already say it twice over — the moving bar, the speed, and
  // the Pause button. The chip only earns its place on the other statuses.
  // "Paused" on a row the schedule stopped is true and useless: the user did
  // not pause it and cannot tell why it isn't going, so the chip says which of
  // the two kinds of paused this is and the meta line says until when.
  const pill = li.querySelector(".dl-status-pill");
  const held = dl.status === "paused" ? heldNote(dl.gid) : "";
  const showChip = dl.status !== "active";
  pill.className = showChip ? `dl-status-pill ${held ? "scheduled" : cls}` : "dl-status-pill hidden";
  if (showChip) pill.textContent = held ? "Scheduled" : statusLabel(dl.status);

  // Progress bar
  const isIndeterminate = dl.status === "active" && total === 0;
  const fill = li.querySelector(".dl-bar-fill");
  fill.classList.toggle("indeterminate", isIndeterminate);
  fill.style.width = isIndeterminate ? "" : `${pct}%`;

  // Meta line: size · speed · percent · eta — or, once the download is over
  // and the uploading isn't, what has gone back out and how far past even.
  const meta = dl.status === "seeding" ? seedingMeta(dl) : progressMeta(dl);
  if (held) meta.push(held);
  li.querySelector(".dl-meta").textContent = meta.join(" · ");

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
  seeding: "Seeding",
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
  // A finished torrent is still "active" to aria2. seeder is what separates it
  // from a download, and the upload pair is what a seeding row has to show
  // instead of a speed and an ETA. aria2 sends all three for torrents only.
  "seeder", "uploadLength", "uploadSpeed",
];

// aria2 has no status for "finished downloading, still uploading" — a seeding
// torrent is `active` with `seeder` set, and looks in every list like a
// download stuck at 100%. The list gives it a status of its own, the way a
// merging video already has one.
function withSeeding(dl) {
  if (dl.status === "active" && dl.seeder === "true") return { ...dl, status: "seeding" };
  // Stopping the seeding is a removal to aria2, so a torrent that has all its
  // bytes and was removed is a download that finished — not one that was
  // cancelled. Anything actually cancelled is purged before it can be seen.
  const total = Number(dl.totalLength) || 0;
  if (dl.status === "removed" && total > 0 && Number(dl.completedLength) === total) {
    return { ...dl, status: "complete" };
  }
  return dl;
}

const VIEW_TITLES = {
  all: "All Downloads",
  active: "Downloading",
  seeding: "Seeding",
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
  if (tally.seeding) bits.push(`${tally.seeding} seeding`);
  if (tally.waiting) bits.push(`${tally.waiting} queued`);
  if (tally.paused) bits.push(`${tally.paused} paused`);
  if (tally.complete) bits.push(`${tally.complete} done`);
  if (tally.error) bits.push(`${tally.error} failed`);
  document.getElementById("stat-counts").textContent =
    bits.length ? bits.join(" · ") : "no downloads";

  const down = formatSpeed(tally.speed);
  const up = formatSpeed(tally.upspeed);
  document.getElementById("stat-speed").textContent =
    [down && `↓ ${down}`, up && `↑ ${up}`].filter(Boolean).join("  ");
}

// A cap explains a slow download, so it has to be visible — and reachable —
// without opening Settings to remember it's there.
function renderTraffic() {
  const btn = document.getElementById("traffic-btn");
  if (!btn) return;
  const mode = currentMode();
  const bytes = modeLimit(mode);

  btn.textContent = mode === "full"
    ? MODE_LABELS.full
    : `${MODE_LABELS[mode]} · ${formatSpeed(bytes)}`;
  btn.classList.toggle("capped", mode !== "full");

  for (const option of document.querySelectorAll(".traffic-option")) {
    const own = option.dataset.mode;
    option.setAttribute("aria-checked", String(own === mode));
    if (own === "full") continue;
    option.querySelector(".traffic-option-note").textContent =
      formatSpeed(modeLimit(own)) || "—";
  }
}

async function setTrafficMode(mode) {
  const next = { ...settings, trafficMode: mode, maxOverallDownloadLimit: modeLimit(mode) };
  const invoker = window.__TAURI__?.core?.invoke;
  if (typeof invoker === "function") {
    // Rust owns the file and pushes the cap into the running aria2.
    settings = await invoker("save_settings", { settings: next });
  } else {
    // Browser dev mode: no backend to route through, so aria2 is told here.
    settings = next;
    try {
      await rpc("aria2.changeGlobalOption", [{
        "max-overall-download-limit": String(next.maxOverallDownloadLimit),
      }]);
    } catch (err) { console.error(err); }
  }
  renderTraffic();
}

// ── Per-download caps ────────────────────────────────────────────────────
// gid → bytes per second, mirroring aria2's own max-download-limit. aria2
// keeps that option for the life of the download and writes it into the
// session file, so a cap set in one run is still in force in the next — which
// means it has to be read back, not just remembered.
const rowLimits = new Map();

// Only a download that has yet to finish can be limited, and only those are
// worth asking aria2 about.
const LIMITABLE = new Set(["active", "waiting", "paused"]);

// aria2 answers with a plain byte count, but its own option syntax allows a
// K or M suffix and a hand-edited session file can carry one.
function parseLimit(value) {
  const text = String(value ?? "").trim();
  const scale = /k$/i.test(text) ? 1024 : /m$/i.test(text) ? 1024 * 1024 : 1;
  const n = parseFloat(text);
  return Number.isFinite(n) && n > 0 ? Math.round(n * scale) : 0;
}

// A merged video is two downloads under one row, and both halves carry the
// cap — so the row's cap is whichever half admits to one.
function rowLimit(gid) {
  for (const g of gidsFor(gid)) {
    const bytes = rowLimits.get(g) || 0;
    if (bytes > 0) return bytes;
  }
  return 0;
}

// gid → the checksum aria2 is holding for that download, "" for none. Same
// shape as the caps above and for the same reason — the option lives in aria2,
// rides into its session file, and comes back from getOption. It is also the
// whole of what garia knows about verification: aria2 will not file a download
// as complete unless the hash matched, so a completed row with a checksum on
// it is a verified row, and nothing else has to be recorded.
const rowChecksums = new Map();

// One question per download, asked once for the life of the run. The cap and
// the checksum come out of the same getOption, which is why they are learned
// together — and why the ask is no longer confined to unfinished downloads:
// a checksum matters most on the row that has already landed.
const optionsAsked = new Set();

// Asked off the poll rather than inside it: the list must not wait on a
// question whose answer only decorates a row.
function learnOptions(raw) {
  for (const dl of raw) {
    if (optionsAsked.has(dl.gid)) continue;
    optionsAsked.add(dl.gid);
    // Defaults only: a download garia has just added already knows its own.
    if (!rowLimits.has(dl.gid)) rowLimits.set(dl.gid, 0);
    if (!rowChecksums.has(dl.gid)) rowChecksums.set(dl.gid, "");
    rpc("aria2.getOption", [dl.gid])
      .then((opt) => {
        const bytes = parseLimit(opt?.["max-download-limit"]);
        if (bytes > 0) rowLimits.set(dl.gid, bytes);
        if (opt?.checksum) rowChecksums.set(dl.gid, String(opt.checksum));
      })
      .catch(() => { /* finished, or forgotten, between the poll and the ask */ });
  }
}

// A merged video is two downloads under one row, so the row's checksum is
// whichever half admits to one — in practice never, since nobody publishes a
// hash for half of a YouTube video, but the row must not guess.
function rowChecksum(gid) {
  for (const g of gidsFor(gid)) {
    const spec = rowChecksums.get(g);
    if (spec) return spec;
  }
  return "";
}

async function setRowLimit(gid, bytes) {
  const gids = gidsFor(gid);
  await Promise.all(gids.map((g) =>
    rpc("aria2.changeOption", [g, { "max-download-limit": String(bytes) }])));
  for (const g of gids) rowLimits.set(g, bytes);
}

// ── Schedule ─────────────────────────────────────────────────────────────
// The window, and every per-download start time, belong to Rust. Not because
// the frontend could not do the arithmetic — it has the same two numbers in
// `settings` — but because Rust is the side that is awake before the webview
// is, and the side actually doing the pausing. Two clocks reading the same
// window would eventually disagree about which side of a boundary the app is
// on, and the one that pauses downloads has to be the one that is right. So
// nothing here recomputes it: the panel and the status bar say what they were
// told.
let schedule = {
  enabled: false, open: true, start: 0, end: 0,
  nextChange: 0, held: [], starts: {}, now: 0,
};
let heldGids = new Set();

async function loadSchedule() {
  const invoker = window.__TAURI__?.core?.invoke;
  if (typeof invoker !== "function") return;
  try {
    schedule = await invoker("schedule_state");
    heldGids = new Set(schedule.held || []);
  } catch (err) {
    console.error(err);
  }
}

// Minutes since midnight, which is how both ends of the window are stored: a
// time of day rather than an instant, so 02:00 is still 02:00 after the clocks
// change. Also the value an <input type="time"> reads and writes.
function hhmm(minute) {
  const m = ((Math.round(minute) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function minutesOf(value) {
  const [h, m] = String(value || "").split(":").map((n) => parseInt(n, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return (((h * 60 + m) % 1440) + 1440) % 1440;
}

// `hhmm` is the value an <input type="time"> reads and writes and is never
// shown as prose. What the user reads is this, which follows their locale — so
// a window's end and a download's own hour cannot appear side by side in the
// same column with one of them in 24-hour and the other in 12.
function clockLabel(minute) {
  const at = new Date();
  at.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// An instant, said the way a person would read it off a clock — with the date
// only when it isn't today, because "starts 02:00" on a Tuesday afternoon is
// ambiguous in exactly the way a scheduler must not be.
function clockOf(epochSecs) {
  const at = new Date(Number(epochSecs) * 1000);
  if (!Number.isFinite(at.getTime())) return "";
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (at.toDateString() === new Date().toDateString()) return time;
  return `${at.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function secondsUntil(epochSecs) {
  return Math.max(0, Number(epochSecs) - Math.floor(Date.now() / 1000));
}

// A merged video is two aria2 downloads under one row, and either half can be
// the one being held — so the row asks about both.
function startAt(gid) {
  for (const id of gidsFor(gid)) {
    const at = Number(schedule.starts?.[id]) || 0;
    if (at > 0) return at;
  }
  return 0;
}

function isHeld(gid) {
  return gidsFor(gid).some((id) => heldGids.has(id));
}

// Why this row is stopped, in the words a row has space for. Only ever said
// about a paused row: a held download and a hand-paused one are both `paused`
// to aria2, and this is the whole of the difference the user can see.
function heldNote(gid) {
  if (!isHeld(gid)) return "";
  const at = startAt(gid);
  if (at) return `starts ${clockOf(at)}`;
  if (schedule.enabled && !schedule.open) return `starts ${clockLabel(schedule.start)}`;
  return "held";
}

// A window that is holding downloads back has to say so somewhere always
// visible. Without it the app is simply a list of downloads that aren't going.
function renderSchedule() {
  const el = document.getElementById("stat-schedule");
  if (!el) return;
  el.classList.toggle("hidden", !schedule.enabled);
  if (!schedule.enabled) return;

  const span = formatSpan(secondsUntil(schedule.nextChange));
  const open = schedule.open;
  el.dataset.state = open ? "open" : "shut";
  el.textContent = open
    ? `· downloading until ${clockLabel(schedule.end)}`
    : `· held until ${clockLabel(schedule.start)}`;
  el.title = open
    ? `The window closes at ${clockLabel(schedule.end)}${span ? `, in ${span}` : ""}.`
    : `Downloads are held until ${clockLabel(schedule.start)}${span ? `, in ${span}` : ""}. `
      + "Garia has to be running then.";
}

// ── Queue order ──────────────────────────────────────────────────────────
// What aria2 starts next, and after that: the queue exactly as tellWaiting
// hands it over. Paused downloads are in it too — they hold their slot without
// taking a turn — so a position can never be counted off the queued rows on
// screen, only looked up in here.
let queueOrder = [];

// A move the user just made that aria2 hasn't confirmed yet. The poll leaves
// the order alone while this is up: it is a tick behind the finger.
let reorderHold = false;

// aria2 numbers positions across the whole queue, and a row is dropped between
// two others — so the position is read off the neighbours rather than counted.
// `before` is the row the dragged one should now precede; `after` the one it
// should follow, which is how a drop past the last queued row lands.
async function moveInQueue(gid, { before = "", after = "" }) {
  // Only what is actually in the queue can be moved in it: half of a merged
  // video can be finished, or gone, while the other half still waits.
  const gids = gidsFor(gid).filter((g) => queueOrder.includes(g));
  if (!gids.length) return false;

  const rest = queueOrder.filter((g) => !gids.includes(g));
  const slots = (g) => gidsFor(g).map((x) => rest.indexOf(x)).filter((i) => i >= 0);

  let pos = -1;
  if (before) {
    const found = slots(before);
    if (found.length) pos = Math.min(...found);
  } else if (after) {
    const found = slots(after);
    if (found.length) pos = Math.max(...found) + 1;
  }
  if (pos < 0) return false;

  // A merged video is two downloads and has to stay two adjacent ones, or the
  // half that lost its place would be started on its own.
  const target = [...rest];
  target.splice(pos, 0, ...gids);

  // Back to front, against a copy kept in step with each call: aria2 renumbers
  // the queue every time something moves, so the place for the first half is
  // only fixed once the second one is where it belongs.
  const queue = [...queueOrder];
  for (const g of [...gids].reverse()) {
    const follower = target[target.indexOf(g) + 1];
    const at = queue.indexOf(g);
    if (at >= 0) queue.splice(at, 1);
    const found = follower === undefined ? -1 : queue.indexOf(follower);
    const to = found < 0 ? queue.length : found;
    queue.splice(to, 0, g);
    await rpc("aria2.changePosition", [g, to, "POS_SET"]);
  }
  // The next drop may come before the next poll does.
  queueOrder = queue;
  return true;
}

// ── Detail view ──────────────────────────────────────────────────────────
// A row is five numbers wide on purpose. Everything else aria2 already knows
// about a download — the URL the bytes come from, the path they land on, how
// many sockets are open this second, who the peers are — lives here, one
// download at a time. It rides the list's poll tick rather than starting a
// timer of its own, and asks for the full key set only for the gid on screen,
// so the list poll stays as narrow as it was.
const DETAIL_KEYS = [
  "gid", "status", "totalLength", "completedLength", "uploadLength",
  "downloadSpeed", "uploadSpeed", "connections", "numSeeders", "seeder",
  "dir", "files", "bittorrent", "infoHash", "numPieces", "pieceLength",
  "errorCode", "errorMessage",
  // Which pieces are in. The list never asks for it — on a big torrent it is
  // hundreds of characters a tick — but the panel needs it to say how much of
  // the *front* of the file has arrived, which is the only part a player reads.
  "bitfield",
];

// Peers arrive by the hundred on a healthy torrent and the fast ones are the
// only ones worth a line. The rest are counted, not listed.
const PEER_LIMIT = 40;

const FACT_LABELS = {
  status: "Status",
  connections: "Connections",
  seeders: "Seeders",
  downloaded: "Downloaded",
  speed: "Speed",
  eta: "Time left",
  uploaded: "Uploaded",
  upspeed: "Upload speed",
  ratio: "Ratio",
  pieces: "Pieces",
};

const FACTS_HTTP = ["status", "connections", "downloaded", "speed", "eta", "pieces"];
const FACTS_BT = ["status", "connections", "seeders", "downloaded", "speed",
                  "uploaded", "upspeed", "ratio"];

// The gid whose details are on screen, or null. Also the guard that stops a
// reply arriving after the dialog closed from painting into a dead panel.
let detailGid = null;
let detailBusy = false;

// Which files inside a torrent the user has ticked but not yet applied, per
// gid. The panel redraws every second off the poll; without this a tick made
// between two of them would be wiped by the next one.
const fileSelection = new Map();

// A torrent's files can be re-picked while it runs, waits or is paused —
// aria2 will not take the option on a download it is actively working, so
// applying one pauses it first.
function canPickFiles(st) {
  return ["active", "waiting", "paused"].includes(st?.status);
}

// 1-based file indices, the way aria2's --select-file names them.
function selectedIndices(sec) {
  return [...sec.querySelectorAll("input[data-file-index]")]
    .filter((box) => box.checked)
    .map((box) => Number(box.dataset.fileIndex))
    .sort((a, b) => a - b);
}

// Nothing to apply until the ticks say something aria2 doesn't already say,
// and nothing to apply if they say "take none of it" — aria2 reads an empty
// selection as "every file", which is the opposite of what the box shows.
function updateSelectBar(sec) {
  const bar = sec.querySelector(".detail-select");
  if (!bar) return;
  // Set by the redraw off aria2's own status, and read back here and by Apply:
  // a running download has to be stopped before it will take the change.
  const running = bar.dataset.running === "true";
  const boxes = [...sec.querySelectorAll("input[data-file-index]")];
  const changed = boxes.some((box) => box.checked !== (box.dataset.was !== "false"));
  const taking = boxes.filter((box) => box.checked).length;

  bar.classList.toggle("hidden", !changed || boxes.length === 0);
  bar.querySelector(".detail-select-note").textContent = taking === 0
    ? "Leave at least one file — a torrent with nothing selected downloads all of it."
    : running
      ? `Take ${taking} of ${boxes.length}. aria2 only changes this on a stopped download, so garia pauses it and starts it again.`
      : `Take ${taking} of ${boxes.length}.`;
  bar.querySelector(".detail-select-apply").disabled = taking === 0;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// How much has arrived is aria2's answer; whether that is enough to play is
// the file's, and only the backend can read it. A container that keeps its
// index at the end — which plenty of MP4s do — is complete-looking on aria2's
// side and unplayable all the same.
async function previewOf(st) {
  const path = previewPath(st);
  if (!path) return null;
  const bytes = playableBytes(st);
  const invoker = window.__TAURI__?.core?.invoke;
  // Browser dev mode: there is no file on disk to read an index out of, so the
  // front of it is taken on aria2's word alone. The app never comes here.
  if (typeof invoker !== "function") return { path, bytes, ready: bytes >= 256 * 1024, reason: "" };
  try {
    const state = await invoker("preview_state", { path, readyBytes: bytes });
    return { path, bytes, ...state };
  } catch (err) {
    console.error(err);
    return null;
  }
}

// aria2 answers getServers and getPeers with an error unless the download is
// running — which is a fact about the download, not a fault worth surfacing.
async function askQuietly(method, gid) {
  try {
    const result = await rpc(method, [gid]);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

// One download, or the two halves of a merged one. A half aria2 has forgotten
// comes back as a part with no status — its file is on disk, and saying so is
// better than leaving a gap.
async function detailData(gid) {
  const row = snapshot.get(gid);
  const ids = gidsFor(gid);
  const labels = ids.length > 1 ? ["Video", "Audio"] : [""];
  const parts = [];

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    let status = null;
    try { status = await rpc("aria2.tellStatus", [id, DETAIL_KEYS]); } catch { /* forgotten */ }
    const live = status?.status === "active";
    parts.push({
      gid: id,
      label: labels[i] || "",
      // Nobody publishes a hash for half of a merged video, and a pair of
      // fields offering one would be two ways to say the same nothing.
      solo: ids.length === 1,
      status,
      preview: status ? await previewOf(status) : null,
      servers: live ? await askQuietly("aria2.getServers", id) : [],
      peers: live && status.bittorrent ? await askQuietly("aria2.getPeers", id) : [],
    });
  }
  return { gid, row, job: row?.job || null, parts };
}

// What the panel is made of, as a string. A torrent that has just picked up
// its metadata gains files and a half that finishes loses its tables, and both
// mean the skeleton has to be rebuilt rather than updated.
function detailShape(data) {
  const parts = data.parts.map((p) => [
    p.gid,
    p.status ? (p.status.bittorrent ? "bt" : "http") : "gone",
    (p.status?.files || []).length,
  ].join(":"));
  return (canLimit(data) ? "cap|" : "")
    + (canSchedule(data) ? "when|" : "")
    + (data.job ? "job|" : "")
    + parts.join("|");
}

function factValues(st) {
  const total = Number(st.totalLength) || 0;
  const done = Number(st.completedLength) || 0;
  const up = Number(st.uploadLength) || 0;
  const speed = Number(st.downloadSpeed) || 0;
  const pieces = Number(st.numPieces) || 0;
  const remaining = st.status === "active" && total > 0 ? total - done : 0;
  return {
    status: statusLabel(st.status),
    connections: String(Number(st.connections) || 0),
    seeders: String(Number(st.numSeeders) || 0),
    downloaded: total > 0 ? `${formatBytes(done)} / ${formatBytes(total)}` : formatBytes(done),
    speed: formatSpeed(speed) || "—",
    eta: (remaining ? formatSpan(remaining / speed) : "") || "—",
    uploaded: formatBytes(up),
    upspeed: formatSpeed(st.uploadSpeed) || "—",
    ratio: done > 0 ? (up / done).toFixed(2) : "0.00",
    pieces: pieces ? `${pieces} × ${formatBytes(st.pieceLength)}` : "—",
  };
}

// Every URI aria2 still holds for a download, in the order it holds them.
function sourceUris(st) {
  const uris = [];
  for (const f of st.files || []) {
    for (const u of f.uris || []) {
      if (u.uri && !uris.includes(u.uri)) uris.push(u.uri);
    }
  }
  return uris;
}

// A single-file download names the file; a torrent names the folder, because
// the files themselves get a table of their own.
function destinationOf(st) {
  const files = st.files || [];
  if (files.length === 1 && files[0].path) return files[0].path;
  return st.dir || "";
}

function hostOf(uri) {
  try { return new URL(uri).host; } catch { return uri; }
}

// aria2 reports a peer's progress as the raw piece bitfield, in hex. The share
// of bits set is the share of the torrent that peer has.
const HEX_BITS = { 0: 0, 1: 1, 2: 1, 3: 2, 4: 1, 5: 2, 6: 2, 7: 3,
                   8: 1, 9: 2, a: 2, b: 3, c: 2, d: 3, e: 3, f: 4 };

// The share of pieces that are in says nothing about whether a file will
// play: a download can be 90% complete with a hole at the front. What a player
// reads is the contiguous run from piece zero, so that is what gets counted —
// aria2 writes the bitfield most-significant bit first, piece zero at the top.
function leadingPieces(bitfield) {
  let run = 0;
  for (const ch of String(bitfield || "").toLowerCase()) {
    const nibble = parseInt(ch, 16);
    if (!Number.isFinite(nibble)) return run;
    for (let bit = 3; bit >= 0; bit--) {
      if (!(nibble & (1 << bit))) return run;
      run++;
    }
  }
  return run;
}

// That run, in bytes. The last piece of a file is short, so the total is the
// ceiling — otherwise a finished download claims a few kilobytes it never had.
function playableBytes(st) {
  const pieces = Number(st.numPieces) || 0;
  const pieceLength = Number(st.pieceLength) || 0;
  const total = Number(st.totalLength) || 0;
  if (!pieces || !pieceLength) return 0;
  const bytes = Math.min(leadingPieces(st.bitfield), pieces) * pieceLength;
  return total > 0 ? Math.min(bytes, total) : bytes;
}

// Worth offering to open: a download still running, writing one file, of a
// kind something on the machine plays. A torrent that is a folder of files has
// no single "the file", and saying which one to play is a bigger question than
// this button answers.
const PREVIEWABLE = new Set([...FOLDERS.Video, ...FOLDERS.Music]);
const PREVIEW_WHILE = new Set(["active", "paused", "waiting"]);

function previewPath(st) {
  if (!st || !PREVIEW_WHILE.has(st.status)) return "";
  const files = st.files || [];
  if (files.length !== 1) return "";
  const path = files[0].path || "";
  return PREVIEWABLE.has(extensionOf(path)) ? path : "";
}

function bitfieldPct(bitfield, numPieces) {
  const pieces = Number(numPieces) || 0;
  if (!bitfield || !pieces) return "—";
  let bits = 0;
  for (const ch of bitfield.toLowerCase()) bits += HEX_BITS[ch] ?? 0;
  return `${Math.min(100, Math.round((bits / pieces) * 100))}%`;
}

// ── Panel skeleton ───────────────────────────────────────────────────────
function buildField(name, label) {
  const wrap = el("div", "detail-field");
  wrap.dataset.field = name;
  wrap.appendChild(el("div", "detail-field-label", label));
  const row = el("div", "detail-field-row");
  row.appendChild(el("code", "detail-value"));
  const copy = el("button", "detail-copy", "Copy");
  copy.type = "button";
  row.appendChild(copy);
  wrap.appendChild(row);
  return wrap;
}

function buildTable(name, title, columns) {
  const wrap = el("div", "detail-table-wrap hidden");
  wrap.dataset.table = name;
  const head = el("div", "detail-table-head");
  head.appendChild(el("h4", null, title));
  head.appendChild(el("span", "detail-table-count"));
  wrap.appendChild(head);

  const table = el("table", "detail-table");
  const headRow = el("tr");
  for (const column of columns) headRow.appendChild(el("th", null, column));
  const thead = el("thead");
  thead.appendChild(headRow);
  table.appendChild(thead);
  table.appendChild(el("tbody"));

  const scroll = el("div", "detail-table-scroll");
  scroll.appendChild(table);
  wrap.appendChild(scroll);
  return wrap;
}

function buildPart(part) {
  const sec = el("section", "detail-part");
  sec.dataset.gid = part.gid;
  if (part.label) sec.appendChild(el("h3", "detail-part-title", part.label));

  if (!part.status) {
    sec.appendChild(el("p", "detail-note",
      "aria2 has no record of this half any more — it finished in an earlier " +
      "session, and its file is on disk."));
    return sec;
  }

  const bt = Boolean(part.status.bittorrent);

  const track = el("div", "detail-bar-track");
  track.appendChild(el("div", "detail-bar-fill"));
  sec.appendChild(track);

  const facts = el("dl", "detail-facts");
  for (const key of bt ? FACTS_BT : FACTS_HTTP) {
    const fact = el("div", "detail-fact");
    fact.dataset.fact = key;
    fact.appendChild(el("dt", null, FACT_LABELS[key]));
    fact.appendChild(el("dd", null, "—"));
    facts.appendChild(fact);
  }
  sec.appendChild(facts);

  sec.appendChild(buildField("source", bt ? "Info hash" : "Source"));
  sec.appendChild(buildField("dest", "Saving to"));

  // Always built, usually hidden: whether a partial file is worth opening
  // changes on almost every tick, and rebuilding the panel under the pointer
  // to make a button appear is what detailShape exists to avoid.
  const preview = el("div", "detail-preview hidden");
  preview.appendChild(el("p", "detail-note detail-preview-note"));
  const play = el("button", "btn-secondary detail-preview-play", "Play what's here");
  play.type = "button";
  play.dataset.gid = part.gid;
  preview.appendChild(play);
  sec.appendChild(preview);

  // Built for every single-file HTTP download, shown for most of them: aria2
  // takes --checksum on HTTP and FTP alone, a torrent already carries a hash
  // per piece, and whether this one has a hash changes with a click — which is
  // exactly the kind of change detailShape exists to keep out of a rebuild.
  if (!bt && part.solo) sec.appendChild(buildCheckBlock(part.gid));

  const filesTable = buildTable("files", "Files",
    bt ? ["Take", "File", "Size", "Done"] : ["File", "Size", "Done"]);
  // The tick column pushes the name along one, and the name is the only column
  // in these tables that isn't a measurement.
  if (bt) filesTable.dataset.pick = "true";
  sec.appendChild(filesTable);
  if (bt) {
    const bar = el("div", "detail-select hidden");
    bar.appendChild(el("p", "detail-note detail-select-note"));
    const apply = el("button", "btn-secondary detail-select-apply", "Apply");
    apply.type = "button";
    apply.dataset.gid = part.gid;
    bar.appendChild(apply);
    sec.appendChild(bar);
  }
  sec.appendChild(buildTable("servers", "Live connections", ["Server", "Speed"]));
  if (bt) sec.appendChild(buildTable("peers", "Peers", ["Peer", "Has", "Down", "Up"]));

  sec.appendChild(el("p", "detail-error hidden"));
  return sec;
}

// What the file has of itself, said in bytes rather than in a percentage —
// "the first 40 MB are here" is the sentence that decides whether to open it.
function updatePreview(sec, part) {
  const block = sec.querySelector(".detail-preview");
  if (!block) return;
  const preview = part.preview;
  block.classList.toggle("hidden", !preview);
  if (!preview) return;

  const play = block.querySelector(".detail-preview-play");
  play.disabled = !preview.ready;
  play.dataset.path = preview.path;

  const said = [];
  if (preview.ready) {
    said.push(`The first ${formatBytes(preview.bytes)} are on disk and will play.`);
    said.push("The rest keeps filling in behind them.");
  } else {
    said.push(preview.reason || "Not enough of the front of the file has arrived to play.");
    // The one place the setting is worth mentioning is the moment it would
    // have helped — and it only helps downloads added after it is turned on.
    if (!settings.inOrder) {
      said.push("Downloads aren't being filled from the front — turn on “Download in order” in Settings.");
    }
  }
  block.querySelector(".detail-preview-note").textContent = said.join(" ");
}

// ── Checking one download against a hash ─────────────────────────────────
// The same field in three moments, and aria2 answers a different way in each.
// Before the bytes land, `changeOption` really does arm the check — one of the
// few options it applies to a download in flight rather than accepting and
// ignoring. Once the download is a finished record it refuses outright, and the
// way in is the download itself: added again, to the same folder under the same
// name, aria2 finds every byte already on disk, fetches none of them, and
// answers with the hash alone in a fraction of a second. It does still ask the
// server how long the file is, so a URL that has expired is a check that can no
// longer be run.
function buildCheckBlock(gid) {
  const block = el("div", "detail-check hidden");
  block.appendChild(buildField("checksum", "Checksum"));
  block.appendChild(el("p", "detail-note detail-check-note"));

  const row = el("div", "detail-check-row hidden");
  const input = el("input", "field-input is-path detail-check-input");
  input.type = "text";
  input.placeholder = "Paste a hash";
  input.setAttribute("aria-label", "Check this download against a hash");
  row.appendChild(input);
  const go = el("button", "btn-secondary detail-check-go", "Check");
  go.type = "button";
  go.dataset.gid = gid;
  row.appendChild(go);
  block.appendChild(row);
  return block;
}

// Which downloads are worth offering a hash for. A 404 has no file to check and
// a mismatch has nothing but — it is the one failure where the bytes are all
// there and only the verdict is in question.
const CHECKABLE = new Set(["active", "waiting", "paused", "complete"]);

function updateCheckBlock(sec, part) {
  const block = sec.querySelector(".detail-check");
  if (!block) return;
  const st = part.status;
  const have = splitChecksum(rowChecksums.get(part.gid) || "");
  const mismatched = st.status === "error" && Number(st.errorCode) === 32;
  const offer = CHECKABLE.has(st.status) || mismatched;

  block.classList.toggle("hidden", !have && !offer);
  if (!have && !offer) return;

  setField(block, "checksum", have ? `${have.label}  ${have.digest}` : "",
    have ? have.spec : "");
  // Copy the digest people would paste elsewhere, not the option aria2 took.
  if (have) block.querySelector(".detail-copy").dataset.value = have.digest;

  const said = [];
  if (have && st.status === "complete") {
    said.push("Matched when the file landed — aria2 will not file a download whose hash disagrees, so this one arriving is the check passing.");
  } else if (mismatched) {
    said.push("What arrived does not match this hash. Every byte is still on disk: deleting the row can take the file with it, and a different hash can be checked against what is there without downloading it again.");
  } else if (have) {
    said.push("aria2 is hashing the bytes as they arrive and will check them against this when the download finishes.");
  } else if (st.status === "complete") {
    said.push("aria2 can still hash the file that is already here — nothing is downloaded a second time, though the download URL has to be alive to answer for the file's length.");
  } else {
    said.push("Paste a hash and aria2 checks it when the download finishes. It takes one on a download that is already running.");
  }
  block.querySelector(".detail-check-note").textContent = said.join(" ");

  // A download that matched has nothing left to ask; one that has not been
  // checked, or has just failed the check, has.
  block.querySelector(".detail-check-row").classList.toggle("hidden", Boolean(have) && !mismatched);
}

// The same three modes as the status bar, aimed at one download. It sits above
// everything else in the panel because the reason to open a row while it runs
// is usually to do something about how fast it is going.
const MODE_SHORT = { full: "Full", medium: "Medium", light: "Light" };

function buildLimitBlock() {
  const sec = el("section", "detail-part detail-limit");
  sec.appendChild(el("h3", "detail-part-title", "Speed limit"));

  const seg = el("div", "seg");
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Speed limit for this download");
  for (const mode of MODES) {
    const btn = el("button", null, MODE_SHORT[mode]);
    btn.type = "button";
    btn.dataset.limitMode = mode;
    seg.appendChild(btn);
  }
  sec.appendChild(seg);

  sec.appendChild(el("p", "detail-note"));
  return sec;
}

function updateLimitBlock(sec, data) {
  const bytes = rowLimit(data.gid);
  const mode = modeOfLimit(bytes);
  for (const btn of sec.querySelectorAll("[data-limit-mode]")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.limitMode === mode));
  }

  const said = [];
  if (bytes > 0) {
    said.push(`Held to ${formatSpeed(bytes)}.`);
    // A cap set back when Light meant something else is still that many bytes.
    if (!mode) said.push("Neither mode stands for that speed now — picking one replaces it.");
    // The cap is an aria2 option on a download, and a merged row is two of them.
    if (data.parts.length > 1) said.push("Each half of the merge carries it, so the pair can take twice that.");
  } else if (currentMode() === "full") {
    said.push("Takes what the line gives it.");
  } else {
    said.push(`Takes what the line gives it, under the overall ${MODE_LABELS[currentMode()]} cap.`);
  }
  sec.querySelector(".detail-note").textContent = said.join(" ");
}

// Only a download still going anywhere can be limited: aria2 takes the option
// on a finished one and does nothing with it.
function canLimit(data) {
  return data.parts.some((p) => p.status && LIMITABLE.has(p.status.status));
}

// ── One download's own hour ───────────────────────────────────────────────
// The window in Settings is a rule about every download; this is one row told
// to wait. They compose the obvious way and the note says so, because the
// case that would otherwise look broken is a row whose hour comes at 3am
// inside a window that does not open until 8.
//
// The control is a datetime-local rather than a time, and deliberately: "start
// at 07:00" on a Tuesday evening is twelve hours away, and a field that cannot
// say which day cannot say that.
function buildStartBlock(gid) {
  const sec = el("section", "detail-part detail-start");
  sec.appendChild(el("h3", "detail-part-title", "Start at"));

  const row = el("div", "detail-start-row");
  const input = el("input", "field-input detail-start-input");
  input.type = "datetime-local";
  input.setAttribute("aria-label", "The moment this download may start");
  row.appendChild(input);

  const set = el("button", "btn-secondary detail-start-set", "Hold");
  set.type = "button";
  set.dataset.gid = gid;
  row.appendChild(set);

  const clear = el("button", "btn-secondary detail-start-clear", "Clear");
  clear.type = "button";
  clear.dataset.gid = gid;
  row.appendChild(clear);
  sec.appendChild(row);

  sec.appendChild(el("p", "detail-note detail-start-note"));
  return sec;
}

// A local datetime, in the shape <input type="datetime-local"> wants it, which
// is the one format that is neither ISO-with-a-Z nor a locale string.
function localInputValue(at) {
  const d = new Date(at * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function updateStartBlock(sec, data) {
  const at = startAt(data.gid);
  const input = sec.querySelector(".detail-start-input");
  // Written when the stored time changes, and at no other moment. Refreshing
  // it every tick — even only while it is unfocused — silently puts the
  // default hour back under anyone who typed a time and then clicked away
  // before pressing Hold, which is a scheduler holding a download until an
  // hour nobody asked for.
  if (sec.dataset.at !== String(at)) {
    sec.dataset.at = String(at);
    input.value = localInputValue(at || defaultStart());
  }
  sec.querySelector(".detail-start-clear").classList.toggle("hidden", !at);

  const said = [];
  if (at) {
    said.push(`Held until ${clockOf(at)}.`);
    const span = formatSpan(secondsUntil(at));
    if (span) said.push(`That is ${span} away.`);
    if (schedule.enabled) {
      said.push(
        schedule.open
          ? `The window is open until ${clockLabel(schedule.end)}; if the two disagree, the later one wins.`
          : `The window is shut until ${clockLabel(schedule.start)}, so the row waits for whichever of the two comes second.`,
      );
    }
    said.push("Garia has to be running then — nothing here wakes the Mac.");
  } else if (schedule.enabled && !schedule.open) {
    said.push(`Already held: the window is shut until ${clockLabel(schedule.start)}. A time here holds it past that.`);
  } else {
    said.push("Give this one download an hour of its own. It is paused until then, and started when it comes round — or when Garia is next running after it.");
  }
  sec.querySelector(".detail-start-note").textContent = said.join(" ");
}

// The next round hour, which is what an empty field should be offering: a
// scheduler asked for a time in the past is a scheduler asked for "now".
function defaultStart() {
  const at = new Date();
  at.setMinutes(0, 0, 0);
  at.setHours(at.getHours() + 1);
  return Math.floor(at.getTime() / 1000);
}

// Only a download with somewhere left to go. A finished or failed row has no
// start to wait for, and a seeding one has already had it.
const SCHEDULABLE = new Set(["active", "waiting", "paused"]);

function canSchedule(data) {
  return data.parts.some((p) => p.status && SCHEDULABLE.has(p.status.status));
}

// A merged video is two aria2 downloads and one file. The pair is the user's
// download, so it gets the top of the panel and the halves come after it.
function buildJobBlock() {
  const sec = el("section", "detail-part detail-job");
  sec.appendChild(buildField("page", "Source page"));
  sec.appendChild(buildField("out", "Saving to"));
  sec.appendChild(el("p", "detail-note"));
  return sec;
}

// ── Panel updates ────────────────────────────────────────────────────────
function setField(sec, name, value, title) {
  const wrap = sec.querySelector(`[data-field="${name}"]`);
  if (!wrap) return;
  wrap.classList.toggle("hidden", !value);
  const code = wrap.querySelector(".detail-value");
  if (code.textContent !== value) code.textContent = value;
  code.title = title || value;
  wrap.querySelector(".detail-copy").dataset.value = value;
}

function cells(tr, values, offset = 0) {
  while (tr.children.length < offset + values.length) {
    tr.appendChild(document.createElement("td"));
  }
  values.forEach((value, i) => {
    const td = tr.children[offset + i];
    if (td.textContent !== value) td.textContent = value;
  });
}

// Servers come and go as aria2 picks up and drops connections, and peers churn
// faster still. Rows are keyed the way the download list keys its own, so one
// that is still there is updated rather than rebuilt under the pointer.
function syncTable(sec, name, items, keyOf, fill, count) {
  const wrap = sec.querySelector(`[data-table="${name}"]`);
  if (!wrap) return;
  wrap.classList.toggle("hidden", items.length === 0);
  wrap.querySelector(".detail-table-count").textContent =
    items.length ? (count ?? String(items.length)) : "";

  const body = wrap.querySelector("tbody");
  const existing = new Map([...body.children].map((tr) => [tr.dataset.key, tr]));
  const desired = [];

  for (const item of items) {
    const key = String(keyOf(item));
    let tr = existing.get(key);
    if (tr) existing.delete(key);
    else {
      tr = document.createElement("tr");
      tr.dataset.key = key;
    }
    fill(tr, item);
    desired.push(tr);
  }
  for (const tr of existing.values()) tr.remove();

  const current = [...body.children];
  if (current.length !== desired.length || desired.some((n, i) => current[i] !== n)) {
    const frag = document.createDocumentFragment();
    for (const tr of desired) frag.appendChild(tr);
    body.textContent = "";
    body.appendChild(frag);
  }
}

function flattenServers(groups) {
  const out = [];
  for (const group of groups || []) {
    for (const server of group.servers || []) {
      const uri = server.currentUri || server.uri || "";
      out.push({ key: `${group.index}:${server.uri || uri}`, uri, speed: server.downloadSpeed });
    }
  }
  return out;
}

function updatePart(sec, part) {
  const st = part.status;
  if (!st) return;

  const total = Number(st.totalLength) || 0;
  const done = Number(st.completedLength) || 0;
  const fill = sec.querySelector(".detail-bar-fill");
  fill.dataset.status = statusClass(st.status);
  fill.style.width = `${total > 0 ? Math.round((done / total) * 100) : 0}%`;

  const values = factValues(st);
  for (const fact of sec.querySelectorAll(".detail-fact")) {
    const dd = fact.querySelector("dd");
    const value = values[fact.dataset.fact] ?? "—";
    if (dd.textContent !== value) {
      dd.textContent = value;
      dd.title = value;   // a narrow window truncates; hovering still answers
    }
  }

  // A torrent has no source URL to show — its info hash is the closest thing,
  // and it is what you paste into a tracker search.
  const uris = sourceUris(st);
  setField(sec, "source",
    st.bittorrent ? st.infoHash || "" : uris[0] || "",
    uris.length > 1 ? uris.join("\n") : "");
  setField(sec, "dest", destinationOf(st));
  updatePreview(sec, part);
  updateCheckBlock(sec, part);

  const files = st.files || [];
  const bt = Boolean(st.bittorrent);
  const pending = fileSelection.get(part.gid);
  syncTable(sec, "files", files.length > 1 ? files : [], (f) => f.index, (tr, f) => {
    const size = Number(f.length) || 0;
    const got = Number(f.completedLength) || 0;
    // A torrent is a bundle you can take part of, so its rows are ticked; an
    // HTTP download's file list is a fact, not a choice.
    if (bt) {
      let box = tr.querySelector("input[data-file-index]");
      if (!box) {
        const td = el("td", "detail-pick");
        box = document.createElement("input");
        box.type = "checkbox";
        box.dataset.fileIndex = f.index;
        box.setAttribute("aria-label", `Download ${(f.path || "").split("/").pop()}`);
        td.appendChild(box);
        tr.appendChild(td);
      }
      // What aria2 says, so the bar can tell a change from a redraw.
      box.dataset.was = f.selected === "false" ? "false" : "true";
      box.checked = pending ? pending.has(Number(f.index)) : f.selected !== "false";
      box.disabled = !canPickFiles(st);
    }
    cells(tr, [
      (f.path || "").split("/").pop() || `File ${f.index}`,
      formatBytes(size),
      f.selected === "false" ? "skipped"
        : size > 0 ? `${Math.round((got / size) * 100)}%` : "—",
    ], bt ? 1 : 0);
    tr.children[bt ? 1 : 0].title = f.path || "";
  });
  const bar = sec.querySelector(".detail-select");
  if (bar) bar.dataset.running = String(st.status === "active");
  updateSelectBar(sec);

  syncTable(sec, "servers", flattenServers(part.servers), (s) => s.key, (tr, s) => {
    cells(tr, [hostOf(s.uri), formatSpeed(s.speed) || "—"]);
    tr.children[0].title = s.uri;
  });

  const peers = part.peers || [];
  const shown = peers
    .map((p) => ({ ...p, key: `${p.ip}:${p.port}` }))
    .sort((a, b) => Number(b.downloadSpeed) - Number(a.downloadSpeed))
    .slice(0, PEER_LIMIT);
  syncTable(sec, "peers", shown, (p) => p.key, (tr, p) => {
    cells(tr, [
      `${p.ip}:${p.port}`,
      p.seeder === "true" ? "all" : bitfieldPct(p.bitfield, st.numPieces),
      formatSpeed(p.downloadSpeed) || "—",
      formatSpeed(p.uploadSpeed) || "—",
    ]);
  }, peers.length > PEER_LIMIT ? `${PEER_LIMIT} of ${peers.length}` : undefined);

  const errEl = sec.querySelector(".detail-error");
  const reason = st.status === "error" ? errorReason(st) : "";
  errEl.classList.toggle("hidden", !reason);
  if (reason && errEl.textContent !== reason) errEl.textContent = reason;
}

const MERGE_NOTES = {
  downloading: "Two downloads, one file: no site serves 2160p as a single stream any " +
               "more, so garia takes the halves separately and stitches them when both land.",
  muxing: "Both halves are down. ffmpeg is rewriting them into one container — a copy, not a re-encode.",
  done: "Merged. The two halves went to the Trash once the file below existed.",
  failed: "The halves downloaded; the merge did not finish.",
};

function updateJobBlock(sec, data) {
  const job = data.job;
  setField(sec, "page", job.webpageUrl || "");
  setField(sec, "out", job.outPath || (job.dir ? `${job.dir}/${job.out}` : job.out || ""));
  sec.querySelector(".detail-note").textContent = MERGE_NOTES[job.state] || "";
}

// Reveal has to name a file that is actually there: a merged row's output does
// not exist until ffmpeg has run, and a download that never wrote a byte has
// nothing to show.
function revealPath(data) {
  if (data.job) return data.job.state === "done" ? data.job.outPath || "" : "";
  const st = data.parts[0]?.status;
  return Number(st?.completedLength) > 0 ? st?.files?.[0]?.path || "" : "";
}

async function renderDetail() {
  const gid = detailGid;
  if (!gid) return;

  const data = await detailData(gid);
  if (detailGid !== gid) return;   // closed, or moved on, while aria2 answered

  const body = document.getElementById("detail-body");
  const shape = detailShape(data);
  if (body.dataset.shape !== shape) {
    body.dataset.shape = shape;
    body.textContent = "";
    if (canLimit(data)) body.appendChild(buildLimitBlock());
    if (canSchedule(data)) body.appendChild(buildStartBlock(data.gid));
    if (data.job) body.appendChild(buildJobBlock());
    for (const part of data.parts) body.appendChild(buildPart(part));
  }

  const title = data.row ? fileName(data.row) : gid;
  const titleEl = document.getElementById("detail-title");
  if (titleEl.textContent !== title) {
    titleEl.textContent = title;
    titleEl.title = title;
  }

  const sections = [...body.children];
  let i = 0;
  if (sections[i]?.classList.contains("detail-limit")) updateLimitBlock(sections[i++], data);
  if (sections[i]?.classList.contains("detail-start")) updateStartBlock(sections[i++], data);
  if (data.job) updateJobBlock(sections[i++], data);
  for (const part of data.parts) updatePart(sections[i++], part);

  const path = revealPath(data);
  const reveal = document.getElementById("detail-reveal");
  reveal.classList.toggle("hidden", !path);
  reveal.dataset.path = path;
}

// Fired off the poll tick, never awaited by it: aria2 answering slowly must
// not hold up the list, and two refreshes must not interleave.
function refreshDetail() {
  if (!detailGid || detailBusy) return;
  detailBusy = true;
  renderDetail()
    .catch((err) => console.error(err))
    .finally(() => { detailBusy = false; });
}

// aria2 takes select-file on a waiting or paused download, never on one it is
// working. So the download is stopped, told, and started again — forcePause
// because the ordinary pause finishes what it is doing first, and a poll for
// the status because "paused" is a state to arrive at, not a return value.
async function whilePaused(gid, wasActive, change) {
  if (!wasActive) return change();
  await rpc("aria2.forcePause", [gid]);
  for (let attempt = 0; attempt < 10; attempt++) {
    const st = await rpc("aria2.tellStatus", [gid, ["status"]]).catch(() => null);
    if (st?.status !== "active") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    return await change();
  } finally {
    // Whatever the change did, the download was running when it was asked for.
    await rpc("aria2.unpause", [gid]).catch((err) => console.error(err));
  }
}

async function applyFileSelection(gid, sec) {
  const wanted = selectedIndices(sec);
  if (!wanted.length) return;
  const running = sec.querySelector(".detail-select")?.dataset.running === "true";
  await whilePaused(gid, running, () =>
    rpc("aria2.changeOption", [gid, { "select-file": wanted.join(",") }]));
  fileSelection.delete(gid);
}

function openDetail(gid) {
  if (!gid) return;
  detailGid = gid;
  const body = document.getElementById("detail-body");
  // A fresh panel every time: the shape marker is what decides whether the
  // next tick rebuilds, and the last download's shape is not this one's.
  body.dataset.shape = "";
  body.textContent = "";
  fileSelection.clear();
  const row = snapshot.get(gid);
  document.getElementById("detail-title").textContent = row ? fileName(row) : gid;
  document.getElementById("detail-reveal").classList.add("hidden");
  document.getElementById("detail-overlay").classList.remove("hidden");
  refreshDetail();
}

function closeDetail() {
  // An unapplied pick is a thought, not a setting: it goes when the panel does.
  fileSelection.clear();
  detailGid = null;
  document.getElementById("detail-overlay").classList.add("hidden");
}

// Through Rust when there is a Rust to go through: the webview's clipboard
// needs a permission the app has no reason to depend on, and the backend is
// already on the other side of this clipboard watching it for file URLs — so
// it also knows to ignore what garia itself just wrote. The browser path is
// for `npm run mock`, where there is no backend at all.
async function copyText(text) {
  const invoker = window.__TAURI__?.core?.invoke;
  if (typeof invoker === "function") return invoker("copy_text", { text });
  return navigator.clipboard.writeText(text);
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
    const path = dl.files?.[0]?.path || "";
    n.api.sendNotification({
      title: "Download complete",
      body: total > 0 ? `${fileName(dl)} · ${formatBytes(total)}` : fileName(dl),
      extra: path ? { path } : undefined,
    });
  } catch (err) {
    console.error(err);
  }
}

function listenNotificationClicks() {
  const n = notifications();
  if (!n || typeof n.api.onAction !== "function") return;
  n.api.onAction((payload) => {
    const path = payload?.extra?.path;
    if (path && window.__TAURI__?.opener?.revealItemInDir) {
      window.__TAURI__.opener.revealItemInDir(path).catch(() => {});
    }
  }).catch((err) => console.error(err));
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

let lastTrayActive = -1;
function syncStatusItem(active) {
  if (active === lastTrayActive) return;
  lastTrayActive = active;
  const invoker = window.__TAURI__?.core?.invoke;
  if (typeof invoker !== "function") return;
  invoker("set_status_item", { active }).catch((err) => console.error(err));
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
      // Asked alongside rather than after: which rows are held changes on the
      // scheduler's tick, not on this one, but a row that says "Paused" for a
      // second before it says "Scheduled" is the flicker worth avoiding.
      loadSchedule(),
    ]);

    setConn("ok");
    renderSchedule();

    // aria2's own queue order, kept before the pairs are folded and the rows
    // are regrouped by status — the only place a drop position can come from.
    queueOrder = waiting.map((d) => d.gid);

    const raw = [...active, ...waiting, ...stopped].map(withSeeding);
    // Where each half actually landed, kept before the pairs are folded away —
    // the merge needs both paths, and only aria2 knows them.
    rawPaths.clear();
    for (const dl of raw) {
      const path = dl.files?.[0]?.path;
      if (path) rawPaths.set(dl.gid, path);
    }

    // Each download's own cap and checksum, learned once per gid — a row that
    // came back capped from the session file has to be able to say so, and a
    // row that finished has to know whether its hash was checked.
    learnOptions(raw);
    for (const gid of optionsAsked) {
      if (raw.some((d) => d.gid === gid)) continue;
      optionsAsked.delete(gid);
      rowLimits.delete(gid);
      rowChecksums.delete(gid);
    }

    const all = collapseJobs(raw);
    runPendingMerges(all);
    const tally = { all: all.length, active: 0, seeding: 0, waiting: 0, paused: 0, complete: 0, error: 0, speed: 0, upspeed: 0 };
    const seen = new Set();

    for (const dl of all) {
      seen.add(dl.gid);
      const before = snapshot.get(dl.gid);
      snapshot.set(dl.gid, dl);

      // The transition, not the state: a row sits at "complete" for as long as
      // it's on screen, and only the tick it arrived on is worth announcing.
      // A torrent lands when its files do — it then seeds for as long as the
      // rules say, and the end of that is not a second arrival.
      const landed = dl.status === "complete" || dl.status === "seeding";
      const hadLanded = before?.status === "complete" || before?.status === "seeding";
      if (settings.notifyOnComplete && !firstPoll && landed && !hadLanded) {
        notifyComplete(dl);
        countCompletion();
      }

      const counted = dl.status === "merging" ? "active" : dl.status;
      if (tally[counted] !== undefined) tally[counted]++;
      if (dl.status === "active") tally.speed += Number(dl.downloadSpeed) || 0;
      if (dl.status === "seeding") tally.upspeed += Number(dl.uploadSpeed) || 0;

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
    if (!reorderHold &&
        (current.length !== desired.length || desired.some((n, i) => current[i] !== n))) {
      const frag = document.createDocumentFragment();
      for (const node of desired) frag.appendChild(node);
      listEl.textContent = "";   // drops headers for groups that no longer exist
      listEl.appendChild(frag);
    }

    // A queue of one has nowhere to go, and the grab cursor would be a lie.
    listEl.classList.toggle("queue-reorderable", tally.waiting > 1);

    renderCounts(tally);
    syncStatusItem(tally.active);
    // Only a poll that actually reached aria2 counts as having seen the list;
    // a failed first attempt must not silence the real one.
    firstPoll = false;
  } catch (err) {
    console.error(err);
    const text = setConn("error");
    if (err?.message) text.title = `${text.title} — ${err.message}`;
    syncStatusItem(0);
  } finally {
    applyFilter(listEl);
    // Whatever the list did, the open detail panel is looking at the same
    // aria2 and wants the same tick.
    refreshDetail();
  }
}

window.addEventListener("DOMContentLoaded", () => {
  if (window.__TAURI__) document.documentElement.classList.add("in-app");

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

  const modalChecksumRow  = document.getElementById("modal-checksum-row");
  const modalChecksum     = document.getElementById("modal-checksum");
  const modalChecksumHint = document.getElementById("modal-checksum-hint");

  const modalBusy     = document.getElementById("modal-busy");
  const modalBusyText  = document.getElementById("modal-busy-text");
  const modalPlain    = document.getElementById("modal-plain");
  const modalOk       = document.getElementById("modal-ok");
  const modalTitle    = document.getElementById("modal-title");
  const videoPanel    = document.getElementById("video-panel");
  const videoChoices  = document.getElementById("video-choices");
  const videoNote     = document.getElementById("video-note");

  const playlistPanel   = document.getElementById("playlist-panel");
  const playlistRule    = document.getElementById("playlist-rule");
  const playlistEntries = document.getElementById("playlist-entries");
  const playlistCount   = document.getElementById("playlist-count");
  const playlistNote    = document.getElementById("playlist-note");

  // The dialog is one of four things at a time: asking for a URL, waiting on
  // yt-dlp, offering qualities, or offering a playlist. Every widget belongs to
  // exactly one of them, so the state is set in one place rather than toggled
  // eight.
  let modalMode = "url";
  let probed = null;      // the last successful probe, and its choices
  let playlist = null;    // the last flat listing, and which of it is ticked
  let probeToken = 0;     // a probe the user has moved on from must not land

  const MODAL_TITLES = {
    url: "Add download",
    busy: "Add download",
    video: "Download video",
    playlist: "Download playlist",
  };

  function setModalMode(mode) {
    modalMode = mode;
    const isUrl = mode === "url";
    document.querySelector(".modal-input-row").classList.toggle("hidden", !isUrl);
    document.querySelector('label[for="modal-url-input"]').classList.toggle("hidden", !isUrl);
    modalBusy.classList.toggle("hidden", mode !== "busy");
    videoPanel.classList.toggle("hidden", mode !== "video");
    playlistPanel.classList.toggle("hidden", mode !== "playlist");
    modalOk.classList.toggle("hidden", mode === "busy");
    // The playlist's own label counts what is ticked, and is set with it.
    if (mode !== "playlist") {
      modalOk.textContent = mode === "video" ? "Download" : "OK";
      modalOk.disabled = false;
    }
    modalTitle.textContent = MODAL_TITLES[mode] || MODAL_TITLES.url;
    // Last, and after the OK button has been re-enabled above: the hash is the
    // one thing in the dialog that can disable it again.
    renderChecksum();
  }

  // One source for the rules, so the list and the reading of it can't drift.
  playlistRule.append(...QUALITY_RULES.map((r) => {
    const option = document.createElement("option");
    option.value = r.id;
    option.textContent = r.detail ? `${r.label} — ${r.detail}` : r.label;
    return option;
  }));

  // A URL whose host garia has a login for, said before the download starts —
  // a 401 three seconds later is a worse way to find out, and a site with a
  // login saved is exactly the one where a typo in the host goes unnoticed.
  const modalLogin = document.getElementById("modal-login");
  function renderModalLogin() {
    const login = loginFor(modalUrlInput.value.trim());
    modalLogin.classList.toggle("hidden", !login);
    if (login) {
      modalLogin.textContent = login.username
        ? `Signing in to ${login.host} as ${login.username}`
        : `Sending your saved headers for ${login.host}`;
    }
  }

  // Three things to say and one field to say them in: nothing yet, the digest
  // aria2 will check against, or why what is there cannot be one. The OK button
  // goes with it — a hash aria2 would refuse is a download that never starts,
  // and finding that out on submit is a worse place to find it out.
  function renderChecksum() {
    const forFile = takesChecksum(modalUrlInput.value);
    modalChecksumRow.classList.toggle("hidden", modalMode !== "url" || !forFile);

    const parsed = forFile ? parseChecksum(modalChecksum.value) : null;
    modalChecksumHint.classList.toggle("is-bad", Boolean(parsed?.error));
    modalChecksumHint.textContent = !parsed
      ? "aria2 hashes the file as it arrives, so checking costs the download nothing."
      : parsed.error
        ? parsed.error
        : `${parsed.label}. The download fails rather than finishing if what lands doesn't match.`;

    if (modalMode === "url") modalOk.disabled = Boolean(parsed?.error);
  }

  function openModal(url = "") {
    probeToken++;
    probed = null;
    playlist = null;
    modalUrlInput.value = url;
    modalChecksum.value = "";
    torrentInput.value  = "";
    modalError.classList.add("hidden");
    modalPlain.classList.add("hidden");
    renderModalLogin();
    setModalMode("url");
    overlay.classList.remove("hidden");
    setTimeout(() => modalUrlInput.focus(), 50);
  }
  function closeModal() {
    probeToken++;   // whatever yt-dlp is doing, it is no longer wanted
    overlay.classList.add("hidden");
  }

  modalUrlInput.addEventListener("input", () => { renderModalLogin(); renderChecksum(); });
  modalChecksum.addEventListener("input", renderChecksum);
  document.getElementById("open-modal-btn").addEventListener("click", () => openModal());
  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("modal-cancel").addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // The login editor sits on top of Settings, so Escape there closes it and
    // leaves what it was opened from where it was.
    if (!document.getElementById("login-overlay").classList.contains("hidden")) {
      document.getElementById("login-overlay").classList.add("hidden");
      return;
    }
    closeTrafficMenu(); closeRowMenu(); closeModal(); closeConfirm(); closeSettings(); closeDetail(); closeLicenses(); closeHelp(); closeUpdate();
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

  // A .torrent the system opened — Finder, Open With, File → Open Torrent.
  // The bytes come from Rust so the webview never has to read an arbitrary path.
  // The same path can arrive twice (the live event and the pending drain);
  // one add is enough.
  const recentlyOpened = new Set();
  async function ingestTorrentPath(path) {
    if (!path || recentlyOpened.has(path)) return;
    recentlyOpened.add(path);
    setTimeout(() => recentlyOpened.delete(path), 2500);
    const invoker = window.__TAURI__?.core?.invoke;
    if (typeof invoker !== "function") return;
    try {
      const b64 = await invoker("read_torrent", { path });
      await rpc("aria2.addTorrent", [b64, [], addOptions()]);
      await pollAndSync();
    } catch (err) {
      console.error(err);
    }
  }

  // Hands the URL to aria2 exactly as typed. This is what the dialog has
  // always done, and it stays the fallback for everything yt-dlp declines.
  async function addPlainUrl(url, options = addOptions(url)) {
    modalError.classList.add("hidden");
    // The hash belongs to the URL as typed, so it rides the same call — and
    // only this one, because a video is two files and a playlist is forty.
    const parsed = takesChecksum(url) ? parseChecksum(modalChecksum.value) : null;
    if (parsed?.error) {
      modalError.textContent = parsed.error;
      modalError.classList.remove("hidden");
      return;
    }
    try {
      const gid = await rpc("aria2.addUri", [[url], { ...options, ...checksumOption(parsed) }]);
      // aria2 would answer the same thing a tick later; knowing it now is what
      // keeps a small file from finishing before its own badge exists.
      if (parsed?.spec && typeof gid === "string") rowChecksums.set(gid, parsed.spec);
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

    // A hash is a claim that this URL is a file, which is the question the
    // probe exists to answer. Nobody publishes a SHA-256 for a video page.
    const hashed = takesChecksum(url) && Boolean(parseChecksum(modalChecksum.value));
    if (hashed || !videoTools.version || !looksLikeAPage(url)) {
      await addPlainUrl(url);
      return;
    }

    const token = ++probeToken;
    modalBusyText.textContent = "Looking for video…";
    setModalMode("busy");

    let probe;
    try {
      probe = await window.__TAURI__.core.invoke("video_probe", { url });
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

    // A "playlist" holding one video is a video. Read it properly and offer
    // qualities, rather than a single checkbox with nothing to compare it to.
    if (probe.kind === "playlist" && probe.entries.length === 1) {
      const only = probe.entries[0];
      try {
        probe = await window.__TAURI__.core.invoke("video_probe", { url: only.url });
      } catch (err) {
        if (token !== probeToken) return;
        setModalMode("url");
        modalError.textContent = String(err?.message || err);
        modalError.classList.remove("hidden");
        modalPlain.classList.remove("hidden");
        return;
      }
      if (token !== probeToken) return;
    }

    if (probe.kind === "playlist") showPlaylist(probe);
    else showPicker(probe, url);
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

    modalPlain.classList.toggle("hidden", choices.length > 0);
    setModalMode("video");
    // After the mode, which hands the button back its default state.
    modalOk.disabled = choices.length === 0;
  }

  videoChoices.addEventListener("click", (e) => {
    const btn = e.target.closest(".video-choice");
    if (!btn || !probed) return;
    probed.selected = Number(btn.dataset.index);
    for (const el of videoChoices.querySelectorAll(".video-choice")) {
      el.setAttribute("aria-checked", String(el === btn));
    }
  });

  // ── The playlist picker ─────────────────────────────────────────────────
  // A flat listing: titles and page URLs, no formats. What each entry can
  // actually be downloaded at is a probe of its own, and those only happen for
  // the entries that are still ticked when Download is pressed.
  function showPlaylist(info) {
    playlist = {
      info,
      // All ticked: a playlist someone pasted is a playlist they want.
      checked: new Set(info.entries.map((_, i) => i)),
    };

    document.getElementById("playlist-title").textContent =
      info.title || info.webpageUrl || "Playlist";
    const shown = info.entries.length;
    const held = info.total > shown ? `first ${shown} of ${info.total}` : `${shown} videos`;
    document.getElementById("playlist-sub").textContent =
      [info.uploader, held, info.extractor].filter(Boolean).join(" · ");

    const thumb = document.getElementById("playlist-thumb");
    const art = info.entries.find((e) => e.thumbnail);
    thumb.classList.toggle("hidden", !art);
    if (art) thumb.src = art.thumbnail;

    // Only a cap is worth a note. Everything else the subtitle already said.
    const note = info.total > shown
      ? `Only the first ${shown} are listed — paste the rest of the playlist to reach them.`
      : "";
    playlistNote.textContent = note;
    playlistNote.classList.toggle("hidden", !note);

    renderPlaylistEntries();
    setModalMode("playlist");
  }

  function renderPlaylistEntries() {
    playlistEntries.textContent = "";
    playlist.info.entries.forEach((entry, i) => {
      const row = el("label", "playlist-entry");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.index = String(i);
      box.checked = playlist.checked.has(i);
      box.setAttribute("aria-label", `Download ${entry.title || entry.url}`);
      row.append(
        box,
        el("span", "playlist-entry-num", String(i + 1)),
        el("span", "playlist-entry-title", entry.title || entry.url),
        el("span", "playlist-entry-time", formatDuration(entry.duration)),
      );
      row.title = entry.title || entry.url;
      playlistEntries.appendChild(row);
    });
    renderPlaylistCount();
  }

  function renderPlaylistCount() {
    const picked = playlist.checked.size;
    const total = playlist.info.entries.length;
    playlistCount.textContent = `${picked} of ${total} selected`;
    modalOk.disabled = picked === 0;
    modalOk.textContent = picked ? `Download ${picked}` : "Download";
  }

  playlistEntries.addEventListener("change", (e) => {
    const box = e.target.closest("input[data-index]");
    if (!box || !playlist) return;
    const i = Number(box.dataset.index);
    if (box.checked) playlist.checked.add(i);
    else playlist.checked.delete(i);
    renderPlaylistCount();
  });

  function setAllChecked(on) {
    if (!playlist) return;
    playlist.checked = on ? new Set(playlist.info.entries.map((_, i) => i)) : new Set();
    for (const box of playlistEntries.querySelectorAll("input[data-index]")) {
      box.checked = on;
    }
    renderPlaylistCount();
  }
  document.getElementById("playlist-all").addEventListener("click", () => setAllChecked(true));
  document.getElementById("playlist-none").addEventListener("click", () => setAllChecked(false));

  // One entry at a time, queued as it resolves rather than after the last one:
  // twelve videos is twelve yt-dlp launches, and a list that fills in while it
  // works is the difference between a wait and a hang. The rule is read
  // against each entry's own formats, because the entries do not share any.
  async function submitPlaylist() {
    if (!playlist) return;
    const picked = [...playlist.checked].sort((a, b) => a - b);
    if (!picked.length) return;

    const rule = playlistRule.value;
    const token = ++probeToken;
    const failures = [];
    let queued = 0;

    setModalMode("busy");
    for (const [nth, index] of picked.entries()) {
      if (token !== probeToken) return;
      const entry = playlist.info.entries[index];
      const name = entry.title || entry.url;
      modalBusyText.textContent = `Reading ${nth + 1} of ${picked.length}…`;

      let probe;
      try {
        probe = await window.__TAURI__.core.invoke("video_probe", { url: entry.url });
      } catch (err) {
        failures.push([name, String(err?.message || err)]);
        continue;
      }
      if (token !== probeToken) return;
      if (probe.kind !== "video") {
        failures.push([name, "that entry is a playlist of its own"]);
        continue;
      }

      const choices = buildChoices(probe, videoTools.ffmpeg);
      const choice = pickByRule(choices, rule);
      if (!choice) {
        failures.push([name, missingNote(probe, choices, videoTools.ffmpeg) ||
          "nothing on it can be fetched as a plain file"]);
        continue;
      }

      try {
        await queueChoice({ ...probe, webpageUrl: probe.webpageUrl || entry.url }, choice);
        queued++;
        // Untick what is already downloading, so what is left on the panel
        // after a partial run is exactly what still needs one.
        playlist.checked.delete(index);
      } catch (err) {
        failures.push([name, String(err?.message || err)]);
      }
    }

    if (token !== probeToken) return;
    await pollAndSync();
    if (!failures.length) {
      closeModal();
      return;
    }

    // Something didn't read. The ones that did are already downloading, so the
    // panel comes back showing only the leftovers.
    renderPlaylistEntries();
    setModalMode("playlist");
    const [name, why] = failures[0];
    modalError.textContent = failures.length === 1
      ? `Queued ${queued}. “${name}” couldn't be read — ${why}`
      : `Queued ${queued} of ${picked.length}. ${failures.length} couldn't be read; ` +
        `the first, “${name}” — ${why}`;
    modalError.classList.remove("hidden");
  }

  // Queue one picked quality. One format is one download; two are two, and a
  // merge job that turns them back into one file and one row. Shared with the
  // playlist picker, which does this once per entry it read.
  async function queueChoice(info, choice) {
    const base = safeName(info.title) || "video";
    // Routed by what the file will be, not by the page URL — which has no
    // extension at all, and would land every video in the base folder.
    const dir = targetDir(`x.${choice.ext}`);
    const common = { ...(dir ? { dir } : {}), ...orderOptions() };
    // Some sites mint a URL for one User-Agent and 403 every other.
    const referer = info.webpageUrl ? { referer: info.webpageUrl } : {};

    if (choice.formats.length === 1) {
      const f = choice.formats[0];
      await rpc("aria2.addUri", [[f.url], {
        ...common, ...referer, out: `${base}.${f.ext}`,
        header: [...f.headers, ...loginHeaders(f.url)],
      }]);
      return;
    }

    const [v, a] = choice.formats;
    // yt-dlp's own naming for the halves, so a leftover part is
    // recognisable for what it is.
    const videoName = `${base}.f${v.id}.${v.ext}`;
    const audioName = `${base}.f${a.id}.${a.ext}`;
    const videoGid = await rpc("aria2.addUri", [[v.url], {
      ...common, ...referer, out: videoName,
      header: [...v.headers, ...loginHeaders(v.url)],
    }]);
    const audioGid = await rpc("aria2.addUri", [[a.url], {
      ...common, ...referer, out: audioName,
      header: [...a.headers, ...loginHeaders(a.url)],
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

  // Queue what the picker chose.
  async function submitVideo() {
    if (!probed) return;
    const { info, choices, selected } = probed;
    const choice = choices[selected];
    if (!choice) return;

    modalBusyText.textContent = "Queueing…";
    setModalMode("busy");

    try {
      await queueChoice(info, choice);
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
    else if (modalMode === "playlist") submitPlaylist();
    else submitUrl();
  });
  modalPlain.addEventListener("click", () => addPlainUrl(modalUrlInput.value.trim()));
  modalUrlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitUrl(); });

  // Per-row buttons and section "View all" links. A plain click selects;
  // the name, a double-click, or Enter opens the panel — a list, not a
  // stack of buttons that happen to look like rows.
  const selected = new Set();
  let selectAnchor = null;

  function visibleItemRows() {
    return [...listEl.querySelectorAll(".dl-item:not(.hidden)")];
  }

  function paintSelection() {
    for (const li of listEl.querySelectorAll(".dl-item")) {
      const on = selected.has(li.dataset.gid);
      li.classList.toggle("is-selected", on);
      li.setAttribute("aria-selected", String(on));
      li.tabIndex = on && li.dataset.gid === selectAnchor ? 0 : -1;
    }
  }

  function pruneSelection() {
    for (const gid of [...selected]) {
      if (!listEl.querySelector(`.dl-item[data-gid="${CSS.escape(gid)}"]`)) {
        selected.delete(gid);
      }
    }
    if (selectAnchor && !selected.has(selectAnchor)) {
      selectAnchor = [...selected][0] || null;
    }
    paintSelection();
  }

  function selectRow(row, e) {
    const gid = row.dataset.gid;
    const rows = visibleItemRows();
    if (e.shiftKey && selectAnchor) {
      const a = rows.findIndex((r) => r.dataset.gid === selectAnchor);
      const b = rows.indexOf(row);
      if (a >= 0 && b >= 0) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        if (!e.metaKey && !e.ctrlKey) selected.clear();
        for (let i = lo; i <= hi; i++) selected.add(rows[i].dataset.gid);
      }
    } else if (e.metaKey || e.ctrlKey) {
      if (selected.has(gid)) selected.delete(gid);
      else selected.add(gid);
      selectAnchor = gid;
    } else {
      selected.clear();
      selected.add(gid);
      selectAnchor = gid;
    }
    paintSelection();
    row.focus({ preventScroll: true });
  }

  function selectedDownloads() {
    return [...selected].map((gid) => snapshot.get(gid)).filter(Boolean);
  }

  async function runRowAction(gid, action, extra = {}) {
    if (action === "remove") { openConfirm([gid]); return; }
    if (action === "reprobe") {
      if (extra.url) { openModal(extra.url); submitUrl(); }
      return;
    }
    const gids = gidsFor(gid);
    try {
      if (action === "stop")   await Promise.all(gids.map((g) => rpc("aria2.pause", [g])));
      if (action === "resume") await Promise.all(gids.map((g) => rpc("aria2.unpause", [g])));
      if (action === "unseed") await Promise.all(gids.map((g) => rpc("aria2.remove", [g])));
      if (action === "retry")  await retryDownload(gid);
      if (action === "reveal") {
        const path = extra.path || rowPath(snapshot.get(gid));
        if (path) await window.__TAURI__.opener.revealItemInDir(path);
      }
      if (action !== "reveal" && extra.poll !== false) await pollAndSync();
    } catch (err) { console.error(err); }
  }

  async function runOnSelected(action) {
    const gids = [...selected];
    if (action === "remove") { openConfirm(gids); return; }
    if (action === "copy-url") {
      const urls = selectedDownloads().map(sourceUrl).filter(Boolean);
      if (urls.length) await copyText(urls.join("\n"));
      return;
    }
    if (action === "details") {
      const gid = selectAnchor || gids[0];
      if (gid) openDetail(gid);
      return;
    }
    let changed = false;
    for (const gid of gids) {
      const dl = snapshot.get(gid);
      if (!dl) continue;
      if (action === "stop" && (dl.status === "active" || dl.status === "waiting")) {
        await runRowAction(gid, "stop", { poll: false });
        changed = true;
      } else if (action === "resume" && dl.status === "paused") {
        await runRowAction(gid, "resume", { poll: false });
        changed = true;
      } else if (action === "unseed" && dl.status === "seeding") {
        await runRowAction(gid, "unseed", { poll: false });
        changed = true;
      } else if (action === "reveal" && rowPath(dl)) {
        await runRowAction(gid, "reveal", { path: rowPath(dl), poll: false });
      } else if (action === "retry" && dl.status === "error") {
        if (dl.job?.webpageUrl) await runRowAction(gid, "reprobe", { url: dl.job.webpageUrl });
        else { await runRowAction(gid, "retry", { poll: false }); changed = true; }
      }
    }
    if (changed) await pollAndSync();
  }

  async function toggleSelectedPause() {
    let changed = false;
    for (const dl of selectedDownloads()) {
      if (dl.status === "active" || dl.status === "waiting") {
        await runRowAction(dl.gid, "stop", { poll: false });
        changed = true;
      } else if (dl.status === "paused") {
        await runRowAction(dl.gid, "resume", { poll: false });
        changed = true;
      }
    }
    if (changed) await pollAndSync();
  }

  listEl.addEventListener("click", async (e) => {
    const link = e.target.closest(".dl-section-link");
    if (link) { setFilter(link.dataset.filter); return; }

    const btn = e.target.closest("[data-action]");
    if (btn) {
      await runRowAction(btn.dataset.gid, btn.dataset.action, btn.dataset);
      return;
    }

    const row = e.target.closest(".dl-item");
    if (!row) {
      if (!e.metaKey && !e.shiftKey) {
        selected.clear();
        selectAnchor = null;
        paintSelection();
      }
      return;
    }
    selectRow(row, e);
    if (e.target.closest(".dl-name")) openDetail(row.dataset.gid);
  });

  listEl.addEventListener("dblclick", (e) => {
    if (e.target.closest("[data-action], .dl-section-link")) return;
    const row = e.target.closest(".dl-item");
    if (row) openDetail(row.dataset.gid);
  });

  const rowMenu = document.getElementById("row-menu");

  function closeRowMenu() {
    rowMenu.classList.add("hidden");
    rowMenu.innerHTML = "";
  }

  function menuSpecFor(dls) {
    const items = [];
    if (dls.some((d) => d.status === "active" || d.status === "waiting")) {
      items.push({ action: "stop", label: "Pause" });
    }
    if (dls.some((d) => d.status === "paused")) {
      items.push({ action: "resume", label: "Resume" });
    }
    if (dls.some((d) => d.status === "seeding")) {
      items.push({ action: "unseed", label: "Stop Seeding" });
    }
    if (dls.some((d) => d.status === "error")) {
      items.push({ action: "retry", label: "Retry" });
    }
    if (dls.some((d) => rowPath(d))) {
      items.push({ action: "reveal", label: "Show in Finder" });
    }
    if (dls.some((d) => sourceUrl(d))) {
      items.push({ action: "copy-url", label: dls.length > 1 ? "Copy URLs" : "Copy URL" });
    }
    if (dls.length === 1) items.push({ action: "details", label: "Details" });
    items.push({ separator: true });
    items.push({ action: "remove", label: "Delete…", danger: true });
    return items;
  }

  function openRowMenu(x, y) {
    const dls = selectedDownloads();
    if (!dls.length) return;
    rowMenu.textContent = "";
    for (const spec of menuSpecFor(dls)) {
      if (spec.separator) {
        const sep = document.createElement("div");
        sep.className = "row-menu-sep";
        sep.setAttribute("role", "separator");
        rowMenu.appendChild(sep);
        continue;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = spec.danger ? "row-menu-item is-danger" : "row-menu-item";
      btn.setAttribute("role", "menuitem");
      btn.dataset.action = spec.action;
      btn.textContent = spec.label;
      rowMenu.appendChild(btn);
    }
    rowMenu.classList.remove("hidden");
    const pad = 8;
    const { width, height } = rowMenu.getBoundingClientRect();
    rowMenu.style.left = `${Math.min(x, window.innerWidth - width - pad)}px`;
    rowMenu.style.top = `${Math.min(y, window.innerHeight - height - pad)}px`;
  }

  listEl.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".dl-item");
    if (!row) return;
    e.preventDefault();
    if (!selected.has(row.dataset.gid)) selectRow(row, { shiftKey: false });
    openRowMenu(e.clientX, e.clientY);
  });

  rowMenu.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    closeRowMenu();
    await runOnSelected(btn.dataset.action);
  });

  document.addEventListener("mousedown", (e) => {
    if (!rowMenu.classList.contains("hidden") && !e.target.closest("#row-menu")) {
      closeRowMenu();
    }
  });
  document.addEventListener("scroll", closeRowMenu, true);

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
    // A download that failed for want of a login is the one most likely to be
    // retried, so the retry is added with whatever has been saved since. The
    // hash goes back on too, and on the one failure that is about the hash it
    // costs nothing to re-run: the bytes and the control file are still there,
    // so aria2 resumes at the end of a finished file and only hashes it.
    const spec = rowChecksums.get(gid) || "";
    const newGid = await rpc("aria2.addUri", [uris, {
      ...(dl.dir ? { dir: dl.dir } : {}), ...orderOptions(), ...loginOptions(uris[0]),
      ...(spec ? { checksum: spec } : {}),
    }]);
    if (spec && typeof newGid === "string") rowChecksums.set(newGid, spec);
    await purgeResult(gid);
  }

  // The hash the detail panel was given, put wherever aria2 will take it. See
  // buildCheckBlock for why the two halves are different calls.
  async function checkAgainst(gid, spec) {
    const st = await rpc("aria2.tellStatus", [gid, ["status", "dir", "files"]]);
    if (LIMITABLE.has(st.status)) {
      await rpc("aria2.changeOption", [gid, { checksum: spec }]);
      rowChecksums.set(gid, spec);
      return gid;
    }

    const uris = retryUris(st);
    if (!uris.length) {
      throw new Error("aria2 has no URL on record for this download, so there is nothing to check it from.");
    }
    // The same folder and the same name, or aria2 writes a second copy beside
    // the file instead of reading the one that is already there.
    const path = st.files?.[0]?.path || "";
    const out = path.slice(path.lastIndexOf("/") + 1);
    const newGid = await rpc("aria2.addUri", [uris, {
      ...(st.dir ? { dir: st.dir } : {}), ...(out ? { out } : {}),
      ...orderOptions(), ...loginOptions(uris[0]), checksum: spec,
    }]);
    rowChecksums.set(newGid, spec);
    await purgeResult(gid);
    return newGid;
  }

  async function removeDownload(gid, alsoTrash, { silent } = {}) {
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
    selected.delete(gid);
    if (!silent) await pollAndSync();
  }

  const confirmOverlay = document.getElementById("confirm-overlay");
  const confirmTitle   = document.getElementById("confirm-title");
  const confirmName    = document.getElementById("confirm-name");
  const confirmFileRow = document.getElementById("confirm-file-row");
  const confirmTrash   = document.getElementById("confirm-trash");
  const confirmCancel  = document.getElementById("confirm-cancel");
  const confirmTrashLabel = confirmFileRow.querySelector("span");
  let confirmGids = [];

  function openConfirm(gids) {
    const list = (Array.isArray(gids) ? gids : [gids]).filter((g) => snapshot.has(g));
    if (!list.length) return;
    confirmGids = list;
    const many = list.length > 1;
    confirmTitle.textContent = many ? "Delete downloads" : "Delete download";
    confirmName.textContent = many
      ? `${list.length} downloads`
      : fileName(snapshot.get(list[0]));
    const onDisk = list.some((g) => rowWroteBytes(snapshot.get(g)));
    confirmFileRow.classList.toggle("hidden", !onDisk);
    confirmTrashLabel.textContent = many
      ? "Move the downloaded files to the Trash"
      : "Move the downloaded file to the Trash";
    confirmTrash.checked = false;
    confirmOverlay.classList.remove("hidden");
    setTimeout(() => confirmCancel.focus(), 50);
  }

  function closeConfirm() {
    confirmOverlay.classList.add("hidden");
    confirmGids = [];
  }

  confirmCancel.addEventListener("click", closeConfirm);
  confirmOverlay.addEventListener("click", (e) => {
    if (e.target === confirmOverlay) closeConfirm();
  });
  document.getElementById("confirm-delete").addEventListener("click", async () => {
    const gids = confirmGids;
    const alsoTrash = confirmTrash.checked && !confirmFileRow.classList.contains("hidden");
    closeConfirm();
    for (const gid of gids) await removeDownload(gid, alsoTrash, { silent: true });
    await pollAndSync();
  });

  // ── Detail panel ─────────────────────────────────────────────────────────
  const detailOverlay = document.getElementById("detail-overlay");

  detailOverlay.addEventListener("click", async (e) => {
    // The row's own cap. Sent before the panel is redrawn, and the buttons go
    // dead in between: a second click while aria2 is still answering the first
    // would leave the two halves of a merged row on different limits.
    const limitBtn = e.target.closest("[data-limit-mode]");
    if (limitBtn && detailGid) {
      const gid = detailGid;
      const seg = limitBtn.closest(".seg");
      const buttons = [...seg.querySelectorAll("button")];
      for (const b of buttons) b.disabled = true;
      try {
        await setRowLimit(gid, modeLimit(limitBtn.dataset.limitMode));
      } catch (err) {
        console.error(err);
      }
      for (const b of buttons) b.disabled = false;
      refreshDetail();
      await pollAndSync();   // the chip on the row behind the panel
      return;
    }

    // A tick on a file inside a torrent. Remembered against the gid so the
    // next poll redraws what the user chose rather than what aria2 still says.
    const box = e.target.closest("input[data-file-index]");
    if (box) {
      const sec = box.closest(".detail-part");
      fileSelection.set(sec.dataset.gid, new Set(selectedIndices(sec)));
      updateSelectBar(sec);
      return;
    }

    // Opening the partial file. The button is only enabled once the backend
    // has said the bytes at the front are worth opening, so there is nothing
    // to re-check here — but the file can go away between tick and click.
    const play = e.target.closest(".detail-preview-play");
    if (play) {
      play.disabled = true;
      try {
        await window.__TAURI__.core.invoke("preview_file", { path: play.dataset.path });
      } catch (err) {
        console.error(err);
        const note = play.closest(".detail-preview").querySelector(".detail-preview-note");
        note.textContent = String(err?.message || err);
      }
      play.disabled = false;
      return;
    }

    // Giving one download an hour, or taking it back. Both are the same Rust
    // call, and both pause or resume the download then and there rather than
    // waiting for the scheduler's next tick — a click whose effect arrives
    // fifteen seconds later reads as a click that did nothing.
    const when = e.target.closest(".detail-start-set, .detail-start-clear");
    if (when) {
      const sec = when.closest(".detail-start");
      const note = sec.querySelector(".detail-start-note");
      const clearing = when.classList.contains("detail-start-clear");
      const typed = sec.querySelector(".detail-start-input").value;
      const at = clearing ? null : Math.floor(new Date(typed).getTime() / 1000);

      if (!clearing && !Number.isFinite(at)) {
        note.textContent = "Pick a date and a time for this download to start.";
        return;
      }
      if (!clearing && at <= Math.floor(Date.now() / 1000)) {
        note.textContent = "That moment has already passed — pick one still to come.";
        return;
      }

      when.disabled = true;
      try {
        schedule = await window.__TAURI__.core.invoke("set_download_start",
          { gid: when.dataset.gid, at });
        heldGids = new Set(schedule.held || []);
        renderSchedule();
      } catch (err) {
        console.error(err);
        note.textContent = String(err?.message || err);
      }
      when.disabled = false;
      refreshDetail();
      await pollAndSync();
      return;
    }

    const apply = e.target.closest(".detail-select-apply");
    if (apply) {
      const sec = apply.closest(".detail-part");
      apply.disabled = true;
      try {
        await applyFileSelection(apply.dataset.gid, sec);
      } catch (err) {
        console.error(err);
      }
      refreshDetail();
      await pollAndSync();
      return;
    }

    // Arming a check on a download in flight, or asking aria2 to re-read one
    // that has already landed. One sentence to the user, two different calls
    // underneath, and a new gid in the second case — a finished download is a
    // record aria2 will not change, so it is the download that is added again.
    const check = e.target.closest(".detail-check-go");
    if (check) {
      const block = check.closest(".detail-check");
      const note = block.querySelector(".detail-check-note");
      const parsed = parseChecksum(block.querySelector(".detail-check-input").value);
      if (!parsed || parsed.error) {
        note.textContent = parsed?.error || "Paste a hash to check this download against.";
        return;
      }
      check.disabled = true;
      try {
        const next = await checkAgainst(check.dataset.gid, parsed.spec);
        // The panel follows the download rather than the record: a re-check is
        // a new gid, and the old one is about to be purged out from under it.
        if (next !== check.dataset.gid) openDetail(next);
      } catch (err) {
        console.error(err);
        note.textContent = String(err?.message || err);
        check.disabled = false;
        return;
      }
      check.disabled = false;
      refreshDetail();
      await pollAndSync();
      return;
    }

    // A source URL is long, expiring and worth pasting elsewhere; a path is
    // worth pasting into a terminal. Both are one click from being text.
    const copy = e.target.closest(".detail-copy");
    if (copy) {
      // Say what actually happened: a button that reports "Copied" over a
      // clipboard that refused is worse than no button.
      let copied = true;
      try {
        await copyText(copy.dataset.value || "");
      } catch (err) {
        copied = false;
        console.error(err);
      }
      copy.textContent = copied ? "Copied" : "Blocked";
      setTimeout(() => { copy.textContent = "Copy"; }, 1200);
      return;
    }
    if (e.target === detailOverlay) closeDetail();
  });

  document.getElementById("detail-close").addEventListener("click", closeDetail);
  document.getElementById("detail-done").addEventListener("click", closeDetail);
  document.getElementById("detail-reveal").addEventListener("click", async (e) => {
    const path = e.currentTarget.dataset.path;
    if (!path) return;
    try { await window.__TAURI__.opener.revealItemInDir(path); } catch (err) { console.error(err); }
  });

  // Bulk action helpers
  async function bulkAction(gids, action) {
    const method = action === "pause" ? "aria2.pause" : "aria2.unpause";
    const all = gids.flatMap(gidsFor);
    await Promise.allSettled(all.map(gid => rpc(method, [gid])));
    await pollAndSync();
  }

  function pauseAll() {
    const gids = [...listEl.querySelectorAll(".dl-item[data-status='active']")].map(li => li.dataset.gid);
    bulkAction(gids, "pause");
  }
  function resumeAll() {
    const gids = [...listEl.querySelectorAll(".dl-item[data-status='paused']")].map(li => li.dataset.gid);
    bulkAction(gids, "resume");
  }

  document.getElementById("pause-all").addEventListener("click", pauseAll);
  document.getElementById("resume-all").addEventListener("click", resumeAll);

  // ── Queue reordering ─────────────────────────────────────────────────────
  // A queue is an order, so it has to be draggable. The rows move under the
  // pointer here and aria2 is told once, on the drop — a round trip per pixel
  // would leave the row a poll behind the finger the whole way down.
  const PRESS_SLOP = 4;      // px before a press is a drag and not a click
  const SCROLL_EDGE = 44;    // how close to the edge of the list starts a scroll

  const scroller = document.querySelector(".content-body");
  let press = null;          // pointer down on a queued row, not yet a drag
  let drag = null;           // the live drag
  let suppressClick = false; // the click that ends a drag isn't a click on the row

  const bound = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

  // Only the queued rows move, and only the ones on screen: search can hide a
  // row without taking it out of the queue.
  function queuedRows() {
    return [...listEl.querySelectorAll('.dl-item[data-status="waiting"]:not(.hidden)')];
  }

  listEl.addEventListener("click", (e) => {
    if (!suppressClick) return;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  listEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !listEl.classList.contains("queue-reorderable")) return;
    const row = e.target.closest(".dl-item");
    if (!row || row.dataset.status !== "waiting") return;
    // The row's buttons are buttons, not a handle.
    if (e.target.closest("[data-action]")) return;
    const rows = queuedRows();
    if (rows.length < 2 || !rows.includes(row)) return;

    press = { row, rows, y: e.clientY };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
  });

  function startDrag() {
    const { row, rows } = press;
    const from = rows.indexOf(row);
    drag = {
      row, rows, from, to: from,
      // Every position is measured once, in the layout the drag started in.
      tops: rows.map((r) => r.getBoundingClientRect().top),
      height: row.getBoundingClientRect().height,
      y: press.y,
      lastY: press.y,
      scrollAt: scroller.scrollTop,
      scrollStep: 0,
      scrolling: 0,
    };
    listEl.classList.add("is-reordering");
    row.classList.add("is-dragging");
    // The list is the user's for as long as the row is in hand; the poll can
    // keep the numbers moving, but not the rows.
    reorderHold = true;
  }

  function onPointerMove(e) {
    if (!drag) {
      if (Math.abs(e.clientY - press.y) < PRESS_SLOP) return;
      startDrag();
    }
    e.preventDefault();
    drag.lastY = e.clientY;
    autoScroll(e.clientY);
    place(e.clientY);
  }

  // A scroll during the drag is just an offset against the measurements taken
  // at the start of it, added back so the row stays under the finger.
  function place(clientY) {
    const { rows, tops, height, from } = drag;
    const scrolled = scroller.scrollTop - drag.scrollAt;
    const lo = tops[0] - tops[from];
    const hi = tops[rows.length - 1] - tops[from];
    const raw = clientY - drag.y + scrolled;
    const dy = bound(raw, lo, hi);
    // The slot is worked out from a hair past either end, so that dragging the
    // row hard against the top of the queue is unambiguously first place
    // rather than a tie with the row already there.
    const center = tops[from] + bound(raw, lo - 1, hi + 1) + height / 2;

    let to = from;
    for (let i = 0; i < rows.length; i++) {
      if (i === from) continue;
      const middle = tops[i] + height / 2;
      if (i < from && center < middle) to = Math.min(to, i);
      if (i > from && center > middle) to = Math.max(to, i);
    }
    drag.to = to;

    // The row follows the pointer; the rows it has passed step aside by
    // exactly its height, which is the gap it will drop into.
    drag.row.style.transform = `translateY(${dy}px)`;
    rows.forEach((r, i) => {
      if (i === from) return;
      const shift = i > from && i <= to ? -height : i < from && i >= to ? height : 0;
      r.style.transform = shift ? `translateY(${shift}px)` : "";
    });
  }

  // Dragging to a row that is off the bottom of a long queue has to be
  // possible without letting go, so the list scrolls itself near its edges.
  function autoScroll(clientY) {
    const box = scroller.getBoundingClientRect();
    const above = clientY - box.top;
    const below = box.bottom - clientY;
    drag.scrollStep =
      above < SCROLL_EDGE ? -Math.ceil((SCROLL_EDGE - above) / 4) :
      below < SCROLL_EDGE ?  Math.ceil((SCROLL_EDGE - below) / 4) : 0;
    if (!drag.scrollStep || drag.scrolling) return;

    const tick = () => {
      if (!drag) return;
      if (!drag.scrollStep) { drag.scrolling = 0; return; }
      scroller.scrollTop += drag.scrollStep;
      place(drag.lastY);
      drag.scrolling = requestAnimationFrame(tick);
    };
    drag.scrolling = requestAnimationFrame(tick);
  }

  function endDrag() {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
    press = null;
    if (!drag) return;

    const { row, rows, from, to, scrolling } = drag;
    if (scrolling) cancelAnimationFrame(scrolling);
    drag = null;

    listEl.classList.remove("is-reordering");
    row.classList.remove("is-dragging");
    for (const r of rows) r.style.transform = "";

    // The pointerup is about to fire a click on the row, which would open the
    // detail panel on the download that was just dragged.
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);

    // moveRow puts the hold straight back up if there is a move to make.
    reorderHold = false;
    if (to !== from) moveRow(row, rows, from, to);
  }

  // The same move without a pointer, for the keyboard and for a queue too long
  // to drag across: ⌥↑ / ⌥↓ by one, with shift to either end.
  listEl.addEventListener("keydown", (e) => {
    // Some layouts hand back a mangled key when alt is down, so the physical
    // key is the fallback — the arrows are the arrows either way.
    const key = e.key === "ArrowUp" || e.key === "ArrowDown" ? e.key : e.code;
    if (!e.altKey || (key !== "ArrowUp" && key !== "ArrowDown")) return;
    const row = e.target.closest?.(".dl-item");
    if (!row || row.dataset.status !== "waiting") return;
    const rows = queuedRows();
    const from = rows.indexOf(row);
    if (from < 0 || rows.length < 2) return;

    e.preventDefault();
    const up = key === "ArrowUp";
    const to = e.shiftKey ? (up ? 0 : rows.length - 1) : from + (up ? -1 : 1);
    if (to === from || to < 0 || to >= rows.length) return;
    moveRow(row, rows, from, to);
    row.scrollIntoView({ block: "nearest" });
  });

  // The row lands where it was put and aria2 is told afterwards. Waiting for
  // the round trip would snap it back for a tick, which reads as a refusal.
  async function moveRow(row, rows, from, to) {
    // aria2 may have started the download while it was in hand, and a running
    // one is not in the queue at all any more.
    if (row.dataset.status !== "waiting") return;

    const target = rows[to];
    const anchor = to > from ? target.nextElementSibling : target;
    const neighbours = to > from
      ? { after: target.dataset.gid }
      : { before: target.dataset.gid };
    const focused = row.contains(document.activeElement) ? document.activeElement : null;

    reorderHold = true;
    listEl.insertBefore(row, anchor);
    focused?.focus({ preventScroll: true });
    try {
      await moveInQueue(row.dataset.gid, neighbours);
    } catch (err) {
      console.error(err);
    }
    reorderHold = false;
    // Whatever aria2 made of it is what the list should be showing.
    await pollAndSync();
    focused?.focus({ preventScroll: true });
  }

  // A finished file leaves the list the way it leaves Finder — the row is the
  // handle, and the drop is the file itself. Queued rows keep the reorder
  // gesture; this one only arms on complete and seeding rows that wrote a path.
  listEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !window.__TAURI__) return;
    if (e.target.closest("[data-action]")) return;
    const row = e.target.closest(".dl-item");
    if (!row || !row.classList.contains("is-file-draggable")) return;
    const origin = { x: e.clientX, y: e.clientY };
    const onMove = (ev) => {
      if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < PRESS_SLOP) return;
      cleanup();
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      if (!selected.has(row.dataset.gid)) selectRow(row, { shiftKey: false });
      const paths = selectedDownloads().map(rowPath).filter(Boolean);
      if (paths.length) {
        window.__TAURI__.core.invoke("start_file_drag", { paths }).catch((err) => console.error(err));
      }
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
  });

  // ── Settings ─────────────────────────────────────────────────────────────
  const settingsOverlay = document.getElementById("settings-overlay");
  const settingsDir     = document.getElementById("settings-dir");
  const settingsMedium  = document.getElementById("settings-medium");
  const settingsLight   = document.getElementById("settings-light");
  const settingsConc    = document.getElementById("settings-concurrency");
  const settingsRatio   = document.getElementById("settings-seed-ratio");
  const settingsSeedFor = document.getElementById("settings-seed-time");
  const settingsNotify  = document.getElementById("settings-notify");
  const settingsAutostart = document.getElementById("settings-autostart");
  const settingsSmart   = document.getElementById("settings-smart-folders");
  const settingsCatch   = document.getElementById("settings-catch");
  const settingsInOrder = document.getElementById("settings-in-order");
  const settingsCookies = document.getElementById("settings-cookies");
  const settingsRemote  = document.getElementById("settings-remote");
  const settingsSched   = document.getElementById("settings-schedule");
  const settingsSchedFrom = document.getElementById("settings-schedule-start");
  const settingsSchedTo   = document.getElementById("settings-schedule-end");
  const settingsSchedSum  = document.getElementById("settings-schedule-sum");
  const settingsLogins  = document.getElementById("settings-logins");
  const settingsError   = document.getElementById("settings-error");

  const MB = 1024 * 1024;

  const inMB = (bytes) => String(Math.round((Number(bytes) / MB) * 100) / 100);
  const toBytes = (text) => {
    const mb = parseFloat(text);
    return Number.isFinite(mb) && mb > 0 ? Math.round(mb * MB) : 0;
  };

  function openSettings() {
    settingsError.classList.add("hidden");
    loadVideoTools();
    settingsDir.value = settings.downloadDir || "";
    // Bytes per second is what aria2 wants; MB/s is what a person thinks in.
    settingsMedium.value = inMB(modeLimit("medium"));
    settingsLight.value = inMB(modeLimit("light"));
    settingsConc.value = String(settings.maxConcurrentDownloads || 5);
    settingsRatio.value = String(Number(settings.seedRatio) || 0);
    settingsSeedFor.value = String(Number(settings.seedTimeMinutes) || 0);
    settingsNotify.checked = settings.notifyOnComplete !== false;
    loadAutostart();
    settingsSmart.checked = settings.smartFolders === true;
    settingsCatch.checked = settings.catchClipboard !== false;
    settingsInOrder.checked = settings.inOrder === true;
    settingsCookies.value = settings.cookieFile || "";
    settingsRemote.checked = settings.remoteControl === true;
    settingsSched.checked = settings.scheduleEnabled === true;
    settingsSchedFrom.value = hhmm(Number(settings.scheduleStart) || 0);
    settingsSchedTo.value = hhmm(Number(settings.scheduleEnd) || 0);
    renderScheduleSummary();
    renderLogins();
    loadRemote();
    settingsOverlay.classList.remove("hidden");
    setTimeout(() => settingsDir.focus(), 50);
  }

  function closeSettings() { settingsOverlay.classList.add("hidden"); }

  async function loadAutostart() {
    const invoker = window.__TAURI__?.core?.invoke;
    if (typeof invoker !== "function") {
      settingsAutostart.closest(".field")?.classList.add("hidden");
      return;
    }
    try {
      settingsAutostart.checked = await invoker("autostart_enabled");
    } catch (err) {
      console.error(err);
      settingsAutostart.closest(".field")?.classList.add("hidden");
    }
  }

  const schedFrom = () => minutesOf(settingsSchedFrom.value) ?? 2 * 60;
  const schedTo   = () => minutesOf(settingsSchedTo.value) ?? 8 * 60;

  // The two times say what they are; how long that leaves and which side of
  // midnight it falls on, they do not. A window that wraps is the normal case
  // here and the one most likely to be typed by accident.
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

  for (const input of [settingsSched, settingsSchedFrom, settingsSchedTo]) {
    input.addEventListener("input", renderScheduleSummary);
  }

  async function saveSettings() {
    settingsError.classList.add("hidden");
    const files = parseInt(settingsConc.value, 10);
    const next = {
      downloadDir: settingsDir.value.trim(),
      maxConcurrentDownloads: Number.isFinite(files) ? Math.min(Math.max(files, 1), 16) : 5,
      // The mode stands; what it means is what this dialog edits. A zero is
      // read as "unset" on the way back in and comes back as the default.
      trafficMode: currentMode(),
      mediumLimit: toBytes(settingsMedium.value),
      lightLimit: toBytes(settingsLight.value),
      seedRatio: Math.min(Math.max(parseFloat(settingsRatio.value) || 0, 0), 100),
      seedTimeMinutes: Math.max(parseInt(settingsSeedFor.value, 10) || 0, 0),
      smartFolders: settingsSmart.checked,
      notifyOnComplete: settingsNotify.checked,
      catchClipboard: settingsCatch.checked,
      inOrder: settingsInOrder.checked,
      // aria2 only reads a jar at launch, so Rust restarts it when this
      // changes. A path that isn't a file comes back as no jar at all.
      cookieFile: settingsCookies.value.trim(),
      // Neither does it move the RPC socket once it is bound —
      // changeGlobalOption answers OK to rpc-listen-all and changes nothing —
      // so this is the second setting that restarts the engine.
      remoteControl: settingsRemote.checked,
      // A window with no width is not a window: read as "always" it is this
      // box unticked, read as "never" it is a download manager that never
      // downloads. Rust refuses to store one either way — this only keeps the
      // dialog from claiming otherwise on its way there.
      scheduleEnabled: settingsSched.checked && schedFrom() !== schedTo(),
      scheduleStart: schedFrom(),
      scheduleEnd: schedTo(),
    };

    // Switching notifications off should take the count on the dock with it.
    if (!next.notifyOnComplete) clearBadge();

    const invoker = window.__TAURI__?.core?.invoke;
    if (typeof invoker !== "function") {
      // Browser dev mode — nothing to persist to, but the dialog still behaves.
      settings = {
        ...next,
        // What Rust would have done with a blank field.
        mediumLimit: next.mediumLimit || 2 * MB,
        lightLimit: next.lightLimit || 512 * 1024,
      };
      settings.maxOverallDownloadLimit = modeLimit(currentMode());
      renderTraffic();
      closeSettings();
      return;
    }

    const opening = next.remoteControl && settings.remoteControl !== true;
    try {
      await invoker("set_autostart", { enabled: settingsAutostart.checked });
      // Rust returns the settings as they were actually stored, clamped.
      settings = await invoker("save_settings", { settings: next });
      renderTraffic();
      // Every other save closes the dialog. Turning remote control on is the
      // one that produces something to look at — the address and the code to
      // scan only exist once aria2 has come back — so it stays up rather than
      // making the user reopen Settings to find what they just asked for.
      if (opening) await loadRemote();
      else closeSettings();
    } catch (err) {
      settingsError.textContent = String(err?.message || err);
      settingsError.classList.remove("hidden");
    }
  }

  // ── Remote control ───────────────────────────────────────────────────────
  // The pairing is Rust's to answer for and nothing here caches it: the
  // address comes off the routing table, the port is the one aria2 actually
  // got, and the secret is the one it was started with — all three of which a
  // restart can change. So the panel asks each time it is shown.
  const remotePair   = document.getElementById("remote-pair");
  const remoteNote   = document.getElementById("remote-note");
  const remoteHost   = document.getElementById("remote-host");
  const remotePort   = document.getElementById("remote-port");
  const remoteSecret = document.getElementById("remote-secret");
  const remoteQr     = document.getElementById("remote-qr");

  // A square of modules, drawn as one rect per horizontal run rather than one
  // per module: a 29-wide code is 841 of them, and a scanner cannot tell the
  // difference. Black on white whatever else the window is, because that is
  // the contrast every camera is looking for.
  const QUIET = 4;   // the margin the QR spec asks for, in modules
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
    // The namespace is redundant inline and not redundant the moment anyone
    // copies the code out of the page.
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" role="img" aria-label="The pairing secret as a QR code" shape-rendering="crispEdges">`
      + `<rect width="${side}" height="${side}" fill="#ffffff"/>`
      + `<g fill="#000000">${rects.join("")}</g></svg>`;
  }

  async function loadRemote() {
    const wanted = settingsRemote.checked;
    const invoker = window.__TAURI__?.core?.invoke;
    let info = null;
    if (typeof invoker === "function") {
      try { info = await invoker("remote_info"); } catch (err) { console.error(err); }
    }

    // What is actually open right now, which is not what the checkbox says
    // until Save has restarted aria2 on the other setting.
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
    if (wanted && !open) {
      said.push("Not open yet — Save restarts the download engine with the port open, and the pairing appears here.");
    } else if (!wanted && open) {
      said.push("Still open until you Save. Saving deletes the secret, so anything paired against it stops working rather than waiting for the port to come back.");
    } else if (open && !info.host) {
      said.push("This machine isn't on a network garia can find an address for, so there is nothing for another device to connect to.");
    } else if (paired && !info.defaultPort) {
      said.push(`Something else had aria2's usual port when garia started, so it took ${info.port} instead. The pairing works, but the number can be different next launch.`);
    }
    remoteNote.textContent = said.join(" ");
    remoteNote.classList.toggle("hidden", said.length === 0);
  }

  settingsRemote.addEventListener("change", loadRemote);

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

  // ── Traffic mode menu ────────────────────────────────────────────────────
  // Anchored to its button rather than nested in the status bar, which clips
  // its own overflow so a long line of counts can't stretch it.
  const trafficBtn  = document.getElementById("traffic-btn");
  const trafficMenu = document.getElementById("traffic-menu");

  function closeTrafficMenu() {
    trafficMenu.classList.add("hidden");
    trafficBtn.setAttribute("aria-expanded", "false");
  }

  function openTrafficMenu() {
    renderTraffic();
    trafficMenu.classList.remove("hidden");
    trafficBtn.setAttribute("aria-expanded", "true");
    const rect = trafficBtn.getBoundingClientRect();
    trafficMenu.style.left = `${rect.left}px`;
    trafficMenu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
  }

  trafficBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (trafficMenu.classList.contains("hidden")) openTrafficMenu();
    else closeTrafficMenu();
  });

  trafficMenu.addEventListener("click", async (e) => {
    const option = e.target.closest(".traffic-option");
    if (!option) return;
    closeTrafficMenu();
    try {
      await setTrafficMode(option.dataset.mode);
    } catch (err) {
      console.error(err);
    }
  });

  // Anywhere else, including the rest of the status bar.
  document.addEventListener("click", (e) => {
    if (trafficMenu.classList.contains("hidden")) return;
    if (!e.target.closest("#traffic-menu, #traffic-btn")) closeTrafficMenu();
  });

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

  document.getElementById("settings-cookies-browse").addEventListener("click", async () => {
    const pick = window.__TAURI__?.dialog?.open;
    if (typeof pick !== "function") {
      settingsError.textContent = "No file picker here — type the path instead.";
      settingsError.classList.remove("hidden");
      return;
    }
    try {
      const chosen = await pick({
        multiple: false,
        title: "Choose a cookies.txt",
        filters: [{ name: "Cookies", extensions: ["txt"] }],
        defaultPath: settingsCookies.value.trim() || undefined,
      });
      if (typeof chosen === "string" && chosen) settingsCookies.value = chosen;
    } catch (err) {
      console.error(err);
    }
  });

  // ── Logins ───────────────────────────────────────────────────────────────
  // The list in Settings, and the editor behind one row of it. Rust owns both
  // files and hands back the list as it stored it, so nothing here decides
  // what a login is — it sends what was typed and re-renders the answer.
  const loginOverlay   = document.getElementById("login-overlay");
  const loginTitle     = document.getElementById("login-title");
  const loginHost      = document.getElementById("login-host");
  const loginUser      = document.getElementById("login-user");
  const loginPass      = document.getElementById("login-pass");
  const loginPassHint  = document.getElementById("login-pass-hint");
  const loginHeadersEl = document.getElementById("login-headers");
  const loginDelete    = document.getElementById("login-delete");
  const loginError     = document.getElementById("login-error");

  // The site being edited, or "" for a new one. It is what tells Save that an
  // empty password box means "keep the one Rust is holding" rather than "no
  // password" — this side is never sent one, so it cannot put it back.
  let editingHost = "";

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

  // The password field says where the password it is about to take will live,
  // because that is the whole difference between the two ways of sending one.
  function renderPassHint(login) {
    if (login?.hasPassword && login.viaHeader) {
      loginPassHint.textContent =
        "This one has a space in it, and netrc has no way to quote a space — so " +
        "garia sends it as an Authorization header instead, which aria2 writes " +
        "into its session file. Leave the box empty to keep it.";
    } else if (login?.hasPassword) {
      loginPassHint.textContent =
        "Saved in a netrc file only aria2 reads. Leave the box empty to keep it.";
    } else {
      loginPassHint.textContent =
        "Kept in a netrc file aria2 reads for itself, so it is never attached to " +
        "a download and never reaches the session file. A password with a space " +
        "in it can't go in a netrc — that one becomes a header, and says so here.";
    }
  }

  function openLogin(host = "") {
    const login = logins.find(l => l.host === host);
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

  async function saveLogin() {
    loginError.classList.add("hidden");
    loginBusy(true);
    try {
      const typed = loginPass.value;
      await putLogin({
        host: loginHost.value,
        username: loginUser.value.trim(),
        // A blank box on a site that already has one means leave it alone;
        // on a new site it means there is no password.
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

  // Saving a login can restart aria2 — a netrc is read once, at launch — so
  // these wait for Rust and take the list it returns rather than guessing.
  async function putLogin(entry) {
    const invoker = window.__TAURI__?.core?.invoke;
    if (typeof invoker === "function") {
      logins = await invoker("save_login", entry);
      return;
    }
    logins = mockLogins(entry, "save");
  }

  async function dropLogin(host) {
    const invoker = window.__TAURI__?.core?.invoke;
    if (typeof invoker === "function") {
      logins = await invoker("delete_login", { host });
      return;
    }
    logins = mockLogins({ host }, "delete");
  }

  // Browser dev mode only. Rust is the real implementation of all of this;
  // this exists so the dialog can be worked on without a build, and mirrors
  // the one rule that changes what the dialog says: netrc cannot hold a
  // password with whitespace in it, so that one becomes a header.
  function mockLogins(entry, verb) {
    const host = siteOf(entry.host);
    const next = logins.filter(l => l.host !== host);
    if (verb === "save") {
      if (!host) throw new Error("Which site is this for? Paste a URL or type a host name.");
      const was = logins.find(l => l.host === host);
      const headers = (entry.headers || []).map(h => h.trim()).filter(Boolean);
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
        password: kept,              // the mock keeps it; Rust never sends it back
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

  document.getElementById("settings-login-add").addEventListener("click", () => openLogin());
  document.getElementById("login-save").addEventListener("click", saveLogin);
  document.getElementById("login-cancel").addEventListener("click", closeLogin);
  document.getElementById("login-close").addEventListener("click", closeLogin);
  loginDelete.addEventListener("click", removeLogin);
  loginOverlay.addEventListener("click", (e) => { if (e.target === loginOverlay) closeLogin(); });
  loginPass.addEventListener("keydown", (e) => { if (e.key === "Enter") saveLogin(); });
  loginHost.addEventListener("keydown", (e) => { if (e.key === "Enter") saveLogin(); });

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

  // Native menu owns these in the app. The browser mock has no menu, so the
  // same shortcuts live here too — and ⌘F is in both, because Find is a
  // custom item rather than the system's.
  function fieldHasFocus() {
    return Boolean(document.activeElement?.closest("input, textarea, select, [contenteditable]"));
  }

  function overlayOpen() {
    return [...document.querySelectorAll(".modal-overlay")].some((el) => !el.classList.contains("hidden"));
  }

  document.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && key === "f") {
      e.preventDefault();
      nameSearch.focus();
      nameSearch.select();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (key === "?" || (key === "/" && e.shiftKey))) {
      e.preventDefault();
      if (helpOverlay.classList.contains("hidden")) openHelp();
      else closeHelp();
      return;
    }
    if (!window.__TAURI__ && (e.metaKey || e.ctrlKey)) {
      if (key === "n") { e.preventDefault(); openModal(); }
      if (key === ",") { e.preventDefault(); openSettings(); }
      if (key === "o") { e.preventDefault(); torrentInput.click(); }
    }

    if (fieldHasFocus() || overlayOpen()) return;

    const rows = visibleItemRows();
    if ((e.metaKey || e.ctrlKey) && key === "a" && rows.length) {
      e.preventDefault();
      selected.clear();
      for (const row of rows) selected.add(row.dataset.gid);
      selectAnchor = rows[rows.length - 1].dataset.gid;
      paintSelection();
      return;
    }

    if (!selected.size && !listEl.contains(document.activeElement)) return;

    if ((e.metaKey || e.ctrlKey) && key === "c") {
      e.preventDefault();
      runOnSelected("copy-url");
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === "Backspace" || e.key === "Delete")) {
      e.preventDefault();
      runOnSelected("remove");
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      runOnSelected("details");
      return;
    }
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      toggleSelectedPause();
      return;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.altKey) {
      e.preventDefault();
      if (!rows.length) return;
      const current = selectAnchor
        ? rows.findIndex((r) => r.dataset.gid === selectAnchor)
        : -1;
      const next = e.key === "ArrowDown"
        ? Math.min(rows.length - 1, current + 1)
        : Math.max(0, current < 0 ? 0 : current - 1);
      selectRow(rows[next], e);
      rows[next].scrollIntoView({ block: "nearest" });
    }
  });

  const listenMenu = window.__TAURI__?.event?.listen;
  if (typeof listenMenu === "function") {
    listenMenu("menu", (event) => {
      const id = event.payload;
      if (id === "new-download") openModal();
      if (id === "settings") openSettings();
      if (id === "open-torrent") torrentInput.click();
      if (id === "find") { nameSearch.focus(); nameSearch.select(); }
      if (id === "pause-all") pauseAll();
      if (id === "resume-all") resumeAll();
      if (id === "open-folder") {
        const dir = settings.downloadDir;
        if (dir && window.__TAURI__?.opener?.openPath) {
          window.__TAURI__.opener.openPath(dir).catch((err) => console.error(err));
        }
      }
      if (id === "licenses") openLicenses();
      if (id === "help") openHelp();
      if (id === "check-updates") checkForUpdate();
    });
  }

  const licensesOverlay = document.getElementById("licenses-overlay");
  function openLicenses() { licensesOverlay.classList.remove("hidden"); }
  function closeLicenses() { licensesOverlay.classList.add("hidden"); }
  document.getElementById("licenses-close").addEventListener("click", closeLicenses);
  document.getElementById("licenses-done").addEventListener("click", closeLicenses);
  licensesOverlay.addEventListener("click", (e) => {
    if (e.target === licensesOverlay) closeLicenses();
  });
  licensesOverlay.addEventListener("click", (e) => {
    const link = e.target.closest("a[href]");
    if (!link || !window.__TAURI__?.opener?.openUrl) return;
    e.preventDefault();
    window.__TAURI__.opener.openUrl(link.href).catch((err) => console.error(err));
  });

  const helpOverlay = document.getElementById("help-overlay");
  function openHelp() { helpOverlay.classList.remove("hidden"); }
  function closeHelp() { helpOverlay.classList.add("hidden"); }
  document.getElementById("help-close").addEventListener("click", closeHelp);
  document.getElementById("help-done").addEventListener("click", closeHelp);
  helpOverlay.addEventListener("click", (e) => {
    if (e.target === helpOverlay) closeHelp();
  });

  const updateOverlay = document.getElementById("update-overlay");
  const updateTitle = document.getElementById("update-title");
  const updateText = document.getElementById("update-text");
  const updateNotes = document.getElementById("update-notes");
  const updateLater = document.getElementById("update-later");
  const updateInstall = document.getElementById("update-install");

  function closeUpdate() { updateOverlay.classList.add("hidden"); }

  function showUpdate(kind, info) {
    updateNotes.classList.add("hidden");
    updateNotes.textContent = "";
    updateLater.textContent = kind === "available" ? "Later" : "OK";
    updateLater.classList.toggle("hidden", kind === "checking");
    updateInstall.classList.toggle("hidden", kind !== "available");
    if (kind === "checking") {
      updateTitle.textContent = "Updates";
      updateText.textContent = "Checking…";
    } else if (kind === "current") {
      updateTitle.textContent = "You’re up to date";
      updateText.textContent = info?.currentVersion
        ? `${info.currentVersion} is the latest.`
        : "This is the latest version.";
    } else if (kind === "available") {
      updateTitle.textContent = `Version ${info.version}`;
      updateText.textContent = `You have ${info.currentVersion}. Install ${info.version}?`;
      if (info.notes) {
        updateNotes.textContent = info.notes;
        updateNotes.classList.remove("hidden");
      }
    } else {
      updateTitle.textContent = "Updates";
      updateText.textContent = info?.message || "Could not check for updates.";
    }
    updateOverlay.classList.remove("hidden");
  }

  async function checkForUpdate({ quiet } = {}) {
    if (!window.__TAURI__?.core?.invoke) return;
    if (!quiet) showUpdate("checking");
    try {
      const info = await window.__TAURI__.core.invoke("check_for_update");
      if (info) showUpdate("available", info);
      else if (!quiet) showUpdate("current");
    } catch (err) {
      if (!quiet) showUpdate("error", { message: String(err?.message || err) });
    }
  }

  updateLater.addEventListener("click", closeUpdate);
  updateOverlay.addEventListener("click", (e) => {
    if (e.target === updateOverlay) closeUpdate();
  });
  updateInstall.addEventListener("click", async () => {
    updateInstall.disabled = true;
    updateLater.disabled = true;
    updateText.textContent = "Downloading…";
    try {
      await window.__TAURI__.core.invoke("install_update");
    } catch (err) {
      updateInstall.disabled = false;
      updateLater.disabled = false;
      showUpdate("error", { message: String(err?.message || err) });
    }
  });

  // A release on GitHub is worth a prompt. A missing latest.json is not —
  // there has never been one, and the menu is how you ask on purpose.
  if (window.__TAURI__) {
    setTimeout(() => checkForUpdate({ quiet: true }), 4000);
  }

  async function pollAndSync() {
    await poll(listEl);
    pruneSelection();
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
    listen("open-torrent", (event) => {
      if (event.payload) ingestTorrentPath(event.payload);
    });
  }
  const invoker = window.__TAURI__?.core?.invoke;
  if (typeof invoker === "function") {
    invoker("take_pending_catch").then((pending) => {
      for (const event of pending || []) handleCatch(event);
    }).catch(() => {});
    invoker("take_pending_torrents").then((pending) => {
      for (const path of pending || []) ingestTorrentPath(path);
    }).catch(() => {});
  }

  loadSettings();
  loadLogins();
  loadVideoTools();
  listenNotificationClicks();
  pollAndSync();
  setInterval(pollAndSync, 1000);
});
