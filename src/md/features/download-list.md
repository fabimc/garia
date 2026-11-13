# Feature: Download list

The main window is a live list of aria2 downloads. The frontend polls every second. Rust owns the aria2 process and the RPC secret.

## Intent

- Show progress without making the user watch the engine.
- Keep unfinished work across relaunch via aria2's session file.
- Keep finished rows across relaunch via Garia's own history file — not the session.
- Route new files into category folders at add time — never move files already on disk.

## Statuses Garia invents

aria2's statuses are not enough for the UI:

- **Seeding** — torrent is `active` with `seeder` set. Treat as finished for completion notices; show ratio/shared, not ETA.
- **Merging** — both halves of a video row are complete; ffmpeg is rewriting the container.
- **Stopped** — Stop Queue (or the daily window) held the row. Distinct from a hand pause.
- **Held / Scheduled** — waiting for a named start time or for the window to open.

The status cell carries the single state line (including Scheduled and Merging).
`.dl-scan` chips are modifiers only — Held, Stopped — never a second copy of the
same word already shown as status. Queue-stop and daily-window holds keep status
as Paused (chip = Stopped / Held); only a named start time prints Scheduled.
Verified / Checking stay on `.dl-verified`.

Long names use a head + tail split so the extension stays visible at any Name
column width (CSS ellipsis on the head; tail never shrinks).

## Finished history

aria2 keeps stopped downloads in memory only. Its session file holds unfinished work. A quit, a SIGTERM, or an aria2 restart for new settings empties its stopped list.

- Rust keeps finished rows in `history.json` in the app data folder (`src-tauri/src/history.rs`). It does not use the session file, and the session file does not use it.
- Finished means: `complete`, a seeding torrent, or a `removed` torrent that has all its bytes (stopped seeding). A magnet's metadata download is not a finished row.
- A watcher thread asks aria2 every second and writes each new finished row at once (temp file, fsync, rename). Quit and an aria2 restart also record before aria2 stops. Do not depend on a graceful Quit — a SIGTERM must keep every row seen before it.
- The list shows a history row only when aria2 does not know its gid. aria2's own row is newer and wins.
- `aria2.removeDownloadResult` through `aria2_rpc` also forgets the gid from history. That is how Delete and Clear completed reach it. For a gid only the history knows, the call answers OK. A forgotten gid is not recorded again in this run.
- `aria2.tellStatus` on a gid only the history knows answers with the saved row, so the inspector and checksum check still work.
- Clear completed keeps the files on disk. It removes rows from aria2 and from history.
- The history keeps the newest 1000 rows (aria2's own `max-download-result`).
- A remote client that purges a result through aria2 directly does not reach the history; the row comes back at the next launch.

## Categories

- Default kinds: Video, Music, Documents, Archives (extension match).
- A category may name a host; host wins over type-only.
- Torrents and magnets have no filename at add time → land in the download folder.
- Smart folders are off by default; turning them on must not reshuffle existing files.
- Quiet mode may pin captures to one category even when smart folders are off.

## Traffic modes

- Modes: Full (no limit), Medium, Light.
- Numbers for Medium/Light live in Settings; the status bar only switches mode.
- Overall cap is always derived from the mode so the two cannot disagree.
- A pre-mode settings file that held a bare cap migrates that number into Medium.

## Queue order

- Only queued rows drag-reorder (`aria2.changePosition`).
- Screen order ≠ aria2 queue index: paused rows keep slots without running.
- Drop position is taken from neighbours in the last `tellWaiting` snapshot.
- A merged video is two gids; move them back-to-front so renumbering lands correctly.
- Optimistic UI: move the row first; do not wait on RPC during the drag.

## Toolbar and menus per view

- The header toolbar changes with the sidebar filter: All/Active → Pause all, Resume all, Stop Queue; Queued → Stop/Start Queue, Move to top/end; Paused → Resume all; Failed → Retry all, Clear failed; Completed → Clear completed, Open download folder; Seeding/Torrents → Stop seeding.
- The row context menu acts on the selection only. It hides verbs that do not apply. Global verbs (Retry Failed, Clear Completed) live in the toolbar, the Download menu, and the tray.
- An empty view offers one primary action, and only one it can run here.

## Columns and detail

- Optional columns (size, speed, ETA, sockets, source, category, Saved to, Show) are view prefs per sidebar filter, not engine settings.
- Defaults never include a column that is always empty for that view: no ETA on Queued/Paused (ETA is only computed for active rows), no Finished at on Completed until Garia stores its own completion time.
- The per-row Show button reveals the file in the desktop file manager; it does not open it (`opener:default` grants reveal, not `openPath` on arbitrary files).
- Turning a column on removes that number from the one-line summary. Speed is in the Status line only while the Speed column is off.
- When the list is narrower than 720px (small window, or the inspector beside it), speed/ETA/source-style columns are not painted and Status carries the speed. The user's column choice is kept. This is done in `syncColLayout`, which writes the grid inline — CSS cannot override it.
- Details live in a side inspector (`#detail-pane`) that follows the selection. Below 900px it is a sheet over the list. Escape closes a dialog first, then the inspector — never both at once.
- With several rows selected, the inspector's speed cap and Start at apply only to rows that can still run (active, queued, paused). Clearing a start time applies to all, which also drops a stale one left on a finished row.
- Detail panel asks the full key set for one gid only so the list poll stays narrow.
- `getServers` / `getPeers` only while running — aria2 errors otherwise.

## Related

- Pure decision helpers: `src/parity.js` (tested by `src/parity.test.js`)
- Formal tour: [docs/Features.md](../../../docs/Features.md), [docs/How-It-Works.md](../../../docs/How-It-Works.md)
