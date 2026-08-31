# Garia

A lightweight desktop download manager built on top of [aria2](https://aria2.github.io/), wrapped in a [Tauri](https://tauri.app/) native app.

Garia manages aria2 automatically — it starts and stops the aria2 process alongside the app, so you never have to touch the command line to download a file.

## Features

- Add downloads by URL, magnet link, or `.torrent` file
- Multi-connection downloads — 16 segments per file
- Live progress bars with speed and size info
- Pause and resume downloads
- Queued and unfinished downloads survive a restart
- Status badges: Downloading, Queued, Paused, Complete, Error

## Requirements

| Tool | Version | Install |
|------|---------|---------|
| [aria2](https://aria2.github.io/) | any | `brew install aria2` |
| [Rust](https://www.rust-lang.org/) | 1.70+ | `brew install rust` |
| [Node.js](https://nodejs.org/) | 18+ | `brew install node` |

## Development

Install JavaScript dependencies:

```sh
npm install
```

Start the app in development mode (hot-reloads the frontend, recompiles Rust on changes):

```sh
npm run tauri dev
```

> The first run takes a few minutes while Cargo compiles the Tauri runtime. Subsequent runs are fast.

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
└── src-tauri/            # Tauri / Rust backend
    ├── src/
    │   ├── lib.rs        # App setup — spawns and stops aria2
    │   └── main.rs       # Binary entry point
    ├── Cargo.toml        # Rust dependencies
    └── tauri.conf.json   # Tauri configuration
```

## How It Works

Garia communicates with aria2 via its built-in JSON-RPC interface on `localhost:6800`, falling back to a free port when something else already holds that one. The Rust backend spawns `aria2c` when the app opens and stops it on exit; if a crash ever leaves one running, the next launch recognises it by the pid it recorded and shuts it down before starting fresh. The frontend polls aria2 every second to refresh download progress.

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
