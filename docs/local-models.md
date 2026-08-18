# Running based against local models

based ships with **no agent configured** — you add a profile yourself in Settings → Agent before
the agent can run. The point is that your schema and your rows don't have to leave the machine to
get an agent that understands them, and **LM Studio** is a well-tested option for that fully-local
path: OpenAI, Azure OpenAI, and Anthropic work exactly the same way, one profile away, if you'd
rather point at a hosted model.

## Pointing based at a model

Settings (gear) → **Agent** → profiles. A profile carries:

- **Kind** — `openai-compatible` (LM Studio, llama.cpp, vLLM, Ollama's OpenAI shim, any gateway),
  `openai`, `azure-openai`, or `anthropic`.
- **Base URL** and **Model** — the model identifier exactly as the server reports it.
- **Model parameters (JSON)** — merged into the request. Recognized sampling keys (`temperature`,
  `topP`, …) become call settings; anything else is passed through as provider options, so gateway-
  specific knobs like `reasoning_effort` reach the server untouched.
- **Response timeout** — defaults to **900 s**, sized for a slow local GPU rather than a hosted API.
- **Instruction set** — switching profile switches the model *and* the persona together.

API keys go to the OS keychain — Windows Credential Manager, or the macOS login Keychain — never to
the local database.

> If based and the model server are on different hosts — a WSL/Windows split, or another machine on
> your LAN — set the Base URL to that host rather than `localhost`.

## Setting up LM Studio

1. Load a model in LM Studio and start its local server (default `http://localhost:1234`).
2. In based: Settings (gear) → **Agent** → `+` → Kind `openai-compatible`, Base URL
   `http://localhost:1234/v1`, Model = the identifier LM Studio reports. Leave the API key blank —
   LM Studio doesn't check it.

## A reference configuration

Tuned for shared-memory AMD (Radeon 890M), all served from LM Studio's OpenAI-compatible endpoint:

- **Agent model:** Ornith or Qwen 35B with **MTP enabled**, or Gemma 4 26B
- **Embeddings:** Qwen3-Embedding-0.6B
- **Reranker:** Qwen3-Reranker-0.6B — see [Reranking](#reranking) below for the wiring, which is
  more interesting than it looks

With less VRAM, drop the agent model rather than the embedding model. Smaller models work
acceptably: **qwen3.5-9b-mtp** is a reasonable squeeze, though being dense it runs slower than an
a3b-style model of comparable quality.

## What to expect from a small model

The agent loop allows up to 30 tool-calling steps, and a schema audit across a wide database will
use a good number of them. A 4B-class model will get through simple questions ("what tables are
here", "sample this table") but tends to lose the thread on multi-step work. The 26–35B range is
where it starts behaving like a colleague rather than a lookup tool.

Two things help regardless of size:

- **Give it an instruction set.** Settings → Agent → instructions. Telling it your conventions
  (naming, which schemas matter, what "active" means in your domain) is worth more than a larger
  model.
- **Keep the reranker small and local.** Reranking is one request per candidate document, so it is
  latency-bound, not intelligence-bound. A 0.6B cross-encoder is the right tool.

## Embeddings

Embedding profiles (Settings → Search) are configured the same way, and are what based uses to turn
a text query into a vector for LanceDB search, and to compute embeddings on the based side when a
table doesn't have them. The dimension is checked against the target vector column before a search
runs, so a mismatched profile fails with a clear message instead of silently returning nonsense.

## Reranking

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
  locally, but lower the candidate pool if it feels slow.
- **Scores are only comparable within one query.** Don't use a global score cutoff tuned on one
  query for another.
- **If every search errors with "never put yes/no in its top logprobs"**: the GGUF's chat template
  likely has Qwen3 *thinking* enabled, so the first generated token is `<think>` instead of
  yes/no. Use a non-thinking template/conversion of the model.
- **"returned no logprobs"**: the server doesn't support `logprobs` on chat completions — update
  LM Studio, or use the Cohere/TEI api with a rerank-capable server instead.
