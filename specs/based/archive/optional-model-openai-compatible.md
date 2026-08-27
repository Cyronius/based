# Optional model name for openai-compatible AI profiles

## Motivation

Local single-model servers (LM Studio, llama.cpp server) don't need a `model` in the request
body — LM Studio uses the currently loaded model when the field is *absent*, llama.cpp ignores
it entirely. The profile form currently requires it for every non-Azure kind
([ThemePicker.tsx:531](../../../ui/src/components/ThemePicker.tsx#L531)), which is friction for
exactly the local-server case the `openai-compatible` kind exists for.

The requirement stays for `openai` and `anthropic` kinds: those APIs reject a request without a
model. Many openai-compatible backends (Ollama, vLLM, OpenRouter, Groq) also require it — so the
field stays present and recommended; only the *required* gate is dropped, and only for
`openai-compatible`.

## Key mechanism

Blank model must mean the `model` field is **omitted from the request body**, not sent as `""`.
The AI SDK always serializes the modelId into the body, and LM Studio's "use the loaded model"
default applies only when the field is absent — `model: ""` risks a model-not-found lookup.
Implementation: `resolveModel`'s `openai-compatible` branch passes a wrapping `fetch` to
`createOpenAICompatible` when `config.model` is blank, which deletes an empty `model` key from
the JSON request body. The body transform is an exported pure helper so it's unit-testable.

## Spec impact

**Modified: BASED-AI-PROVIDER-WIRED**
- UI note: per-kind field requirements gain "model required for `openai` / `anthropic`, optional
  for `openai-compatible` (blank = server's loaded/default model) and `azure-openai` (deployment
  runs)".
- New acceptance criteria (test category: unit):
  - `openai-compatible` with blank model still resolves to a model
  - the body transform removes an empty `model` key and leaves a non-empty one untouched

No new or removed requirements. Server side needs no change (`POST /api/ai-profiles` never
validated `model`). Embedding profiles keep model required (an embeddings request without a model
id has no equivalent single-model convention worth relying on for vector dimensions); reranker
profiles already treat it as optional.

## Changes

1. `specs/based/tests/` — unit test (red first) for the exported body-transform helper in
   `core/src/agent/provider.ts`: strips `model: ""`, preserves `model: "x"`, preserves other keys.
   Traces: BASED-AI-PROVIDER-WIRED.
2. [core/src/agent/provider.ts](../../../core/src/agent/provider.ts) — export the helper; in the
   `openai-compatible` branch, when `config.model.trim()` is empty pass a custom `fetch` that
   applies it to the outgoing body.
3. [ui/src/components/ThemePicker.tsx](../../../ui/src/components/ThemePicker.tsx) — `canSave`:
   model required only for `openai` / `anthropic`; placeholder for `openai-compatible` becomes
   "Model (optional — blank uses the server's loaded model)".
4. `specs/based/spec.md` — BASED-AI-PROVIDER-WIRED edits above.

Profile list rows already fall back (`p.model || p.deployment || p.baseUrl`), so a blank model
displays fine.

## Verification

- Unit test above via `npm test` in `specs/`.
- Manual: profile with kind openai-compatible, blank model, LM Studio base URL → Save enabled,
  chat turn streams against the loaded model; the request LM Studio logs has no `model` field.

## Rider (same PR)

**Modified: BASED-AI-PROVIDER-PROFILES** — saving a *new* AI profile activates it immediately
(`AiProfileEditor.onSave` calls `setActiveAiProfile` when creating); edits never change the
active profile. Manual verification via the requirement's procedure.

## Delivery

Branch `optional-model-name` off `main`, PR into `main`.
