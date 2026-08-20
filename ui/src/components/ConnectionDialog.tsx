// Traces: BASED-ENGINE-PROFILE-WIRE, BASED-CONN-SETTINGS-BAG
// The connection dialog renders from engine profiles served by core, not from per-engine JSX. It
// knows the closed set of FieldSpec kinds and nothing else — no engine names, no auth-type
// comparisons, no `isLance` flag. That is the whole point: adding the fourth through eighth engines
// is a core-only change, and this file cannot drift out of step with the registry the way a
// hand-mirrored copy of the engine list would.
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { browseFolder } from "../api/client";
import { SecretStoreWarning } from "./SecretStoreWarning";
import { IconButton } from "./IconButton";
import type { ConnectionInput, EngineProfile, FieldSpec, TestResult } from "../api/types";

/** ConnectionConfig keys that stay top-level; every other FieldSpec key addresses `settings`. */
const TOP_LEVEL_KEYS = new Set(["name", "database", "defaultEmbeddingProfileId", "defaultRerankerProfileId"]);

function readField(form: ConnectionInput, key: string): unknown {
  if (TOP_LEVEL_KEYS.has(key)) return (form as unknown as Record<string, unknown>)[key];
  return form.settings?.[key];
}

function writeField(form: ConnectionInput, key: string, value: unknown): ConnectionInput {
  if (TOP_LEVEL_KEYS.has(key)) return { ...form, [key]: value } as ConnectionInput;
  return { ...form, settings: { ...(form.settings ?? {}), [key]: value } };
}

/** A field is shown when it has no `visibleWhen`, or when the named field currently holds one of
 *  the listed values. `authType` is the only cross-cutting one today, but the rule is general. */
function isVisible(form: ConnectionInput, spec: FieldSpec): boolean {
  if (!spec.visibleWhen) return true;
  const current =
    spec.visibleWhen.field === "authType" ? form.authType : String(readField(form, spec.visibleWhen.field) ?? "");
  return spec.visibleWhen.equals.includes(String(current));
}

/** Seed a form for an engine: its FieldSpec defaults, plus the first auth mode. */
function blankForm(profile: EngineProfile): ConnectionInput {
  const settings: Record<string, unknown> = {};
  for (const f of profile.fields) {
    if (f.default !== undefined && !TOP_LEVEL_KEYS.has(f.key)) settings[f.key] = f.default;
  }
  return {
    name: "",
    database: "",
    engine: profile.id,
    authType: profile.authModes[0]?.id ?? "",
    settings,
    secret: "",
  };
}

export function ConnectionDialog() {
  const dialog = useStore((s) => s.dialog);
  const setDialog = useStore((s) => s.setDialog);
  const engines = useStore((s) => s.engines);
  const saveConnection = useStore((s) => s.saveConnection);
  const connect = useStore((s) => s.connect);
  const deleteConnection = useStore((s) => s.deleteConnection);
  const testConnection = useStore((s) => s.testConnection);
  const embeddingProfiles = useStore((s) => s.embeddingProfiles);
  const rerankerProfiles = useStore((s) => s.rerankerProfiles);

  const editing = dialog.mode === "edit" ? dialog.connection : null;
  const firstEngine = engines[0];
  const [form, setForm] = useState<ConnectionInput>(() =>
    editing
      ? { ...editing, settings: { ...(editing.settings ?? {}) }, secret: "" }
      : firstEngine
        ? blankForm(firstEngine)
        : { name: "", database: "", authType: "", settings: {}, secret: "" },
  );
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDialog({ mode: "closed" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setDialog]);

  const profile = useMemo(
    () => engines.find((e) => e.id === (form.engine ?? "mssql")) ?? engines[0],
    [engines, form.engine],
  );
  const authMode = profile?.authModes.find((m) => m.id === form.authType) ?? profile?.authModes[0];
  const visibleFields = useMemo(
    () => (profile ? profile.fields.filter((f) => isVisible(form, f)) : []),
    [profile, form],
  );

  /** Switch engines: reseed from the new engine's defaults, keeping only the connection's name.
   *  Carrying settings across would leave another engine's keys in the bag. */
  function selectEngine(nextId: string) {
    const next = engines.find((e) => e.id === nextId);
    if (!next) return;
    setTestResult(null);
    setError(null);
    setForm({ ...blankForm(next), name: form.name });
  }

  // Traces: BASED-LANCE-CONN-DEFAULT-PROFILES — with exactly one embedding profile configured (the
  // single-endpoint case, e.g. one LM Studio) a new connection whose engine offers the field adopts
  // it, so the common setup needs no extra choice. Never on edit: a stored choice — including an
  // explicit "None" — is authoritative, and the ref keeps a later profile-list change from
  // overriding the user's pick.
  const prefilled = useRef(false);
  const offersEmbedding = visibleFields.some((f) => f.kind === "embedding-profile");
  useEffect(() => {
    if (editing || prefilled.current || !offersEmbedding || embeddingProfiles.length !== 1) return;
    prefilled.current = true;
    setForm((f) => (f.defaultEmbeddingProfileId ? f : { ...f, defaultEmbeddingProfileId: embeddingProfiles[0]!.id }));
  }, [editing, embeddingProfiles, offersEmbedding]);

  function payload(): ConnectionInput {
    const p = { ...form };
    if (!p.secret) delete p.secret; // blank on edit = keep the stored secret
    return p;
  }

  async function onBrowseFolder(key: string) {
    setBrowsing(key);
    try {
      const { path } = await browseFolder(String(readField(form, key) ?? "") || undefined);
      if (path) setForm(writeField(form, key, path));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBrowsing(null);
  }

  async function onTest() {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      setTestResult(await testConnection(payload()));
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    setTesting(false);
  }

  /** Required-field validation comes from the profile, so a new engine's rules ship with it. */
  function missingRequired(): string | null {
    if (!form.name.trim()) return "Name is required.";
    for (const f of visibleFields) {
      if (!f.required) continue;
      const value = readField(form, f.key);
      if (typeof value === "string" ? !value.trim() : value == null) return `${f.label} is required.`;
    }
    return null;
  }

  async function onSave() {
    const missing = missingRequired();
    if (missing) {
      setError(missing);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await saveConnection(payload());
      setDialog({ mode: "closed" });
      // Saving a connection (new or edited) selects it as the active session.
      void connect(saved.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  const field =
    "w-full px-2.5 py-1.5 rounded border border-line bg-ink-950 text-paper text-[length:var(--fs-base)] focus:outline-none focus:border-brass-soft placeholder:text-faint";
  const label = "ledger-label block mb-1";
  const help = "mt-1 text-[length:var(--fs-sm)] text-faint leading-snug";

  function renderField(spec: FieldSpec) {
    const value = readField(form, spec.key);
    const set = (v: unknown) => setForm(writeField(form, spec.key, v));

    if (spec.kind === "checkbox") {
      return (
        <label key={spec.key} className="flex items-center gap-1.5 cursor-pointer text-[length:var(--fs-base)] text-muted">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => set(e.target.checked)}
            className="accent-(--color-brass)"
          />
          {spec.label}
        </label>
      );
    }

    if (spec.kind === "embedding-profile" || spec.kind === "reranker-profile") {
      const list = spec.kind === "embedding-profile" ? embeddingProfiles : rerankerProfiles;
      return (
        <div key={spec.key}>
          <label className={label}>{spec.label}</label>
          <select className={field} value={String(value ?? "")} disabled={list.length === 0} onChange={(e) => set(e.target.value || null)}>
            <option value="">None</option>
            {list.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <p className={help}>
            {list.length === 0 ? "No search profiles configured yet — add them under Settings → Search, then pick them here." : spec.help}
          </p>
        </div>
      );
    }

    if (spec.kind === "select") {
      return (
        <div key={spec.key}>
          <label className={label}>{spec.label}</label>
          <select className={field} value={String(value ?? "")} onChange={(e) => set(e.target.value)}>
            {(spec.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {spec.help && <p className={help}>{spec.help}</p>}
        </div>
      );
    }

    const browsable = spec.kind === "directory" || spec.kind === "file";
    return (
      <div key={spec.key}>
        <label className={label}>
          {spec.label}
          {!spec.required && <span className="normal-case tracking-normal"> (optional)</span>}
        </label>
        <div className={browsable ? "flex gap-2" : undefined}>
          <input
            className={field}
            type={spec.kind === "password" ? "password" : "text"}
            value={String(value ?? "")}
            onChange={(e) => set(e.target.value)}
            placeholder={spec.placeholder}
          />
          {browsable && (
            <button
              type="button"
              className="shrink-0 px-2.5 py-1.5 text-[length:var(--fs-base)] rounded border border-line text-muted hover:text-paper disabled:opacity-40"
              disabled={browsing === spec.key}
              onClick={() => void onBrowseFolder(spec.key)}
            >
              {browsing === spec.key ? "…" : "Browse…"}
            </button>
          )}
        </div>
        {spec.help && <p className={help}>{spec.help}</p>}
      </div>
    );
  }

  const checkboxes = visibleFields.filter((f) => f.kind === "checkbox");
  const inputs = visibleFields.filter((f) => f.kind !== "checkbox");

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60"
      onMouseDown={(e) => e.target === e.currentTarget && setDialog({ mode: "closed" })}
    >
      <div className="w-[440px] max-h-[90vh] overflow-y-auto rounded-lg border border-line bg-ink-900 shadow-2xl shadow-black/50 fade-up">
        <div className="px-5 pt-4 pb-3 border-b border-line-soft flex items-baseline justify-between">
          <h2 className="font-display text-lg text-paper">{editing ? "Edit connection" : "New connection"}</h2>
          <IconButton title="Close" aria-label="Close" className="text-faint hover:text-paper" onClick={() => setDialog({ mode: "closed" })}>
            ✕
          </IconButton>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div>
            <label className={label}>Engine</label>
            <select className={field} value={profile?.id ?? ""} onChange={(e) => selectEngine(e.target.value)}>
              {engines.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
            {authMode?.note && <p className={help}>{authMode.note}</p>}
          </div>

          <div>
            <label className={label}>Name</label>
            <input className={field} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Production DB" />
          </div>

          {(profile?.authModes.length ?? 0) > 1 && (
            <div>
              <label className={label}>Authentication</label>
              <select
                className={field}
                value={form.authType}
                onChange={(e) => {
                  setForm({ ...form, authType: e.target.value });
                  setTestResult(null);
                }}
              >
                {profile?.authModes.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {inputs.map(renderField)}

          {authMode?.secretLabel && (
            <div>
              <label className={label}>
                {authMode.secretLabel}
                {editing && <span className="normal-case tracking-normal"> (blank = keep stored)</span>}
              </label>
              <div className="mb-1">
                <SecretStoreWarning />
              </div>
              {/* A PEM spans lines and an <input> cannot hold one — the browser strips newlines on
                  paste, which silently mangles the key rather than rejecting it. Multi-line secrets
                  therefore get a textarea; it forfeits the masking, which a pasted PEM never had
                  anywhere else in the flow either. */}
              {authMode.secretMultiline ? (
                <textarea
                  className={`${field} font-mono text-[length:var(--fs-sm)] resize-y`}
                  rows={6}
                  spellCheck={false}
                  value={form.secret ?? ""}
                  onChange={(e) => setForm({ ...form, secret: e.target.value })}
                />
              ) : (
                <input
                  type="password"
                  className={field}
                  value={form.secret ?? ""}
                  onChange={(e) => setForm({ ...form, secret: e.target.value })}
                />
              )}
              {authMode.secretHelp && <p className={help}>{authMode.secretHelp}</p>}
            </div>
          )}

          {checkboxes.length > 0 && <div className="flex gap-4 pt-1">{checkboxes.map(renderField)}</div>}

          {testResult && (
            <div
              className={`px-3 py-2 rounded border text-[length:var(--fs-base)] font-mono ${testResult.ok ? "border-ok/40 bg-ok/10 text-ok" : "border-err/40 bg-err/10 text-err"}`}
            >
              {testResult.ok
                ? testResult.identity
                  ? `Connected as ${testResult.identity} — ${testResult.serverVersion ?? ""}`
                  : `Connected ${testResult.serverVersion ?? ""}`
                : testResult.error}
            </div>
          )}
          {error && <div className="px-3 py-2 rounded border border-err/40 bg-err/10 text-err text-[length:var(--fs-base)]">{error}</div>}
        </div>

        <div className="px-5 py-3 border-t border-line-soft flex items-center gap-2">
          {editing && (
            <button
              className={`px-3 py-1.5 text-[length:var(--fs-base)] rounded border ${confirmDelete ? "border-err bg-err/20 text-err" : "border-line text-muted hover:text-err hover:border-err/50"}`}
              onClick={() => {
                if (!confirmDelete) {
                  setConfirmDelete(true);
                  return;
                }
                void deleteConnection(editing.id).then(() => setDialog({ mode: "closed" }));
              }}
            >
              {confirmDelete ? "Confirm delete?" : "Delete"}
            </button>
          )}
          <div className="flex-1" />
          <button
            className="px-3 py-1.5 text-[length:var(--fs-base)] rounded border border-line text-muted hover:text-paper disabled:opacity-40"
            disabled={testing}
            onClick={() => void onTest()}
          >
            {testing ? "Testing…" : "Test connection"}
          </button>
          <button
            className="px-4 py-1.5 text-[length:var(--fs-base)] rounded border border-brass-soft bg-brass/15 text-brass hover:bg-brass/25 disabled:opacity-40"
            disabled={saving}
            onClick={() => void onSave()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
