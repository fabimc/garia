// Decisions behind the uTorrent-parity controls. Kept here so the list, the
// detail panel, and the tests agree on what "stalled", "healthy", and "high
// priority" mean. aria2 has no per-file piece priority and no tracker status,
// so the rules below are the closest honest reading of those ideas.

const TIER = ["high", "normal", "low"];

function asString(value) {
  return String(value ?? "").trim();
}

function isFalseSelection(value) {
  const text = asString(value).toLowerCase();
  return value === false || text === "false" || value === 0;
}

function isTrueSelection(value) {
  const text = asString(value).toLowerCase();
  return value === true || text === "true";
}

function normalizePriority(value) {
  if (value === false || value === null || value === undefined || value === 0) return "normal";
  const text = asString(value).toLowerCase();
  return text || "normal";
}

export function isTorrentDownload(dl) {
  if (!dl) return false;
  return Boolean(dl.bittorrent || dl.infoHash);
}

export function fileDone(file) {
  const length = Number(file?.length) || 0;
  const got = Number(file?.completedLength) || 0;
  return length > 0 && got >= length;
}

// High files come first, then Normal, then Low. Off is left out. A file whose
// size is still unknown counts as unfinished, so a magnet does not skip ahead
// of the files the user asked for first.
export function desiredIndices(files) {
  const rows = (files || [])
    .map((file) => ({
      index: Number(file.index),
      priority: normalizePriority(file.priority),
      done: fileDone(file),
    }))
    .filter((file) => file.priority !== "off" && Number.isFinite(file.index));
  if (!rows.length) return [];

  const pending = rows.filter((file) => !file.done);
  const active = pending.length
    ? TIER.find((tier) => pending.some((file) => file.priority === tier)) || "low"
    : "low";
  const allow = new Set(TIER.slice(0, TIER.indexOf(active) + 1));
  return rows
    .filter((file) => allow.has(file.priority))
    .map((file) => file.index)
    .sort((a, b) => a - b);
}

export function prioritiesNeedAdvance(files) {
  return (files || []).some((file) => {
    const priority = normalizePriority(file?.priority);
    return priority && priority !== "normal";
  });
}

export function indicesDiffer(current, wanted) {
  const a = current || [];
  const b = wanted || [];
  return a.length !== b.length || a.some((n, i) => n !== b[i]);
}

export function selectedIndicesOf(files) {
  return (files || [])
    .filter((file) => !isFalseSelection(file?.selected))
    .map((file) => Number(file.index))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

// Connected seeds and peers, which is all aria2 reports. The whole swarm is
// not in the RPC, so "healthy" means the peers we can actually reach.
export function torrentHealth({ seeders = 0, leechers = 0, peers = 0 } = {}) {
  const seeds = Math.max(0, Number(seeders) || 0);
  const leech = Math.max(0, Number(leechers) || 0);
  const connected = Math.max(0, Number(peers) || 0);
  let label = "No peers";
  if (seeds >= 5 || (seeds >= 2 && connected >= 4)) label = "Healthy";
  else if (seeds >= 1) label = "OK";
  else if (connected > 0 || leech > 0) label = "Weak";
  return {
    label,
    seeds,
    leechers: leech,
    peers: connected,
    title: `${seeds} seeds · ${leech} leechers · ${connected} connected`,
  };
}

// A torrent with metadata, no speed, and nobody to talk to. Fetching the
// metainfo (no size yet) is not stalled — there is nothing to stall on.
export function isStalled(dl) {
  if (!isTorrentDownload(dl)) return false;
  if (dl.status !== "active" || dl.seeder === "true") return false;
  const total = Number(dl.totalLength) || 0;
  const done = Number(dl.completedLength) || 0;
  if (!(total > 0) || done >= total) return false;
  const speed = Number(dl.downloadSpeed) || 0;
  const peers = Number(dl.connections) || 0;
  return speed === 0 && peers === 0;
}

export function seedUntilLabel(ratio, minutes) {
  const share = Number(ratio) || 0;
  const mins = Number(minutes) || 0;
  if (share <= 0 && mins <= 0) return "Seed until you stop it";
  const parts = [];
  if (share > 0) parts.push(`ratio ${share}×`);
  if (mins > 0) parts.push(`${mins} min`);
  return `Seed until ${parts.join(" or ")}`;
}

export function placeInQueue(order, moving, where) {
  const set = new Set(moving || []);
  const picked = (order || []).filter((gid) => set.has(gid));
  if (!picked.length) return (order || []).slice();
  const rest = (order || []).filter((gid) => !set.has(gid));
  if (!rest.length) return (order || []).slice();
  return where === "end" ? [...rest, ...picked] : [...picked, ...rest];
}

export function sameOrder(a, b) {
  return (a || []).length === (b || []).length && (a || []).every((gid, i) => gid === b[i]);
}

export function trackerRows(announceList) {
  const rows = [];
  const tiers = Array.isArray(announceList) ? announceList : [];
  tiers.forEach((tier, index) => {
    const urls = Array.isArray(tier) ? tier : [tier];
    for (const url of urls) {
      if (!url) continue;
      rows.push({ tier: index + 1, url: String(url) });
    }
  });
  return rows;
}

// aria2 does not say which tracker answered. A connected peer is the only
// evidence that the list is doing its job.
export function trackerStatus(peerCount) {
  return Number(peerCount) > 0 ? "Working" : "Waiting";
}

// A custom cap, typed as kilobytes per second. Blank is "no custom cap".
// Negative and non-numeric values are refused rather than treated as zero.
export function parseKilobytes(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1024);
}

export function leechersOf({ connections = 0, seeders = 0, peers = [] } = {}) {
  const list = Array.isArray(peers) ? peers : [];
  if (list.length) return list.filter((peer) => peer?.seeder !== "true").length;
  return Math.max(0, (Number(connections) || 0) - (Number(seeders) || 0));
}

// Why a paused row is waiting — queue stopped, schedule window, or a start time.
export function scheduleHoldNote({
  held = false,
  startAtLabel = "",
  queueStopped = false,
  scheduleBlocked = false,
  scheduleStartLabel = "",
} = {}) {
  if (!held) return "";
  if (startAtLabel) return `starts ${startAtLabel}`;
  if (queueStopped) return "Queue stopped";
  if (scheduleBlocked && scheduleStartLabel) return `starts ${scheduleStartLabel}`;
  return "held";
}

const FAILURE_LABELS = {
  checksum: "Checksum",
  network: "Network",
  disk: "Disk",
  auth: "Login",
  server: "Server",
  media: "Media merge",
  unknown: "Error",
};

export function failureCategoryLabel(kind) {
  return FAILURE_LABELS[kind] || "";
}

export function failureKind({ errorCode, errorMessage, jobError } = {}) {
  if (jobError) return "media";
  const code = Number(errorCode) || 0;
  const msg = String(errorMessage || "").toLowerCase();
  if (code === 32) return "checksum";
  if (code === 24) return "auth";
  if ([9, 15, 16, 17, 18, 14, 13].includes(code)) return "disk";
  if ([2, 6, 19].includes(code)) return "network";
  if ([3, 4, 8, 22, 23, 29].includes(code)) return "server";
  if (/status=(403|401|404|429|500|502|503)/.test(msg)) return "server";
  if (/timed out|timeout|network|resolve|connection reset|refused/.test(msg)) return "network";
  if (/checksum|hash|digest/.test(msg)) return "checksum";
  if (/space|disk|no such file|permission|read-only/.test(msg)) return "disk";
  if (code) return "unknown";
  return "";
}

// The seven digests and their lengths are aria2's, not a convention borrowed
// from elsewhere.
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

export function parseChecksum(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const named = raw.match(/\b(adler-?32|md5|sha-?(?:224|256|384|512|1))\b[\s:=]*/i);
  const claimed = named ? normalizeAlgo(named[1]) : "";
  const rest = named ? raw.slice(named.index + named[0].length) : raw;

  const hex = (t) => /^[0-9a-f]+$/i.test(t);
  const tokens = rest.split(/[\s,]+/).filter(Boolean);
  let digest = tokens.find((t) => hex(t) && CHECKSUM_ALGOS[t.length]);
  if (!digest && tokens.length > 1 && tokens.every(hex)) {
    const joined = tokens.join("");
    if (CHECKSUM_ALGOS[joined.length]) digest = joined;
  }
  if (!digest) {
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

export function splitChecksum(spec) {
  const text = String(spec || "");
  const at = text.indexOf("=");
  if (at < 1) return null;
  const algo = text.slice(0, at).toLowerCase();
  return { algo, digest: text.slice(at + 1), label: ALGO_LABELS[algo] || algo.toUpperCase(), spec: text };
}

// Playlist rule ids match QUALITY_RULES in the add dialog.
export function pickByRule(choices, rule) {
  if (!choices?.length) return null;
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

// XDM-style copy for empty states, media capture, limits, and failure recovery
// (P3–P5 in docs/XDM-Parity-Plan.md). Shared so list, detail, and settings agree.

export function formatEmptyQueueState({
  filter = "all",
  hasAnyDownloads = false,
  connError = false,
  modNHint = "⌘N",
} = {}) {
  if (connError) {
    return {
      title: "Can't reach aria2",
      sub: "Start aria2 and garia will reconnect on its own",
    };
  }
  if (hasAnyDownloads) {
    if (String(filter).startsWith("cat:")) {
      return {
        title: "Nothing in this category",
        sub: "Downloads that land in this folder show up here",
      };
    }
    if (String(filter).startsWith("pkg:")) {
      return {
        title: "Nothing left in this package",
        sub: "Finished or removed downloads drop out of the package list",
      };
    }
    if (filter === "torrents") {
      return { title: "No torrents", sub: "Magnets and .torrent files show up here" };
    }
    return {
      title: "Nothing matches this view",
      sub: "Try a different filter or clear the search field",
    };
  }
  return {
    title: "No downloads yet",
    sub: `Drag a URL or .torrent file anywhere, copy a file link, or hit ${modNHint}, or install the browser extension to catch links and video pages`,
  };
}

export function formatRecoverableNextStep(errorCode) {
  const code = Number(errorCode);
  if (code === 24) return "Add a login in Settings, then Retry.";
  if (code === 32) return "Check the checksum or remove the row and download again.";
  if (code === 29) return "Wait and use Retry when the server is less busy.";
  if (code === 19) return "Check your network or DNS, then Retry.";
  if (code === 17) return "Free disk space or pick another folder, then Retry.";
  return "Retry re-queues the download with the same options.";
}

export function formatIntegrityFailureReason(errorCode) {
  const code = Number(errorCode);
  if (code === 32) return "Checksum mismatch — the file on disk does not match what was promised.";
  if (code === 26) return "The torrent metainfo is corrupt.";
  return "";
}

export function formatFfmpegMergeLine({ hasFfmpeg = false, ffmpegSource = "" } = {}) {
  if (!hasFfmpeg) {
    return "No ffmpeg — the bundled one is missing, so only single-file qualities are offered.";
  }
  if (ffmpegSource === "system") {
    return "Merging uses your own ffmpeg; the copy garia ships did not run.";
  }
  return "Merging uses the ffmpeg garia ships, so split video-and-audio qualities are available.";
}

export function formatCaptureFlowHint(source) {
  if (source === "clipboard") {
    return "Link copied — confirm in Add Download or start from the banner.";
  }
  if (source === "extension") {
    return "Sent from the browser — review the URL and folder before adding.";
  }
  return "Paste a URL, drop a file, or capture from the browser extension.";
}

export function formatMediaQualityLabel({ height = 0, ext = "", formatId = "" } = {}) {
  const h = Number(height);
  const res = h > 0 ? `${h}p` : "unknown resolution";
  const kind = String(ext || formatId || "stream").trim() || "stream";
  return `${res} · ${kind}`;
}

export function formatSpeedLimitScope({ perDownloadBytes = 0, modeBytes = 0, mode = "full" } = {}) {
  const cap = Number(perDownloadBytes) || 0;
  const modeCap = Number(modeBytes) || 0;
  if (cap > 0) {
    return `This download has its own cap (${cap} B/s), overriding the traffic mode.`;
  }
  if (mode && mode !== "full" && modeCap > 0) {
    return `Traffic mode “${mode}” limits all active downloads (${modeCap} B/s).`;
  }
  return "No per-download cap — the app-wide traffic mode applies.";
}

export function formatTorrentStateMessage(dl) {
  if (!dl) return "";
  if (dl.status === "seeding") return "Seeding — sharing completed pieces with the swarm.";
  if (dl.status === "active" && isStalled(dl)) {
    return "Stalled — no peers connected, so nothing is arriving.";
  }
  if (dl.status === "active" && dl.seeder === "true") return "Uploading to the swarm.";
  if (dl.status === "waiting") return "Queued — will start when a slot opens.";
  if (dl.status === "paused") return "Paused — resume when you are ready.";
  if (dl.status === "error") return "Failed — read the message below and Retry if offered.";
  return "";
}

export function formatChecksumStatus({ hasChecksum = false, verified = false } = {}) {
  if (!hasChecksum) return "No checksum was set for this download.";
  if (verified) return "Checksum matched — the file is verified.";
  return "Checksum pending or failed — see the row status.";
}

export function formatDetailBadge(dl) {
  if (!dl) return "";
  if (isTorrentDownload(dl)) return "Torrent";
  if (dl.job) return "Video";
  return "HTTP";
}

export function formatFilePriorityLabel(priority) {
  const tier = normalizePriority(priority);
  const labels = { high: "High", normal: "Normal", low: "Low", off: "Off" };
  return labels[tier] || "Normal";
}

// The four choices a torrent file can be given. Off is a choice, not the
// absence of one: it is how a file stays out of the download.
export const FILE_PRIORITY_TIERS = ["high", "normal", "low", "off"];

export const priorityDisplay = formatFilePriorityLabel;

// Active, peers connected, but barely moving — not stalled (zero peers).
export function isSlowDownload(dl, minSpeedBytes = 1024) {
  if (!isTorrentDownload(dl)) return false;
  if (dl.status !== "active" || dl.seeder === "true") return false;
  const total = Number(dl.totalLength) || 0;
  const done = Number(dl.completedLength) || 0;
  if (!(total > 0) || done >= total) return false;
  if (isStalled(dl)) return false;
  const speed = Number(dl.downloadSpeed) || 0;
  const peers = Number(dl.connections) || 0;
  return peers > 0 && speed > 0 && speed < minSpeedBytes;
}

// What to show on a torrent row when the user set non-default file tiers.
export function prioritySummary(files) {
  const rows = (files || [])
    .map((file) => ({
      priority: normalizePriority(file.priority),
      done: fileDone(file),
    }))
    .filter((file) => file.priority !== "off" && !file.done);
  if (!rows.length) return null;
  const pending = rows.map((r) => r.priority);
  if (pending.some((p) => p === "high")) {
    return { label: "High first", title: "High-priority files download before Normal and Low." };
  }
  if (pending.some((p) => p === "low") && !pending.some((p) => p === "normal")) {
    return { label: "Low only", title: "Only Low-priority files are still waiting." };
  }
  // Default Normal-only queues are not a custom priority layout.
  if (pending.every((p) => p === "normal") || pending.every((p) => p === "off")) return null;
  return { label: "Custom files", title: "This torrent uses custom per-file priorities." };
}

export function bulkPriorityMap(files, action, checkedIndices) {
  const checked = new Set(checkedIndices || []);
  const out = {};
  for (const file of files || []) {
    const index = Number(file.index);
    if (!Number.isFinite(index)) continue;
    const key = String(index);
    const current = normalizePriority(file.priority);
    if (action === "all-high") out[key] = "high";
    else if (action === "all-normal") out[key] = "normal";
    else if (action === "all-low") out[key] = "low";
    else if (action === "all-off") out[key] = "off";
    else if (action === "checked-high" && checked.has(index)) out[key] = "high";
    else if (action === "checked-normal" && checked.has(index)) out[key] = "normal";
    else if (action === "checked-low" && checked.has(index)) out[key] = "low";
    else if (action === "checked-off" && checked.has(index)) out[key] = "off";
    else out[key] = current;
  }
  return out;
}

// One line of guidance for recoverable failures (tooltip / detail panel).
export function recoveryNextStep(dl) {
  if (!dl || dl.status !== "error") return "";
  const code = Number(dl.errorCode);
  if (code === 24) return "Add a login in Settings, then retry.";
  if (code === 9) return "Free disk space, then retry.";
  if (code === 32) return "Check the checksum or download again without one.";
  if (code === 6 || code === 2) return "Check your connection, then retry.";
  if (code === 3 || code === 4 || code === 8) return "The file may be gone or the link changed — try a fresh URL.";
  if (code === 13) return "Remove or rename the existing file, then retry.";
  if (code === 29) return "Wait a few minutes and retry.";
  if (code === 5) return "Raise the speed limit or traffic mode, then retry.";
  return "Use Retry on the row or Download → Retry Failed.";
}

// Bulk intake. A pasted page, or "download all links", mixes files with
// ordinary pages. Files start selected. Pages do not, because adding a page
// as a URL saves its HTML. Content kinds (video, archive, …) are the JD-style
// labels on top of File/Page so a dump can be filtered before it starts.

const CONTENT_EXTS = {
  video: new Set(["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "3gp", "ts"]),
  audio: new Set(["mp3", "flac", "wav", "aac", "ogg", "oga", "m4a", "wma", "opus", "aiff", "alac"]),
  document: new Set([
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
    "rtf", "txt", "csv", "epub", "mobi", "djvu",
  ]),
  archive: new Set([
    "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "iso", "dmg", "pkg",
    "exe", "msi", "deb", "rpm", "apk", "jar", "bin", "img", "xip",
  ]),
};

const MIME_BY_EXT = {
  mp4: "video/mp4", mkv: "video/x-matroska", webm: "video/webm", avi: "video/x-msvideo",
  mov: "video/quicktime", mp3: "audio/mpeg", flac: "audio/flac", wav: "audio/wav",
  m4a: "audio/mp4", ogg: "audio/ogg", pdf: "application/pdf", zip: "application/zip",
  rar: "application/vnd.rar", "7z": "application/x-7z-compressed", tar: "application/x-tar",
  gz: "application/gzip", iso: "application/x-iso9660-image", dmg: "application/x-apple-diskimage",
  exe: "application/vnd.microsoft.portable-executable", torrent: "application/x-bittorrent",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  txt: "text/plain", csv: "text/csv", json: "application/json", xml: "application/xml",
};

const CONTENT_LABELS = {
  video: "Video",
  audio: "Audio",
  archive: "Archive",
  document: "Document",
  magnet: "Magnet",
  torrent: "Torrent",
  page: "Page",
  other: "File",
};

export function extensionOfUrl(url) {
  const path = String(url || "").split(/[?#]/, 1)[0];
  const name = path.split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function mimeHintFromExt(ext) {
  const key = String(ext || "").toLowerCase();
  if (!key) return "";
  return MIME_BY_EXT[key] || (CONTENT_EXTS.video.has(key) ? `video/${key}`
    : CONTENT_EXTS.audio.has(key) ? `audio/${key}`
      : CONTENT_EXTS.archive.has(key) ? `application/${key}`
        : CONTENT_EXTS.document.has(key) ? `application/${key}`
          : "");
}

export function contentKindFromUrl(url) {
  const raw = String(url ?? "").trim();
  if (/^magnet:/i.test(raw)) return "magnet";
  const ext = extensionOfUrl(raw);
  if (ext === "torrent") return "torrent";
  if (CONTENT_EXTS.video.has(ext)) return "video";
  if (CONTENT_EXTS.audio.has(ext)) return "audio";
  if (CONTENT_EXTS.archive.has(ext)) return "archive";
  if (CONTENT_EXTS.document.has(ext)) return "document";
  return "other";
}

export function contentKindLabel(content) {
  return CONTENT_LABELS[content] || CONTENT_LABELS.other;
}

export function classifyIntakeUrl(url, isDirectFile = () => false) {
  const raw = String(url ?? "").trim();
  if (/^magnet:/i.test(raw)) {
    return {
      kind: "magnet",
      label: "Magnet",
      file: true,
      content: "magnet",
      contentLabel: "Magnet",
      mime: "",
      ext: "",
    };
  }
  if (/^ftps?:\/\//i.test(raw)) {
    const file = isDirectFile(raw);
    const content = file ? contentKindFromUrl(raw) : "other";
    const ext = file ? extensionOfUrl(raw) : "";
    return {
      kind: file ? "ftp-file" : "ftp",
      label: file ? (contentKindLabel(content) === "File" ? "FTP file" : contentKindLabel(content)) : "FTP folder",
      file,
      content: file ? content : "other",
      contentLabel: file ? contentKindLabel(content) : "Folder",
      mime: file ? mimeHintFromExt(ext) : "",
      ext,
    };
  }
  if (/^https?:\/\//i.test(raw)) {
    const file = isDirectFile(raw);
    if (!file) {
      return {
        kind: "page",
        label: "Page",
        file: false,
        content: "page",
        contentLabel: "Page",
        mime: "text/html",
        ext: "",
      };
    }
    const content = contentKindFromUrl(raw);
    const ext = extensionOfUrl(raw);
    const contentLabel = contentKindLabel(content);
    return {
      kind: "file",
      label: contentLabel === "File" ? "File" : contentLabel,
      file: true,
      content,
      contentLabel,
      mime: mimeHintFromExt(ext),
      ext,
    };
  }
  return {
    kind: "other",
    label: "Link",
    file: false,
    content: "other",
    contentLabel: "Link",
    mime: "",
    ext: "",
  };
}

export function reviewIntake(urls, { isDirectFile, alreadyHave } = {}) {
  const seen = new Set();
  const rows = [];
  for (const url of urls || []) {
    const raw = String(url ?? "").trim();
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    const kind = classifyIntakeUrl(raw, isDirectFile);
    const queued = Boolean(alreadyHave?.(raw));
    rows.push({
      url: raw,
      ...kind,
      queued,
      selected: !queued && kind.file,
    });
  }
  return rows;
}

// "All" and "Files" skip anything already in the list. A manual tick can
// still put one back; the shortcuts should not. Video / Archive / Audio only
// tick that content kind — pages stay off.
export function applyIntakePick(rows, mode) {
  return (rows || []).map((row) => {
    if (row.queued) return { ...row, selected: false };
    if (mode === "none") return { ...row, selected: false };
    if (mode === "all") return { ...row, selected: true };
    if (mode === "files") return { ...row, selected: Boolean(row.file) };
    if (mode === "video" || mode === "archive" || mode === "audio" || mode === "document") {
      return { ...row, selected: row.content === mode };
    }
    return { ...row };
  });
}

export function filterIntake(rows, {
  content = "",
  host = "",
  selectedOnly = false,
  fileOnly = false,
} = {}) {
  const wantHost = String(host || "").trim().toLowerCase();
  const wantContent = String(content || "").trim().toLowerCase();
  return (rows || []).filter((row) => {
    if (selectedOnly && !row.selected) return false;
    if (fileOnly && !row.file) return false;
    if (wantContent && row.content !== wantContent) return false;
    if (wantHost) {
      let rowHost = "";
      try { rowHost = new URL(row.url).hostname.toLowerCase(); } catch { /* ignore */ }
      if (!rowHost.includes(wantHost)) return false;
    }
    return true;
  });
}

export function formatIntakeMeta(row) {
  if (!row) return { kindLabel: "", contentLabel: "", mime: "", host: "" };
  let host = "";
  try { host = new URL(row.url).hostname; } catch { /* ignore */ }
  return {
    kindLabel: row.label || "",
    contentLabel: row.contentLabel || contentKindLabel(row.content),
    mime: row.mime || mimeHintFromExt(row.ext) || "",
    host,
  };
}

export function intakeReviewHint(rows) {
  const list = rows || [];
  if (!list.length) return "";
  const files = list.filter((row) => row.file && !row.queued).length;
  const others = list.filter((row) => !row.file && !row.queued).length;
  const queued = list.filter((row) => row.queued).length;
  const videos = list.filter((row) => row.content === "video" && !row.queued).length;
  const archives = list.filter((row) => row.content === "archive" && !row.queued).length;
  const parts = [];
  if (files && others) {
    const fileBit = files === 1 ? "1 file starts selected" : `${files} files start selected`;
    const otherBit = others === 1
      ? "1 other link stays off until you tick it"
      : `${others} other links stay off until you tick them`;
    parts.push(`${fileBit}. ${otherBit}.`);
  } else if (others) {
    parts.push("None of these name a file yet. Tick the ones you want before they start.");
  } else if (files) {
    parts.push("Every link already names a file. Untick any you do not want.");
  }
  if (videos || archives) {
    const bits = [];
    if (videos) bits.push(videos === 1 ? "1 video" : `${videos} videos`);
    if (archives) bits.push(archives === 1 ? "1 archive" : `${archives} archives`);
    parts.push(`In this dump: ${bits.join(", ")}.`);
  }
  if (queued) parts.push(`${queued} already in the list.`);
  return parts.join(" ");
}

// A batch of related links becomes one package so pause/retry/clear can act
// on the set later. aria2 still owns each gid; the package is app-side only.

export function newPackageId(now = Date.now()) {
  const stamp = Number(now) || Date.now();
  return `pkg-${stamp.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function packageDisplayName({ referrer = "", host = "", count = 0 } = {}) {
  let fromRef = "";
  try { fromRef = referrer ? new URL(referrer).hostname : ""; } catch { /* ignore */ }
  const site = String(fromRef || host || "").replace(/^www\./i, "").trim();
  const n = Math.max(0, Number(count) || 0);
  if (site && n > 1) return `${site} (${n})`;
  if (site) return site;
  if (n > 1) return `Batch of ${n}`;
  return "Package";
}

export function packageSummary(items) {
  const rows = items || [];
  const summary = {
    total: rows.length,
    active: 0,
    waiting: 0,
    paused: 0,
    error: 0,
    complete: 0,
    seeding: 0,
    merging: 0,
  };
  for (const dl of rows) {
    const status = dl?.status;
    if (status && summary[status] !== undefined) summary[status] += 1;
  }
  return summary;
}

export function groupDownloadsByPackage(downloads, packageOfGid) {
  const buckets = new Map();
  const ungrouped = [];
  for (const dl of downloads || []) {
    const pkg = packageOfGid?.(dl?.gid);
    if (!pkg?.id) {
      ungrouped.push(dl);
      continue;
    }
    let bucket = buckets.get(pkg.id);
    if (!bucket) {
      bucket = { id: pkg.id, name: pkg.name || "Package", items: [] };
      buckets.set(pkg.id, bucket);
    }
    bucket.items.push(dl);
  }
  return { packages: [...buckets.values()], ungrouped };
}

// Package-scoped menu verbs. Only offered when the selection shares one
// package, so a mixed selection does not invent a group.
export function packageActions({
  samePackage = false,
  failed = 0,
  active = 0,
  waiting = 0,
  paused = 0,
  completed = 0,
  packageSize = 0,
  selected = 0,
} = {}) {
  if (!samePackage) return [];
  const items = [];
  const size = Math.max(0, Number(packageSize) || 0);
  const picked = Math.max(0, Number(selected) || 0);
  if (size > picked) items.push({ action: "select-package", label: "Select Package" });
  if ((Number(active) || 0) + (Number(waiting) || 0) > 0) {
    items.push({ action: "pause-package", label: "Pause Package" });
  }
  if ((Number(paused) || 0) > 0) {
    items.push({ action: "resume-package", label: "Resume Package" });
  }
  if ((Number(failed) || 0) > 0) {
    items.push({ action: "retry-package", label: "Retry Failed in Package" });
  }
  if ((Number(completed) || 0) > 0) {
    items.push({ action: "clear-package-completed", label: "Clear Completed in Package" });
  }
  return items;
}

// Why a single link is waiting, failed, or blocked — for the row tooltip and
// the detail panel, so a schedule hold and a rate limit read differently.
export function formatWaitReason({
  status = "",
  held = false,
  holdNote = "",
  queueStopped = false,
  scheduleBlocked = false,
  scheduleStartLabel = "",
  errorCode = 0,
  errorMessage = "",
  jobError = "",
} = {}) {
  if (held) {
    if (holdNote) return holdNote;
    return scheduleHoldNote({
      held: true,
      queueStopped,
      scheduleBlocked,
      scheduleStartLabel,
    }) || "held";
  }
  if (status === "waiting") {
    if (queueStopped) return "Queue is stopped — Start Queue to let it run.";
    return "Waiting for a free slot in the queue.";
  }
  if (status === "error") {
    if (Number(errorCode) === 5 || /speed|rate.?limit|throttl/i.test(String(errorMessage || ""))) {
      return "Held behind a speed or rate limit — raise the cap or traffic mode, then retry.";
    }
    const kind = failureKind({ errorCode, errorMessage, jobError });
    const tag = failureCategoryLabel(kind);
    const next = recoveryNextStep({ status: "error", errorCode, errorMessage })
      || formatRecoverableNextStep(errorCode);
    if (tag && next) return `${tag}: ${next}`;
    return next || tag || "Failed — use Retry if the link still works.";
  }
  return "";
}

// What a page can hand over. Embedded media is listed first so a long run of
// navigation links does not bury the file that was actually on screen. The
// page itself is left out, and blob: or data: URLs are not downloads.
export function captureTargetsFromPage({ pageUrl = "", links = [], media = [] } = {}) {
  const page = String(pageUrl || "").split("#")[0];
  const seen = new Set();
  const out = [];
  const push = (value) => {
    const url = String(value ?? "").trim();
    if (!url || url.startsWith("blob:") || url.startsWith("data:")) return;
    if (!(url.startsWith("magnet:") || /^https?:\/\//i.test(url) || /^ftps?:\/\//i.test(url))) return;
    if (page && url.split("#")[0] === page) return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push(url);
  };
  for (const src of media) push(src);
  for (const href of links) push(href);
  return out;
}

// A stable word for the row, beside the percentage. The status cell changes
// every second; this one does not, so Active, Queued, and Done can be scanned
// without reading the bar.
export function formatQueueScan(status, { stalled = false, slow = false, scheduled = false } = {}) {
  if (scheduled) return { key: "scheduled", label: "Scheduled" };
  if (status === "error") return { key: "failed", label: "Failed" };
  if (status === "complete") return { key: "done", label: "Done" };
  if (status === "seeding") return { key: "seeding", label: "Seeding" };
  if (status === "paused") return { key: "paused", label: "Paused" };
  if (status === "waiting") return { key: "queued", label: "Queued" };
  if (status === "merging") return { key: "merging", label: "Merging" };
  if (status === "removed") return { key: "removed", label: "Removed" };
  if (status === "active" && stalled) return { key: "stalled", label: "Stalled" };
  if (status === "active" && slow) return { key: "slow", label: "Slow" };
  if (status === "active") return { key: "active", label: "Active" };
  return { key: "", label: "" };
}

// Housekeeping that is about the whole queue, not only the rows under the
// pointer. Retry All stays hidden when the selection already is the only
// failure — Retry covers that.
export function housekeepingActions({ failed = 0, failedSelected = 0, completed = 0 } = {}) {
  const items = [];
  const failedN = Math.max(0, Number(failed) || 0);
  const selectedN = Math.max(0, Number(failedSelected) || 0);
  const doneN = Math.max(0, Number(completed) || 0);
  if (failedN > 1 || (failedN > 0 && selectedN < failedN)) {
    items.push({ action: "retry-all", label: "Retry All Failed" });
  }
  if (doneN > 0) items.push({ action: "clear-completed", label: "Clear Completed" });
  return items;
}

export function formatRestartResumeNote(sizeLabel) {
  const size = String(sizeLabel || "").trim();
  if (!size) return "";
  return `Resumed after a restart — ${size} were already on disk.`;
}

export function formatMediaOutputName({ title = "", ext = "" } = {}) {
  const base = String(title || "").trim() || "video";
  const kind = String(ext || "").replace(/^\./, "").trim();
  return kind ? `${base}.${kind}` : base;
}

// Split video and audio cannot become one file without ffmpeg. Said in the
// picker, where the missing qualities would otherwise just not be listed.
export function formatUnsupportedMerge({ canMerge = true, bestHeight = 0 } = {}) {
  if (canMerge) return "";
  const best = Number(bestHeight) || 0;
  const tail = best > 0 ? ` — up to ${best}p` : "";
  return (
    `Higher qualities here${tail} arrive as separate video and audio, ` +
    "and the ffmpeg that merges them isn't running — see Settings."
  );
}

export function formatUnplayableMediaNote() {
  return "Nothing on this page can be downloaded as a plain file — it's a live or segmented stream.";
}

export function formatPlaylistRuleNote(ruleId) {
  const id = String(ruleId || "");
  if (id === "best") return "Each video downloads at the tallest quality it has.";
  if (id === "audio") return "Sound only — the picture is left out.";
  const cap = Number(id);
  if (cap > 0) {
    return (
      `Each video downloads at the best quality up to ${cap}p. ` +
      "One with nothing that small still downloads, at its smallest."
    );
  }
  return "";
}

// What to do next, for a torrent whose status is not the whole story.
// Seeding and the queue already have their own sentences.
export function formatTorrentNextStep(dl) {
  if (!dl || !isTorrentDownload(dl)) return "";
  if (dl.status === "error") {
    return "Retry adds it again when a magnet or URL is still on the row.";
  }
  if (dl.status === "active" && isStalled(dl)) {
    return "Leave it running, or pause and resume to ask the trackers again.";
  }
  return "";
}

// aria2 does not say which tracker answered. A connected peer is still the
// only evidence the announce list is doing anything.
export function formatTrackerSummary(peerCount, trackerCount) {
  const n = Math.max(0, Number(trackerCount) || 0);
  if (!n) return "No trackers were announced.";
  const state = trackerStatus(peerCount);
  if (state === "Working") {
    return `${n} tracker${n === 1 ? "" : "s"} · a peer is connected, so the list is reaching someone.`;
  }
  return `${n} tracker${n === 1 ? "" : "s"} · none have a peer connected yet.`;
}

// ── JDownloader parity items 4–7 ─────────────────────────────────────────
// Site rules sit beside logins: credentials stay in netrc/headers; these
// only shape how a URL is added. Grab jobs and templates share one shape so
// a saved link set can be re-run by hand or on a clock.

function hostOfUrl(url) {
  try {
    return new URL(String(url || "").trim()).hostname.replace(/\.+$/, "").toLowerCase();
  } catch {
    return "";
  }
}

export function normalizeSiteHost(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    return new URL(withScheme).hostname.replace(/\.+$/, "").toLowerCase();
  } catch {
    return raw.replace(/^www\./i, "").replace(/\/.*$/, "").toLowerCase();
  }
}

export function siteRuleFor(url, rules = []) {
  const host = hostOfUrl(url);
  if (!host) return null;
  const list = Array.isArray(rules) ? rules : [];
  const exact = list.find((rule) => normalizeSiteHost(rule?.host) === host);
  if (exact) return exact;
  return list.find((rule) => {
    const wanted = normalizeSiteHost(rule?.host);
    return wanted && (host === wanted || host.endsWith(`.${wanted}`));
  }) || null;
}

export function applySiteRuleOptions(baseOptions = {}, rule = null) {
  if (!rule) return { ...baseOptions };
  const options = { ...baseOptions };
  const referrer = String(rule.referrer || "").trim();
  if (referrer && !options.referer) options.referer = referrer;
  const dir = String(rule.defaultDir || "").trim();
  if (dir && !options.dir) options.dir = dir;
  if (rule.alwaysQueue) options.pause = "true";
  const extra = (rule.extraHeaders || [])
    .map((line) => String(line || "").trim())
    .filter(Boolean);
  if (extra.length) {
    const existing = Array.isArray(options.header) ? options.header : [];
    options.header = [...existing, ...extra];
  }
  return options;
}

export function formatSiteRuleSummary(rule) {
  if (!rule) return "";
  const bits = [];
  if (rule.referrer) bits.push("referrer");
  const headers = (rule.extraHeaders || []).filter(Boolean).length;
  if (headers) bits.push(headers === 1 ? "1 header" : `${headers} headers`);
  if (rule.defaultDir) bits.push("folder");
  if (rule.alwaysQueue) bits.push("queue");
  if (rule.qualityRule) bits.push(`quality ${rule.qualityRule}`);
  if (rule.packagePrefix) bits.push("package name");
  return bits.length ? bits.join(" · ") : "No overrides yet";
}

export function moveGidsToPackage(packageList, gids, targetId, { name = "", now = Date.now() } = {}) {
  const moving = [...new Set((gids || []).map(String).filter(Boolean))];
  let packages = (packageList || [])
    .map((pkg) => ({
      id: pkg.id,
      name: pkg.name || "Package",
      gids: (pkg.gids || []).map(String),
      createdAt: Number(pkg.createdAt) || 0,
    }))
    .filter((pkg) => pkg.id);

  for (const pkg of packages) {
    pkg.gids = pkg.gids.filter((gid) => !moving.includes(gid));
  }

  if (targetId === null || targetId === "") {
    return packages.filter((pkg) => pkg.gids.length > 0);
  }

  let target = packages.find((pkg) => pkg.id === targetId);
  if (!target) {
    target = {
      id: targetId === "new" ? newPackageId(now) : String(targetId),
      name: String(name || "Package"),
      gids: [],
      createdAt: Number(now) || Date.now(),
    };
    packages = [target, ...packages];
  } else if (name) {
    target.name = String(name);
  }
  target.gids = [...new Set([...target.gids, ...moving])];
  return packages.filter((pkg) => pkg.gids.length > 0);
}

export function packageExportPayload({ name = "", urls = [], createdAt = Date.now() } = {}) {
  const entries = (urls || []).map((row) => {
    if (typeof row === "string") return { url: row };
    const url = String(row?.url || "").trim();
    if (!url) return null;
    const out = String(row.out || "").trim();
    const dir = String(row.dir || "").trim();
    return {
      url,
      ...(out ? { out } : {}),
      ...(dir ? { dir } : {}),
    };
  }).filter(Boolean);
  return {
    version: 1,
    name: String(name || "Package"),
    urls: entries,
    createdAt: Number(createdAt) || Date.now(),
  };
}

export function packageExportText(payload) {
  const rows = payload?.urls || [];
  return rows.map((row) => (typeof row === "string" ? row : row.url)).filter(Boolean).join("\n");
}

export function parseLinkListText(text) {
  const seen = new Set();
  const urls = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const token = line.split(/\s+/)[0];
    if (!(token.startsWith("magnet:") || /^https?:\/\//i.test(token) || /^ftps?:\/\//i.test(token))) {
      continue;
    }
    if (seen.has(token)) continue;
    seen.add(token);
    urls.push(token);
  }
  return urls;
}

export function normalizeGrabJob(raw = {}) {
  const urls = Array.isArray(raw.urls)
    ? raw.urls.map((u) => String(u || "").trim()).filter(Boolean)
    : [];
  return {
    id: String(raw.id || newPackageId()),
    name: String(raw.name || "Grab").trim() || "Grab",
    urls,
    enabled: raw.enabled !== false,
    every: raw.every === "weekly" ? "weekly" : "daily",
    atMinute: Math.max(0, Math.min(24 * 60 - 1, Number(raw.atMinute) || 0)),
    weekday: Math.max(0, Math.min(6, Number(raw.weekday) || 0)),
    packageName: String(raw.packageName || "").trim(),
    lastRunAt: Number(raw.lastRunAt) || 0,
  };
}

export function grabJobSummary(job) {
  const row = normalizeGrabJob(job);
  const n = row.urls.length;
  const links = n === 1 ? "1 link" : `${n} links`;
  const hh = String(Math.floor(row.atMinute / 60)).padStart(2, "0");
  const mm = String(row.atMinute % 60).padStart(2, "0");
  const when = row.every === "weekly"
    ? `weekly · ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][row.weekday]} ${hh}:${mm}`
    : `daily · ${hh}:${mm}`;
  const state = row.enabled ? when : `paused · ${when}`;
  return `${links} · ${state}`;
}

export function grabJobDue(job, { now = new Date(), lastRunAt } = {}) {
  const row = normalizeGrabJob(job);
  if (!row.enabled || !row.urls.length) return false;
  const stamp = lastRunAt == null ? row.lastRunAt : Number(lastRunAt) || 0;
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) return false;
  if (row.every === "weekly" && current.getDay() !== row.weekday) return false;
  const minute = current.getHours() * 60 + current.getMinutes();
  if (minute < row.atMinute) return false;
  if (!stamp) return true;
  const last = new Date(stamp);
  if (Number.isNaN(last.getTime())) return true;
  if (row.every === "daily") {
    return last.toDateString() !== current.toDateString();
  }
  // Weekly: due once the most recent weekday+time has passed without a run.
  const due = new Date(current);
  due.setSeconds(0, 0);
  due.setHours(Math.floor(row.atMinute / 60), row.atMinute % 60, 0, 0);
  while (due.getDay() !== row.weekday) due.setDate(due.getDate() - 1);
  return last.getTime() < due.getTime();
}

export function normalizeTemplate(raw = {}) {
  const urls = Array.isArray(raw.urls)
    ? raw.urls.map((row) => {
      if (typeof row === "string") return { url: row };
      const url = String(row?.url || "").trim();
      if (!url) return null;
      return {
        url,
        ...(row.out ? { out: String(row.out) } : {}),
        ...(row.dir ? { dir: String(row.dir) } : {}),
      };
    }).filter(Boolean)
    : [];
  return {
    id: String(raw.id || newPackageId()),
    name: String(raw.name || "Template").trim() || "Template",
    urls,
    createdAt: Number(raw.createdAt) || Date.now(),
  };
}

export function templateSummary(template) {
  const row = normalizeTemplate(template);
  const n = row.urls.length;
  return n === 1 ? "1 saved link" : `${n} saved links`;
}

export function rememberedQualityRule(stored, fallback = "best") {
  const value = String(stored || "").trim();
  if (!value) return fallback;
  if (value === "best" || value === "audio") return value;
  const cap = Number(value);
  return Number.isFinite(cap) && cap > 0 ? String(cap) : fallback;
}

export function packageMenuExtras({
  samePackage = false,
  hasPackages = false,
  selected = 0,
} = {}) {
  const items = [];
  const n = Math.max(0, Number(selected) || 0);
  if (n > 0 && (samePackage || hasPackages)) {
    items.push({ action: "move-package", label: "Move to Package…" });
  }
  if (samePackage) {
    items.push({ action: "ungroup-package", label: "Remove from Package" });
    items.push({ action: "copy-package-urls", label: "Copy Package URLs" });
    items.push({ action: "save-package-template", label: "Save as Template" });
  } else if (n > 1) {
    items.push({ action: "new-package", label: "New Package from Selection" });
  }
  return items;
}
