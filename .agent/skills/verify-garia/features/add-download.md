# Add a download

Add a download lets a user open the Add download dialog, paste an HTTP(S) URL or a magnet link, confirm, and see one new row appear in the library. A magnet stays one row while metadata is fetched and after the torrent itself starts.

## Sub-features

- `add-open` opens the Add download dialog from the sidebar button.
- `add-url` submits a single HTTP URL.
- `add-cancel` closes the dialog without queueing.
- `add-row-appears` shows the new file name in the list after OK.
- `add-magnet` submits one magnet link and shows one row named from `dn`, status `Fetching metadata…`, with no `[METADATA]` name.
- `add-magnet-pause-before` pauses and resumes that row before metadata arrives.
- `add-magnet-handoff` after metadata, still shows exactly one row for that magnet (real file name, no second `[METADATA]` row). Section and All Downloads counts stay in step.
- `add-magnet-pause-after` pauses and resumes the same row after metadata arrives.
- `add-magnet-duplicate` re-adding the same magnet says it is already in the list and does not add a row.
- `add-magnet-remove` removes the row and clears both the torrent gid and the metadata gid.
- `add-magnet-retry-before` retries a metadata fetch that failed, still one row, back to `Fetching metadata…`.
- `add-magnet-retry-after` retries the follow-up after it failed. The new row is the magnet again, not a second `[METADATA]` row. The failed follow-up's status text is `File already exists`.

## How to get to it (user POV)

- Choose `Add download` in the sidebar.
- Press the platform New Download shortcut in the native app (⌘N / Ctrl+N) — native only.
- Drop a URL on the window — native / DnD path; not driven here.

## Driving it with control-garia

Preconditions:

- `./helpers/control-garia doctor` reports `ok: true`.
- No row already uses the file name you will add (pick a unique URL path segment).

- **Open dialog.** Choose Add download. Run `./helpers/control-garia browser open-add`. Dialog `#modal-overlay` is visible and `#modal-title` reads `Add download`.
- **Cancel path.** Open the dialog, then choose Cancel. Run `./helpers/control-garia browser click --css '#modal-cancel'`. The overlay is hidden and the row count is unchanged.
- **Enter URL.** Open the dialog and type a unique URL. Run `./helpers/control-garia browser add-url --url 'https://proof.ovh.net/files/verify-garia-1Mb.dat'`. Observable result: a list option whose name contains `verify-garia-1Mb.dat` appears; command exits 0 with `appeared: true`.
- **Proof.** Snapshot the list after add. Run `./helpers/control-garia browser filter --name "All Downloads"`, then `./helpers/control-garia browser snapshot --path add-download/after-add.aria.txt` and `./helpers/control-garia browser screenshot --path add-download/after-add.png`. Artifacts include the new name. Optionally confirm the mock accepted the URI with `./helpers/control-garia rpc aria2.tellWaiting '[0,100,["gid","status","files"]]'` and find the matching path.
- **Add a magnet.** Choose All Downloads and note the item count. Run `./helpers/control-garia browser filter --name "All Downloads"`, then `./helpers/control-garia browser add-url --url 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=verify-garia-magnet'`. A single new row named `verify-garia-magnet` appears. Run `./helpers/control-garia browser snapshot --path add-download/magnet-fetching.aria.txt` and `./helpers/control-garia browser screenshot --path add-download/magnet-fetching.png`. The status text is `Fetching metadata…`. No row name contains `[METADATA]`. The All Downloads item count grows by one.
- **Pause before metadata.** Run `./helpers/control-garia browser pause-named --name 'verify-garia-magnet'`. The row's `data-status` is `paused`. Run `./helpers/control-garia browser click-named --name 'verify-garia-magnet' --action resume`. `data-status` is `active` again and the status text is still `Fetching metadata…`. Still one row for that name.
- **Wait for the torrent.** The mock hands the magnet to a follow-up download after about eight seconds of unpaused time, and the list then drops the metadata gid. Run `./helpers/control-garia browser wait --ms 10000`, then `./helpers/control-garia browser filter --name "All Downloads"`. Exactly one row matches `verify-garia-magnet`. Its name is the file (`verify-garia-magnet.mp4`), not `[METADATA]…`, and it is not in Completed. Run `./helpers/control-garia rpc aria2.tellActive '[["gid","status","following","files"]]'` and confirm the follow-up gid (its `following` is the metadata gid). Run `./helpers/control-garia rpc aria2.tellStopped '[0,100,["gid","status","followedBy","files"]]'` and confirm no `[METADATA]` file remains. Snapshot with `./helpers/control-garia browser snapshot --path add-download/magnet-one-row.aria.txt` and `./helpers/control-garia browser screenshot --path add-download/magnet-one-row.png`.
- **Pause after metadata.** Run `./helpers/control-garia browser pause-named --name 'verify-garia-magnet'`, then `./helpers/control-garia browser click-named --name 'verify-garia-magnet' --action resume`. Status goes `paused`, then back to `active`. Still one matching row.
- **Duplicate.** Run `./helpers/control-garia browser add-url --url 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=verify-garia-magnet'` again. The notice says the magnet is already in the list. The number of rows named `verify-garia-magnet` stays one.
- **Remove.** Run `./helpers/control-garia browser click-named --name 'verify-garia-magnet' --action remove`, then `./helpers/control-garia browser click --css '#confirm-delete'`. The row is gone. Run `./helpers/control-garia rpc aria2.tellActive '[["gid","files"]]'` and `./helpers/control-garia rpc aria2.tellStopped '[0,100,["gid","files","followedBy"]]'` and confirm neither the metadata gid nor the follow-up gid remains.
- **Retry before metadata.** Add `magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=verify-garia-meta-fail`. The mock fails that metadata fetch after about 1.5s of unpaused time, still as one row named `verify-garia-meta-fail` (no `[METADATA]`). Run `./helpers/control-garia browser wait --ms 3000`, then `./helpers/control-garia browser click-named --name 'verify-garia-meta-fail' --action retry`. The row is active again and the status text is `Fetching metadata…`. Still one matching row.
- **Retry after metadata.** Add `magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&dn=verify-garia-magnet-fail`. Wait for the handoff (`./helpers/control-garia browser wait --ms 10000`). One row remains, named `verify-garia-magnet-fail.mp4`, status `error`, status text `File already exists`. Run `./helpers/control-garia browser click-named --name 'verify-garia-magnet-fail' --action retry`. That row is gone and one active row named `verify-garia-magnet-fail` shows `Fetching metadata…`.

## Gotchas

- The mock must persist `aria2.addUri` into `tellWaiting` (repo mock does). An older mock that returned a gid without a row makes this journey fail — report that, do not weaken the journey.
- Video page URLs take the quality picker and need yt-dlp via Tauri `invoke` — out of scope for browser-dev; use a plain file URL.
- Torrent file browse uses a native file picker — unverified here.
- Unique URL path names avoid colliding with seeded mock rows when asserting by visible name.
- Magnet `add-url` matches the `dn` name (or the info hash), not the whole magnet string. Use a `dn` that no seeded row contains (`verify-garia-magnet`, not `Big Buck Bunny`, which collides with a seeded video).
- The mock waits about eight seconds of unpaused time before `followedBy` / `following` appear. Pausing during that wait holds the handoff; resume continues it. A proof that snapshots too early still shows `Fetching metadata…`. After the handoff the metadata gid is removed from aria2, so `tellStopped` no longer lists `[METADATA]`. A `dn` ending in `-meta-fail` errors the metadata fetch after about 1.5s instead of handing off. A `dn` ending in `-fail` hands off, then the follow-up fails with a file-already-exists message so Retry can be checked after the gid swap.
- `click-named` uses the row action `data-action` (`resume`, `remove`). Remove opens the confirm dialog; `#confirm-delete` confirms it. The trash checkbox stays off, so only the list entry goes.
