---
name: verify-garia
description: "Drive Garia the way a user does and capture proof. Use for Garia UI verification, download-list / add / pause / detail journeys, mock-RPC browser-dev runs, or when an agent must prove behavior before claiming a fix. Prefer this over guessing at Tauri internals."
---

# Verify Garia

Garia is a Tauri download manager (aria2 under the hood). This skill is the scripted way to launch a disposable instance, exercise a mapped user feature, and keep evidence after teardown.

Agents read this cold. Follow Launch → Doctor → Drive (one feature file) → Evidence → Cleanup. Never drive an instance you did not start.

## Surfaces

| Surface | Role in verification |
| --- | --- |
| **Browser-dev UI** (`src/` + `npm run mock`) | **Primary harness for agents / cloud VMs.** Same frontend as the app; talks to a mock aria2 JSON-RPC on `127.0.0.1:6800`. |
| **Native Tauri app** (`npm run tauri dev` / packaged build) | Real product surface. Needs WebKitGTK (Linux), Rust sidecars (aria2/ffmpeg/yt-dlp), and a display. Prove native-only paths (tray, dock, Quit vs close, `garia://`, Settings via invoke) on a machine that can run Tauri. |
| Browser extension / marketing `site/` | Out of scope for this skill's first map. |

**Stand-in honesty:** a browser-dev proof does **not** cover Tauri `invoke` paths (settings persistence, video tools, queue stop via Rust, file reveal, notifications, deep links). Those stay unverified until a native run.

## Launch

From the repo root:

```bash
cd .cursor/skills/verify-garia
./helpers/control-garia launch
```

What it starts (and records under `.cursor/skills/verify-garia/.run/state.json`):

1. `node mock-rpc.js` — mock aria2 JSON-RPC at `http://127.0.0.1:6800/jsonrpc` (same server as `npm run mock`, started directly so cleanup owns the real PID). The helper **refuses** to launch if `:6800` is already taken by a foreign process.
2. `python3 -m http.server <port> --directory src --bind 127.0.0.1` — static frontend (preferred port `8765`, or next free; override with `GARIA_UI_PORT`).
3. Playwright's Chromium with `--remote-debugging-port` (preferred `9222`, override with `GARIA_CDP_PORT`) so every `browser` command attaches to the **same** page and UI state (filters, dialogs) persists across calls.

**Ready** means all of:

- Mock answers `aria2.getGlobalStat`.
- UI HTTP 200 at the recorded `uiUrl`.
- Status text `#conn-text` contains `aria2 ·` (connected), not `connecting…` / `aria2 unreachable`.
- `#download-list [role=option]` has at least one seeded mock row.
- Sidebar wordmark reads `garia`.

Optional: `GARIA_RUN_ID=my-run ./helpers/control-garia launch`.

**Unit parity (not a substitute for Drive):** `npm test` runs `src/parity.test.js` (pure helpers). Useful smoke; does not prove the UI.

**Native launch (when the machine can):** `npm install && npm run tauri dev`. First run builds sidecars. Do not use `control-garia` against a shared native session — isolation is undefined for the real app data dir.

## Doctor

```bash
./helpers/control-garia doctor
```

Read-only. Exit `0` only when the instance **we** launched owns live mock + UI PIDs, RPC works, HTTP works, `#conn-text` shows `aria2 · …`, rows are present, and the brand wordmark is visible. Run doctor whenever anything looks off before driving.

## Drive

Helper: `.cursor/skills/verify-garia/helpers/control-garia` (executable). Installs Playwright into `helpers/node_modules` on first use.

Prefer feature recipes under `features/`. Stable handles from this repo:

| Handle | Meaning |
| --- | --- |
| `#open-modal-btn` / text `Add download` | Opens the add dialog |
| `#modal-url-input`, `#modal-ok`, `#modal-cancel` | Add dialog fields |
| `#filter-bar .nav-item` + label (`All Downloads`, `Active`, `Queued`, `Torrents`, …) | Sidebar filters; sets `#view-title` |
| `#download-list` `role=listbox` / children `role=option` with `data-gid`, `data-name`, `data-status` | Download rows |
| `button.dl-icon[aria-label="Pause"]` / `Resume` | Per-row pause/resume |
| `.dl-name` click | Opens `#detail-overlay` |
| `#name-filter` / `#name-filter-clear` | In-list name filter |
| `#conn-text` | Connection proof |

Examples:

```bash
./helpers/control-garia browser filter --name Active
./helpers/control-garia browser open-add
./helpers/control-garia browser add-url --url 'https://proof.ovh.net/files/1Mb.dat'
./helpers/control-garia browser open-detail --name 'Ubuntu 24.04 Desktop.iso'
./helpers/control-garia browser pause-named --name 'Ubuntu 24.04 Desktop.iso'
./helpers/control-garia browser click --css '#open-modal-btn'
./helpers/control-garia browser fill --css '#modal-url-input' --value 'https://example.com/a.zip'
./helpers/control-garia browser snapshot --path browse-library/active.aria.txt
./helpers/control-garia browser screenshot --path browse-library/active.png
./helpers/control-garia rpc aria2.getGlobalStat '[]'
```

Generic locators: `--css`, `--role` + `--name`, `--text`.

## Evidence

Proof directory (survives cleanup):

`.cursor/skills/verify-garia/evidence/`

Standards:

- Exercise the **user path** (sidebar, Add download, row actions) — not internal test hooks.
- Capture the **action and the resulting state** (screenshot + ARIA/rows JSON +, when relevant, RPC).
- Mock RPC is the production boundary for aria2 in browser-dev; treating mock rows as "downloads" is correct for UI proof, not for claiming bytes landed on disk.
- Record the feature file id and entry point with the artifacts (use the feature's folder name under `evidence/`).

Minimum proof set for a UI journey:

1. Screenshot showing the Garia wordmark and the asserted state.
2. `*.aria.txt` snapshot (includes conn + view title) and/or `*.rows.json` from `browser snapshot`.
3. For mutations (add/pause): a second observation (row `data-status` / RPC) after the action.

## Cleanup

```bash
./helpers/control-garia cleanup
```

Stops **only** the mock and UI PIDs recorded in `.run/state.json`, then deletes that state file. **Never** deletes `evidence/`. Never kill by process name (`pkill node`, etc.).

After failed iterations, run cleanup before relaunching so `:6800` and the UI port are not stranded.

## Isolate

- **Mock RPC port `6800` is shared.** Only one mock (or real aria2) may bind it. `control-garia launch` refuses a foreign occupant.
- **UI port** is per-run (`GARIA_UI_PORT` / auto-increment) and is isolatable.
- Do not drive a developer's already-open `tauri dev` session from this skill.
- Browser-dev state is ephemeral (in-memory mock + browser profile discarded each Playwright launch). No disposable data dir is required for the stand-in.

## Helpers

| Path | Invocation |
| --- | --- |
| `helpers/control-garia` | `./helpers/control-garia <launch\|doctor\|cleanup\|browser\|rpc> …` |
| `helpers/control-garia.mjs` | Same, via `node` (wrapper ensures `npm install` in `helpers/`) |
| `helpers/ux-visual-baselines` | CDP screenshots after `launch` (see Visual baselines) |
| `helpers/package.json` | Pins `playwright` for the driver |

All helpers are executable / runnable as shown above. Logs for a live run: `.run/mock.log`, `.run/ui.log`.

## Visual baselines

Optional UX review captures (issue #82). **Requires** a working `control-garia` launcher — land **#83 / PR #88** first. Output is written under `evidence/ux-baselines/` (gitignored) or `--out tmp/ux-baselines`; **not** checked into git and **not** run in CI.

```bash
cd .cursor/skills/verify-garia
./helpers/control-garia launch
./helpers/ux-visual-baselines                 # or: --out /path/to/tmp/ux-baselines
./helpers/control-garia cleanup
```

Per theme (`light` / `dark`) and width (`1280` / `760`): main list, each sidebar filter, Add (single + multi-line batch), detail, Settings. Inspector **focus-order / trap** a11y still needs the inspector pane (#80 / **PR #90**) — this script does not substitute for that checklist.

## Feature map

See [`features/README.md`](features/README.md). Drive **one** mapped feature per proof run unless the task asks for broader coverage.

## Maintenance

Keep the map honest with `/maintain-verification-skill` as the UI changes. Formal/model checking is a separate track — do not start it from this skill.
