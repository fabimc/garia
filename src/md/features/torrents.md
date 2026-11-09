# Feature: Torrents

Magnets and `.torrent` files go through aria2 BitTorrent. Garia adds UI statuses and file controls that aria2 does not name.

## Magnets

- One magnet is one row for its whole life. aria2 first creates a metadata download named `[METADATA]…`, then a new gid for the torrent. `followedBy` (metadata) and `following` (torrent) are the link. The metadata gid is hidden once the torrent gid is in the list; until then the row is the magnet.
- Before metadata arrives the name comes from `dn`, or the info hash, and the status is "Fetching metadata…". It is not the `[METADATA]` filename and it is not a completed download.
- The metadata step finishing is not a completion. No done notification, and that gid never sits in Completed.
- Pause, resume, remove, and retry use whichever gid is live: the metadata gid before the handoff, the torrent gid after. Remove also calls `removeDownloadResult` on the metadata gid so nothing is left behind.
- Re-adding the same magnet matches `btih` / `infoHash` and says it is already in the list.
- aria2's session writer skips a download that has `followedBy`. On launch, a leftover session record whose URI line is a `[METADATA]….torrent` file is dropped whole — the path and its `gid` / `dir` — so it does not come back beside the magnet. A magnet record is kept even when one of its options mentions that name.
- The follow-up gid is created by aria2, not by `addUri`. Quiet hours and Stop Queue still hold it: `schedule_tick` force-pauses every active or waiting download the clock does not allow. That is the path for anything that did not come through `addUri`. `decide` / `allowed` are unchanged.

## Seeding

- After download, aria2 keeps the torrent `active` with `seeder` set.
- Garia maps that to **Seeding**: show shared bytes and ratio, not percent/ETA.
- Completion notice fires when files land, not when seeding ends.
- Stop seeding is `aria2.remove`. A removed torrent with every byte present files as complete.

## Seed limits

- Share ratio and seed time live in Settings.
- aria2 will not apply those limits to an already-running download → set at launch and again on each torrent at add time.

## File select and priorities

- Detail panel ticks files (`--select-file`).
- aria2 refuses select-file while actively working → force-pause, wait until really paused, change, unpause.
- Priorities High / Normal / Low / Off are Garia rules on top of select-file. aria2 has no per-file piece priority.
- High unfinished files block later tiers (`desiredIndices` in `src/parity.js`).
- Unknown size counts as unfinished so a magnet does not skip ahead.

## Health

- Stalled: torrent still has work and no useful peers.
- Tracker / health copy is the closest honest reading of aria2 peer data — not a uTorrent clone of tracker status.

## Related

- [docs/uTorrent-Parity.md](../../../docs/uTorrent-Parity.md) (formal parity notes)
- Decision helpers: `src/parity.js`
