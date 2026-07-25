# Tab restore: mirror the open set instead of accumulating

## Context

Every launch, a LanceDB connection reopened **every table the user had ever opened**, not the
tabs open at last exit — session restore looked broken. Root cause: the tab store was an
ever-growing union, never a mirror of what's open.

- `closeTabs` (`ui/src/store.ts`) deleted rows server-side **only** for `kind === "query"` tabs;
  table/routine tabs left React state but their DB rows survived.
- `POST /api/tabs` (`core/src/server.ts`) was upsert-only — it never pruned rows absent from the
  payload; `flushPendingTabs` (`ui/src/store.ts`) likewise only upserted and skipped empty
  payloads.

So every `table:<schema>.<name>` row accumulated forever and was restored on launch. Worst on
LanceDB Cloud (`sql: false` → no query editor → interaction is almost entirely table tabs).

## Spec impact — BASED-TABSTORE (modified)

Persistence is now a per-connection **replace**: saving a connection's tabs mirrors the
currently-open set and prunes any previously-persisted tab (of any kind) no longer open. New
acceptance criterion added for `replaceForConnection`. `list`/`delete`/`upsert` unchanged.

## Changes (implemented)

1. `core/src/storage/tabs.ts` — added `TabStore.replaceForConnection(connectionId, tabs)`: in a
   transaction, delete the connection's rows absent from the payload, then upsert the rest. Empty
   array clears the connection.
2. `core/src/server.ts` — `POST /api/tabs` now takes `{ connectionId, tabs }` and calls
   `replaceForConnection` (falls back to `tabs[0].connectionId` for back-compat; 400 if neither).
3. `ui/src/store.ts` — `flushPendingTabs` always POSTs (even empty) with `connectionId`;
   `closeTabs` drops the query-only manual DELETE loop, keeps `disposeModel` for query tabs, and
   calls `persistTabsSoon()` so the reconciling flush prunes closed tabs of every kind.

## Tests

- `specs/based/tests/integration.storage.test.ts` — `replaceForConnection` prunes absent tabs of
  any kind, keeps order, scopes per connection, clears on empty, survives store reopen.
- `specs/based/tests/integration.server.test.ts` — re-POSTing a subset prunes the dropped tab via
  the API. Both suites + `core`/`ui` typecheck green.

## Known limitation

The **first** launch after the fix still shows the accumulated set once (restore reads the
polluted rows); it prunes the moment any tab op flushes. Not worth a one-time DB wipe.
