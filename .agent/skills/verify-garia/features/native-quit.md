# Quit the native app

Closing the window only hides Garia; Quit is the exit. Quit from the native **Garia** menu, Ctrl+Q in the main window, or the tray's Quit closes the app and stops its aria2c, so no engine process is left behind. This is native-only: browser-dev has no menu bar, accelerators, or tray.

## Sub-features

- `quit-menu` **Garia → Quit** is enabled and shows Ctrl+Q; choosing it quits.
- `quit-accelerator` Ctrl+Q in the main window quits, including on Linux (GTK).
- `quit-tray` tray menu → **Quit** quits.
- `quit-stops-engine` after any Quit, Garia's aria2c child is gone.

## How to get to it (user POV)

- Menu bar: **Garia → Quit**.
- Keyboard: Ctrl+Q with the main window focused (Cmd+Q on macOS).
- Tray: click the Garia tray icon, then **Quit**.

## Driving it with control-garia

Preconditions:

- A Linux host that can build Tauri (WebKitGTK 4.1, libayatana-appindicator3 dev packages) plus `Xvfb`, `xfwm4`, `xdotool`, ImageMagick `import`, `busctl`, `jq`, and `dbus-run-session`.
- A debug build with its sidecars beside it: `npm run sidecar`, then `cargo build` in `src-tauri/` (leaves `src-tauri/target/debug/garia` and `aria2c`). To skip the long sidecar build on a throwaway VM, copy a system `aria2c`/`ffmpeg` to `src-tauri/binaries/<name>-<host triple>` and put any executable at `src-tauri/resources/yt-dlp` first; that is enough for Quit.
- No `control-garia launch` instance is needed. `native-quit` owns its own X display (`:99`, override `GARIA_NATIVE_DISPLAY`), window manager, D-Bus session, and a throwaway HOME/XDG sandbox per mode.

- **All three paths.** From `.agent/skills/verify-garia/`, run `./helpers/native-quit`. Exit 0 means every mode logged `RESULT … garia=exited aria2c=gone`. Logs and screenshots land in `evidence/native-quit/`.
- **Menu Quit.** `./helpers/native-quit menu-click` clicks **Garia** in the menu bar, then Quit. `menu-click-02-garia-menu-open.png` shows Quit enabled with `Ctrl+Q`; `menu-click.log` ends with `garia=exited aria2c=gone`.
- **Ctrl+Q.** `./helpers/native-quit ctrl-q` dismisses the Welcome sheet and presses Ctrl+Q; `ctrl-q.log` ends with `garia=exited aria2c=gone`.
- **Tray Quit.** `./helpers/native-quit tray-quit` finds the tray's `com.canonical.dbusmenu` object on Garia's D-Bus connection and sends `Event <Quit id> clicked`, the same call a tray host makes. `tray-quit.menu-labels.txt` lists the tray items; `tray-quit.log` ends with `garia=exited aria2c=gone`.
- **Compare a build.** `--bin PATH --out DIR` runs another binary (for example a copy of a pre-fix build kept beside `garia` so it finds `aria2c`) into a separate folder.

## Gotchas

- Clicks use screen coordinates of the 1100×750 main window placed at 0,0 under xfwm4's title bar. A changed window size, Welcome sheet layout, or app-menu length moves them; check `*-01-launched.png` and `menu-click-02-garia-menu-open.png` first when a run fails.
- `xdotool search` returns xfwm4's frame window, so `mousemove --window` offsets are off by the title bar. Keep screen coordinates.
- Keyboard navigation inside the open GTK menu (`End`, `Return`) is unreliable under xdotool; the menu recipe clicks.
- A copied binary must sit next to an `aria2c` sidecar, or Garia starts without an engine and `aria2c=none` is logged.
- Closing the window is not Quit: it hides Garia and leaves aria2c running by design.
- Xvfb proof is GTK/X11. Wayland compositors (Hyprland/Omarchy) and a real tray host still need a check on that machine.
