#!/bin/sh
# Zip the browser capture package for the Chrome Web Store and
# addons.mozilla.org. Same files in both — Chrome uses the service
# worker, Firefox the event page. Load the folder unpacked for day-to-day.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/extensions/garia"
out="$root/dist/extensions"
stage="$(mktemp -d "${TMPDIR:-/tmp}/garia-ext.XXXXXX")"

cleanup() { rm -rf "$stage"; }
trap cleanup EXIT

mkdir -p "$out" "$stage"

# Store zips must not carry Safari's converter manifest or editor junk.
cp "$src/manifest.json" "$stage/"
cp "$src/background.js" "$src/content.js" "$src/file-types.js" "$src/video-button.js" "$stage/"
cp "$src/handoff.html" "$src/handoff.js" "$stage/"
mkdir -p "$stage/icons"
cp "$src/icons/16.png" "$src/icons/32.png" "$src/icons/48.png" "$src/icons/128.png" "$stage/icons/"

(
  cd "$stage"
  zip -X -r -q "$out/garia-chrome.zip" .
  cp "$out/garia-chrome.zip" "$out/garia-firefox.zip"
)

echo "Chrome Web Store zip:  $out/garia-chrome.zip"
echo "Firefox Add-ons zip:   $out/garia-firefox.zip"
echo "Sideload either browser from $src — Settings → Capture opens that folder."
