# Feature: Remote control

Optional: let an aria2 client on the local network drive the same RPC port.

## Three changes together

1. **Socket** — `--rpc-listen-all=true`. aria2 has no "this interface only". Launch-only (`changeGlobalOption` lies with OK). Restart required.
2. **Secret** — while on, token lives in `remote-secret` (0600) and persists across launches. Turning off **deletes** the file (un-pairs devices). Turning on again mints a new secret.
3. **Pairing** — Settings shows host, port, and a QR of the secret alone (not a URL — clients want three fields; a secret in a URL is a secret in history).

## Address discovery

Use a connected UDP socket to TEST-NET-1 to learn the routed source address. Connecting UDP sends nothing.

## Deliberate limits

- Traffic is plain HTTP; the secret crosses the LAN in the clear. Fine at home; leave off on unknown networks.
- No `--rpc-allow-origin-all`: browser clients (AriaNg) are blocked by CORS on purpose. Native clients are unaffected.
- If port 6800 was taken at launch, the actual port may differ next time — say so in the UI.

## Related

- [docs/Remote-Control.md](../../../docs/Remote-Control.md)
- [api/aria2-rpc.md](../api/aria2-rpc.md)
