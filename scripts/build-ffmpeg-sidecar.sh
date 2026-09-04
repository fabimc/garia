#!/usr/bin/env bash
#
# Builds the ffmpeg that ships inside the app bundle.
#
# Garia asks ffmpeg for exactly one thing: rewrite two finished files into one
# container with -c copy. No decoding, no encoding, no scaling, no network. So
# this builds an ffmpeg with all of that switched off — every muxer, demuxer,
# parser and bitstream filter is kept, because those are what a remux is made
# of, and everything that would have made the binary 70 MB is gone. What comes
# out is 4 MB, LGPL-only, and linked against nothing but the OS.
#
# Usage: scripts/build-ffmpeg-sidecar.sh [target-triple]
#        (defaults to this machine's triple; re-running is a no-op)

set -euo pipefail

VERSION="9.0.1"
# Cross-checked against the sha256 Homebrew records for the same tarball.
SHA256="cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635"
TARBALL="ffmpeg-${VERSION}.tar.xz"
URL="https://ffmpeg.org/releases/${TARBALL}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRIPLE="${1:-$(rustc -vV | awk '/^host:/{print $2}')}"
DEST="${ROOT}/src-tauri/binaries/ffmpeg-${TRIPLE}"

if [ -x "${DEST}" ]; then
  echo "ffmpeg sidecar already present: ${DEST#"${ROOT}/"}"
  exit 0
fi

echo "Building the ffmpeg sidecar for ${TRIPLE} — a minute, once."

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

curl -fsSL -o "${WORK}/${TARBALL}" "${URL}"
echo "${SHA256}  ${WORK}/${TARBALL}" | shasum -a 256 -c - > /dev/null
tar xf "${WORK}/${TARBALL}" -C "${WORK}"
cd "${WORK}/ffmpeg-${VERSION}"

CONFIGURE_ARGS=(
  # Never link something this machine happens to have and the next one won't.
  --disable-autodetect
  --disable-doc --disable-debug
  # A remux reads and writes local files. Nothing here opens a socket.
  --disable-network
  # The whole codec half of ffmpeg, which -c copy never reaches for. This is
  # where the 70 MB goes; it also leaves the build LGPL-2.1 with no GPL parts.
  --disable-encoders --disable-decoders --disable-hwaccels
  --disable-filters --disable-devices
  # Nothing needs hand-written assembly once the codecs are gone, and saying so
  # means the x86_64 cross-build doesn't need a nasm on an Apple Silicon Mac.
  --disable-x86asm
  # One program, not three.
  --disable-ffplay --disable-ffprobe
  --enable-small
)

# Rust and clang disagree on what to call this chip: aarch64 vs arm64.
case "${TRIPLE%%-*}" in
  aarch64) TARGET_ARCH="arm64" ;;
  *)       TARGET_ARCH="${TRIPLE%%-*}" ;;
esac

# Building for the other Mac architecture: the SDK is universal, so this is
# just a matter of telling configure what it is aiming at and not to run what
# it compiles.
if [ "${TARGET_ARCH}" != "$(uname -m)" ]; then
  CONFIGURE_ARGS+=(
    --enable-cross-compile
    --arch="${TARGET_ARCH}"
    --target-os=darwin
    --extra-cflags="-arch ${TARGET_ARCH}"
    --extra-ldflags="-arch ${TARGET_ARCH}"
  )
fi

./configure "${CONFIGURE_ARGS[@]}" > "${WORK}/configure.log" 2>&1 ||
  { tail -30 "${WORK}/configure.log"; exit 1; }

# The GPL parts stay off. Assert it rather than trusting the flag list above.
if ! grep -q '^License: LGPL' "${WORK}/configure.log"; then
  echo "ffmpeg configured to something other than LGPL:"
  grep '^License:' "${WORK}/configure.log"
  exit 1
fi

JOBS="$(sysctl -n hw.ncpu 2>/dev/null || true)"
make -j"${JOBS:-4}" > "${WORK}/make.log" 2>&1 ||
  { tail -30 "${WORK}/make.log"; exit 1; }

strip -x ffmpeg

# A sidecar that pulls in anything outside the OS would fail on someone else's
# machine, and it would fail at runtime, quietly. Refuse to ship one.
if otool -L ffmpeg | tail -n +2 | grep -qvE '^\s+(/usr/lib/|/System/Library/)'; then
  echo "ffmpeg linked something outside the OS:"
  otool -L ffmpeg | tail -n +2
  exit 1
fi

mkdir -p "${ROOT}/src-tauri/binaries"
cp ffmpeg "${DEST}"
echo "Built ${DEST#"${ROOT}/"} ($(du -h "${DEST}" | cut -f1))"
