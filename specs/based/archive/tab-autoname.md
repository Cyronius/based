# Plan: Auto-name query tabs after first successful run

## Spec impact

**New requirements:** BASED-TAB-AUTONAME-DERIVE (unit), BASED-TAB-AUTONAME-APPLY (manual).
No modified or removed requirements.

## Context

Query tabs are only ever named `Query N` (`nextQueryTitle`, ui/src/store.ts). After a
statement runs, the tab should get a deterministic, content-derived name.

Decision: **no AST parser**. Targets are T-SQL and DuckDB; JS AST parsers fail on common
valid T-SQL (APPLY, hints, temp tables, MERGE), so a heuristic fallback would be needed
anyway. Instead, extend the tokenizing approach proven in `core/src/db/classify.ts` into a
pure extractor.

**Policy:** name once, on the tab's first successful run (`status === "ok"`), and only while
the title still matches `/^Query \d+$/` — file-backed tabs and manually renamed tabs never
match, and after one rename the title no longer matches, so it freezes naturally with no new
state field.

**Format:** lowercase verb + object: `select Customers`, `update Users`,
`exec usp_RebuildIndexes`; verb alone when no object is found.

## Implementation

1. `ui/src/lib/deriveTabTitle.ts` — pure `deriveTabTitle(sql): string | null`. Mirrors (not
   imports) the comment/string strippers from `core/src/db/classify.ts` per the ui/core
   mirroring convention. Paren-depth-aware tokenizing: verb = first keyword (skipping a CTE
   list after `WITH`); object per verb (SELECT/DELETE → depth-0 `FROM`, INSERT/MERGE →
   `INTO`, UPDATE → next identifier skipping `TOP (n)`, EXEC → next identifier skipping
   `@var =`, CREATE/ALTER/DROP/TRUNCATE/BACKUP → skip object-type keywords then identifier).
   Identifier = last dotted segment, brackets/quotes stripped.
2. Wire into `runQuery`'s `case "done"` in `ui/src/store.ts`: on `status === "ok"`, if title
   matches `/^Query \d+$/` and tab has no `filePath`, set title to the derived name (keep old
   title when derivation returns null). The executed SQL is `tab.content` captured at run
   start.
3. Tests: `specs/based/tests/unit.deriveTabTitle.test.ts` (bun test), written failing-first.
4. Manual procedure for BASED-TAB-AUTONAME-APPLY in `specs/based/tests/manual.ui.test.ts`.
5. Add both requirements to `specs/based/spec.md`; archive this plan.
