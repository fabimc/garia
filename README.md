# Garia

A lightweight desktop download manager built on top of [aria2](https://aria2.github.io/), wrapped in a [Tauri](https://tauri.app/) native app.

Garia manages aria2 automatically — it ships its own copy inside the app and starts and stops it alongside the window, so you never have to touch the command line to download a file.

## Features

- Add downloads by URL, magnet link, or `.torrent` file — typed, or dropped on the window
- Video downloads — paste a video page and pick a quality; the streams go through aria2 like any other file
- Multi-connection downloads — 16 segments per file
- Live progress bars with speed and size info
- Pause and resume downloads
- Drag a queued download somewhere else in the queue — or move it with ⌥↑ / ⌥↓
- A detail panel on every row — where the bytes come from, where they land, how many sockets are open, and every peer of a torrent
- Delete a download, and optionally move the file it wrote to the Trash
- Retry a failed download — the row says why it failed
- Queued and unfinished downloads survive a restart
- A notification when a download finishes, and a count on the dock icon for the ones that landed while you were elsewhere
- Catch a file URL from the clipboard, or send any page from the browser with a bookmarklet
- Optional smart folders — new downloads sorted into Video, Music, Documents, and Archives by file type
- Three traffic modes — Full, Medium, Light — switched from the status bar, over everything at once or over the one download that is saturating the line
- Settings: download folder, what Medium and Light mean, how many files run at once, clipboard catching, and both switches above
- Torrents you can take part of: tick the files inside one, and see when a finished torrent is still seeding — with rules for when it stops, or a button
- Status badges: Downloading, Seeding, Merging, Queued, Paused, Complete, Error

## Requirements

| Tool | Version | Install |
|------|---------|---------|
| [Rust](https://www.rust-lang.org/) | 1.70+ | `brew install rust` |
| [Node.js](https://nodejs.org/) | 18+ | `brew install node` |

aria2 isn't on that list. Garia builds its own and bundles it — see below. Video downloads want two more, both optional:

| Tool | Why | Install |
|------|-----|---------|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Reads a video page and resolves it into media URLs | `brew install yt-dlp` — or nothing, if you have a `python3` 3.10+, which the bundled copy runs under |
| [ffmpeg](https://ffmpeg.org/) | Merges the separate video and audio streams every large site now serves | `brew install ffmpeg` |

Without yt-dlp, a video page downloads as a page. Without ffmpeg, only qualities that arrive as a single file are offered — which on YouTube means audio only. Settings says which of the two garia found.

## Development

Install JavaScript dependencies:

```sh
npm install
```

Start the app in development mode (hot-reloads the frontend, recompiles Rust on changes):

```sh
npm run tauri dev
```

> The first run takes a few minutes while Cargo compiles the Tauri runtime and `scripts/build-aria2-sidecar.sh` builds aria2. Subsequent runs are fast — the script is a no-op once the binary exists.

## The bundled aria2

`npm run sidecar` (run for you before every dev run and build) compiles aria2 from the upstream 1.37.0 release into `src-tauri/binaries/`, and Tauri copies it into the app bundle.

Homebrew's `aria2c` links six Homebrew dylibs, so it stops working the moment it leaves the machine that installed it. The bundled build links nothing but the OS — AppleTLS for HTTPS, CommonCrypto for hashing, the system zlib — which is what makes it safe to ship. The script refuses to install a binary that links anything else.

Trimming those dependencies drops Metalink, SFTP, Firefox cookie import, and async DNS. Garia uses none of them. HTTP, HTTPS, and BitTorrent are all in.

To build for the other Mac architecture, pass a target triple:

```sh
npm run sidecar -- x86_64-apple-darwin
```

At runtime the bundled binary wins, and a system `aria2c` on `PATH` is the fallback.

## The bundled yt-dlp

`scripts/fetch-ytdlp-sidecar.sh` (part of `npm run sidecar`) downloads yt-dlp's 3 MB zipapp into `src-tauri/resources/`, checksum-verified against the release's own `SHA2-256SUMS`.

The order is the opposite of aria2's: **a yt-dlp on `PATH` wins, and the bundled copy is the fallback.** aria2 is stable and the bundled build is the one garia knows; yt-dlp breaks whenever a site changes and ships a fix within days, so the user's own copy — the one that gets updated — is always the better bet.

The zipapp needs a `python3` 3.10 or newer, which macOS does not provide: `/usr/bin/python3` is 3.9, and yt-dlp dropped it. Garia looks past it to Homebrew and python.org installs. The alternative was one of the standalone builds, and both are worse: the 37 MB onefile re-extracts itself on every run, which macOS then rescans — 22 seconds per probe, measured — and the onedir build that fixes the speed weighs 124 MB unpacked.

## Video downloads

Paste a video page into the add dialog and garia asks yt-dlp what is on it, then offers the qualities aria2 can actually fetch — plain HTTP only, since handing aria2 an HLS or DASH URL downloads the playlist rather than the video. A URL that already names a file is never probed.

Large sites no longer serve video and audio in one file: YouTube's 53 formats include not a single complete one. So a merged quality is queued as **two** downloads that share **one row** — one name, one progress bar, one status — and when both land, ffmpeg stitches them with `-c copy` (a container rewrite, not a re-encode) and the halves go to the Trash. The pairing is written to `localStorage` along with both paths, so a quit mid-download still merges on the next launch, even though aria2 forgets a finished download when it restarts.

Failed video rows offer Retry, which re-reads the page rather than re-queueing the URL: the media URLs sites hand out expire, often within hours.

## Build

Produce an optimised, self-contained `.app` bundle in `src-tauri/target/release/bundle/`:

```sh
npm run tauri build
```

## Project Structure

```
garia/
├── src/                  # Frontend (HTML, CSS, JS)
│   ├── index.html        # App shell
│   ├── styles.css        # Styles and animations
│   └── main.js           # aria2 JSON-RPC client + UI logic
├── scripts/              # sidecar scripts — builds aria2, fetches yt-dlp
└── src-tauri/            # Tauri / Rust backend
    ├── binaries/         # Bundled aria2c (built, not committed)
    ├── resources/        # Bundled yt-dlp zipapp (fetched, not committed)
    ├── tests/fixtures/   # Real yt-dlp output, for the parser's unit tests
    ├── src/
    │   ├── lib.rs        # App setup — spawns and stops aria2
    │   ├── catch.rs      # Clipboard file URLs and garia://add?url=…
    │   └── main.rs       # Binary entry point
    ├── Cargo.toml        # Rust dependencies
    └── tauri.conf.json   # Tauri configuration
```

## How It Works

Garia communicates with aria2 via its built-in JSON-RPC interface on `localhost:6800`, falling back to a free port when something else already holds that one. The Rust backend spawns `aria2c` when the app opens and stops it on exit; if a crash ever leaves one running, the next launch recognises it by the pid it recorded and shuts it down before starting fresh. The frontend polls aria2 every second to refresh download progress.

Settings live in `settings.json` beside the session file. Saving them writes the file and pushes the three aria2 ones — folder, speed cap, concurrency — into the running aria2, so nothing needs a restart; the next launch starts aria2 with them directly.

The speed cap is a mode rather than a number to remember: Full is aria2's own no-limit, and Medium and Light are two speeds the user defines in Settings and switches between from the status bar — `max-overall-download-limit`, derived from the mode rather than set beside it, so the two can never disagree. A settings file written before the modes existed keeps its cap: it becomes what Medium means, and the app comes up capped exactly as it was left. The same three are aimed at a single download from its detail panel, which is `max-download-limit` on that gid — both halves of a merged video, since the row is two downloads. aria2 keeps that option in the session file, so a cap set in one run is still in force in the next; the list asks `aria2.getOption` once per unfinished download to find the ones it did not set itself, and says so on the row.

Every new download also names its folder explicitly rather than relying on aria2's global one, and that is what smart folders route with: the extension in the URL picks `Video`, `Music`, `Documents`, or `Archives` inside the download folder, and anything unrecognised — along with every torrent and magnet, which don't name their files until they start — lands in the folder itself. Nothing already on disk ever moves.

aria2 has no status for a torrent that has finished downloading and is still uploading — it stays `active`, with `seeder` set, and looks in every list like a download stuck at 100%. Garia gives that its own status, section and filter: a seeding row reports what it has shared and the ratio it has reached rather than a percentage and an ETA, and it announces itself as finished when its files land, not when the seeding ends. When to stop is two numbers in Settings — a share ratio and a time — and because aria2 takes neither on a download that is already running, they are set at launch and again on each torrent as it is added. Stopping by hand is `aria2.remove`: the seeding *is* the download still running, so ending it is a removal, and a removed torrent with every byte present is filed as complete rather than lost.

The files inside a torrent are ticked in the detail panel, which is `--select-file` for that download. aria2 refuses the option on a download it is actively working, so applying one pauses the torrent, changes it, and starts it again — a force-pause, then a poll until the status really is paused, because "paused" is a state to arrive at rather than a return value. Ticking a file back on is the same call, and aria2 starts fetching what it skipped.

Clicking a row opens its detail panel, which asks aria2 for the full key set — the source URL, the destination path, the live connection count, the piece layout — for that one download only, so the list's own poll stays as narrow as it was. While it's open it refreshes off the same one-second tick: `aria2.getServers` for the servers an HTTP download is actually pulling from, `aria2.getPeers` for a torrent's peers, both asked for only while the download is running, because aria2 answers with an error otherwise. A merged video shows as what it is — the page it came from and the file it will become, then each half with its own URL, path and connections. Copy buttons go through Rust rather than the webview's clipboard, which also means the clipboard watcher on the other side knows to ignore what garia itself just wrote.

A queued row can be dragged to a different place in the queue, which is `aria2.changePosition` underneath. The position it sends is not the row's place on screen: aria2's queue holds paused downloads too — they keep their slot without taking a turn — and the list shows those in a section of their own. So the drop is read off its neighbours instead. The row it was dropped above is looked up in the queue that `tellWaiting` last reported, and that index is the position. A merged video is two downloads in one row, so it moves as two, back to front, because aria2 renumbers the queue on every move. The row goes where it was put before aria2 is asked, and the list holds still while a row is in hand — a drag that waited on a round trip would drop the row back for a tick, which reads as a refusal. Only queued rows move: a running download has already left the queue, and a paused one is not waiting for a turn.

Completion is noticed by the same one-second poll that drives the progress bars: a download that was not `complete` on the previous tick and is now gets a notification, and — if the window wasn't focused — adds one to the dock badge, which clears the moment you come back to it.

A copied file URL — an `.iso`, a `.zip`, a magnet — is offered as a banner rather than queued on the spot, because copying is not the same as asking. The first clipboard contents at launch are ignored, so a leftover copy doesn't greet you. Anything sent on purpose through `garia://add?url=…` (the bookmarklet in Settings, or an extension later) is queued, or opened on the quality picker when it's a video page.

The `garia://` scheme is declared in `src-tauri/Info.plist`, which Tauri merges into the bundle. macOS only routes the scheme to an app it has registered, so the bookmarklet works from `tauri build` output — not from `tauri dev`, where the binary isn't a bundle.

Every RPC call is authenticated with a secret generated at launch and injected by the Rust backend, so nothing else on the machine — including a web page in your browser — can drive the download engine. Unfinished downloads are written to `session.txt` in the app's data directory and read back at startup.

## Test Downloads
Here are some sample files you can use to test Garia:
Paste any of these into the app — picked for being fast, reliable public servers:

| Size | URL |
|------|-----|
| 100 MB | `https://proof.ovh.net/files/100Mb.dat` |
| 1 GB | `https://proof.ovh.net/files/1Gb.dat` |
| ~650 MB | `https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-12.10.0-amd64-netinst.iso` |

The OVH ones (`proof.ovh.net`) are speed-test files — they'll download at your full connection speed so the progress bar moves fast and you can see it clearly. Start with the 100 MB one.
