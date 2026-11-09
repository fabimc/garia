# API: aria2 RPC and Tauri commands

The frontend talks to aria2 over JSON-RPC on localhost. Rust injects the RPC secret on every call so a random web page cannot drive the engine.

## Endpoint

- Prefer port 6800; fall back to a free port if taken.
- Local mode: secret is per-launch, unlisted.
- Remote control on: secret persists in `remote-secret` (see [remote-control.md](../features/remote-control.md)).

## Concurrency

At most six frontend RPC calls in flight (`RPC_CONCURRENCY`). Launch asks `getOption` once per unfinished download; unbounded parallelism would open a thread and socket per row.

## Restart lock

While aria2 restarts (login/proxy/remote), writers hold `restarting`. Readers wait instead of reporting unreachable mid-restart.

## Off the main thread

Any Tauri command that waits on a process, disk, network, or aria2 restart must be async and use `off_main`. Sync commands run on the UI thread — a yt-dlp probe there beachballs the window and stalls polls.

Examples: `video_probe`, `mux_video`, `save_settings` (when a restart is needed), FTP listing, trash.

## Batch adds

Some `addUri` batches are detected so the UI can treat them as one intake flow (`batch_adds`).

## Magnet handoff

List polls ask for `followedBy` and `following`. A finished metadata download is `removeDownloadResult`'d so the stopped list, and the next `--save-session`, do not keep a second row. The scheduler does not special-case the follow-up gid: the next tick holds it when the queue or the quiet-hours window is shut. See [torrents.md](../features/torrents.md).

## Related

- Code: `src-tauri/src/lib.rs` (`Aria2`, `aria2_rpc`, `off_main`)
- Frontend poll / RPC helpers: `src/main.js`
