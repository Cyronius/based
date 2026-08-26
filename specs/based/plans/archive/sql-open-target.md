# Plan: .sql open-target setting + multi-select coalescing

## Spec impact

**Modified:** `BASED-OPEN-SQL-ARGV` — file-open requests (argv + single-instance forwards) now
coalesce into one batch in the shell (~300ms debounce); a batch opens at most ONE new window
(all paths as repeated `open=` hash params) or lands as tabs in the last-focused window,
depending on the setting.

**New:** `BASED-SQL-OPEN-TARGET` — the `sqlFileOpenTarget` setting (default `current-window`),
the `POST /api/open-files` relay + `open-files` SSE event with attach-time buffering, the
Settings → General control, and the UI's queue-until-connected multi-path open.

## Design

- Explorer's open verb launches one process per selected file; each fires the single-instance
  callback. Coalescing therefore lives in the Rust shell: callbacks send file batches into an
  mpsc channel; a batcher thread accumulates with a 300ms silence timeout, dedupes, then
  dispatches. Cold-launch argv goes through the same channel, so a primary's own files and its
  siblings' forwarded files merge into one batch.
- The shell keeps the decision (it alone knows focus order — tracked via `WindowEvent::Focused`)
  and reads the setting from `GET /api/settings` per batch (default current-window on any error).
  Webviews are External-URL with no Tauri IPC, so current-window opens route through core:
  `POST /api/open-files {sid, paths}` → `open-files` SSE event to that window, buffered in core
  until the window's SSE stream attaches (closes the restored-window cold-launch race).
- New-window mode (or no window): ONE window with repeated `open=` hash params.
- The UI generalizes the single-path boot logic to a pending-paths queue drained once the window
  has a connected session; `openSqlFile` already dedupes by filePath per window.
- Same-window default also reduces multi-window-same-connection exposure to the known
  per-connection tab-persistence clobbering (tabs.replaceForConnection last-flush-wins).

## Implementation

1. `core/src/storage/settings.ts` + `ui/src/api/types.ts` + `ui/src/store.ts` +
   `ThemePicker.tsx` GeneralTab: `sqlFileOpenTarget: "current-window" | "new-window"`.
2. `core/src/server.ts`: `POST /api/open-files` (validate non-empty paths; broadcast or buffer
   in `pendingOpens`), flush on SSE attach.
3. `ui/src/App.tsx`: `bootOpenPaths` via `getAll("open")`; module-level `queueFileOpens` +
   drain-when-connected; handle the `open-files` SSE event.
4. `shell-tauri/src/main.rs`: multi-path `create_window`, focus-order tracking, mpsc batcher
   (300ms), settings fetch, dispatch (relay + focus, or one new window).
5. Tests: settings round-trip; new `integration.openFiles.test.ts` (SSE delivery, one-shot
   buffering, sid isolation, 400 on empty). Shell batching is manual (spec procedure).
