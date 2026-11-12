# Infrastructure: App lifecycle

## Close vs quit

- Closing the window hides it; aria2 keeps running. The Dock, tray, or app launcher can bring it back.
- Quit (⌘Q): save session, stop aria2, exit.
- Window size and position survive quit.

## Dock and tray

- The macOS dock menu and desktop tray provide New Download, Pause/Resume All, Stop/Start Queue, Retry Failed, Clear Completed, and Open Download Folder.
- The tray also provides Show Garia and Quit. On Linux, relaunching Garia from the application launcher restores the existing instance if the Wayland tray host is unavailable.
- macOS menu-bar extra shows the running count while the window is hidden.

## Launch at login

- macOS uses a LaunchAgent; Linux uses an XDG autostart entry.
- On Linux the entry lives in `$XDG_CONFIG_HOME/autostart` (or `~/.config/autostart` by default) and is changed only when the setting is toggled.
- Linux autostart starts the engine without showing a tiled window. Opening Garia from the launcher restores the existing instance.
- Settings reports errors when the autostart state cannot be read or changed.

## Notifications

- Completion notifications use the desktop notification service.
- Enabling notifications checks or requests permission; denied or unavailable notification services are reported in Settings.

## Crash recovery

Pid of the aria2 child is recorded. Next launch kills a leftover process before starting fresh.

## Schemes

Built bundles register `garia://`, `magnet:`, and `.torrent`. Dev builds do not register — Open With / scheme tests need a built app.

## Related

- Code: `src-tauri/src/dock.rs`, `src-tauri/src/service.rs`, `src-tauri/src/lib.rs`
- [features/browser-capture.md](../features/browser-capture.md)
