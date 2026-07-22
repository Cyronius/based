// Traces: BASED-UI-LAYOUT, BASED-CHAT-UI
// The right-hand margin rail now hosts Margin Chat (Phase 2). The agent provider stays mounted
// while a connection is active so the thread survives collapse/expand.
import { useEffect, useState } from "react";
import { useAgent, AgentProvider } from "@itkennel/lm-ag-ui";
import { useStore } from "../store";
import { token, AGENT_BASE_URL, aiGetConfig, aiSaveConfig } from "../api/client";
import type { AiConfig } from "../api/types";
import { marginTools } from "../agent/marginTools";
import { MarginChat } from "./MarginChat";

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
    <div className="border-b border-line-soft bg-ink-900 p-3 text-[12px] space-y-2 fade-up">
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

function MarginRail() {
  const [err, setErr] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const agent = useAgent({
    baseUrl: AGENT_BASE_URL,
    agentId: "margin",
    tools: marginTools,
    tokenProvider: async () => token,
    sendFullHistory: false,
    onError: (e) => setErr(e.message),
  });

  return (
    <AgentProvider value={agent}>
      <div className="flex flex-1 min-h-0 flex-col">
        <header className="flex items-center justify-between border-b border-line-soft px-3 py-2">
          <span className="ledger-label">Margin Chat</span>
          <button className="text-faint hover:text-brass text-[13px]" title="AI provider settings" onClick={() => setShowConfig((v) => !v)}>
            ⚙
          </button>
        </header>
        {showConfig && <ConfigPanel onClose={() => setShowConfig(false)} />}
        {err && (
          <div className="flex items-start gap-2 border-b border-err/30 bg-err/10 px-3 py-2 text-[11px] text-err">
            <span className="flex-1 font-mono">{err}</span>
            <button className="text-muted hover:text-paper" onClick={() => setErr(null)}>
              ✕
            </button>
          </div>
        )}
        <MarginChat />
      </div>
    </AgentProvider>
  );
}

export function RightRail() {
  const open = useStore((s) => s.rightRailOpen);
  const toggle = useStore((s) => s.toggleRightRail);
  const connected = useStore((s) => s.activeConnectionId);

  return (
    <aside className={`shrink-0 flex border-l border-line-soft bg-ink-950 transition-all ${open ? "w-96" : "w-8"}`}>
      <button
        className="w-8 shrink-0 flex flex-col items-center pt-3 gap-2 text-faint hover:text-brass"
        title={open ? "Collapse margin" : "Expand margin"}
        onClick={toggle}
      >
        <span className="text-[11px]">{open ? "›" : "‹"}</span>
        {!open && (
          <span className="ledger-label" style={{ writingMode: "vertical-rl" }}>
            margin
          </span>
        )}
      </button>
      {/* Kept mounted while connected so the chat thread survives collapse; hidden when closed. */}
      {connected ? (
        <div className={open ? "flex flex-1 min-w-0" : "hidden"}>
          <MarginRail />
        </div>
      ) : (
        open && (
          <div className="flex-1 p-4 fade-up">
            <div className="ledger-label mb-3">Margin</div>
            <p className="text-[12px] text-muted leading-relaxed">Connect to a database to chat with the agent.</p>
          </div>
        )
      )}
    </aside>
  );
}
