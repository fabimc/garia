import assert from "node:assert/strict";
import test from "node:test";
import {
  bulkPriorityMap,
  desiredIndices,
  failureCategoryLabel,
  failureKind,
  indicesDiffer,
  isSlowDownload,
  isStalled,
  isTorrentDownload,
  leechersOf,
  parseChecksum,
  parseKilobytes,
  pickByRule,
  placeInQueue,
  prioritiesNeedAdvance,
  priorityDisplay,
  prioritySummary,
  recoveryNextStep,
  sameOrder,
  scheduleHoldNote,
  seedUntilLabel,
  selectedIndicesOf,
  splitChecksum,
  torrentHealth,
  trackerRows,
  trackerStatus,
  formatEmptyQueueState,
  formatRecoverableNextStep,
  formatFfmpegMergeLine,
  formatCaptureFlowHint,
  formatMediaQualityLabel,
  formatTorrentStateMessage,
  formatDetailBadge,
  formatFilePriorityLabel,
} from "./parity.js";

test("a torrent is recognised by its metainfo or its info hash", () => {
  assert.equal(isTorrentDownload({ bittorrent: { info: { name: "a" } } }), true);
  assert.equal(isTorrentDownload({ infoHash: "abc" }), true);
  assert.equal(isTorrentDownload({ gid: "1" }), false);
  assert.equal(isTorrentDownload(null), false);
});

test("high files are requested before normal and low", () => {
  const files = [
    { index: 1, length: 10, completedLength: 0, priority: "high" },
    { index: 2, length: 10, completedLength: 0, priority: "normal" },
    { index: 3, length: 10, completedLength: 0, priority: "low" },
    { index: 4, length: 10, completedLength: 0, priority: "off" },
  ];
  assert.deepEqual(desiredIndices(files), [1]);
  files[0].completedLength = 10;
  // A finished high file stays selected so aria2 does not drop it.
  assert.deepEqual(desiredIndices(files), [1, 2]);
  files[1].completedLength = 10;
  assert.deepEqual(desiredIndices(files), [1, 2, 3]);
});

test("an unfinished high file keeps the later tiers waiting", () => {
  const files = [
    { index: 1, length: 10, completedLength: 4, priority: "high" },
    { index: 2, length: 10, completedLength: 0, priority: "normal" },
  ];
  assert.deepEqual(desiredIndices(files), [1]);
  assert.equal(prioritiesNeedAdvance(files), true);
  assert.equal(prioritiesNeedAdvance([{ priority: "normal" }]), false);
});

test("a file with no size yet is not treated as finished", () => {
  const files = [
    { index: 1, length: 0, completedLength: 0, priority: "high" },
    { index: 2, length: 10, completedLength: 0, priority: "normal" },
  ];
  assert.deepEqual(desiredIndices(files), [1]);
});

test("selected indices ignore files aria2 has skipped", () => {
  const files = [
    { index: 2, selected: "true" },
    { index: 1, selected: "false" },
    { index: 3, selected: true },
    { index: 4, selected: false },
  ];
  assert.deepEqual(selectedIndicesOf(files), [2, 3]);
  assert.equal(indicesDiffer([2, 3], [2, 3]), false);
  assert.equal(indicesDiffer([1], [2, 3]), true);
  assert.equal(prioritiesNeedAdvance([{ priority: "normal" }]), false);
  assert.equal(prioritiesNeedAdvance([{ priority: false }]), false);
});

test("health is judged from the peers aria2 has actually reached", () => {
  assert.equal(torrentHealth({ seeders: 6, peers: 6 }).label, "Healthy");
  assert.equal(torrentHealth({ seeders: 2, peers: 4 }).label, "Healthy");
  assert.equal(torrentHealth({ seeders: 1, peers: 1 }).label, "OK");
  assert.equal(torrentHealth({ seeders: 0, peers: 3, leechers: 3 }).label, "Weak");
  assert.equal(torrentHealth().label, "No peers");
  assert.match(torrentHealth({ seeders: 1, leechers: 2, peers: 3 }).title, /1 seeds/);
});

test("leechers come from the peer list, or from connections minus seeds", () => {
  assert.equal(leechersOf({
    peers: [{ seeder: "true" }, { seeder: "false" }, { seeder: "false" }],
  }), 2);
  assert.equal(leechersOf({ connections: 5, seeders: 2 }), 3);
  assert.equal(leechersOf({ connections: 1, seeders: 4 }), 0);
});

test("stalled is a torrent with somewhere left to go and nobody on it", () => {
  const base = {
    bittorrent: {},
    status: "active",
    totalLength: "100",
    completedLength: "10",
    downloadSpeed: "0",
    connections: "0",
  };
  assert.equal(isStalled(base), true);
  assert.equal(isStalled({ ...base, downloadSpeed: "1" }), false);
  assert.equal(isStalled({ ...base, connections: "2" }), false);
  assert.equal(isStalled({ ...base, totalLength: "0" }), false);
  assert.equal(isStalled({ ...base, seeder: "true" }), false);
  assert.equal(isStalled({ ...base, status: "paused" }), false);
  assert.equal(isStalled({ gid: "1", status: "active", totalLength: "100", completedLength: "1" }), false);
});

test("seed until names the rule that will stop a torrent", () => {
  assert.equal(seedUntilLabel(1.5, 0), "Seed until ratio 1.5×");
  assert.equal(seedUntilLabel(0, 30), "Seed until 30 min");
  assert.equal(seedUntilLabel(2, 90), "Seed until ratio 2× or 90 min");
  assert.equal(seedUntilLabel(0, 0), "Seed until you stop it");
});

test("move to top and move to end keep the relative order of the selection", () => {
  const order = ["a", "b", "c", "d"];
  assert.deepEqual(placeInQueue(order, ["c", "a"], "top"), ["a", "c", "b", "d"]);
  assert.deepEqual(placeInQueue(order, ["b"], "end"), ["a", "c", "d", "b"]);
  assert.equal(sameOrder(order, placeInQueue(order, ["a"], "top")), true);
  assert.equal(sameOrder(order, placeInQueue(order, ["d"], "end")), true);
  assert.deepEqual(placeInQueue(order, [], "top"), order);
});

test("tracker rows flatten announce tiers and status follows connected peers", () => {
  assert.deepEqual(trackerRows([["http://a"], ["udp://b", "http://c"]]), [
    { tier: 1, url: "http://a" },
    { tier: 2, url: "udp://b" },
    { tier: 2, url: "http://c" },
  ]);
  assert.deepEqual(trackerRows(null), []);
  assert.equal(trackerStatus(0), "Waiting");
  assert.equal(trackerStatus(3), "Working");
});

test("a custom cap is kilobytes per second, and a blank field clears it", () => {
  assert.equal(parseKilobytes(""), 0);
  assert.equal(parseKilobytes("  1.5 "), 1536);
  assert.equal(parseKilobytes("0"), 0);
  assert.equal(parseKilobytes("-1"), null);
  assert.equal(parseKilobytes("fast"), null);
});

test("schedule hold notes name the reason a row is waiting", () => {
  assert.equal(scheduleHoldNote({ held: false }), "");
  assert.equal(scheduleHoldNote({ held: true, startAtLabel: "3:00 PM" }), "starts 3:00 PM");
  assert.equal(scheduleHoldNote({ held: true, queueStopped: true }), "Queue stopped");
  assert.equal(
    scheduleHoldNote({ held: true, scheduleBlocked: true, scheduleStartLabel: "2:00 AM" }),
    "starts 2:00 AM",
  );
});

test("failure kinds group aria2 and merge errors for the UI", () => {
  assert.equal(failureKind({ errorCode: 32 }), "checksum");
  assert.equal(failureKind({ errorCode: 24 }), "auth");
  assert.equal(failureKind({ errorCode: 6 }), "network");
  assert.equal(failureKind({ jobError: "ffmpeg missing" }), "media");
  assert.equal(failureCategoryLabel("checksum"), "Checksum");
  assert.equal(failureCategoryLabel(""), "");
});

test("checksum parsing matches aria2's accepted forms", () => {
  const parsed = parseChecksum("sha256=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789");
  assert.equal(parsed.spec, "sha-256=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789");
  assert.deepEqual(splitChecksum(parsed.spec)?.algo, "sha-256");
  assert.ok(parseChecksum("not-a-hash")?.error);
});

test("playlist rules pick the tallest quality inside the cap", () => {
  const choices = [
    { label: "1080p" },
    { label: "720p" },
    { label: "Audio" },
  ];
  assert.equal(pickByRule(choices, "best").label, "1080p");
  assert.equal(pickByRule(choices, "720").label, "720p");
  assert.equal(pickByRule(choices, "480").label, "720p");
  assert.equal(pickByRule(choices, "audio").label, "Audio");
});

test("priority labels match the detail panel wording", () => {
  assert.equal(priorityDisplay("high"), "High");
  assert.equal(priorityDisplay("off"), "Off");
  assert.equal(priorityDisplay(false), "Normal");
});

test("empty queue copy follows filter and connection state", () => {
  const fresh = formatEmptyQueueState({ modNHint: "⌘N" });
  assert.equal(fresh.title, "No downloads yet");
  assert.match(fresh.sub, /⌘N/);
  assert.equal(formatEmptyQueueState({ filter: "torrents", hasAnyDownloads: true }).title, "No torrents");
  assert.equal(formatEmptyQueueState({ connError: true }).title, "Can't reach aria2");
});

test("recoverable failures name a next step", () => {
  assert.match(formatRecoverableNextStep(24), /Settings/i);
  assert.match(formatRecoverableNextStep(32), /checksum/i);
  assert.match(formatRecoverableNextStep(0), /Retry/i);
});

test("ffmpeg merge line reflects bundled vs missing", () => {
  assert.match(formatFfmpegMergeLine({ hasFfmpeg: false }), /missing/i);
  assert.match(formatFfmpegMergeLine({ hasFfmpeg: true, ffmpegSource: "bundled" }), /ships/i);
});

test("capture hints name the source", () => {
  assert.match(formatCaptureFlowHint("clipboard"), /copied/i);
  assert.match(formatCaptureFlowHint("extension"), /browser/i);
});

test("media quality labels combine resolution and format", () => {
  assert.equal(formatMediaQualityLabel({ height: 1080, ext: "mp4" }), "1080p · mp4");
});

test("torrent state messages cover stall and queue", () => {
  const stalled = {
    bittorrent: {},
    status: "active",
    totalLength: "100",
    completedLength: "10",
    downloadSpeed: "0",
    connections: "0",
  };
  assert.match(formatTorrentStateMessage(stalled), /Stalled/i);
  assert.match(formatTorrentStateMessage({ status: "waiting" }), /Queued/i);
});

test("detail badges distinguish torrent, video, and http", () => {
  assert.equal(formatDetailBadge({ bittorrent: {} }), "Torrent");
  assert.equal(formatDetailBadge({ job: {} }), "Video");
  assert.equal(formatDetailBadge({ gid: "1" }), "HTTP");
});

test("file priority labels match the tier names in the UI", () => {
  assert.equal(formatFilePriorityLabel("high"), "High");
  assert.equal(formatFilePriorityLabel(false), "Normal");
});

test("slow is active with peers but almost no speed", () => {
  const base = {
    bittorrent: {},
    status: "active",
    totalLength: "1000",
    completedLength: "100",
    downloadSpeed: "512",
    connections: "3",
  };
  assert.equal(isSlowDownload(base), true);
  assert.equal(isSlowDownload({ ...base, downloadSpeed: "2048" }), false);
  assert.equal(isSlowDownload({ ...base, connections: "0" }), false);
});

test("priority summary names the tier still waiting", () => {
  const files = [
    { index: 1, length: 10, completedLength: 10, priority: "high" },
    { index: 2, length: 10, completedLength: 0, priority: "normal" },
  ];
  // Only default Normal left pending — not a custom layout.
  assert.equal(prioritySummary(files), null);
  files[0].completedLength = 0;
  assert.equal(prioritySummary(files)?.label, "High first");
  // Mix of Normal and Low (no High) is custom.
  files[0].priority = "low";
  assert.equal(prioritySummary(files)?.label, "Custom files");
});

test("bulk priority maps every file or only checked ones", () => {
  const files = [
    { index: 1, priority: "normal" },
    { index: 2, priority: "normal" },
  ];
  assert.deepEqual(bulkPriorityMap(files, "all-high"), { 1: "high", 2: "high" });
  assert.deepEqual(bulkPriorityMap(files, "checked-low", [2]), { 1: "normal", 2: "low" });
});

test("recovery hints name a next step for common errors", () => {
  assert.match(recoveryNextStep({ status: "error", errorCode: "24" }), /Settings/i);
  assert.match(recoveryNextStep({ status: "error", errorCode: "9" }), /disk/i);
  assert.equal(recoveryNextStep({ status: "active" }), "");
});
