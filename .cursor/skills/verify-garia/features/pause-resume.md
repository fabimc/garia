# Pause and resume

Pause and resume lets a user stop an active download from its row icon and later start it again, with the row status updating to match.

## Sub-features

- `pause-row` pauses one active download via the row Pause control.
- `pause-status` shows `data-status=paused` after pause.
- `resume-row` resumes a paused download via the row Resume control (when the icon offers it).

## How to get to it (user POV)

- On an active row, choose the Pause control on the row icon (aria-label `Pause`).
- On a paused row, choose Resume (aria-label `Resume`).
- Choose `Pause all` in the header — bulk path; map it only when proving that control.
- Press Space with a row selected — keyboard path.

## Driving it with control-garia

Preconditions:

- `./helpers/control-garia doctor` reports `ok: true`.
- An active seeded row named `Ubuntu 24.04 Desktop.iso` is present (mock default).

- **Locate active row.** Choose Active. Run `./helpers/control-garia browser filter --name Active`. A row for `Ubuntu 24.04 Desktop.iso` is listed with active status.
- **Pause.** Choose Pause on that row. Run `./helpers/control-garia browser pause-named --name 'Ubuntu 24.04 Desktop.iso'`. Command exits 0 and reports `status: "paused"`.
- **Confirm in Paused filter.** Choose Paused. Run `./helpers/control-garia browser filter --name Paused`. The Ubuntu row is visible.
- **Proof.** Run `./helpers/control-garia browser snapshot --path pause-resume/paused.aria.txt` and `./helpers/control-garia browser screenshot --path pause-resume/paused.png`. Artifacts show the paused Ubuntu row. Optionally `./helpers/control-garia rpc aria2.tellWaiting '[0,100,["gid","status","files"]]'` includes a paused Ubuntu path.

## Gotchas

- Pause the seeded Ubuntu ISO, not a seeding torrent — Garia models stop-seeding as remove, not pause.
- After pause, the row leaves the Active filter; assert in All Downloads or Paused.
- `Pause all` requires enabled header buttons and selected/global semantics — do not treat a disabled `#pause-all` as a pass.
- Resume after pause is supported by the mock (`aria2.unpause`); if the row icon does not expose Resume yet, report the unmet control rather than clicking elsewhere.
