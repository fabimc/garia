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
- Browser-dev verifies the checklist copy, rows, and links, not native folder selection, Settings, tray, or external-link opening.

- **Use the native sheet layout.** Run `./helpers/control-garia browser eval --expr 'document.documentElement.classList.add("in-app")'`. Without it the Help sheet is taller than the browser viewport and does not scroll, so a pointer click on `#help-setup` times out with "element is outside of the viewport".
- **Open the checklist.** Press `Control+Shift+/`, then run `./helpers/control-garia browser click --css '#help-setup'`. `#setup-overlay` is visible and the Help sheet is closed.
- **Check the four rows.** Evaluate `JSON.stringify({visible: getComputedStyle(document.getElementById("setup-overlay")).display, rows: document.querySelectorAll("#setup-overlay .setup-row").length, links: [...document.querySelectorAll("#setup-overlay a[href]")].map(a => a.href)})`. Expect `flex`, four rows, and the Browser-Capture and README `#linux` links.
- **Native-only checks.** On a clean Omarchy account, confirm the displayed path is the intended download folder; exercise Change…, Open Settings, tray restore, and each external documentation link. Dismissing with Continue, the close button, or the backdrop should not show the checklist again; Help → Set up Garia again should reopen it.

## Gotchas

- Browser-dev starts with an empty mock download path and has no native folder picker, Tauri Settings window, tray, autostart, or external opener. Do not treat it as proof of those paths.
- Do not describe the checklist as Omarchy-detected: Garia has no distro detector.
- `browser reload` drops the `in-app` class; add it again before opening Help.
- Closing Garia hides the window but leaves downloads running; Quit is the operation that stops the engine.
