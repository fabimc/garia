# Packaging notes (post-Tauri)

The iced binary is **`garia`** (`cargo build --release -p garia`).

Installer wiring (DMG / AppImage / `.deb`) is a follow-up. Until then, release CI ships the cargo-built binary (plus sidecars when built). Use these files when packaging:

| File | Purpose |
|------|---------|
| `Info.plist` | macOS URL schemes (`garia`, `magnet`) + Services menu entry |
| `entitlements.plist` | Hardened-runtime entitlements for a signed Mac `.app` |
| `garia.desktop` | Linux MIME / scheme associations (`.torrent`, `garia://`, `magnet:`) |
| `updater/garia.key.pub` | Public key for a future signed `latest.json` updater |
| `../assets/icons/` | App / tray icons |

**Identifier:** `com.fabimc.garia`  
**Product name:** Garia  

Runtime already accepts `garia://`, `magnet:`, and `.torrent` paths via argv; OS registration happens when these assets are installed into a real bundle/package.
