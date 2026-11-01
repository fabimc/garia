# Feature: Torrents

Magnets and `.torrent` files go through aria2 BitTorrent. Garia adds UI statuses and file controls that aria2 does not name.

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
