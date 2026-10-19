#!/usr/bin/env bash
# Shared helpers for packaging scripts. Source from other scripts; do not run directly.

pack_cargo_version() {
  local root="$1"
  awk '
    $0 == "[workspace.package]" { in_pkg = 1; next }
    in_pkg && /^\[/ { exit }
    in_pkg && $1 == "version" {
      gsub(/"/, "", $3)
      print $3
      exit
    }
  ' "${root}/Cargo.toml"
}

pack_require_file() {
  local path="$1"
  if [ ! -e "${path}" ]; then
    echo "missing required file: ${path}" >&2
    exit 1
  fi
}

pack_require_exec() {
  local path="$1"
  pack_require_file "${path}"
  if [ ! -x "${path}" ]; then
    chmod +x "${path}"
  fi
}
