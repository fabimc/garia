# Feature: Authentication and proxy

Three ways to prove identity. They are different promises, stored in different places.

## Password → netrc

- Stored in `logins.json` (0600); derived `netrc` for aria2.
- Never passed as `http-passwd` on a download: that lands in the session file and is returned by `getOption` to anyone with the RPC token (measured on aria2 1.37).
- Frontend never receives passwords — only `hasPassword` and headers for a host.
- netrc has no quoting: passwords with whitespace become an `Authorization:` header instead, and the UI says which path was used.
- aria2 silently ignores a world-readable netrc.

## Headers

- Literal download options. They do land in the session file (needed for resume).
- Bearer tokens on disk are an honest cost; the dialog says so.

## Cookie jar

- Path to a Netscape `cookies.txt` from the browser. Nothing is copied.
- aria2 matches hosts itself. yt-dlp reads the same path for probes.

## Restart

Saving a login or proxy **restarts** aria2 on the same port. netrc, cookies, and `--all-proxy` are launch-only. Header-only edits do not restart.

## HTTP proxy

- Host, port, optional login. Password in `proxy-passwd` (0600), not `settings.json`.
- Covers HTTP/HTTPS/FTP. BitTorrent peers stay direct.
- yt-dlp gets the same proxy for page probes.
- No SOCKS / NTLM / Kerberos (aria2 does not speak them).

## Failures

aria2 error 24 → row text "Needs a login" with a fix inside the app. Retry re-queues with whatever was saved since.

## Related

- Code: `src-tauri/src/logins.rs`
- [docs/Authentication.md](../../../docs/Authentication.md)
