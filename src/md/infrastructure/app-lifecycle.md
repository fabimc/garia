# Infrastructure: App lifecycle

## Close vs quit

- Closing the window hides it; aria2 keeps running. The tray or application launcher can bring it back.
- Quit (Ctrl+Q): record finished downloads, save session, stop aria2, exit.
- Finished downloads are written to `history.json` as they finish, so a SIGTERM keeps them too. See [features/download-list.md](../features/download-list.md#finished-history).
- Window size and position survive quit.

## Tray

- The tray provides New Download, Pause/Resume All, Stop/Start Queue, Retry Failed, Clear Completed, Open Download Folder, Show Garia, and Quit.
- Relaunching Garia from the application launcher restores the existing instance if the Wayland tray host is unavailable.
- The tray tooltip shows the running count while the window is hidden.

## Launch at login

- Garia uses an XDG autostart entry.
- Autostart starts the engine without showing a tiled window. Opening Garia from the launcher restores the existing instance.
- Settings reports errors when the autostart state cannot be read or changed.

## Notifications

- Completion notifications use the desktop notification service.
- Enabling notifications checks or requests permission; denied or unavailable notification services are reported in Settings.

## Crash recovery

Pid of the aria2 child is recorded. Next launch kills a leftover process before starting fresh.

## Schemes

Built bundles register `garia://`, `magnet:`, and `.torrent`. Dev builds do not register — Open With / scheme tests need a built app.

## Related

- Code: `src-tauri/src/lib.rs`
- [features/browser-capture.md](../features/browser-capture.md)
