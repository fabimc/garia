# Data: Settings and secret files

User preferences live beside the aria2 session in the app data directory. Passwords do not share that readable JSON file.

## `settings.json`

Holds non-secret preferences: download folder, concurrency, traffic modes/limits, categories, capture flags, schedule times, proxy host (not password), remote-control boolean, done action, and so on.

### Migrations / defaults that matter

| Case | Behavior |
|------|----------|
| File has a bare overall cap and no `trafficMode` | Cap becomes Medium; app starts capped as left |
| Missing `confirmCapture` | Default true (browser click ≠ bookmarklet) |
| Missing `setupSeen` on upgrade | Treat as already seen (do not reopen first-run sheet) |
| Empty `downloadDir` or concurrency 0 | Normalise before use — aria2 would stall or refuse |

Frontend-facing copies strip secrets and may add `hasProxyPassword`. Disk writes never serialize `proxyPassword`.

## Secret / derived files (0600)

| File | Role |
|------|------|
| `logins.json` | Garia credential store |
| `netrc` | Derived for aria2 only |
| `proxy-passwd` | Proxy password |
| `remote-secret` | Persistent RPC token while remote control is on |
| `session.txt` | aria2 unfinished downloads |
| `download-history.json` | Completed rows and finished merge halves; may contain source URLs |

## Categories

Stored as a list of `{ id, name, extensions, folder, host }`. Empty list + smart folders on → built-in four kinds. Frontend keeps a matching table when Settings was never saved after enabling the switch (`FOLDERS` in `src/main.js`).

## Related

- Struct and normalise logic: `src-tauri/src/lib.rs` (`Settings`)
- [features/authentication.md](../features/authentication.md)
