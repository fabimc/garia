// Dev-only mock of the aria2 JSON-RPC endpoint, for working on the UI without
// a running aria2c. Serves the same shape as aria2.tellActive / tellWaiting /
// tellStopped on port 6800.  Usage: npm run mock
import { createServer } from "node:http";

const MB = 1024 * 1024;
const started = Date.now();

// `extra` carries whatever the row needs beyond the basics — errorCode and
// errorMessage for a failed download, or `uris: []` for a torrent, which has
// no source URI and so nothing to retry from.
const item = (gid, status, path, total, done, speed, extra = {}) => {
  const { uris, ...rest } = extra;
  return {
    gid,
    status,
    totalLength: String(total),
    completedLength: String(done),
    downloadSpeed: String(speed),
    dir: path.slice(0, path.lastIndexOf("/")),
    // The detail panel asks for the full key set, so the mock has to carry the
    // fields the row never looks at: how many sockets are open, what has gone
    // back out, and how the file is cut up.
    uploadLength: "0",
    uploadSpeed: "0",
    connections: status === "active" ? "16" : "0",
    numPieces: total ? String(Math.ceil(total / (4 * MB))) : "0",
    pieceLength: String(4 * MB),
    files: [{
      index: "1",
      path,
      length: String(total),
      completedLength: String(done),
      selected: "true",
      uris: uris ?? [{ uri: "https://example.com/" + path.split("/").pop(), status: "used" }],
    }],
    ...rest,
  };
};

// A torrent, so the peers table and the per-file list have something real to
// render. Everything about it that isn't in `item` is what makes it a torrent.
const torrent = (t) => {
  const total = 1800 * MB;
  const done = Math.min(total, 300 * MB + t * 3.1 * MB);
  const dir = "/Users/me/Downloads/archive-linux-isos";
  const files = [
    ["alpine-3.21-x86_64.iso", 220 * MB, 1],
    ["debian-13.1-amd64-netinst.iso", 640 * MB, 1],
    ["fedora-42-workstation.iso", 940 * MB, 0.35],
  ].map(([name, length, share], i) => ({
    index: String(i + 1),
    path: `${dir}/${name}`,
    length: String(length),
    completedLength: String(Math.round(length * Math.min(1, share * (done / total) * 2.2))),
    selected: isPicked("eeee1111", i + 1) ? "true" : "false",
    uris: [],
  }));
  return {
    gid: "eeee1111",
    status: paused.has("eeee1111") ? "paused" : "active",
    totalLength: String(total),
    completedLength: String(Math.round(done)),
    downloadSpeed: String(Math.round(2.6 * MB)),
    uploadLength: String(Math.round(done * 0.4)),
    uploadSpeed: String(Math.round(0.9 * MB)),
    connections: "23",
    numSeeders: "7",
    seeder: "false",
    numPieces: String(Math.ceil(total / (4 * MB))),
    pieceLength: String(4 * MB),
    infoHash: "2b66980093bc11806fab50cb3cb41835b95a0362",
    dir,
    files,
    bittorrent: { mode: "multi", info: { name: "archive-linux-isos" } },
  };
};

// aria2 reports a peer's progress as the raw piece bitfield, so the mock has
// to hand over hex rather than a percentage.
function bitfield(pieces, share) {
  const nibbles = Math.ceil(pieces / 4);
  const full = Math.floor(nibbles * share);
  return "f".repeat(full) + "0".repeat(nibbles - full);
}

function peersFor(bt) {
  const pieces = Number(bt.numPieces);
  const rows = [
    ["81.171.22.4", 51413, 1, 1.4, 0.2],
    ["185.21.216.155", 6881, 1, 0.7, 0.1],
    ["92.63.194.17", 34210, 0.62, 0.4, 0.35],
    ["203.0.113.44", 6889, 0.31, 0.08, 0.6],
    ["198.51.100.7", 12043, 0.12, 0, 0.25],
  ];
  return rows.map(([ip, port, share, down, up]) => ({
    peerId: ip,
    ip,
    port: String(port),
    bitfield: bitfield(pieces, share),
    seeder: share >= 1 ? "true" : "false",
    amChoking: "false",
    peerChoking: share < 0.2 ? "true" : "false",
    downloadSpeed: String(Math.round(down * MB)),
    uploadSpeed: String(Math.round(up * MB)),
  }));
}

// getServers is per file, and a mirrored download is the case worth seeing:
// two hosts, two speeds, one file.
function serversFor(dl) {
  const speed = Number(dl.downloadSpeed);
  // A torrent gets its bytes from peers, and aria2 lists servers only for the
  // web seeds it usually doesn't have.
  if (!speed || dl.bittorrent) return [];
  const uri = dl.files[0]?.uris?.[0]?.uri || "https://example.com/file";
  return [{
    index: "1",
    servers: [
      { uri, currentUri: uri, downloadSpeed: String(Math.round(speed * 0.62)) },
      {
        uri,
        currentUri: uri.replace("example.com", "mirror.eu.example.net"),
        downloadSpeed: String(Math.round(speed * 0.38)),
      },
    ],
  }];
}

// The queue is the one thing here that has to remember what it was told:
// changePosition only means anything if the next tellWaiting comes back in the
// new order. A paused download sits in it, exactly as aria2 reports one — and
// that is what makes a queue position more than a count of the queued rows.
const QUEUE = new Map([
  ["bbbb1111", () => item("bbbb1111", "waiting", "/Users/me/Downloads/Xcode_16.2.xip", 7800 * MB, 0, 0)],
  ["cccc1111", () => item("cccc1111", "paused", "/Users/me/Downloads/Blender 4.3 macOS arm64.dmg", 420 * MB, 190 * MB, 0)],
  ["bbbb2222", () => item("bbbb2222", "waiting", "/Users/me/Downloads/an-extremely-long-file-name-that-should-be-truncated-with-an-ellipsis-rather-than-wrapping-across-lines.tar.gz", 2200 * MB, 0, 0)],
  ["bbbb3333", () => item("bbbb3333", "waiting", "/Users/me/Downloads/node-v24.4.0-darwin-arm64.tar.gz", 62 * MB, 0, 0)],
  ["bbbb4444", () => item("bbbb4444", "waiting", "/Users/me/Downloads/Sintel (2010) 4K.mkv", 5100 * MB, 0, 0)],
  ["bbbb5555", () => item("bbbb5555", "waiting", "/Users/me/Downloads/postgresql-18.1-macos.dmg", 310 * MB, 0, 0)],
]);

let queueOrder = [...QUEUE.keys()];

// POS_SET counts from the front, POS_CUR from where the download is now, and
// POS_END back from the end. aria2 answers with the position it ended up at.
function changePosition(gid, pos, how = "POS_SET") {
  const at = queueOrder.indexOf(gid);
  if (at < 0) return null;
  queueOrder.splice(at, 1);
  const base = how === "POS_CUR" ? at : how === "POS_END" ? queueOrder.length : 0;
  const to = Math.max(0, Math.min(queueOrder.length, base + Number(pos)));
  queueOrder.splice(to, 0, gid);
  return to;
}

// Per-download caps, the way aria2 keeps them: an option on the download, set
// with changeOption and read back with getOption. One row starts capped, so a
// chip and a pressed segment are on screen without anyone clicking first.
const limits = new Map([["aaaa2222", String(512 * 1024)]]);

// Which files inside a torrent are being taken, as aria2's --select-file
// string. Undefined means all of them, which is aria2's own default.
const picks = new Map([["eeee1111", "1,2"]]);

function isPicked(gid, index) {
  const spec = picks.get(gid);
  if (spec === undefined) return true;
  return spec.split(",").some((part) => {
    const [from, to] = part.split("-").map(Number);
    return to === undefined ? from === index : index >= from && index <= to;
  });
}

function changeOption(gid, options = {}) {
  if ("max-download-limit" in options) {
    limits.set(gid, String(options["max-download-limit"]));
  }
  if ("select-file" in options) {
    // The real aria2 refuses this on a download it is actively working, which
    // is the whole reason the UI pauses first.
    if (paused.has(gid)) picks.set(gid, String(options["select-file"]));
    else return { error: `Cannot change select-file on an active download` };
  }
  return "OK";
}

function getOption(gid) {
  return {
    dir: "/Users/me/Downloads",
    "select-file": picks.get(gid) ?? "",
    "max-download-limit": limits.get(gid) ?? "0",
    "max-connection-per-server": "16",
    split: "16",
  };
}

// Downloads the UI has paused or stopped seeding, so the mock can answer the
// way aria2 would between a forcePause and the unpause after it.
const paused = new Set();
const removed = new Set();

function snapshot() {
  // Let the two active downloads creep forward so progress bars animate.
  const t = (Date.now() - started) / 1000;
  const done = Math.min(351 * MB, 40 * MB + t * 4.2 * MB);

  const active = [
    item("aaaa1111", "active", "/Users/me/Downloads/Ubuntu 24.04 Desktop.iso", 351 * MB, Math.round(done), 4.2 * MB),
    torrent(t),
    // totalLength 0 → exercises the indeterminate sweep
    item("aaaa2222", "active", "/Users/me/Downloads/stream-of-unknown-size.bin", 0, Math.round(12 * MB + t * MB), 1.1 * MB),
  ];

  // One download that actually crosses the line, so the completion handling —
  // the notification, the dock badge, the row changing sections — has
  // something to fire on without waiting for a real transfer.
  const FINISH_AT = 15;
  const landing = t < FINISH_AT
    ? item("dddd1111", "active", "/Users/me/Downloads/lands-in-15-seconds.mp4",
        80 * MB, Math.round((t / FINISH_AT) * 80 * MB), 5.3 * MB)
    : item("dddd1111", "complete", "/Users/me/Downloads/lands-in-15-seconds.mp4",
        80 * MB, 80 * MB, 0);
  (landing.status === "active" ? active : null)?.push(landing);
  // The two halves of a merged video, so the detail panel's paired shape has
  // something to show: one row in the list, two downloads underneath it.
  const half = (gid, name, total, share, speed) =>
    item(gid, "active", `/Users/me/Downloads/Video/${name}`, total,
      Math.round(Math.min(total, total * share * (t / 40))), speed,
      { uris: [{ uri: `https://rr3---sn-vgqs7nsk.googlevideo.com/videoplayback?expire=1788400000&ei=${gid}&ip=0.0.0.0&itag=${name.includes("audio") ? 251 : 315}&source=youtube&mime=video%2Fwebm`, status: "used" }] });

  active.push(
    half("ffff1111", "A Very Long Talk About Nothing.f315.webm", 1300 * MB, 1, 3.4 * MB),
    half("ffff2222", "A Very Long Talk About Nothing.f251.webm", 42 * MB, 1, 0.6 * MB),
  );

  // A torrent that is done downloading and is still uploading — `active` with
  // `seeder`, which is the only way aria2 says "seeding". Stopping the seeding
  // is a removal, and what aria2 keeps afterwards is a `removed` record with
  // every byte present.
  const seedSize = 740 * MB;
  const seeding = {
    ...item("eeee2222", removed.has("eeee2222") ? "removed" : "active",
      "/Users/me/Downloads/nixos-25.05-x86_64.iso", seedSize, seedSize, 0),
    seeder: "true",
    uploadLength: String(Math.round(seedSize * (0.3 + t / 600))),
    uploadSpeed: removed.has("eeee2222") ? "0" : String(Math.round(1.4 * MB)),
    numSeeders: "12",
    connections: removed.has("eeee2222") ? "0" : "9",
    infoHash: "8c4f3d2a19b6e05c7d81f4a2b3c9e0d5f6a7b8c9",
    bittorrent: { mode: "single", info: { name: "nixos-25.05-x86_64.iso" } },
  };
  if (!removed.has("eeee2222")) active.push(seeding);

  const waiting = queueOrder.map((gid) => QUEUE.get(gid)());
  const stopped = [
    ...(removed.has("eeee2222") ? [seeding] : []),
    ...(landing.status === "complete" ? [landing] : []),
    item("cccc2222", "complete", "/Users/me/Downloads/annual-report.pdf", 18 * MB, 18 * MB, 0),
    // quotes + angle brackets: proves filenames are no longer injected as HTML
    item("cccc3333", "complete", '/Users/me/Downloads/quote"and<angle>brackets.zip', 3 * MB, 3 * MB, 0),
    // aria2 reports the reason two ways: a message when it has one…
    item("cccc4444", "error", "/Users/me/Downloads/broken-mirror.tar.xz", 96 * MB, 12 * MB, 0,
      { errorCode: "3", errorMessage: "Resource not found" }),
    // …and a bare code when it doesn't, which the UI has to translate
    item("cccc5555", "error", "/Users/me/Downloads/half-written.iso", 1400 * MB, 640 * MB, 0,
      { errorCode: "9" }),
    // No source URI — a torrent can't be retried by re-adding a URL
    item("cccc6666", "error", "/Users/me/Downloads/some-collection.torrent", 0, 0, 0,
      { errorCode: "26", uris: [] }),
  ];
  return { active, waiting, stopped };
}

createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.end();

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let id = null, method = "", params = [];
    try { ({ id, method, params = [] } = JSON.parse(body)); } catch {}
    // Anything that isn't a poll is the UI actually doing something — printed
    // so the folder each download is added with is visible from here.
    if (method && !method.startsWith("aria2.tell") &&
        method !== "aria2.getServers" && method !== "aria2.getPeers" &&
        method !== "aria2.getOption") {
      console.log(method, JSON.stringify(params));
    }
    const s = snapshot();
    const all = [...s.active, ...s.waiting, ...s.stopped];
    // The detail panel asks about one gid at a time, and about where its bytes
    // are coming from — which the poll methods never say.
    const one = (gid) => all.find((d) => d.gid === gid);
    const result =
      method === "aria2.changePosition" ? changePosition(params[0], params[1], params[2]) :
      method === "aria2.changeOption" ? changeOption(params[0], params[1]) :
      method === "aria2.getOption"    ? getOption(params[0]) :
      method === "aria2.pause" || method === "aria2.forcePause"
        ? (paused.add(params[0]), "OK") :
      method === "aria2.unpause"      ? (paused.delete(params[0]), "OK") :
      method === "aria2.remove"       ? (removed.add(params[0]), "OK") :
      method === "aria2.tellActive"  ? s.active  :
      method === "aria2.tellWaiting" ? s.waiting :
      method === "aria2.tellStopped" ? s.stopped :
      method === "aria2.tellStatus"  ? one(params[0]) ?? null :
      method === "aria2.getServers"  ? serversFor(one(params[0]) ?? { downloadSpeed: "0", files: [] }) :
      method === "aria2.getPeers"    ? (one(params[0])?.bittorrent ? peersFor(one(params[0])) : []) :
      "OK";
    if (result && result.error) {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({
        jsonrpc: "2.0", id, error: { code: 1, message: result.error },
      }));
    }
    // aria2 answers with an error, not a null, when it has never heard of a gid.
    if (method === "aria2.tellStatus" && !result) {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({
        jsonrpc: "2.0", id,
        error: { code: 1, message: `No such download for GID#${params[0]}` },
      }));
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  });
}).listen(6800, "127.0.0.1", () => console.log("mock aria2 RPC on http://127.0.0.1:6800/jsonrpc"));
