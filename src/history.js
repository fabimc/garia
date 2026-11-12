import { announcesCompletion } from "./parity.js";

export function historyState(value) {
  if (value != null && (!Array.isArray(value.rows) || !Array.isArray(value.parts))) {
    throw new Error("Invalid download history");
  }
  const valid = (rows) => Array.isArray(rows)
    ? rows.filter((row) => row && typeof row.gid === "string" && row.gid)
    : [];
  return { rows: valid(value?.rows), parts: valid(value?.parts) };
}

// Keep finished merge halves out of visible history but available for folding.
export function reconcileHistory(history, raw, rows, jobs, removing = new Set()) {
  const state = historyState(history);
  const saved = new Map(state.rows.map((row) => [row.gid, row]));
  const parts = new Map(state.parts.map((row) => [row.gid, row]));
  const jobGids = new Set();
  for (const [gid, job] of jobs) {
    jobGids.add(gid);
    if (job.audioGid) jobGids.add(job.audioGid);
  }
  for (const gid of parts.keys()) if (!jobGids.has(gid)) parts.delete(gid);
  for (const dl of raw) {
    if (!jobGids.has(dl.gid)) continue;
    if (dl.status === "complete") parts.set(dl.gid, dl);
    else parts.delete(dl.gid);
  }
  for (const dl of rows) {
    if (removing.has(dl.gid)) continue;
    if (announcesCompletion(dl)) {
      const completed = {
        ...dl, status: "complete", seeder: "false",
        downloadSpeed: "0", uploadSpeed: "0", connections: "0",
      };
      if (dl.status === "seeding" && saved.has(dl.gid)) {
        completed.uploadLength = saved.get(dl.gid).uploadLength;
      }
      saved.set(dl.gid, completed);
      if (dl.job?.state === "done") {
        parts.delete(dl.gid);
        parts.delete(dl.job.audioGid);
      }
    } else {
      saved.delete(dl.gid);
    }
  }
  return { rows: [...saved.values()], parts: [...parts.values()] };
}

export function historyRows(history, liveRows) {
  const live = new Set(liveRows.map((row) => row.gid));
  return [...liveRows, ...historyState(history).rows.filter((row) => !live.has(row.gid))];
}

export function forgetHistory(history, gids) {
  const removed = new Set(gids);
  const state = historyState(history);
  return {
    rows: state.rows.filter((row) => !removed.has(row.gid)),
    parts: state.parts.filter((row) => !removed.has(row.gid)),
  };
}

// Invalidate polls on both sides of a removal, including polls started while
// aria2 is still processing it. Muxes wait for the removal's outcome.
export function createHistoryGuard() {
  let generation = 0;
  const pending = new Map();
  return {
    version: () => pending.size ? null : generation,
    current: (version) => version === generation,
    removing: (gid) => pending.has(gid),
    begin(gids) {
      generation++;
      let resolve;
      const done = new Promise((r) => { resolve = r; });
      for (const gid of gids) pending.set(gid, done);
      return () => {
        generation++;
        for (const gid of gids) if (pending.get(gid) === done) pending.delete(gid);
        resolve();
      };
    },
    async wait(gid) {
      while (pending.has(gid)) await pending.get(gid);
    },
    async waitAll() {
      while (pending.size) await Promise.all([...pending.values()]);
    },
  };
}

// A result outside tellStopped's window may still exist. Only an explicit
// tellStatus "not found" response proves a failed purge is already complete.
export async function purgeHistoryResults(gids, batch, delay) {
  let left = [...new Set(gids.filter(Boolean))];
  let reason = "";
  for (let attempt = 0; attempt < 3 && left.length; attempt++) {
    if (attempt) await delay();
    const answers = await batch(left.map((gid) => ["aria2.removeDownloadResult", [gid]]));
    reason = answers.find((a) => a.error)?.error || reason;
    left = left.filter((_, i) => answers[i].error);
  }
  if (left.length) {
    const statuses = await batch(left.map((gid) => ["aria2.tellStatus", [gid, ["status"]]]));
    left = left.filter((gid, i) => {
      const error = statuses[i]?.error;
      if (typeof error !== "string") return true;
      const message = error.trim().toLowerCase();
      const id = gid.toLowerCase();
      return message !== `no such download for gid#${id}` && message !== `gid#${id} is not found`;
    });
  }
  return { left, reason };
}
