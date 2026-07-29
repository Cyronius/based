# Help docs as a tab — replace the second window with a `docs` tab kind

## Goal

The `?` button opens the help documentation as a tab inside the app instead of spawning a second
native window. The docs tab is a first-class persisted tab kind: it saves and restores with the
connection whose tab set it was open in, and it renders even when no connection is active.

Supersedes the just-built (uncommitted) window approach in
[`archive/help-docs-window.md`](../archive/help-docs-window.md).

## Decisions

1. **Persist it.** A docs tab is a normal member of a connection's tab set — open it under
   connection A and it comes back under A on restore, and is absent under B. (Not the
   filtered-out, never-persisted treatment the hidden `sql:` child tabs get.)
2. **Render outside the connection gate.** [`App.tsx:185`](../../../ui/src/App.tsx#L185) gates the
   whole tab area on `activeConnectionId`; a docs tab renders anyway, because help matters most
   before you've set up a connection.
3. **Every tab id becomes a UUID.** Table, routine, and diagram tabs currently derive their ids
   from their content (`table:dbo.Users`), which collides across connections. Rather than add a
   fourth derived-id kind, fix the scheme for all of them — see "Tab ids become UUIDs" below.

## Spec impact

### Modified: BASED-HELP-DOCS (spec.md:1916)

Rewritten. Same requirement — in-app help documentation reachable from a `?` button — but the
delivery mechanism changes from "second Vite entry opened in a shell BrowserWindow, theme-synced
via the `storage` event" to "a `docs` tab rendered by the app". New text should state:

- `?` IconButton in the left-rail header, beside the theme picker, opens a **docs tab**
- One docs tab per window's tab set — clicking `?` again focuses the existing tab
- The tab persists with its connection (BASED-TABSTORE) and restores on relaunch
- The tab renders whether or not a connection is active; with no connection the tab strip shows
  only the docs tab, and its connection-scoped controls (new query tab, fetch size, plan/stats
  capture) are hidden
- Content, unchanged: the BASED-UI-SHORTCUTS table + the vim section (BASED-EDITOR-VIM)
- Theming needs no mention at all — it's inside the app

**Applies to** narrows from `based (ui + core + shell)` to `based (ui + core)` (core still owns
the `kind` value it persists; the shell drops out entirely).

New verification procedure:
1. Click `?` → a docs tab opens and activates; click `?` again → focuses it, no second tab
2. Restart with the docs tab open → it comes back on that connection; switch to a connection that
   never had it open → no docs tab
3. Disconnect / fresh profile with no connection → click `?` → docs still renders; the strip shows
   no `+`, no Rows field, no plan/stats toggles
4. Shortcut list matches BASED-UI-SHORTCUTS, vim section matches BASED-EDITOR-VIM, no uppercase
   labels, close (`✕`) and Ctrl+W close it like any tab

### Modified: BASED-TABSTORE (spec.md:277)

The kind enumeration in the requirement text lists query / table-view / routine — it never picked
up `diagram`, and now needs `docs` too. Rewrite the list as: query (content, optional file path),
table/view, routine, diagram (schema scope), and docs (no metadata). Add an acceptance criterion
covering the kind set round-tripping, and extend the existing case in
`specs/based/tests/integration.storage.test.ts` from three kinds to all five — this is the one
real executable test in the change.

### Touched wording: BASED-UI-SHORTCUTS (spec.md:1884, 1903)

"the help page (BASED-HELP-DOCS) renders it" → "help tab"; "discoverable via the help page" →
"via the help tab". No requirement change — the table, the discoverability rule, and the three-way
cross-check in its verification procedure all stand.

### Touched wording: BASED-AGENT-THREADS (spec.md:1196)

The rationale sentence — "the connectionId prefix guarantees global uniqueness — deterministic tab
ids like `table:dbo.Users` repeat across connections" — becomes false once ids are UUIDs. The
`tab:{connectionId}:{tabId}` format itself does **not** change (changing it would orphan every
persisted thread); only the parenthetical explaining why the prefix is there. Same fix to the
duplicated comment in [`threadIds.ts:7-8`](../../../ui/src/agent/threadIds.ts#L7-L8).

### No impact

- **BASED-UI-TABS, BASED-WINDOW-RESTORE** — a docs tab restores through the existing per-connection
  path with no new mechanism.
- **The UUID change carries no spec impact of its own.** Requirements specify tab *identity*
  ("opening the same object again focuses the existing tab" — BASED-EXPLORER-ACTION,
  BASED-DIAGRAM-UI, BASED-AGENT-SHOW-RESULTS), and that behavior is unchanged. How the identity is
  computed — derived id string vs. matching the tab's fields — is below the traceability line: no
  stakeholder files a bug when it changes. Existing tests and manual procedures must still pass
  untouched, which is the real check that it's a pure refactor.

## Design

### Tab ids become UUIDs

**Why.** The `tabs` table has `id` as the primary key, and `upsert` sets
`connection_id = excluded.connection_id` on conflict
([`tabs.ts:57-70`](../../../core/src/storage/tabs.ts#L57-L70)). Open `dbo.Users` under connection
A and under connection B and both windows persist the id `table:dbo.Users` — one row, ping-ponging
between the two connections as each flush steals it back, so `replaceForConnection` prunes it from
whichever connection lost the race. Today's bug, not one this plan introduces; a docs tab would
just have been a fourth way to hit it.

**The change.** Every tab is created with `crypto.randomUUID()`, and "is this already open?"
becomes a match on the tab's identity fields instead of a match on a reconstructed id:

| Site | Today | Becomes |
|---|---|---|
| [`openTableTab`](../../../ui/src/store.ts#L926) | `id = \`table:${schema}.${table}\`` | `find(t => t.kind === "table" && t.schema === schema && t.table === table)` |
| [`openRoutineTab`](../../../ui/src/store.ts#L965) | `id = \`routine:${schema}.${name}\`` | `find(t => t.kind === "routine" && t.schema === schema && t.name === name)` |
| [`openDiagramTab`](../../../ui/src/store.ts#L1269) | `id = \`diagram:${scope \|\| "*"}\`` | `find(t => t.kind === "diagram" && t.schemaScope === scope)` |
| [`ensureSqlView`](../../../ui/src/store.ts#L439) | `linkedId = \`sql:${tableTab.id}\`` | `some(t => t.kind === "query" && t.parentTabId === tableTab.id)` |

The `ensureSqlView` case is the easy one — [`TableDetailsView.tsx:339`](../../../ui/src/components/TableDetailsView.tsx#L339)
already finds the linked tab by `parentTabId`, so the id-string lookup was the odd one out.

**Signature change.** `openTableTab` returns `Promise<void>` today, and
[`openTableTabWithQuery`](../../../ui/src/store.ts#L913) reconstructs the derived id afterwards to
stamp `view`/`prefillWhere` on it. With UUIDs that reconstruction is impossible, so `openTableTab`
must return the tab id — `Promise<string>`. Return the id from `openRoutineTab` and
`openDiagramTab` too; it costs nothing and keeps the four openers symmetric.

**No migration.** Ids are opaque and never parsed. Rows already persisted with derived ids restore
with those ids intact and keep working — dedup now matches on `meta` fields, so a restored
`table:dbo.Users` still correctly absorbs a later `openTableTab("dbo", "Users")` instead of
spawning a duplicate. The `tabs` table just ends up with a mix of old and new id shapes, which
nothing cares about. Agent threads keyed `tab:{connectionId}:{tabId}` stay stable for those tabs
for the same reason.

### The tab kind

`"docs"` joins the `TabKind` union in both [`ui/src/api/types.ts:154`](../../../ui/src/api/types.ts#L154)
and [`core/src/storage/tabs.ts:5`](../../../core/src/storage/tabs.ts#L5). No DB migration: the
column is `kind TEXT NOT NULL DEFAULT 'query'` with no CHECK constraint
([`db.ts:92`](../../../core/src/storage/db.ts#L92)).

```ts
interface DocsTabState { kind: "docs"; id: string; title: string }
```

No metadata, no content, no async hydration — `tabMeta()` returns `null` for it and
`buildTabPayload` already sends `content: ""` / `filePath: null` for non-query kinds.

The id is a `crypto.randomUUID()` like every other tab (decision 3). The singleton check is by
kind — there is at most one docs tab, so `tabs.find(t => t.kind === "docs")` is the whole thing.

### `openDocsTab()` in the store

```ts
openDocsTab() {
  const existing = get().tabs.find((t) => t.kind === "docs");
  if (existing) { set({ activeTabId: existing.id }); return; }
  const tab: DocsTabState = { kind: "docs", id: crypto.randomUUID(), title: "Help" };
  set({ tabs: [...get().tabs, tab], activeTabId: tab.id });
  persistTabsSoon();
}
```

`hydrateTabsForConnection` gets a `r.kind === "docs"` branch returning the same shape from
`r.id` / `r.title`; `hydrateTabDetails` needs no case (nothing to fetch).

### Carrying a pre-connection docs tab forward

Opening docs with no connection means nothing to persist to — `flushPendingTabs` already
early-returns without an `activeConnectionId`, so that's free. But `connect()` replaces `tabs`
wholesale on both paths (in-memory cache hit and fresh hydration), which would yank the docs tab
out from under someone who opened help, then set up a connection. Carry it forward: if a docs tab
was open pre-connect and the incoming set has none, append it and `persistTabsSoon()` — from then
on it belongs to that connection, exactly as decision 1 wants.

`disconnect()` clears `tabs` to `[]` and the docs tab goes with it. Leaving that as-is: making
docs survive disconnect is a special case in a path that otherwise means "drop everything", and
reopening is one click.

### Rendering

- **`ui/src/components/DocsView.tsx`** — the [`docs.html`](../../../ui/docs.html) markup ported to
  the app's Tailwind classes (`bg-ink-950`, `text-paper-dim`, `border-line-soft`, `font-display`,
  `text-[length:var(--fs-*)]`). All the `var(--x, #fallback)` pairs and the standalone `<style>`
  block go away. Scrollable, same `max-w-[46rem]` centred column.
- **`App.tsx`** — add `{activeTab?.kind === "docs" && <DocsView />}` and widen the gate at line 185
  from `activeConnectionId ?` to `activeConnectionId || activeTab?.kind === "docs" ?`, so
  `EmptyState` still shows for a plain disconnected window.
- **`TabStrip.tsx`** — a `?` glyph for `t.kind === "docs"`, matching the existing per-kind icons at
  lines 103-105. Gate the connection-scoped controls on `activeConnectionId`: `sqlEditor` becomes
  `!!activeConnectionId && (capabilities?.sql ?? true)` (otherwise a disconnected strip offers `+`,
  and `newQueryTab`'s guard doesn't fire because `capabilities` is `null`), and the Rows field plus
  the plan/stats toggles render only when connected.
- **`LeftRail.tsx`** — the `?` IconButton keeps its position and labels; `onClick` becomes
  `openDocsTab()`. The `openDocsApi().then(...).catch(...)` fallback chain goes away.

### Reverting the window plumbing

All of it is uncommitted, so this is a revert rather than a deletion of shipped code:

- `ui/docs.html`, `ui/src/docsMain.ts` — delete (both untracked)
- `ui/vite.config.ts` — drop `build.rollupOptions.input` and the `node:url` import
- `core/src/server.ts` — drop `onRequestDocsWindow` from `ServerOptions` and the
  `POST /api/window/docs` route
- `shell/src/bun/index.ts` — drop `openDocsWindow`, the module-level `docsWin`, and the option wiring
- `ui/src/api/client.ts` — drop `openDocsApi`
- `ui/src/theme.ts` — the `THEME_HINT_KEY` export exists for the docs page's `storage` listener;
  check for other callers before removing, and keep it if `applyTheme` uses it internally

Leave `scripts/package-win.ps1` alone — its diff is the unrelated rcedit-shim fix.

## Files touched

| File | Change |
|---|---|
| `specs/based/spec.md` | rewrite BASED-HELP-DOCS; BASED-TABSTORE kind list + AC; BASED-UI-SHORTCUTS + BASED-AGENT-THREADS wording |
| `specs/based/tests/integration.storage.test.ts` | extend the kind round-trip case to all five kinds |
| `ui/src/api/types.ts` | `TabKind` += `"docs"` |
| `core/src/storage/tabs.ts` | `TabKind` += `"docs"`; update the kind-set comment |
| `ui/src/store.ts` | UUID ids + field-based dedup in the four openers; `openTableTab` returns the id; `DocsTabState`, `TabState` union, `openDocsTab`, hydrate branch, connect carry-forward |
| `ui/src/agent/threadIds.ts` | comment fix — the derived-id rationale no longer holds |
| `ui/src/components/DocsView.tsx` | new — the docs content as a React view |
| `ui/src/App.tsx` | docs render branch + widened gate |
| `ui/src/components/TabStrip.tsx` | docs icon; gate query-scoped controls on a connection |
| `ui/src/components/LeftRail.tsx` | `?` calls `openDocsTab` |
| `ui/docs.html`, `ui/src/docsMain.ts` | delete |
| `ui/vite.config.ts`, `core/src/server.ts`, `shell/src/bun/index.ts`, `ui/src/api/client.ts` | revert the window plumbing |

## Tests

- **Executable (integration, TDD):** extend the BASED-TABSTORE kind round-trip in
  `integration.storage.test.ts` to cover `diagram` and `docs` — write it first against the current
  `TabKind`, watch it fail to typecheck / round-trip, then widen the union. The existing cases use
  opaque ids (`"tbl1"`), so they need no change for the UUID work.
- **Regression pass for the UUID change (manual):** it's a refactor, so the check is that specified
  behavior is unmoved. Open the same table twice from the explorer → one tab focused, not two.
  Same for a routine and for the ER diagram at one scope. Open a table's "SQL" sub-view → the
  hidden linked tab is created once and reruns don't stack. Close a table tab → its linked SQL tab
  goes with it (`closeTabs` walks `parentTabId`, which is unaffected). Restart with tabs persisted
  under the old derived ids → they restore, and reopening the same object focuses the restored tab
  instead of duplicating it. Two windows on two connections, same table open in each → both
  survive a restart (this is the case that fails today).
- **`unit.capiTools.test.ts`** — check whether it asserts on `show_results` tab ids; if so, loosen
  it to "the returned id names a real tab" rather than a literal string.
- **Manual (BASED-HELP-DOCS):** the four-step procedure above. UI + tab-lifecycle behavior; no
  executable test, no stub.

## Risks / notes

- The shortcut table is still duplicated between spec.md and the docs markup. As TSX it *could*
  be driven from a shared constant that `App.tsx`'s keydown handler also reads — a real fix for the
  drift BASED-UI-SHORTCUTS currently manages by hand, but a bigger change than this plan. Flagging,
  not doing.
- Widening the `App.tsx` gate is the only place where app chrome renders without a connection.
  Worth a look at `StatusBar` and `RightRail` in that state — both already render disconnected
  today, so no change expected.
- Lost capability: reading docs side-by-side with the app on a second monitor. Ctrl+N still opens a
  window, and docs opens as a tab there.
- The UUID change is the riskier half of this plan, and it's the half with no new behavior to show
  for it. It touches the four open-a-tab paths plus an agent-facing return value. Land it as its
  own commit ahead of the docs tab so a bisect can separate them.
