# Garia

A lightweight desktop download manager built on top of [aria2](https://aria2.github.io/), wrapped in a [Tauri](https://tauri.app/) native app.

Garia manages aria2 automatically — it ships its own copy inside the app and starts and stops it alongside the window, so you never have to touch the command line to download a file.

## Features

- Add downloads by URL, magnet link, or `.torrent` file — typed, or dropped on the window
- Multi-connection downloads — 16 segments per file
- Live progress bars with speed and size info
- Pause and resume downloads
- Delete a download, and optionally move the file it wrote to the Trash
- Retry a failed download — the row says why it failed
- Queued and unfinished downloads survive a restart
- A notification when a download finishes, and a count on the dock icon for the ones that landed while you were elsewhere
- Optional smart folders — new downloads sorted into Video, Music, Documents, and Archives by file type
- Settings: download folder, an overall speed limit, how many files run at once, and both switches above
- Status badges: Downloading, Queued, Paused, Complete, Error

## Requirements

| Tool | Version | Install |
|------|---------|---------|
| [Rust](https://www.rust-lang.org/) | 1.70+ | `brew install rust` |
| [Node.js](https://nodejs.org/) | 18+ | `brew install node` |

aria2 isn't on that list. Garia builds its own and bundles it — see below.

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
├── scripts/              # aria2 sidecar build script
└── src-tauri/            # Tauri / Rust backend
    ├── binaries/         # Bundled aria2c (built, not committed)
    ├── src/
    │   ├── lib.rs        # App setup — spawns and stops aria2
    │   └── main.rs       # Binary entry point
    ├── Cargo.toml        # Rust dependencies
    └── tauri.conf.json   # Tauri configuration
```

## How It Works

Garia communicates with aria2 via its built-in JSON-RPC interface on `localhost:6800`, falling back to a free port when something else already holds that one. The Rust backend spawns `aria2c` when the app opens and stops it on exit; if a crash ever leaves one running, the next launch recognises it by the pid it recorded and shuts it down before starting fresh. The frontend polls aria2 every second to refresh download progress.

Settings live in `settings.json` beside the session file. Saving them writes the file and pushes the three aria2 ones — folder, speed cap, concurrency — into the running aria2, so nothing needs a restart; the next launch starts aria2 with them directly.

Every new download also names its folder explicitly rather than relying on aria2's global one, and that is what smart folders route with: the extension in the URL picks `Video`, `Music`, `Documents`, or `Archives` inside the download folder, and anything unrecognised — along with every torrent and magnet, which don't name their files until they start — lands in the folder itself. Nothing already on disk ever moves.

Completion is noticed by the same one-second poll that drives the progress bars: a download that was not `complete` on the previous tick and is now gets a notification, and — if the window wasn't focused — adds one to the dock badge, which clears the moment you come back to it.

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
