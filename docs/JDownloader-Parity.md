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

That means Garia is already strong on the core “download manager” experience. The remaining work below was the batch, packaging, site-rule, automation, and export depth that JDownloader users expect on top of basic downloading.

## Parity work now in the app

The bullets are the spec that shipped. Gaps that stay out of scope for Garia’s smaller product shape are listed at the end.

### 1. Link-grabbing and page-level capture

Priority: high — shipped

- A paste or extension dump of several links is reviewed first. Each row is marked Video, Audio, Archive, Document, File, Page, Magnet, or FTP, with a MIME hint when the extension is known.
- All, Files, Video, Archive, and None sit on that review. Video and Archive only tick that content kind. All and Files still skip a link that is already in the list.
- A clipboard dump of several file URLs opens the same batch review instead of offering only the first link.
- Download all links still prefers embedded video and audio, then download-attribute links, then ordinary anchors.

### 2. Batch workflow and package management

Priority: high — shipped

- Adding a reviewed batch creates a named package so the grab stays together in the queue. The package name defaults from the referrer host or the common site, and can be edited before download.
- Each packaged row shows the package name beside the scan chip. Packages appear in the sidebar; opening one keeps the usual Downloading / Queued / Failed / Completed section headers.
- When the selection shares one package, the row menu offers Select Package, Pause Package, Resume Package, Retry Failed in Package, and Clear Completed in Package.
- Move to Package, Remove from Package, New Package from Selection, Copy Package URLs, and Save as Template are on the row menu.
- Retry All Failed, Clear Completed, remove while keeping files, and status grouping were already on the queue.

### 3. Link-level metadata and contextual controls

Priority: high — shipped

- Batch rows show content kind, host, category or MIME, and whether the link is already in the list.
- Failed and waiting rows name the next step more clearly: queue stopped, schedule hold, login needed, checksum mismatch, or speed/rate limit.
- Single-capture confirm covers save path and filename before a download starts. Batch rows let you rename the saved file before add.

### 4. Site login and anti-bot handling

Priority: medium — shipped (Garia-shaped)

- Site logins still own passwords, netrc, and login headers. A separate Site rules list (Settings → Network) adds per-host referrer, extra headers, default folder, always-queue, package name prefix, and default video quality.
- Rules apply in `addOptions` on top of a matching login. The Add sheet says when a rule will apply.
- The cookie jar is used by aria2 and by yt-dlp video probes, so logged-in watch pages can be listed without reinventing extractors.
- CAPTCHA solvers, site-specific JS extractors, and MyJDownloader cloud plugins stay out of scope for Garia’s size.

### 5. Community-driven and automation-heavy features

Priority: medium — shipped (Garia-shaped)

- Recurring grabs (Settings → Schedule) save a link set and open it for review on a daily or weekly clock while Garia is running. They respect the same Stop Queue / schedule hold world as ordinary adds.
- Link templates store a batch for re-run; packages can be saved as templates from the row menu.
- File → Import Link List and dropping a `.txt` / `.json` link list open the batch review. Extension / `garia://` batch capture and aria2 JSON-RPC remote control remain the external automation hooks — Garia does not invent a second RPC protocol.

### 6. Media-specific convenience features

Priority: medium — shipped (Garia-shaped)

- Playlist downloads become a named package. The last playlist quality rule is remembered, and a site rule can override the default.
- Cookie-backed probes share the Settings cookie jar with aria2.
- Quality picker, merge jobs, playlist caps, and ffmpeg messaging from earlier Motrix/XDM work stay as the media pipeline. Mixed “bundle” extractors beyond yt-dlp are out of scope.

### 7. Advanced queue and export behavior

Priority: low to medium — shipped (Garia-shaped)

- Import/export of link lists and package URL copy / Save as Template cover re-run workflows.
- Move between packages, ungroup, and new-package-from-selection cover package housekeeping.
- Per-row rename in the batch review is available before download.
- Batches of dozens to low hundreds of HTTP URLs use the existing sequential add path; virtualized batch lists and MyJDownloader-scale crawlers stay out of scope.

## Out of scope for Garia

These remain explicitly outside the product shape rather than unfinished checklist items:

- CAPTCHA solving, proprietary hoster plugins, and MyJDownloader cloud account sync
- A second automation RPC beyond aria2 JSON-RPC + `garia://` / extension capture
- Rebuilding yt-dlp as an in-app extractor marketplace
- Virtualized UI for thousands of offline LinkGrabber rows

## Recommended implementation order

1. Make the browser-capture and link-grab flow feel first-class and batch-friendly. — done
2. Add stronger package-level and batch-level queue controls so Garia scales beyond a handful of downloads. — done
3. Improve per-item metadata and failure messaging so users can understand why a link is waiting, failed, or blocked. — done
4. Expand site-specific automation and login handling to cover the workflows JDownloader users rely on. — done
5. Keep the media workflow and automation hooks aligned with the general download pipeline rather than treating them as side features. — done

## Outcome

Garia matches the JDownloader workflows that fit a smaller aria2-based desktop client: link-grab review, packages, site rules beside logins, recurring grabs and templates, media packaging, and import/export of link sets. What JDownloader does through a plugin marketplace and cloud account remains intentionally out of scope, listed above.

This document should be revisited only when product scope changes — not as an open feature backlog.
