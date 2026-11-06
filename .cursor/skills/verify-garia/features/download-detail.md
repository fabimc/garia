# Download details

Download details lets a user open a docked inspector for one download to inspect name, status, and source information beyond the row summary.

## Sub-features

- `detail-open` opens the detail inspector from a row name.
- `detail-title` shows the download name in `#detail-title`.
- `detail-close` dismisses the inspector with Close.

## How to get to it (user POV)

- Choose the download name on a row in the list.
- Use the row context menu Details item when present.

## Driving it with control-garia

Preconditions:

- `./helpers/control-garia doctor` reports `ok: true`.
- Seeded row `Ubuntu 24.04 Desktop.iso` exists under All Downloads or Active.

- **Open details.** Choose the Ubuntu row name. Run `./helpers/control-garia browser open-detail --name 'Ubuntu 24.04 Desktop.iso'`. `#detail-pane` is visible and `#detail-title` contains `Ubuntu 24.04 Desktop.iso`.
- **Close.** Choose Close. Run `./helpers/control-garia browser click --css '#detail-close'`. The inspector is hidden.
- **Proof.** Re-open details and capture. Run `./helpers/control-garia browser open-detail --name 'Ubuntu 24.04 Desktop.iso'`, then `./helpers/control-garia browser screenshot --path download-detail/ubuntu.png` and `./helpers/control-garia browser snapshot --path download-detail/ubuntu.aria.txt`. Artifacts show the detail inspector and the Ubuntu title.

## Gotchas

- Click `.dl-name` to open the inspector (Enter, double-click, and ⌘I / Ctrl+I also open it). Row chrome alone only selects.
- Torrent inspector tabs isolate Files / Peers / Trackers. Assert the title first, then the active tab’s panel if the journey requires it.
- `Show in Finder` / reveal needs Tauri and is unverified in browser-dev.
