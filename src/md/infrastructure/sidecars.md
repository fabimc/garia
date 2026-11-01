# Infrastructure: Sidecars

Garia ships three tools so downloads do not depend on Homebrew or apt. `npm run sidecar` builds or fetches all three before `tauri dev` / `tauri build`.

## aria2 (bundled wins)

- Build from upstream 1.37.0 into `src-tauri/binaries/`.
- Must link only the OS (AppleTLS / system OpenSSL / system zlib). Homebrew `aria2c` pulls Homebrew dylibs and breaks off-machine — refuse to install such a binary.
- Trimmed: no Metalink, SFTP, Firefox cookie import, async DNS (unused).
- Universal Mac: build both chips and `lipo` (Tauri will not lipo external binaries).

## ffmpeg (bundled wins)

- Trimmed build: muxers/demuxers/parsers only for `-c copy` merges (~4 MB).
- No encoders, filters, network, or GPL parts → LGPL-2.1. Script checks size, linkage, and license surface.
- System `ffmpeg` is fallback only.

## yt-dlp (PATH wins)

- Opposite preference: user's PATH copy preferred; bundled zipapp is fallback.
- Sites break often; the updated user copy is the better bet.
- Zipapp needs Python 3.10+. macOS system Python is 3.9 → look past `/usr/bin/python3` to Homebrew / python.org.
- Standalone onefile was measured too slow under Gatekeeper rescans; onedir too large.

## Related

- Scripts: `scripts/sidecar.sh`, `scripts/build-*-sidecar.sh`, `scripts/fetch-ytdlp-sidecar.sh`
- [docs/Sidecars.md](../../../docs/Sidecars.md)
