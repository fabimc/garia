# Feature: Schedule and queue hold

Two clocks and one verb. Enforced in Rust (`schedule.rs`), not only in the frontend.

## Why Rust owns it

aria2 resumes unfinished downloads from the session file before the webview paints. A shut window at 09:00 must already be shut by something that runs earlier than JavaScript.

## Daily window

- Downloads run between two local times; held outside the window.
- Times are minutes since local midnight (survive DST). `end` before `start` wraps midnight (overnight).
- On first tick after launch, reconcile against the wall clock: open the window immediately if already inside it.

## Per-download start

- Add sheet or detail panel can name a start time for one download.
- Meaning: start at that time, **or** the next moment Garia is open after it. Not an alarm clock that wakes the Mac.
- A new scheduled download is added paused; record that scheduler-owned hold with its start time, so it survives a restart. A pre-existing user pause is not a scheduler hold.

## Stop Queue / Start Queue

- Stop Queue: pause running and queued work; nothing new starts. Seeding continues.
- Start Queue: release only what Garia stopped. A hand-paused row stays paused.
- Distinct UI status from a manual pause.

## Done action

- After the last unfinished download lands: none / sleep / shut down (Mac).
- Arm only after this run has had real work — launch onto an empty list must not sleep the machine.
- 30-second warning before sleep/shutdown.

## aria2 traps (measured on 1.37)

- Global `pause` via `changeGlobalOption` answers OK and does nothing → hold per download.
- `pause=true` on `addUri` starts paused; `getOption` does not report it (action, not stored setting).
- `forcePause` works on waiting and active downloads.

## Related

- Code: `src-tauri/src/schedule.rs`
- [docs/How-It-Works.md](../../../docs/How-It-Works.md)
