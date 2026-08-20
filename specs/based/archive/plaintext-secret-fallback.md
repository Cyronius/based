# Plan: plaintext secret fallback when the OS keyring is unavailable

**Status:** implemented 2026-08-19 — merged into `BASED-SECRET-STORE` in spec.md; tests in
`integration.secretsFallback.test.ts`
**Spec impact:** 1 modified requirement (`BASED-SECRET-STORE`)
**Motivation:** the Linux port found sessions with no usable keyring (WSL2: session bus present, no
Secret Service, and `@napi-rs/keyring` segfaults core if called; `BASED_KEYRING=off` is the current
escape hatch). Today writes are refused there, so API keys and connection passwords cannot be saved
at all. Decision: allow saving anyway, in plaintext, **loudly** — the user is told before they save,
not after, and nothing downgrades silently.

## Design

**Storage.** A `secrets_fallback (account TEXT PRIMARY KEY, secret TEXT)` table in `app.db`, behind a
small `SecretsFallbackStore` in `core/src/storage/`. app.db is already the app's private state
(`~/.local/share/based`, `%APPDATA%\based`); a separate file would be one more artifact with the same
security properties.

**Wiring.** `secrets.ts` has no DB handle today. Server startup registers the store into module-level
state (`registerSecretsFallback(store)`) — the same one-broker-per-process pattern `dialogs.ts` uses.
Callers of `setSecret`/`getSecret`/etc. are untouched.

**Semantics** (single code path; applies equally to connection passwords and AI/embedding/reranker
keys):

| Op | Keyring available | Keyring unavailable |
|---|---|---|
| write | keyring, **and purge any fallback row** (upgrade-in-place, mirrors the v2-marker precedent) | fallback row + one `console.warn` per write |
| read | keyring; on miss, fallback (a key saved on WSL still works after the box gains a keyring) | fallback only |
| delete | both | fallback only |

The 2560-byte cap and UTF-8 encoding rules stay — they're portability rules, not keyring rules.
`BASED_KEYRING=off` keeps meaning "keyring unavailable", which now routes to the fallback instead of
refusing.

**Loudness.**
- New `GET /api/secret-store` → `{ backend: "keyring" | "plaintext", reason?: string }`.
- The three profile editors and the connection dialog fetch it and, when `backend` is `"plaintext"`,
  render a warning above the secret field: *"The OS keyring is unavailable (\<reason\>). Secrets you
  save here are stored **unencrypted** in app.db."* The user knows before typing the key.
- Core logs one warning per plaintext write (not once per process — each write is a distinct choice).

## Rejected

- **Refusing writes** (current behavior) — overruled: a dev tool user who has read the warning gets
  to decide; LM Studio-style keyless flows already work, this unblocks the keyed ones.
- **Encrypting the fallback with an app-embedded key** — obfuscation with an unwarranted security
  smell; anyone who can read app.db can read the binary that decrypts it.
- **A separate plaintext file** (`.env`-style) — same exposure as app.db, one more file to create,
  lock down, and delete on uninstall.

## Spec impact

`BASED-SECRET-STORE` gains the fallback semantics table above, the loudness requirements (UI warning
sourced from `/api/secret-store`, per-write log), and the read-through + upgrade-on-write rule.

**Acceptance criteria to add** (integration — bun:sqlite in-memory db, `BASED_KEYRING=off` set for
the test):
- unavailable: `setSecret` → `getSecret` round-trips via the fallback table; the value is readable in
  the raw table (it IS plaintext); `deleteSecret` removes the row
- unavailable: an over-cap secret is still refused with the message naming the limit
- available (host keyring): a pre-seeded fallback row is readable, and a subsequent `setSecret`
  moves the secret to the keyring and purges the row
- `GET /api/secret-store` reports `plaintext` + reason when unavailable, `keyring` otherwise

UI warning: `manual` — open the AI provider editor with `BASED_KEYRING=off`, see the warning before
saving, save a key, restart, key still works.

## Out of scope

- Whether `@napi-rs/keyring` works under Bun on Linux when a Secret Service exists (linux-port 7d
  open question). If it turns out unusable entirely, this fallback becomes Linux's primary store
  until an out-of-process helper exists — the loud warning makes that livable, but that decision
  stays in the linux-port plan.
- Migrating fallback secrets automatically at startup when a keyring appears (write-time upgrade is
  enough; a startup sweep adds a native call at boot, which 2a taught us to distrust).
