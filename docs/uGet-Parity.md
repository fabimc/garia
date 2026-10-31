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

That means Garia already matches the everyday "do my downloads, organize them, and keep them running" experience that uGet is known for. The remaining work below was the batch, queue, and browser-capture depth that makes a uGet-style client feel faster and more complete on large or repetitive download tasks.

## Parity work now in the app

The bullets are the spec that shipped. Gaps that stay out of scope for Garia’s smaller product shape are listed at the end. Batch review, packages, wait reasons, and media packaging already landed with the JDownloader / Motrix work; this pass closes the uGet-shaped leftovers on top of that shared pipeline.

### 1. Link-grabbing and browser intake

Priority: high — shipped

- Browser-originated downloads share one intake path across the extension, clipboard, system open, and Add Download.
- A paste or extension dump of several links is reviewed first, with content kind, host, MIME, and “already in the list” feedback.
- Clipboard monitoring can be narrowed to named file extensions (Settings → Browser), the way uGet’s clipboard monitor filters by type. Magnets still pass.
- Quiet mode skips the confirm sheet for browser captures and adds copied file links without the offer banner.
- Quiet mode can pin those captures to one category folder even when smart folders are off (Settings → Browser → Quiet category).

### 2. Batch workflow and package organization

Priority: high — shipped

- Named packages keep a related grab together for pause / retry / clear, with sidebar filters and status section headers.
- Multi-select row actions cover retry failed, clear completed, move between packages, and remove while keeping files.
- Packages and queue order survive a relaunch.
- uGet-style URL sequences (`file[01-10].zip`) expand into the same batch review. OK expands an unexpanded sequence automatically (200 URL cap).

### 3. Queue depth and workflow polish

Priority: high — shipped

- Move to top / move to end, Retry All Failed, and Clear Completed stay on the Download menu, dock, and tray.
- Scan chips distinguish a user **Paused** row from **Stopped** (queue), **Held** (daily window), and **Scheduled** (start time).
- The header status line and detail panel keep saying why the queue or schedule is holding work.

### 4. Download control and failure clarity

Priority: medium — shipped

- Per-download speed caps and traffic modes share one detail-panel sentence via the same scope helper used in tests.
- Failed rows name Login, Checksum, Network, Disk, Server, or Media merge, with a recovery next step on the tooltip and detail panel.
- Retry and Retry All Failed stay discoverable on the row, menu, dock, and tray.

### 5. Media and browser-native convenience

Priority: medium — shipped (Garia-shaped)

- Browser capture, media downloads, and ordinary files stay on one add pipeline; playlists become packages.
- Site rules can set a default video quality; the cookie jar is shared with yt-dlp probes.
- ffmpeg merge messaging and incomplete-media notes stay on the quality picker.

### 6. Platform polish and discoverability

Priority: medium — shipped (Garia-shaped)

- macOS and Linux menus, tray, and dock share the same core verbs where behavior is equivalent: New Download, Pause / Resume All, Stop / Start Queue, Retry Failed, Clear Completed, Open Download Folder.
- Queue status and row actions stay consistent across those surfaces.

### 7. Multi-source mirrors

Priority: medium — shipped

- The Add Download sheet accepts optional mirror URLs for a single file. aria2 pulls from every URI at once, the same idea as uGet’s multiple mirrors.

## Out of scope for Garia

These remain explicitly outside the product shape rather than unfinished checklist items:

- Per-category active-download limits as a second concurrency system — aria2 only exposes one `max-concurrent-downloads`, so true per-category caps need an app-side pause/resume scheduler on top of packages. Not a small additive field.
- FlashGot / browser-native download takeover beyond the existing extension — click capture, `downloads.onCreated` takeover, context menus, and the video chip already cover Chromium/Firefox; Safari cannot cancel in-flight browser downloads, and deeper engine hooks are speculative.
- A separate plugin marketplace or Metalink authoring UI

## Recommended implementation order

1. Improve browser capture and batch intake so large link sets feel as natural as the core single-download flow. — done
2. Add richer queue controls and list-housekeeping actions for repeated multi-download workloads. — done
3. Strengthen pause, retry, failure, and schedule messaging so users know why a row is waiting or failing. — done
4. Bring media and browser-capture quality flows into the same shared model as normal file downloads. — done
5. Finish the platform polish and discoverability pass so the app reads like a complete uGet-style desktop client. — done

## Outcome

Garia matches the uGet workflows that fit a smaller aria2-based desktop client: batch browser intake, URL sequences, clipboard extension filters, quiet capture (with an optional fixed category pin), packages and queue housekeeping, clearer pause / stop / schedule chips, failure recovery language, multi-source mirrors, and shared menu/tray verbs. Category-level concurrency plugins and FlashGot-era browser engine hooks stay intentionally out of scope, listed above.

This document should be revisited only when product scope changes — not as an open feature backlog.
