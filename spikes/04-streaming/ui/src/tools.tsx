// Frontend tool: `confirm_mutation` — the approval-card round-trip.
// Pattern (b) from lm-ag-ui: the async handler awaits a promise the renderer
// resolves on button click; the tool runner then auto-dispatches the tool
// message and calls submitToolResults, continuing the chain server-side.
import { useState } from "react";
import type { ToolDefinition } from "@itkennel/lm-ag-ui";

let pendingResolve: ((v: string) => void) | null = null;

function ApprovalCard({ args, result }: { args: any; result: string }) {
  const [decided, setDecided] = useState<string | null>(null);
  const done = decided !== null || (result && result.length > 0);

  const decide = (approved: boolean) => {
    const verdict = JSON.stringify({ approved });
    setDecided(verdict);
    pendingResolve?.(verdict);
    pendingResolve = null;
  };

  return (
    <div data-testid="approval-card" className="border border-amber-400 bg-amber-50 rounded-lg p-3 my-2">
      <div className="font-semibold text-amber-900 mb-1">Mutation approval required</div>
      {args?.reason && <div className="text-sm mb-2">{args.reason}</div>}
      <pre className="text-xs bg-white border border-amber-200 rounded p-2 overflow-x-auto">{args?.sql}</pre>
      {done ? (
        <div data-testid="approval-done" className="text-sm mt-2 text-amber-900">
          Decision sent: {decided ?? result}
        </div>
      ) : (
        <div className="mt-2 flex gap-2">
          <button
            data-testid="approve-btn"
            className="bg-emerald-600 text-white text-sm px-3 py-1 rounded"
            onClick={() => decide(true)}
          >
            Approve &amp; run
          </button>
          <button
            data-testid="reject-btn"
            className="bg-rose-600 text-white text-sm px-3 py-1 rounded"
            onClick={() => decide(false)}
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

export const tools: Record<string, ToolDefinition> = {
  confirm_mutation: {
    definition: {
      name: "confirm_mutation",
      description: "Ask the user to approve a SQL mutation before it runs",
      parameters: {
        type: "object",
        properties: {
          sql: { type: "string", description: "The SQL statement needing approval" },
          reason: { type: "string", description: "Why the mutation is needed" },
        },
        required: ["sql"],
      },
    },
    isFrontend: true,
    handler: () =>
      new Promise<string>((resolve) => {
        console.log("[spike4-ui] confirm_mutation handler awaiting user decision");
        pendingResolve = resolve;
      }),
    renderer: (args, result) => <ApprovalCard args={args} result={result} />,
    onResult: (_args, result) => console.log("[spike4-ui] confirm_mutation onResult:", result),
  },
};
