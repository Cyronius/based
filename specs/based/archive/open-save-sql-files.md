# Open / Save As for .sql files

## Spec impact

- **New requirement:** BASED-FILE-OPEN-SQL (open a .sql file into a query tab; endpoint integration-tested, UI manual)
- **Modified requirement:** BASED-UI-TABS (Save As verification step; Ctrl+Shift+S)

## Context

Save already works end-to-end: Ctrl+S (global in `App.tsx`, Monaco command in `EditorPane.tsx`) and the toolbar Save button call `saveTab` (`ui/src/store.ts`) → `POST /api/file/save-sql` (`core/src/server.ts`) → native PowerShell SaveFileDialog (`core/src/dialogs.ts`) → writes file, sets `filePath`/`title`, clears `dirty`. `filePath` is persisted with the tab (TabStore).

What's missing:
1. **Open** — no endpoint reads a .sql file, no store action, no UI entry point. The native open dialog (`openFileDialog`) and `filterFor("sql")` already exist (used for CSV import).
2. **Save As** — once a tab has a `filePath`, Ctrl+S silently overwrites; there's no way to re-dialog. BASED-UI-TABS already says "Save/Save-As".

## Changes

### 1. Core: `POST /api/file/open-sql` — `core/src/server.ts` (next to `/api/file/save-sql`)

Body `{ path?: string }`. If no `path`, pop `openFileDialog(filterFor("sql"))` (dialog cancelled → `{ path: null }`). Read the file with `Bun.file`; missing file → `{ error }` 400. Return `{ path, content }`. The explicit-`path` mode mirrors save-sql's dialog bypass and makes the endpoint integration-testable.

### 2. Store: `openSqlFile()` + Save As — `ui/src/store.ts`

- `openSqlFile(): Promise<void>`: guard `capabilities && !capabilities.sql`; call the endpoint; `path: null` → no-op; a tab already open with the same `filePath` → activate it; else build the tab like `newQueryTabWithContent` with `filePath` set and `dirty: false`; `persistTabsSoon()`.
- `saveTab(id, opts?: { as?: boolean })` — `as: true` sends no `path` (always dialogs), `defaultName` from current file name or title.

### 3. UI entry points

- `App.tsx` global keybindings: Ctrl+O → `openSqlFile()` (gated on `activeConnectionId`); Ctrl+Shift+S → `saveTab(tab.id, { as: true })`; plain Ctrl+S now requires `!e.shiftKey`.
- `EditorPane.tsx`: Monaco commands for Ctrl+Shift+S and Ctrl+O mirroring Ctrl+S.
- `QueryTabView.tsx` toolbar: "Open…" button before Save, "Save As…" after Save.

### 4. Tests

Integration round-trip in `specs/based/tests/integration.server.test.ts`: save-sql to a temp path → open-sql returns the same content; open-sql on a nonexistent path → 400. `// Traces: BASED-FILE-OPEN-SQL`.
