# FTP

Paste `ftp://ftp.example.com/pub/` into the add dialog and Garia lists the folder. Files are ticked and queued through aria2; a folder is opened, not downloaded. That is the whole UI — not a site grabber, not SFTP, not a recursive copy.

The password is the site login already in Settings, the same netrc aria2 reads when it fetches the file. It is never sent to the dialog and never attached to the download. A one-off `ftp://user:pass@host/…` still lists, and those file URLs keep the userinfo so aria2 can sign in without a saved login — the picker shows the name, not the secret.

A URL that already names a file (`ftp://host/a.iso`) skips the listing and starts, the same way a `.zip` on HTTPS does. `ftps://` is a file aria2 can fetch; listing one is not something Garia does.

See [Downloads behind a login](Authentication.md) for how the netrc is stored.
