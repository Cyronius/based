// Traces: BASED-CONN-SWITCH-FAILURE, BASED-CONN-ERROR-TEXT
// Names the connection that failed, says why in plain words, and offers the two next steps.
import { useStore } from "../store";
import { describeConnectError } from "../lib/connectError";
import { IconButton } from "./IconButton";

export function ConnectFailureBanner() {
  const failure = useStore((s) => s.connectFailure);
  const connections = useStore((s) => s.connections);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const connect = useStore((s) => s.connect);
  const setDialog = useStore((s) => s.setDialog);
  const dismiss = useStore((s) => s.dismissConnectFailure);
  if (!failure) return null;
  const conn = connections.find((c) => c.id === failure.connectionId);
  const current = connections.find((c) => c.id === activeConnectionId);
  const { summary, detail } = describeConnectError(failure.message);
  return (
    <div role="alert" className="flex items-start gap-3 px-4 py-2 text-[length:var(--fs-base)] bg-err/10 border-b border-err/30">
      <div className="flex-1 min-w-0">
        <div className="text-err">
          Couldn't connect to <span className="font-bold">{conn?.name ?? "the connection"}</span> — {summary}
          {current && current.id !== failure.connectionId && <span className="text-muted"> · still on {current.name}</span>}
        </div>
        {detail && <div className="mt-0.5 font-mono text-[length:var(--fs-sm)] text-muted break-words">{detail}</div>}
      </div>
      <button className="shrink-0 text-brass hover:underline" onClick={() => void connect(failure.connectionId)}>
        Retry
      </button>
      {conn && (
        <button
          className="shrink-0 text-brass hover:underline"
          onClick={() => {
            dismiss();
            setDialog({ mode: "edit", connection: conn });
          }}
        >
          Edit connection…
        </button>
      )}
      <IconButton size="sm" title="Dismiss" aria-label="Dismiss" className="text-muted hover:text-paper" onClick={dismiss}>
        ✕
      </IconButton>
    </div>
  );
}
