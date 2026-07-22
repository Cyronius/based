// Traces: BASED-CHAT-UI, BASED-AGENT-MUTATION-GATE (frontend half)
// The `run_mutation` frontend tool. The agent calls it with SQL it wants to run; we render an
// approval card. Only the user's Approve reaches the gated /api/agent/mutation endpoint — the model
// never executes DML itself. The async handler awaits the user's decision, then resolves the tool
// result so the agent can report the outcome.
import { useState } from "react";
import type { ToolDefinition } from "@itkennel/lm-ag-ui";
import { runAgentMutation } from "../api/client";
import type { MutationResult } from "../api/types";

let pendingResolve: ((v: string) => void) | null = null;

function summarize(res: MutationResult): string {
  if (res.status === "error") return `Failed: ${res.errors.join("; ") || "unknown error"}`;
  const affected = res.rowCounts.reduce((a, b) => a + b, 0);
  const parts = [res.messages.join(" ") || `${affected} row(s) affected`];
  return `Executed in ${res.durationMs} ms. ${parts.join(" ")}`.trim();
}

function ApprovalCard({ args }: { args: { sql?: string; reason?: string } }) {
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "rejected">("idle");
  const [outcome, setOutcome] = useState<string>("");
  const sql = args?.sql ?? "";

  const approve = async () => {
    setPhase("running");
    try {
      const res = await runAgentMutation(sql);
      const text = summarize(res);
      setOutcome(text);
      setPhase("done");
      pendingResolve?.(JSON.stringify({ approved: true, status: res.status, summary: text }));
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setOutcome(text);
      setPhase("done");
      pendingResolve?.(JSON.stringify({ approved: true, status: "error", summary: text }));
    }
    pendingResolve = null;
  };

  const reject = () => {
    setPhase("rejected");
    pendingResolve?.(JSON.stringify({ approved: false }));
    pendingResolve = null;
  };

  return (
    <div className="my-2 rounded-md border border-brass/40 bg-brass/5 p-3">
      <div className="ledger-label mb-1 text-brass">Mutation approval</div>
      {args?.reason && <div className="mb-2 text-[12px] text-paper-dim">{args.reason}</div>}
      <pre className="mb-2 overflow-x-auto rounded bg-ink-950 p-2 text-[11px] font-mono text-paper-dim border border-line-soft">
        {sql}
      </pre>
      {phase === "idle" ? (
        <div className="flex gap-2">
          <button
            className="rounded bg-ok/20 px-3 py-1 text-[12px] text-ok border border-ok/40 hover:bg-ok/30"
            onClick={approve}
          >
            Approve &amp; run
          </button>
          <button
            className="rounded bg-err/15 px-3 py-1 text-[12px] text-err border border-err/40 hover:bg-err/25"
            onClick={reject}
          >
            Reject
          </button>
        </div>
      ) : phase === "running" ? (
        <div className="text-[12px] text-muted pulse-soft">Running…</div>
      ) : phase === "rejected" ? (
        <div className="text-[12px] text-err">Rejected — nothing ran.</div>
      ) : (
        <div className="text-[12px] text-ok">{outcome}</div>
      )}
    </div>
  );
}

export const marginTools: Record<string, ToolDefinition> = {
  run_mutation: {
    definition: {
      name: "run_mutation",
      description:
        "Request the user's approval to run a data- or schema-changing statement (INSERT/UPDATE/DELETE/DDL). Shows an approval card; the statement runs only if the user approves.",
      parameters: {
        type: "object",
        properties: {
          sql: { type: "string", description: "The exact SQL statement to run" },
          reason: { type: "string", description: "Short explanation of why this change is needed" },
        },
        required: ["sql"],
      },
    },
    isFrontend: true,
    handler: () =>
      new Promise<string>((resolve) => {
        pendingResolve = resolve;
      }),
    renderer: (args) => <ApprovalCard args={args as { sql?: string; reason?: string }} />,
  },
};
