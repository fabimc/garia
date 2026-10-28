import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
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
  FILE_PRIORITY_TIERS,
  classifyIntakeUrl,
  reviewIntake,
  applyIntakePick,
  filterIntake,
  intakeReviewHint,
  formatIntakeMeta,
  contentKindFromUrl,
  mimeHintFromExt,
  captureTargetsFromPage,
  formatQueueScan,
  housekeepingActions,
  formatRestartResumeNote,
  formatMediaOutputName,
  formatUnsupportedMerge,
  formatUnplayableMediaNote,
  formatPlaylistRuleNote,
  formatTorrentNextStep,
  formatTrackerSummary,
  newPackageId,
  packageDisplayName,
  packageSummary,
  groupDownloadsByPackage,
  packageActions,
  packageMenuExtras,
  formatWaitReason,
  siteRuleFor,
  applySiteRuleOptions,
  formatSiteRuleSummary,
  moveGidsToPackage,
  packageExportPayload,
  packageExportText,
  parseLinkListText,
  normalizeGrabJob,
  grabJobSummary,
  grabJobDue,
  normalizeTemplate,
  templateSummary,
  rememberedQualityRule,
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
  assert.deepEqual(FILE_PRIORITY_TIERS.map(formatFilePriorityLabel), ["High", "Normal", "Low", "Off"]);
});

test("bulk intake selects files and leaves pages off", () => {
  const isFile = (url) => /\.(zip|iso)(\?|$)/i.test(url);
  const rows = reviewIntake([
    "https://ex.test/a.zip",
    "https://ex.test/read",
    "magnet:?xt=urn:btih:abc",
    "https://ex.test/a.zip",
    "ftp://files.test/pub/",
    "ftp://files.test/disk.iso",
  ], { isDirectFile: isFile });
  assert.deepEqual(rows.map((row) => [row.kind, row.selected]), [
    ["file", true],
    ["page", false],
    ["magnet", true],
    ["ftp", false],
    ["ftp-file", true],
  ]);
  assert.equal(classifyIntakeUrl("https://ex.test/a.zip", isFile).label, "Archive");
  assert.equal(classifyIntakeUrl("https://ex.test/a.zip", isFile).content, "archive");
  assert.equal(classifyIntakeUrl("https://ex.test/a.zip", isFile).mime, "application/zip");
  assert.match(intakeReviewHint(rows), /3 files start selected/);
  assert.match(intakeReviewHint(rows), /2 other links stay off/);
  assert.match(intakeReviewHint(rows), /archives/);
  assert.match(
    intakeReviewHint([{ file: true, queued: false }, { file: false, queued: false }]),
    /1 file starts selected\. 1 other link stays off/,
  );
});

test("intake content kinds and filters name video and archive links", () => {
  assert.equal(contentKindFromUrl("https://cdn.test/clip.mp4"), "video");
  assert.equal(contentKindFromUrl("https://cdn.test/pack.zip"), "archive");
  assert.equal(mimeHintFromExt("mp4"), "video/mp4");
  const isFile = (url) => /\.(mp4|zip|pdf)(\?|$)/i.test(url);
  const rows = reviewIntake([
    "https://cdn.test/clip.mp4",
    "https://cdn.test/pack.zip",
    "https://cdn.test/notes.pdf",
    "https://cdn.test/about",
  ], { isDirectFile: isFile });
  assert.deepEqual(rows.map((row) => row.content), ["video", "archive", "document", "page"]);
  assert.deepEqual(applyIntakePick(rows, "video").map((row) => row.selected), [true, false, false, false]);
  assert.deepEqual(applyIntakePick(rows, "archive").map((row) => row.selected), [false, true, false, false]);
  assert.equal(filterIntake(rows, { content: "video" }).length, 1);
  assert.equal(filterIntake(rows, { host: "cdn.test", fileOnly: true }).length, 3);
  assert.equal(formatIntakeMeta(rows[0]).mime, "video/mp4");
  assert.equal(formatIntakeMeta(rows[0]).contentLabel, "Video");
});

test("a link already in the list stays unticked, including All and Files", () => {
  const rows = reviewIntake(
    ["https://ex.test/a.zip", "https://ex.test/b.zip"],
    { isDirectFile: () => true, alreadyHave: (url) => url.endsWith("a.zip") },
  );
  assert.equal(rows[0].selected, false);
  assert.equal(rows[0].queued, true);
  assert.deepEqual(applyIntakePick(rows, "all").map((row) => row.selected), [false, true]);
  assert.deepEqual(applyIntakePick(rows, "files").map((row) => row.selected), [false, true]);
  assert.deepEqual(applyIntakePick(rows, "none").map((row) => row.selected), [false, false]);
  assert.match(intakeReviewHint(rows), /already in the list/);
});

test("packages group related downloads and offer scoped actions", () => {
  const id = newPackageId(1);
  assert.match(id, /^pkg-/);
  assert.equal(packageDisplayName({ host: "www.cdn.test", count: 4 }), "cdn.test (4)");
  assert.equal(packageDisplayName({ count: 3 }), "Batch of 3");
  const downloads = [
    { gid: "a", status: "active" },
    { gid: "b", status: "error" },
    { gid: "c", status: "complete" },
    { gid: "d", status: "waiting" },
  ];
  const map = {
    a: { id: "p1", name: "cdn.test (3)" },
    b: { id: "p1", name: "cdn.test (3)" },
    c: { id: "p1", name: "cdn.test (3)" },
  };
  const grouped = groupDownloadsByPackage(downloads, (gid) => map[gid]);
  assert.equal(grouped.packages.length, 1);
  assert.equal(grouped.packages[0].items.length, 3);
  assert.equal(grouped.ungrouped.length, 1);
  assert.deepEqual(packageSummary(grouped.packages[0].items), {
    total: 3, active: 1, waiting: 0, paused: 0, error: 1, complete: 1, seeding: 0, merging: 0,
  });
  assert.deepEqual(
    packageActions({
      samePackage: true,
      failed: 1,
      active: 1,
      waiting: 0,
      paused: 0,
      completed: 1,
      packageSize: 3,
      selected: 1,
    }).map((item) => item.action),
    ["select-package", "pause-package", "retry-package", "clear-package-completed"],
  );
  assert.deepEqual(packageActions({ samePackage: false, failed: 2 }), []);
});

test("wait reasons distinguish queue, schedule, and failure", () => {
  assert.match(formatWaitReason({ status: "waiting", queueStopped: true }), /Queue is stopped/);
  assert.match(formatWaitReason({ status: "waiting" }), /free slot/);
  assert.equal(formatWaitReason({ held: true, holdNote: "starts Fri 9:00" }), "starts Fri 9:00");
  assert.match(formatWaitReason({ status: "error", errorCode: 24 }), /Login/);
  assert.match(formatWaitReason({ status: "error", errorCode: 5 }), /speed|cap|traffic/i);
});

test("site rules match host and merge options onto an add", () => {
  const rules = [
    { host: "cdn.example", referrer: "https://cdn.example/", extraHeaders: ["X-Token: a"], alwaysQueue: true },
    { host: "files.example.com", defaultDir: "/Downloads/Files", qualityRule: "1080" },
  ];
  assert.equal(siteRuleFor("https://cdn.example/a.zip", rules).host, "cdn.example");
  assert.equal(siteRuleFor("https://mirror.cdn.example/a.zip", rules).host, "cdn.example");
  assert.equal(siteRuleFor("https://other.test/a.zip", rules), null);
  const options = applySiteRuleOptions({ dir: "/tmp" }, rules[0]);
  assert.equal(options.dir, "/tmp");
  assert.equal(options.referer, "https://cdn.example/");
  assert.equal(options.pause, "true");
  assert.deepEqual(options.header, ["X-Token: a"]);
  assert.match(formatSiteRuleSummary(rules[1]), /folder/);
  assert.match(formatSiteRuleSummary(rules[1]), /1080/);
});

test("packages can move, export, and become templates", () => {
  const start = [
    { id: "p1", name: "One", gids: ["a", "b"], createdAt: 1 },
    { id: "p2", name: "Two", gids: ["c"], createdAt: 2 },
  ];
  const moved = moveGidsToPackage(start, ["a", "c"], "p2");
  assert.deepEqual(moved.find((p) => p.id === "p1").gids, ["b"]);
  assert.deepEqual(moved.find((p) => p.id === "p2").gids.sort(), ["a", "c"]);
  assert.deepEqual(moveGidsToPackage(moved, ["a"], null).find((p) => p.id === "p2").gids, ["c"]);
  const payload = packageExportPayload({
    name: "Dump",
    urls: ["https://a.test/x.zip", { url: "https://a.test/y.mp4", out: "clip.mp4" }],
  });
  assert.equal(payload.version, 1);
  assert.equal(payload.urls[1].out, "clip.mp4");
  assert.equal(packageExportText(payload), "https://a.test/x.zip\nhttps://a.test/y.mp4");
  assert.deepEqual(
    parseLinkListText("# note\nhttps://a.test/x.zip\nhttps://a.test/x.zip\nnot-a-url"),
    ["https://a.test/x.zip"],
  );
  assert.equal(templateSummary(normalizeTemplate(payload)), "2 saved links");
  assert.deepEqual(
    packageMenuExtras({ samePackage: true, hasPackages: true, selected: 2 }).map((i) => i.action),
    ["move-package", "ungroup-package", "copy-package-urls", "save-package-template"],
  );
});

test("grab jobs fire once per day or week after their minute", () => {
  const job = normalizeGrabJob({
    name: "Nightly",
    urls: ["https://a.test/a.zip"],
    every: "daily",
    atMinute: 2 * 60,
    lastRunAt: 0,
  });
  assert.match(grabJobSummary(job), /1 link/);
  assert.match(grabJobSummary(job), /daily/);
  const morning = new Date("2026-10-28T01:00:00");
  const evening = new Date("2026-10-28T03:00:00");
  assert.equal(grabJobDue(job, { now: morning }), false);
  assert.equal(grabJobDue(job, { now: evening }), true);
  assert.equal(grabJobDue(job, { now: evening, lastRunAt: evening.getTime() }), false);
  const weekly = normalizeGrabJob({ ...job, every: "weekly", weekday: 3 }); // Wed
  assert.equal(grabJobDue(weekly, { now: evening }), true); // 2026-10-28 is Wed
  assert.equal(grabJobDue(weekly, { now: new Date("2026-10-29T03:00:00") }), false);
  assert.equal(rememberedQualityRule("720"), "720");
  assert.equal(rememberedQualityRule(""), "best");
  assert.equal(rememberedQualityRule("nope"), "best");
});

test("the extension collector matches the shared page-capture helper", () => {
  const source = readFileSync(new URL("../extensions/garia/file-types.js", import.meta.url), "utf8");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const sample = {
    pageUrl: "https://ex.test/watch#part",
    links: ["https://ex.test/watch", "https://ex.test/next", "blob:https://ex.test/x"],
    media: ["https://cdn.test/clip.mp4", "https://ex.test/next"],
  };
  assert.equal(
    JSON.stringify(sandbox.gariaCaptureTargets(sample)),
    JSON.stringify(captureTargetsFromPage(sample)),
  );
});

test("page capture lists embedded media before links and drops the page itself", () => {
  const urls = captureTargetsFromPage({
    pageUrl: "https://ex.test/watch",
    links: [
      "https://ex.test/watch",
      "https://ex.test/watch#top",
      "https://ex.test/next",
      "blob:https://ex.test/clip",
      "magnet:?xt=urn:btih:abc",
    ],
    media: ["https://cdn.test/clip.mp4", "https://ex.test/next"],
  });
  assert.deepEqual(urls, [
    "https://cdn.test/clip.mp4",
    "https://ex.test/next",
    "magnet:?xt=urn:btih:abc",
  ]);
});

test("queue scan words stay stable across progress", () => {
  assert.deepEqual(formatQueueScan("active"), { key: "active", label: "Active" });
  assert.equal(formatQueueScan("waiting").label, "Queued");
  assert.equal(formatQueueScan("complete").label, "Done");
  assert.equal(formatQueueScan("error").label, "Failed");
  assert.equal(formatQueueScan("active", { stalled: true }).label, "Stalled");
  assert.equal(formatQueueScan("active", { slow: true }).label, "Slow");
  assert.equal(formatQueueScan("active", { scheduled: true }).label, "Scheduled");
});

test("housekeeping offers retry-all and clear-completed only when they do something", () => {
  assert.deepEqual(housekeepingActions({ failed: 1, failedSelected: 1, completed: 0 }), []);
  assert.deepEqual(
    housekeepingActions({ failed: 1, failedSelected: 0, completed: 2 }).map((item) => item.action),
    ["retry-all", "clear-completed"],
  );
  assert.equal(housekeepingActions({ failed: 3, failedSelected: 3 })[0].label, "Retry All Failed");
});

test("a restart says how much was already on disk", () => {
  assert.equal(formatRestartResumeNote(""), "");
  assert.match(formatRestartResumeNote("12.0 MB"), /Resumed after a restart — 12.0 MB/);
});

test("media output names and merge gaps say what the file will be", () => {
  assert.equal(formatMediaOutputName({ title: "Talk", ext: "mkv" }), "Talk.mkv");
  assert.equal(formatMediaOutputName({ title: "", ext: "" }), "video");
  assert.equal(formatUnsupportedMerge({ canMerge: true, bestHeight: 1080 }), "");
  assert.match(formatUnsupportedMerge({ canMerge: false, bestHeight: 2160 }), /2160p/);
  assert.match(formatUnsupportedMerge({ canMerge: false, bestHeight: 2160 }), /ffmpeg/i);
  assert.match(formatUnplayableMediaNote(), /live or segmented/);
  assert.match(formatPlaylistRuleNote("best"), /tallest/);
  assert.match(formatPlaylistRuleNote("720"), /720p/);
  assert.match(formatPlaylistRuleNote("audio"), /Sound only/);
  assert.equal(formatPlaylistRuleNote(""), "");
});

test("a stalled or failed torrent says what to do next", () => {
  const stalled = {
    bittorrent: {},
    status: "active",
    totalLength: "100",
    completedLength: "10",
    downloadSpeed: "0",
    connections: "0",
  };
  assert.match(formatTorrentNextStep(stalled), /pause and resume/i);
  assert.match(formatTorrentNextStep({ bittorrent: {}, status: "error" }), /Retry/);
  assert.equal(formatTorrentNextStep({ status: "error" }), "");
  assert.match(formatTrackerSummary(0, 2), /none have a peer/);
  assert.match(formatTrackerSummary(3, 1), /reaching someone/);
  assert.match(formatTrackerSummary(0, 0), /No trackers/);
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
