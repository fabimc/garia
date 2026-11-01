# Browse the download library

Browse the download library lets a user see seeded downloads, switch sidebar filters, and confirm Garia is connected to aria2 before acting on any row.

## Sub-features

- `library-connect` shows a live aria2 connection in the status bar.
- `library-all` lists every seeded download under All Downloads.
- `library-filter-active` shows only active transfers.
- `library-filter-queued` shows queued waiting rows.
- `library-filter-torrents` shows magnet/torrent rows.

## How to get to it (user POV)

- Open Garia and read the status bar connection label.
- Choose `All Downloads` in the sidebar Library group.
- Choose `Active`, `Queued`, or `Torrents` in the same sidebar.

## Driving it with control-garia

Preconditions:

- `./helpers/control-garia doctor` reports `ok: true`.
- Browser-dev mock is serving its seeded catalog (Ubuntu ISO, queue items, torrents, errors).

- **Confirm connection.** Read the status bar. Run `./helpers/control-garia browser eval --expr "document.getElementById('conn-text').textContent"`. The result contains `aria2 ·`.
- **All Downloads.** Choose All Downloads. Run `./helpers/control-garia browser filter --name "All Downloads"`. `#view-title` is `All Downloads` and `#download-list [role=option]` count is greater than zero.
- **Active filter.** Choose Active. Run `./helpers/control-garia browser filter --name Active`. `#view-title` is `Active` and every visible option has `data-status` consistent with active work (mock active/seeding rows).
- **Queued filter.** Choose Queued. Run `./helpers/control-garia browser filter --name Queued`. `#view-title` matches the queued view and at least one option named like a seeded waiting file appears (for example `Xcode_16.2.xip`).
- **Torrents filter.** Choose Torrents. Run `./helpers/control-garia browser filter --name Torrents`. Options with torrent rows remain (for example `archive-linux-isos`).
- **Proof.** Capture the Active view. Run `./helpers/control-garia browser snapshot --path browse-library/active.aria.txt` and `./helpers/control-garia browser screenshot --path browse-library/active.png`. Artifacts show the `garia` wordmark, `aria2 ·` connection text, view title `Active`, and active download names.

## Gotchas

- Doctor can pass HTTP while `#conn-text` still says `connecting…` if you skip the helper's ready wait — always require `aria2 ·` before filtering.
- Filter labels are the visible `nav-label` text (`Queued`, not `waiting`).
- Empty filters are a failure against the seeded mock, not a soft pass.
- Native tray / dock “how many are running” counts are not covered in browser-dev.
