# Garia

A lightweight desktop download manager built on top of [aria2](https://aria2.github.io/), wrapped in a [Tauri](https://tauri.app/) native app.

Garia manages aria2 automatically — it starts and stops the aria2 process alongside the app, so you never have to touch the command line to download a file.

## Features

- Add downloads by URL
- Live progress bars with speed and size info
- Pause and resume downloads
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

Garia communicates with aria2 via its built-in JSON-RPC interface on `localhost:6800`. The Rust backend spawns `aria2c` when the app opens and kills it cleanly on exit. The frontend polls aria2 every second to refresh download progress.
