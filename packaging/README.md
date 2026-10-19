# Packaging (post-Tauri)

The iced binary is **`garia`** (`cargo build --release -p garia`). Sidecars live next to it (`aria2c`, `ffmpeg`, `yt-dlp`) — that is what `garia-core` looks for via `current_exe()`.

## Assets in this folder

| File | Purpose |
|------|---------|
| `Info.plist` | macOS app template (`__VERSION__` substituted by pack scripts): schemes, `.torrent`, Services |
| `entitlements.plist` | Hardened-runtime entitlements for a signed Mac `.app` |
| `garia.desktop` | Linux MIME / scheme associations (`.torrent`, `garia://`, `magnet:`) |
| `updater/garia.key.pub` | Public key for a future signed `latest.json` updater |
| `../assets/icons/` | App / tray icons (`icon.icns`, PNGs) |

**Identifier:** `com.fabimc.garia`  
**Product name:** Garia  

## Local packaging

Prerequisites: a release `garia` binary and sidecars from `./scripts/sidecar.sh`.

### macOS (must run on a Mac)

```sh
./scripts/sidecar.sh universal-apple-darwin   # or host triple for single-arch
cargo build --release -p garia --target aarch64-apple-darwin
cargo build --release -p garia --target x86_64-apple-darwin
mkdir -p target/universal
lipo -create \
  target/aarch64-apple-darwin/release/garia \
  target/x86_64-apple-darwin/release/garia \
  -output target/universal/garia

./scripts/pack-macos.sh
# → dist/Garia.app
# → dist/Garia_<ver>_universal.dmg
# → dist/Garia_universal.app.tar.gz
```

Single-arch (this machine only):

```sh
./scripts/sidecar.sh
cargo build --release -p garia
./scripts/pack-macos.sh --arch-label "$(uname -m)"
```

Optional signing / notarization: set `APPLE_CERTIFICATE` (base64 `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and for notarization `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`. Without them the DMG is still produced unsigned.

### Linux

```sh
./scripts/sidecar.sh
cargo build --release -p garia
./scripts/pack-linux-deb.sh          # → dist/garia_<ver>_amd64.deb
./scripts/pack-linux-appimage.sh     # → dist/Garia-<ver>-x86_64.AppImage
```

The AppImage script downloads `linuxdeploy` / `appimagetool` into `.cache/appimage-tools/` on first use. Set `APPIMAGE_EXTRACT_AND_RUN=1` on hosts without FUSE (CI does).

`.deb` installs under `/usr/lib/garia/` with `/usr/bin/garia` → that directory so sidecars resolve correctly. Runtime Depends: GTK 3, libxdo, Ayatana AppIndicator, OpenSSL, zlib, Python ≥ 3.10 (for the yt-dlp zipapp).

## What CI publishes

On a `v*` tag, `.github/workflows/release.yml` builds Mac + Linux in parallel, then one `publish` job opens a **single draft** release with:

| Artifact | Notes |
|----------|--------|
| `Garia_<ver>_universal.dmg` | Homebrew cask URL shape |
| `Garia_universal.app.tar.gz` | `.app` for updater / inspection |
| `garia-<ver>-macos-universal.tar.gz` | Flat binary + sidecars |
| `garia_<ver>_amd64.deb` | Debian/Ubuntu |
| `Garia-<ver>-x86_64.AppImage` | Portable Linux |
| `garia-<ver>-linux-x86_64.tar.gz` | Flat binary + sidecars |
| `*.SHA256SUMS` | Checksums beside each family |

## Gaps / follow-ups

- **Apple notarization** — wired when `APPLE_*` secrets are present; otherwise unsigned DMG (cask caveats still apply: `xattr -dr com.apple.quarantine …`).
- **Signed updater** — pubkey is here; private key stays offline (`garia.key` gitignored). Check for Updates is still informational until download/apply is signed.
- **Windows** — out of scope.
