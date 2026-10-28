# Persepolis parity review

This document compares Garia with Persepolis and records the feature gaps that remain before Garia can be considered a full desktop download-manager equivalent for the workflows Persepolis users expect.

This is a product review and roadmap, not a claim that Garia should copy Persepolis feature-by-feature. Garia is a smaller, cross-platform app built around aria2 and a browser-centric workflow, so the goal is to match the core capabilities users expect from a modern desktop downloader while keeping the product focused and maintainable.

## Current Garia coverage

Garia already covers a large part of the everyday download-manager experience Persepolis users expect:

- Download-by-URL support for HTTP, HTTPS, FTP, and magnet links
- `.torrent` support, including per-file selection and seed rules
- Browser capture from clipboard, link capture, browser extension, and system-open flows
- Download queue management with pause/resume, stop, scheduling, and retry flows
- Bandwidth controls and traffic modes for per-app throttling
- File categories and site-based rules for organization and sorting
- Login handling via saved credentials, custom headers, cookies, and HTTP proxies
- Video downloads with yt-dlp and ffmpeg merge support
- Checksum verification during or after download
- Remote control and persistent queue behavior across relaunches
- Notifications and tray/dock-style status indicators

In other words, Garia already matches the core “desktop downloader” workflow that Persepolis is known for: add links, let them download in the background, keep a queue, and make browser capture and media downloads feel native.

## Where Garia still trails Persepolis

### 1. Browser-capture and intake flow

Priority: high

- Make the browser-capture flow feel closer to a first-class “download from page or clipboard” experience, not just a one-off add-link flow
- Support larger batch capture operations without losing the ability to review, filter, and edit links before starting
- Improve the way page-based media captures are presented to the user when multiple audio/video files are embedded on one page
- Keep the browser extension, clipboard, and system-open flows consistent so the same content is handled the same way everywhere

### 2. Queue organization and batch controls

Priority: high

- Add stronger queue grouping and scan-friendly states so large lists are easier to understand at a glance
- Improve batch operations such as retry, reorder, remove while keeping files, and clear completed so they behave predictably at scale
- Provide clearer “active / queued / stalled / failed / seeding” states without requiring the user to read the item details text
- Keep queue ordering and re-run behavior stable across relaunches and retry cycles

### 3. Media-download polish

Priority: high

- Improve the quality and format selection UX so media downloads are easier to understand before a job starts
- Surface mergeability and ffmpeg dependency issues more clearly when a video uses separate audio/video streams
- Make naming, output format, and final filename selection more consistent across playlist and single-file media captures
- Add clearer messaging for cases where a format cannot be merged or a higher-quality stream is not available

### 4. File and torrent-management depth

Priority: medium

- Continue to make per-file priority controls clearer and more explicit in the row and detail panel
- Improve torrent state messaging for stalled, seeding, failed, and retryable states so the user always knows the next step
- Surface tracker and peer health more gracefully where aria2 can report only partial information
- Keep file-priority overrides and seed rules stable between sessions so user intent is not lost on relaunch

### 5. Native desktop and discoverability polish

Priority: medium

- Extend the app’s native menu, tray, and dock behavior so the desktop experience feels as polished as a dedicated download manager
- Improve first-run onboarding and the “what this app can do” experience for less technical users
- Keep empty states, notices, and the detail panel more explicit about why a job is waiting, stalled, or failed
- Add product polish so Garia feels like a fully native “download manager” rather than a lightweight utility app

## Recommended implementation order

1. Improve the browser-capture and batch-link intake workflow.
2. Strengthen queue organization, row actions, and batch behavior.
3. Make media quality, final naming, and ffmpeg/merge messaging clearer.
4. Tighten torrent status, fail-state, and per-file control UX.
5. Finish native desktop polish, first-run guidance, and discoverability gaps.

## Implementation notes for the next contributor

- Keep each improvement incremental and user-visible; do not try to copy Persepolis feature-by-feature in one patch.
- Favor queue, browser-capture, and media-quality work that is easy to test and easy to understand from the app itself.
- Reuse the shared parity helper pattern in `src/parity.js` for any logic that must stay consistent across the UI.
- Add focused tests for parity logic and queue-state behavior before broad UI changes.
- Keep the roadmap in `docs/` so the future work remains discoverable and maintainable.

## Outcome

Garia already covers the core Persepolis experience for everyday desktop downloading: URL and torrent downloads, browser capture, queue controls, media downloads, and the usual auth/proxy/caching features users expect from a serious downloader. The remaining gaps are mostly around batch intake, queue organization, media-quality clarity, and native desktop polish rather than the basic functionality itself.

This document should be revisited as those features are implemented and the product grows.
