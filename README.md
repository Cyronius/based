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

## Reranking with a local LLM (Qwen3-Reranker via LM Studio)

> Interim home for this doc until the app has real documentation.

Search over a LanceDB table can add an optional **rerank** step: after the vector/FTS/hybrid pass
returns a candidate pool, an external model rescores each `(query, document)` pair and the results
are re-sorted by that score (`_rerank_score`). A reranker reads the query and document *together*
(cross-encoder), which is more accurate than comparing precomputed embeddings (bi-encoder) — and is
why it can't be cached and runs per query.

Reranker profiles (Settings → Search → Reranker profiles) support two API shapes:

- **Rerank endpoint (Cohere/TEI)** — the classic `POST {baseUrl}/rerank {query, documents}` shape.
  Use for Cohere, TEI/Infinity, or `llama-server --reranking` with a classification-head model
  (bge-reranker, or a sequence-classification GGUF conversion of Qwen3-Reranker).
- **OpenAI chat completions (yes/no logprobs)** — for servers with **no** `/rerank` endpoint, like
  LM Studio. This exists because Qwen3-Reranker isn't a classic cross-encoder at all: it's the
  Qwen3-0.6B causal LM prompted to judge "does this document match the query? answer yes or no",
  and the relevance score is read off the logprobs of the first generated token:
  `score = P(yes) / (P(yes) + P(no))`. Any OpenAI-compatible chat endpoint that returns
  `top_logprobs` can therefore act as a reranker — based sends one `max_tokens: 1` request per
  candidate document and computes the score itself.

### Setup (LM Studio)

1. In LM Studio, download and load a **Qwen3-Reranker-0.6B** GGUF as a normal text model, and start
   the local server (default `http://localhost:1234`).
2. In based: Settings (gear) → Search → Reranker profiles → `+` → set API to
   "OpenAI chat completions (yes/no logprobs)", Base URL `http://localhost:1234/v1`, Model = the
   LM Studio model identifier. API key stays empty for LM Studio. The optional Instruction field
   overrides Qwen's default task instruction ("Given a web search query, retrieve relevant passages
   that answer the query") — useful for domain-specific corpora.
3. In a LanceDB connection's Data tab, pick the profile in the search toolbar and run a search.
   Rows come back ordered by `_rerank_score` (0–1).

### Caveats

- **Latency is O(candidates)**: one HTTP call per candidate document (8 in flight at a time). With
  the default 50-candidate pool that's 50 chat completions per search — fine for a 0.6B model
  locally, but lower `sampleSize` if it feels slow.
- **Scores are only comparable within one query.** Don't use a global `floor` cutoff tuned on one
  query for another.
- **If every search errors with "never put yes/no in its top logprobs"**: the GGUF's chat template
  likely has Qwen3 *thinking* enabled, so the first generated token is `<think>` instead of
  yes/no. Use a non-thinking template/conversion of the model.
- **"returned no logprobs"**: the server doesn't support `logprobs` on chat completions — update
  LM Studio, or use the Cohere/TEI api with a rerank-capable server instead.

Phase 1 (classic core) is complete — see `specs/based/archive/phase1-classic-core.md`. Phase 2 is Ask Capi (Mastra agent + AG-UI in the right rail).
