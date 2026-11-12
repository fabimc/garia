#!/usr/bin/env bash
#
# Builds the ffmpeg that ships inside the app bundle.
#
# Garia asks ffmpeg for exactly one thing: rewrite two finished files into one
# container with -c copy. No decoding, no encoding, no scaling, no network. So
# this builds an ffmpeg with all of that switched off — every muxer, demuxer,
# parser and bitstream filter is kept, because those are what a remux is made
# of, and everything that would have made the binary 70 MB is gone. What comes
# out is ~4 MB, LGPL-only, and linked against nothing but the OS.
#
# Usage: scripts/build-ffmpeg-sidecar.sh [target-triple]
#        (defaults to this machine's triple; re-running is a no-op)

set -euo pipefail

VERSION="9.0.1"
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

SOURCE="$("${ROOT}/scripts/download-verified.sh" "${URL}" "${SHA256}" "${TARBALL}")"
tar xf "${SOURCE}" -C "${WORK}"
cd "${WORK}/ffmpeg-${VERSION}"

case "${TRIPLE}" in
  *-unknown-linux-gnu | *-unknown-linux-musl) ;;
  *)
    echo "unsupported sidecar target: ${TRIPLE}" >&2
    exit 1
    ;;
esac

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
  # means the build doesn't need a nasm.
  --disable-x86asm
  # One program, not three.
  --disable-ffplay --disable-ffprobe
  --enable-small
)

HOST_ARCH="$(uname -m)"

if [ "${TRIPLE%%-*}" != "${HOST_ARCH}" ]; then
  echo "cross-building ffmpeg for ${TRIPLE} is not supported yet" >&2
  exit 1
fi

CONFIGURE_ARGS+=(
  --arch="${TRIPLE%%-*}"
  --target-os=linux
)

./configure "${CONFIGURE_ARGS[@]}" > "${WORK}/configure.log" 2>&1 ||
  { tail -30 "${WORK}/configure.log"; exit 1; }

# The GPL parts stay off. Assert it rather than trusting the flag list above.
if ! grep -q '^License: LGPL' "${WORK}/configure.log"; then
  echo "ffmpeg configured to something other than LGPL:"
  grep '^License:' "${WORK}/configure.log"
  exit 1
fi

make -j"$(nproc)" > "${WORK}/make.log" 2>&1 ||
  { tail -30 "${WORK}/make.log"; exit 1; }

strip ffmpeg

# A sidecar that pulls in anything outside the OS would fail on someone else's
# machine, and it would fail at runtime, quietly. Refuse to ship one.
bad="$(ldd ffmpeg | awk '
  /not found/ { print; next }
  {
    lib = $1
    if (lib ~ /^linux-vdso/ || lib ~ /^\/lib/ || lib ~ /^\/usr\/lib/) next
    if (lib ~ /^lib(c|m|dl|pthread|rt|resolv|util|gcc_s|stdc\+\+|z)\.so/) next
    print
  }
')"
if [ -n "${bad}" ]; then
  echo "ffmpeg linked something unexpected:"
  echo "${bad}"
  ldd ffmpeg
  exit 1
fi

mkdir -p "${ROOT}/src-tauri/binaries"
cp ffmpeg "${DEST}"
echo "Built ${DEST#"${ROOT}/"} ($(du -h "${DEST}" | cut -f1))"
