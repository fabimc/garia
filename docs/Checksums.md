# Checksum verification

Paste a hash into the add dialog and it goes to aria2 as `--checksum=sha-256=…`. aria2 hashes the bytes as they arrive, so the check costs the download nothing, and it will not file a download as complete unless the digest matches — which is why a *Verified* chip is not a claim Garia is making. There is nothing for it to store: a completed download whose `getOption` still carries a `checksum` is a checked one, and the option lives in aria2's session file for as long as the download does.

The field takes what is actually in the clipboard. A bare digest names its own algorithm, because aria2 knows seven of them and each has one digit count — 32 for MD5, 40 for SHA-1, 56, 64, 96, 128 for the SHA-2 family, 8 for Adler-32 — and refuses a `--checksum` whose length and algorithm disagree. So `sha256:…`, `SHA-256 = …`, a whole `<hash>  <filename>` line out of a SHASUMS file, and certutil's two-digit groups all resolve to the one string aria2 takes. A hash that cannot be one says why, and the OK button waits: a `--checksum` aria2 would reject is a download that never starts.

A mismatch is aria2's error 32, which it sends with no message of its own, so the row reads *What arrived doesn't match the checksum*. Every byte is still on disk — aria2 reports `completedLength` 0 and leaves the file and its `.aria2` control file where they are — so deleting the row can take the file with it, and Retry re-runs the check rather than the download: with the control file still there aria2 resumes at the end of a finished file and only hashes it.

The detail panel takes a hash too, and which call it uses depends on when it is asked:

- **While the download runs** — `aria2.changeOption`, which really does apply `checksum` to a download in flight. Most options it accepts and ignores; this is one of the few it doesn't, measured against aria2 1.37.
- **After it has landed** — `changeOption` is refused outright (*Cannot change option for GID#…*), so the download is added again with the same folder, the same name and the hash. aria2 finds every byte already on disk, fetches none of them, and answers with the digest in a fraction of a second. It does ask the server how long the file is first, so a URL that has expired is a check that can no longer be run.

Torrents never see the field. They carry a hash per piece already, and `--checksum` is HTTP and FTP only.
