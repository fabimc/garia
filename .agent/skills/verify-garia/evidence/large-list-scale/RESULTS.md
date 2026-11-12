# Large-library scale proof

Feature ID: `large-list-scale`
Entry point: Library > All Downloads
Issue: #129

Browser-dev was populated with 500 additional mock rows (524 total including the seeded catalog). All 524 were visible in All Downloads; Queued showed 505 rows, and clicking the final row selected it. Hiding during a filter pass and restoring visibility returned the list to 524 visible rows.

Chromium browser-dev measurement: first render 3.8 s, with long tasks of 566, 110, 92, and 93 ms; filtering took 903 ms and selecting the final queued row took 165 ms. The current row style reported `content-visibility: auto`. These numbers are directional browser-dev evidence, not WebKitGTK measurements.

Native WebKitGTK profiling remains unverified: this environment has WebKitGTK libraries but no configured Rust toolchain or graphical display for running the Tauri app.

Artifacts:

- `all-524-rows.png` — All Downloads, connection status, and 524-item count.
- `all-524-rows.json` — visible rows, row names, and computed offscreen rendering mode.
- `queued-selection.json` — Queued filter and selected final row.
