#!/usr/bin/env bash
#
# Build a Garia AppImage (x86_64).
#
# Usage:
#   scripts/pack-linux-appimage.sh
#   scripts/pack-linux-appimage.sh --version 0.2.0 --binary target/release/garia --out dist
#
# Downloads linuxdeploy + appimagetool into .cache/appimage-tools/ on first run
# (or uses tools already on PATH). Tries the GTK plugin first (tray / dialogs),
# then falls back to a deps-only deploy if the plugin fails.
#
# Output: dist/Garia-<ver>-x86_64.AppImage (+ .SHA256SUMS)

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
ARCH="x86_64"
CACHE="${ROOT}/.cache/appimage-tools"

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --binary) BINARY="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --aria2) ARIA2="$2"; shift 2 ;;
    --ffmpeg) FFMPEG="$2"; shift 2 ;;
    --yt-dlp) YTDLP="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,18p' "$0"
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
command -v curl >/dev/null || { echo "curl required" >&2; exit 1; }
command -v file >/dev/null || { echo "file(1) required" >&2; exit 1; }

fetch_tool() {
  local name="$1"
  local url="$2"
  local dest="${CACHE}/${name}"
  if [ -x "${dest}" ]; then
    echo "${dest}"
    return
  fi
  mkdir -p "${CACHE}"
  echo "Downloading ${name}…" >&2
  curl -fsSL -o "${dest}" "${url}"
  chmod +x "${dest}"
  echo "${dest}"
}

LINUXDEPLOY="$(fetch_tool linuxdeploy-x86_64.AppImage \
  "https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-x86_64.AppImage")"
APPIMAGETOOL="$(fetch_tool appimagetool-x86_64.AppImage \
  "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage")"

GTK_PLUGIN="${CACHE}/linuxdeploy-plugin-gtk.sh"
if [ ! -x "${GTK_PLUGIN}" ]; then
  mkdir -p "${CACHE}"
  curl -fsSL -o "${GTK_PLUGIN}" \
    "https://github.com/linuxdeploy/linuxdeploy-plugin-gtk/raw/master/linuxdeploy-plugin-gtk.sh" \
    && chmod +x "${GTK_PLUGIN}" \
    || GTK_PLUGIN=""
fi

mkdir -p "${OUT}"
APPDIR="${OUT}/Garia.AppDir"

stage_appdir() {
  rm -rf "${APPDIR}"
  mkdir -p \
    "${APPDIR}/usr/bin" \
    "${APPDIR}/usr/share/applications" \
    "${APPDIR}/usr/share/icons/hicolor/256x256/apps" \
    "${APPDIR}/usr/share/icons/hicolor/128x128/apps" \
    "${APPDIR}/usr/share/icons/hicolor/32x32/apps"

  # Sidecars next to garia so current_exe discovery works inside the AppImage.
  # yt-dlp is a Python zipapp — add it after linuxdeploy so it is not scanned as ELF.
  cp "${BINARY}" "${APPDIR}/usr/bin/garia"
  cp "${ARIA2}" "${APPDIR}/usr/bin/aria2c"
  cp "${FFMPEG}" "${APPDIR}/usr/bin/ffmpeg"
  chmod +x "${APPDIR}/usr/bin/garia" "${APPDIR}/usr/bin/aria2c" "${APPDIR}/usr/bin/ffmpeg"

  cp "${ROOT}/assets/icons/icon.png" "${APPDIR}/usr/share/icons/hicolor/256x256/apps/garia.png"
  cp "${ROOT}/assets/icons/128x128.png" "${APPDIR}/usr/share/icons/hicolor/128x128/apps/garia.png"
  cp "${ROOT}/assets/icons/32x32.png" "${APPDIR}/usr/share/icons/hicolor/32x32/apps/garia.png"
  cp "${ROOT}/assets/icons/icon.png" "${APPDIR}/garia.png"

  cat > "${APPDIR}/usr/share/applications/garia.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Garia
Comment=Fast download manager
Exec=garia %u
Icon=garia
Terminal=false
Categories=Network;FileTransfer;
MimeType=application/x-bittorrent;x-scheme-handler/garia;x-scheme-handler/magnet;
StartupWMClass=garia
EOF
  cp "${APPDIR}/usr/share/applications/garia.desktop" "${APPDIR}/garia.desktop"
}

run_linuxdeploy() {
  local with_gtk="${1:-}"
  local -a args=(
    --appdir "${APPDIR}"
    --executable "${APPDIR}/usr/bin/garia"
    --desktop-file "${APPDIR}/usr/share/applications/garia.desktop"
    --icon-file "${APPDIR}/garia.png"
    --executable "${APPDIR}/usr/bin/aria2c"
    --executable "${APPDIR}/usr/bin/ffmpeg"
  )
  if [ "${with_gtk}" = "gtk" ] && [ -n "${GTK_PLUGIN}" ]; then
    args+=(--plugin gtk)
  fi
  "${LINUXDEPLOY}" "${args[@]}"
}

export ARCH
export VERSION
export APPIMAGE_EXTRACT_AND_RUN=1
export LINUXDEPLOY_OUTPUT_VERSION="${VERSION}"
export DEPLOY_GTK_VERSION="${DEPLOY_GTK_VERSION:-3}"
export PATH="${CACHE}:${PATH}"

stage_appdir

if [ -n "${GTK_PLUGIN}" ]; then
  if ! run_linuxdeploy gtk; then
    echo "linuxdeploy + GTK plugin failed; retrying without plugin…" >&2
    stage_appdir
    run_linuxdeploy
  fi
else
  run_linuxdeploy
fi

# Ensure AppRun exists (linuxdeploy usually writes it).
if [ ! -e "${APPDIR}/AppRun" ]; then
  cat > "${APPDIR}/AppRun" <<'EOF'
#!/bin/sh
SELF="$(readlink -f "$0")"
HERE="${SELF%/*}"
export PATH="${HERE}/usr/bin:${PATH}"
exec "${HERE}/usr/bin/garia" "$@"
EOF
  chmod +x "${APPDIR}/AppRun"
fi

# Re-copy yt-dlp after linuxdeploy in case strip/rpath tooling touched neighbours.
cp "${YTDLP}" "${APPDIR}/usr/bin/yt-dlp"
chmod +x "${APPDIR}/usr/bin/yt-dlp"

AI_NAME="Garia-${VERSION}-${ARCH}.AppImage"
AI_PATH="${OUT}/${AI_NAME}"
rm -f "${AI_PATH}"

"${APPIMAGETOOL}" "${APPDIR}" "${AI_PATH}"
chmod +x "${AI_PATH}"
rm -rf "${APPDIR}"

(
  cd "${OUT}"
  sha256sum "${AI_NAME}" > "Garia-${VERSION}-${ARCH}.AppImage.SHA256SUMS"
)

echo "Built ${AI_PATH}"
