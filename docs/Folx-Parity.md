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

The matching work already shipped in Garia is the part of the Folx workflow users notice first: browser-capture review, queue-state clarity, media naming, and torrent handling.

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

## Remaining gaps versus Folx

### 5. Better organization and file-management workflow

Priority: high

- Add stronger folder and file organization controls for categories, tags, and saved destination patterns.
- Improve how a user can quickly find the final downloaded file, the containing folder, and the system view for it.
- Make bulk organization actions more explicit for a downloaded set that came from the browser or a torrent.

### 6. Queue and scheduler parity

Priority: high

- Make scheduling logic more visible, easier to review, and more predictable across app relaunches.
- Add clearer multi-select queue operations for reordered downloads and common housekeeping tasks.
- Improve the list’s grouping for Active, Queued, Paused, and Seeding states so it reads like a desktop manager rather than a basic status list.

### 7. Torrent and file control depth

Priority: high

- Improve per-torrent file-priority controls so the user can manage large sets without digging through hidden state.
- Expose richer bulk file operations for multi-file torrents, similar to the multi-selection workflows a Folx user expects.
- Surface more human-readable torrent health, seeding state, and next-step messaging.

### 8. Browser capture and media quality polish

Priority: medium

- Add stronger capture detection for embedded media and more aggressive page-level source recognition.
- Improve the quality-choice flow so the user can clearly see when a format is a merge, a split stream, or a fallback option.
- Keep the resulting filename and output format consistent and explainable in the row and detail panel.

### 9. Native desktop polish

Priority: medium

- Align menu and dock verbs with the same expectations users have from Folx and other macOS-native managers.
- Improve empty states, notices, and detail-side content so the app explains what is happening without a long read of logs.
- Make app-level actions such as retry failed, clear completed, and bulk housekeeping easier to discover.

## Recommended implementation order

1. Organization, file-management, and destination workflow.
2. Queue and scheduler parity, including bulk operations and clearer state grouping.
3. Torrent and file control depth: health, priority, and bulk file operations.
4. Browser-capture and media-quality improvements.
5. Native desktop polish and discoverability.

## Implementation notes for the next contributor

- Keep each improvement incremental and feature-gated; do not try to ship all Folx features in one patch.
- Favor user-facing improvements that are visible in the queue, row, detail panel, and capture flow.
- Reuse the shared parity helper pattern in `src/parity.js` for logic that must stay consistent across the list and detail panel.
- Add focused tests around queue-state and parity logic before broad UI work.
- Keep the product-level plan in `docs/` so the roadmap stays discoverable and maintainable.

## Outcome

When this roadmap is implemented, Garia should feel substantially closer to Folx for the kinds of downloads users actually care about: browser-capture intake, media quality control, download organization, torrent file controls, and a more polished queue workflow.
