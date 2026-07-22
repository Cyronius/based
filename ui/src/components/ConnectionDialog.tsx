import { useState } from "react";
import { useStore } from "../store";
import type { AuthType, ConnectionInput, TestResult } from "../api/types";

const AUTH_OPTIONS: Array<{ value: AuthType; label: string }> = [
  { value: "entra-interactive", label: "Entra ID (interactive browser)" },
  { value: "azure-cli", label: "Azure CLI credential" },
  { value: "sql-login", label: "SQL login" },
  { value: "service-principal", label: "Service principal" },
];

export function ConnectionDialog() {
  const dialog = useStore((s) => s.dialog);
  const setDialog = useStore((s) => s.setDialog);
  const saveConnection = useStore((s) => s.saveConnection);
  const deleteConnection = useStore((s) => s.deleteConnection);
  const testConnection = useStore((s) => s.testConnection);

  const editing = dialog.mode === "edit" ? dialog.connection : null;
  const [form, setForm] = useState<ConnectionInput>(
    editing
      ? { ...editing, secret: "" }
      : {
          name: "",
          server: "",
          database: "",
          authType: "entra-interactive",
          encrypt: true,
          trustServerCertificate: false,
          secret: "",
        },
  );
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsSecret = form.authType === "sql-login" || form.authType === "service-principal";
  const secretLabel = form.authType === "sql-login" ? "Password" : "Client secret";

  function payload(): ConnectionInput {
    const p = { ...form };
    if (!p.secret) delete p.secret; // blank on edit = keep the stored secret
    return p;
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

  async function onSave() {
    if (!form.name.trim() || !form.server.trim() || !form.database.trim()) {
      setError("Name, server, and database are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveConnection(payload());
      setDialog({ mode: "closed" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  const field = "w-full px-2.5 py-1.5 rounded border border-line bg-ink-950 text-paper text-[12.5px] focus:outline-none focus:border-brass-soft placeholder:text-faint";
  const label = "ledger-label block mb-1";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60" onMouseDown={(e) => e.target === e.currentTarget && setDialog({ mode: "closed" })}>
      <div className="w-[440px] max-h-[90vh] overflow-y-auto rounded-lg border border-line bg-ink-900 shadow-2xl shadow-black/50 fade-up">
        <div className="px-5 pt-4 pb-3 border-b border-line-soft flex items-baseline justify-between">
          <h2 className="font-display text-lg text-paper">{editing ? "Edit connection" : "New connection"}</h2>
          <button className="text-faint hover:text-paper" onClick={() => setDialog({ mode: "closed" })}>
            ✕
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div>
            <label className={label}>Name</label>
            <input className={field} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Production ledger" />
          </div>
          <div>
            <label className={label}>Server</label>
            <input className={field} value={form.server} onChange={(e) => setForm({ ...form, server: e.target.value })} placeholder="myserver.database.windows.net" />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className={label}>Initial database</label>
              <input className={field} value={form.database} onChange={(e) => setForm({ ...form, database: e.target.value })} placeholder="mydb" />
            </div>
            <div className="flex-1">
              <label className={label}>Authentication</label>
              <select
                className={field}
                value={form.authType}
                onChange={(e) => {
                  setForm({ ...form, authType: e.target.value as AuthType });
                  setTestResult(null);
                }}
              >
                {AUTH_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {form.authType === "sql-login" && (
            <div>
              <label className={label}>Username</label>
              <input className={field} value={form.username ?? ""} onChange={(e) => setForm({ ...form, username: e.target.value })} />
            </div>
          )}
          {(form.authType === "service-principal" || form.authType === "entra-interactive" || form.authType === "azure-cli") && (
            <div>
              <label className={label}>Tenant id {form.authType !== "service-principal" && <span className="normal-case tracking-normal">(optional)</span>}</label>
              <input className={field} value={form.tenantId ?? ""} onChange={(e) => setForm({ ...form, tenantId: e.target.value })} />
            </div>
          )}
          {form.authType === "service-principal" && (
            <div>
              <label className={label}>Client id</label>
              <input className={field} value={form.clientId ?? ""} onChange={(e) => setForm({ ...form, clientId: e.target.value })} />
            </div>
          )}
          {needsSecret && (
            <div>
              <label className={label}>
                {secretLabel}
                {editing && <span className="normal-case tracking-normal"> (blank = keep stored)</span>}
              </label>
              <input type="password" className={field} value={form.secret ?? ""} onChange={(e) => setForm({ ...form, secret: e.target.value })} />
            </div>
          )}

          <div className="flex gap-4 pt-1 text-[12px] text-muted">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={form.encrypt} onChange={(e) => setForm({ ...form, encrypt: e.target.checked })} className="accent-(--color-brass)" />
              Encrypt
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={form.trustServerCertificate}
                onChange={(e) => setForm({ ...form, trustServerCertificate: e.target.checked })}
                className="accent-(--color-brass)"
              />
              Trust server certificate
            </label>
          </div>

          {testResult && (
            <div className={`px-3 py-2 rounded border text-[12px] font-mono ${testResult.ok ? "border-ok/40 bg-ok/10 text-ok" : "border-err/40 bg-err/10 text-err"}`}>
              {testResult.ok ? `Connected as ${testResult.identity || "?"} — ${testResult.serverVersion ?? ""}` : testResult.error}
            </div>
          )}
          {error && <div className="px-3 py-2 rounded border border-err/40 bg-err/10 text-err text-[12px]">{error}</div>}
        </div>

        <div className="px-5 py-3 border-t border-line-soft flex items-center gap-2">
          {editing && (
            <button
              className={`px-3 py-1.5 text-[12px] rounded border ${confirmDelete ? "border-err bg-err/20 text-err" : "border-line text-muted hover:text-err hover:border-err/50"}`}
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
          <button className="px-3 py-1.5 text-[12px] rounded border border-line text-muted hover:text-paper disabled:opacity-40" disabled={testing} onClick={() => void onTest()}>
            {testing ? "Testing…" : "Test connection"}
          </button>
          <button
            className="px-4 py-1.5 text-[12px] rounded border border-brass-soft bg-brass/15 text-brass hover:bg-brass/25 disabled:opacity-40"
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
