# Reranker profiles: OpenAI chat-completions scoring mode (Qwen3-Reranker via LM Studio)

## Context

The external rerank step ([core/src/db/reranker.ts](c:/code/based/core/src/db/reranker.ts)) only speaks the Cohere/TEI shape (`POST {baseUrl}/rerank`). LM Studio has no `/rerank` endpoint, so Qwen3-Reranker can't be used from it today — but Qwen3-Reranker isn't a classification-head cross-encoder anyway; it's the Qwen3-0.6B causal LM scored by a two-token softmax over "yes"/"no" logprobs at the first generated position. Any OpenAI-compatible chat-completions endpoint that returns `top_logprobs` can therefore act as a reranker.

Add a per-profile discriminator `api: "rerank" | "openai"` (undefined = `"rerank"`, legacy). In `"openai"` mode the rerank step sends one chat-completions request per candidate document with Qwen's judging prompt, `max_tokens: 1`, `logprobs: true`, and computes `score = P(yes) / (P(yes) + P(no))`.

Decisions confirmed with user:
- Endpoint: `/chat/completions` (portable; LM Studio, llama-server, vLLM, OpenAI)
- Naming: `api: "rerank" | "openai"`
- Task instruction: **optional per-profile field** `instruction` (default: `"Given a web search query, retrieve relevant passages that answer the query"`)
- Documentation is part of the deliverable: README section + spec (user: "it's not straightforward"; app docs come later)

Known caveats (documented, not blockers):
- O(n) HTTP calls per search (default `sampleSize` 50). Mitigate with a concurrency pool (8) and a README note to lower `sampleSize` with this mode.
- If the GGUF's chat template enables Qwen3 thinking, the first generated token is `<think>` and neither yes nor no appears in `top_logprobs` — detect this (all documents score nothing) and throw a descriptive error naming the likely cause.
- Alternative already served by the existing `"rerank"` api: sequence-classification GGUF conversions of Qwen3-Reranker under `llama-server --reranking`. This feature is specifically for keeping everything in LM Studio.

## Spec impact

Per doctrine, first materialize this plan as `specs/based/plans/rerank-openai-api.md` (archive on completion).

- **Modified: BASED-LANCE-RERANK-PROFILES** — profiles gain `api?: "rerank" | "openai"` (absent = `"rerank"`) and `instruction?: string` (openai mode only). Manual verification gains an LM Studio + Qwen3-Reranker procedure.
- **New: BASED-LANCE-RERANK-OPENAI** (Applies to: based (core); Test category: integration) — openai-mode scoring semantics. Acceptance criteria:
  - One `POST {baseUrl}/chat/completions` per document: system prompt = Qwen judge instruction, user = `<Instruct>: …\n<Query>: …\n<Document>: …`, body has `model`, `max_tokens: 1`, `temperature: 0`, `logprobs: true`, `top_logprobs: 20`; `authorization: Bearer` when the profile has a key
  - Score = `pYes / (pYes + pNo)` summing all case/whitespace variants of "yes"/"no" in `top_logprobs`; "no" absent → score = `pYes`; neither present → 0
  - Results reorder by `_rerank_score` exactly as the `"rerank"` api does (same `RerankResult` shape)
  - `rerankerOptions.topN` truncates the scored list to the top N (Cohere `top_n` semantics); `temperature` run-option is a documented no-op in this mode
  - Every document scoring "neither yes nor no in top_logprobs" → descriptive error mentioning logprobs support / thinking-enabled chat template
  - Profile `instruction` overrides the default instruct line

## Changes

### Core

1. **[core/src/db/types.ts](c:/code/based/core/src/db/types.ts:260)** — add `export type RerankerApi = "rerank" | "openai"`; add `api?: RerankerApi` and `instruction?: string` to `ResolvedRerankerProfile`. Update `RerankerRunOptions.temperature` doc comment (no-op in openai mode).

2. **[core/src/storage/rerankerProfiles.ts](c:/code/based/core/src/storage/rerankerProfiles.ts:4)** — add `api?: RerankerApi`, `instruction?: string` to `RerankerProfile`. JSON-blob storage → no migration; legacy rows deserialize with `api` undefined.

3. **[core/src/db/searchProfileResolve.ts](c:/code/based/core/src/db/searchProfileResolve.ts:27)** — `resolveRerankerProfile` passes `api` and `instruction` through to the resolved profile.

4. **[core/src/db/reranker.ts](c:/code/based/core/src/db/reranker.ts)** — the real work. `rerank()` dispatches on `profile.api ?? "rerank"`; existing body becomes `rerankCohere()`. New `rerankOpenAi(profile, query, documents, opts)`:
   - Constants: `DEFAULT_INSTRUCTION`, system prompt `Judge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".`
   - Per document: `POST {baseUrl}/chat/completions` with `{model, messages: [system, user], max_tokens: 1, temperature: 0, logprobs: true, top_logprobs: 20}`; user content `<Instruct>: {instruction}\n<Query>: {query}\n<Document>: {doc}`
   - Parse `choices[0].logprobs.content[0].top_logprobs` (array of `{token, logprob}`). Sum `exp(logprob)` across tokens whose `token.trim().toLowerCase()` is `"yes"` / `"no"`. Score per acceptance criteria above.
   - Small worker-pool (concurrency 8) over documents; keep `{index}` pairing.
   - `opts.topN`: sort desc, slice — mirrors what the Cohere endpoint does server-side.
   - Errors: non-OK → same message style as today; response missing `logprobs.content` → "endpoint returned no logprobs — the server may not support logprobs"; all documents with neither token → error suggesting a non-thinking chat template / correct model.
   - Extract the top_logprobs → score math as an exported pure helper (e.g. `scoreFromTopLogprobs(entries): number`) so the math is unit-assertable without HTTP; the integration test still covers the wire path.

5. **Adapter/server/agent tools** — no changes. [lanceAdapter.ts:509](c:/code/based/core/src/db/lanceAdapter.ts#L509) already calls `rerank()` generically; agent tools and the `/api/session/lance-search` route pass profile ids through `resolveRerankerProfile`.

### UI

6. **[ui/src/api/types.ts](c:/code/based/ui/src/api/types.ts:288)** — mirror `api`/`instruction` on `RerankerProfile` (+ inherited by `RerankerProfileInput`).

7. **[ui/src/components/ThemePicker.tsx](c:/code/based/ui/src/components/ThemePicker.tsx:331)** — reranker profile form gains:
   - An API `<select>` (reuse the `field` styling / AiProfileForm's provider-kind select pattern): options **"Rerank endpoint (Cohere/TEI)"** (`rerank`) and **"OpenAI chat completions (yes/no logprobs)"** (`openai`). No uppercase labels.
   - When `openai` selected: an "Instruction (optional)" input, placeholder showing the default instruction; and `model` becomes required (LM Studio needs it; the yes/no trick is model-specific), so extend the `canSave` logic.
   - Mechanically: add an optional `extra?: ReactNode` slot to `ProfileForm` (rendered between model and API-key inputs) plus an optional `modelRequired` override from the caller — the select/instruction inputs live at the two reranker call sites (`editingRerankId === p.id` and `"new"` branches), keeping `ProfileForm` generic. Update `emptyRerankerForm` with `api: "rerank"`, `instruction: ""`.
   - Save path: strip empty `instruction` to undefined so legacy-shaped blobs stay clean.

### Tests (TDD: write failing first)

8. **specs/based/tests/integration.lancedb.test.ts** — new `BASED-LANCE-RERANK-OPENAI` tests following the existing fake-`Bun.serve` rerank pattern (line ~196):
   - Fake `/chat/completions` handler scores each document deterministically from its content (e.g. logprob of "yes" derived from "oranges" count, " no" variant token included) → assert reorder by `_rerank_score`, score values ≈ expected softmax, request shape (`max_tokens`, `logprobs`, `top_logprobs`, `temperature: 0`, model, Bearer header), one request per document, `topN` truncation, `instruction` override appearing in the user message.
   - A response with "no" absent from top_logprobs → `pYes` fallback ordering still correct.
   - A `<think>`-style response (neither token present, all docs) → descriptive error.
   - Unit-style assertions on the exported `scoreFromTopLogprobs` can live in the same file or `unit.*` per existing conventions.
   - ⚠️ This file contains a raw `\0` byte (~offset 2284) — Grep treats it as binary; use `rg -a`/sed for searching, and plain `Edit` for changes (verified sed reads it fine as UTF-8).

### Documentation (explicit deliverable)

9. **[README.md](c:/code/based/README.md)** — new section **"Reranking with a local LLM (Qwen3-Reranker via LM Studio)"**:
   - What a reranker is and why it's a separate step from embedding (2–3 sentences, cross-encoder vs bi-encoder in one line)
   - Why the `openai` api mode exists: LM Studio exposes no `/rerank`; Qwen3-Reranker is a causal LM whose score is `P("yes")` vs `P("no")` at the first generated token, readable via chat-completions `logprobs`
   - Setup walkthrough: load `Qwen3-Reranker-0.6B` (GGUF) in LM Studio → Settings → Search → Reranker profiles → Add → api = "OpenAI chat completions", baseUrl `http://localhost:1234/v1`, model = the LM Studio model id → select the profile in the Data tab's search toolbar
   - Caveats: one request per candidate (lower `sampleSize` for latency); scores only comparable within one query (don't set global `floor` cutoffs across queries); if every result scores 0 / errors, the GGUF's chat template likely has thinking enabled — use a non-thinking template/conversion; the classic `"rerank"` api remains right for bge-reranker/TEI/`llama-server --reranking`
   - One line noting app documentation is future work and this section is the interim home

10. **specs/based/spec.md** — apply the Spec impact section above (modify RERANK-PROFILES, add RERANK-OPENAI with acceptance criteria + the LM Studio manual procedure).

## Verification

1. `cd specs && bun test specs/based/tests/integration.lancedb.test.ts` — new RERANK-OPENAI tests red first (no dispatch), green after; existing RERANK-PIPELINE tests stay green (legacy `api` undefined path untouched).
2. `bun run typecheck`.
3. Manual (spec procedure): `bun run dev` → gear → Search tab → create an `openai`-api profile against LM Studio running Qwen3-Reranker-0.6B → Data-tab search on a LanceDB table → rows carry `_rerank_score` in (0,1) and order changes vs. native score; blank-key edit keeps stored key; legacy profile still hits `/rerank`.
