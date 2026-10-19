#!/usr/bin/env bash
#
# Build a Debian package for Garia (x86_64 / amd64).
#
# Usage:
#   scripts/pack-linux-deb.sh
#   scripts/pack-linux-deb.sh --version 0.2.0 --binary target/release/garia --out dist
#
# Layout:
#   /usr/lib/garia/{garia,aria2c,ffmpeg,yt-dlp}   # sidecars next to binary
#   /usr/bin/garia -> ../lib/garia/garia
#   /usr/share/applications/garia.desktop
#   /usr/share/icons/hicolor/*/apps/garia.png
#
# Output: dist/garia_<ver>_amd64.deb (+ .SHA256SUMS)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=pack-common.sh
source "${ROOT}/scripts/pack-common.sh"

VERSION=""
BINARY=""
OUT="${ROOT}/dist"
ARIA2=""
FFMPEG=""
YTDLP=""
ARCH="amd64"

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --binary) BINARY="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --aria2) ARIA2="$2"; shift 2 ;;
    --ffmpeg) FFMPEG="$2"; shift 2 ;;
    --yt-dlp) YTDLP="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if [ -z "${VERSION}" ]; then
  VERSION="$(pack_cargo_version "${ROOT}")"
fi
if [ -z "${BINARY}" ]; then
  BINARY="${ROOT}/target/release/garia"
fi
if [ -z "${ARIA2}" ]; then
  ARIA2="${ROOT}/binaries/aria2c-$(rustc -vV | awk '/^host:/{print $2}')"
fi
if [ -z "${FFMPEG}" ]; then
  FFMPEG="${ROOT}/binaries/ffmpeg-$(rustc -vV | awk '/^host:/{print $2}')"
fi
if [ -z "${YTDLP}" ]; then
  YTDLP="${ROOT}/resources/yt-dlp"
fi

pack_require_exec "${BINARY}"
pack_require_exec "${ARIA2}"
pack_require_exec "${FFMPEG}"
pack_require_file "${YTDLP}"
pack_require_file "${ROOT}/packaging/garia.desktop"
command -v dpkg-deb >/dev/null || { echo "dpkg-deb required" >&2; exit 1; }

mkdir -p "${OUT}"
STAGE="${OUT}/.deb-garia_${VERSION}_${ARCH}"
rm -rf "${STAGE}"

LIBDIR="${STAGE}/usr/lib/garia"
BINDIR="${STAGE}/usr/bin"
APPDIR="${STAGE}/usr/share/applications"
ICON_BASE="${STAGE}/usr/share/icons/hicolor"
DOCDIR="${STAGE}/usr/share/doc/garia"
DEBIAN="${STAGE}/DEBIAN"

mkdir -p "${LIBDIR}" "${BINDIR}" "${APPDIR}" "${DOCDIR}" "${DEBIAN}"
mkdir -p \
  "${ICON_BASE}/32x32/apps" \
  "${ICON_BASE}/128x128/apps" \
  "${ICON_BASE}/256x256/apps"

cp "${BINARY}" "${LIBDIR}/garia"
cp "${ARIA2}" "${LIBDIR}/aria2c"
cp "${FFMPEG}" "${LIBDIR}/ffmpeg"
cp "${YTDLP}" "${LIBDIR}/yt-dlp"
chmod 755 "${LIBDIR}/garia" "${LIBDIR}/aria2c" "${LIBDIR}/ffmpeg" "${LIBDIR}/yt-dlp"

ln -sf ../lib/garia/garia "${BINDIR}/garia"

# Desktop entry: keep Exec=garia %u (PATH via /usr/bin symlink).
sed 's|^Exec=.*|Exec=garia %u|' "${ROOT}/packaging/garia.desktop" > "${APPDIR}/garia.desktop"
chmod 644 "${APPDIR}/garia.desktop"

cp "${ROOT}/assets/icons/32x32.png" "${ICON_BASE}/32x32/apps/garia.png"
cp "${ROOT}/assets/icons/128x128.png" "${ICON_BASE}/128x128/apps/garia.png"
cp "${ROOT}/assets/icons/icon.png" "${ICON_BASE}/256x256/apps/garia.png"

cat > "${DOCDIR}/copyright" <<EOF
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: garia
Source: https://github.com/fabimc/garia

Files: *
Copyright: Garia contributors
License: MIT

Comment: Bundled aria2c is GPL-2.0-or-later; ffmpeg is LGPL-2.1; yt-dlp is Unlicense.
EOF
chmod 644 "${DOCDIR}/copyright"

SIZE_KB="$(du -sk "${STAGE}/usr" | cut -f1)"

cat > "${DEBIAN}/control" <<EOF
Package: garia
Version: ${VERSION}
Section: net
Priority: optional
Architecture: ${ARCH}
Installed-Size: ${SIZE_KB}
Maintainer: fabimc <https://github.com/fabimc/garia>
Homepage: https://github.com/fabimc/garia
Depends: libgtk-3-0, libxdo3, libayatana-appindicator3-1, libssl3 | libssl1.1, zlib1g, python3 (>= 3.10)
Recommends: xdg-utils
Description: Fast download manager for Linux
 Garia is a download manager built on aria2 with a native iced UI.
 It ships bundled aria2c, ffmpeg, and yt-dlp sidecars and registers
 garia://, magnet:, and .torrent associations via its desktop entry.
EOF

cat > "${DEBIAN}/postinst" <<'EOF'
#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q /usr/share/icons/hicolor || true
fi
EOF
chmod 755 "${DEBIAN}/postinst"

DEB_NAME="garia_${VERSION}_${ARCH}.deb"
DEB_PATH="${OUT}/${DEB_NAME}"
rm -f "${DEB_PATH}"
dpkg-deb --root-owner-group --build "${STAGE}" "${DEB_PATH}"
rm -rf "${STAGE}"

(
  cd "${OUT}"
  sha256sum "${DEB_NAME}" > "garia_${VERSION}_${ARCH}.deb.SHA256SUMS"
)

echo "Built ${DEB_PATH}"
