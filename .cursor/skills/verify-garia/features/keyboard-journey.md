# Keyboard-first download journey

The keyboard path covers adding a URL, filtering the library, pausing and resuming a row, opening details, and closing the topmost surface. Browser-dev can verify Linux copy and focus behavior; hide/restore and Quit require the native app.

## Sub-features

- `keyboard-add` opens Add download, submits a URL, and shows its row.
- `keyboard-filter` moves among sidebar filters with arrow keys and applies one with Enter.
- `keyboard-pause-resume` pauses and resumes the focused row with Space while preserving focus.
- `keyboard-inspector` opens details with the platform shortcut.
- `keyboard-escape` closes a dialog before the inspector.
- `keyboard-help` opens Help with the platform shortcut and shows platform-aware keyboard and file-location guidance.

## How to get to it (user POV)

- Press the platform New Download shortcut (⌘N / Ctrl+N).
- Use Tab to reach the sidebar; use Up / Down to move between filters and Enter to apply one.
- Focus a download row to move through, pause, resume, inspect, or delete it.
- Press the platform Help shortcut (⌘? / Ctrl+Shift+/).
- Native only: close the window to hide Garia, restore it from the tray or launcher, and use the platform Quit shortcut to exit.

## Driving it with control-garia

Preconditions:

- Launch the browser-dev instance with `./helpers/control-garia launch`; require `./helpers/control-garia doctor` to report `ok: true` and `ownedByUs: true`.
- Enable Linux copy in browser-dev with `./helpers/control-garia browser eval --expr 'location.href = `${location.origin}/?platform=linux`; "reloading"'`, then run `doctor` again.

- **Add by keyboard.** Run `./helpers/control-garia browser press --key Control+n`. `#modal-overlay` is visible and `#modal-url-input` has focus. Fill `#modal-url-input` with a unique URL and press `Control+Enter`; the dialog closes and one matching row appears.
- **Filter by keyboard.** Focus `#filter-bar .nav-item[data-filter=all]`, press `ArrowDown`, then `Enter`. The Torrents filter is active and the focus ring remains visible.
- **Pause and resume.** Focus an active `#download-list [role=option]`, press `ArrowDown` to select it, then press `Space`. The row becomes paused and retains focus. Press `Space` again; it becomes active and retains focus.
- **Inspector and Escape.** With a row selected, press `Control+i` to open the inspector. Press `Control+n`, then `Escape`: the Add dialog closes and the inspector stays open. Press `Escape` again; the inspector closes.
- **Help.** Press `Control+Shift+/`. The Help sheet opens and contains the “Keyboard-only path” instructions with Linux shortcut labels and the Linux “Show in folder” file-manager note.
- **Proof.** `evidence/keyboard-journey/` contains the Linux browser-dev add, filter, pause/resume, and Help snapshots and screenshots, including `show-in-folder-help.aria.txt`, `.rows.json`, and `.png`.

## Gotchas

- Browser-dev does not provide native menu accelerators, tray restore, window hide, or Quit. Do not claim those native paths verified.
- The mock has seeded paused rows; use an active row for the pause/resume path.
- `browser reload` returns to the helper's base URL; reapply `?platform=linux` after a reload.
