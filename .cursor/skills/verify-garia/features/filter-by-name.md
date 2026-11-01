# Filter by name

Filter by name lets a user type into the list search box to narrow visible downloads by file name and clear the filter afterward.

## Sub-features

- `name-filter-type` narrows the list to matching names.
- `name-filter-empty` shows the empty state when nothing matches.
- `name-filter-clear` restores the unfiltered list.

## How to get to it (user POV)

- Focus the name filter field above the list and type a query.
- Choose the clear control on the filter field.

## Driving it with control-garia

Preconditions:

- `./helpers/control-garia doctor` reports `ok: true`.
- Sidebar filter is All Downloads.
- Seeded catalog includes `Ubuntu 24.04 Desktop.iso`.

- **Type a match.** Fill the name filter. Run `./helpers/control-garia browser fill --css '#name-filter' --value Ubuntu`. Visible options include Ubuntu and exclude unrelated names such as `annual-report.pdf` when that row was previously visible under All Downloads.
- **Empty query.** Replace the value with a nonsense string. Run `./helpers/control-garia browser fill --css '#name-filter' --value volcano-not-present`. The empty state (`#empty-state` not `.hidden`) or zero options is shown.
- **Clear.** Choose clear. Run `./helpers/control-garia browser click --css '#name-filter-clear'`. The filter value is empty and multiple seeded rows return.
- **Proof.** With `Ubuntu` applied, run `./helpers/control-garia browser snapshot --path filter-by-name/ubuntu.aria.txt` and `./helpers/control-garia browser screenshot --path filter-by-name/ubuntu.png`. Artifacts show the query effect and matching row.

## Gotchas

- Name filter is not the sidebar Library filter — do not conflate the two journeys.
- Debounce/render is fast in this UI; still wait for options to update before asserting counts.
- Clearing via backspace without `#name-filter-clear` is a different entry path; if you use it, say so in the proof notes.
