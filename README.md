# based

AI-first SQL Server client. TypeScript end-to-end: Electrobun shell (thin, disposable), Bun core server (all logic, all secrets), React webview ("The Ledger"). See [.claude/plans/feasibility-and-architecture.md](.claude/plans/feasibility-and-architecture.md) for the architecture and [specs/based/spec.md](specs/based/spec.md) for the canonical requirements.

## Layout

- `core/` — Bun server: mssql adapter (tedious in-process, Entra auth), REST + NDJSON query streaming + SSE on `127.0.0.1:<port>` with a per-launch token, storage (`bun:sqlite` in `%APPDATA%/based/app.db`), secrets in Windows Credential Manager, CSV/XLSX export
- `ui/` — React + Vite webview: connection rail, object explorer, Monaco SQL tabs (3 resizable panes), virtualized results grid, output pane
- `shell/` — Electrobun app: starts core in-process, points a window at it
- `specs/` — spec-driven requirements (`BASED-*`) + tests
- `spikes/` — Phase 0 validation spikes (spike 3, Entra interactive, still awaits a human run)

## Commands

```sh
bun install               # workspace install
bun test                  # from specs/: unit + integration (integration self-skips without az login)
bun run dev:core          # core on 127.0.0.1:7042, token "dev"
bun run dev:ui            # Vite on 5183, proxies /api to core  → browser dev loop
bun run build:ui          # ui/dist
bun run shell             # Electrobun window (serves ui/dist; run build:ui first)
bun run typecheck
```

Phase 1 (classic core) is complete — see `specs/based/archive/phase1-classic-core.md`. Phase 2 is Margin Chat (Mastra agent + AG-UI in the right rail).
