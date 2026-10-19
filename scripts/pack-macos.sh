#!/usr/bin/env bash
#
# Stage a macOS .app bundle and a DMG from a pre-built garia + sidecars.
#
# Usage:
#   scripts/pack-macos.sh
#   scripts/pack-macos.sh --version 0.2.0 --binary target/universal/garia --out dist
#
# Expects (defaults for CI after release build steps):
#   binary:   target/universal/garia   (universal) or target/release/garia
#   sidecars: binaries/aria2c-universal-apple-darwin (or host triple)
#             binaries/ffmpeg-universal-apple-darwin
#             resources/yt-dlp
#
# Outputs under --out (default dist/):
#   Garia.app
#   Garia_<ver>_universal.dmg   (or Garia_<ver>_<arch>.dmg for single-arch)
#   Garia_universal.app.tar.gz  (updater-friendly archive of the .app)
#
# Optional Apple signing / notarization when these env vars are set:
#   APPLE_CERTIFICATE              base64 .p12
#   APPLE_CERTIFICATE_PASSWORD
#   APPLE_SIGNING_IDENTITY         e.g. "Developer ID Application: …"
#   APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID   for notarytool
#
# Without those secrets the DMG still builds (unsigned). Homebrew cask documents
# the quarantine workaround.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=pack-common.sh
source "${ROOT}/scripts/pack-common.sh"

VERSION=""
BINARY=""
OUT="${ROOT}/dist"
ARCH_LABEL="universal"
ARIA2=""
FFMPEG=""
YTDLP=""

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --binary) BINARY="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --arch-label) ARCH_LABEL="$2"; shift 2 ;;
    --aria2) ARIA2="$2"; shift 2 ;;
    --ffmpeg) FFMPEG="$2"; shift 2 ;;
    --yt-dlp) YTDLP="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,30p' "$0"
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
  if [ -x "${ROOT}/target/universal/garia" ]; then
    BINARY="${ROOT}/target/universal/garia"
    ARCH_LABEL="universal"
  elif [ -x "${ROOT}/target/release/garia" ]; then
    BINARY="${ROOT}/target/release/garia"
    ARCH_LABEL="$(uname -m)"
  else
    echo "no garia binary found; pass --binary or build first" >&2
    exit 1
  fi
fi

if [ -z "${ARIA2}" ]; then
  if [ -x "${ROOT}/binaries/aria2c-universal-apple-darwin" ]; then
    ARIA2="${ROOT}/binaries/aria2c-universal-apple-darwin"
  else
    ARIA2="${ROOT}/binaries/aria2c-$(rustc -vV | awk '/^host:/{print $2}')"
  fi
fi
if [ -z "${FFMPEG}" ]; then
  if [ -x "${ROOT}/binaries/ffmpeg-universal-apple-darwin" ]; then
    FFMPEG="${ROOT}/binaries/ffmpeg-universal-apple-darwin"
  else
    FFMPEG="${ROOT}/binaries/ffmpeg-$(rustc -vV | awk '/^host:/{print $2}')"
  fi
fi
if [ -z "${YTDLP}" ]; then
  YTDLP="${ROOT}/resources/yt-dlp"
fi

pack_require_exec "${BINARY}"
pack_require_exec "${ARIA2}"
pack_require_exec "${FFMPEG}"
pack_require_file "${YTDLP}"
pack_require_file "${ROOT}/packaging/Info.plist"
pack_require_file "${ROOT}/packaging/entitlements.plist"
pack_require_file "${ROOT}/assets/icons/icon.icns"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "pack-macos.sh must run on macOS (needs hdiutil / codesign)" >&2
  exit 1
fi

mkdir -p "${OUT}"
APP="${OUT}/Garia.app"
rm -rf "${APP}"

MACOS="${APP}/Contents/MacOS"
RESOURCES="${APP}/Contents/Resources"
mkdir -p "${MACOS}" "${RESOURCES}"

# Sidecars must sit next to the executable (garia-core looks in current_exe dir).
cp "${BINARY}" "${MACOS}/garia"
cp "${ARIA2}" "${MACOS}/aria2c"
cp "${FFMPEG}" "${MACOS}/ffmpeg"
cp "${YTDLP}" "${MACOS}/yt-dlp"
chmod +x "${MACOS}/garia" "${MACOS}/aria2c" "${MACOS}/ffmpeg" "${MACOS}/yt-dlp"

cp "${ROOT}/assets/icons/icon.icns" "${RESOURCES}/AppIcon.icns"
sed "s/__VERSION__/${VERSION}/g" "${ROOT}/packaging/Info.plist" > "${APP}/Contents/Info.plist"

# Optional: import Developer ID cert when provided as base64 .p12
KEYCHAIN=""
cleanup_keychain() {
  if [ -n "${KEYCHAIN}" ] && [ -f "${KEYCHAIN}" ]; then
    security delete-keychain "${KEYCHAIN}" >/dev/null 2>&1 || true
  fi
}
trap cleanup_keychain EXIT

IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [ -n "${APPLE_CERTIFICATE:-}" ] && [ -n "${APPLE_CERTIFICATE_PASSWORD:-}" ]; then
  KEYCHAIN="$(mktemp -t garia-signing.XXXXXX.keychain-db)"
  rm -f "${KEYCHAIN}"
  security create-keychain -p "" "${KEYCHAIN}"
  security set-keychain-settings -lut 21600 "${KEYCHAIN}"
  security unlock-keychain -p "" "${KEYCHAIN}"
  CERT_PATH="$(mktemp -t garia-cert.XXXXXX.p12)"
  echo "${APPLE_CERTIFICATE}" | base64 --decode > "${CERT_PATH}"
  security import "${CERT_PATH}" -k "${KEYCHAIN}" -P "${APPLE_CERTIFICATE_PASSWORD}" \
    -T /usr/bin/codesign -T /usr/bin/security
  rm -f "${CERT_PATH}"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" "${KEYCHAIN}" >/dev/null
  security list-keychains -d user -s "${KEYCHAIN}" $(security list-keychains -d user | sed 's/"//g')
  if [ -z "${IDENTITY}" ]; then
    IDENTITY="$(security find-identity -v -p codesigning "${KEYCHAIN}" | awk -F\" '/Developer ID Application/{print $2; exit}')"
  fi
  echo "Using signing identity: ${IDENTITY:-<none found>}"
fi

sign_item() {
  local path="$1"
  if [ -z "${IDENTITY}" ]; then
    return 0
  fi
  codesign --force --options runtime --timestamp \
    --entitlements "${ROOT}/packaging/entitlements.plist" \
    --sign "${IDENTITY}" \
    "${path}"
}

# Sign helpers first, then the main binary, then the bundle.
if [ -n "${IDENTITY}" ]; then
  sign_item "${MACOS}/aria2c"
  sign_item "${MACOS}/ffmpeg"
  sign_item "${MACOS}/yt-dlp"
  sign_item "${MACOS}/garia"
  codesign --force --options runtime --timestamp \
    --entitlements "${ROOT}/packaging/entitlements.plist" \
    --sign "${IDENTITY}" \
    "${APP}"
  codesign --verify --deep --strict "${APP}"
else
  echo "No APPLE_SIGNING_IDENTITY / certificate — shipping unsigned .app"
fi

DMG_NAME="Garia_${VERSION}_${ARCH_LABEL}.dmg"
DMG_PATH="${OUT}/${DMG_NAME}"
STAGE_DMG="${OUT}/.dmg-stage"
rm -rf "${STAGE_DMG}" "${DMG_PATH}"
mkdir -p "${STAGE_DMG}"
cp -R "${APP}" "${STAGE_DMG}/Garia.app"
ln -s /Applications "${STAGE_DMG}/Applications"

hdiutil create \
  -volname "Garia" \
  -srcfolder "${STAGE_DMG}" \
  -ov -format UDZO \
  "${DMG_PATH}"
rm -rf "${STAGE_DMG}"

if [ -n "${IDENTITY}" ]; then
  codesign --force --sign "${IDENTITY}" --timestamp "${DMG_PATH}" || true
fi

# Notarization is optional — skip quietly when Apple ID secrets are absent.
if [ -n "${IDENTITY}" ] && [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  echo "Submitting DMG for notarization…"
  xcrun notarytool submit "${DMG_PATH}" \
    --apple-id "${APPLE_ID}" \
    --password "${APPLE_PASSWORD}" \
    --team-id "${APPLE_TEAM_ID}" \
    --wait
  xcrun stapler staple "${DMG_PATH}"
  xcrun stapler staple "${APP}" || true
else
  echo "Skipping notarization (set APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID to enable)."
fi

APP_TGZ="${OUT}/Garia_${ARCH_LABEL}.app.tar.gz"
tar -C "${OUT}" -czf "${APP_TGZ}" Garia.app

(
  cd "${OUT}"
  shasum -a 256 "${DMG_NAME}" "Garia_${ARCH_LABEL}.app.tar.gz" > "Garia_${VERSION}_${ARCH_LABEL}.SHA256SUMS"
)

echo "Built ${DMG_PATH}"
echo "Built ${APP_TGZ}"
