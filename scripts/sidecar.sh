#!/usr/bin/env bash
#
# The three sidecars, one command.
#
# Usage: scripts/sidecar.sh [target-triple]
#        no args → this machine; re-running is a no-op

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"

build_one() {
  "${ROOT}/scripts/build-aria2-sidecar.sh" "$1"
  "${ROOT}/scripts/build-ffmpeg-sidecar.sh" "$1"
}

"${ROOT}/scripts/fetch-ytdlp-sidecar.sh"

case "${TARGET}" in
  "" )
    build_one "$(rustc -vV | awk '/^host:/{print $2}')"
    ;;
  * )
    build_one "${TARGET}"
    ;;
esac
