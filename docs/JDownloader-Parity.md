# JDownloader parity review

This is a product review and implementation plan, not a claim that Garia should copy every JDownloader detail exactly. Garia is a smaller, cross-platform desktop download manager built on aria2, and the goal is to match the features users expect from a modern multi-source download client where they are valuable to Garia's workflow.

## Current Garia coverage

Garia already covers a large share of the core download-manager experience that people use every day:

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

That means Garia is already strong on the core “download manager” experience. The remaining work is mostly about the things JDownloader users expect from a batch-oriented, browser-heavy download workflow rather than basic HTTP downloads themselves.

## Where Garia still trails JDownloader

### 1. Link-grabbing and page-level capture

Priority: high

- Add a first-class “grab links from page / clipboard / file list” workflow that feels closer to JDownloader’s link-capture flow
- Support capturing large batches of links from a page or text dump without losing the ability to filter or edit them before starting
- Make link extraction more transparent when a page embeds audio, video, or archive downloads
- Keep browser-originated captures predictable across the extension, clipboard, and system-level flows

### 2. Batch workflow and package management

Priority: high

- Add stronger package-level grouping so a single user action can manage many related downloads together
- Support moving downloads between packages, reordering packages, and handling batch retry / retry-all behaviors more explicitly
- Add clearer “queued / running / failed / completed” grouping in the same spirit as JDownloader’s heavy batch-oriented view
- Improve “clear completed”, “remove and keep files”, and “re-run failed imports” row actions so they feel natural at scale

### 3. Link-level metadata and contextual controls

Priority: high

- Surface important metadata per item such as filename, final destination, MIME type, source site, and whether a link is a video or archive
- Add better per-item controls for save path, file selection, and file naming before a download starts
- Make it easier to review why a single link was paused, failed, or queued behind a rate limit or schedule

### 4. Site login and anti-bot handling

Priority: medium

- Add more robust, structured support for per-site downloading rules, including login flows and extractor-specific settings
- Improve handling for sites that require custom headers, cookies, or bulk fetch patterns beyond “single URL plus login” today
- Make the setup experience more discoverable for users who treat “downloading from subscribed sites” as a first-class workflow

### 5. Community-driven and automation-heavy features

Priority: medium

- Prepare for bulk import, recurring download jobs, and automation policies similar to the “download manager as workflow platform” side of JDownloader
- Add more explicit support for scheduled jobs, repeated grabs, and recurring download batches without forcing the user into ad hoc workflows
- Keep remote control, automation commands, and browser extension hooks aligned so the same set of links can be managed from multiple entry points

### 6. Media-specific convenience features

Priority: medium

- Continue to improve the “video page to download” workflow so it feels as low-friction as a link-grab tool
- Add more polished handling for mixed media bundles, quality selection, and post-processing defaults
- Keep the video workflow integrated with the same queue, categories, and status reporting as normal downloads

### 7. Advanced queue and export behavior

Priority: low to medium

- Better support for import/export, saved job templates, and “re-run this set of links later” workflows
- Add deeper rules around queue ordering, one-click reprocessing of failed links, and selection persistence from a downloaded package
- Extend the app’s batch-execution UX so it feels equally comfortable with dozens or hundreds of links at once

## Recommended implementation order

1. Make the browser-capture and link-grab flow feel first-class and batch-friendly.
2. Add stronger package-level and batch-level queue controls so Garia scales beyond a handful of downloads.
3. Improve per-item metadata and failure messaging so users can understand why a link is waiting, failed, or blocked.
4. Expand site-specific automation and login handling to cover the workflows JDownloader users rely on.
5. Keep the media workflow and automation hooks aligned with the general download pipeline rather than treating them as side features.

## Outcome

Garia already covers the everyday desktop download-manager basics that JDownloader users expect, especially around queueing, browser capture, categories, speed controls, login support, and remote pairing. The biggest remaining gaps are not in basic downloading itself; they are in the “link packaging, batch capture, and automation” workflows that make JDownloader feel like a power-user tool.

This document is meant to guide future work and should be revisited as those features are implemented and the product grows.
