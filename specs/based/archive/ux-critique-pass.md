# Plan: UX critique pass (impeccable critique, 2026-10-26)

**Status:** implemented (7 commits on `ux/critique-pass`, 2026-10-27)
**Branch:** `ux/critique-pass` (from `origin/main`)
**Source:** `.impeccable/critique/2026-10-26T17-24-28Z__ui-src.md` (24/40). User priorities: agent SQL
safety first, all five issues, agent/connection identity shown across the workspace.
**Spec impact:** 15 new requirements, 8 modified — listed per phase and summarized at the end.

## Fixed constraints (user decisions)

- **One connection per window** is a deliberate core decision (`BASED-UI-CONNECTIONS`). Connection
  identity lives at the *window* level — title, status bar, approval card — never per tab.
- **No nag prompts by default.** "Save changes?" exists only as an opt-in setting, default off. The
  default protection against lost work is a silent reopen stack.

Each phase is one commit; phases 1–3 are the safety core and can ship alone as a first PR.

---

## Phase 1 — Agent SQL safety (`/impeccable harden`)

**Problems:** chat code blocks render Streamdown's default *light* Shiki theme on dark surfaces
(`CapiChat.tsx:144`, strings 1.42:1); the chat "Run" link executes any statement, DML included, with
no gate (`CapiChat.tsx:166` → `runSqlInNewTab`, `store.ts:1379`); the `run_mutation` card scrolls the
SQL horizontally so the WHERE clause is hidden (`capiTools.tsx:62`), names no target, shows
`Failed: …` in success green (`capiTools.tsx:85`, `:330`), and styles Reject — the safe choice — red.

**Changes:**
1. **Shared UI SQL text helpers.** New `ui/src/lib/sqlText.ts`: the comment/string strippers and
   tokenizer now private to `deriveTabTitle.ts` move here, plus an `isReadOnly(sql)` mirror of
   `core/src/db/classify.ts` (the webview never imports `@based/core`). `deriveTabTitle.ts` imports
   from it — no behavior change there.
2. **Chat Run gate.** `SqlActions` classifies each block: read-only → **Run** (unchanged: new tab,
   runs). Anything else → **Open** (new tab with the SQL, *not* run, editor focused) with tooltip
   "Opens in a tab without running — review, then F5". No dialog: the user runs it the same way they
   run their own SQL, which matches the no-nag constraint and still keeps agent-authored writes from
   executing on one click.
3. **Theme-aware chat code.** Pass Streamdown a Shiki theme pair derived from the active theme's
   mode (dark/midtone → dark theme, light → light theme), and override the code-block background to
   the app's `--color-ink-950` so blocks sit on the same surface as the editor. Chat markdown table
   headers get the same treatment (light-grey header on dark).
4. **Approval cards** (`run_mutation`, `import_csv`, `create_table` — one shared `ApprovalFrame`):
   - Header line names the target in weight 700: `{connection name} · {database}`. The name is the
     user's own, so it carries whatever environment convention they use (Phase 2).
   - SQL wraps (`whitespace-pre-wrap break-words`), max-height with vertical scroll; nothing hidden
     horizontally.
   - Approve keeps the brass/ok primary weight; Reject becomes a neutral secondary button.
   - Outcome renders by status: ok → `text-ok`, error → `text-err` with "Failed:" prefix, rejected →
     `text-muted` ("Rejected — nothing ran."). Fixes the green-failure bug on mutation and import.

**Spec:**
- New `BASED-UI-READONLY-MIRROR` — **unit**. `ui/src/lib/sqlText.isReadOnly` agrees with
  `core/src/db/classify.isReadOnly` on a shared case table (SELECT, CTE, CTE+DML, `SELECT … INTO`,
  EXEC, comment/string-hidden keywords, empty). Silent when wrong, so it earns a test.
- New `BASED-CHAT-SQL-RUN-GATE` — **manual**. Read-only fence → Run executes; non-read fence → Open,
  new tab unrun, nothing executes.
- New `BASED-UI-APPROVAL-CARD` — **manual**. Target line, wrapped SQL, neutral Reject, status-colored
  outcome on all three cards.
- New `BASED-CHAT-CODE-THEME` — **manual**. Chat code legible on dark, midtone, and light themes.
- `BASED-AGENT-MUTATION-GATE` unchanged (server contract untouched).

## Phase 2 — Window identity and Capi presence (`/impeccable shape` → build)

Today every window is titled `based` (`shell-tauri/src/main.rs:105`), so the taskbar and Alt-Tab
cannot tell windows apart. The connection's own name shows only in the left-rail selector; the
status bar shows the host (`connTarget`), not the name (`StatusBar.tsx:47-51`).

Shape brief:
- **Job:** at a glance — from the taskbar, Alt-Tab, the status bar, or an approval card — know which
  connection this window is. Know which tabs Capi opened.
- **Identity source:** the connection name the user chose. Environments differ for every user, so
  based adds no environment field, tag, or color; users put that in the name ("orders PROD").
- **Surfaces:**
  1. **Window title, name first:** `"{connection name} · {database} — based"`; plain `based` when no
     connection is active. The native title bar cannot be styled, so the name leads the string to
     survive taskbar truncation. The UI sets `document.title`; the Tauri shell mirrors it with
     `WebviewWindowBuilder::on_document_title_changed` → `set_title` (`shell-tauri/src/main.rs:104`;
     available in the locked tauri 2.11). Same code path on Windows, macOS, and Linux.
  2. **Status bar names the connection:** the connection name in weight 700 before the existing
     `target · database` text.
  3. **Engine glyph** (SQL Server / Snowflake / LanceDB) beside connection names in the selector and
     status bar; connection names truncate in the middle with a full-name tooltip.
  4. **Read-only badge** in the status bar when `capabilities.write === false` (an engine fact, not
     a user tag).
  5. **Capi-opened tabs** — tabs created by `show_results` / `open_query_tab` carry
     `openedBy: "capi"` (persisted in tab meta) and render a small capybara mark before the title,
     tooltip "Opened by Capi".
- **Already exists, no work:** Capi's reads and writes are in History → Agent (`HistoryPanel.tsx`,
  `BASED-AGENT-AUDIT`).
- **Anti-goals:** no per-tab connection markers, no multi-connection windows, no environment
  tags/colors/strips, no user-set "treat as read-only" write block (possible follow-up; it is a
  capability change, not a UI one).

**Spec:**
- New `BASED-WINDOW-IDENTITY` — **manual**: name-first window title (updates on connect, switch,
  database change, disconnect), connection name in status bar, engine glyph, read-only badge.
- New `BASED-AGENT-TAB-MARK` — **manual**: Capi-opened tabs marked, mark survives restart.

## Phase 3 — Editor safety (`/impeccable harden`)

**Problems:** `runQuery` always sends the whole buffer (`store.ts:1131`); F5 and Ctrl+Enter ignore
the selection (`EditorPane.tsx:47-48`); `closeTabs` discards dirty tabs with no recovery
(`store.ts:1054-1075`).

**Changes:**
1. `runQuery(id, opts?: { sql?: string; range?: IRange })` — runs `opts.sql` when given, else the
   buffer. Result/tab-title derivation uses the SQL actually run (already true for autoname).
2. **F5 / toolbar Run:** run the selection when non-empty, else the whole buffer (SSMS semantics).
3. **Ctrl+Enter:** run the statement at the cursor — new pure `statementAt(sql, offset)` in
   `sqlText.ts`, splitting on depth-0 `;` and `GO` lines with strings/comments respected (same
   tokenizer as autoname). The executed range flashes briefly (Monaco decoration, reduced-motion
   aware). Falls back to the whole buffer when the text has a single statement.
4. **Reopen stack.** Closing tabs pushes one *batch* entry (title, content, filePath, kind, table
   identity) onto an in-session stack (cap 20 batches). **Ctrl+Shift+T** pops one batch and restores
   every tab in it — a "Close All Tabs" comes back with one press. Tab context menu gains
   "Reopen closed tab". Pure helper `ui/src/lib/closedTabs.ts` (push/pop/cap).
5. **Opt-in confirm.** New setting `confirmCloseUnsaved` (default **false**) in Settings → General:
   when on, closing tabs with `dirty && content.trim()` asks once per close action (one dialog for a
   batch, listing the tab titles). Off = today's behavior plus the reopen stack.

**Spec:**
- New `BASED-RUN-SCOPE` — **unit** for `statementAt` (multi-statement, GO, strings/comments containing
  `;`, cursor on separator/blank line, single statement) + **manual** for selection/F5 wiring.
- New `BASED-TAB-REOPEN` — **unit** for the stack helper (batch round-trip, cap eviction) + **manual**
  for Ctrl+Shift+T after Close All.
- New `BASED-TAB-CLOSE-CONFIRM` — **manual**; `BASED-SETTINGS` modified — **integration**: fresh store
  returns `confirmCloseUnsaved: false`.
- `BASED-UI-SHORTCUTS` modified: split the F5 / Ctrl+Enter row (F5 = selection or all, Ctrl+Enter =
  statement at cursor), add Ctrl+Shift+T. Help tab renders from the same table.
- `BASED-UI-TABS` modified: run wording + reopen.

## Phase 4 — Failure states (`/impeccable clarify`)

**Problems:** `connectSession` disconnects the old adapter before the new one connects
(`core/src/server.ts:250-251`), and the UI keeps the old `activeConnectionId` on failure
(`store.ts:875-877`) — selector, explorer, and status bar disagree, and the working session is gone.
The banner is raw driver text with no action. A restored tab for a missing table renders blank
while three calls 500. After a SQL error the results pane still says "No results — run a query
(F5)." (`ResultsPane.tsx:132`) and the error never reaches the editor. A local LanceDB path that does
not exist is silently created and connects green with "Tables 0".

**Changes:**
1. **Connect-then-swap (core).** `connectSession` builds and connects the new adapter first; only on
   success does it close the old adapter + LSP and swap. On failure the session keeps its previous
   adapter, `connectionId`, and status, and the error propagates.
2. **UI on failure:** state stays on the previous connection (it still works). The banner names the
   connection that failed — "Couldn't connect to **Demo Retail** — server not reachable at
   localhost,15433" — with **Retry** and **Edit connection…** actions. From the disconnected state
   the selector shows the failed connection with an error dot.
3. **Error translation.** Pure `describeConnectError(engine, message)` maps known driver patterns to
   plain text + the raw message as detail: host unreachable/timeout, login failed, Snowflake role or
   account identifier, Lance folder not found. Unknown → raw message unchanged.
4. **Lance missing folder (core).** A local path that does not exist fails with
   `Folder not found: "<path>"` and creates nothing. Existing-but-empty folders still bootstrap
   (`BASED-LANCE-CONNECT` unchanged there).
5. **Table tab error state.** When details/columns/row-count fail, the tab shows the error, the object
   name, and **Close tab** / **Refresh objects** instead of a blank pane.
6. **Query errors.** On an error result the results pane shows the error text (line breaks kept)
   instead of the empty-state copy; when the error chunk carries `line`, set a Monaco error marker on
   that line (cleared on next run). Output keeps the full text.

**Spec:**
- New `BASED-CONN-SWITCH-FAILURE` — **integration** (server: connect A, connect a bad config → error,
  session still on A and A still queryable) + **manual** (UI banner, Retry/Edit, selector state).
- New `BASED-CONN-ERROR-TEXT` — **unit** for `describeConnectError` patterns.
- `BASED-LANCE-CONNECT` modified — **integration**: a non-existent path errors and no directory is
  created.
- New `BASED-UI-QUERY-ERROR` — **manual** (results-pane error + editor marker);
  `BASED-UI-OUTPUT` modified to reference it.
- New `BASED-UI-TABLE-TAB-ERROR` — **manual**.

## Phase 5 — Keyboard, screen reader, contrast (`/impeccable audit`)

**Problems:** zero `role=`/`aria-live`/`focus-visible` in `ui/src`; explorer rows and tabs are
click-only divs (`ObjectExplorer.tsx:159-171`, `TabStrip.tsx:59-65`); the tab ✕ stays `opacity-0`
on focus (`TabStrip.tsx:121`); the four modals (`ConnectionDialog`, `ImportCsvDialog`,
`NewTableDialog`, `ThemePicker`) have no dialog semantics, focus trap, or initial focus, and two
ignore Esc; Monaco takes focus on connect and keeps Tab; several icon-only buttons bypass
`IconButton`; `--color-faint` is 3.3–4.0:1 at 10–12px across 134 uses.

**Changes:**
1. **Explorer = tree** (`role="tree"`/`treeitem`, group headers as expandable items), roving
   tabindex, arrows/Home/End, Enter = open (same as double-click), Shift+F10 / Menu key = context
   menu, type-ahead by name.
2. **Tab strip = tablist** with roving tabindex; Delete closes the focused tab; ✕ and other
   hover-reveal controls (edit connection, + New table) get `focus-visible:opacity-100`.
3. **Shared `Dialog` component** — `role="dialog"`, `aria-modal`, `aria-labelledby`, focus trap,
   initial focus on the first field, Esc closes, focus returns to the opener. Backdrop click no longer
   closes a dialog that has in-progress input (ImportCsv mapping). All four modals adopt it.
4. **Live regions:** `aria-live="polite"` for streamed Capi answers (final text, not every token),
   run status, and the banner; approval cards announce on mount.
5. **Monaco focus:** don't steal focus on connect/restore — only when the user opens or switches to a
   tab. Help documents Ctrl+M (Tab moves focus).
6. **Icon buttons:** Capi collapse, Send, plan/stats toggles, Copy → `IconButton` with `title` +
   `aria-label` (`CopyIcon` for Copy, per `CLAUDE.md`). "New chat" gets a distinct icon, not ✎.
7. **Contrast:** raise `faint` in every theme to ≥ 4.5:1 on `bg0`–`bg2`; move text that sits on
   `bg3` (row-count badge) to `muted`. "Ask Capi" title → `text-paper-dim`. Also retire the stale
   `#5a606a` fallback in `index.css:59` in favor of the ledger value.
8. **Connection dropdown:** listbox semantics, arrow keys, Enter, Esc.

**Spec:**
- New `BASED-THEME-CONTRAST` — **unit**: for every theme in `theme.ts`, `faint` vs `bg0`/`bg1`/`bg2`
  ≥ 4.5:1 and `muted` ≥ 4.5:1 (WCAG relative-luminance math in the test). Silent when wrong, cheap.
- New `BASED-UI-A11Y-KEYBOARD` — **manual**: keyboard-only walk (explorer → open table → tabs →
  dialogs → Capi) plus a screen-reader spot check.
- `BASED-UI-EXPLORER` and `BASED-UI-TABS` modified (keyboard behavior); `BASED-HELP-DOCS` modified
  (Ctrl+M entry).

## Phase 6 — Vector-search toolbar (`/impeccable layout`)

**Problem:** one non-wrapping row of 8–15 controls (`TableDataGrid.tsx:598-757`); Run/Clear clipped
at 1440, 1280, and 1024px; placeholder-only labels; mode glyphs unlabeled; read-only tables still
show Review SQL / Commit / Discard.

**Changes:**
1. **Primary row:** text segmented control `Vector | Text | Hybrid`, query input (flex), **Run**,
   Clear. Run is always visible.
2. **Tuning row** behind a "Tuning" disclosure: embedding profile, reranker + top_n/temperature,
   pool/keep/min score/max gap, vector column, where prefilter — each with a persistent visible
   label. Collapsed state shows non-default values as removable chips ("min score 0.5 ✕").
   Disclosure state persists per window.
3. Data-view action row wraps by group instead of per word at narrow widths; edit actions (Review
   SQL / Commit / Discard / + / Import CSV / Delete row) hidden on read-only tables.

**Spec:** `BASED-LANCE-SEARCH-UI` modified — **manual**: layout, labels, chips, Run visible at
1024px with Capi open.

## Phase 7 — Polish (`/impeccable polish`)

Minor items from the critique: Settings label hierarchy (group label ≥ sub-label) and a modal sized
to content; "Pick a connection to begin." gets a **Choose connection** button when connections exist
(`App.tsx:86`); "Rows 500" fetch size moves next to Run; read-only "0–0 of 0" hidden; status-bar path
middle-truncated with tooltip; README theme count corrected; `docs/screenshots/agent-tabs.png`
retaken (shows "unknown" tool rows); Monaco's unhandled `Canceled` rejection on dispose caught.
Then rerun `/impeccable critique` and record the new score.

## Not in this plan

- A Stop control for an in-progress Capi run (the critique noted Stop appears only after 120 s
  without progress). Worth its own small plan.
- Command palette; explorer filter beyond type-ahead.
- A user-set read-only flag that blocks writes on a connection.

## Spec impact summary

**New (15):** `BASED-UI-READONLY-MIRROR` (unit), `BASED-CHAT-SQL-RUN-GATE`, `BASED-UI-APPROVAL-CARD`,
`BASED-CHAT-CODE-THEME`, `BASED-WINDOW-IDENTITY`, `BASED-AGENT-TAB-MARK`, `BASED-RUN-SCOPE` (unit +
manual), `BASED-TAB-REOPEN` (unit + manual), `BASED-TAB-CLOSE-CONFIRM`, `BASED-CONN-SWITCH-FAILURE`
(integration + manual), `BASED-CONN-ERROR-TEXT` (unit), `BASED-UI-QUERY-ERROR`,
`BASED-UI-TABLE-TAB-ERROR`, `BASED-THEME-CONTRAST` (unit), `BASED-UI-A11Y-KEYBOARD`.

**Modified (8):** `BASED-SETTINGS`, `BASED-UI-SHORTCUTS`,
`BASED-UI-TABS`, `BASED-LANCE-CONNECT`, `BASED-UI-OUTPUT`, `BASED-UI-EXPLORER`, `BASED-HELP-DOCS`,
`BASED-LANCE-SEARCH-UI`.

**Tests (all in `specs/based/tests/`, `bun test`):** `unit.sqlText.test.ts` (readonly mirror +
statementAt), `unit.closedTabs.test.ts`, `unit.connectError.test.ts`, `unit.themeContrast.test.ts`,
and additions to the existing settings, server, and lancedb integration tests.

## Verification

- `bun run typecheck` and `cd specs && bun test` green after each phase.
- Phases 1–6: drive the dev build (`dev:core` + `dev:ui`, memory note) at 1440/1280/1024 with
  screenshots of each changed surface, including the approval card on SQL Server (needs the demo
  SQL Server up) and a dark, midtone, and light theme.
- Phase 7 ends with `/impeccable critique` on `ui/src`; target ≥ 30/40.

## Outcome

- All seven phases are implemented and merged into `spec.md`; `bun test` and typecheck pass.
- Deviations: Phase 2 has no environment field, tag, or strip (user decision); identity is the
  user-chosen name, first in the window title and bold in the status bar. The engine mark is a text
  chip from the engine profile, not a glyph (`BASED-ENGINE-REGISTRY` forbids branching on engine id).
  `docs/screenshots/agent-tabs.png` was not retaken (needs a live model backend).
- Re-critique: 25/40 (was 24/40), short of the 30 target. New P1s for a follow-up plan: pending
  grid edits lost on tab/view switch, invisible focus ring on dark themes, LanceDB search offering
  unsupported modes and raw engine errors. Snapshot: `.impeccable/critique/2026-10-27T18-32-23Z__ui-src.md`.
