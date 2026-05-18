/**
 * mock-rpc.js — fake aria2 JSON-RPC server for UI development
 *
 * Simulates downloads with live progress so you can test the UI
 * without fetching any real files.
 *
 * Usage:
 *   node mock-rpc.js
 *
 * Then start the app normally:
 *   npm run tauri dev
 */

import http from "http";

const PORT = 6800;
const TICK_MS = 200; // how often progress advances

let nextGid = 1;
const gid = () => String(nextGid++).padStart(16, "0");

// Each download: { gid, status, totalLength, completedLength, downloadSpeed, files }
const downloads = new Map();

function makeDownload(uri, totalMB = null) {
  const total = totalMB != null
    ? totalMB * 1024 * 1024
    : Math.floor((50 + Math.random() * 950) * 1024 * 1024); // 50–1000 MB
  const name = uri.split("/").pop() || "download";
  const id = gid();
  downloads.set(id, {
    gid: id,
    status: "active",
    totalLength: String(total),
    completedLength: "0",
    downloadSpeed: "0",
    files: [{ path: `/tmp/${name}`, uris: [{ uri }] }],
  });
  return id;
}

// Pre-seed a few downloads so there's something to see immediately
makeDownload("https://example.com/ubuntu-24.04-desktop-amd64.iso", 1200);
makeDownload("https://example.com/archlinux-2024.01.01-x86_64.iso", 800);
makeDownload("https://example.com/small-file.zip", 30);

// One already completed
const doneId = gid();
downloads.set(doneId, {
  gid: doneId,
  status: "complete",
  totalLength: "104857600",
  completedLength: "104857600",
  downloadSpeed: "0",
  files: [{ path: "/tmp/already-done.tar.gz", uris: [{ uri: "https://example.com/already-done.tar.gz" }] }],
});

// One paused
const pausedId = gid();
const pausedTotal = 200 * 1024 * 1024;
downloads.set(pausedId, {
  gid: pausedId,
  status: "paused",
  totalLength: String(pausedTotal),
  completedLength: String(Math.floor(pausedTotal * 0.35)),
  downloadSpeed: "0",
  files: [{ path: "/tmp/paused-update.pkg", uris: [{ uri: "https://example.com/paused-update.pkg" }] }],
});

// Advance progress on a timer
setInterval(() => {
  for (const dl of downloads.values()) {
    if (dl.status !== "active") continue;

    const total = Number(dl.totalLength);
    const done  = Number(dl.completedLength);
    if (done >= total) {
      dl.status = "complete";
      dl.completedLength = dl.totalLength;
      dl.downloadSpeed = "0";
      continue;
    }

    // Vary speed to make it look realistic: 3–12 MB/s per tick interval
    const speedBytesPerSec = (3 + Math.random() * 9) * 1024 * 1024;
    const chunk = Math.floor(speedBytesPerSec * (TICK_MS / 1000));
    dl.completedLength = String(Math.min(done + chunk, total));
    dl.downloadSpeed   = String(Math.floor(speedBytesPerSec));
  }
}, TICK_MS);

// --- JSON-RPC handler ---

function handle(method, params) {
  switch (method) {
    case "aria2.addUri": {
      const uri = params[0]?.[0] ?? "unknown";
      const id = makeDownload(uri);
      return id;
    }

    case "aria2.tellActive":
      return [...downloads.values()].filter(d => d.status === "active");

    case "aria2.tellWaiting":
      // aria2 groups both waiting and paused under tellWaiting
      return [...downloads.values()].filter(d => d.status === "waiting" || d.status === "paused");

    case "aria2.tellStopped":
      return [...downloads.values()].filter(d => d.status === "complete" || d.status === "error" || d.status === "removed");

    case "aria2.pause": {
      const dl = downloads.get(params[0]);
      if (dl) { dl.status = "paused"; dl.downloadSpeed = "0"; }
      return params[0];
    }

    case "aria2.unpause": {
      const dl = downloads.get(params[0]);
      if (dl) dl.status = "active";
      return params[0];
    }

    case "aria2.remove":
    case "aria2.forceRemove": {
      const dl = downloads.get(params[0]);
      if (dl) dl.status = "removed";
      return params[0];
    }

    default:
      throw { code: -32601, message: `Method not found: ${method}` };
  }
}

// --- HTTP server ---

const server = http.createServer((req, res) => {
  // CORS — required for requests from the Tauri WebView origin
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method !== "POST")   { res.writeHead(405); res.end(); return; }

  let body = "";
  req.on("data", chunk => (body += chunk));
  req.on("end", () => {
    let response;
    try {
      const { id, method, params = [] } = JSON.parse(body);
      const result = handle(method, params);
      response = { jsonrpc: "2.0", id, result };
    } catch (err) {
      const { id } = (() => { try { return JSON.parse(body); } catch { return { id: null }; } })();
      response = { jsonrpc: "2.0", id, error: err.code ? err : { code: -32603, message: String(err) } };
    }

    const out = JSON.stringify(response);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(out);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`aria2 mock RPC listening on http://localhost:${PORT}`);
  console.log(`Pre-seeded ${downloads.size} fake downloads. Add more via the UI.`);
});
