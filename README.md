# Garia

A lightweight desktop download manager built on top of [aria2](https://aria2.github.io/), wrapped in a [Tauri](https://tauri.app/) native app.

Garia manages aria2 automatically — it ships its own copy inside the app and starts it with the app. Closing the window leaves downloads running; Quit is what stops them. You never have to touch the command line to download a file.

## Features

- Add downloads by URL, magnet link, or `.torrent` file — typed, dropped on the window, or opened from Finder
- Close the window and downloads keep going; Quit (⌘Q) is what stops them
- A real Mac menu — New Download (⌘N), Open Torrent (⌘O), Settings (⌘,)
- The window comes back where you left it; launch at login is a switch in Settings
- File → Open Download Folder, and the same verbs stay in the menu while the window is hidden
- Select rows, right-click them, and use the keyboard — Space pauses, ⌘⌫ deletes, ⌘C copies the URL
- Follows the system appearance, including a translucent sidebar; drag a finished file out to Finder
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
- Downloads behind a login: a saved user name and password per site, custom headers, and a cookie jar exported from the browser
- Checksum verification: paste a hash beside the URL and aria2 checks the file as it arrives — before it starts, while it runs, or against one already on disk
- Remote control: open the aria2 port to the local network and pair a phone by scanning the secret
- Status badges: Downloading, Seeding, Merging, Queued, Paused, Complete, Error

## Requirements

| Tool | Version | Install |
|------|---------|---------|
| [Rust](https://www.rust-lang.org/) | 1.70+ | `brew install rust` |
| [Node.js](https://nodejs.org/) | 18+ | `brew install node` |

aria2 and ffmpeg aren't on that list. Garia builds both and bundles them — see below. Video downloads want one more:

| Tool | Why | Install |
|------|-----|---------|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Reads a video page and resolves it into media URLs | `brew install yt-dlp` — or nothing, if you have a `python3` 3.10+, which the bundled copy runs under |

Without yt-dlp, a video page downloads as a page. Settings says which yt-dlp and which ffmpeg garia is using.

## Development

Install JavaScript dependencies:

```sh
npm install
```

Start the app in development mode (hot-reloads the frontend, recompiles Rust on changes):

```sh
npm run tauri dev
```

> The first run takes a few minutes while Cargo compiles the Tauri runtime and the sidecar scripts build aria2 and ffmpeg. Subsequent runs are fast — the scripts are no-ops once the binaries exist.

## The bundled aria2

`npm run sidecar` (run for you before every dev run and build) compiles aria2 from the upstream 1.37.0 release into `src-tauri/binaries/`, and Tauri copies it into the app bundle.

Homebrew's `aria2c` links six Homebrew dylibs, so it stops working the moment it leaves the machine that installed it. The bundled build links nothing but the OS — AppleTLS for HTTPS, CommonCrypto for hashing, the system zlib — which is what makes it safe to ship. The script refuses to install a binary that links anything else.

Trimming those dependencies drops Metalink, SFTP, Firefox cookie import, and async DNS. Garia uses none of them. HTTP, HTTPS, and BitTorrent are all in.

To build for the other Mac architecture, pass a target triple:

```sh
npm run sidecar -- x86_64-apple-darwin
```

At runtime the bundled binary wins, and a system `aria2c` on `PATH` is the fallback.

## The bundled ffmpeg

`scripts/build-ffmpeg-sidecar.sh` (part of `npm run sidecar`) compiles ffmpeg 9.0.1 into `src-tauri/binaries/` the same way, and it takes about a minute — because almost none of ffmpeg gets built.

Garia asks ffmpeg for exactly one thing: rewrite two finished files into one container with `-c copy`. That is a job for muxers, demuxers, parsers and bitstream filters, and for nothing else — so every encoder, decoder, hardware accelerator, filter and device is configured out, along with the network layer. What is left is 4 MB instead of 70, links nothing but the OS, and is LGPL-2.1 with no GPL parts in it; the script checks all three and refuses to install a binary that fails any of them.

The same target-triple argument cross-builds it. There is no assembly left to assemble once the codecs are gone, so the x86_64 build needs no `nasm` on an Apple Silicon Mac.

As with aria2, the bundled binary wins and a system `ffmpeg` is the fallback — which is what Settings is saying when it names one rather than the other.

## The bundled yt-dlp

`scripts/fetch-ytdlp-sidecar.sh` (part of `npm run sidecar`) downloads yt-dlp's 3 MB zipapp into `src-tauri/resources/`, checksum-verified against the release's own `SHA2-256SUMS`.

The order is the opposite of aria2's: **a yt-dlp on `PATH` wins, and the bundled copy is the fallback.** aria2 is stable and the bundled build is the one garia knows; yt-dlp breaks whenever a site changes and ships a fix within days, so the user's own copy — the one that gets updated — is always the better bet.

The zipapp needs a `python3` 3.10 or newer, which macOS does not provide: `/usr/bin/python3` is 3.9, and yt-dlp dropped it. Garia looks past it to Homebrew and python.org installs. The alternative was one of the standalone builds, and both are worse: the 37 MB onefile re-extracts itself on every run, which macOS then rescans — 22 seconds per probe, measured — and the onedir build that fixes the speed weighs 124 MB unpacked.

## Video downloads

Paste a video page into the add dialog and garia asks yt-dlp what is on it, then offers the qualities aria2 can actually fetch — plain HTTP only, since handing aria2 an HLS or DASH URL downloads the playlist rather than the video. A URL that already names a file is never probed.

Large sites no longer serve video and audio in one file: YouTube's 53 formats include not a single complete one. So a merged quality is queued as **two** downloads that share **one row** — one name, one progress bar, one status — and when both land, ffmpeg stitches them with `-c copy` (a container rewrite, not a re-encode) and the halves go to the Trash. The pairing is written to `localStorage` along with both paths, so a quit mid-download still merges on the next launch, even though aria2 forgets a finished download when it restarts.

Failed video rows offer Retry, which re-reads the page rather than re-queueing the URL: the media URLs sites hand out expire, often within hours.

## Playing a download before it finishes

**Download in order** in Settings switches aria2's piece selector to `inorder`, so a file fills from the beginning instead of wherever a connection happens to be. It is off by default and it is a real trade — the default selector picks pieces to keep connections busy, which is what makes the download fast — and aria2 will not change it on a download already in flight, so it rides on each one as it is added.

A row's detail panel then says how much of the *front* of the file is on disk, and offers to open it. That number comes from aria2's piece bitfield rather than from `completedLength`: a download can be 90% complete with a hole at the beginning, and a percentage would call that playable. What is counted is the contiguous run of pieces from piece zero.

Having the bytes still isn't enough for MP4 and its relatives, which carry an index — the `moov` box — that a player has to read before it can start, and which plenty of encoders write *after* the video. So garia walks the file's top-level boxes as far as the bytes actually go, and only offers to play it once the whole index is there. Matroska, WebM, Ogg and MPEG-TS are built to be read from the first byte and need no such check. (garia's own merged videos are written with `+faststart`, which puts the index in front — so a merged download is playable as soon as it starts arriving.)

## Downloads behind a login

A file behind a sign-in needs one of three things, and garia keeps them in three different places on purpose — because they are not the same promise.

**A password** goes into a netrc file in garia's app data, at `0600`, which aria2 reads for itself: per request, per host, matched by aria2 rather than by garia. It is never an option on a download. That distinction is the whole point of the netrc — a password passed to `aria2.addUri` as `http-passwd` is written verbatim into the session file that keeps unfinished downloads across a quit, and is handed back by `getOption` to anything holding the RPC token. Measured against aria2 1.37, not assumed.

**A header** is a literal aria2 has to put on the request, so it *is* an option on the download, and it does land in the session file — which is how a resume after a quit still gets through, and also means a bearer token in one is written to disk. The dialog says so rather than pretending otherwise.

**A cookie jar** is a path to a `cookies.txt` exported from the browser. Nothing is copied: the file stays where it is, and aria2 matches its cookies to hosts itself.

Two things netrc will not do, both found by trying them. It has no quoting at all — `password "two words"` is read as the literal `"two` — so a password with whitespace in it cannot go in one; garia sends that one as an `Authorization:` header instead and says which of the two it did. And aria2 ignores a netrc that anyone but its owner can read, silently, with no auth header on the wire.

Saving a login **restarts aria2**. Both the netrc and the cookie jar are read once, when it starts: `load-cookies` sent to `aria2.changeGlobalOption` or carried on `addUri` is accepted, answers `OK`, and loads nothing, and a netrc written after aria2 started is a file it has already read. So garia does what quitting and reopening does — saves the session, stops aria2, starts it on the same port, and waits until it answers — and every unfinished download resumes mid-file, the same way it does across a relaunch. Editing only a site's headers changes nothing aria2 reads, and restarts nothing.

A download that fails for want of a login says so: aria2's error 24 is the one failure with a fix inside the app, so the row reads *Needs a login — add one in Settings* rather than *Authorization failed*, and Retry re-queues it with whatever has been saved since.

## Checksum verification

Paste a hash into the add dialog and it goes to aria2 as `--checksum=sha-256=…`. aria2 hashes the bytes as they arrive, so the check costs the download nothing, and it will not file a download as complete unless the digest matches — which is why a *Verified* chip is not a claim garia is making. There is nothing for it to store: a completed download whose `getOption` still carries a `checksum` is a checked one, and the option lives in aria2's session file for as long as the download does.

The field takes what is actually in the clipboard. A bare digest names its own algorithm, because aria2 knows seven of them and each has one digit count — 32 for MD5, 40 for SHA-1, 56, 64, 96, 128 for the SHA-2 family, 8 for Adler-32 — and refuses a `--checksum` whose length and algorithm disagree. So `sha256:…`, `SHA-256 = …`, a whole `<hash>  <filename>` line out of a SHASUMS file, and certutil's two-digit groups all resolve to the one string aria2 takes. A hash that cannot be one says why, and the OK button waits: a `--checksum` aria2 would reject is a download that never starts.

A mismatch is aria2's error 32, which it sends with no message of its own, so the row reads *What arrived doesn't match the checksum*. Every byte is still on disk — aria2 reports `completedLength` 0 and leaves the file and its `.aria2` control file where they are — so deleting the row can take the file with it, and Retry re-runs the check rather than the download: with the control file still there aria2 resumes at the end of a finished file and only hashes it.

The detail panel takes a hash too, and which call it uses depends on when it is asked:

- **While the download runs** — `aria2.changeOption`, which really does apply `checksum` to a download in flight. Most options it accepts and ignores; this is one of the few it doesn't, measured against aria2 1.37.
- **After it has landed** — `changeOption` is refused outright (*Cannot change option for GID#…*), so the download is added again with the same folder, the same name and the hash. aria2 finds every byte already on disk, fetches none of them, and answers with the digest in a fraction of a second. It does ask the server how long the file is first, so a URL that has expired is a check that can no longer be run.

Torrents never see the field. They carry a hash per piece already, and `--checksum` is HTTP and FTP only.

## Remote control

Everything in garia already talks to aria2 over JSON-RPC on a port, so letting an aria2 client on a phone do the same is one launch flag — `--rpc-listen-all=true`, off by default and turned on in Settings. What it is not is one decision. Three things have to change together, and each of them is the reason the card sat in the "bigger swings" tier rather than the quick wins.

**The socket stops being this machine's.** aria2 has no setting between loopback and every interface — there is no "listen on this one" for the RPC port — so turning this on binds `*`, on IPv4 and IPv6 both. And it is launch-only: `rpc-listen-all` sent to `aria2.changeGlobalOption` answers `OK`, leaves the socket bound exactly as it was, and `getGlobalOption` still reports the old value. Measured against aria2 1.37, and the same trap the cookie jar sprang — so this is the second setting that restarts the download engine, and unfinished downloads come back from the session file mid-file.

**The token stops being per-launch.** A secret generated fresh every launch is right for a port only this machine can reach and useless for one a phone is paired with. So while remote control is on the token lives in a `remote-secret` file at `0600` in garia's app data, beside the logins and for the same reason — a credential does not belong in `settings.json`, which the user is invited to read. Turning remote control off *deletes* that file, so every paired device is un-paired rather than merely waiting for the port to come back; turning it on again mints a new one.

**The secret has to reach the other device.** The address and the port are short enough to read off the screen and type. Thirty-two hex characters are not, so Settings draws them as a QR code — the secret alone, not a URL with the secret in it, because clients ask for host, port and token as three separate fields and a token in a URL is a token in a history file. Rust encodes it and hands the frontend a square of modules; the SVG is drawn in the page, black on white whatever else the window is, as one rect per horizontal run rather than one per module.

The address comes off the routing table rather than an interface walk: a UDP socket that has been *connected* has chosen a route and therefore a source address, and connecting a UDP socket sends nothing. The address it is pointed at is in TEST-NET-1, reserved so that it can be named without meaning a real host.

Two things the panel says out loud. The traffic is plain HTTP, so the secret crosses the network in the clear on every request — worth having at home, worth leaving off on a network you don't know. And if something else held aria2's usual port when garia started, the pairing still works but the number can be different next launch.

A browser client such as AriaNg is the one thing this does not reach: aria2 sends no `Access-Control-Allow-Origin` header, and garia does not pass `--rpc-allow-origin-all`, which the Foundations pass deliberately removed. Native clients are unaffected — CORS is a browser rule.

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
├── scripts/              # sidecar scripts — builds aria2 and ffmpeg, fetches yt-dlp
└── src-tauri/            # Tauri / Rust backend
    ├── binaries/         # Bundled aria2c and ffmpeg (built, not committed)
    ├── resources/        # Bundled yt-dlp zipapp (fetched, not committed)
    ├── tests/fixtures/   # Real yt-dlp output, for the parser's unit tests
    ├── src/
    │   ├── lib.rs        # App setup — spawns and stops aria2
    │   ├── catch.rs      # Clipboard file URLs and garia://add?url=…
    │   ├── logins.rs     # Site credentials, and the netrc aria2 reads
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

Credentials are the one kind of setting aria2 will not take while it is running. A netrc and a cookie jar are both read once, at launch, so garia keeps its own store in `logins.json` (at `0600`, holding the passwords) and *derives* the netrc from it — rebuilt at every launch and after every edit, and deleted rather than left empty when the last login goes, so a machine with no logins leaves aria2 reading the user's own `~/.netrc` exactly as it would have. Saving one restarts aria2 on the same port and waits for it to answer; unfinished downloads come back from the session file mid-file, the same as across a relaunch. The frontend is never sent a password — it gets the list with a `hasPassword` flag and the headers to put on a download for a given host, and that is all it can leak.

A copied file URL — an `.iso`, a `.zip`, a magnet — is offered as a banner rather than queued on the spot, because copying is not the same as asking. The first clipboard contents at launch are ignored, so a leftover copy doesn't greet you. Anything sent on purpose through `garia://add?url=…` (the bookmarklet in Settings, or an extension later) is queued, or opened on the quality picker when it's a video page. A `magnet:` link or a `.torrent` file the system opens — Safari, Finder, Open With — is an instruction, the same as the scheme.

The `garia://` and `magnet:` schemes, and `.torrent` as a document type, are declared in `src-tauri/Info.plist` and `tauri.conf.json`. macOS only routes them to an app it has registered, so they work from `tauri build` output — not from `tauri dev`, where the binary isn't a bundle.

On a Mac, the red button and ⌘W hide the window. aria2 keeps running, the dock icon stays, and clicking it (or a `garia://` link) brings the window back. ⌘Q is the only thing that saves the session and stops the engine. The window's size and place survive a quit. Launch at login is a LaunchAgent, turned on from Settings, so an overnight schedule does not wait for you to open the app.

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
