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

export function priorityDisplay(value) {
  const tier = normalizePriority(value);
  if (tier === "off") return "Off";
  if (tier === "high") return "High";
  if (tier === "low") return "Low";
  return "Normal";
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
