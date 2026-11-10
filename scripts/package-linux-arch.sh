#!/usr/bin/env bash
#
# Turns Tauri's self-contained Linux AppImage into an Arch-safe AppDir archive.
# The PKGBUILD installs the private AppDir under /opt/garia, never into /usr/bin.
#
# Usage: scripts/package-linux-arch.sh <appimage> <version> <output-dir>

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <appimage> <version> <output-dir>" >&2
  exit 2
fi

APPIMAGE="$(realpath "$1")"
VERSION="$2"
mkdir -p "$3"
OUTPUT_DIR="$(realpath "$3")"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]]; then
  echo "invalid release version: $VERSION" >&2
  exit 2
fi
if [ ! -x "$APPIMAGE" ]; then
  echo "AppImage is not executable: $APPIMAGE" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

(
  cd "$WORK"
  "$APPIMAGE" --appimage-extract >/dev/null
  APPDIR="$WORK/squashfs-root"

  for path in \
    AppRun \
    AppRun.wrapped \
    usr/bin/garia \
    usr/bin/aria2c \
    usr/bin/ffmpeg \
    usr/lib/Garia/resources/yt-dlp \
    usr/share/applications/Garia.desktop \
    usr/share/icons/hicolor/128x128/apps/garia.png
  do
    if [ ! -e "$APPDIR/$path" ]; then
      echo "AppImage is missing required path: $path" >&2
      exit 1
    fi
  done

  for bin in garia aria2c ffmpeg; do
    if ! file "$APPDIR/usr/bin/$bin" | grep -q "x86-64"; then
      echo "expected an x86_64 $bin executable in the AppImage" >&2
      exit 1
    fi
  done

  mv "$APPDIR" "$WORK/garia"
  # This is generated as an absolute link to the build runner's source tree.
  rm -f "$WORK/garia/.DirIcon"

  # The extracted AppImage is 0700 throughout; installed as root, that would
  # lock every other user out of /opt/garia.
  tar \
    --sort=name \
    --owner=0 --group=0 --numeric-owner \
    --mode='u+rwX,go+rX,go-w' \
    --mtime="@${SOURCE_DATE_EPOCH:-0}" \
    -cf - -C "$WORK" garia |
    gzip -n > "$OUTPUT_DIR/garia-${VERSION}-linux-x86_64.tar.gz"
)
