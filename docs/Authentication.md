# Downloads behind a login

A file behind a sign-in needs one of three things, and Garia keeps them in three different places on purpose — because they are not the same promise.

**A password** goes into a netrc file in Garia's app data, at `0600`, which aria2 reads for itself: per request, per host, matched by aria2 rather than by Garia. It is never an option on a download. That distinction is the whole point of the netrc — a password passed to `aria2.addUri` as `http-passwd` is written verbatim into the session file that keeps unfinished downloads across a quit, and is handed back by `getOption` to anything holding the RPC token. Measured against aria2 1.37, not assumed.

**A header** is a literal aria2 has to put on the request, so it *is* an option on the download, and it does land in the session file — which is how a resume after a quit still gets through, and also means a bearer token in one is written to disk. The dialog says so rather than pretending otherwise.

**A cookie jar** is a path to a `cookies.txt` exported from the browser. Nothing is copied: the file stays where it is, and aria2 matches its cookies to hosts itself.

Two things netrc will not do, both found by trying them. It has no quoting at all — `password "two words"` is read as the literal `"two` — so a password with whitespace in it cannot go in one; Garia sends that one as an `Authorization:` header instead and says which of the two it did. And aria2 ignores a netrc that anyone but its owner can read, silently, with no auth header on the wire.

Saving a login **restarts aria2**. Both the netrc and the cookie jar are read once, when it starts: `load-cookies` sent to `aria2.changeGlobalOption` or carried on `addUri` is accepted, answers `OK`, and loads nothing, and a netrc written after aria2 started is a file it has already read. So Garia does what quitting and reopening does — saves the session, stops aria2, starts it on the same port, and waits until it answers — and every unfinished download resumes mid-file, the same way it does across a relaunch. Editing only a site's headers changes nothing aria2 reads, and restarts nothing.

A download that fails for want of a login says so: aria2's error 24 is the one failure with a fix inside the app, so the row reads *Needs a login — add one in Settings* rather than *Authorization failed*, and Retry re-queues it with whatever has been saved since.

## HTTP proxy

An HTTP proxy is the same restart, for the same reason: `--all-proxy` is a launch flag. Settings → Access takes a host, a port, and an optional login. The password lives in `proxy-passwd` at `0600`, beside the logins, not in `settings.json`. HTTP, HTTPS, and FTP go through it; BitTorrent peers do not, because they are not HTTP. yt-dlp uses the same proxy when it reads a video page, so a YouTube probe on a network that needs one still works. Hosts in the bypass list skip it. SOCKS, NTLM, and Kerberos are not offered — aria2 does not speak them.
