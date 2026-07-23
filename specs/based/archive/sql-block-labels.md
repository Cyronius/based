# SQL block labels: purpose comment + first line

## Context

The Capi chat rail extracts ```sql fences from assistant messages into Insert/Run affordances, but labels them only "sql 1", "sql 2" (`ui/src/components/CapiChat.tsx:42`). With several proposed statements the user can't tell which is which without scrolling the markdown. Fix in two halves:

1. Instruct the agent to lead every ```sql fence with a one-line `--` comment stating the statement's purpose.
2. Render that comment (plus the first line of actual SQL) as the block's label instead of "sql N".

## Changes

### 1. Agent instruction — `core/src/agent/tools/mssql.ts:22`

Amend the last `MSSQL_PERSONA` bullet:

```
- Put every SQL statement in its own \`\`\`sql fenced code block so the user can insert or run it with one click. Make the first line of each block a single-line comment (\`-- ...\`) briefly stating what the statement does — the UI shows it as the block's label.
```

No other instruction site: `instructionsStore.ts` imports the constant, so the virtual default set picks this up automatically (user-saved custom sets keep their own text — expected).

### 2. Parser — new pure module `ui/src/lib/sqlBlocks.ts`

Move/extend `extractSql` from `CapiChat.tsx:21-31` into an exported pure function so it's unit-testable (no React/streamdown imports):

```ts
export interface SqlBlock {
  sql: string;          // full fence content, comment included (Insert/Run use this)
  label: string | null; // text of leading `-- ...` comment, `--` stripped, trimmed
  firstLine: string;    // first non-empty, non-`--`-comment line of the SQL
}
export function parseSqlBlocks(md: string): SqlBlock[]
```

Same fence regex as today. `label` comes only from the *first* line of the block; additional leading comments stay in `sql` but aren't used. If the block is all comments, `firstLine` falls back to the raw first line.

### 3. Rendering — `ui/src/components/CapiChat.tsx` (`SqlActions`, lines 33-53)

Per block, replace the single "sql N" row with:

- Row 1: label — the comment text if present, else the current `sql N` fallback (old messages / non-compliant model) — in the existing `ledger-label text-faint` style, `truncate`, followed by the Insert / Run buttons.
- Row 2: `firstLine` in mono, faint, `truncate` (the rail is narrow; both lines truncate with ellipsis).

Insert/Run behavior unchanged — they still receive the full `sql` (comment included, which is also useful in the editor).

## Spec impact (specs/based/spec.md)

- **New requirement `BASED-CHAT-SQL-LABELS`** (Applies to: based (ui + core); Test category: `unit`): parser behavior + persona instruction. Acceptance criteria:
  - Fence `-- Add covering index\nCREATE INDEX ...` → `label: "Add covering index"`, `firstLine: "CREATE INDEX ..."`
  - Fence with no leading comment → `label: null`, `firstLine` = first non-empty line
  - Multiple fences → one block each, order preserved; `sql` retains the comment line
  - `MSSQL_PERSONA` contains the leading-comment instruction
- **Amend `BASED-CHAT-UI`** (line 669, manual): label text = leading comment + first SQL line, "sql N" fallback; add a verification step ("Ask for SQL → block shows the agent's purpose comment and first statement line").
- Doctrine housekeeping: drop this plan into `specs/based/plans/` at implementation start, move to `archive/` when done.

## Tests

`specs/based/tests/unit.sqlBlocks.test.ts` (bun test, like existing unit tests):
- `// Traces: BASED-CHAT-SQL-LABELS`
- Import `parseSqlBlocks` by relative path (`../../../ui/src/lib/sqlBlocks`) — pure TS, no ui deps needed; and `MSSQL_PERSONA` from `@based/core` source to assert the instruction text mentions the leading comment.
- Cases mirror the acceptance criteria above. Write red first (module doesn't exist), then implement.

## Verification

1. `cd specs && bun test .` — new unit tests pass, existing suites unaffected.
2. Manual (BASED-CHAT-UI procedure): run the app, ask Capi for SQL (e.g. "give me index creation scripts") → each block shows the purpose comment + first SQL line with Insert/Run; Run still opens a results tab; a legacy thread message without comments still shows the `sql N` fallback.
