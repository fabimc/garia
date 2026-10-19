# Bundled sidecars

Garia ships three tools beside the app so a download does not depend on Homebrew or apt. `./scripts/sidecar.sh` (also `npm run sidecar`) is the one command that produces all three.

At runtime the iced binary looks for `aria2c` / `ffmpeg` next to itself (then system `PATH`), and for yt-dlp prefers a system install with the bundled zipapp as fallback.

## The bundled aria2

`./scripts/sidecar.sh` compiles aria2 from the upstream 1.37.0 release into `binaries/`. A Mac release build asks for both chips and `lipo`s them into `*-universal-apple-darwin`.

Homebrew's `aria2c` links six Homebrew dylibs, so it stops working the moment it leaves the machine that installed it. The bundled build links nothing but the OS — AppleTLS on macOS, OpenSSL on Linux, CommonCrypto/system hashing, the system zlib — which is what makes it safe to ship. The script refuses to install a binary that links anything else.

Trimming those dependencies drops Metalink, SFTP, Firefox cookie import, and async DNS. Garia uses none of them. HTTP, HTTPS, FTP, and BitTorrent are all in.

To build for another architecture, or both Mac chips at once:

```sh
./scripts/sidecar.sh x86_64-apple-darwin
./scripts/sidecar.sh universal-apple-darwin
./scripts/sidecar.sh x86_64-unknown-linux-gnu
```

At runtime the bundled binary wins, and a system `aria2c` on `PATH` is the fallback.

## The bundled ffmpeg

`scripts/build-ffmpeg-sidecar.sh` (part of `./scripts/sidecar.sh`) compiles ffmpeg 9.0.1 into `binaries/` the same way, and it takes about a minute — because almost none of ffmpeg gets built.

Garia asks ffmpeg for exactly one thing: rewrite two finished files into one container with `-c copy`. That is a job for muxers, demuxers, parsers and bitstream filters, and for nothing else — so every encoder, decoder, hardware accelerator, filter and device is configured out, along with the network layer. What is left is ~4 MB instead of 70, links nothing but the OS, and is LGPL-2.1 with no GPL parts in it; the script checks all three and refuses to install a binary that fails any of them.

The same target-triple argument cross-builds it on macOS. There is no assembly left to assemble once the codecs are gone, so the x86_64 Mac build needs no `nasm` on an Apple Silicon machine. Linux builds for the host triple only (no cross-compile yet).

As with aria2, the bundled binary wins and a system `ffmpeg` is the fallback.

## The bundled yt-dlp

`scripts/fetch-ytdlp-sidecar.sh` (part of `./scripts/sidecar.sh`) downloads yt-dlp's 3 MB zipapp into `resources/yt-dlp`, checksum-verified against the release's own `SHA2-256SUMS`.

The order is the opposite of aria2's: **a yt-dlp on `PATH` wins, and the bundled copy is the fallback.** aria2 is stable and the bundled build is the one Garia knows; yt-dlp breaks whenever a site changes and ships a fix within days, so the user's own copy — the one that gets updated — is always the better bet.

The zipapp needs a `python3` 3.10 or newer. On Linux that is usually `/usr/bin/python3`. macOS does not provide a new enough system Python (`/usr/bin/python3` is 3.9), so Garia looks past it to Homebrew and python.org installs. The alternative was one of the standalone builds, and both are worse: the 37 MB onefile re-extracts itself on every run, which macOS then rescans — 22 seconds per probe, measured — and the onedir build that fixes the speed weighs 124 MB unpacked.

## Licenses

Garia itself is MIT. The sidecars keep their own licenses and run as separate processes:

| Tool | License |
|------|---------|
| aria2 1.37.0 | GPL-2.0-or-later |
| ffmpeg (trimmed build) | LGPL-2.1 |
| yt-dlp zipapp | Unlicense |
