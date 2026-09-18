# Remote control

Everything in Garia already talks to aria2 over JSON-RPC on a port, so letting an aria2 client on a phone do the same is one launch flag — `--rpc-listen-all=true`, off by default and turned on in Settings. What it is not is one decision. Three things have to change together.

**The socket stops being this machine's.** aria2 has no setting between loopback and every interface — there is no "listen on this one" for the RPC port — so turning this on binds `*`, on IPv4 and IPv6 both. And it is launch-only: `rpc-listen-all` sent to `aria2.changeGlobalOption` answers `OK`, leaves the socket bound exactly as it was, and `getGlobalOption` still reports the old value. Measured against aria2 1.37, and the same trap the cookie jar and the proxy sprang — so this is another setting that restarts the download engine, and unfinished downloads come back from the session file mid-file.

**The token stops being per-launch.** A secret generated fresh every launch is right for a port only this machine can reach and useless for one a phone is paired with. So while remote control is on the token lives in a `remote-secret` file at `0600` in Garia's app data, beside the logins and for the same reason — a credential does not belong in `settings.json`, which the user is invited to read. Turning remote control off *deletes* that file, so every paired device is un-paired rather than merely waiting for the port to come back; turning it on again mints a new one.

**The secret has to reach the other device.** The address and the port are short enough to read off the screen and type. Thirty-two hex characters are not, so Settings draws them as a QR code — the secret alone, not a URL with the secret in it, because clients ask for host, port and token as three separate fields and a token in a URL is a token in a history file. Rust encodes it and hands the frontend a square of modules; the SVG is drawn in the page, black on white whatever else the window is, as one rect per horizontal run rather than one per module.

The address comes off the routing table rather than an interface walk: a UDP socket that has been *connected* has chosen a route and therefore a source address, and connecting a UDP socket sends nothing. The address it is pointed at is in TEST-NET-1, reserved so that it can be named without meaning a real host.

Two things the panel says out loud. The traffic is plain HTTP, so the secret crosses the network in the clear on every request — worth having at home, worth leaving off on a network you don't know. And if something else held aria2's usual port when Garia started, the pairing still works but the number can be different next launch.

A browser client such as AriaNg is the one thing this does not reach: aria2 sends no `Access-Control-Allow-Origin` header, and Garia does not pass `--rpc-allow-origin-all`, which was deliberately left out. Native clients are unaffected — CORS is a browser rule.
