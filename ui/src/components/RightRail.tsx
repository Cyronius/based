// Traces: BASED-UI-LAYOUT, BASED-CHAT-UI
// The right-hand rail now hosts Ask Capi (Phase 2). The agent provider stays mounted
// while a connection is active so the thread survives collapse/expand.
import { useEffect, useState } from "react";
import { useAgent, AgentProvider } from "@itkennel/lm-ag-ui";
import { useStore } from "../store";
import {
  token,
  sessionId,
  AGENT_BASE_URL,
  aiGetConfig,
  aiSaveConfig,
  getAgentInstructions,
  saveAgentInstructionSet,
  setActiveAgentInstructionSet,
  deleteAgentInstructionSet,
} from "../api/client";
import type { AiConfig, AgentInstructionsConfig, InstructionSet } from "../api/types";
import { capiTools } from "../agent/capiTools";
import { CapiChat } from "./CapiChat";

const WIDTH_KEY = "based:rightRailWidth";
const MIN_WIDTH = 280;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 384;

function loadWidth(): number {
  const stored = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(stored) && stored >= MIN_WIDTH && stored <= MAX_WIDTH ? stored : DEFAULT_WIDTH;
}

function ConfigPanel({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<AiConfig | null>(null);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void aiGetConfig().then(setCfg);
  }, []);

  if (!cfg) return null;
  const save = async () => {
    setSaving(true);
    await aiSaveConfig({ ...cfg, key: key ? key : undefined }).catch(() => {});
    setSaving(false);
    onClose();
  };

  return (
    <div className="border-b border-line-soft bg-ink-900 pl-3 pr-4 py-3 text-[length:var(--fs-base)] space-y-2 fade-up">
      <div className="ledger-label">AI provider</div>
      <label className="block">
        <span className="text-faint">Base URL</span>
        <input
          className="mt-0.5 w-full rounded border border-line bg-ink-950 px-2 py-1 text-paper"
          value={cfg.baseUrl}
          onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })}
        />
      </label>
      <label className="block">
        <span className="text-faint">Model</span>
        <input
          className="mt-0.5 w-full rounded border border-line bg-ink-950 px-2 py-1 text-paper"
          value={cfg.model}
          onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
        />
      </label>
      <label className="block">
        <span className="text-faint">API key {cfg.hasKey ? "(stored)" : "(optional)"}</span>
        <input
          type="password"
          className="mt-0.5 w-full rounded border border-line bg-ink-950 px-2 py-1 text-paper"
          placeholder={cfg.hasKey ? "•••••• — leave blank to keep" : "none needed for local"}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      <div className="flex gap-2 pt-1">
        <button className="rounded bg-brass px-3 py-1 text-ink-950 disabled:opacity-40" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button className="rounded border border-line px-3 py-1 text-muted hover:text-paper" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** A collapsible textarea box — Core/SQL Server persona/LanceDB persona can each be large, so they
 *  start collapsed rather than filling the panel (BASED-AGENT-INSTRUCTIONS-UI). */
function InstructionsField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <details className="rounded border border-line">
      <summary className="cursor-pointer select-none px-2 py-1 text-faint">{label}</summary>
      <textarea
        className="w-full resize-y rounded-b border-t border-line bg-ink-950 px-2 py-1 text-paper disabled:opacity-60"
        rows={6}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </details>
  );
}

function InstructionsPanel() {
  const [cfg, setCfg] = useState<AgentInstructionsConfig | null>(null);
  const [selectedId, setSelectedId] = useState<string>("default");
  const [draft, setDraft] = useState<InstructionSet | null>(null);
  const [busy, setBusy] = useState(false);

  const applyConfig = (next: AgentInstructionsConfig, preferId?: string) => {
    setCfg(next);
    setSelectedId(preferId ?? next.activeId);
  };

  useEffect(() => {
    void getAgentInstructions().then((c) => applyConfig(c));
  }, []);

  useEffect(() => {
    const selected = cfg?.sets.find((s) => s.id === selectedId);
    if (selected) setDraft(selected);
  }, [cfg, selectedId]);

  if (!cfg || !draft) return null;
  const selected = cfg.sets.find((s) => s.id === selectedId)!;

  const selectSet = async (id: string) => {
    setBusy(true);
    const next = await setActiveAgentInstructionSet(id).catch(() => cfg);
    applyConfig(next, id);
    setBusy(false);
  };

  const save = async () => {
    setBusy(true);
    const next = await saveAgentInstructionSet({
      id: selected.id,
      name: draft.name,
      core: draft.core,
      mssqlPersona: draft.mssqlPersona,
      lancePersona: draft.lancePersona,
    }).catch(() => cfg);
    applyConfig(next, selectedId);
    setBusy(false);
  };

  const duplicate = async () => {
    setBusy(true);
    const next = await saveAgentInstructionSet({
      name: `${selected.name} copy`,
      core: selected.core,
      mssqlPersona: selected.mssqlPersona,
      lancePersona: selected.lancePersona,
    }).catch(() => cfg);
    const created = next.sets.find((s) => s.editable && !cfg.sets.some((existing) => existing.id === s.id));
    applyConfig(next, created?.id ?? next.activeId);
    setBusy(false);
  };

  const remove = async () => {
    setBusy(true);
    const next = await deleteAgentInstructionSet(selected.id).catch(() => cfg);
    applyConfig(next);
    setBusy(false);
  };

  return (
    <div className="border-b border-line-soft bg-ink-900 pl-3 pr-4 py-3 text-[length:var(--fs-base)] space-y-2 fade-up">
      <div className="ledger-label">Agent instructions</div>
      <label className="block">
        <span className="text-faint">Set</span>
        <select
          className="mt-0.5 w-full rounded border border-line bg-ink-950 px-2 py-1 text-paper"
          value={selectedId}
          onChange={(e) => void selectSet(e.target.value)}
          disabled={busy}
        >
          {cfg.sets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      {!selected.editable && <p className="text-faint italic">Default instructions are read-only — duplicate to customize.</p>}
      <InstructionsField
        label="Core (shared)"
        value={draft.core}
        disabled={!selected.editable}
        onChange={(v) => setDraft({ ...draft, core: v })}
      />
      <InstructionsField
        label="SQL Server persona"
        value={draft.mssqlPersona}
        disabled={!selected.editable}
        onChange={(v) => setDraft({ ...draft, mssqlPersona: v })}
      />
      <InstructionsField
        label="LanceDB persona"
        value={draft.lancePersona}
        disabled={!selected.editable}
        onChange={(v) => setDraft({ ...draft, lancePersona: v })}
      />
      <div className="flex flex-wrap gap-2 pt-1">
        {selected.editable && (
          <button
            className="rounded bg-brass px-3 py-1 text-ink-950 disabled:opacity-40"
            onClick={() => void save()}
            disabled={busy}
          >
            Save
          </button>
        )}
        <button className="rounded border border-line px-3 py-1 text-muted hover:text-paper disabled:opacity-40" onClick={() => void duplicate()} disabled={busy}>
          Duplicate as new set
        </button>
        {selected.editable && (
          <button className="rounded border border-err/50 px-3 py-1 text-err hover:bg-err/10 disabled:opacity-40" onClick={() => void remove()} disabled={busy}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

function CapiRail() {
  const [err, setErr] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const agent = useAgent({
    baseUrl: AGENT_BASE_URL,
    agentId: "capi",
    tools: capiTools,
    tokenProvider: async () => token,
    sendFullHistory: false,
    configParams: { sid: sessionId },
    onError: (e) => setErr(e.message),
  });

  return (
    <AgentProvider value={agent}>
      <div className="flex flex-1 min-h-0 min-w-0 flex-col">
        <header className="flex items-center justify-between border-b border-line-soft pl-3 pr-4 py-4">
          <span className="flex items-center gap-2.5 font-sans text-[length:var(--fs-md)] font-semibold text-faint">
            <img src="/capi.png" alt="" className="h-8 w-8 rounded-full object-cover" />
            Ask Capi
          </span>
          <button className="text-faint hover:text-brass text-base" title="AI provider settings" onClick={() => setShowConfig((v) => !v)}>
            ⚙
          </button>
        </header>
        {showConfig && (
          <>
            <ConfigPanel onClose={() => setShowConfig(false)} />
            <InstructionsPanel />
          </>
        )}
        {err && (
          <div className="flex items-start gap-2 border-b border-err/30 bg-err/10 pl-3 pr-4 py-2 text-[length:var(--fs-sm)] text-err">
            <span className="flex-1 font-mono break-words">{err}</span>
            <button className="text-muted hover:text-paper" onClick={() => setErr(null)}>
              ✕
            </button>
          </div>
        )}
        <CapiChat />
      </div>
    </AgentProvider>
  );
}

export function RightRail() {
  const open = useStore((s) => s.rightRailOpen);
  const toggle = useStore((s) => s.toggleRightRail);
  const connected = useStore((s) => s.activeConnectionId);
  const [width, setWidth] = useState(loadWidth);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - e.clientX));
      setWidth(next);
      localStorage.setItem(WIDTH_KEY, String(next));
    };
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  return (
    <aside
      className={`relative shrink-0 flex border-l border-line-soft bg-ink-950 ${dragging ? "" : "transition-[width]"}`}
      style={{ width: open ? width : 32 }}
    >
      {open && (
        <div
          className="absolute left-0 top-0 z-10 h-full w-1 -translate-x-1/2 cursor-ew-resize hover:bg-brass/40 active:bg-brass/50"
          title="Drag to resize"
          onMouseDown={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
        />
      )}
      <button
        className="w-8 shrink-0 flex flex-col items-center pt-3 gap-2 text-faint hover:text-brass"
        title={open ? "Collapse Capi" : "Expand Capi"}
        onClick={toggle}
      >
        <span className="text-[length:var(--fs-sm)]">{open ? "›" : "‹"}</span>
        {!open && (
          <span className="ledger-label" style={{ writingMode: "vertical-rl" }}>
            capi
          </span>
        )}
      </button>
      {/* Kept mounted while connected so the chat thread survives collapse; hidden when closed. */}
      {connected ? (
        <div className={open ? "flex flex-1 min-w-0" : "hidden"}>
          <CapiRail />
        </div>
      ) : (
        open && (
          <div className="flex-1 min-w-0 p-4 pr-5 fade-up">
            <img src="/capi.png" alt="" className="h-36 w-36 rounded-full object-cover overflow-visible mb-3" />
            <div className="ledger-label mb-3">Capi</div>
            <p className="text-[length:var(--fs-base)] text-muted leading-relaxed break-words">Connect to a database to chat with the agent.</p>
          </div>
        )
      )}
    </aside>
  );
}
