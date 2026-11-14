# Building Garia

Garia is a Linux desktop app. The [root README](../README.md) has the short path; this page covers requirements, development, release builds, and the GitHub Release workflow. The bundled aria2, ffmpeg, and yt-dlp are documented in [Sidecars](Sidecars.md).

## Requirements

| Tool | Version | Install (Debian/Ubuntu) |
|------|---------|-------------------------|
| [Rust](https://www.rust-lang.org/) | 1.70+ | [rustup](https://rustup.rs/) |
| [Node.js](https://nodejs.org/) | 18+ | distro package or nvm |
| WebKitGTK + build deps | — | see below |

```sh
sudo apt-get install -y \
  build-essential curl wget file \
  libxdo-dev libssl-dev zlib1g-dev pkg-config \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf
```

Garia builds and bundles aria2 and ffmpeg. Video downloads use the bundled yt-dlp zipapp or one on `PATH`; the zipapp needs Python 3.10 or newer.

## Development

Install JavaScript dependencies:

```sh
npm install
```

Start the app in development mode:

```sh
npm run tauri dev
```

The first run takes a few minutes while Cargo compiles Tauri and the sidecar scripts build aria2 and ffmpeg. Subsequent runs reuse those binaries.

`npm run sidecar` builds sidecars for the current Linux host and fetches yt-dlp. Cross-compiling sidecars is not supported.

## Building a release

```sh
npm run tauri build
```

The build produces an AppImage and a `.deb` under `src-tauri/target/release/bundle/appimage/` and `src-tauri/target/release/bundle/deb/`. Prefer the `.deb` when you want the package manager to register `garia://`, magnet, and `.torrent` associations; the AppImage is the portable single-file option. Releases also include `garia-<version>-linux-x86_64.tar.gz` for Arch-based distributions.

The Tauri icon set uses the PNG files under `src-tauri/icons/`. To regenerate them from the master artwork:

```sh
npx tauri icon app-icon.png
```

Keep the tracked files under `src-tauri/icons/`; the CLI may also emit platform assets that are not used by Garia.

A release build can create updater artifacts when `TAURI_SIGNING_PRIVATE_KEY` is configured:

```sh
export TAURI_SIGNING_PRIVATE_KEY_PATH="$PWD/.tauri/garia.key"
```

Keep that file out of Git and back it up. Set the key contents in the GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` to sign CI releases; set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` only when the key is encrypted. Without the key, the release workflow builds packages without updater signatures.

## Releasing

1. Bump `version` in `src-tauri/tauri.conf.json` and `package.json`.
2. Tag the release as `v<version>` and push the tag.
3. The Release workflow builds the Linux AppImage, `.deb`, and Arch-compatible tarball, and drafts a GitHub release. When the updater key is present it also signs the update payload and publishes `latest.json`.
4. Garia → Check for Updates reads `latest.json`.

The first published release is what makes Check for Updates have something to find. Until then the menu says it could not check, and a quiet launch check stays quiet.

For an alpha, mark the GitHub release as a pre-release after the draft is up; the workflow opens a regular draft by default.

## Project structure

```
garia/
├── src/                  # Frontend (HTML, CSS, JS)
├── docs/                 # This documentation
├── extensions/garia/     # Chromium and Firefox browser capture
├── scripts/              # Linux sidecar builders and packagers
└── src-tauri/            # Tauri / Rust backend and configuration
```
