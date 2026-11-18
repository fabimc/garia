# Open download and containing folders

Open Download Folder opens the configured download folder in the desktop file manager, and Open Containing Folder opens the folder that holds the selected downloads. Both refuse a folder that does not exist and say so in the notice banner.

## Sub-features

- `open-download-folder` opens the configured download folder from the Completed toolbar, the empty Completed state, the tray, or the Download menu.
- `open-containing` opens each distinct folder holding the selected rows, from the row context menu.
- `open-folder-missing` shows "Couldn't open the folder: … is not an existing folder" when the folder is gone.
- `open-folder-unavailable` disables the toolbar button and hides the empty-state action when there is no download folder or no native app bridge.

## How to get to it (user POV)

- Choose **Completed** in the sidebar, then **Open download folder** in the toolbar.
- With no completed downloads, use the action in the empty Completed view.
- Right-click a row (or Shift+F10 / the Menu key on a focused row), then **Open Containing Folder**.
- Native only: tray menu or Download menu → **Open Download Folder**.

## Driving it with control-garia

Preconditions:

- Launch with `./helpers/control-garia launch`; require `./helpers/control-garia doctor` to report `ok: true` and `ownedByUs: true`.
- Load the IPC stand-in with `./helpers/control-garia browser reload --tauri-stub --missing-dir /Users/me/Downloads/Video`, then run `doctor` again. The stub reports `/home/garia/Downloads` as the download folder (override with `--download-dir`), records every native call in `window.__gariaInvokes`, and rejects `open_folder` for the `--missing-dir` path.

- **Plain browser-dev is unavailable.** Before the stub reload, choose Completed and evaluate `document.getElementById("open-download-folder").disabled`. Expect `true`.
- **Open Download Folder.** Run `./helpers/control-garia browser filter --name Completed`, then `./helpers/control-garia browser click --css '#open-download-folder'`. Evaluate `window.__gariaInvokes.filter(c => c.cmd === "open_folder").map(c => c.payload.path)` and expect `["/home/garia/Downloads"]`.
- **Open Containing Folder.** Run `./helpers/control-garia browser press --css '#download-list [role=option][data-name="annual-report.pdf"]' --key Shift+F10`, then `./helpers/control-garia browser click --role menuitem --name 'Open Containing Folder'`. The newest recorded `open_folder` path is `/Users/me/Downloads`.
- **Missing folder.** Repeat Open Containing Folder on `Keynote.f251.webm`. `#notice-text` reads `Couldn't open the folder: /Users/me/Downloads/Video is not an existing folder`.
- **Proof.** Screenshot plus `browser snapshot` after each action, and the evaluated `__gariaInvokes` paths, under `evidence/open-folder/`.
- **Native-only checks.** In the Tauri app, each entry point opens the file manager on the folder; a deleted folder gives the same notice; the tray and Download menu items open it once per click.

## Gotchas

- The stub proves which native command the UI calls with which path, and how it shows a refusal. It does not prove a file manager opened; that stays a native check.
- The stub lasts for one page load. A plain `browser reload` or navigation drops it, and the page returns to browser-dev behavior.
- Select rows by `data-name` within the current filter. The first `[role=option]` in the DOM may be a row hidden by the filter.
- Mock rows use `/Users/me/Downloads` paths; that is mock data, not a platform claim.
