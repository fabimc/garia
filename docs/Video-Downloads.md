# Video downloads

Paste a video page into the add dialog — or click Download on the player — and Garia asks yt-dlp what is on it, then offers the qualities aria2 can actually fetch — plain HTTP only, since handing aria2 an HLS or DASH URL downloads the playlist rather than the video. A URL that already names a file is never probed. The button sends the page, not the stream, so playlists still work and you do not have to play first.

Large sites no longer serve video and audio in one file: YouTube's 53 formats include not a single complete one. So a merged quality is queued as **two** downloads that share **one row** — one name, one progress bar, one status — and when both land, ffmpeg stitches them with `-c copy` (a container rewrite, not a re-encode) and the halves go to the Trash. The pairing is written to `localStorage` along with both paths, so a quit mid-download still merges on the next launch, even though aria2 forgets a finished download when it restarts.

Failed video rows offer Retry, which re-reads the page rather than re-queueing the URL: the media URLs sites hand out expire, often within hours.

The [sidecar notes](Sidecars.md) explain which yt-dlp and which ffmpeg Garia uses, and why.
