import test from "node:test";
import assert from "node:assert/strict";
import { historyState, reconcileHistory, historyRows, forgetHistory, createHistoryGuard, purgeHistoryResults } from "./history.js";
import { collapseMagnetDownloads } from "./parity.js";

const file = (gid, status = "complete") => ({
  gid, status, totalLength: "10", completedLength: "10",
  files: [{ path: `/downloads/${gid}`, uris: [{ uri: `https://example.test/${gid}` }] }],
});

test("completed history survives serialization, live rows win, and clearing leaves files alone", () => {
  const row = file("one");
  let state = reconcileHistory(null, [row], [row], new Map());
  state = historyState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(historyRows(state, []), [state.rows[0]]);
  const live = { ...row, status: "active", completedLength: "2" };
  assert.deepEqual(historyRows(state, [live]), [live]);
  state = reconcileHistory(state, [live], [live], new Map());
  assert.deepEqual(state.rows, []);
  state = reconcileHistory(state, [row], [row], new Map());
  assert.deepEqual(forgetHistory(state, ["one"]), { rows: [], parts: [] });
  assert.equal(row.files[0].path, "/downloads/one");
});

test("seeding is retained as complete history without replacing its live row", () => {
  const seed = { ...file("torrent", "seeding"), seeder: "true", uploadLength: "11" };
  const state = reconcileHistory(null, [seed], [seed], new Map());
  assert.equal(historyRows(state, [seed])[0].status, "seeding");
  assert.equal(historyRows(state, [])[0].status, "complete");
  const stopped = { ...seed, status: "complete", seeder: "false" };
  assert.equal(reconcileHistory(state, [stopped], [stopped], new Map()).rows.length, 1);
});

test("magnet metadata handoff is never recorded as a completion", () => {
  const parent = { ...file("meta"), followedBy: ["torrent"], files: [{ path: "/downloads/[METADATA]abc.torrent" }] };
  const child = { ...file("torrent", "active"), following: "meta" };
  const rows = collapseMagnetDownloads([parent, child]).rows;
  assert.deepEqual(reconcileHistory(null, [parent, child], rows, new Map()).rows, []);
});

test("finished merge halves survive restart without becoming visible history", () => {
  const jobs = new Map([["video", { audioGid: "audio", state: "downloading" }]]);
  const raw = [file("video"), file("audio")];
  let state = reconcileHistory(null, raw, [{ gid: "video", status: "merging" }], jobs);
  assert.equal(state.rows.length, 0);
  state = historyState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(state.parts.map((p) => p.gid), ["video", "audio"]);
  const merged = { ...file("video"), job: { audioGid: "audio", state: "done", outPath: "/downloads/merged.mp4" } };
  state = reconcileHistory(state, [], [merged], jobs);
  assert.equal(state.rows.length, 1);
  assert.deepEqual(state.parts, []);
  assert.equal(state.rows[0].job.outPath, "/downloads/merged.mp4");
  assert.deepEqual(forgetHistory(state, ["video", "audio"]).rows, []);
});

test("invalid saved history is not silently treated as empty", () => {
  assert.throws(() => historyState({ rows: "broken", parts: [] }), /Invalid/);
});

test("in-flight polls are invalidated across a clear and new polls wait for it", async () => {
  const guard = createHistoryGuard();
  let state = historyState(null);
  const before = guard.version();
  const finish = guard.begin(["one"]);
  const during = guard.version();
  let waiting = true;
  const nextPoll = guard.waitAll().then(() => { waiting = false; });
  await Promise.resolve();
  assert.equal(waiting, true);
  state = forgetHistory(reconcileHistory(state, [file("one")], [file("one")], new Map()), ["one"]);
  finish();
  await nextPoll;
  if (guard.current(before)) state = reconcileHistory(state, [file("one")], [file("one")], new Map());
  assert.equal(guard.current(during), false);
  assert.deepEqual(state.rows, []);
  assert.equal(guard.current(guard.version()), true);
});

test("mux completion waits for removal and only saves the original surviving job", async () => {
  for (const removed of [true, false]) {
    const guard = createHistoryGuard();
    const job = { audioGid: "audio", state: "muxing" };
    const jobs = new Map([["video", job]]);
    let state = historyState(null);
    const finish = guard.begin(["video"]);
    const complete = (async () => {
      while (guard.removing("video")) await guard.wait("video");
      if (jobs.get("video") !== job) return;
      state = reconcileHistory(state, [], [{ ...file("video"), job: { ...job, state: "done" } }], jobs);
    })();
    await Promise.resolve();
    assert.deepEqual(state.rows, []);
    if (removed) jobs.delete("video");
    finish();
    await complete;
    assert.equal(state.rows.length, removed ? 0 : 1);
  }
});

test("purging probes all gids, accepts only confirmed missing results and retains failures", async () => {
  const calls = [];
  const batch = async (requests) => {
    calls.push(requests);
    return requests.map(([method, [gid]]) => {
      if (method === "aria2.removeDownloadResult") {
        return gid === "outside-cap" ? { result: "OK" } : { error: "purge failed" };
      }
      if (gid === "missing") return { error: "No such download for GID#missing" };
      if (gid === "missing-real") return { error: "GID#missing-real is not found" };
      if (gid === "offline") return { error: "connection failed" };
      return { result: { status: "active" } };
    });
  };
  const result = await purgeHistoryResults(
    ["outside-cap", "missing", "missing-real", "offline", "active"], batch, async () => {},
  );
  assert.deepEqual(result.left, ["offline", "active"]);
  assert.deepEqual(calls[0].map(([, [gid]]) => gid), ["outside-cap", "missing", "missing-real", "offline", "active"]);
});
