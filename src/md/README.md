# Garia

Garia is a download manager for Linux. It wraps [aria2](https://aria2.github.io/) in a [Tauri](https://tauri.app/) app and ships its own aria2, ffmpeg, and yt-dlp.

## Stack

- Frontend: plain HTML, CSS, and ES modules under `src/`
- Backend: Rust under `src-tauri/src/` (Tauri 2 commands + aria2 process)
- Browser extension: `extensions/garia`
- Marketing site: `site/` (plain HTML/CSS; GitHub Pages)
- User docs and build notes: `docs/` (formal docs — not intent)

## Important subtleties

- Closing the window hides the UI. Quit stops aria2 and ends downloads.
- Credentials (passwords, proxy password, remote RPC secret) never live in `settings.json`.
- aria2 reads netrc, cookies, and proxy flags once at launch. Changing them restarts aria2 on the same port.
- Merged video qualities are two aria2 downloads shown as one row; ffmpeg muxes with `-c copy` when both finish.
- A seeding torrent stays `active` in aria2. Garia gives it its own status so it does not look stuck at 100%.
- Schedule and Stop Queue are enforced in Rust before the webview paints, because aria2 resumes the session at launch.

## Rules

- Change `src/md` first to capture intent, then change code and tests.
- Keep high signal: capture decisions and traps, omit the obvious.
- Use Simplified Technical English in these files.
- Link formal docs under `docs/` when needed; do not move them into `src/md`.
- Put short-lived plans in `tmp/` (gitignored), not here.

## Layout of the code

| Path | Role |
|------|------|
| `src/main.js` | Download list UI, polling, add/queue actions |
| `src/parity.js` | Pure rules shared by UI and tests |
| `src/add-dialog.js` | Add sheet, batch review, video quality picker |
| `src/settings.js` | Settings window |
| `src-tauri/src/lib.rs` | Aria2 lifecycle, settings, most Tauri commands |
| `src-tauri/src/catch.rs` | Clipboard / `garia://` / extension handoff |
| `src-tauri/src/schedule.rs` | Daily window, per-download start, Stop Queue |
| `src-tauri/src/logins.rs` | Credential store → netrc |
| `extensions/garia` | Browser capture extension |

## File Index

- [features/download-list.md](features/download-list.md): list, statuses, queue, categories, traffic modes
- [features/video.md](features/video.md): yt-dlp probe, merged qualities, ffmpeg mux
- [features/torrents.md](features/torrents.md): seeding status, file select, priorities, seed limits
- [features/browser-capture.md](features/browser-capture.md): clipboard offer vs scheme vs extension
- [features/schedule.md](features/schedule.md): daily window, start time, Stop Queue, done action
- [features/authentication.md](features/authentication.md): netrc, headers, cookies, HTTP proxy
- [features/remote-control.md](features/remote-control.md): listen-all, persistent secret, pairing
- [data/settings.md](data/settings.md): settings shape, migrations, secret files
- [api/aria2-rpc.md](api/aria2-rpc.md): RPC secret, concurrency, restart, off-main commands
- [infrastructure/sidecars.md](infrastructure/sidecars.md): bundled aria2, ffmpeg, yt-dlp choices
- [infrastructure/app-lifecycle.md](infrastructure/app-lifecycle.md): close vs quit, tray, schemes
