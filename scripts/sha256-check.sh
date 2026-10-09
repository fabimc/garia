#!/usr/bin/env bash
# Verify a file's SHA-256. Usage: sha256-check.sh <hex> <file>
set -euo pipefail
EXPECTED="$1"
FILE="$2"
if command -v sha256sum >/dev/null 2>&1; then
  echo "${EXPECTED}  ${FILE}" | sha256sum -c - >/dev/null
elif command -v shasum >/dev/null 2>&1; then
  echo "${EXPECTED}  ${FILE}" | shasum -a 256 -c - >/dev/null
else
  echo "need sha256sum or shasum" >&2
  exit 1
fi
