#!/usr/bin/env bash
#
# The three sidecars, one command. Dev only needs this machine; a release
# that claims both Mac chips needs both binaries lipo'd into one file,
# because Tauri looks for `*-universal-apple-darwin` and will not lipo
# external bins itself.
#
# Usage: scripts/sidecar.sh [target-triple|universal-apple-darwin]
#        no args → this machine; re-running is a no-op

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"

build_one() {
  "${ROOT}/scripts/build-aria2-sidecar.sh" "$1"
  "${ROOT}/scripts/build-ffmpeg-sidecar.sh" "$1"
}

lipo_one() {
  local name="$1"
  local dest="${ROOT}/src-tauri/binaries/${name}-universal-apple-darwin"
  local arm="${ROOT}/src-tauri/binaries/${name}-aarch64-apple-darwin"
  local intel="${ROOT}/src-tauri/binaries/${name}-x86_64-apple-darwin"
  if [ -x "${dest}" ]; then
    echo "${name} universal sidecar already present: ${dest#"${ROOT}/"}"
    return
  fi
  if [ ! -x "${arm}" ] || [ ! -x "${intel}" ]; then
    echo "cannot lipo ${name}: need both aarch64 and x86_64 sidecars" >&2
    exit 1
  fi
  lipo -create "${arm}" "${intel}" -output "${dest}"
  echo "Lipo'd ${dest#"${ROOT}/"} ($(du -h "${dest}" | cut -f1))"
}

"${ROOT}/scripts/fetch-ytdlp-sidecar.sh"

case "${TARGET}" in
  "" )
    build_one "$(rustc -vV | awk '/^host:/{print $2}')"
    ;;
  universal-apple-darwin | universal )
    build_one aarch64-apple-darwin
    build_one x86_64-apple-darwin
    lipo_one aria2c
    lipo_one ffmpeg
    ;;
  * )
    build_one "${TARGET}"
    ;;
esac
