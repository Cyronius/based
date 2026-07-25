# Expose full app functionality to the Capi agent

## Context

The Capi agent today has a narrow, read-only toolset (`get_schema`, `sample_rows`, `run_query`, three Lance search tools, `load_skill`) and one global chat thread per window with zero tab awareness. The user wants the agent to be a first-class operator of the app:

- Full LanceDB vector-search richness (all query knobs, reranker options)
- DDL scripting (generate CREATE scripts; execution stays on the existing approval gate)
- Export of query/table results (import deferred — parallel session; stop and re-examine at the end)
- Efficient record paging (no whole-table pulls)
- Tab context: current tab by default, other tabs on reference
- Agent can open new query tabs; SQL results for the user open in a tab instead of dumping into chat
- Per-tab chat threads (user-confirmed choice): switching tabs switches the conversation

## Approved scope decisions (from user)

1. Per-tab chat threads, with a connection-level fallback thread when no tab is active.
2. Agent opens **new query tabs only** (not table tabs, not connections).
3. DDL: script generation + gated execution via existing `run_mutation` approval flow.
4. Import: **deferred** — being built in another session; after everything else, stop and re-examine an import tool.

## Key existing primitives (reuse, don't rebuild)

- `runSqlInNewTab(sql)` — ui/src/store.ts:986 — opens a query tab and runs it.
- Frontend tool pattern (`isFrontend`, handler promise, renderer) — ui/src/agent/capiTools.tsx (`run_mutation`).
- `systemContextBuilder` + `initialThreadId` + `setMessages` — ui/vendor/lm-ag-ui (dist/types/index.d.ts, AgentClient.d.ts); client runs `sendFullHistory: false` (stateful, Mastra memory rehydrates by threadId) — RightRail.tsx:62-71.
- `readTablePage(schema, table, {offset, limit})` on both adapters — core/src/db/types.ts:246.
- Unified `adapter.search(params)` — core/src/db/lanceAdapter.ts:385 (rerankerOptions/rerankTextColumn already supported adapter-side, just not in agent tool schemas).
- Export writers `toCsv` / `writeXlsx` — core/src/export/csv.ts, xlsx.ts.
- Mutation gate — POST /api/agent/mutation (server.ts) + isReadOnly classifier.

## Plan

### A. Vector-search richness (LanceDB)

SDK verified: installed `@lancedb/lancedb` **0.24.1** has `nprobes`, `ef`, `refineFactor`, `distanceType`, `postfilter`, `bypassVectorIndex`, `distanceRange(lower?, upper?)` on `VectorQuery`; `Table.listIndices()` / `indexStats(name)` with `distanceType`. No upgrade needed.

**A1. Reranker options on agent tools** — `core/src/agent/tools/lancedb.ts` `searchOptionFields` (lines 39–46) gains flat fields `rerankTopN`, `rerankTemperature`, `rerankTextColumn`; execute maps to the adapter's existing `rerankerOptions`/`rerankTextColumn` (zero adapter work — already supported at core/src/db/lanceAdapter.ts:426-429).

**A2. Wire missing SDK knobs** —
- `core/src/db/types.ts` `LanceSearchRequest`: add `distanceType?: "l2"|"cosine"|"dot"`, `nprobes?`, `refineFactor?`, `ef?`, `postfilter?`, `bypassVectorIndex?`, `distanceRangeLower?`, `distanceRangeUpper?`. The HTTP route `POST /api/session/lance-search` spreads `...rest`, so it gets them for free.
- `core/src/db/lanceAdapter.ts` `search()` (line 385): private `applyVectorKnobs(q, params)` chained in the vector branch and in the hybrid branch after `.nearestTo(vector)` before `.rerank(...)`. Text mode with any vector-only knob → descriptive error (teaches the agent).
- Agent tools: split `searchOptionFields` into `commonOptionFields` + `vectorOptionFields`; `vector_search`/`hybrid_search` get all eight, `text_search` gets none (schema-level omission).
- **Skipped with rationale**: `fastSearch()` (silently drops unindexed rows — recall footgun), `minimumNprobes`/`maximumNprobes` (near-duplicates of `nprobes`), `explainPlan()` (a diagnostic, not a search param — future).

**A3. Populate `vectorMetric`** — `getTableColumns` (lanceAdapter.ts:259, hardcodes null at 276): when vector columns exist, `listIndices()` + `indexStats()` → normalize `distanceType` to `"l2"|"cosine"|"dot"`; try/catch → null on failure; memoized per `${schema}/${table}` in a Map cleared on `disconnect()` (getTableColumns runs on every page read/search — keeps cloud latency flat).

**A4. Skill update** — `core/src/agent/skills/lanceSearch.ts`: new "Tuning knobs" section (when to raise nprobes/ef, refineFactor for exactness, bypassVectorIndex as ground truth, postfilter vs prefilter starvation, distanceRange vs floor/delta, rerank fields, distanceType-vs-index-metric caveat).

### B. DDL scripting (`script_object`)

- `core/src/db/mssqlAdapter.ts` `getTableColumns` (line 251): add `c.is_identity` + LEFT JOIN `sys.default_constraints` → new optional `TableColumn.isIdentity?` / `defaultExpr?` in `core/src/db/types.ts` (Lance never sets them; grid/tableEdit unaffected).
- **New pure module `core/src/db/scriptObject.ts`**: `scriptCreateTable(schema, table, columns)` (T-SQL: types with MAX/-1 handling, precision/scale, nullability, IDENTITY, defaults, PK constraint, trailing single-column `ALTER TABLE … ADD FOREIGN KEY` from `fkTarget`; reuses `quoteIdent`/`qualified` from core/src/db/tableEdit.ts) and `describeLanceSchema(table, columns)` (readable pseudo-DDL + pyarrow snippet, vector cols show `vector[dim] of type (metric: …)`). Indexes skipped in v1 (agent can query sys.indexes via run_query); composite FKs collapse to per-column statements (introspection granularity — recorded limitation).
- **Agent tools**: mssql `script_object({name, schema?})` — resolves object type via `listObjects()`; table → `scriptCreateTable`, view/proc/function → existing `getObjectDefinition`. Lance `script_object({table, schema?})` → `describeLanceSchema`. Both audited via `auditRead`.
- **Execution**: no new exec path — DDL the agent proposes runs through the existing `run_mutation` approval card (isReadOnly already classifies DDL as mutation).

### C. Paging tool (`read_rows`)

Engine-neutral, in `core/src/agent/tools/shared.ts` (readTablePage is on the DatabaseAdapter interface):
`read_rows({table, schema?, offset?, limit?})` — limit clamped 1–200 (default 100), returns `{columns, rows, orderBy, offset, returned, hasMore}` where `hasMore = rows.length === limit` (documented heuristic; TablePage has no total). Audited. **Keep `sample_rows`** (peek at example values) alongside — distinct intents, cross-referenced in descriptions.

### D. Export tool (`export_data`)

**UX decision: server-side write to a default folder, return the path** (modal save-dialog mid-agent-run blocks the tool loop; frontend-mediated card is a UI workstream for a benign read-only write). Default `~/Downloads` (fallback tmpdir), filename `based-export-<name>-<timestamp>.<ext>`, optional `openAfter` via existing `openWithDefaultApp`.

- **New `core/src/export/exportData.ts`**: `exportData(adapter, source, format, targetPath, opts?)` with `ExportSource = {kind:"sql", sql} | {kind:"table", schema, table}`; `EXPORT_ROW_CAP = 100_000`. SQL source: requires `capabilities.sql`, runs via existing `collectQuery` (core/src/agent/runSql.ts), exports first result set. Table source: loops `readTablePage` in pages of 1,000 (works on every engine incl. Lance Cloud). Writers: existing `toCsv`/`writeXlsx`.
- **Agent tool** in shared.ts: `export_data({format: csv|xlsx, sql?|table?, schema?, fileName?, openAfter?})` — exactly-one-of sql/table; `isReadOnly` refusal on sql; fileName sanitized (no separators/`..`); audited as kind `read`; returns `{path, rowCount, truncated}`.
- No new HTTP routes (tools run in-process on the server).

### E. Tab context + open-query-tab tools

**Key verified fact**: `systemContextBuilder` is a **dead end** — the `@ag-ui/mastra` bridge's message converter only handles `user`/`assistant`/`tool` roles (verified in `core/node_modules/@ag-ui/mastra/dist/mastra-BMpL3wPU.js`; no `system` case), so injected system messages are silently dropped. The channel is **`forwardedProps`**: `useAgent({ buildForwardedProps })` merges into every send including mid-chain `submitToolResults`, `RunAgentInputSchema.forwardedProps` is `z.any()`, and the server already parses the full input.

**E1. Server-side context injection**
- New pure `core/src/agent/tabContext.ts`: `renderTabContext(raw: unknown): string | null` — validates the loose shape, hard caps (SQL ≤4,000 chars, ≤30 tabs, total ≤8,000 chars), renders a `<workspace_context>` block (active tab identity + SQL + result-set *summaries* — columns/rowCount/truncated, no rows — plus a one-line list of all open tabs). Null on absent/garbage input.
- `core/src/agent/agent.ts`: `buildAgent` gains optional `contextNote?: string`, appended to instructions; `GENERIC_CORE` gains ground rules: workspace-context awareness + "when the user asks to *see* data, call `open_query_tab` so results land in a real grid — don't paste large row sets into chat; `run_query` is for your own analysis."
- `core/src/server.ts` `agentStream`: `renderTabContext(input.forwardedProps?.tabContext)` → `buildAgent`.

**E2. UI snapshot + frontend tools**
- New pure `ui/src/agent/tabContext.ts`: `buildTabContext(state)` (active tab: id/kind/title/sql/lastRun/resultSummaries; openTabs from existing `visibleTabs`) and `serializeResultRows(rs, maxRows)` using existing `cellText` (ui/src/api/types.ts:316), cell cap 300 chars.
- `ui/src/agent/capiTools.tsx` — three new tools (same `ToolDefinition` pattern as `run_mutation`, handlers read `useStore.getState()`):
  - `list_tabs` (no args) → active tab id + per-visible-tab `{id, kind, title, running?, resultSets: [{rowCount, truncated}]}`.
  - `get_tab({tabId, maxRows?})` — query tab → sql/output/stats/serialized results (default 50 rows, max 200); table/routine → columns/definition (≤4,000 chars); unknown id → `{error, validTabIds}` (no-throw, mirrors `load_skill`).
  - `open_query_tab({sql, run?, title?})` — `run !== false` → `await Promise.race([runSqlInNewTab(sql), 15s])`; returns `{tabId, title, status, durationMs, resultSets, preview: first 10 rows, errors}` or on timeout `{status: "running", note}`. `run === false` → open with content, don't execute. Optional renderer: "Opened *{title}*" chip that calls `activateTab(tabId)`.
- `ui/src/store.ts`: `runSqlInNewTab` / `newQueryTabWithContent` return the new tab id (callers ignoring the value stay compatible; `runSqlInNewTab` already awaits `runQuery` internally — store.ts:1000-1007).
- `RightRail.tsx` `useAgent`: add `buildForwardedProps: () => ({ tabContext: buildTabContext(useStore.getState()) })`.

### F. Per-tab chat threads

**Verified constraints**: `AgentClient` is constructed once with `initialThreadId` fixed (no setter); `startNewRun()` keeps the threadId, `endSession()` nulls it (next run gets a random one); `useAgent` does no network work on mount; under `sendFullHistory: false` the client sends only `[context?, lastMessage]` and Mastra memory rehydrates by threadId; Mastra `Memory` exposes `recall({threadId, resourceId, perPage: false})` and `deleteThread(threadId)`.

**Design decisions**:
- **threadId** = `tab:${connectionId}:${tabId}` (table-tab ids like `table:dbo.Users` repeat across connections; the prefix guarantees uniqueness in the memory store). Fallback `conn:${connectionId}` when no tab is active. `resourceId` stays `connectionId`.
- **Thread ownership & aliasing (agent-opened tabs)**: a user-opened tab *owns* the thread derived from its id. An **agent-opened tab aliases the thread that created it** — the `open_query_tab` handler stamps the new tab with `originThreadId` (the currently mounted thread id), persisted in the tab's `meta` JSON so it survives restart. Thread resolution everywhere = `tab.originThreadId ?? derived id`. Rationale: without this, clicking the results tab the agent just opened would blank the rail — the conversation that produced the tab must follow it.
  - **Close rule**: deleting a thread on tab close happens only when the closing tab *owns* it AND no other open tab aliases it (cheap scan of `tabs`). Aliased tabs never delete on close.
  - **New chat on an aliased tab**: detaches — clears `originThreadId` so the tab starts its own fresh owned thread, never wiping the shared conversation out from under the origin tab.
  - `QueryTabState` gains optional `originThreadId?: string`; `buildTabPayload`/hydration round-trip it through tab `meta`.
- **UI swap** = single `useAgent`, remounted via React `key={threadId}` + `initialThreadId`. No parallel providers.
- **"New chat"** must stop calling `endSession()` (it would randomize the threadId) — instead: `DELETE` the thread server-side, `clearMessages()`, evict cache.
- **Mid-run tab switch**: defer the remount until the run finishes (banner "Capi is finishing in *{tab}* — the chat will follow"); never kill an in-flight run.

**F1. Server** —
- New `core/src/agent/threadMessages.ts`: `mapDbMessagesToAgui(messages)` — Mastra DB messages (`{id, role, createdAt, content: {format: 2, parts}}`) → AG-UI `Message[]`; assistant `tool-invocation` parts become `toolCalls` + one synthetic `role:"tool"` message per resolved invocation with id prefix `hist_` (so CapiChat's existing call/result pairing renders). Defensive: skip unknown parts/roles.
- `core/src/server.ts`: `GET /api/agent/threads/:threadId/messages?resourceId=…` → `recall` → map → json (`[]` on unknown/error; no live DB connection required); `DELETE /api/agent/threads/:threadId` → `deleteThread` (try/catch).

**F2. UI** —
- New `ui/src/agent/threads.ts`: `agentThreadId(connectionId, tabId)`, module-level `threadMessageCache: Map<threadId, Message[]>` + `restoredIds: Set<string>`, `fetchThreadHistory`, `deleteThread`, `pruneRestored(messages)` (drops restored `hist_*` messages from outbound sends via `pruneOutboundMessages` — prevents re-saving synthetic tool results; mechanically safe under `sendFullHistory:false`, documented as a deliberate contract bend).
- `RightRail.tsx`: compute `desiredThreadId` from store (`activeTabId` + `activeConnectionId`); hold `mountedThreadId` in state, swap only when not streaming; extract current body into `<ChatSession key={mountedThreadId} threadId=… />` with `initialThreadId`, `buildForwardedProps`, `pruneOutboundMessages: pruneRestored`. On mount: cache hit → `setMessages(cached)`, miss → `fetchThreadHistory(...).then(setMessages)`; mirror `messages` into cache on change.
- `ui/src/store.ts` `closeTabs`: fire-and-forget `deleteThread(...)` per closed tab **subject to the ownership/alias close rule above** + cache eviction (table-tab reopen reuses the deterministic id, so delete-on-close keeps semantics clean).
- `open_query_tab` handler additionally stamps `originThreadId` on the tab it creates (via a small store action, e.g. `setTabOriginThread(tabId, threadId)`), so the new tab's rail shows the conversation that created it.

## Spec impact

New requirements (specs/based/spec.md, house style, failing-test-first for unit/integration):

1. **BASED-LANCE-SEARCH-KNOBS** (integration) — knobs flow wire → adapter → SDK; agent tools expose them + rerank fields; text-mode rejection; `text_search` schema omits vector knobs. Tests extend `specs/based/tests/integration.lancedb.test.ts` (existing seeded-table + Bun.serve fake-reranker patterns).
2. **BASED-LANCE-VECTOR-METRIC** (integration) — `vectorMetric` from `indexStats().distanceType`; unindexed → null; memoized. Index-creation test self-skips if small-data index training fails.
3. **BASED-SCRIPT-OBJECT** (unit + integration) — pure builders unit-tested in new `unit.scriptObject.test.ts`; tool round-trips in mssql/lancedb integration tests. Also modify **BASED-MSSQL-COLUMNS** (isIdentity/defaultExpr bullet).
4. **BASED-AGENT-READ-ROWS** (unit) — cap 200, hasMore heuristic, default schema, audited; fake-adapter test in new `unit.readRows.test.ts` + surface assertion in `unit.surface.test.ts`.
5. **BASED-AGENT-EXPORT** (unit + integration) — paging loop/truncation/filename sanitization unit-tested (new `unit.exportData.test.ts`); real CSV write + audit row + mutation refusal in `integration.lancedb.test.ts`. Implementation note records deferred import.
6. **BASED-LANCE-AGENT-SURFACE** (modify) — toolset lists gain `script_object`/`read_rows`/`export_data`.
7. **BASED-AGENT-THREADS** (modify → per-tab) — threads keyed `tab:{connectionId}:{tabId}` (fallback `conn:{connectionId}`), resourceId = connectionId; agent-opened tabs alias their origin thread via `originThreadId` (persisted in tab meta; resolution `originThreadId ?? derived`; owned-and-unaliased threads deleted on close, aliased never; New chat on an aliased tab detaches); GET/DELETE thread endpoints with acceptance criteria (history round-trip; delete → subsequent GET `[]`). Integration + unit (mapper: new `unit.threadMessages.test.ts`; thread-resolution/close-rule pure logic unit-tested; endpoints: extend `integration.agent.test.ts` against a temp `agent.db`).
8. **BASED-AGENT-TAB-CONTEXT** (unit + integration) — `renderTabContext` caps/shapes (new `unit.tabContext.test.ts`, which also covers the UI's pure `buildTabContext`/`serializeResultRows`); `buildAgent({contextNote})` includes the block; `agentStream` forwards `forwardedProps.tabContext`; absent/malformed → no-op.
9. **BASED-AGENT-TAB-TOOLS** (ui — manual, pure builders unit) — `list_tabs`/`get_tab`/`open_query_tab` behavior; manual procedure: switch tabs → conversation switches; restart → per-tab history restored; close tab → thread gone; New chat clears only that tab's thread; "show me the customers table" → agent opens a tab, results in the grid, chat narrates a summary; mid-run tab switch shows the deferred banner then follows. `describe.skip` block in `manual.ui.test.ts`.
10. **BASED-CHAT-UI** (amend) — restart-restore is now per-tab and real; note the "results live in tabs, not chat" persona rule.

## Ordering

1. Spec edits — all new/modified requirements in one commit.
2. `core/src/db/types.ts` churn once (search knobs + `TableColumn.isIdentity`/`defaultExpr`).
3. Failing tests for unit/integration requirements (`unit.scriptObject`, `unit.readRows`, `unit.exportData`, `unit.tabContext`, `unit.threadMessages`, integration extensions, `unit.surface` additions).
4. Adapters: `lanceAdapter` (`applyVectorKnobs`, text-mode rejection, memoized `vectorMetric`); `mssqlAdapter` (identity/defaults join).
5. Pure modules: `db/scriptObject.ts`, `export/exportData.ts`, `agent/tabContext.ts`, `agent/threadMessages.ts`.
6. Backend tools + endpoints: `tools/shared.ts` (`read_rows`, `export_data`), `tools/mssql.ts` + `tools/lancedb.ts` (`script_object`, knob fields), server thread GET/DELETE, `buildAgent` contextNote + `agentStream` wiring.
7. UI: `agent/threads.ts`, `agent/tabContext.ts`, keyed `ChatSession` remount in `RightRail.tsx`, `capiTools` additions, store tweaks (`runSqlInNewTab` returns id, `closeTabs` thread deletion).
8. Prose: `lance-search` skill, `GENERIC_CORE` + persona fragments.
9. `bun test` from `specs/` + `tsc -p core/tsconfig.json`.

Areas A–D are independent after step 2; E depends on the `buildAgent`/`agentStream` wiring; F depends on the thread endpoints. Backend (A–D + F1/E1) and UI (E2 + F2) can proceed in parallel after step 6.

## Risks

- ANN knobs are no-ops without a trained index — keep behavioral test assertions to `distanceRange`/`postfilter`; vectorMetric index test self-skips if small-data index training fails.
- `distanceType` mismatch with the index's metric gives confusing scores — documented in skill, not guarded in code.
- Custom instruction sets (BASED-AGENT-INSTRUCTIONS) freeze old personas — new tools must be self-explanatory from `description`s; users with custom sets won't get the new GENERIC_CORE tab guidance (accepted, matches existing behavior).
- Export materializes ≤100k rows in memory (matches existing UI export posture; streaming is future work).
- `pruneOutboundMessages` contract bend (dropping restored messages vs "only content may change") — mechanically safe under `sendFullHistory:false` (verified send paths); fallback is tombstoning content to `""`.
- Mid-run tab switch: run stays pinned to its thread until completion (banner, not live stream). Accepted for v1; parallel per-tab `useAgent` instances rejected as heavy.
- Mastra DB-message part shapes may evolve — history mapper is defensive (skip unknown parts) with unit coverage.
- Vendored lm-ag-ui is NOT modified — everything needed exists (`initialThreadId`, `buildForwardedProps`, `setMessages`, `pruneOutboundMessages`).

## Verification

- `bun test` from `specs/` — all new unit + integration tests green; lancedb integration exercises knobs, metric, script_object, export end-to-end against the seeded local table; agent integration covers thread GET/DELETE and contextNote.
- `tsc -p core/tsconfig.json` clean; `bun run build` (ui) clean.
- Manual (dev app): "script the Orders table" → CREATE TABLE text; "export that to csv" → file path returned, file opens; "page through X" → repeated `read_rows` with rising offset; Lance "find similar with higher recall" → knobs in tool args; "show me the customers" → new query tab opens with results, chat gives a summary not a row dump; switch tabs → different conversation; restart app → per-tab history restored; close tab → thread gone; agent-opened results tab shows the originating conversation (alias), closing it leaves the origin tab's chat intact, New chat on it starts a fresh thread for that tab only.

## Post-plan note

Per repo doctrine, on approval this plan is materialized into `specs/based/plans/` and archived after implementation. Final step: stop and re-examine the import tool with the user (parallel session owns import machinery).

---

## Implementation addendum (as built)

The parallel import-workstream session landed BASED-SCRIPT-TSQL / BASED-TABLE-DETAILS /
BASED-TABLE-ORDERBY mid-implementation, so Area B was adapted (per this plan's own reuse doctrine):

- mssql `script_object` reuses `core/src/db/scripter.ts` + `getTableDetails` (no new scriptObject.ts,
  no mssqlAdapter introspection changes — identity/defaults/FKs/indexes already in TableDetails).
  The tool supports all scripter actions (create/drop/drop-create/alter/select/insert).
- Only the Lance half needed a new pure module: `core/src/db/lanceDescribe.ts`.
- `read_rows` additionally passes through BASED-TABLE-ORDERBY's `orderBy`/`filters` on
  orderedBrowse engines.
- `ToolDeps.exportDir` was added so tests never write to the real Downloads folder.
- UI pure logic split for DOM-free unit tests: `ui/src/agent/threadIds.ts` (id derivation + close
  rule) and store-import-free `ui/src/agent/tabContext.ts`.

Import tool: still deferred — re-examine with the user now that BASED-IMPORT-CSV-* has landed.

**Import re-examination outcome (same day):** user approved the gated shape — `import_csv` frontend
tool (BASED-AGENT-IMPORT): approval card inspects the file + target columns, resolves/previews the
mapping (explicit / header-name / positional), and only Approve drives the existing
`/api/import/csv/run` stream with live progress. No new server surface; `capabilities.write` still
gates. The agent-import deferral is closed.
