# Building Garia

Garia is a desktop app for macOS and Linux. The [root README](../README.md) has the short path; this page is the rest — requirements, a release build, signing, notarization, and the GitHub Release workflow. The bundled aria2, ffmpeg, and yt-dlp are documented in [Sidecars](Sidecars.md).

## Requirements

### macOS

| Tool | Version | Install |
|------|---------|---------|
| macOS | 11.0+ | — |
| [Xcode Command Line Tools](https://developer.apple.com/xcode/) | — | `xcode-select --install` |
| [Rust](https://www.rust-lang.org/) | 1.70+ | `brew install rust` |
| [Node.js](https://nodejs.org/) | 18+ | `brew install node` |

### Linux

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
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Reads a video page and resolves it into media URLs | `brew install yt-dlp` / distro package — or nothing, if you have a `python3` 3.10+, which the bundled copy runs under |

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

`npm run sidecar` (run for you before every `tauri dev`) compiles aria2 and ffmpeg into `src-tauri/binaries/` and fetches yt-dlp into `src-tauri/resources/`. To build for another architecture, or both Mac chips at once:

```sh
npm run sidecar -- x86_64-apple-darwin
npm run sidecar -- universal-apple-darwin
npm run sidecar -- x86_64-unknown-linux-gnu
```

## Building a release

### macOS

Produce an optimised `.app` and `.dmg` in `src-tauri/target/release/bundle/`:

```sh
npm run tauri build
```

That first build also compiles the Intel sidecars and `lipo`s them with the Apple Silicon ones when you ask for a universal target. The Rust side of a *universal* app is a second target:

```sh
rustup target add x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

The result lands under `src-tauri/target/universal-apple-darwin/release/bundle/` and runs natively on both chips. A release tag does this on CI.

### Linux

On Linux the same command produces an AppImage and a `.deb`:

```sh
npm run tauri build
```

Artifacts land under `src-tauri/target/release/bundle/appimage/` and `…/deb/`. Prefer the `.deb` when you want `garia://`, magnet, and `.torrent` file associations installed by the package manager; the AppImage is the portable single-file option.

A release build also writes updater artifacts. Those need the updater private key:

```sh
export TAURI_SIGNING_PRIVATE_KEY_PATH="$PWD/.tauri/garia.key"
```

That file is gitignored. Back it up. Losing it means already-installed copies cannot be updated. Put the same value in the GitHub secret `TAURI_SIGNING_PRIVATE_KEY` (the key contents, not the path) when you want CI to sign a release.

## Signing and notarization (macOS)

Gatekeeper will warn on an unsigned `.app`. Notarization wants a **Developer ID Application** certificate from an [Apple Developer](https://developer.apple.com) account. Garia is not going to the App Store — the translucent sidebar uses a private API — so Developer ID is the right kind of certificate.

With the certificate in the login keychain:

```sh
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="YOURTEAMID"
npm run tauri build
```

Tauri picks the Developer ID identity, signs with the hardened runtime and `src-tauri/entitlements.plist`, and submits the bundle for notarization.

## Releasing

1. Bump `version` in `src-tauri/tauri.conf.json` and `package.json`.
2. Tag `v0.1.0` (or whatever the version is) and push the tag.
3. The Release workflow builds a universal Mac app and Linux AppImage/`.deb` on CI, signs the updater payload when the key is present, and drafts a GitHub release that includes `latest.json`.
4. Garia → Check for Updates reads that file.

The first published release is what makes Check for Updates have something to find. Until then the menu says it could not check, and a quiet launch check stays quiet.

Publishing the draft is also what the Homebrew tap can download. The [homebrew-garia](https://github.com/fabimc/homebrew-garia) cask tracks `Garia_<version>_universal.dmg`. After the release is public, the tap's **Update cask** workflow pins the version and SHA (daily cron, or immediately if this repo has a `HOMEBREW_TAP_TOKEN` secret that can dispatch to that tap). Homebrew 7 also needs `brew trust fabimc/garia` once per machine.

The Release workflow is a no-op for signing until these GitHub Actions secrets exist:

| Secret | What |
|--------|------|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `.tauri/garia.key` (the key is local; it is not in GitHub yet) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Only if that key is encrypted |
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Password for that `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: …` |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | Notarization (app-specific password) |
| `HOMEBREW_TAP_TOKEN` | Optional. A PAT that can dispatch to `fabimc/homebrew-garia` |

For an alpha, mark the GitHub release as a pre-release once the draft is up. The workflow currently opens a regular draft (`prerelease: false` in `.github/workflows/release.yml`); tick **Set as a pre-release** on the draft if that is what you are shipping.

## Project structure

```
garia/
├── src/                  # Frontend (HTML, CSS, JS)
│   ├── index.html        # App shell
│   ├── styles.css        # Styles and animations
│   └── main.js           # aria2 JSON-RPC client + UI logic
├── docs/                 # This documentation
├── extensions/garia/     # Browser capture — Chrome and Firefox unpacked; Safari via the converter script
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
    ├── tauri.macos.conf.json
    └── tauri.linux.conf.json
```
