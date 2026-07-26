# Contributing

Issues and pull requests are welcome. based is young and opinionated, so a quick issue describing
what you want to change is usually worth more than a surprise PR. But I'll take those too!

Start with [docs/development.md](docs/development.md) for setup and dev loops.

## Ground rules

```sh
bun run typecheck
bun test
```

Both must pass. Integration tests self-skip without a SQL Server — that's expected and fine.

Match the surrounding code. This codebase has a consistent house style: comments explain *why*, not
*what*, and non-obvious workarounds carry the diagnosis that justifies them. Several files
(`shell/electrobun.config.ts` especially) are load-bearing comment as much as code — read before
editing.

UI conventions are in [CLAUDE.md](CLAUDE.md): no uppercased labels, and any icon-only control uses
the shared `IconButton` so the whole box is the hit target rather than the glyph.

## Spec-driven development

`specs/based/spec.md` is authoritative. Every requirement has an ID (`BASED-*`), an **Applies to**,
a **Test category**, and acceptance criteria.

| Category | Verified by |
|---|---|
| `unit` | A real executable test |
| `integration` | A real executable test, possibly needing a live database |
| `e2e` / `manual` | An implemented feature plus a **documented verification procedure** |

If you change specified behavior, update the spec in the same change. If you add behavior worth
depending on, add a requirement for it.

Tests link back with a trace comment:

```ts
// Traces: BASED-GRID-SORT
```

**Never commit a stub as coverage.** `throw new Error("not implemented")`, an empty body, or
`expect(thing).toBeDefined()` are not tests. The cure for a requirement that's awkward to unit-test
is to classify it `e2e`/`manual` and write the procedure down — not to leave a failing placeholder
that looks like a test in the report.

Don't restructure working code purely to make it unit-testable. If extracting a pure module improves
the design, do it; if it's artificial, leave the logic where it is and verify it as `manual`.

## Commits and PRs

Reference the requirement ID in the commit or PR body when one applies. Keep the working tree
typechecking at every commit — `scripts/release.ps1` refuses to cut a release otherwise.
