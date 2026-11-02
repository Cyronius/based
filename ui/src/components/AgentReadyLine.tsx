// Traces: BASED-AGENT-READY — one line above the composer when a send cannot work yet.
import type { AgentReadiness } from "../api/client";
import { useStore } from "../store";

export function agentReadyText(r: AgentReadiness | null): string | null {
  if (!r || r.state === "ok") return null;
  if (r.state === "none") return "No agent profile yet, so Capi cannot answer.";
  if (r.state === "no-key") return `The ${r.profileName ?? "active"} profile has no API key.`;
  return "The model server is not answering.";
}

export function AgentReadyLine() {
  const ready = useStore((s) => s.agentReady);
  const text = agentReadyText(ready);
  if (!text) return null;
  return (
    <div role="status" className="mb-2 rounded border border-err/30 bg-err/10 px-2 py-1.5 text-[length:var(--fs-sm)]">
      <div className="text-paper-dim">{text}</div>
      {ready?.state === "unreachable" && ready.detail && <div className="mt-0.5 font-mono text-muted break-words">{ready.detail}</div>}
      <div className="mt-1 flex gap-3">
        <button className="text-brass hover:underline" onClick={() => useStore.getState().openSettings("agent")}>
          Settings → Agent
        </button>
        <button className="text-muted hover:text-paper" onClick={() => void useStore.getState().refreshAgentReady()}>
          Check again
        </button>
      </div>
    </div>
  );
}
