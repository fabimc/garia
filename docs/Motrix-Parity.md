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

## Parity work now in the app

Browser-capture review, queue scan chips and row housekeeping, media output names, torrent next steps, and the welcome sheet's categories are in the app. The bullets are the spec that shipped.

### 1. Browser capture and download intake

Priority: high

- The capture sheet says the link came from the browser and asks for a look at the URL and folder before it starts.
- A paste or an extension dump of several links is reviewed first. Each row is marked File, Page, Magnet, FTP file, or FTP folder. Files start selected. Pages and folders stay off until they are ticked, so a page is not saved as HTML.
- All, Files, and None sit on that review. All and Files skip a link that is already in the list.
- Download all links also picks up embedded video and audio, and links with a download attribute. The same content script does this in Chrome, Firefox, Edge, Brave, and Safari.

### 2. Queue and row actions

Priority: high

- Move to top, move to end, pause, resume, retry, remove while keeping files, and delete were already on the row. Retry All Failed and Clear Completed are there too, when the queue has something for them to do.
- Each row carries a scan chip — Active, Queued, Paused, Seeding, Done, Failed, Stalled, Slow, Merging, or Scheduled — so the state is readable without the progress text.
- A failed row still names the next step. A download that continued after a restart says how much was already on disk, in the row and in the detail panel.

### 3. File and media quality controls

Priority: medium

- The quality picker names the file it will save, including the container the merge will use.
- A playlist says what Best available, a resolution cap, or Audio only will do. A video with nothing inside the cap still downloads, at its smallest.
- When ffmpeg is not running, the picker says which higher qualities are separate video and audio and cannot be merged.

### 4. Torrent and fail-state UX

Priority: medium

- A stalled torrent says nothing is arriving, and that pause and resume asks the trackers again. A failed torrent says Retry adds it again when a magnet or URL is still on the row.
- The tracker line says how many were announced and whether any peer is connected. aria2 still does not say which tracker answered.
- Set every file to High, Normal, Low, or Off from the detail panel. The same labels are on each file. High still downloads before Normal, then Low, because aria2 has no per-file piece priority.
- The detail header shows Torrent, Video, or HTTP.

### 5. First-run categories

Priority: medium

- The welcome sheet introduces categories beside the download folder. The switch starts off, the same one Settings uses.
- Video, Music, Documents, and Archives are named. Turning the switch on with nothing saved yet installs those four. Folders already saved are kept, and the sheet names those instead.
- The choice is saved when the switch moves. Help → Set up Garia again opens the same sheet.

## Remaining gaps versus Motrix

### 6. Native menu and Safari

Priority: medium

- Menu, tray, and dock verbs were not extended. Retry Failed and Clear Completed are already on the menu bar, the tray, and the dock menu.
- Safari still cannot cancel a download the browser has already started, so takeover there remains click capture, the context menu, and the on-page button.

## Recommended implementation order

1. Browser-capture parity and bulk intake improvements.
2. Queue actions, batch selection, and row-action polish.
3. Better media quality selection and ffmpeg/merge messaging.
4. Torrent status, file-priority, and fail-state clarity.
5. First-run categories, then whatever native-menu polish is still worth doing.

## Implementation notes for the next contributor

- Keep each improvement incremental and target a gap the Motrix feature list makes obvious.
- Favor user-facing behavior that is testable and visible in the queue, row, and browser-capture flow.
- Reuse the shared parity helper pattern in `src/parity.js` for any logic that must stay consistent across the UI.
- Add focused tests for queue-state and parity logic before broad UI work.
- Keep the product-level plan in `docs/` so the roadmap stays discoverable and maintainable.

## Outcome

Garia already matches the core Motrix feature set for day-to-day downloading: browser capture, queue controls, video downloads, torrent handling, auth/proxy support, and app-level bandwidth management. Capture review, queue chips, media filenames, torrent next steps, and a first-run introduction to categories are in the app. What is left is the Safari takeover limit. Menu, tray, and dock already share Retry Failed and Clear Completed, and no further verbs were added.
