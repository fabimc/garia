# Infrastructure: App lifecycle

## Close vs quit

- Close / red button / ⌘W: hide the window. aria2 keeps running. Dock / tray bring it back.
- Quit (⌘Q): save session, stop aria2, exit.
- Window size and position survive quit.

## Dock and tray

- macOS dock menu and Linux tray mirror verbs: New Download, Pause/Resume All, Stop/Start Queue, Retry Failed, Clear Completed, Open Download Folder.
- Menu-bar extra while the window is hidden shows running count.

## Launch at login

macOS LaunchAgent toggled from Settings so overnight schedules do not wait for a manual open.

## Crash recovery

Pid of the aria2 child is recorded. Next launch kills a leftover process before starting fresh.

## Schemes

Built bundles register `garia://`, `magnet:`, and `.torrent`. Dev builds do not register — Open With / scheme tests need a built app.

## Related

- Code: `src-tauri/src/dock.rs`, `src-tauri/src/service.rs`, `src-tauri/src/lib.rs`
- [features/browser-capture.md](../features/browser-capture.md)
