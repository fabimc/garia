# uTorrent parity review

This is a product review and implementation plan, not a claim that Garia should copy every uTorrent detail exactly. Garia is a smaller, cross-platform desktop download manager built on aria2; the goal is to match the features users expect from a modern uTorrent-like client where they are valuable to Garia's workflow.

## Current Garia coverage

Garia already matches a substantial portion of the core download-manager experience that uTorrent users care about:

- Multi-download queue with pause/resume, queue stopping, and per-download scheduling
- Bandwidth limits and traffic modes (Full / Medium / Light)
- File categories and smart folders for sorting downloads
- Browser capture from clipboard, bookmarklet, extension, and system open events
- Download-from-URL support for HTTP/HTTPS/FTP and magnets
- `.torrent` handling, including file selection within a torrent
- Seed-ratio / seed-time rules for finished torrents
- Download authentication via stored site logins, custom headers, and browser cookie jars
- HTTP proxy configuration with bypass hosts
- Checksum verification while a file is downloading
- Video downloads via yt-dlp and ffmpeg merging
- Remote control for the aria2 JSON-RPC port and QR pairing flow
- Notification, dock, and tray-style status indicators

## Parity work now in the app

Torrent detail and seeding, queue and row actions, per-download caps, the Torrents filter, and the same Download-menu verbs on macOS and Linux are in the app. The bullets are the spec that shipped.

That work was deeper torrent management, richer queue controls, and UX polish rather than basic downloads themselves.

### 1. Torrent-management feature depth

Priority: high

- Add stronger torrent metadata and peer details in the UI: tracker status, connected peers, seeds/leechers, and health
- Expose per-file priority controls more directly in the row/detail panels
- Add better torrent-specific status badges and messages for seeding, stalled, and error states
- Improve the seed policy experience with clearer controls and a dedicated “seed until” UI

### 2. Queue/workflow parity

Priority: high

- Expand queue organization beyond simple reorder and stop/resume: explicit “move to top”, “move to end”, and batch operations
- Add a more complete “download list” workflow similar to uTorrent’s active/queued/seeding categories
- Surface a richer set of row actions: copy file path, open containing folder, retry all, remove+keep files, and clear completed items
- Keep the scheduler and queue rules in sync across relaunches without confusing the user

### 3. Advanced download controls

Priority: medium

- Better multi-file handling for large mixed downloads, including per-file priority and destination selection
- More explicit verification/failure reporting for failed files, retries, and when a session resumes after a crash
- Granular rate limits by connection or by single download rather than only the app-wide traffic modes

### 4. UX parity and discoverability

Priority: medium

- Add a first-class torrent tab or detail sidebar equivalent to uTorrent’s full torrent dashboard
- Provide clearer, more explicit labels for the queue, schedule, and done-action states
- Improve the “catch a download” UX so browser-originated downloads feel as native and low-friction as uTorrent’s add-from-browser flow

### 5. Platform-specific polish

Priority: medium

- Use macOS and Linux native menus/trays more consistently so the app feels as integrated as a desktop torrent client should
- Continue platform-specific behavior work around badges, menu entries, and launch persistence
- Keep the Linux implementation aligned with the macOS feature set where behavior is equivalent

## Recommended implementation order

1. Bring torrent detail and seeding status up to par with the basic expectations of torrent users.
2. Add richer queue controls and row actions for downloads that are already running.
3. Polish the detail panel and status messaging so users can understand “why this is paused” or “why this failed”.
4. Add the UX improvements that move Garia from “download manager” toward “uTorrent-like client” without changing its smaller scope.
5. Treat browser-capture, remote control, and media workflows as value-add differentiators rather than missing gaps.

## Outcome

The current version of Garia covers the core functional expectations of uTorrent for everyday downloads and torrent use, including the torrent, queue, and per-download controls listed above. aria2 still does not report which tracker answered or a per-file piece priority, so tracker status follows whether any peer is connected, and file priority downloads High, then Normal, then Low.

This document is meant to guide future work and should be revisited as features are implemented and the product grows.
