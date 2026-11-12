# Keep a large library responsive

Large download libraries remain scrollable, filterable, and selectable without doing unnecessary list work while the window is hidden.

## Sub-features

- `large-list-render` renders hundreds of download rows and keeps offscreen content inexpensive.
- `large-list-filter` filters a large library without blocking the interface for one long task.
- `large-list-select` lets the user select a row near the end of a large library.
- `large-list-restore` refreshes the list after the window becomes visible again.

## How to get to it (user POV)

- Open Garia and choose `All Downloads` in the Library sidebar.
- Search or choose a sidebar filter to narrow the library.
- Select any row, including one near the end of the list.
- Hide and restore the app window, then continue browsing the library.

## Driving it with control-garia

Preconditions:

- `./helpers/control-garia doctor` reports `ok: true`.
- Browser-dev mock RPC is serving its seeded catalog.

- **Seed a large library.** From `.agent/skills/verify-garia/`, add 500 unique rows to the mock:

  ```bash
  for i in $(seq 1 500); do
    ./helpers/control-garia rpc aria2.addUri "[[\"https://example.test/large-list/$i.dat\"]]" >/dev/null || exit 1
  done
  ```

- **Render and scroll.** Choose All Downloads with `./helpers/control-garia browser filter --name "All Downloads"`. Read `#view-count` with `./helpers/control-garia browser eval --expr "document.getElementById('view-count').textContent"`. It should report at least 500 items; scroll to the bottom and confirm the last row is visible.
- **Filter and select.** Choose Queued with `./helpers/control-garia browser filter --name Queued`, then click a visible row with `./helpers/control-garia browser click --css '#download-list [role="option"]:not(.hidden)'`. `./helpers/control-garia browser eval --expr "document.querySelector('#download-list [role=option][aria-selected=true]')?.dataset.name"` returns the selected row name.
- **Restore after a hidden render.** Start filtering and hide the page in the same browser turn with `./helpers/control-garia browser eval --expr "document.querySelector('#filter-bar .nav-item[data-filter=all]').click(); Object.defineProperty(document,'hidden',{configurable:true,value:true}); document.dispatchEvent(new Event('visibilitychange'))"`. Then restore with `./helpers/control-garia browser eval --expr "Object.defineProperty(document,'hidden',{configurable:true,value:false}); document.dispatchEvent(new Event('visibilitychange'))"`. The visible All Downloads view and its row count recover after the next poll. This simulates the page lifecycle only; it is not proof of native Tauri window hiding.
- **Proof.** `evidence/large-list-scale/all-524-rows.png` shows the 524-row All Downloads view. `all-524-rows.json` records its visible row count and connection status; `queued-selection.json` records the filtered row selection.

## Gotchas

- Browser-dev evidence uses Chromium and mock aria2; it does not prove WebKitGTK paint or layout performance.
- Do not use the wall-clock total for adding the 500 mock rows as a render-time measurement.
- The hidden lifecycle simulation is not a substitute for testing hide/restore on a native Wayland session.
