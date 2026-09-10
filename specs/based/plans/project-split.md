# Project split: core, open-source frontend, based.ai

Written 2026-09-10. Phase 1 of the based.ai roadmap; later phases are sketched at the end so the split is made with them in view.

**Status:** Phase 1 implemented 2026-09-10 on branch `project-split`. Private repo `Cyronius/based-ai` created and linked. Still open: confirm the `@based` npm scope (`npm publish --dry-run` from `core/` once logged in) and add the `NPM_TOKEN` repo secret before the next tag. Phases 2 to 7 remain.

## Spec impact

New requirements: `BASED-PKG-BOUNDARIES` (unit), `BASED-PRIVATE-GUARD` (unit), `BASED-CORE-PUBLISH` (manual).
Modified: `BASED-RELEASE-CI` gains an npm publish job.
Removed: none.
Everything else in this plan is packaging and repo layout with no behavior change.

## Shape

Two git repos, three buildable projects.

| Project | Where | Visibility | Depends on |
|---|---|---|---|
| core (`@based/core`) | `based/core/` (this repo) | public, MIT | nothing in-repo |
| frontend (`@based/ui`) | `based/ui/` (this repo) | public, MIT | nothing in-repo (HTTP only) |
| based.ai | `C:\code\based-ai\` (new repo, sibling directory) | private | `@based/core` from npm |

`shell-tauri/` stays in this repo as the desktop packaging of core plus ui. `specs/` stays as the home of `BASED-*` requirements and tests.

**Why core stays in this repo for now.** Most desktop work touches core and ui together. Moving core to its own repo turns every such change into a publish-and-bump cycle before ui can see it. Revisit once based.ai's release cadence diverges from the desktop app's; the boundary check below keeps the extraction cheap whenever that happens.

**Why the paid piece is not a directory in this tree.** A gitignored or nested-repo directory is one `git add --force`, one stray `git add .` gitlink, or one badly written ignore rule away from leaking. A sibling directory cannot be committed to this repo by any command. The guard below is a backstop, not the mechanism.

**How based.ai consumes core.** From npm at a pinned version in CI and production. Locally via `bun link`: `cd based/core && bun link`, then `cd based-ai && bun link @based/core`. Core is shipped as TypeScript source (its `exports` already point at `src/`), which is fine because every consumer runs under Bun and core needs `bun:sqlite` anyway.

## Current state that makes this cheap

- The workspace already has `core`, `ui`, `shell-tauri`, and `specs` as separate packages with their own `typecheck` scripts.
- `ui/src` has zero imports from core. The one place that would want them, `ui/src/api/client.ts`, hand-mirrors the types and says so.
- `startServer` in `core/src/server.ts` takes `dbPath`, `agentDbPath`, `token`, and `staticDir`, so a hosted control plane can run one core per tenant without touching core.
- There is no PR or push CI today, only tag-triggered release and a manual macOS build. Independent builds need a CI file to be true in practice, not just locally.

## Work items

### 1. Make core publishable

- `core/package.json`: drop `private`, add `version` (kept in step by the bump script), `files: ["src"]`, `publishConfig.access: "public"`, `engines.bun`. Keep `exports` on `src/`.
- `scripts/bump-version.ps1`: rewrite `core/package.json` version alongside `tauri.conf.json`, `Cargo.toml`, and `version.ts`. Still one source of truth.
- `.github/workflows/release.yml`: add a `publish-core` job after the Windows job's typecheck and tests pass. `npm publish --provenance` with an `NPM_TOKEN` repo secret. Runs on the same `v*` tag; the desktop version and the core package version are the same number.
- `BASED-CORE-PUBLISH` (manual): tagging `vX.Y.Z` publishes `@based/core@X.Y.Z`; `bun add @based/core@X.Y.Z` in a fresh Bun project resolves and `startServer` is importable.

Open item: `npm view @based/core` returns 404, which only says the package is unpublished. The `@based` scope may belong to someone. Confirm with `npm publish --dry-run` once logged in. Fallback name if the scope is taken: `@cyronius/based-core`.

### 2. Prove the builds are independent

- `scripts/check-boundaries.ts`: exports `crossesBoundary(fromFile, importSpecifier)` and a CLI that walks `core/src`, `ui/src`, and `shell-tauri/*.ts`. Fails if ui imports core or shell, core imports ui or shell, or either imports a workspace sibling through a relative path. `shell-tauri` importing `@based/core` is allowed (that is its job).
- `BASED-PKG-BOUNDARIES` (unit): `crossesBoundary("ui/src/x.ts", "../../core/src/y")` is true; `crossesBoundary("ui/src/x.ts", "./y")` is false; `crossesBoundary("shell-tauri/core-child.ts", "@based/core")` is false; `crossesBoundary("core/src/x.ts", "@based/ui")` is true.
- New `.github/workflows/ci.yml` on push and pull request, one job per project so a red job names the project: `core` (typecheck), `ui` (typecheck plus `vite build`), `shell-tauri` (typecheck), `tests` (`bun test`), `boundaries`, `private-guard`. Rust is not needed for any of these, so the jobs stay fast.
- Root `package.json`: add `check` script that runs boundaries and the private guard so `bun run check` locally matches CI.

Tests in `specs/` import both core and ui today (the grid, plan XML, font metrics, and capi tests are ui-side). They stay in one `tests` job. Splitting them per package is optional later and is not part of this plan.

### 3. Private guard in this repo

- `.gitignore`: add `based-ai/`, `paid/`, `private/`, `*.private/`.
- `scripts/check-private.ts`: exports `isPrivatePath(path)` covering those prefixes plus `.env*` and the key patterns already in `.gitignore` (`*.p8`, `*.pem`, `*.key`, `*_rsa_key*`). CLI: `--staged` checks `git diff --cached --name-only`; `--tree` checks `git ls-files`.
- `.githooks/pre-commit` (tracked) runs `bun scripts/check-private.ts --staged`. `docs/development.md` and `CONTRIBUTING.md` get the one-time `git config core.hooksPath .githooks` line. No postinstall magic.
- CI `private-guard` job runs `--tree`, so a bypassed hook still fails the build.
- `BASED-PRIVATE-GUARD` (unit): `isPrivatePath("based-ai/src/x.ts")` true; `isPrivatePath("paid/README.md")` true; `isPrivatePath(".env.production")` true; `isPrivatePath("core/src/x.ts")` false; `isPrivatePath("ui/vendor/lm-ag-ui/dist/index.js")` false.

### 4. Scaffold based-ai

- `C:\code\based-ai\`: `git init`, `bun init`, `package.json` with `@based/core` pinned once published (linked until then), `README.md` stating what the project is and the link workflow, `specs/basedai/spec.md` with the `BASEDAI` prefix and no requirements yet, `.gitignore`.
- Private GitHub repo `Cyronius/based-ai`. This is the one outward-facing step; it is a `gh repo create --private` and I will ask before running it.
- Nothing else. The control plane is Phase 5 below. A `src/index.ts` that imports `startServer` and boots one core on a temp data dir is enough to prove the dependency resolves.

### 5. Docs

- `docs/development.md`: add a "Three projects" section above the package table, the hook setup line, and the `bun link` loop.
- `docs/architecture.md`: two paragraphs under a "Products" heading. based desktop is core plus ui in a Tauri shell; based.ai is a private control plane that runs the same core per tenant.
- `README.md`: one line in Status that core is published on npm.

### Verification

- `bun run check` passes locally; `ci.yml` is green on the PR.
- Temporarily creating `based-ai/x.ts` in this tree and running `git add -f` then `bun scripts/check-private.ts --staged` fails; removing it passes.
- Fresh clone of `based-ai`, `bun install`, `bun run src/index.ts` starts a core on a loopback port and `/api/health` answers.

### Order

Items 2 and 3 first (they are pure additions and can merge on their own). Then 1, which touches release. Then 4, once 1 has published at least one version. Docs land with whichever item they describe.

## Follow-up phases

Each gets its own plan. Order was agreed on 2026-09-10.

**Phase 2: Postgres with pgvector.** One adapter closes the biggest engine gap in the competitor matrix and adds a second vector engine. Design question to settle first: today SQL engines and LanceDB have different agent surfaces, and pgvector is a SQL engine that also does vector search. The registry's capability model needs to express both on one connection so `run_query` and `vector_search` coexist. Ships in the desktop app; hosted use follows for free because Neon, Supabase, RDS, and Azure Database for PostgreSQL are all cloud-reachable.

**Phase 3: Metering and caps in core.** Per-run step and token ceilings in the agent loop with a visible "run hit its budget" outcome. A usage table next to the audit log keyed by run: model, input and output tokens, tool calls, engine. Model routing resolved from the AI profile so a tenant's "ours" or "my key" choice maps to Cerebras, OpenRouter, or their endpoint. Useful to desktop users on its own, and a hard prerequisite for charging anyone.

**Phase 4: Headless core.** A `SecretStore` interface with the keyring implementation for desktop and an envelope-encrypted implementation for hosted use. Native-only routes (dialogs, new window, file open) become optional so a headless core answers 404 on them cleanly. Static egress IP documentation for Snowflake network policies and Azure SQL firewalls.

**Phase 5: based.ai v1.** Control plane in the private repo: sign-up and auth, Stripe billing, one core process per tenant on a sandbox host with static egress, engines limited to Snowflake, LanceDB Cloud, Azure SQL, and cloud Postgres. Hosted model profile seeded server-side, BYO-key tier unmetered. Chat-first web UI reusing grid and agent components from ui, which means ui grows a library entry point alongside the app. SOC 2 readiness starts here. No on-prem connector and no hosting of databases ourselves.

**Phase 6: More vector engines.** Qdrant and Pinecone by inbound demand. Both have cloud offerings and no SQL, so they land like LanceDB Cloud: search tools only. Milvus, Weaviate, and Chroma wait until someone asks.

**Phase 7: Saved questions, then dashboards.** An agent answer pinned to a URL with a refresh is a dashboard tile. This is the layer that gives a non-DBA a reason to pay and where based.ai starts overlapping Basedash and Hex deliberately. An MCP server belongs in the same phase, since it is becoming table stakes for "agents talk to your data."
