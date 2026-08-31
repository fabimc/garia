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
    files: [{
      path,
      uris: uris ?? [{ uri: "https://example.com/" + path.split("/").pop() }],
    }],
    ...rest,
  };
};

function snapshot() {
  // Let the two active downloads creep forward so progress bars animate.
  const t = (Date.now() - started) / 1000;
  const done = Math.min(351 * MB, 40 * MB + t * 4.2 * MB);

  const active = [
    item("aaaa1111", "active", "/Users/me/Downloads/Ubuntu 24.04 Desktop.iso", 351 * MB, Math.round(done), 4.2 * MB),
    // totalLength 0 → exercises the indeterminate sweep
    item("aaaa2222", "active", "/Users/me/Downloads/stream-of-unknown-size.bin", 0, Math.round(12 * MB + t * MB), 1.1 * MB),
  ];
  const waiting = [
    item("bbbb1111", "waiting", "/Users/me/Downloads/Xcode_16.2.xip", 7800 * MB, 0, 0),
    item("bbbb2222", "waiting", "/Users/me/Downloads/an-extremely-long-file-name-that-should-be-truncated-with-an-ellipsis-rather-than-wrapping-across-lines.tar.gz", 2200 * MB, 0, 0),
  ];
  const stopped = [
    item("cccc1111", "paused", "/Users/me/Downloads/Blender 4.3 macOS arm64.dmg", 420 * MB, 190 * MB, 0),
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
    let id = null, method = "";
    try { ({ id, method } = JSON.parse(body)); } catch {}
    const s = snapshot();
    const result =
      method === "aria2.tellActive"  ? s.active  :
      method === "aria2.tellWaiting" ? s.waiting :
      method === "aria2.tellStopped" ? s.stopped :
      "OK";
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  });
}).listen(6800, "127.0.0.1", () => console.log("mock aria2 RPC on http://127.0.0.1:6800/jsonrpc"));
