#!/bin/sh
# Safari will not load a folder the way Chrome does. This copies the
# Chromium package, drops the downloads permission Safari does not have,
# and runs Apple's converter. The result is an Xcode project you Run once
# with Develop → Allow Unsigned Extensions turned on.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/extensions/garia"
work="$(mktemp -d "${TMPDIR:-/tmp}/garia-safari.XXXXXX")"
out="$root/extensions/safari-app"

cleanup() { rm -rf "$work"; }
trap cleanup EXIT

cp -R "$src/." "$work/"
cp "$src/manifest.safari.json" "$work/manifest.json"

if ! command -v xcrun >/dev/null; then
  echo "xcrun is not here — install Xcode’s command-line tools." >&2
  exit 1
fi

rm -rf "$out"
xcrun safari-web-extension-converter "$work" \
  --project-location "$out" \
  --app-name "Garia Capture" \
  --bundle-identifier com.fabimc.garia.capture \
  --macos-only \
  --no-open \
  --force

echo "Safari project is at $out"
echo "Open it, Run it, then enable Garia in Safari → Settings → Extensions."
