# Browser capture

Catch a download from the browser — click a file, a Download button on a video page, right-click a link, or send the page — plus the clipboard, a bookmarklet, and Services → Download with Garia.

A copied file URL — an `.iso`, a `.zip`, a magnet — is offered as a banner rather than queued on the spot, because copying is not the same as asking. Quiet mode in Settings → Browser skips that banner and the confirm sheet, and an optional clipboard file-type list limits which extensions count as an offer. The first clipboard contents at launch are ignored, so a leftover copy doesn't greet you. Anything sent on purpose through `garia://add?url=…` is an instruction: the bookmarklet goes straight in, or open the quality picker when the URL is a video page. The browser extension uses the same scheme with `from=extension`, and a file it intercepted gets a sheet for the name, the folder, and start-now vs queue — a video page still goes to the picker, which is its confirm. On a watch page the extension also draws a Download button on the player; it sends the page, not the stream, so playlists still work and you do not have to play first. × hides it for that site; the extension options page can turn click capture, download takeover, and the video button off, and clear those hidden sites. Hold Alt on a file link to leave the download with the browser. A `magnet:` link or a `.torrent` file the system opens — a browser, the file manager, Open With — is an instruction, the same as the scheme.

The extension lives in `extensions/garia`. Settings → Browser → Show extension folder opens it. Chrome, Edge, Brave, and Arc load that folder unpacked. Firefox loads the same `manifest.json` from `about:debugging` (Load Temporary Add-on) until addons.mozilla.org signs it. Right-click the page to send every link, reviewed in the add dialog. `npm run ext:pack` writes the two store zips; [Publishing the browser extension](Publishing-the-Extension.md) is the Chrome Web Store and AMO checklist.

## Omarchy: Chromium

The package-bundled unpacked extension is the supported Omarchy install path; Chromium's Web Store is not required.

1. Install Garia from Omarchy's OPR (`garia-bin`) when available, so the system can register the `garia://` handoff. The interim AppImage does not register protocol or file associations.
2. In Garia, open Settings → Browser → **Show extension folder**.
3. In Chromium, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the folder opened in the previous step.
4. Click a normal file link; Garia's capture sheet opens in the running app. Confirm it to add the download. Hold **Alt** while clicking to leave that file with Chromium.
5. The extension hands captures to Garia with `garia://`. A later handoff focuses the existing instance rather than starting a second tiled window.

The bundled extension path is available in packaged builds, not `tauri dev`. If the system does not have a `garia://` handler, use a packaged install; Omarchy package availability and host validation are tracked by [#108](https://github.com/fabimc/garia/issues/108)–[#110](https://github.com/fabimc/garia/issues/110).

The `garia://` and `magnet:` schemes, and `.torrent` as a document type, are declared in `tauri.conf.json`. Linux routes them only after a package registers the app; they do not work from `tauri dev`, where the binary is not installed as a desktop app.

The extension [privacy policy](../extensions/PRIVACY.md) is what the stores need as a public URL.
