# Feature: Download list

The main window is a live list of aria2 downloads. The frontend polls every second. Rust owns the aria2 process and the RPC secret.

## Intent

- Show progress without making the user watch the engine.
- Keep unfinished work across relaunch via aria2's session file.
- Route new files into category folders at add time — never move files already on disk.

## Statuses Garia invents

aria2's statuses are not enough for the UI:

- **Seeding** — torrent is `active` with `seeder` set. Treat as finished for completion notices; show ratio/shared, not ETA.
- **Merging** — both halves of a video row are complete; ffmpeg is rewriting the container.
- **Stopped** — Stop Queue (or the daily window) held the row. Distinct from a hand pause.
- **Held / Scheduled** — waiting for a named start time or for the window to open.

The status cell carries the single state line (including Scheduled and Merging).
`.dl-scan` chips are modifiers only — Held, Stopped — never a second copy of the
same word already shown as status. Verified / Checking stay on `.dl-verified`.

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

## Columns and detail

- Optional columns (size, speed, ETA, sockets, source, category) are view prefs, not engine settings.
- Turning a column on removes that number from the one-line summary.
- Detail panel asks the full key set for one gid only so the list poll stays narrow.
- `getServers` / `getPeers` only while running — aria2 errors otherwise.

## Related

- Pure decision helpers: `src/parity.js` (tested by `src/parity.test.js`)
- Formal tour: [docs/Features.md](../../../docs/Features.md), [docs/How-It-Works.md](../../../docs/How-It-Works.md)
