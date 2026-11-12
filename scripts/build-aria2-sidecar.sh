#!/usr/bin/env bash
#
# Builds the aria2c that ships inside the app bundle.
#
# Build against system OpenSSL and zlib. The cost is Metalink, SFTP,
# Firefox cookie import, and async DNS — none of which garia uses.
#
# Usage: scripts/build-aria2-sidecar.sh [target-triple]
#        (defaults to this machine's triple; re-running is a no-op)

set -euo pipefail

VERSION="1.37.0"
# Verified against the upstream checksum for the same tarball.
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

SOURCE="$("${ROOT}/scripts/download-verified.sh" "${URL}" "${SHA256}" "${TARBALL}")"
tar xf "${SOURCE}" -C "${WORK}"
cd "${WORK}/aria2-${VERSION}"

case "${TRIPLE}" in
  *-unknown-linux-gnu | *-unknown-linux-musl)
    CONFIGURE_ARGS=(
      --disable-nls
      --with-openssl --without-gnutls --without-libnettle
      --without-libgmp --without-libgcrypt
      --without-sqlite3 --without-libssh2 --without-libcares
      --without-libxml2 --without-libexpat
      --without-libuv
    )
    ;;
  *)
    echo "unsupported sidecar target: ${TRIPLE}" >&2
    exit 1
    ;;
esac

HOST_ARCH="$(uname -m)"

if [[ "${TRIPLE%%-*}" != "${HOST_ARCH}" ]]; then
  echo "cross-building aria2 for ${TRIPLE} is not supported yet" >&2
  exit 1
fi

./configure "${CONFIGURE_ARGS[@]}" > "${WORK}/configure.log" 2>&1 ||
  { tail -30 "${WORK}/configure.log"; exit 1; }

if command -v nproc >/dev/null 2>&1; then
  JOBS="$(nproc)"
else
  JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
fi
make -j"${JOBS}" > "${WORK}/make.log" 2>&1 ||
  { tail -30 "${WORK}/make.log"; exit 1; }

strip src/aria2c

# A sidecar that pulls in anything outside the OS would fail on someone else's
# machine, and it would fail at runtime, quietly. Refuse to ship one.
# Allow the usual glibc/OpenSSL/zlib set that every Ubuntu/Debian box has
# (and that linuxdeploy will bundle into an AppImage).
bad="$(ldd src/aria2c | awk '
  /not found/ { print; next }
  {
    lib = $1
    if (lib ~ /^linux-vdso/ || lib ~ /^\/lib/ || lib ~ /^\/usr\/lib/) next
    if (lib ~ /^lib(c|m|dl|pthread|rt|resolv|util|gcc_s|stdc\+\+|ssl|crypto|z)\.so/) next
    print
  }
')"
if [ -n "${bad}" ]; then
  echo "aria2c linked something unexpected:"
  echo "${bad}"
  ldd src/aria2c
  exit 1
fi

mkdir -p "${ROOT}/src-tauri/binaries"
cp src/aria2c "${DEST}"
echo "Built ${DEST#"${ROOT}/"} ($(du -h "${DEST}" | cut -f1))"
