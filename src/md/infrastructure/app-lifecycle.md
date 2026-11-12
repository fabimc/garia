# Infrastructure: App lifecycle

## Close vs quit

- Closing the window hides it; aria2 keeps running. The tray or app launcher can bring it back.
- Quit (Ctrl+Q): save session, stop aria2, exit.
- Window size and position survive quit.

## Tray

- The desktop tray provides New Download, Pause/Resume All, Stop/Start Queue, Retry Failed, Clear Completed, and Open Download Folder.
- The tray also provides Show Garia and Quit. On Linux, relaunching Garia from the application launcher restores the existing instance if the Wayland tray host is unavailable.

## Launch at login

- Launch at login uses an XDG autostart entry.
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
