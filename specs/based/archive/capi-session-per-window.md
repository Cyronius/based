# Capi session per window (not per tab)

**Branch:** `capi_session_per_window` (from `main`)

## Problem

The Capi chat thread is derived from the active tab (`tab:{connectionId}:{tabId}`,
BASED-AGENT-THREADS), so switching tabs switches the visible conversation. The user experiences
this as "losing the capi session" on every tab switch. The conversation should belong to the
**window**: switching tabs must not change the chat.

## Design

**New thread scheme:** `win:{sid}:{connectionId}`, where `sid` is the existing per-window session
id the shell mints and restores (BASED-WINDOW-RESTORE — a restored window reuses its sid, so the
thread survives app restarts). `resourceId` stays the connection id.

- One conversation per (window, connection). Two windows on the same connection chat
  independently; switching connections within a window switches to that connection's thread and
  back losslessly (message cache + server history restore, unchanged mechanics).
- Tab switches never touch the chat. The agent keeps full tab awareness through the existing
  per-send `tabContext` snapshot and the `list_tabs` / `get_tab` tools (BASED-AGENT-TAB-CONTEXT,
  BASED-AGENT-TAB-TOOLS — unchanged).
- Dev-browser fallback `sid=default` gets a stable shared thread per connection (same shared-bucket
  semantics window state already has for sid-less requests).

**What dies with per-tab threads** (all of it exists only to make per-tab tolerable):

- `resolveThreadId` / `originThreadId` aliasing — agent-opened tabs no longer need to alias the
  conversation that created them; there is only one conversation in the window.
- `threadsToDeleteOnClose` and thread deletion on tab close.
- The "New chat detaches an aliased tab" branch in `ChatSession.newChat`.
- The tab-switch-while-streaming deferral banner in `CapiRail` (remounts now happen only on
  connection switch; the defer mechanism stays, it just triggers there).

**Thread lifecycle:** a cleanly closed window (`POST /api/session/close`, which already drops the
window's persisted state at core/src/server.ts:386) also deletes its `win:{sid}:*` threads from
agent memory — the per-window analog of today's delete-on-tab-close. App exit does not post close,
so restorable windows keep their history.

**Migration:** none. Existing `tab:*` / `conn:*` threads in `agent.db` become unreferenced; they
are left in place (harmless, and the messages GET for them still works). The spec's "format is not
safe to change" note applied to keeping old rows findable — per-tab history is deliberately
abandoned by this change, which is the accepted cost.

## Changes by file

### ui
- `ui/src/agent/threadIds.ts` — replace `agentThreadId`/`resolveThreadId`/`threadsToDeleteOnClose`
  with a single `windowThreadId(sid, connectionId)` → `win:{sid}:{connectionId}`.
- `ui/src/components/RightRail.tsx` — `CapiRail` derives the thread from `sessionId` +
  `connectionId` only; no `tabs`/`activeTabId` subscription; remove the deferred-tab-title banner
  path (keep the mid-stream remount deferral for connection switches). `newChat` loses the
  aliased-tab detach branch.
- `ui/src/agent/capiTools.tsx` — `show_results` drops the `setTabOriginThread` aliasing block.
- `ui/src/agent/threads.ts` — remove `getActiveChatThreadId`/`setActiveChatThreadId` if nothing
  else consumes them (their only consumer was the aliasing block); cache/history/reset logic
  unchanged.
- `ui/src/store.ts` — remove `setTabOriginThread`, `originThreadId` on `QueryTabState`, the
  origin-thread round-trip in tab persistence meta (hydration ignores stale `originThreadId` in
  old rows), and the delete-threads-on-tab-close call.

### core
- `core/src/server.ts` (`/api/session/close`) — enumerate and delete the closing window's
  `win:{sid}:*` threads (Mastra Memory: threads by `resourceId` per known connection, filtered by
  the `win:{sid}:` prefix — or a direct `agent.db` query if the Memory API can't list).

### specs
- `specs/based/spec.md` — rewrite BASED-AGENT-THREADS as per-window (drop ownership/aliasing/close
  rules; add window-close deletion; keep reset-wins-over-restore and the endpoints, which are
  id-agnostic). Update the BASED-AGENT-TAB-TOOLS "per-tab conversations" bullet and its
  verification procedure (tab switch keeps the conversation; agent-opened tabs need no aliasing).
- `specs/based/tests/unit.uiTabContext.test.ts` — replace the `agentThreadId`/`resolveThreadId`/
  `threadsToDeleteOnClose` unit tests with `windowThreadId` derivation tests.
- `specs/based/tests/unit.threadReset.test.ts`, `unit.threadMessages.test.ts`,
  `integration.agent.test.ts` — unchanged (thread-id-agnostic); add an integration assertion that
  session close deletes the window's threads.

## Spec impact

- **Modified:** BASED-AGENT-THREADS (per-tab → per-window; lifecycle moves from tab close to
  window close), BASED-AGENT-TAB-TOOLS (rail wiring + verification procedure; the tools themselves
  are unchanged).
- **Unchanged:** BASED-AGENT-TAB-CONTEXT, BASED-AGENT-SHOW-RESULTS (minus the aliasing sentence),
  BASED-WINDOW-RESTORE, thread endpoints.

## Decisions taken (flag if wrong)

1. **"New chat" clears the whole window's conversation** for the current connection — there is no
   smaller unit anymore.
2. **Clean window close deletes its threads** (hygiene, matches today's tab-close semantics);
   restorable windows (app exit) keep history.
3. **No migration of per-tab history** — old threads are orphaned in `agent.db`, not swept.
