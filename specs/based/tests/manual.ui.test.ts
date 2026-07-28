// Manual/e2e verification procedures — the spec's acceptance criteria are the artifact.
// Full step-by-step procedures live in specs/based/spec.md under each requirement.
import { describe, it } from "bun:test";

// Traces: BASED-UI-LAYOUT (canonical spec: specs/based/spec.md)
// Verification: manual — launch app; left rail + center render; right-rail placeholder toggles.
describe.skip("BASED-UI-LAYOUT: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-UI-CONNECTIONS (canonical spec: specs/based/spec.md)
// Verification: manual — create/test/save/edit/delete connection; database + schema selectors.
describe.skip("BASED-UI-CONNECTIONS: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-UI-EXPLORER (canonical spec: specs/based/spec.md)
// Verification: manual — accordion groups with counts; double-click table → details tab.
describe.skip("BASED-UI-EXPLORER: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-UI-TABS (canonical spec: specs/based/spec.md)
// Verification: manual — tab persistence across restart, Ctrl+S save, F5 run, cancel, resizable panes.
describe.skip("BASED-UI-TABS: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-UI-RESULTS (canonical spec: specs/based/spec.md)
// Verification: manual — result-set sub-tabs, grid/text/plan tabs at far left (tab-styled), copy,
// CSV/XLSX export, Open in Excel, row-cap notice tied to the tab bar's fetch-size input.
describe.skip("BASED-UI-RESULTS: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-UI-EXEC-PLAN (canonical spec: specs/based/spec.md)
// Verification: manual — tab bar's fetch-size input + Execution Plan/Client Statistics icon toggles;
// interactive pan/zoom/click-select plan canvas; multi-statement plan picker; stats messages in Output.
describe.skip("BASED-UI-EXEC-PLAN: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-UI-OUTPUT (canonical spec: specs/based/spec.md)
// Verification: manual — readable error text in Output; visible reconnecting state after token expiry.
describe.skip("BASED-UI-OUTPUT: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-AUTH-INTERACTIVE (canonical spec: specs/based/spec.md)
// Verification: manual — Test Connection with "Entra ID (interactive)" opens browser, sign-in succeeds.
describe.skip("BASED-AUTH-INTERACTIVE: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-AUTH-SQLLOGIN (canonical spec: specs/based/spec.md)
// Verification: manual — SQL auth connection succeeds; wrong password fails readably.
describe.skip("BASED-AUTH-SQLLOGIN: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-AUTH-SP (canonical spec: specs/based/spec.md)
// Verification: manual — service principal connection succeeds.
describe.skip("BASED-AUTH-SP: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-AGENT-INSTRUCTIONS-UI (canonical spec: specs/based/spec.md)
// Verification: manual — settings Agent tab lists instruction sets as rows (Edit + duplicate icons,
// subtitle shows built-in/read-only and profile-link count); opening any editor (set or provider
// profile) takes over the whole tab, hiding the lists until Save/Cancel returns; Default opens as a
// read-only viewer with "Duplicate to edit"; duplicate opens an unsaved editable copy (Save-only,
// discarded on Cancel); rename/edit/save/delete all persist per spec.md acceptance criteria.
describe.skip("BASED-AGENT-INSTRUCTIONS-UI: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-WINDOW-RESTORE (canonical spec: specs/based/spec.md)
// Verification: manual — open 2 windows (Ctrl+N) on different connections with tabs open, quit
// (both cleanly and via kill) and relaunch → both windows reopen with connection/tabs/active
// tab/schema filter intact; a cleanly-closed window does not come back.
describe.skip("BASED-WINDOW-RESTORE: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-CONN-SWITCH-CACHE (canonical spec: specs/based/spec.md)
// Verification: manual — switching between connections already visited this session is instant
// and lossless (tabs/active tab/schema filter restored, no refetch); an edit typed within 700ms of
// switching is not dropped.
describe.skip("BASED-CONN-SWITCH-CACHE: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-LANCE-FOLDER-BROWSE (canonical spec: specs/based/spec.md)
// Verification: manual — Browse button next to the LanceDB Local directory-path field opens a native
// folder picker and fills the field; the button is absent in Cloud mode.
describe.skip("BASED-LANCE-FOLDER-BROWSE: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-LANCE-SQL-GATING (canonical spec: specs/based/spec.md)
// Verification: manual — local Lance connections show the "+" new-query button and run real SQL
// (cross-folder JOINs, vector cells as vec[dim]); the table SQL sub-view generates double-quoted
// folder.main.table (never [dbo]); Cloud connections show neither; offline first-use surfaces the
// extension-download error in the Output pane without breaking browse/search.
describe.skip("BASED-LANCE-SQL-GATING: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-LSP-MSSQL-NATIVE (canonical spec: specs/based/spec.md; supersedes BASED-LSP-MSSQL —
// the sqls bridge is deleted)
// Verification: manual — an Entra-auth MSSQL connection now gets schema-aware completions in the
// editor (previously the degraded word-based path); a sql-login connection behaves identically
// (one code path); the integration + unit coverage lives in integration.lsp.test.ts /
// unit.mssqlLspContext.test.ts.
describe.skip("BASED-LSP-MSSQL-NATIVE: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-LSP-UI (canonical spec: specs/based/spec.md)
// Verification: manual — completions/hover work on both engines' query tabs; stopping core leaves
// the editor fully functional with Monaco built-ins and completions return after restart (backoff
// reconnect); Cloud Lance opens no LSP socket.
describe.skip("BASED-LSP-UI: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-CHAT-ACTIVITY (canonical spec: specs/based/spec.md)
// Verification: manual — while a Capi run is in flight the rail shows a live abbreviated AG-UI event
// feed (Thinking → tool name) with a spinner on the active step and a baseline "Working…" spinner
// when busy before the first event; settled backend tool calls render as expandable rows (name +
// one-line arg hint collapsed; full JSON args + result when opened); the live feed shows only the
// current run's activity and resets on send / New chat.
describe.skip("BASED-CHAT-ACTIVITY: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-AI-PROVIDER-WIRED (canonical spec: specs/based/spec.md)
// Verification: manual — the profile form's fields are per-kind (endpoint required for
// openai-compatible/azure, optional for openai/anthropic; deployment required for azure); a profile
// pointed at a live openai / azure-openai / anthropic backend with a real key streams a chat turn.
describe.skip("BASED-AI-PROVIDER-WIRED: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-AI-PROFILE-PARAMS (canonical spec: specs/based/spec.md)
// Verification: manual — the profile form's "Model parameters (JSON)" textarea rejects invalid JSON
// with an inline error (Save disabled); a saved reasoning_effort observably changes the request the
// model backend receives (e.g. LM Studio server log shows reasoning_effort in the request body).
describe.skip("BASED-AI-PROFILE-PARAMS: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-AI-PROFILE-TIMEOUT (canonical spec: specs/based/spec.md)
// Verification: manual — the profile form's "Response timeout (seconds)" field, blank showing the
// 900 s default in its placeholder.
// 1. Settings → Agent → edit the ACTIVE profile → set Response timeout to 5 → Save
// 2. Ask Capi something a slow local model can't answer within 5 s → the run aborts and
//    "The request timed out. Please try again." appears (no chat remount was needed for the new
//    value to take effect)
// 3. Edit the same profile → set 1800 → Save → ask again → the answer streams to completion even
//    if the model sits silent for several minutes before its first token
// 4. Clear the field → Save → reopen the profile → the field is blank and the placeholder shows the
//    default (the stored value was removed, not zeroed)
describe.skip("BASED-AI-PROFILE-TIMEOUT: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-HISTORY-UI (canonical spec: specs/based/spec.md)
// Verification: manual — left-rail Objects | History toggle (persisted); History panel with
// Queries + Agent sub-tabs scoped to the active connection, search + status chips, inline expand
// with Insert / Open in new tab / Copy; Agent sub-tab read-only (no re-run affordance).
describe.skip("BASED-HISTORY-UI: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-GRID-SORT (canonical spec: specs/based/spec.md)
// Verification: manual — results-grid header click cycles asc (▲) → desc (▼) → none; NULLs first
// asc / last desc; Copy/CSV/Excel reflect the sorted view; truncation banner notes fetched-rows-only.
describe.skip("BASED-GRID-SORT: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-GRID-FILTER (canonical spec: specs/based/spec.md)
// Verification: manual — header menu icon opens the filter popover at the header; typing narrows
// rows live; the "N of M rows · Clear filters" chip row is correct; filters compose with sort and
// are WYSIWYG for copy/export.
describe.skip("BASED-GRID-FILTER: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-TABLE-FILTER-UI (canonical spec: specs/based/spec.md)
// Verification: manual — Data-tab header click cycles server-side sort (▲/▼, reload from page 1);
// header menu filter (mini-language → structured TableFilter) reloads debounced; "filtered · clear"
// chip; pending edits block sort/filter with an inline notice; LanceDB headers stay non-interactive.
describe.skip("BASED-TABLE-FILTER-UI: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-TABLE-DETAILS-UI (canonical spec: specs/based/spec.md)
// Verification: manual — Details sub-view sections (Indexes / Foreign keys / Constraints /
// Triggers, omitted when empty) + table DDL block with a copy-to-clipboard icon button (flashes ✓,
// pastes the full CREATE statement); Script ▾ dropdown on table/view and routine tabs opens
// generated DDL in a new query tab; absent on LanceDB.
describe.skip("BASED-TABLE-DETAILS-UI: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-UI-SCRIPT-AS (canonical spec: specs/based/spec.md)
// Verification: manual — ctrl/shift multi-select within a group (type-homogeneous), right-click
// "Script as" menu scripts the whole selection into one GO-separated query tab; LanceDB shows
// only Open actions.
describe.skip("BASED-UI-SCRIPT-AS: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-EXPLORER-ACTION (canonical spec: specs/based/spec.md)
// Verification: manual — settings General tab "Double-click opens" selects drive the explorer's
// double-click (details/data/sql/script-create for tables; details/script-create for routines);
// engines lacking a capability degrade to details; persists across restart.
describe.skip("BASED-EXPLORER-ACTION: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-IMPORT-CSV-UI, BASED-DIALOG-OPEN-FILE (canonical spec: specs/based/spec.md)
// Verification: manual — Data-tab "Import CSV" stepper: native file dialog → auto-mapped columns
// with NOT-NULL warnings → coerced preview with per-cell error highlighting → NDJSON progress +
// row-error list → summary and grid reload; absent on views / PK-less tables / LanceDB.
describe.skip("BASED-IMPORT-CSV-UI: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-DIAGRAM-UI (canonical spec: specs/based/spec.md)
// Verification: manual — diagram tab (left-rail button beside the schema filter / explorer
// context menu): React Flow table nodes with ⚿/⚷ glyphs, smoothstep FK edges with a detail card
// on selection, scope select refetches, >300-table guard, persists/restores; absent on LanceDB.
describe.skip("BASED-DIAGRAM-UI: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-AGENT-TAB-TOOLS, BASED-AGENT-THREADS (canonical spec: specs/based/spec.md)
// Verification: manual — per-tab chat threads (switching tabs flips the conversation; restart
// restores each tab's history; close deletes owned-and-unaliased threads; New chat clears only the
// current tab's thread, detaching on an agent-opened alias); workspace context in every send;
// list_tabs/get_tab read other tabs; open_query_tab lands user-facing results in a real grid tab
// aliased to the conversation that created it; a mid-run tab switch defers with a banner.
describe.skip("BASED-AGENT-TAB-TOOLS: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-CHAT-UI (canonical spec: specs/based/spec.md)
// Verification: manual — the chat rail renders each turn once. A multi-round tool run (e.g. "exercise
// every query tool") streams several text segments under one repeated message id, so with the browser
// console open there must be no "two children with the same key" warning, no "Maximum update depth
// exceeded", and no narration paragraph or tool card appearing twice.
describe.skip("BASED-CHAT-UI: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-CHAT-TRANSCRIPT-UI (canonical spec: specs/based/spec.md)
// Verification: manual — the chat header's Download transcript button: disabled on an empty thread
// and while streaming; pops the native Save As dialog with a based-chat-<timestamp>.md default;
// cancel writes nothing; saving yields a markdown file with every turn INCLUDING the reply that is
// not yet flushed to agent.db, headed by the tab title, with no tool-call JSON. The formatter and
// the endpoint behind it are covered executably (unit.transcript, integration.server).
describe.skip("BASED-CHAT-TRANSCRIPT-UI: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-AGENT-IMPORT (canonical spec: specs/based/spec.md)
// Verification: manual — agent import_csv approval card: file+columns inspected, mapping resolved
// (explicit / header-name / positional) and previewed with unmapped warnings; Approve drives the
// existing NDJSON import run with live progress; Reject runs nothing; read-only connections and
// bad mappings invalidate the card before Approve is offered.
describe.skip("BASED-AGENT-IMPORT: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-EMBED-UI (canonical spec: specs/based/spec.md)
// Verification: manual — Embeddings sub-view on vector tables: animated UMAP layout, 2D/3D toggle,
// cluster tints + fading labels, legend chips, hover/click details, find-similar, lasso → grid,
// AI labeling, live theme recolor, worker survives sub-view switches and dies with the tab.
describe.skip("BASED-EMBED-UI: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-GRID-EXPORT-STANDARD (canonical spec: specs/based/spec.md)
// Verification: manual — every data grid (SQL results, Data tab, embeddings Selection) shows the
// same toolbar action set (Fit columns / Copy / Copy as Markdown / Save as CSV / Open in Excel),
// all controls at one height; notices ("Copied", "Saved …") surface in the toolbar for both
// toolbar- and context-menu-triggered actions.
describe.skip("BASED-GRID-EXPORT-STANDARD: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-GRID-CONTEXT-MENU (canonical spec: specs/based/spec.md)
// Verification: manual — right-click a cell in any grid → Copy / Copy as Markdown / Save as CSV /
// Open in Excel at the mouse position; right-click outside the selection moves it first; file
// exports scope to the selection when one exists; header right-click opens the sort/filter menu
// (Data tab keeps its pending-edits gate); Escape/outside click closes.
describe.skip("BASED-GRID-CONTEXT-MENU: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-TAB-AUTONAME-APPLY (canonical spec: specs/based/spec.md)
// Verification: manual — after a query tab's first successful run, a default "Query N" title is
// replaced by a name derived from the executed SQL ("select Customers"); later runs, errored
// runs, file-backed tabs, and manually renamed tabs keep their titles.
describe.skip("BASED-TAB-AUTONAME-APPLY: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-LANCE-CONN-DEFAULT-PROFILES (canonical spec: specs/based/spec.md)
// Verification: manual (UI half; the resolution/persistence/sweep half is covered by
// integration.storage, integration.lancedb, and integration.server) — a LanceDB connection's
// embedding + reranker pickers persist and prefill (only on a new connection, only when exactly one
// embedding profile exists); the Data tab's search dropdowns seed from the connection but honor an
// explicit "none"; editing the connection applies without reconnecting.
describe.skip("BASED-LANCE-CONN-DEFAULT-PROFILES: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-EDITOR-VIM (canonical spec: specs/based/spec.md)
// Verification: manual (the persistence half rides integration.settings) — Settings → General →
// Editor keymap = Vim gives the query editor modal editing with a block caret; the mode and the `:`
// command line render in the app's bottom status bar; `:w` saves the tab and `:q` closes it; F5 /
// Ctrl+Enter / Ctrl+S keep working in every mode; toggling back to Default restores plain typing
// with the buffer and undo history intact.
describe.skip("BASED-EDITOR-VIM: manual verification", () => {
  it.todo("see spec.md procedure");
});
