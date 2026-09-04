#!/usr/bin/env bash
#
# Builds the aria2c that ships inside the app bundle.
#
# Homebrew's aria2c links six Homebrew dylibs, so it breaks the moment it
# leaves this machine. This builds one against nothing but the OS: AppleTLS
# for HTTPS, CommonCrypto for hashing, the system zlib. The cost is Metalink,
# SFTP, Firefox cookie import, and async DNS — none of which garia uses.
#
# Usage: scripts/build-aria2-sidecar.sh [target-triple]
#        (defaults to this machine's triple; re-running is a no-op)

set -euo pipefail

VERSION="1.37.0"
# Cross-checked against the sha256 Homebrew records for the same tarball.
SHA256="60a420ad7085eb616cb6e2bdf0a7206d68ff3d37fb5a956dc44242eb2f79b66b"
TARBALL="aria2-${VERSION}.tar.xz"
URL="https://github.com/aria2/aria2/releases/download/release-${VERSION}/${TARBALL}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRIPLE="${1:-$(rustc -vV | awk '/^host:/{print $2}')}"
DEST="${ROOT}/src-tauri/binaries/aria2c-${TRIPLE}"

if [ -x "${DEST}" ]; then
  echo "aria2c sidecar already present: ${DEST#"${ROOT}/"}"
  exit 0
fi

echo "Building the aria2c sidecar for ${TRIPLE} — a few minutes, once."

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

curl -fsSL -o "${WORK}/${TARBALL}" "${URL}"
echo "${SHA256}  ${WORK}/${TARBALL}" | shasum -a 256 -c - > /dev/null
tar xf "${WORK}/${TARBALL}" -C "${WORK}"
cd "${WORK}/aria2-${VERSION}"

CONFIGURE_ARGS=(
  --disable-nls
  --without-openssl --without-gnutls --without-libnettle
  --without-libgmp --without-libgcrypt
  --with-appletls
  --without-sqlite3 --without-libssh2 --without-libcares
  --without-libxml2 --without-libexpat
  --without-libuv
)

# Rust and clang disagree on what to call this chip: aarch64 vs arm64.
case "${TRIPLE%%-*}" in
  aarch64) TARGET_ARCH="arm64" ;;
  *)       TARGET_ARCH="${TRIPLE%%-*}" ;;
esac

# Building for the other Mac architecture: the SDK is universal, so this is
# just a matter of telling configure not to run what it compiles.
if [ "${TARGET_ARCH}" != "$(uname -m)" ]; then
  CONFIGURE_ARGS+=(--host="${TRIPLE}")
  export CFLAGS="-arch ${TARGET_ARCH}"
  export CXXFLAGS="-arch ${TARGET_ARCH}"
  export LDFLAGS="-arch ${TARGET_ARCH}"
fi

./configure "${CONFIGURE_ARGS[@]}" > "${WORK}/configure.log" 2>&1 ||
  { tail -30 "${WORK}/configure.log"; exit 1; }

JOBS="$(sysctl -n hw.ncpu 2>/dev/null || true)"
make -j"${JOBS:-4}" > "${WORK}/make.log" 2>&1 ||
  { tail -30 "${WORK}/make.log"; exit 1; }

strip -x src/aria2c

# A sidecar that pulls in anything outside the OS would fail on someone else's
# machine, and it would fail at runtime, quietly. Refuse to ship one.
if otool -L src/aria2c | tail -n +2 | grep -qvE '^\s+(/usr/lib/|/System/Library/)'; then
  echo "aria2c linked something outside the OS:"
  otool -L src/aria2c | tail -n +2
  exit 1
fi

mkdir -p "${ROOT}/src-tauri/binaries"
cp src/aria2c "${DEST}"
echo "Built ${DEST#"${ROOT}/"} ($(du -h "${DEST}" | cut -f1))"
