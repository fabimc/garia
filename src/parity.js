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
    sub: `Drag a URL or .torrent file anywhere, copy a file link, or hit ${modNHint}`,
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
