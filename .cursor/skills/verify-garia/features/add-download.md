# Add a download

Add a download lets a user open the Add download dialog, paste an HTTP(S) URL, confirm, and see a new row appear in the library.

## Sub-features

- `add-open` opens the Add download dialog from the sidebar button.
- `add-url` submits a single HTTP URL.
- `add-cancel` closes the dialog without queueing.
- `add-row-appears` shows the new file name in the list after OK.

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

## Gotchas

- The mock must persist `aria2.addUri` into `tellWaiting` (repo mock does). An older mock that returned a gid without a row makes this journey fail — report that, do not weaken the journey.
- Video page URLs take the quality picker and need yt-dlp via Tauri `invoke` — out of scope for browser-dev; use a plain file URL.
- Torrent file browse uses a native file picker — unverified here.
- Unique URL path names avoid colliding with seeded mock rows when asserting by visible name.
