# XDM parity plan

This document is the implementation roadmap for the XDM feature gap that Garia still has to close before it can be considered feature-parity with XDM for power-user download workflows.

This is intentionally a planning document, not a promise that Garia should copy every feature XDM has. The goal is to match the features users expect from an XDM-like desktop downloader where they materially improve speed, resilience, or usability for Garia's workflow.

## Product direction

Garia already covers the core download-manager experience for everyday use: download queueing, categories, browser capture, torrent controls, seeding rules, video downloads, and remote control. The remaining gap is in the more demanding, XDM-style power-user features that are especially visible in large media downloads, multi-file torrents, and browser-captured content.

The plan below is the implementation order a later agent should follow.

## Priority 1: make torrent status and file controls feel XDM-like

### A. Torrent detail depth
- Show richer peer and tracker health in the detail panel.
- Surface tracked peer counts, seed/leech split, and a human-readable health label.
- Show tracker state more explicitly than “connected or not” where aria2 cannot report the specific tracker that responded.
- Add stronger, user-friendly torrent state messaging for stalled, seeding, and active-but-slow states.

### B. File priority controls
- Keep per-file priority choices consistent across relaunches.
- Make “High / Normal / Low / Off” visible and understandable in the row and detail panel.
- Save explicit file-priority overrides by torrent so a relaunch does not lose the user's intent.
- Expose bulk file operations for multi-file torrents that are common in XDM workflows.

### C. Seeding and queue behavior
- Improve how seed rules are presented to the user.
- Make “seed until ratio”, “seed until time”, and “seed until stopped” clearer in the UI.
- Keep queue actions and torrent rules consistent between relaunches.

## Priority 2: add the queue and row actions users expect from XDM

### A. Richer queue operations
- Add “move to top” and “move to end” as first-class queue actions.
- Support batch actions on multiple rows: pause, resume, delete, remove with files, retry, and reorder.
- Improve “active / queued / seeding” grouping so the list is easier to scan.
- Make repeated queue operations keep the same relative ordering for the selected set.

### B. Download management row actions
- Add row actions like copy file path, open containing folder, locate file in the system explorer, and retry.
- Add “remove + keep files” as a distinct action instead of conflating delete with purge.
- Expose “clear completed” and similar housekeeping actions in a discoverable place.

### C. Download recovery
- Improve state transitions around retries and failed downloads.
- Surface why a download is paused, stalled, or waiting.
- Ensure recoverable errors have clear next steps instead of a vague failure message.

## Priority 3: close the media-capture gap with XDM-style browser workflows

### A. Better browser capture
- Detect downloadable links and embedded media more aggressively from browser pages.
- Add a smoother capture flow for links, selected media, and clipboard content.
- Keep browser-originated downloads as low-friction as possible.

### B. Better media selection
- Show quality and format options more clearly for videos and audio.
- Support direct quality selection and a “best available” rule for playlists.
- Keep the resulting filename and output format consistent and intelligible.

### C. Higher-quality media handling
- Improve ffmpeg/merge workflows and the user messaging around them.
- Make missing ffmpeg or unsupported media combinations explicit.
- Add clearer handling for “video + audio split” downloads and merged outputs.

## Priority 4: bring in the power-user control surface

### A. Connection and speed controls
- Expose per-download speed limits and concurrency controls more directly.
- Add better controls for connection count or file-level acceleration where the backend supports them.
- Distinguish between app-wide limits and per-download overrides more clearly.

### B. Recovery and integrity checks
- Strengthen failure recovery for partial downloads and interrupted sessions.
- Handle checksum verification UX in a way that is understandable to users.
- Provide visibility into whether a download failed because of a network issue, checksum mismatch, or a user action.

### C. Browser and host-level configuration
- Improve host-specific auth, headers, cookies, and proxy flows.
- Keep browser-capture rules aligned with site-specific settings and categories.

## Priority 5: polish the UX to feel like a desktop XDM alternative

- Align the macOS and Linux menus with the same verbs and expectations where behavior is equivalent.
- Improve empty states, notices, badges, and the detail panel so users know what is happening without reading logs.
- Add a fuller, native-feeling detail sidebar for torrents and active downloads.
- Make the app feel like a “download manager that understands torrents and media” instead of a slimmer utility tool.

## Recommended implementation order

1. Torrent detail, health, and per-file priority controls.
2. Queue actions, batch actions, and row-action polish.
3. Browser capture and media quality selections.
4. Recovery, retries, and integrity/diagnostic messaging.
5. Power-user controls and platform-specific polish.

## Implementation notes for the next agent

- Keep the work incremental and feature-gated; do not try to ship all XDM features in one patch.
- Prefer strong, testable, UI-facing improvements that map directly to user expectations.
- Reuse the existing parity helper pattern in src/parity.js for logic that is shared across the list and detail panel.
- Add tests for any parity logic and queue-state behavior before broad UI work.
- Use the existing docs structure in docs/ as the canonical home for product-level planning.

## Outcome

When this roadmap is implemented, Garia should feel substantially closer to XDM for the kinds of downloads and torrents users actually care about: torrent management, browser-originated capture, media quality selection, and robust queue behavior.
