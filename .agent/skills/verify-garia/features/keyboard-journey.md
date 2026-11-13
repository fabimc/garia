# Keyboard-first download journey

The keyboard path covers adding a URL, filtering the library, pausing and resuming a row, opening details, and closing the topmost surface. Browser-dev can verify Linux copy and focus behavior; hide/restore and Quit require the native app.

## Sub-features

- `keyboard-add` opens Add download, submits a URL, and shows its row.
- `keyboard-filter` moves among sidebar filters with arrow keys and applies one with Enter.
- `keyboard-pause-resume` pauses and resumes the focused row with Space while preserving focus.
- `keyboard-row-controls` activates a focused row button (Retry, Pause/Resume, Show in folder, Delete, the name) with Enter or Space instead of running the list shortcut on the selection.
- `keyboard-inspector` opens details with the platform shortcut.
- `keyboard-row-menu` opens the focused row's context menu with Shift+F10 or the Menu key.
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
- **Row menu.** In Completed, focus an unselected row (Ctrl+F, Tab, Tab reaches the first row). Press `Shift+F10`: `#row-menu` opens next to the row, the row becomes selected, and the first menu item has focus. `ArrowDown`/`ArrowUp`/`Home`/`End` move among the items. Press `Escape` and check focus returns to the row; repeat with `ContextMenu`, then press `Tab`: the menu closes and focus returns to the row. On an active row, open the menu and press `Enter` on Pause: the row pauses and keeps focus. With multiple rows selected, focus one of them and open the menu again: the selection stays intact. Plain `F10` must not open it. Right-click an unselected row and check the menu still opens at the pointer and selects that row.
- **Row controls.** Select the active Ubuntu row, press `Control+f`, then Tab to `[data-gid="cccc4444"] [data-action="retry"]` and press `Enter`. RPC sees `aria2.addUri`, `#detail-pane` stays hidden, and the Ubuntu row stays active. Space on another row's Retry behaves the same. `node --test helpers/keyboard-activation.test.mjs` covers every row control with both keys; it launches and cleans up its own instance, so run it with no instance live.
- **Inspector and Escape.** With a row selected, press `Control+i` to open the inspector. Press `Control+n`, then `Escape`: the Add dialog closes and the inspector stays open. Press `Escape` again; the inspector closes.
- **Help.** Press `Control+Shift+/`. The Help sheet opens and contains the “Keyboard-only path” instructions with Linux shortcut labels and the Linux “Show in folder” file-manager note.
- **Proof.** `evidence/keyboard-journey/` contains the Linux browser-dev add, filter, pause/resume, and Help snapshots and screenshots, including `show-in-folder-help.aria.txt`, `.rows.json`, and `.png`.

## Gotchas

- Browser-dev does not provide native menu accelerators, tray restore, window hide, or Quit. Do not claim those native paths verified.
- The mock has seeded paused rows; use an active row for the pause/resume path.
- `browser reload` returns to the helper's base URL; reapply `?platform=linux` after a reload.
