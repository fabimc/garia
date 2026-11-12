# Building Garia

Garia is a Linux desktop app. The [root README](../README.md) has the short path; this page is the rest — requirements, a release build, signing, and the GitHub Release workflow. The bundled aria2, ffmpeg, and yt-dlp are documented in [Sidecars](Sidecars.md).

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

aria2 and ffmpeg aren't on those lists. Garia builds both and bundles them — see [Sidecars](Sidecars.md). Video downloads want one more:

| Tool | Why | Install |
|------|-----|---------|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Reads a video page and resolves it into media URLs | distro package — or nothing, if you have a `python3` 3.10+, which the bundled copy runs under |

Without yt-dlp, a video page downloads as a page. Settings says which yt-dlp and which ffmpeg Garia is using.

## Development

Install JavaScript dependencies:

```sh
npm install
```

Start the app in development mode (hot-reloads the frontend, recompiles Rust on changes):

```sh
npm run tauri dev
```

The first run takes a few minutes while Cargo compiles the Tauri runtime and the sidecar scripts build aria2 and ffmpeg. Subsequent runs are fast — the scripts are no-ops once the binaries exist.

`npm run sidecar` (run for you before every `tauri dev`) compiles aria2 and ffmpeg into `src-tauri/binaries/` and fetches yt-dlp into `src-tauri/resources/`. To build for an explicit target triple:

```sh
npm run sidecar -- x86_64-unknown-linux-gnu
```

## Building a release

Produce an AppImage and a `.deb`:

```sh
npm run tauri build
```

Artifacts land under `src-tauri/target/release/bundle/appimage/` and `…/deb/`. Prefer the `.deb` when you want `garia://`, magnet, and `.torrent` file associations installed by the package manager; the AppImage is the portable single-file option. Packages read `bundle.icon` in `src-tauri/tauri.conf.json` (`32x32`, `128x128`, `128x128@2x`, `icon.png`).

## App icon

Master art is `app-icon.png` at the repo root (1024×1024 RGBA, cream rounded tile, transparent outside). To refresh from new pixel art:

1. Start from a PNG of the helmet (or other mark). Key near-white background to alpha (`R,G,B ≥ ~248` → transparent; soft fringe optional). Prefer nearest-neighbour when scaling pixel art — smooth resampling blurs it.
2. Composite onto the cream tile `(243, 230, 212)` using the existing `app-icon.png` alpha mask for the padding and corner radius, or rebuild an equivalent rounded square with ~10% margin.
3. Write the result to `app-icon.png`, then regenerate the Tauri set:
   ```sh
   npx tauri icon app-icon.png
   ```
   Keep the tracked files under `src-tauri/icons/` (drop any untracked `ios/` / `android/` / `64x64.png` and the `icon.icns` / `icon.ico` the CLI may also emit).
4. Regenerate extension icons (`extensions/garia/icons/{16,32,48,128}.png`), site favicons / `icon-512` / touch icon, and the in-app `src/assets/logo.png` (helmet only, transparent — no cream tile) with nearest-neighbour from the master.

A release build also writes updater artifacts. Those need the updater private key:

```sh
export TAURI_SIGNING_PRIVATE_KEY_PATH="$PWD/.tauri/garia.key"
```

That file is gitignored. Back it up. Losing it means already-installed copies cannot be updated. Put the same value in the GitHub secret `TAURI_SIGNING_PRIVATE_KEY` (the key contents, not the path) when you want CI to sign a release.

## Releasing

1. Bump `version` in `src-tauri/tauri.conf.json` and `package.json`.
2. Tag `v0.1.0` (or whatever the version is) and push the tag.
3. The Release workflow builds the Linux AppImage/`.deb` on CI, signs the updater payload when the key is present, and drafts a GitHub release that includes `latest.json`.
4. Garia → Check for Updates reads that file.

The first published release is what makes Check for Updates have something to find. Until then the menu says it could not check, and a quiet launch check stays quiet.

The Release workflow skips updater signatures until this GitHub Actions secret exists:

| Secret | What |
|--------|------|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `.tauri/garia.key` (the key is local; it is not in GitHub yet) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Only if that key is encrypted |

For an alpha, mark the GitHub release as a pre-release once the draft is up. The workflow currently opens a regular draft (`prerelease: false` in `.github/workflows/release.yml`); tick **Set as a pre-release** on the draft if that is what you are shipping.

## Project structure

```
garia/
├── src/                  # Frontend (HTML, CSS, JS)
│   ├── index.html        # App shell
│   ├── styles.css        # Styles and animations
│   └── main.js           # aria2 JSON-RPC client + UI logic
├── docs/                 # This documentation
├── extensions/garia/     # Browser capture — Chrome and Firefox, unpacked
├── extensions/PRIVACY.md # Store privacy policy
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
    ├── tauri.conf.json   # Shared Tauri configuration
    └── tauri.linux.conf.json
```
