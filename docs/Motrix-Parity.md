# Motrix parity review

This document compares Garia with the Motrix feature list and records the remaining work needed to close the gaps that matter most for everyday desktop downloading.

This is a product review and implementation plan, not a claim that Garia should copy Motrix feature-by-feature. Garia is a smaller, cross-platform desktop downloader built on aria2, and its goal is to match the workflow users expect from a modern download manager while keeping the app simpler, more focused, and easier to maintain.

## Current Garia coverage

Garia already covers a substantial portion of the core Motrix workflow:

- Download by URL, magnet link, `.torrent`, and FTP directory
- Browser capture from links, media pages, the clipboard, and extension-driven flows
- Download queueing with pause, resume, stop, and scheduler support
- File categories and site-based rules for sorting downloads
- Per-download speed caps and traffic modes for app-wide bandwidth control
- Torrent controls for file selection, seeding rules, and tracker/peer visibility
- Video downloads with yt-dlp and ffmpeg merging
- Checksum verification, login/auth handling, and HTTP proxy support
- Remote control, tray/dock status indicators, and restart-safe queued downloads
- Notifications and app-layer housekeeping such as retry failed and clear completed

The core Motrix experience is already present in a simplified form: add a download, track progress, catch it from browsers, and let the queue keep working while the app is hidden.

## Remaining gaps versus Motrix

The gaps are not in core downloading; they are in the polish, breadth, and power-user experience around browser capture, queue operations, and media selection.

### 1. Browser capture and download intake

Priority: high

- Improve the browser-capture flow so it feels as frictionless as Motrix's "download from page or selected link" UX.
- Tighten detection for downloadable links and embedded media so capture is more reliable on more websites.
- Keep the browser-extension workflow consistent across Chrome, Firefox, Edge, Brave, and Safari.
- Make bulk intake from pages and copied links easier to review before starting downloads.

### 2. Queue and row actions

Priority: high

- Add more explicit queue organization actions, including move-to-top / move-to-end and clearer batch operations.
- Expose consistent row actions for retry, retry all, remove with/without files, and housekeeping tasks.
- Make active, queued, and completed states easier to scan without needing deep list knowledge.
- Improve the recovery story when a failed item is retryable and when a restart resumes queued work.

### 3. File and media quality controls

Priority: medium

- Improve media-quality selection in the video-download workflow so it feels more like a first-class Motrix experience.
- Surface more understandable output naming and format choices for videos and audio downloads.
- Keep the ffmpeg/merge flow explicit when the requested combination is unsupported.
- Improve playlist and best-available behavior without making the flow harder to follow.

### 4. Torrent and fail-state UX

Priority: medium

- Add clearer torrent health, tracker-state, and stalled/seeding messaging for users who are not reading the underlying aria2 output.
- Make per-file priority and bulk file decisions more obvious in both the row and the detail panel.
- Improve how failed or stalled torrent states explain the next action to the user.
- Keep the seed policy and queue behavior consistent through relaunches.

### 5. Native product polish

Priority: medium

- Continue polishing menu, tray, and dock verbs so the app feels as native and discoverable as a desktop download manager should.
- Improve empty states, notices, and detail-panel summaries so users understand what is happening at a glance.
- Tighten the onboarding and first-run experience so new users can discover the browser capture, categories, and video workflow quickly.

## Recommended implementation order

1. Browser-capture parity and bulk intake improvements.
2. Queue actions, batch selection, and row-action polish.
3. Better media quality selection and ffmpeg/merge messaging.
4. Torrent status, file-priority, and fail-state clarity.
5. First-run onboarding and native desktop polish.

## Implementation notes for the next contributor

- Keep each improvement incremental and target a gap the Motrix feature list makes obvious.
- Favor user-facing behavior that is testable and visible in the queue, row, and browser-capture flow.
- Reuse the shared parity helper pattern in `src/parity.js` for any logic that must stay consistent across the UI.
- Add focused tests for queue-state and parity logic before broad UI work.
- Keep the product-level plan in `docs/` so the roadmap stays discoverable and maintainable.

## Outcome

Garia already matches the core Motrix feature set for day-to-day downloading: browser capture, queue controls, video downloads, torrent handling, auth/proxy support, and app-level bandwidth management. The remaining work is mostly in polish, power-user UX, and deeper parity around browser capture, queue workflow, and media output quality.
