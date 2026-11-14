#!/usr/bin/env bash
#
# Downloads a sidecar's source once, checks its SHA-256, and prints where it
# is. Every later caller gets the copy already on disk, so each tarball is
# fetched only once per build.
#
# The servers behind these URLs drop connections now and then, and one reset
# used to cost a whole release run. So the download retries, on every kind of
# error and not only the few plain --retry covers; the checksum still decides
# whether what came back is the file.
#
# Usage: scripts/download-verified.sh <url> <sha256> <filename>
#        prints the path of the verified file on stdout
#        cache dir: $SIDECAR_DOWNLOAD_CACHE, else .sidecar-cache/ in the repo

set -euo pipefail

URL="$1"
SHA256="$2"
NAME="$3"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="${SIDECAR_DOWNLOAD_CACHE:-${ROOT}/.sidecar-cache}"
DEST="${CACHE}/${NAME}"

if [ -f "${DEST}" ]; then
  if "${ROOT}/scripts/sha256-check.sh" "${SHA256}" "${DEST}" 2>/dev/null; then
    echo "${DEST}"
    exit 0
  fi
  echo "Cached ${NAME} does not match its checksum; fetching it again." >&2
  rm -f "${DEST}"
fi

mkdir -p "${CACHE}"
PART="${DEST}.part"
trap 'rm -f "${PART}"' EXIT

curl -fsSL \
  --retry 5 --retry-delay 5 --retry-all-errors \
  --connect-timeout 30 \
  -o "${PART}" "${URL}"
"${ROOT}/scripts/sha256-check.sh" "${SHA256}" "${PART}"
mv "${PART}" "${DEST}"
echo "${DEST}"
