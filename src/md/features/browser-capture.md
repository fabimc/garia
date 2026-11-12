# Feature: Browser capture

Catch downloads that start outside the app: clipboard, `garia://` links, and the browser extension.

## Three sources, three promises

| Source | Meaning | Default UI |
|--------|---------|------------|
| `clipboard` | Offer — copy is not a request | Banner / confirm |
| `scheme` | Instruction (bookmarklet, Services, Open With) | Queue or quality picker |
| `extension` | Browser intercepted a click/download | Confirm sheet (unless quiet) |

Quiet mode skips the banner and confirm sheet. Magnets always pass the clipboard extension filter.

## Rules

- Ignore the first clipboard contents at launch (leftover copy must not greet the user).
- Extension sends the **page** for video, not the stream URL — playlists still work; no need to play first.
- Hold Option/Alt on a file link to leave that download with the browser.
- `confirm` from the extension: ask name/folder/start-vs-queue. Video pages still use the quality picker as confirm.
- Referrer from the page goes to aria2 as `Referer` (hotlink protection).
- Suggested filename becomes aria2 `out` when the URL has no useful path.
- Keep the extension handoff tab open until the user closes it. Chromium may wait for an external-app confirmation, and the extension cannot tell whether Garia opened. Allow a retry from the tab.

## Schemes and document types

`garia://`, `magnet:`, and `.torrent` are registered in the Mac/Linux bundle (`Info.plist` / `tauri.conf.json`). They work from a built app, not from `tauri dev` (no registered bundle).

## Extension package

Lives in `extensions/garia`. One package for Chromium and Firefox; Safari needs Apple's converter (`scripts/make-safari-extension.sh`) and cannot cancel Safari's own downloads.

## Related

- Code: `src-tauri/src/catch.rs`, `extensions/garia`
- [docs/Browser-Capture.md](../../../docs/Browser-Capture.md)
