# Building Garia

Garia is a desktop app for macOS and Linux (iced + tiny-skia). The [root README](../README.md) has the short path; this page is the rest — requirements, a release build, and the GitHub Release workflow. The bundled aria2, ffmpeg, and yt-dlp are documented in [Sidecars](Sidecars.md). Packaging helpers live in [`packaging/`](../packaging/).

## Requirements

### macOS

| Tool | Version | Install |
|------|---------|---------|
| macOS | 11.0+ | — |
| [Xcode Command Line Tools](https://developer.apple.com/xcode/) | — | `xcode-select --install` |
| [Rust](https://www.rust-lang.org/) | 1.70+ | `brew install rust` |

### Linux

| Tool | Version | Install (Debian/Ubuntu) |
|------|---------|-------------------------|
| [Rust](https://www.rust-lang.org/) | 1.70+ | [rustup](https://rustup.rs/) |
| GTK + tray build deps | — | see below |

```sh
sudo apt-get install -y \
  build-essential curl wget file \
  libxdo-dev libssl-dev zlib1g-dev pkg-config \
  libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev python3
```

No WebKitGTK. The UI is iced (tiny-skia), not a WebView.

aria2 and ffmpeg aren't on those lists. Garia builds both and places them in `binaries/` — see [Sidecars](Sidecars.md). Video downloads want one more:

| Tool | Why | Install |
|------|-----|---------|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Reads a video page and resolves it into media URLs | `brew install yt-dlp` / distro package — or nothing, if you have a `python3` 3.10+, which the bundled copy runs under |

Without yt-dlp, a video page downloads as a page. Settings shows probe status for the tools Garia finds.

## Development

```sh
./scripts/sidecar.sh    # optional; builds/fetches sidecars into binaries/ and resources/
cargo run -p garia
```

Or release-optimised:

```sh
cargo run -p garia --release
```

`./scripts/sidecar.sh` (also available as `npm run sidecar` if you keep Node around for extension scripts) compiles aria2 and ffmpeg into `binaries/` and fetches yt-dlp into `resources/`. To build for another architecture, or both Mac chips at once:

```sh
./scripts/sidecar.sh x86_64-apple-darwin
./scripts/sidecar.sh universal-apple-darwin
./scripts/sidecar.sh x86_64-unknown-linux-gnu
```

## Building a release

### Binary

```sh
cargo build --release -p garia
# → target/release/garia
```

Place `aria2c`, `ffmpeg`, and `yt-dlp` next to the binary (or keep system copies on `PATH`). The release workflow stages a tarball that way.

### macOS universal

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
./scripts/sidecar.sh universal-apple-darwin
cargo build --release -p garia --target aarch64-apple-darwin
cargo build --release -p garia --target x86_64-apple-darwin
lipo -create \
  target/aarch64-apple-darwin/release/garia \
  target/x86_64-apple-darwin/release/garia \
  -output garia-universal
```

A signed `.app` / `.dmg` with schemes from `packaging/Info.plist` is a packaging follow-up (see [`packaging/README.md`](../packaging/README.md)).

### Linux packages

AppImage / `.deb` are not produced by the current CI. Ship the release tarball for now; use `packaging/garia.desktop` when you wire a `.deb` so `garia://`, magnet, and `.torrent` associations install with the package.

## Updater

The iced shell checks GitHub `latest.json` (version + notes + URL). **Signed download/apply is not wired yet** — Check for Updates is informational. The public key for a future signed updater lives at `packaging/updater/garia.key.pub`. Keep the private key offline; losing it means already-installed copies cannot verify updates.

## Releasing

1. Bump `version` in `crates/garia/Cargo.toml` (and `package.json` if you use it for extension versioning).
2. Tag `v0.2.0` (or whatever the version is) and push the tag.
3. The Release workflow builds Linux x86_64 and macOS universal tarballs (binary + sidecars) and drafts a GitHub release.
4. Garia → Check for Updates reads `latest.json` when you publish one in that format.

Publishing the draft is also what the Homebrew tap can download once a DMG asset exists again. The [homebrew-garia](https://github.com/fabimc/homebrew-garia) cask historically tracked `Garia_<version>_universal.dmg` — update the tap when packaging returns.

Optional GitHub Actions secrets (Mac signing / notarization — unused until `.app` packaging returns):

| Secret | What |
|--------|------|
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Password for that `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: …` |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | Notarization (app-specific password) |
| `HOMEBREW_TAP_TOKEN` | Optional. A PAT that can dispatch to `fabimc/homebrew-garia` |

## Project structure

```
garia/
├── crates/
│   ├── garia-core/       # Domain: aria2, catch, ftp, settings, video, …
│   ├── garia-platform/   # Mac/Linux OS integration (tray, dialogs, …)
│   ├── garia-ui/         # iced UI
│   └── garia/            # Binary entry (`garia`)
├── assets/icons/         # App / tray icons
├── packaging/            # Info.plist, .desktop, entitlements, updater pubkey
├── docs/                 # This documentation
├── extensions/garia/     # Browser capture
├── scripts/              # sidecar scripts — builds aria2 and ffmpeg, fetches yt-dlp
├── binaries/             # Built aria2c / ffmpeg (gitignored)
└── resources/            # Fetched yt-dlp zipapp (gitignored)
```
