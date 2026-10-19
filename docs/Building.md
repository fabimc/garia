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

### macOS universal + DMG

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
./scripts/sidecar.sh universal-apple-darwin
cargo build --release -p garia --target aarch64-apple-darwin
cargo build --release -p garia --target x86_64-apple-darwin
mkdir -p target/universal
lipo -create \
  target/aarch64-apple-darwin/release/garia \
  target/x86_64-apple-darwin/release/garia \
  -output target/universal/garia
./scripts/pack-macos.sh
# → dist/Garia_<ver>_universal.dmg , dist/Garia.app , dist/Garia_universal.app.tar.gz
```

`pack-macos.sh` embeds `packaging/Info.plist` (schemes + `.torrent`), sidecars next to the binary inside `Contents/MacOS/`, and signs/notarizes when `APPLE_*` env vars are set. Details: [`packaging/README.md`](../packaging/README.md).

### Linux packages

```sh
./scripts/sidecar.sh
cargo build --release -p garia
./scripts/pack-linux-deb.sh       # → dist/garia_<ver>_amd64.deb
./scripts/pack-linux-appimage.sh  # → dist/Garia-<ver>-x86_64.AppImage
```

Both installers ship `packaging/garia.desktop` associations (`garia://`, magnet, `.torrent`). The `.deb` places binaries under `/usr/lib/garia/` with a `/usr/bin/garia` symlink so sidecar discovery still works.

## Updater

The iced shell checks GitHub `latest.json` (version + notes + URL). **Signed download/apply is not wired yet** — Check for Updates is informational. The public key for a future signed updater lives at `packaging/updater/garia.key.pub`. Keep the private key offline; losing it means already-installed copies cannot verify updates.

## Releasing

1. Bump **`[workspace.package] version`** in the root `Cargo.toml`. All crates (`garia`, `garia-ui`, `garia-core`, `garia-platform`) use `version.workspace = true`, so About / Check for Updates (`APP_VERSION` from `garia-ui`) stay in sync with the binary. Also bump `package.json` (and the extension manifests) if those should match.
2. Tag `v0.2.0` (or whatever the version is) and push the tag.
3. The Release workflow builds Linux (tarball + `.deb` + AppImage) and macOS (tarball + universal DMG + `.app` archive) in parallel, then opens **one** draft GitHub release with all assets.
4. Garia → Check for Updates reads `latest.json` when you publish one in that format.

Publishing the draft is what the Homebrew tap downloads. The [homebrew-garia](https://github.com/fabimc/homebrew-garia) cask expects `Garia_<version>_universal.dmg`.

Optional GitHub Actions secrets (Mac signing / notarization — release job skips quietly when unset):

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
├── scripts/              # sidecars + pack-macos / pack-linux-deb / pack-linux-appimage
├── binaries/             # Built aria2c / ffmpeg (gitignored)
└── resources/            # Fetched yt-dlp zipapp (gitignored)
```
