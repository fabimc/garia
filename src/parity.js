// Decisions behind the uTorrent-parity controls. Kept here so the list, the
// detail panel, and the tests agree on what "stalled", "healthy", and "high
// priority" mean. aria2 has no per-file piece priority and no tracker status,
// so the rules below are the closest honest reading of those ideas.

const TIER = ["high", "normal", "low"];

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
      priority: file.priority || "normal",
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
  return (files || []).some((file) => file.priority && file.priority !== "normal");
}

export function indicesDiffer(current, wanted) {
  const a = current || [];
  const b = wanted || [];
  return a.length !== b.length || a.some((n, i) => n !== b[i]);
}

export function selectedIndicesOf(files) {
  return (files || [])
    .filter((file) => file.selected !== "false")
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
