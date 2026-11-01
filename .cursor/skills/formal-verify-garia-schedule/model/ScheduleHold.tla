----------------------------- MODULE ScheduleHold -----------------------------
(***************************************************************************
 * Model of Garia's download hold / release / override state machine.
 *
 * Code this describes (one indivisible Tick ≈ one schedule_tick pass
 * for a single gid that is already in the active/waiting lists):
 *
 *   src-tauri/src/schedule.rs
 *     decide, allowed, Saved.held, Schedule.overridden, Schedule.reconcile
 *
 *   src-tauri/src/lib.rs
 *     schedule_tick — forcePause / unpause, hold / unhold, clear overrides
 *       when `open`; set_queue_stopped_blocking; set_download_start_blocking
 *
 * `open` here is schedule_tick's `open = daily_open && !queue_stopped`.
 * Per-gid `allowed` is schedule::allowed(gid, open, starts, now).
 *
 * Assumptions (out of scope — see the skill):
 *   - aria2 RPC for forcePause / unpause succeeds when Tick chooses them
 *   - one download (one gid); seeders are already excluded from `rows`
 *   - status is only "running" (active|waiting) or "paused"
 *   - no Quit / process death / session reload mid-trace
 ***************************************************************************)

EXTENDS Integers

VARIABLES
  status,       \* "running" or "paused" — aria2 view of this gid
  held,         \* gid ∈ Schedule.saved.held
  overridden,   \* gid ∈ Schedule.overridden (in-memory, not persisted)
  open,         \* daily window open AND queue not stopped
  hasStart,     \* gid has an entry in Saved.starts
  startDue,     \* epoch_now >= starts[gid] (ignored when ~hasStart)
  lastDecision, \* what the last Tick chose (for traces / statechart)
  badRelease,   \* latch: Tick chose Release while ~held (user-pause bug)
  badRehold,    \* latch: Tick chose Hold while overridden (fight-user bug)
  badStaleHold, \* latch: Tick left status=running with held still true
  badLostOverride \* latch: Tick chose Overridden but cleared it while ~allowed

vars == <<status, held, overridden, open, hasStart, startDue,
          lastDecision, badRelease, badRehold, badStaleHold, badLostOverride>>

Statuses == {"running", "paused"}
Decisions == {"Hold", "Release", "Overridden", "Leave", "none"}

--------------------------------------------------------------------------
\* schedule::allowed — schedule.rs
Allowed == open /\ (~hasStart \/ startDue)

\* schedule::decide — schedule.rs
\* Row status "paused" is the only pause; active and waiting are "running".
Decide(paused, allowed, isHeld, isOverridden) ==
  CASE allowed /\ paused /\ isHeld                 -> "Release"
    [] allowed                                     -> "Leave"
    [] (~allowed) /\ paused                        -> "Leave"
    [] (~allowed) /\ (~paused) /\ isHeld           -> "Overridden"
    [] (~allowed) /\ (~paused) /\ (~isHeld)        ->
         IF isOverridden THEN "Leave" ELSE "Hold"
    [] OTHER                                       -> "Leave"

--------------------------------------------------------------------------
TypeOK ==
  /\ status \in Statuses
  /\ held \in BOOLEAN
  /\ overridden \in BOOLEAN
  /\ open \in BOOLEAN
  /\ hasStart \in BOOLEAN
  /\ startDue \in BOOLEAN
  /\ lastDecision \in Decisions
  /\ badRelease \in BOOLEAN
  /\ badRehold \in BOOLEAN
  /\ badStaleHold \in BOOLEAN
  /\ badLostOverride \in BOOLEAN

\* Plain-language properties (invariants):
\*
\* UserPauseSafety — the scheduler never unpauses a download it did not hold.
\*   Harm if broken: a download the user paused at midnight starts again at 6am.
\*
\* OverrideNoFight — once the user resumes inside a shut window, the scheduler
\*   does not forcePause that download again for the rest of this shut period.
\*   Harm if broken: Resume is undone on the next 15s tick; the UI fights the user.
\*
\* NoStaleHold — after a Tick, a running download is not still marked held.
\*   Harm if broken: held sticks across a Resume that races a window/queue open;
\*   a later user Pause is mistaken for a scheduler hold and gets Released.
\*   (Finding on current code — see skill report.)
\*
\* OverrideStickyWhileGated — deciding Overridden must leave overridden set
\*   whenever allowed is still false (e.g. per-download start not due yet).
\*   Harm if broken: clearing overrides whenever `open` forgets a resume of a
\*   start-gated row and the next tick Holds it again.
\*   (Finding on current code — see skill report.)

UserPauseSafety == ~badRelease
OverrideNoFight == ~badRehold
NoStaleHold == ~badStaleHold
OverrideStickyWhileGated == ~badLostOverride

--------------------------------------------------------------------------
Init ==
  /\ status = "running"
  /\ held = FALSE
  /\ overridden = FALSE
  /\ open = TRUE
  /\ hasStart = FALSE
  /\ startDue = FALSE
  /\ lastDecision = "none"
  /\ badRelease = FALSE
  /\ badRehold = FALSE
  /\ badStaleHold = FALSE
  /\ badLostOverride = FALSE

--------------------------------------------------------------------------
\* One schedule_tick for this gid (lib.rs schedule_tick loop body + reconcile
\* + override clear). RPC success is assumed — see module header.
\* Overridden only fires when ~Allowed. Allowed = open /\ (~hasStart \/ startDue),
\* so ~Allowed does NOT imply ~open: a start-gated row can be Overridden while
\* open=TRUE, then overriddenNext clears because open — that race is the
\* OverrideStickyWhileGated finding (badLostOverride).
Tick ==
  LET paused == (status = "paused")
      allowed == Allowed
      d == Decide(paused, allowed, held, overridden)
      statusNext ==
        CASE d = "Hold"    -> "paused"
          [] d = "Release" -> "running"
          [] OTHER         -> status
      heldNext ==
        CASE d = "Hold"                      -> TRUE
          [] d \in {"Release", "Overridden"} -> FALSE
          [] OTHER                           -> held
      overriddenNext ==
        IF open THEN FALSE
        ELSE IF d = "Overridden" THEN TRUE
        ELSE overridden
      hasStartNext ==
        IF allowed /\ hasStart /\ startDue THEN FALSE ELSE hasStart
  IN /\ lastDecision' = d
     /\ badRelease' = (badRelease \/ (d = "Release" /\ ~held))
     /\ badRehold'  = (badRehold  \/ (d = "Hold" /\ overridden))
     /\ badStaleHold' = (badStaleHold \/ (statusNext = "running" /\ heldNext))
     /\ badLostOverride' =
          (badLostOverride \/ (d = "Overridden" /\ ~overriddenNext /\ ~allowed))
     /\ status' = statusNext
     /\ held' = heldNext
     /\ overridden' = overriddenNext
     /\ hasStart' = hasStartNext
     /\ UNCHANGED <<open, startDue>>

--------------------------------------------------------------------------
\* Environment / user / settings — not the scheduler, but they change what
\* the next Tick sees (UI pause/resume, Stop Queue, daily window, start time).

UserPause ==
  /\ status = "running"
  /\ status' = "paused"
  /\ lastDecision' = "none"
  /\ UNCHANGED <<held, overridden, open, hasStart, startDue,
                 badRelease, badRehold, badStaleHold, badLostOverride>>

UserResume ==
  /\ status = "paused"
  /\ status' = "running"
  /\ lastDecision' = "none"
  /\ UNCHANGED <<held, overridden, open, hasStart, startDue,
                 badRelease, badRehold, badStaleHold, badLostOverride>>

\* Stop Queue or daily window shutting → open becomes FALSE.
\* set_queue_stopped_blocking also calls schedule_tick in the same command;
\* model that as CloseWindow then Tick (always enabled as a later step).
CloseWindow ==
  /\ open = TRUE
  /\ open' = FALSE
  /\ lastDecision' = "none"
  /\ UNCHANGED <<status, held, overridden, hasStart, startDue,
                 badRelease, badRehold, badStaleHold, badLostOverride>>

OpenWindow ==
  /\ open = FALSE
  /\ open' = TRUE
  /\ lastDecision' = "none"
  /\ UNCHANGED <<status, held, overridden, hasStart, startDue,
                 badRelease, badRehold, badStaleHold, badLostOverride>>

\* set_download_start_blocking with a future time: forcePause + hold + starts
AssignFutureStart ==
  /\ ~hasStart
  /\ hasStart' = TRUE
  /\ startDue' = FALSE
  /\ status' = "paused"
  /\ held' = TRUE
  /\ lastDecision' = "none"
  /\ UNCHANGED <<overridden, open, badRelease, badRehold, badStaleHold,
                 badLostOverride>>

\* Wall clock reaches the per-download start.
StartBecomesDue ==
  /\ hasStart
  /\ ~startDue
  /\ startDue' = TRUE
  /\ lastDecision' = "none"
  /\ UNCHANGED <<status, held, overridden, open, hasStart,
                 badRelease, badRehold, badStaleHold, badLostOverride>>

--------------------------------------------------------------------------
Next ==
  \/ Tick
  \/ UserPause
  \/ UserResume
  \/ CloseWindow
  \/ OpenWindow
  \/ AssignFutureStart
  \/ StartBecomesDue

Spec == Init /\ [][Next]_vars

=============================================================================
