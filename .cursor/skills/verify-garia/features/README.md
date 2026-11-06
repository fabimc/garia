# Garia verification map

This directory is the maintained source for verifying Garia's user-facing behavior. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch with `./helpers/control-garia launch` from `.cursor/skills/verify-garia/` (browser-dev: mock RPC + static `src/`).
- Run `./helpers/control-garia doctor` and require `ok: true`, `ownedByUs: true`, `#conn-text` containing `aria2 ·`, and a non-zero download row count.
- Never drive an instance that was not started by this verification run.
- Prefer browser-dev on agent/cloud hosts. Native Tauri paths are called out per feature as unverified here when they need `invoke`.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer `#id`, `data-*`, ARIA roles/names, and sidebar filter labels over coordinates.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Run UI actions through `./helpers/control-garia browser …`. Commands attach to the Chromium started by `launch`, so sidebar filters and dialogs persist between calls.
- Inspect the mock with `./helpers/control-garia rpc …` when proving engine-visible side effects.
- Restore nothing special after mock mutations (mock is ephemeral). Do not remove proof artifacts during cleanup. Use `browser reload` only when you intentionally need a fresh page.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA/rows snapshot and a screenshot with the Garia wordmark visible.
- Mutation proof includes a second read of row `data-status` or RPC.
- Record the feature ID and entry point used with every artifact under `evidence/<feature>/`.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.
- Browser-dev proofs must not claim native-only behavior (tray, dock, Quit, Settings persistence, real disk downloads).

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control-garia` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Browse the download library](./browse-library.md) covers sidebar filters, the seeded list, and connection status.
- [Add a download](./add-download.md) covers opening Add download, submitting a URL, and seeing the new row.
- [Pause and resume](./pause-resume.md) covers pausing an active row from the row icon.
- [Download details](./download-detail.md) covers opening the detail inspector from a row name.
- [Filter by name](./filter-by-name.md) covers the in-list name search box.
