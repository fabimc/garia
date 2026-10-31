# Folx parity review

This document is the implementation roadmap for the Folx feature gap that Garia still has to close before it can feel like a full-featured desktop downloader on macOS for power users.

This is intentionally a product review and planning document, not a promise that Garia should copy Folx feature-by-feature. The goal is to match the workflow and control users expect from a macOS-native downloader where those features materially improve speed, organization, resilience, or usability.

## Current Garia coverage

Garia already covers a large share of the core download-manager workflow:

- URL, magnet, `.torrent`, and FTP directory downloads
- Browser capture from links, media pages, the clipboard, and extension-driven flows
- Queueing with pause, resume, stop, retry, and scheduler support
- Per-download and app-wide bandwidth controls
- File categories, site rules, and organizer-style automation
- Torrent controls for file selection, seeding rules, and tracker/peer visibility
- Video downloads with yt-dlp and ffmpeg merging
- Checksum verification, login/auth handling, and HTTP proxy support
- Remote control, restart-safe queued downloads, and tray/dock status indicators

The core everyday workflow is already present: add a download, track progress, capture from browsers, and let the queue keep working while the app is hidden.

## Parity work already in the app

The matching work already shipped in Garia is the part of the Folx workflow users notice first: browser-capture review, queue-state clarity, media naming, torrent handling, organization, queue grouping, torrent file depth, capture polish, and desktop discoverability.

### 1. Browser capture and intake

- The capture sheet tells the user where the link came from and asks for the destination before the transfer begins.
- A paste or extension dump of multiple links is reviewed first, with File, Page, Magnet, FTP file, and FTP folder labeling.
- Download-all flows pick up embedded video and audio and links with a `download` attribute, matching the expected browser-capture experience.

### 2. Queue and row behavior

- The row exposes queue-state chips such as Active, Queued, Paused, Seeding, Done, Failed, Stalled, Slow, Merging, and Scheduled.
- Row actions include retry, move to top, move to end, and “remove while keeping files.”
- The app already surfaces meaningful recovery wording for retrying failed or restarted downloads.

### 3. File and media quality controls

- Quality and output names are shown in the UI before a download starts.
- Playlist and media workflows can choose a quality cap, “Best available,” or audio-only output.
- ffmpeg and merge rules are surfaced clearly when a media combination is not valid.

### 4. Torrent and fail-state UX

- Torrent rows show the relevant next step when stalled or failed.
- File priority labels are exposed consistently as High / Normal / Low / Off.
- The detail panel communicates tracker and peer health in a way that is useful without pretending aria2 exposes more detail than it really does.

### 5. Organization and file-management workflow

Priority: high

- Categories remain the smart-folder path. Tags sit beside them: add, remove, or clear from the row menu; the row shows a short tag summary; Find matches tags as well as names.
- Saved destination folders are named presets in Settings and on Move to Saved Folder for a selection. Relative paths resolve under the download folder; absolute paths stay absolute.
- Open Containing Folder opens the folder for the selected row(s), distinct from the app-wide Open Download Folder.
- Bulk organize on a multi-select covers Set Category, Use Download Folder, Move to Saved Folder, and tags, so a browser or torrent grab can be filed without one-by-one edits.

### 6. Queue and scheduler parity

Priority: high

- Section headers, sidebar titles, and scan chips share Active / Queued / Paused / Seeding wording through `queueGroupMeta`, so the list reads like a desktop manager rather than a mixed Downloading/Active list.
- Multi-select queue extras surface pause/resume (and related housekeeping) when the selection mixes states.
- Held and scheduled rows feed a status-bar review: the schedule chip names how many are held, and tooltips say start times and the queue stop survive a relaunch.

### 7. Torrent and file control depth

Priority: high

- Multi-file torrents get a file filter (name search + Selected only) so large sets stay manageable without scrolling every path.
- Bulk priority exposes every `bulkPriorityMap` action (All/Checked × High/Normal/Low/Off). Set-every-file pills and the bulk bar share one click path through `normalizeBulkPriorityAction`.
- Health and next-step copy cover metainfo fetch, Weak/No peers, slow, stalled, seeding, and paused — combined in `formatTorrentHealthNote` for the Health fact and detail note.

### 8. Browser capture and media quality polish

Priority: medium

- Page capture also reads `og:video` / Twitter player meta, JSON-LD `contentUrl`, `srcset`, and `.m3u8` links, ordered ahead of ordinary navigation via `collectEmbeddedMediaUrls`.
- Quality choices carry an explicit kind (`complete` / `merge` / `audio`) and shared detail wording; the picker “Saves as …” line names file, resolution, and kind together.
- Video detail notes include the same explainable output line beside merge state.

### 9. Native desktop polish

Priority: medium

- Download menu, dock, and tray already share Retry Failed and Clear Completed; Features docs match those verbs.
- Empty states for Failed, Completed, and Torrents point at Retry Failed / Clear Completed / Open Torrent.
- Status bar shows Retry Failed and Clear Completed when the queue has work for them (`desktopHousekeepingItems`), so housekeeping is visible without opening a menu.

## Remaining gaps versus Folx

None of the numbered roadmap items are open after `#68` (organization + queue) and this PR (torrent depth, capture/quality, desktop discoverability). Further Folx-like polish is optional product work outside this plan:

- Deeper network sniffing for blob players / DRM streams (yt-dlp already covers most watch pages)
- Folder-tree collapse inside torrent file lists
- Dock verbs beyond the existing Download menu set

## Recommended implementation order

1. ~~Organization, file-management, and destination workflow.~~ `#68`
2. ~~Queue and scheduler parity, including bulk operations and clearer state grouping.~~ `#68`
3. ~~Torrent and file control depth: health, priority, and bulk file operations.~~ Done here.
4. ~~Browser-capture and media-quality improvements.~~ Done here.
5. ~~Native desktop polish and discoverability.~~ Done here.

## Implementation notes for the next contributor

- Keep each improvement incremental and feature-gated; do not try to ship all Folx features in one patch.
- Favor user-facing improvements that are visible in the queue, row, detail panel, and capture flow.
- Reuse the shared parity helper pattern in `src/parity.js` for logic that must stay consistent across the list and detail panel.
- Add focused tests around queue-state and parity logic before broad UI work.
- Keep the product-level plan in `docs/` so the roadmap stays discoverable and maintainable.

## Outcome

With `#68` and this PR, Garia matches the Folx roadmap for organization, queue grouping, torrent file control, capture/quality explainability, and in-window housekeeping discoverability. Remaining differences are intentional honesty about aria2 limits and optional polish outside the numbered plan.
