//! ── The scheduler ────────────────────────────────────────────────────────
//!
//! Two clocks, and one of them is a promise garia cannot keep on its own.
//!
//! The first is a window: downloads run between two times of day and are held
//! outside it. The second is per download — a row that waits until a moment
//! the user named. Both are enforced here rather than in the frontend, for a
//! reason that shows up at launch: aria2 reads its session file and starts
//! every unfinished download in it before the webview has painted, so a window
//! that is shut at 09:00 has to be shut by something that runs earlier than
//! any JavaScript.
//!
//! What it deliberately does not do is pretend to be an alarm clock. garia's
//! downloads are aria2's, aria2 is garia's child process, and a child process
//! of an app that isn't running isn't running either — so "start at 2am" means
//! "start at 2am, or the moment garia is next open after it". The window is
//! reconciled against the wall clock on the first tick, which is why a launch
//! at 03:00 into a window that opened at 02:00 starts downloading immediately
//! instead of waiting for the next boundary. The dialog says this in words;
//! nothing here quietly rounds it off.
//!
//! Three things measured against aria2 1.37 rather than assumed:
//!
//!   * `pause` sent to `changeGlobalOption` answers **OK** and does nothing —
//!     `getGlobalOption` does not even list it as an option. It is the fourth
//!     member of the family `rpc-listen-all`, `load-cookies` and
//!     `stream-piece-selector` belong to, and the reason a shut window is
//!     applied per download rather than pushed at the process once.
//!   * `pause=true` *is* honoured as a per-download option at `addUri`: the
//!     download comes back already `paused`. `getOption` does not report it
//!     afterwards, because it is an action rather than a stored setting — so
//!     it leaves no trace in the session file and nothing to clean up.
//!   * `forcePause` works on a `waiting` download as well as an `active` one,
//!     and both land on `paused`. Which is what lets one code path hold a
//!     download that has started and one that has only been queued.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Minutes in a day, which is the unit both ends of the window are kept in:
/// a time of day is not a timestamp, and storing it as one would mean a window
/// set in June drifting an hour in November.
pub const DAY: u32 = 24 * 60;

/// How often the window is reconciled against the clock. A minute would be
/// enough for the boundaries — they are on minute lines — but a download added
/// during quiet hours is held by the `addUri` path immediately, so this only
/// has to catch the boundary itself and anything that arrived another way.
pub const TICK: std::time::Duration = std::time::Duration::from_secs(15);

/// What survives a quit. The start times obviously have to — a row told to
/// begin at 2am is still that row after a relaunch, and gids are stable across
/// one because aria2 writes them into the session file. `held` has to as well,
/// and less obviously: a download this code paused at midnight and a download
/// the *user* paused at midnight are both just `paused` to aria2, and the
/// difference between them is the whole of not resuming someone's deliberately
/// stopped download at 6am.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Saved {
    /// gid → the epoch second it may start at.
    pub starts: BTreeMap<String, i64>,
    /// gids this scheduler paused, and is therefore the one to un-pause.
    pub held: BTreeSet<String>,
}

pub struct Schedule {
    file: PathBuf,
    saved: Mutex<Saved>,
    /// gids the user started anyway, inside a shut window. Not persisted, and
    /// deliberately: an override is an answer to *this* window, and a relaunch
    /// is a fresh question. Holding it in memory also keeps the scheduler from
    /// fighting the person using it — without this, a download un-paused by
    /// hand at 3am would be re-paused fifteen seconds later, forever.
    overridden: Mutex<BTreeSet<String>>,
}

impl Schedule {
    pub fn new(file: PathBuf) -> Self {
        let saved = std::fs::read_to_string(&file)
            .ok()
            .and_then(|text| serde_json::from_str::<Saved>(&text).ok())
            .unwrap_or_default();
        Self {
            file,
            saved: Mutex::new(saved),
            overridden: Mutex::new(BTreeSet::new()),
        }
    }

    pub fn snapshot(&self) -> Saved {
        self.saved.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// Every mutation goes through here so that nothing can change the set of
    /// held gids without the file on disk agreeing — the one piece of state
    /// whose loss would strand a download in `paused` with nobody left who
    /// knows to start it again.
    fn edit(&self, change: impl FnOnce(&mut Saved)) -> Saved {
        let Ok(mut guard) = self.saved.lock() else {
            return Saved::default();
        };
        change(&mut guard);
        let copy = guard.clone();
        drop(guard);
        if let Ok(json) = serde_json::to_string_pretty(&copy) {
            if let Err(e) = std::fs::write(&self.file, json) {
                eprintln!("[garia] Could not write the schedule: {e}");
            }
        }
        copy
    }

    pub fn hold(&self, gid: &str) {
        self.edit(|s| {
            s.held.insert(gid.to_string());
        });
    }

    pub fn set_start(&self, gid: &str, at: Option<i64>) -> Saved {
        self.edit(|s| match at {
            Some(at) => {
                s.starts.insert(gid.to_string(), at);
            }
            None => {
                s.starts.remove(gid);
            }
        })
    }

    /// Clearing a start time is also an instruction to stop holding the row for
    /// it, which is separate from the window still being shut.
    pub fn release(&self, gid: &str) {
        self.edit(|s| {
            s.held.remove(gid);
        });
    }

    pub fn overridden(&self) -> BTreeSet<String> {
        self.overridden.lock().map(|o| o.clone()).unwrap_or_default()
    }

    pub fn set_overridden(&self, next: BTreeSet<String>) {
        if let Ok(mut guard) = self.overridden.lock() {
            *guard = next;
        }
    }

    /// One tick's worth of changes, written once. `known` is every gid aria2
    /// still has — anything else has been deleted out from under us, and
    /// keeping it would mean the file growing forever with the gids of
    /// downloads nobody can name any more.
    pub fn reconcile(
        &self,
        hold: &[String],
        unhold: &[String],
        spent: &[String],
        known: &BTreeSet<String>,
    ) {
        self.edit(|s| {
            for gid in hold {
                s.held.insert(gid.clone());
            }
            for gid in unhold {
                s.held.remove(gid);
            }
            for gid in spent {
                s.starts.remove(gid);
            }
            s.held.retain(|gid| known.contains(gid));
            s.starts.retain(|gid, _| known.contains(gid));
        });
    }
}

/// Local minutes since midnight. Local rather than UTC because a window is a
/// time of day: someone who says "between 2am and 8am" means their 2am, and
/// means it again after the clocks change.
pub fn minutes_now() -> u32 {
    use chrono::Timelike;
    let now = chrono::Local::now();
    now.hour() * 60 + now.minute()
}

pub fn epoch_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Is the window open at `minute`? A window whose end is before its start
/// wraps midnight, which is the shape the interesting case has: 2am to 8am is
/// typed as the smaller number first, but 10pm to 6am is not.
pub fn open_at(start: u32, end: u32, minute: u32) -> bool {
    if start == end {
        // Never stored — `Settings::normalised` turns a zero-length window off
        // rather than leaving it to be read as either "always" or "never".
        return true;
    }
    if start < end {
        minute >= start && minute < end
    } else {
        minute >= start || minute < end
    }
}

/// The epoch second the window next changes state, for a panel that wants to
/// count down to it. Computed from the same clock that decides `open_at`, so
/// the two can never disagree about which side of a boundary the app is on.
pub fn next_change(start: u32, end: u32) -> i64 {
    let now_min = minutes_now();
    let target = if open_at(start, end, now_min) { end } else { start };
    let mut ahead = (target + DAY - now_min) % DAY;
    if ahead == 0 {
        ahead = DAY;
    }
    // Truncated to the minute garia is in, so the answer lands on the boundary
    // rather than that many minutes from the current second.
    let now = chrono::Local::now();
    use chrono::Timelike;
    let secs_into_minute = now.second() as i64;
    epoch_now() - secs_into_minute + (ahead as i64) * 60
}

/// What the frontend is told. The window's state is here rather than derived in
/// JavaScript from the same two numbers because there must be exactly one
/// answer to "is it open" — the one the code doing the pausing used.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleState {
    pub enabled: bool,
    pub open: bool,
    pub start: u32,
    pub end: u32,
    /// Epoch seconds. 0 when there is no window, so nothing counts down.
    pub next_change: i64,
    pub held: Vec<String>,
    pub starts: BTreeMap<String, i64>,
    pub now: i64,
}

/// Merge `pause=true` into an `aria2.addUri` parameter list.
///
/// The shape is `[uris, options?, position?]` — the token has not been added
/// yet at this point. A download queued while the window is shut is held from
/// its first instant this way rather than started and stopped a moment later,
/// which for a torrent is the difference between announcing to a tracker and
/// not.
pub fn with_pause(params: serde_json::Value) -> serde_json::Value {
    let serde_json::Value::Array(mut args) = params else {
        return params;
    };
    match args.get_mut(1) {
        Some(serde_json::Value::Object(options)) => {
            options.insert("pause".into(), serde_json::json!("true"));
        }
        // No options given at all, or something that is not an object where
        // they belong: put a fresh object in the slot. Anything after it keeps
        // its position, because aria2 reads these by index.
        Some(_) | None => {
            while args.len() < 1 {
                args.push(serde_json::Value::Null);
            }
            args.insert(1, serde_json::json!({ "pause": "true" }));
        }
    }
    serde_json::Value::Array(args)
}

/// The gid an `addUri` answered with, if it answered with one at all.
pub fn gid_of(response: &serde_json::Value) -> Option<String> {
    response
        .get("result")
        .and_then(|r| r.as_str())
        .map(|s| s.to_string())
}

/// One row as the tick needs to see it.
pub struct Row {
    pub gid: String,
    pub status: String,
}

/// What to do about one download, given the clock. Split out from the tick so
/// the decision can be tested without an aria2 to talk to.
#[derive(PartialEq, Debug)]
pub enum Act {
    /// Stop it, and remember that we did.
    Hold,
    /// Start it again — we are the ones who stopped it.
    Release,
    /// It is running inside a shut window and we are not the reason: the user
    /// started it by hand, so stop trying.
    Overridden,
    Leave,
}

pub fn decide(row: &Row, allowed: bool, held: bool, overridden: bool) -> Act {
    let paused = row.status == "paused";
    match (allowed, paused, held) {
        // The window opened, or the row's hour came: whatever we stopped, we
        // start. A paused row we did *not* stop is the user's and stays put.
        (true, true, true) => Act::Release,
        (true, _, _) => Act::Leave,
        // Shut, and already stopped: nothing to do either way.
        (false, true, _) => Act::Leave,
        // Shut, running, and we thought we were holding it — so somebody
        // pressed Resume, and that is an answer rather than a race.
        (false, false, true) => Act::Overridden,
        // Shut, running, ours to stop — unless it has already been overruled.
        (false, false, false) => {
            if overridden {
                Act::Leave
            } else {
                Act::Hold
            }
        }
    }
}

/// Whether a given download may run right now: the window has to be open *and*
/// its own hour, if it was given one, has to have come.
pub fn allowed(gid: &str, window_open: bool, starts: &BTreeMap<String, i64>, now: i64) -> bool {
    window_open && starts.get(gid).map_or(true, |at| now >= *at)
}

pub fn state_file(dir: &Path) -> PathBuf {
    dir.join("schedule.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_window_is_open_between_its_ends() {
        // 02:00 → 08:00
        assert!(!open_at(120, 480, 60));
        assert!(open_at(120, 480, 120));
        assert!(open_at(120, 480, 479));
        // The end is exclusive, or a window ending at 08:00 would still be
        // open at 08:00 and the two boundaries would overlap.
        assert!(!open_at(120, 480, 480));
    }

    #[test]
    fn a_window_that_ends_before_it_starts_wraps_midnight() {
        // 22:00 → 06:00, which is the shape most people mean by "overnight".
        assert!(open_at(1320, 360, 1320));
        assert!(open_at(1320, 360, 1439));
        assert!(open_at(1320, 360, 0));
        assert!(open_at(1320, 360, 359));
        assert!(!open_at(1320, 360, 360));
        assert!(!open_at(1320, 360, 12 * 60));
    }

    #[test]
    fn a_start_time_gates_one_download_and_no_others() {
        let mut starts = BTreeMap::new();
        starts.insert("a".to_string(), 2_000);
        assert!(!allowed("a", true, &starts, 1_999));
        assert!(allowed("a", true, &starts, 2_000));
        assert!(allowed("b", true, &starts, 0));
        // A start time that has come is still no help outside the window.
        assert!(!allowed("a", false, &starts, 9_999));
    }

    #[test]
    fn a_row_resumed_by_hand_is_not_paused_again() {
        let running = Row { gid: "a".into(), status: "active".into() };
        // Tick one, inside a shut window: ours to stop, and we record it held.
        assert_eq!(decide(&running, false, false, false), Act::Hold);
        // Tick two — held, and running again, so somebody pressed Resume.
        // The row stops being ours, which drops it out of `held`.
        assert_eq!(decide(&running, false, true, false), Act::Overridden);
        // Tick three and every one after it: no longer held, and marked as
        // overruled, so it is left alone rather than fought over.
        assert_eq!(decide(&running, false, false, true), Act::Leave);
    }

    #[test]
    fn only_what_the_scheduler_paused_is_started_again() {
        let stopped = Row { gid: "a".into(), status: "paused".into() };
        assert_eq!(decide(&stopped, true, true, false), Act::Release);
        // The user's own pause, which the window opening must not undo.
        assert_eq!(decide(&stopped, true, false, false), Act::Leave);
    }

    #[test]
    fn pause_is_merged_into_the_options_addUri_already_carries() {
        let params = serde_json::json!([["http://example.test/f.iso"], { "dir": "/tmp" }]);
        let out = with_pause(params);
        assert_eq!(out[1]["dir"], "/tmp");
        assert_eq!(out[1]["pause"], "true");
        // …and made when there are none, without displacing a position.
        let out = with_pause(serde_json::json!([["http://example.test/f.iso"]]));
        assert_eq!(out[1]["pause"], "true");
        assert_eq!(out[0][0], "http://example.test/f.iso");
    }

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("garia-schedule-test-{name}.json"));
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn held_gids_survive_a_relaunch() {
        // The one piece of state whose loss strands a download: after a quit,
        // a row this code paused and a row the user paused are both just
        // `paused`, and only the file says which is which.
        let file = scratch("relaunch");
        let first = Schedule::new(file.clone());
        first.hold("aaaa");
        first.set_start("bbbb", Some(4_000));

        let second = Schedule::new(file.clone());
        assert!(second.snapshot().held.contains("aaaa"));
        assert_eq!(second.snapshot().starts.get("bbbb"), Some(&4_000));
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn a_deleted_download_is_forgotten_rather_than_kept_forever() {
        let file = scratch("prune");
        let sched = Schedule::new(file.clone());
        sched.hold("gone");
        sched.hold("here");
        sched.set_start("gone", Some(9_000));

        let known: BTreeSet<String> = ["here".to_string()].into_iter().collect();
        sched.reconcile(&[], &[], &[], &known);

        let saved = sched.snapshot();
        assert!(saved.held.contains("here"));
        assert!(!saved.held.contains("gone"));
        assert!(saved.starts.is_empty());
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn a_spent_hour_is_dropped_but_the_hold_is_not_invented() {
        let file = scratch("spent");
        let sched = Schedule::new(file.clone());
        sched.set_start("aaaa", Some(1_000));
        let known: BTreeSet<String> = ["aaaa".to_string()].into_iter().collect();

        sched.reconcile(&["aaaa".to_string()], &[], &[], &known);
        assert!(sched.snapshot().held.contains("aaaa"));

        // The hour comes round: the start time is spent and the hold released.
        sched.reconcile(&[], &["aaaa".to_string()], &["aaaa".to_string()], &known);
        let saved = sched.snapshot();
        assert!(saved.held.is_empty());
        assert!(saved.starts.is_empty());
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn the_next_boundary_is_never_now() {
        // Whichever side of it the clock is on, a countdown to the change has
        // to have something left to count.
        assert!(next_change(0, 720) > epoch_now());
        assert!(next_change(720, 0) > epoch_now());
    }
}
