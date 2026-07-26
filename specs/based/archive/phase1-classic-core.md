# Phase 1 — Classic core ("The Ledger" shell)

> **Status: COMPLETE (2026-07-21).** All requirements implemented and merged into [spec.md](../spec.md).
> Verification: `cd specs && bun test` → 36 pass / 0 fail (unit + integration incl. live Azure SQL dev DB); 9 manual procedures documented.
> End-to-end Playwright smoke against core + built UI (production path, real dev DB): 11/11 — connection dialog + Test Connection (azure-cli), connect, explorer groups, multi-result-set batch (3 sub-tabs), grid/text toggle, syntax-error text in Output, mid-query cancel, tab + content persistence across reload, table details tab, no console errors.
> Not yet exercised: Electrobun shell launch (`bun run shell`, needs a human at the GUI), Entra interactive / SQL-login / service-principal auth (manual procedures in spec.md).

Parent plan: [.claude/plans/feasibility-and-architecture.md](../../../.claude/plans/feasibility-and-architecture.md) (Phase 1 section).
Phase 0 evidence: [../phase0-results.md](../phase0-results.md).

## Spec impact

**New requirements** (all new — spec.md is created by this phase):

- Connections & auth: BASED-CONN-STORE, BASED-SECRET-STORE, BASED-CONN-TEST, BASED-AUTH-AZCLI, BASED-AUTH-INTERACTIVE, BASED-AUTH-SQLLOGIN, BASED-AUTH-SP
- Engine/adapter: BASED-MSSQL-OBJECTS, BASED-MSSQL-COLUMNS, BASED-BATCH-GO, BASED-MULTI-RESULTSET, BASED-CANCEL, BASED-ERROR-TEXT, BASED-RECONNECT-RETRY, BASED-VALUE-SAFETY, BASED-ROWCAP
- Server: BASED-API-AUTH, BASED-HISTORY, BASED-TABSTORE
- Export: BASED-EXPORT-CSV, BASED-EXPORT-XLSX
- UI (manual): BASED-UI-LAYOUT, BASED-UI-CONNECTIONS, BASED-UI-EXPLORER, BASED-UI-TABS, BASED-UI-RESULTS, BASED-UI-OUTPUT

Modified: none. Removed: none.

## Implementation decisions (below the traceability line, recorded for context)

- **Local store = `bun:sqlite`**, not `@libsql/client`, for Phase 1 app data (connections metadata, tabs, history). Zero-dependency, guaranteed under Bun. Mastra `LibSQLStore` arrives in Phase 2 for agent memory (its own tables, same SQLite file family). Same on-disk format; swap is cheap if Phase 2 wants one store.
- **Test runner = `bun test`**, not Vitest: the app runs under Bun and core uses `bun:sqlite`; testing under the production runtime beats the doctrine's default table. Single command: `cd specs && bun test` (`specs/package.json` has the `test` script).
- **Secrets = Windows Credential Manager via `@napi-rs/keyring`** (napi prebuild; Bun napi loading validated by spike 5).
- **Native file dialogs via PowerShell** (`System.Windows.Forms` Save/OpenFileDialog spawned from core) — keeps the Electrobun shell dialog-free, consistent with "the shell is disposable".
- **mssql pinned ^11.x** (spike-proven). 12.x evaluation deferred.
- Row cap default 50,000 rows per result set (truncation surfaced in UI); rows streamed to the UI as NDJSON chunks; cancel via per-query id.
- Azure SQL has no cross-database `USE`; the database selector reconnects the pool to the chosen database on the same server.
- Margin Chat rail, Tools menu (Notes/Execution Plan/Messages), and AI settings are **Phase 2** — the right rail ships as a collapsed placeholder only.

## Verification

Per requirement in spec.md. Integration tests run read-only against the Phase 0 dev DB (configured via `BASED_TEST_SERVER` / `BASED_TEST_DB`) using AzureCliCredential; they self-skip when those aren't set or no `az` login is available. UI behavior is `manual` with documented procedures — no stubs.
