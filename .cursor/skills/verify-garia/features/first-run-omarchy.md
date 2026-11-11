# Linux / Omarchy first-run setup

The dismissible Linux setup checklist confirms the download folder, explains tray and login behavior, points to Ctrl shortcuts, and gives Omarchy Chromium extension steps without replacing the existing macOS setup.

## Sub-features

- `setup-folder` displays the current download folder and offers a folder picker.
- `setup-tray-login` explains hide versus Quit and links to notification/autostart Settings.
- `setup-shortcuts` opens Help with the Linux Ctrl shortcuts and keyboard-only download path.
- `setup-chromium` opens the extension folder and links to Omarchy Chromium and install guidance.
- `setup-platform-copy` shows the Linux checklist only on Linux and preserves the generic setup elsewhere.

## How to get to it (user POV)

- On a clean Linux install, launch Garia; the checklist appears once.
- From Help, choose **Set up Garia again** to reopen it later.
- Choose **Open Settings** for notification and login-autostart options, or **Open Help** for keyboard guidance.

## Driving it with control-garia

Preconditions:

- Launch with `./helpers/control-garia launch`; require `./helpers/control-garia doctor` to report `ok: true` and `ownedByUs: true`.
- Use browser-dev with `?platform=linux`; it verifies platform-specific copy and visibility, not native folder selection, Settings, tray, or external-link opening.

- **Select Linux copy.** Run `./helpers/control-garia browser eval --expr 'location.href = `${location.origin}/?platform=linux`; "reloading"'`, then run `doctor`.
- **Open the checklist.** Press `Control+Shift+/`, then click `#help-setup`. `#setup-overlay` is visible.
- **Check the four Linux rows.** Evaluate `JSON.stringify({rows: document.querySelectorAll("#setup-overlay .setup-row:not(.setup-generic)").length, linux: getComputedStyle(document.querySelector("#setup-overlay .setup-linux-only")).display, generic: getComputedStyle(document.querySelector("#setup-overlay .setup-generic")).display, links: [...document.querySelectorAll("#setup-overlay a[href]")].map(a => a.href)})`. Expect four rows, Linux-only content visible, generic content hidden, and the Chromium/README links present.
- **Check the macOS regression path.** Reload with `?platform=macos`, run `doctor`, press `Control+Shift+/`, and click `#help-setup`. The categories and video rows are visible; Linux-only rows are hidden.
- **Native-only checks.** On a clean Omarchy account, confirm the displayed path is the intended download folder; exercise Change…, Open Settings, tray restore, and each external documentation link. Dismissing with Continue, the close button, or the backdrop should not show the checklist again; Help → Set up Garia again should reopen it.

## Gotchas

- Browser-dev starts with an empty mock download path and has no native folder picker, Tauri Settings window, tray, autostart, or external opener. Do not treat it as proof of those paths.
- Do not describe the checklist as Omarchy-detected: the app has a Linux platform check, not a distro detector.
- Closing Garia hides the window but leaves downloads running; Quit is the operation that stops the engine.
