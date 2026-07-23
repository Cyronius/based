# based

AI-first SQL Server client. TypeScript end-to-end: Electrobun shell (thin, disposable), Bun core server (all logic, all secrets), React webview ("The Ledger"). See [.claude/plans/feasibility-and-architecture.md](.claude/plans/feasibility-and-architecture.md) for the architecture and [specs/based/spec.md](specs/based/spec.md) for the canonical requirements.

## Layout

- `core/` — Bun server: mssql adapter (tedious in-process, Entra auth), REST + NDJSON query streaming + SSE on `127.0.0.1:<port>` with a per-launch token, storage (`bun:sqlite` in `%APPDATA%/based/app.db`), secrets in Windows Credential Manager, CSV/XLSX export
- `ui/` — React + Vite webview: connection rail, object explorer, Monaco SQL tabs (3 resizable panes), virtualized results grid, output pane
- `shell/` — Electrobun app: starts core in-process, points a window at it
- `specs/` — spec-driven requirements (`BASED-*`) + tests

## Commands

```sh
bun install               # workspace install
bun test                  # from specs/: unit + integration (integration self-skips without az login)
bun run dev               # ⭐ full dev loop: core + Vite + native window, all with HMR (see below)
bun run dev:core          # core on 127.0.0.1:7042, token "dev"
bun run dev:ui            # Vite on 5183, proxies /api to core  → browser dev loop
bun run build:ui          # ui/dist
bun run shell             # Electrobun window (serves ui/dist; run build:ui first)
bun run typecheck
```

## Dev loops

Three ways to run the app, fastest-feedback first:

- **`bun run dev`** — one command. [scripts/dev.ts](scripts/dev.ts) starts `dev:core` (watch) and `dev:ui`
  (Vite), waits until both are listening, then launches the shell pointed at Vite
  (`BASED_DEV_URL=http://localhost:5183`) — the **native window with full hot-reload**. Ctrl-C (or closing
  the window) tears all three down. Logs interleave in the one terminal.
- **`bun run dev:core` + `bun run dev:ui`** — same core + Vite, but iterate in a **browser** at
  http://localhost:5183. HMR on every `.tsx` save. The client falls back to token `dev` when there's no URL
  hash, so no auth wiring needed.
- **`bun run shell`** — production-like smoke test: bundles and serves the static `ui/dist`. **No watch, no
  HMR** — run `bun run build:ui` after UI changes or you'll see a stale bundle. Set `BASED_DEV_URL` to point
  this same window at Vite instead (that's what `bun run dev` does under the hood).

Phase 1 (classic core) is complete — see `specs/based/archive/phase1-classic-core.md`. Phase 2 is Ask Capi (Mastra agent + AG-UI in the right rail).
