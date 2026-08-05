# Plan: validate the model id on model-bearing profiles

**Status:** proposed
**Spec impact:** 1 new requirement (`BASED-MODEL-ID-CHECK`), 1 modified (`BASED-AI-PROVIDER-WIRED` — UI note cross-reference only)

## Problem

An AI provider profile's `model` is a free-text box. `resolveModel` passes it through
verbatim ([`core/src/agent/provider.ts:69`](../../../core/src/agent/provider.ts#L69)), which is
correct — but OpenAI-compatible servers do not reliably reject an unknown model id.

Observed against LM Studio 0.3.x, a profile with `qwen3.6-35b-a3b-mtp@q4_k_m` (an id that blends
two real ids — `qwen3.6-35b-a3b-mtp` has no quant suffix, and the `@q4_k_m` build is `qwen3.5`):

```
request  model: qwen3.6-35b-a3b-mtp@q4_k_m
response model: qwen3guard-gen-0.6b        <- silently substituted, HTTP 200
content:        "Safety: Safe\nCategories"
```

No error anywhere. The user gets a working-looking agent driven by a 0.6B safety classifier.
The same free-text-model-id shape exists on embedding profiles (wrong model → wrong vector space
or a dimension error much later) and on reranker profiles in `openai` mode.

Nothing in based is wrong. What's missing is a way to find out you typed the id wrong.

## Approach

Two additions, one cheap check behind both:

1. **A `Test` button on every profile form that carries a model id.** It lists the endpoint's
   models and reports whether the profile's id is actually there — plus near-misses when it isn't,
   which is what turns "not found" into "you meant `qwen3.6-35b-a3b-mtp`".
2. **The model input becomes a combo box** (`<input list>` + `<datalist>`) fed by that same list,
   so the common case never involves typing an id at all. It stays free text — Azure deployments
   and some gateways have nothing to list.

Deliberately **not** blocking Save on a not-found model: a user editing a profile while the local
server is stopped is normal, and a hard block would make the app unusable offline. Test warns; Save
always saves.

### Why a list check, not a probe completion

A 1-token completion is the only test that proves the whole path end to end, and it returns the
model that actually answered — the exact signal that exposes the substitution. But it forces the
backend to load the model: the probe above took ~100 s wall clock for a 35B MoE. `GET /models` is
instant, needs no VRAM, and would have caught this bug outright. So the list check is the test for
every kind that can list. Azure is the exception — its inference endpoint has no model listing, and
a bad deployment returns a clean `DeploymentNotFound`, so Azure gets the 1-token probe.

## Shared endpoint

`POST /api/model-profiles/test` — one endpoint for all three profile types, since the check is
identical and only the base URL / auth header shape differ.

```
Request:  { kind: ProviderKind, baseUrl: string, model?: string, deployment?: string,
            apiKey?: string, profileId?: string }
Response: { ok: boolean, reachable: boolean, modelFound: boolean | null,
            models?: string[], nearMisses?: string[], answeredAs?: string, error?: string }
```

- `apiKey` omitted/blank + `profileId` present → fall back to the stored Credential Manager key,
  matching the blank-means-keep-stored convention the forms already use.
- `modelFound: null` = "no model id to check" (reachability-only result), not "false".

Per-kind behavior:

| kind | check |
|---|---|
| `openai-compatible`, `openai` | `GET {baseUrl}/models`, bearer key if present |
| `anthropic` | `GET {baseUrl ?? https://api.anthropic.com}/v1/models`, `x-api-key` + `anthropic-version` |
| `azure-openai` | 1-token chat completion against `deployment`; `answeredAs` = the response's `model` |
| embedding / reranker profiles | treated as `openai-compatible` |

A profile with no model id (reranker in `rerank` mode) gets reachability only: any HTTP response
from `GET {baseUrl}/models` counts as reachable, `modelFound: null`.

## Matching rules (the pure part)

`matchModelId(requested, available) -> { found: boolean, nearMisses: string[] }`

Normalize = lowercase, strip a leading `publisher/` segment.

- **found** — some candidate's normalized form equals the requested normalized form.
- **near-miss** — not found, and the candidate either
  - equals the request once an `@quant` suffix is dropped from either side, or
  - is within Levenshtein distance 2 of the request (normalized).
- near-misses capped at 5, exact-ish matches first.

The two rules are what recover both halves of the real mistake: rule 1 surfaces
`qwen3.6-35b-a3b-mtp`, rule 2 surfaces `qwen3.5-35b-a3b-mtp@q4_k_m`.

## Requirement draft

### BASED-MODEL-ID-CHECK: Model-bearing profiles can verify their model id against the endpoint

**Applies to:** based (core, ui)
**Test category:** unit (`matchModelId`); integration (the test endpoint, against a local fixture
server); manual (the form's Test button + model combo box)

Every profile form that carries a free-text model id — AI provider, embedding, and reranker —
shall offer a `Test` action backed by `POST /api/model-profiles/test`, which reports whether the
endpoint is reachable and whether the profile's model id is one the endpoint actually serves.
An unknown model id shall be reported as a failure naming the closest ids the endpoint does serve,
because OpenAI-compatible servers may answer an unknown id with a substituted model and HTTP 200
rather than an error. Model listing shall use `GET {baseUrl}/models` for openai-compatible/openai
(and embedding/reranker profiles), Anthropic's `/v1/models` for anthropic, and — for `azure-openai`,
whose inference endpoint lists nothing — a minimal completion against the deployment, reporting the
model id the response claims. A profile with no model id is checked for reachability only. The model
input shall be a combo box offering the listed ids while remaining free text, since not every
gateway can list. Testing never gates Save: a profile whose backend is unreachable or whose id is
unrecognized still saves.

**Acceptance criteria:**
- `matchModelId("qwen3.6-35b-a3b-mtp@q4_k_m", ["qwen3guard-gen-0.6b", "qwen3.6-35b-a3b-mtp", "qwen3.5-35b-a3b-mtp@q4_k_m"])`
  → `found: false`, `nearMisses` containing both `qwen3.6-35b-a3b-mtp` and `qwen3.5-35b-a3b-mtp@q4_k_m`
- `matchModelId("qwen3.6-35b-a3b-mtp", [... same ...])` → `found: true`, `nearMisses: []`
- Case and `publisher/` prefix are ignored: `matchModelId("GPT-OSS-20B", ["openai/gpt-oss-20b"])` → `found: true`
- An unrelated id yields `found: false` with `nearMisses: []` (no noise)
- `nearMisses` is capped at 5
- Endpoint, fixture server serving a known list: matching model → `{ ok: true, modelFound: true }`;
  unknown model → `{ ok: false, modelFound: false }` with a non-empty `nearMisses` when one exists
- Endpoint, unreachable base URL → `{ ok: false, reachable: false }` with a non-empty `error`,
  not a thrown 500
- Endpoint, profile with no `model` → `{ ok: true, modelFound: null }`
- Blank `apiKey` + a `profileId` with a stored key → the stored key is used (no 401 against a
  key-requiring endpoint)

**Verification procedure (manual):**
1. Settings → Agent → edit a profile pointed at a running LM Studio → the Model field's dropdown
   lists the server's model ids; picking one fills the field
2. Type `qwen3.6-35b-a3b-mtp@q4_k_m` (an id the server doesn't serve) → Test → a failure line
   naming near-misses; Save is still enabled and still saves
3. Pick the suggested real id → Test → success naming the matched id
4. Stop LM Studio → Test → an unreachable-endpoint failure, no dropdown options, Save still works
5. Same on an embedding profile and on a reranker profile in `openai` mode; a reranker profile in
   `rerank` mode (no model id) reports reachability only

### Modified: BASED-AI-PROVIDER-WIRED

Its **UI (manual)** paragraph gains a sentence pointing at `BASED-MODEL-ID-CHECK` for the model
field's combo box and Test action. No behavior change to the requirement itself.

## Files

| File | Change |
|---|---|
| `core/src/models/catalog.ts` | **new** — pure `matchModelId`, plus `listModels(kind, baseUrl, apiKey)` and `probeAzureDeployment(...)`. New dir because all three profile types share it; `core/src/agent/` would be the wrong home. |
| `core/src/server.ts` | **new** `POST /api/model-profiles/test` handler, near the profile CRUD routes (~line 676) |
| `ui/src/api/client.ts` | **new** `testModelProfile(input)` + `ModelTestResult` type |
| `ui/src/components/ThemePicker.tsx` | **new** shared `ModelField` (labelled input + `<datalist>` + Test button + result line), consumed by both `AiProfileForm` (:550) and the generic `ProfileForm` (:414) |
| `specs/based/tests/unit.modelCatalog.test.ts` | **new** — `matchModelId` cases above |
| `specs/based/tests/integration.modelProfileTest.test.ts` | **new** — endpoint driven against a `Bun.serve` fixture returning a fixed `/models` payload (deterministic; no live LM Studio dependency) |
| `specs/based/spec.md` | add `BASED-MODEL-ID-CHECK`; amend `BASED-AI-PROVIDER-WIRED`'s UI note |
| `docs/local-models.md` | note the silent-substitution behavior and point at Test |

UI conventions: `Test` carries a visible text label, so it is a regular `<button className={btnSecondary}>`,
not an `IconButton` (per `CLAUDE.md` — icon-only controls use `IconButton`, labelled ones don't).
No uppercase label text.

## Build order

1. `matchModelId` + its unit test (red → green) — pure, cheapest to get right first
2. `listModels` / `probeAzureDeployment`
3. `POST /api/model-profiles/test` + the fixture-server integration test (red → green)
4. `testModelProfile` in the UI client
5. `ModelField`, wired into `AiProfileForm` and `ProfileForm`
6. Walk the manual procedure against the live LM Studio, including reproducing the original
   `qwen3.6-35b-a3b-mtp@q4_k_m` failure and confirming Test names the right near-misses
7. Merge into `spec.md`, move this plan to `specs/based/archive/`

## Considered and deferred

**Warn at run time when the response's model id ≠ the requested one.** This is the strictly better
signal — it fires on the actual failure, not on a check the user has to remember to run, and it
would catch a substitution that only happens once the model is loaded. Deferred because the value
has to survive Mastra's agent stream and the AG-UI bridge to reach the chat rail, and it isn't yet
established that `response.modelId` is exposed intact along that path. Worth a spike after this
lands; if the id does survive, it becomes a follow-up requirement and the Test button drops to
being the pre-flight convenience it's designed as.

**Blocking Save on a not-found model.** Rejected — breaks editing a profile while its backend is
stopped, which is the normal local-model workflow.
