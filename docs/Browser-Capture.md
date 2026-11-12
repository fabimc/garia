# Browser capture

Garia catches downloads started outside the app: file links, video pages, magnets, `.torrent` files, the clipboard, and the browser extension.

A copied file URL is offered as a banner rather than queued immediately, because copying is not the same as asking. Quiet mode in Settings → Browser skips the banner and confirm sheet, and an optional clipboard file-type list limits which extensions count as an offer. The first clipboard contents at launch are ignored. Anything sent on purpose through `garia://add?url=…` is an instruction: the bookmarklet goes straight in, or opens the quality picker for a video page. The browser extension uses the same scheme with `from=extension`; an intercepted file opens a sheet for its name, folder, and start-now vs queue choice. On a watch page the extension draws a Download button on the player and sends the page, not the stream, so playlists still work without playing first. The options page can turn click capture, download takeover, and the video button off, and clear hidden sites. Hold Alt on a file link to leave that download with the browser.

The extension lives in `extensions/garia`. Settings → Browser → **Show extension folder** opens it. Chromium loads the folder from `chrome://extensions` with Developer mode enabled. Firefox loads `manifest.json` from `about:debugging` (Load Temporary Add-on) until addons.mozilla.org signs it. Right-click a page to review all its links in the add dialog. `npm run ext:pack` writes the Chromium and Firefox store zips; see [Publishing the browser extension](Publishing-the-Extension.md).

## Omarchy: Chromium

The package-bundled unpacked extension is the supported Omarchy install path.

1. Install Garia from Omarchy's OPR (`garia-bin`) when available, so the system registers `garia://`. The interim AppImage does not register protocol or file associations.
2. In Garia, open Settings → Browser → **Show extension folder**.
3. In Chromium, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the opened folder.
4. Click a file link; Garia's capture sheet opens in the running app. Confirm it to add the download. Hold **Alt** while clicking to leave that file with Chromium.
5. The extension hands captures to Garia with `garia://`. A later handoff focuses the existing instance rather than starting a second tiled window.

The bundled extension path is available in packaged builds, not `tauri dev`. If the system does not have a `garia://` handler, use a packaged install; Omarchy package availability and host validation are tracked by [#108](https://github.com/fabimc/garia/issues/108)–[#110](https://github.com/fabimc/garia/issues/110).

The `garia://` and `magnet:` schemes, and `.torrent` as a document type, are declared in `tauri.conf.json`. They work from a built app, not from `tauri dev`, where the binary is not installed as a desktop app.

The extension [privacy policy](../extensions/PRIVACY.md) is the public URL for store listings.
