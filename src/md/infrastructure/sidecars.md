# Infrastructure: Sidecars

Garia ships three tools so downloads do not depend on system package managers. `npm run sidecar` builds or fetches all three before `tauri dev` / `tauri build`.

## aria2 (bundled wins)

- Build from upstream 1.37.0 into `src-tauri/binaries/`.
- Must link only the OS (system OpenSSL / system zlib). Refuse to install a binary with external library dependencies.
- Trimmed: no Metalink, SFTP, Firefox cookie import, async DNS (unused).

## ffmpeg (bundled wins)

- Trimmed build: muxers/demuxers/parsers only for `-c copy` merges (~4 MB).
- No encoders, filters, network, or GPL parts → LGPL-2.1. Script checks size, linkage, and license surface.
- System `ffmpeg` is fallback only.

## yt-dlp (PATH wins)

- Opposite preference: user's PATH copy preferred; bundled zipapp is fallback.
- Sites break often; the updated user copy is the better bet.
- Zipapp needs Python 3.10+. Look past `/usr/bin/python3` to a newer system installation when needed.

## Related

- Scripts: `scripts/sidecar.sh`, `scripts/build-*-sidecar.sh`, `scripts/fetch-ytdlp-sidecar.sh`
- [docs/Sidecars.md](../../../docs/Sidecars.md)
