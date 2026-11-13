# Bundled sidecars

Garia ships three tools inside the Linux app so downloads do not depend on system package managers. `npm run sidecar` builds or fetches all three before `tauri dev` and `tauri build`.

Settings → About shows which copy is active at runtime (bundled or system), plus the resolved version and path for each sidecar.

Every download goes through `scripts/download-verified.sh`. It retries dropped connections, checks the SHA-256, and keeps the verified file in `.sidecar-cache/` (gitignored). On CI, the **Sidecars** workflow builds the tools on `master` when a sidecar script changes and caches the result. The Release workflow restores that cache, so a release tag normally skips the build. Its cache key hashes the sidecar scripts.

## The bundled aria2

`npm run sidecar` compiles aria2 from the upstream 1.37.0 release into `src-tauri/binaries/`, and Tauri copies it into the app bundle. The build links against system OpenSSL and zlib; the script checks that it does not depend on unexpected libraries.

Trimming dependencies drops Metalink, SFTP, Firefox cookie import, and async DNS. Garia uses none of them. HTTP, HTTPS, FTP, and BitTorrent are supported.

The sidecar script builds for the current host. At runtime the bundled binary wins, with a system `aria2c` on `PATH` as the fallback.

## The bundled ffmpeg

`scripts/build-ffmpeg-sidecar.sh` compiles ffmpeg 9.0.1 into `src-tauri/binaries/` as part of `npm run sidecar`.

Garia asks ffmpeg to rewrite two finished files into one container with `-c copy`. The build keeps muxers, demuxers, parsers, and bitstream filters, while disabling encoders, decoders, hardware accelerators, filters, devices, and networking. The result is a small LGPL-2.1 binary without GPL parts. The script checks the license, size, and linkage.

The bundled binary wins; a system `ffmpeg` is the fallback.

## The bundled yt-dlp

`scripts/fetch-ytdlp-sidecar.sh` downloads yt-dlp's zipapp into `src-tauri/resources/`, checksum-verified against the release's `SHA2-256SUMS`.

A yt-dlp on `PATH` wins, and the bundled copy is the fallback. Sites change often, so a user's updated copy is preferred.

The zipapp needs Python 3.10 or newer. The resolver checks `python3`, `/usr/bin/python3`, and `/usr/local/bin/python3`, and uses the first interpreter that can run the bundled copy.

## Licenses

Garia itself is MIT. The sidecars keep their own licenses and run as separate processes:

| Tool | License |
|------|---------|
| aria2 1.37.0 | GPL-2.0-or-later |
| ffmpeg (trimmed build) | LGPL-2.1 |
| yt-dlp zipapp | Unlicense |
