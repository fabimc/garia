# browse-library proof

- Run id: `proof-browse-library-1`
- Mode: browser-dev (mock RPC + static `src/` + persistent Chromium CDP)
- Entry points driven: connection status, All Downloads, Active, Queued, Torrents
- Artifacts: `active.aria.txt`, `active.rows.json`, `active.png`
- Observed: conn `aria2 · 127.0.0.1:6800`, Active view with seeded mock downloads only, `garia` wordmark visible
- Stand-in gaps: no native Tauri window, tray, dock, or real aria2 disk writes
