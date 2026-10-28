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

## Parity work now in the app

Link-grab review, packages, and clearer wait/fail copy for the high-priority gaps are in the app. The bullets are the spec that shipped.

### 1. Link-grabbing and page-level capture

Priority: high

- A paste or extension dump of several links is reviewed first. Each row is marked Video, Audio, Archive, Document, File, Page, Magnet, or FTP, with a MIME hint when the extension is known.
- All, Files, Video, Archive, and None sit on that review. Video and Archive only tick that content kind. All and Files still skip a link that is already in the list.
- A clipboard dump of several file URLs opens the same batch review instead of offering only the first link.
- Download all links still prefers embedded video and audio, then download-attribute links, then ordinary anchors.

### 2. Batch workflow and package management

Priority: high

- Adding a reviewed batch creates a named package so the grab stays together in the queue. The package name defaults from the referrer host or the common site, and can be edited before download.
- Each packaged row shows the package name beside the scan chip. Packages appear in the sidebar; opening one keeps the usual Downloading / Queued / Failed / Completed section headers.
- When the selection shares one package, the row menu offers Select Package, Pause Package, Resume Package, Retry Failed in Package, and Clear Completed in Package.
- Retry All Failed, Clear Completed, remove while keeping files, and status grouping were already on the queue.

### 3. Link-level metadata and contextual controls

Priority: high

- Batch rows show content kind, host, category or MIME, and whether the link is already in the list.
- Failed and waiting rows name the next step more clearly: queue stopped, schedule hold, login needed, checksum mismatch, or speed/rate limit.
- Single-capture confirm still covers save path and filename before a download starts. Per-row rename inside a batch list is not in this pass.

## Where Garia still trails JDownloader

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
- Per-item save path and rename inside the batch review list
- Moving downloads between existing packages from the row menu

## Recommended implementation order

1. Make the browser-capture and link-grab flow feel first-class and batch-friendly.
2. Add stronger package-level and batch-level queue controls so Garia scales beyond a handful of downloads.
3. Improve per-item metadata and failure messaging so users can understand why a link is waiting, failed, or blocked.
4. Expand site-specific automation and login handling to cover the workflows JDownloader users rely on.
5. Keep the media workflow and automation hooks aligned with the general download pipeline rather than treating them as side features.

## Outcome

Garia already covers the everyday desktop download-manager basics that JDownloader users expect, especially around queueing, browser capture, categories, speed controls, login support, and remote pairing. Link-grab review, packages, and wait/fail messaging for the first three priorities are in the app. What is left is site-rule depth, recurring automation, media polish, and import/export — listed above.

This document is meant to guide future work and should be revisited as those features are implemented and the product grows.
