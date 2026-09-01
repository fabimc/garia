#!/usr/bin/env bash
#
# Fetches the yt-dlp that ships inside the app bundle.
#
# This is the 3 MB zipapp, not one of the 40 MB standalone builds, and that is
# a measured choice. The PyInstaller onefile build re-extracts itself into a
# fresh temp directory on every run, which macOS then rescans: 22 seconds per
# probe, every probe. The onedir build fixes the speed and costs 124 MB
# unpacked. The zipapp needs a python3 on the machine, but when there is one it
# starts in half a second and weighs nothing.
#
# It is only ever the fallback — garia prefers a yt-dlp on PATH, because this
# copy is frozen at the version below and extractors break as sites change.
#
# Usage: scripts/fetch-ytdlp-sidecar.sh
#        (re-running is a no-op)

set -euo pipefail

VERSION="2026.08.19"
# From the release's own SHA2-256SUMS.
SHA256="1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6"
URL="https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}/yt-dlp"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${ROOT}/src-tauri/resources/yt-dlp"

if [ -f "${DEST}" ]; then
  echo "yt-dlp already present: ${DEST#"${ROOT}/"}"
  exit 0
fi

echo "Fetching yt-dlp ${VERSION} — 3 MB, once."

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

curl -fsSL -o "${WORK}/yt-dlp" "${URL}"
echo "${SHA256}  ${WORK}/yt-dlp" | shasum -a 256 -c - > /dev/null

# Pure Python, so one copy serves every architecture. Garia never execs it
# directly — a GUI app doesn't inherit the PATH the shebang would need — so it
# is handed to a python3 the backend found for itself.
mkdir -p "${ROOT}/src-tauri/resources"
cp "${WORK}/yt-dlp" "${DEST}"
echo "Fetched ${DEST#"${ROOT}/"} ($(du -h "${DEST}" | cut -f1))"
