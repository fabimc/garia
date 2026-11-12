---
name: formal-verify-garia-schedule
description: "Formally verify Garia's schedule hold/release/override state machine (Stop Queue, daily window, per-download start, user Resume) with TLA+/TLC. Use when changing schedule.rs decide/allowed/reconcile, schedule_tick, set_queue_stopped, set_download_start, or any code that pauses/unpauses downloads for the clock."
---

# Formal verify — Garia schedule hold

Use this skill when a change touches the download scheduler's hold/release/override behavior. It checks every interleaving in scope of user pause/resume, Stop/Start Queue, daily window open/close, and per-download start times — cases tests rarely order.

This is **not** the behavioral `verify-garia` skill. It does not launch the UI.

## Property (plain words)

1. **UserPauseSafety** — The scheduler never unpauses a download it did not itself hold. Harm: a download the user paused overnight starts again when the window opens.
2. **OverrideNoFight** — After the user resumes inside a shut window/stopped queue, the scheduler does not force-pause that download again for the rest of that shut period. Harm: Resume is undone on the next 15s tick.
3. **NoStaleHold** — After a scheduler tick, a running download must not still be marked `held`. Harm: Resume races a window/queue opening, `held` sticks, and a later user Pause is mistaken for a scheduler hold and gets Released.
4. **OverrideStickyWhileGated** — When the tick decides `Overridden` but the download is still not `allowed` (e.g. start time not due), `overridden` must remain set. Harm: clearing overrides whenever the daily window/`open` bit is true forgets a resume of a start-gated row and the next tick Holds it again.

**Baseline of current product code:** properties 1–4 hold under `./scripts/run-tlc full`. Do not weaken the invariants. Do not change product code in a formal-verify / maintain run unless the user asked for a fix.

## Tool and why

**TLA+ / TLC** (model checker). The question is whether events can happen in a bad order across ticks and user actions — that is a model-checking question. Garia’s scheduler is Rust; there is no in-language model checker wired here. TLC runs on the pinned `tla2tools.jar` (Java): GitHub release **v1.8.0**, whose asset banners as `TLC2 Version 2026.11.06.222357 (rev: d8fb231)` — `scripts/run-tlc` checks the jar SHA-256 so download, pin, and evidence stay aligned. Prefer this over inventing more unit tests: the unit tests in `schedule.rs` cover discrete `decide` cases, not the interleavings with `open` vs `allowed` and sticky `held`.

## Coverage record

| Check | Code (open these) | Model |
| --- | --- | --- |
| `decide` / `allowed` | `src-tauri/src/schedule.rs` — `decide`, `allowed`, `Saved.held`, `Schedule.overridden`, `reconcile` | `model/ScheduleHold.tla` operators `Decide`, `Allowed`, vars `held` / `overridden` |
| tick apply | `src-tauri/src/lib.rs` — `schedule_tick` (forcePause/unpause, hold/unhold, clear overrides when allowed) | `Tick` |
| Stop/Start Queue | `src-tauri/src/lib.rs` — `set_queue_stopped_blocking` | `CloseWindow` / `OpenWindow` (+ later `Tick`) |
| per-download start | `src-tauri/src/lib.rs` — `set_download_start_blocking` | `AssignFutureStart`, `StartBecomesDue` |
| user pause/resume | Frontend/RPC pause & unpause (aria2 status only; does not edit `held`) | `UserPause`, `UserResume` |

**Sync commit:** `c020a769b020539c15e58124eda04b4c6f0e7d93` (product files above last confirmed to match this model). Move this forward only after you confirm the model still describes those files at the new commit.

## Bounds and assumptions

- **One download (one gid).** Multi-gid races are out of scope.
- Status is only `running` (aria2 `active`/`waiting`) or `paused`. Seeders are already excluded from `rows` in `schedule_tick`.
- aria2 `forcePause` / `unpause` succeed when the tick chooses them (no RPC failure mid-tick). For `Release` on an already-running row, the tick unholds without requiring an unpause RPC (aria2 rejects unpause of active).
- No Quit, process death, or session reload mid-trace.
- `OpenWindow` then `Tick` models Start Queue’s immediate tick and the daily-window boundary tick; Close/Open alone are also enabled so interleavings with user actions are explored.
- State space is finite and small (~hundreds of distinct states); a run finishes in seconds.

## How to run

From this skill directory:

```bash
./scripts/run-tlc passing   # props 1–2 (subset; expect exit 0)
./scripts/run-tlc full      # all four props; expect exit 0
```

Requires network once to fetch `model/tla2tools.jar` (pinned URL inside the script), and `java` (OpenJDK 17+).

**Reading results:** Read every TLC result with the pstack `/statechart` skill (by name). Do not copy statechart CLI paths into this skill — they change between releases.

## When the covered code changes

1. Diff `schedule.rs` and the `schedule_tick` / `set_queue_stopped_blocking` / `set_download_start_blocking` regions of `lib.rs` from the sync commit to `HEAD`.
2. Update `Decide` / `Allowed` / `Tick` / environment actions so each step still matches one indivisible step in the code. Names stay from this repo.
3. Run `./scripts/run-tlc full` and `./scripts/run-tlc passing`.
4. A new violation of any of props 1–4 is a **bug candidate** (or a deliberate promise change — cite the evidence). Do not weaken the invariant to make TLC pass.
5. Only then move the sync commit forward.
6. Point maintain work at `/maintain-formal-verification-skill`.

## Real bug vs modeling error

- Replay the counterexample as a sequence of Garia steps (Stop Queue, Resume, Start Queue, Pause, tick…). If a step cannot happen in the code, fix the model.
- If every step can happen, it is a finding about the code. State the harm in one sentence. Do not weaken the invariant to make TLC pass.
- Do not change product code in a formal-verify run unless the user asked for a fix.

## Prove this skill still works (scratch break)

After any edit to the model or runner, once:

1. Scratch-break **product** `schedule::decide` so a user pause is Released when the window opens (e.g. treat any paused row as held on the allowed/paused arm), and mirror that change in `Decide` in `ScheduleHold.tla`.
2. `./scripts/run-tlc passing` must **fail** on `UserPauseSafety`.
3. Drop both scratch changes; `./scripts/run-tlc passing` and `./scripts/run-tlc full` must both pass again.

## Out of scope

- UI / mock-RPC / browser-dev proofs (`verify-garia`)
- Quit vs close, tray, dock, aria2 process lifecycle
- Concurrent multi-gid ticks, RPC failures, drain/done-action, seeding
