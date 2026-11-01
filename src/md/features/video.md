# Feature: Video downloads

Paste a video page (or click Download on the player). Garia probes with yt-dlp, then queues plain HTTP media URLs through aria2.

## Intent

- Offer only formats aria2 can fetch as files (no HLS/DASH playlist URLs).
- Never probe a URL that already names a media file.
- Prefer the user's `yt-dlp` on PATH; fall back to the bundled zipapp (sites break often).

## Merged qualities

Large sites serve video and audio as separate streams. A merged quality is:

1. Two aria2 downloads
2. One UI row (one name, one bar, one status)
3. On both complete: ffmpeg `-c copy` into one container; trash the halves

Pairing (both gids + paths) is stored in `localStorage` so a quit mid-download still merges on next launch. aria2 forgets finished downloads on restart; the pairing must not live only in aria2.

## Retry

Failed video rows re-probe the page. Media URLs expire; re-queueing the old URL is wrong.

## Process placement

yt-dlp probes and ffmpeg merges run off the Tauri main thread (`off_main`). Blocking the main thread freezes the window and stalls every poll behind it.

## Related

- [docs/Video-Downloads.md](../../../docs/Video-Downloads.md)
- [infrastructure/sidecars.md](../infrastructure/sidecars.md)
