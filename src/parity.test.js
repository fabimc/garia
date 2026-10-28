import assert from "node:assert/strict";
import test from "node:test";
import {
  desiredIndices,
  indicesDiffer,
  isStalled,
  isTorrentDownload,
  leechersOf,
  parseKilobytes,
  placeInQueue,
  prioritiesNeedAdvance,
  sameOrder,
  seedUntilLabel,
  selectedIndicesOf,
  torrentHealth,
  trackerRows,
  trackerStatus,
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
