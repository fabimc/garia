# Agent notes (Garia)

Verification skills live under `.cursor/skills/` once merged (`verify-garia`, `formal-verify-garia-schedule`).

## Maintain triggers

- After **UI journey** changes (frontend journeys, feature map, mock-RPC browser-dev harness): run pstack **`/maintain-verification-skill`** on `verify-garia`.
- After **schedule / decide** changes (`schedule.rs`, `schedule_tick`, Stop/Start Queue, per-download start, clock-driven pause/unpause): run pstack **`/maintain-formal-verification-skill`** on `formal-verify-garia-schedule`.

Do not edit product code inside a maintain run. Formal known findings (`NoStaleHold`, `OverrideStickyWhileGated`) stay open product decisions until a human asks for a fix — re-check them; do not weaken the invariants.
