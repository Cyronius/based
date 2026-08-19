# Capi chat history picker

**Branch:** `capi_session_per_window` (continues the unmerged per-window work — this feature
revises that thread model, so stacking it is cleaner than a second branch off main)

## Problem

There is exactly one conversation per (window, connection), and "New chat" deletes it. Nothing to
browse, nothing to reactivate. The user wants: an icon in the Capi header that opens a history of
past sessions (last 15), deterministically titled by the first few words of the first user
message, with click-to-reactivate.

## Design

### Thread model (revises BASED-AGENT-THREADS from earlier on this branch)

A history picker means conversations are durable records, which breaks the "one stable derived
thread id, New chat wipes it" model just built:

- **Thread ids become per-conversation:** `chat:{uuid}`, minted client-side. `resourceId` stays
  the connection id → **history is per-connection**, shared across windows (windows are viewports;
  the conversation content is what you're reactivating).
- **Each window tracks its active thread per connection:** an in-session module map (like
  `connectionCache`), plus a new nullable `capi_thread_id` column on `window_state` for the
  window's *current* connection — saved whenever the pointer or connection changes, so restart
  restores the same conversation (window restore reuses the sid → row).
- **New chat = mint a new id + move the pointer.** No server delete — the old conversation simply
  becomes history. Mastra only materializes a thread on its first run, so an abandoned "New chat"
  leaves no empty junk thread behind.
- **Window close no longer sweeps threads** (history must survive the window) — the sweep added
  earlier on this branch is removed along with its integration test. Instead, **deleting a
  connection sweeps its threads** (`listThreads` by resourceId → `deleteThread` each), closing a
  real leak: today `connections.delete` leaves agent.db rows orphaned forever.
- Reset-wins-over-restore (`threadReset`) machinery is unchanged; the explicit thread DELETE
  endpoint stays (unused by New chat now, available for a future per-row delete).

### Endpoint

`GET /api/agent/threads?resourceId=…&limit=15` → `[{ id, title, updatedAt }]`, newest first, via
`Memory.listThreads({ filter: { resourceId }, perPage: limit, orderBy: { field: "updatedAt",
direction: "desc" } })`. Memory-only — no live DB connection required, like the other thread
routes.

**Deterministic titles:** pure helper `threadTitle(firstUserMessageText)` — first 6 words,
hard-capped at 48 chars with an ellipsis; blank → "Untitled chat". Applied server-side at list
time: a thread whose stored title is empty/Mastra-default gets its first user message recalled,
the title derived, and cached back via `updateThread` (derived once, self-healing for pre-existing
threads). No LLM title generation anywhere. **Future:** Josh is training a tiny CPU-only titling
model to be offered later (likely a config option) — so the derivation must stay behind this ONE
seam (`threadTitle.ts`, one call site in the list route's backfill), never scattered.

### UI

- **History icon** — new clock SVG in `icons.tsx` (unicode renders inconsistently on Windows),
  rendered via `IconButton` with `title`/`aria-label` "Chat history", in the header's trailing
  group left of Download. Disabled while streaming (same rule as New chat — reactivating remounts
  the session, which would kill the stream).
- **Popover panel** anchored under the header: the last 15 conversations for the current
  connection — title + relative time, active one highlighted, close on outside-click/Esc. Click a
  row → set the window's pointer to that thread id → the existing keyed remount + message
  cache/history-fetch path shows it (no new seeding logic).
- "New chat" button behavior unchanged visually; it now archives instead of deleting.

## Changes by file

### ui
- `ui/src/agent/threadIds.ts` — `windowThreadId` replaced by `newChatThreadId()` (`chat:{uuid}`).
- `ui/src/agent/threads.ts` — active-pointer module map `activeThreadByConnection` +
  get/set helpers that persist the current connection's pointer to window state; thread list
  fetcher `fetchThreadList(connectionId)`.
- `ui/src/components/RightRail.tsx` — `CapiRail` reads the pointer (minting one if absent) instead
  of deriving; `newChat` mints + moves the pointer (no `deleteThread`); history button + popover
  (new `ChatHistoryPopover` component or inline); mid-stream deferral logic unchanged (pointer
  changes defer the remount exactly like connection switches do).
- `ui/src/components/icons.tsx` — `HistoryIcon` (clock).
- `ui/src/api/client.ts` / `types.ts` — `fetchWindowState`/`saveWindowState` gain `capiThreadId`;
  thread-list API type.

### core
- `core/src/storage/windowState.ts` + `storage/db.ts` migration — `capi_thread_id` column
  (nullable) on `window_state`, round-tripped through the record.
- `core/src/agent/threadTitle.ts` — pure `threadTitle()` + "is unset/default title" predicate.
- `core/src/server.ts` — the threads list route (+ title backfill); remove the session-close
  sweep; sweep threads in the connection DELETE route.

### specs
- `spec.md` — BASED-AGENT-THREADS: id scheme, pointer persistence, New-chat/close/connection-
  delete lifecycle. New **BASED-CHAT-HISTORY-PICKER** (ui+core; endpoint+title: integration/unit,
  picker: manual). BASED-AGENT-TAB-TOOLS: New-chat wording. BASED-WINDOW-RESTORE: note the new
  column.
- Tests: unit `threadTitle` cases (6-word cut, 48-char cap, blank, whitespace); integration —
  list endpoint returns ≤15 newest-first with derived titles cached, connection DELETE sweeps its
  threads; replace the session-close-sweep test with one asserting close *keeps* threads; rewrite
  the `windowThreadId` unit test for `newChatThreadId` shape. Manual picker procedure in
  `manual.ui.test.ts`.

## Decisions taken (flag if wrong)

1. **History is per-connection and cross-window** — two windows may reactivate the same
   conversation; concurrent sends are last-writer-wins (accepted, matches tabs-share-persistence
   elsewhere).
2. **No pruning** beyond displaying 15 — old threads accumulate as cheap SQLite rows; a per-row
   delete in the picker is a natural follow-up, not in v1.
3. **Titles derive from the first user message only**, frozen once cached — renames/re-derivation
   out of scope.
