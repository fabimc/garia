# Linux / Omarchy first-run setup

The dismissible Linux setup checklist confirms the download folder, explains tray and login behavior, points to Ctrl shortcuts, and gives Omarchy Chromium extension steps. Garia is Linux-only, so this is the only setup checklist.

## Sub-features

- `setup-folder` displays the current download folder and offers a folder picker.
- `setup-tray-login` explains hide versus Quit and links to notification/autostart Settings.
- `setup-shortcuts` opens Help with the Linux Ctrl shortcuts and keyboard-only download path.
- `setup-chromium` opens the extension folder and links to Omarchy Chromium and install guidance.

## How to get to it (user POV)

- On a clean Linux install, launch Garia; the checklist appears once.
- From Help, choose **Set up Garia again** to reopen it later.
- Choose **Open Settings** for notification and login-autostart options, or **Open Help** for keyboard guidance.

## Driving it with control-garia

Preconditions:

- Launch with `./helpers/control-garia launch`; require `./helpers/control-garia doctor` to report `ok: true` and `ownedByUs: true`.
- Browser-dev verifies checklist copy and visibility, not native folder selection, Settings, tray, or external-link opening. The frontend has no platform switch; no `?platform=` query is needed.

- **Open the checklist.** Press `Control+Shift+/`, then run `./helpers/control-garia browser press --css '#help-setup' --key Enter`. `#setup-overlay` is visible. (A mouse `click` times out in browser-dev: see Gotchas.)
- **Check the four rows.** Evaluate `JSON.stringify({heads: [...document.querySelectorAll("#setup-overlay .setup-row-head")].map(h => h.textContent.trim().replace(/\s+/g, " ")), links: [...document.querySelectorAll("#setup-overlay a[href]")].map(a => a.href)})`. Expect four rows (Download folder, Browser, Tray and login, Keyboard shortcuts) and the Browser-Capture and `#linux` README links.
- **Native-only checks.** On a clean Omarchy account, confirm the displayed path is the intended download folder; exercise Change…, Open Settings, tray restore, and each external documentation link. Dismissing with Continue, the close button, or the backdrop should not show the checklist again; Help → Set up Garia again should reopen it.

## Gotchas

- Help and the checklist only scroll inside the sheet when `html.in-app` is set (native, or `browser reload --tauri-stub`). In plain browser-dev the Help sheet is taller than the 657px harness viewport and `#help-setup` sits off-screen, so `browser click` times out; activate it with `browser press --css '#help-setup' --key Enter`.
- Browser-dev starts with an empty mock download path and has no native folder picker, Tauri Settings window, tray, autostart, or external opener. Do not treat it as proof of those paths.
- Do not describe the checklist as Omarchy-detected: the app has a Linux platform check, not a distro detector.
- Closing Garia hides the window but leaves downloads running; Quit is the operation that stops the engine.
