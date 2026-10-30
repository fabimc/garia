# uGet parity review

This is a product review and implementation plan, not a claim that Garia should copy every uGet detail exactly. Garia is a smaller, cross-platform desktop download manager built on aria2, and the goal is to match the features users expect from a modern multi-source download client where they materially improve speed, resilience, or usability for Garia's workflow.

## Current Garia coverage

Garia already covers a large share of the core download-manager experience that users expect from a uGet-like client:

- Download-by-URL support for HTTP, HTTPS, FTP, and magnets
- Browser capture from the clipboard, bookmarklet, extension, and system open events
- Queue management with pause/resume, queue stopping, and per-download scheduling
- Bandwidth limits and traffic modes (Full / Medium / Light)
- File categories and smart folders for sorting downloads
- Login handling via saved site credentials, custom headers, and browser cookie jars
- HTTP proxy configuration with bypass hosts
- Optional checksum verification while a file is downloading
- Video downloads through yt-dlp and ffmpeg
- Remote control for the aria2 JSON-RPC port and QR pairing flow
- Notification, status, and tray/dock integrations

That means Garia already matches the everyday "do my downloads, organize them, and keep them running" experience that uGet is known for. The remaining work below is the batch, queue, and browser-capture depth that makes a uGet-style client feel faster and more complete on large or repetitive download tasks.

## Parity work still to achieve

### 1. Link-grabbing and browser intake

Priority: high

- Make browser-originated downloads feel as native and low-friction as uGet's clipboard / drag / page-capture flow.
- Improve the capture review for multiple links so batch intake feels more deliberate and less ad hoc.
- Keep capture and add flows consistent between the browser extension, system events, and the app itself.
- Provide clearer user feedback around duplicate links, site rules, and when a page yields several possible downloads.

### 2. Batch workflow and package organization

Priority: high

- Add stronger package- and batch-level grouping so large download sets are easier to reason about.
- Surface more clear "active / queued / completed / failed" grouping for bulk downloads.
- Improve row actions for multi-item selection: retry failed, clear completed, move between groups, and remove while preserving files.
- Keep package rules and queue behavior consistent across relaunches without surprising the user.

### 3. Queue depth and workflow polish

Priority: high

- Extend queue organization beyond simple reorder and stop/resume with more explicit move-to-top / move-to-end semantics.
- Add stronger download-housekeeping controls for repeated tasks, retry loops, and lists of completed rows.
- Improve the difference between a user-held pause, a queue stop, and a schedule hold in the UI.
- Keep the scheduler and stop/start rules legible in both the list and the detail panel.

### 4. Download control and failure clarity

Priority: medium

- Improve the visibility of rate limiting, per-download caps, and why a download is waiting.
- Give users clearer guidance when a download fails because of a login problem, a checksum mismatch, or a transient network issue.
- Add more discoverable recovery actions for retries, stuck items, and resumed sessions.
- Keep the same diagnostic language across row actions, detail panels, and settings.

### 5. Media and browser-native convenience

Priority: medium

- Keep browser-capture, media downloads, and general file downloads in one consistent pipeline.
- Strengthen the quality-selection workflow for video/audio where the backend requires the same site rules and cookie jar.
- Improve the user messaging around ffmpeg merge, media failures, and incomplete media downloads.
- Treat media-specific features as high-value extensions of the main download pipeline, not as a separate product.

### 6. Platform polish and discoverability

Priority: medium

- Align the macOS and Linux menu and tray flows with the same core verbs where behavior is equivalent.
- Keep queue, status, and row actions consistent across app surfaces so users do not need to learn two different workflows.
- Make the app feel native and self-explanatory for power users without adding a second heavy configuration system.

## Recommended implementation order

1. Improve browser capture and batch intake so large link sets feel as natural as the core single-download flow.
2. Add richer queue controls and list-housekeeping actions for repeated multi-download workloads.
3. Strengthen pause, retry, failure, and schedule messaging so users know why a row is waiting or failing.
4. Bring media and browser-capture quality flows into the same shared model as normal file downloads.
5. Finish the platform polish and discoverability pass so the app reads like a complete uGet-style desktop client.

## Outcome

When this roadmap is implemented, Garia should feel substantially closer to uGet for the kinds of tasks users actually care about: batch browser intake, large queued download sets, clearer scheduler and failure states, and a more polished desktop workflow around the same aria2 engine. The remaining work is an incremental product gap, not a full rewrite.

This document should be revisited as the queue, browser capture, and media workflows mature.
