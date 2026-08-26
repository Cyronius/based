// Traces: BASED-CHAT-UI, BASED-AGENT-MUTATION-GATE (frontend half), BASED-AGENT-TAB-TOOLS,
//         BASED-AGENT-SHOW-RESULTS, BASED-AGENT-SURFACE-VARIANT
// Frontend agent tools — handlers and approval-card renderers. The schemas the model actually sees,
// and the capability policy that decides which of these are offered at all, live in ./capiToolDefs
// (React- and store-free, so they can be asserted directly).
//
// `run_mutation`: the agent proposes SQL, we render an approval card, and only the user's Approve
// reaches the gated /api/agent/mutation endpoint. `list_tabs`/`get_tab`: read the workspace (tab
// list, a tab's SQL/results) from the store on demand. `show_results`: puts rows in front of the
// user in a real grid rather than in chat — a query tab where SQL exists, the table's data grid
// where it doesn't. Agent-opened tabs need no thread bookkeeping — the chat is per-window
// (BASED-AGENT-THREADS).
import { useEffect, useState } from "react";
import type { ToolDefinition } from "@itkennel/lm-ag-ui";
import { api, inspectCsv, runAgentCreateTable, runAgentMutation, streamCsvImport, type CreateTableRequest, type CsvImportChunk } from "../api/client";
import type { EngineCapabilities, MutationResult, TableColumn } from "../api/types";
import { capiToolDefs, filterToolsByCapabilities } from "./capiToolDefs";
import { useStore, type QueryTabState } from "../store";
import { buildTabContext, serializeResultRows } from "./tabContext";

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
      {args?.reason && <div className="mb-2 text-[length:var(--fs-base)] text-paper-dim">{args.reason}</div>}
      <pre className="mb-2 overflow-x-auto rounded bg-ink-950 p-2 text-[length:var(--fs-sm)] font-mono text-paper-dim border border-line-soft">
        {sql}
      </pre>
      {phase === "idle" ? (
        <div className="flex gap-2">
          <button
            className="rounded bg-ok/20 px-3 py-1 text-[length:var(--fs-base)] text-ok border border-ok/40 hover:bg-ok/30"
            onClick={approve}
          >
            Approve &amp; run
          </button>
          <button
            className="rounded bg-err/15 px-3 py-1 text-[length:var(--fs-base)] text-err border border-err/40 hover:bg-err/25"
            onClick={reject}
          >
            Reject
          </button>
        </div>
      ) : phase === "running" ? (
        <div className="text-[length:var(--fs-base)] text-muted pulse-soft">Running…</div>
      ) : phase === "rejected" ? (
        <div className="text-[length:var(--fs-base)] text-err">Rejected — nothing ran.</div>
      ) : (
        <div className="text-[length:var(--fs-base)] text-ok">{outcome}</div>
      )}
    </div>
  );
}

const GET_TAB_DEFAULT_ROWS = 50;
const GET_TAB_MAX_ROWS = 200;
const OPEN_TAB_PREVIEW_ROWS = 10;
const OPEN_TAB_RUN_TIMEOUT_MS = 15_000;
const DEFINITION_CAP = 4_000;

function clip(text: string | null | undefined): string | null {
  if (text == null) return null;
  return text.length > DEFINITION_CAP ? `${text.slice(0, DEFINITION_CAP)}\n-- …truncated…` : text;
}

/** "Opened <tab>" chip rendered under a show_results call — click refocuses the tab. */
function OpenedTabChip({ result }: { result: string }) {
  let parsed: { tabId?: string; title?: string; status?: string } = {};
  try {
    parsed = JSON.parse(result) as typeof parsed;
  } catch {
    // unparseable result → no chip
  }
  if (!parsed.tabId) return null;
  const tabId = parsed.tabId;
  return (
    <button
      className="my-1 inline-flex items-center gap-1.5 rounded border border-brass/40 bg-brass/10 px-2.5 py-1 text-[length:var(--fs-sm)] text-brass hover:bg-brass/20"
      onClick={() => useStore.getState().activateTab(tabId)}
    >
      <span>Opened</span>
      <span className="font-semibold">{parsed.title ?? "tab"}</span>
      {parsed.status === "running" && <span className="text-muted">(still running)</span>}
    </button>
  );
}

function summarizeQueryTab(tab: QueryTabState, previewRows: number) {
  return {
    tabId: tab.id,
    title: tab.title,
    status: tab.running ? "running" : (tab.stats?.status ?? "not_run"),
    durationMs: tab.stats?.durationMs,
    resultSets: tab.resultSets.map((rs) => ({ columns: rs.columns.map((c) => c.name), rowCount: rs.rowCount, truncated: rs.truncated })),
    preview: tab.resultSets[0] ? serializeResultRows(tab.resultSets[0], previewRows) : null,
    errors: tab.output.filter((l) => l.kind === "error").map((l) => l.text),
  };
}

// Traces: BASED-AGENT-IMPORT — the gated import card. Import writes rows, so it follows the
// run_mutation doctrine: the agent only PROPOSES (file → table, mapping); the card previews the
// file and resolved mapping, and only the user's Approve drives the existing /api/import/csv/run
// endpoint (which the server gates on capabilities.write).
let pendingImportResolve: ((v: string) => void) | null = null;

interface ImportArgs {
  path?: string;
  schema?: string;
  table?: string;
  hasHeader?: boolean;
  mapping?: Array<{ csvIndex: number; column: string }>;
  nullEmpty?: boolean;
  skipBadRows?: boolean;
  reason?: string;
}

/** Auto-map CSV columns to table columns: by header name (case-insensitive) when there's a header,
 *  else by position. Returns the mapping plus any unmatched CSV column labels for the warning row. */
function autoMapCsv(
  header: string[],
  hasHeader: boolean,
  columns: TableColumn[],
): { mapping: Array<{ csvIndex: number; column: string }>; unmatched: string[] } {
  const mapping: Array<{ csvIndex: number; column: string }> = [];
  const unmatched: string[] = [];
  if (hasHeader) {
    const byLower = new Map(columns.map((c) => [c.name.toLowerCase(), c.name]));
    header.forEach((h, i) => {
      const col = byLower.get(h.trim().toLowerCase());
      if (col) mapping.push({ csvIndex: i, column: col });
      else unmatched.push(h || `(column ${i + 1})`);
    });
  } else {
    const n = Math.min(header.length, columns.length);
    for (let i = 0; i < n; i++) mapping.push({ csvIndex: i, column: columns[i]!.name });
  }
  return { mapping, unmatched };
}

function ImportApprovalCard({ args }: { args: ImportArgs }) {
  const [phase, setPhase] = useState<"loading" | "idle" | "running" | "done" | "rejected" | "invalid">("loading");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ header: string[]; sampleRows: number } | null>(null);
  const [mapping, setMapping] = useState<Array<{ csvIndex: number; column: string }>>([]);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ inserted: number; totalRows: number } | null>(null);
  const [outcome, setOutcome] = useState<string>("");

  const schema = args.schema ?? "dbo";
  const table = args.table ?? "";
  const hasHeader = args.hasHeader !== false;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!args.path || !table) throw new Error("import_csv needs both a file path and a target table");
        const caps = useStore.getState().capabilities;
        if (caps && !caps.write) throw new Error("This connection is read-only — it does not support imports.");
        const [{ header, rows }, columns] = await Promise.all([
          inspectCsv(args.path),
          api<TableColumn[]>(`/api/session/columns?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`),
        ]);
        if (cancelled) return;
        if (columns.length === 0) throw new Error(`No columns found for ${schema}.${table}`);
        if (args.mapping?.length) {
          const valid = new Set(columns.map((c) => c.name));
          const bad = args.mapping.find((m) => !valid.has(m.column));
          if (bad) throw new Error(`Proposed mapping targets unknown column "${bad.column}"`);
          setMapping(args.mapping);
        } else {
          const auto = autoMapCsv(header, hasHeader, columns);
          if (auto.mapping.length === 0) throw new Error("No CSV columns could be mapped to the table's columns");
          setMapping(auto.mapping);
          setUnmatched(auto.unmatched);
        }
        setPreview({ header, sampleRows: rows.length });
        setPhase("idle");
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setPhase("invalid");
        pendingImportResolve?.(JSON.stringify({ approved: false, error: msg }));
        pendingImportResolve = null;
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot per card
  }, []);

  const approve = async () => {
    setPhase("running");
    let summary = "";
    try {
      let final: Extract<CsvImportChunk, { type: "done" }> | null = null;
      const rowErrors: string[] = [];
      await streamCsvImport(
        {
          path: args.path!,
          schema,
          table,
          hasHeader,
          mapping,
          nullEmpty: args.nullEmpty !== false,
          skipBadRows: args.skipBadRows === true,
        },
        (chunk) => {
          if (chunk.type === "progress") setProgress({ inserted: chunk.inserted, totalRows: chunk.totalRows });
          else if (chunk.type === "rowError") rowErrors.push(`row ${chunk.row}: ${chunk.error}`);
          else final = chunk;
        },
      );
      const doneChunk = final as Extract<CsvImportChunk, { type: "done" }> | null;
      if (doneChunk?.status === "ok") {
        summary = `Imported ${doneChunk.inserted} row(s) into ${schema}.${table} in ${doneChunk.durationMs} ms${doneChunk.failed > 0 ? `; ${doneChunk.failed} row(s) skipped` : ""}.`;
      } else {
        summary = `Import failed: ${doneChunk?.error ?? "unknown error"}${doneChunk?.inserted ? ` (${doneChunk.inserted} rows committed before the failure)` : ""}`;
      }
      setOutcome(summary);
      setPhase("done");
      pendingImportResolve?.(
        JSON.stringify({
          approved: true,
          status: doneChunk?.status ?? "error",
          inserted: doneChunk?.inserted ?? 0,
          failed: doneChunk?.failed ?? 0,
          summary,
          rowErrors: rowErrors.slice(0, 10),
        }),
      );
    } catch (err) {
      summary = err instanceof Error ? err.message : String(err);
      setOutcome(summary);
      setPhase("done");
      pendingImportResolve?.(JSON.stringify({ approved: true, status: "error", summary }));
    }
    pendingImportResolve = null;
  };

  const reject = () => {
    setPhase("rejected");
    pendingImportResolve?.(JSON.stringify({ approved: false }));
    pendingImportResolve = null;
  };

  return (
    <div className="my-2 rounded-md border border-brass/40 bg-brass/5 p-3">
      <div className="ledger-label mb-1 text-brass">Import approval</div>
      {args.reason && <div className="mb-2 text-[length:var(--fs-base)] text-paper-dim">{args.reason}</div>}
      <div className="mb-2 text-[length:var(--fs-base)] text-paper-dim">
        <span className="font-mono break-all">{args.path}</span>
        <span className="text-muted"> → </span>
        <span className="font-semibold">
          {schema}.{table}
        </span>
      </div>
      {phase === "loading" ? (
        <div className="text-[length:var(--fs-base)] text-muted pulse-soft">Reading the file…</div>
      ) : phase === "invalid" ? (
        <div className="text-[length:var(--fs-base)] text-err">{error}</div>
      ) : (
        <>
          {preview && (
            <div className="mb-2 text-[length:var(--fs-sm)] text-muted">
              {mapping.length} column(s) mapped
              {hasHeader ? ` from header (${preview.header.length} CSV columns)` : " by position"}
              {unmatched.length > 0 && <span className="text-warn"> — unmapped: {unmatched.join(", ")}</span>}
            </div>
          )}
          {mapping.length > 0 && phase === "idle" && (
            <pre className="mb-2 overflow-x-auto rounded bg-ink-950 p-2 text-[length:var(--fs-sm)] font-mono text-paper-dim border border-line-soft">
              {mapping.map((m) => `csv[${m.csvIndex}] → ${m.column}`).join("\n")}
            </pre>
          )}
          {phase === "idle" ? (
            <div className="flex gap-2">
              <button className="rounded bg-ok/20 px-3 py-1 text-[length:var(--fs-base)] text-ok border border-ok/40 hover:bg-ok/30" onClick={approve}>
                Approve &amp; import
              </button>
              <button className="rounded bg-err/15 px-3 py-1 text-[length:var(--fs-base)] text-err border border-err/40 hover:bg-err/25" onClick={reject}>
                Reject
              </button>
            </div>
          ) : phase === "running" ? (
            <div className="text-[length:var(--fs-base)] text-muted pulse-soft">
              Importing…{progress ? ` ${progress.inserted}/${progress.totalRows} rows` : ""}
            </div>
          ) : phase === "rejected" ? (
            <div className="text-[length:var(--fs-base)] text-err">Rejected — nothing was imported.</div>
          ) : (
            <div className="text-[length:var(--fs-base)] text-ok">{outcome}</div>
          )}
        </>
      )}
    </div>
  );
}

// Traces: BASED-AGENT-LANCE-CREATE — the gated create-table card. Lance writes are SDK calls, not
// SQL, so table creation gets its own proposal card (BASED-AGENT-MUTATION-GATE's design
// constraint) instead of riding run_mutation; only the user's Approve reaches the gated
// /api/agent/create-table endpoint, which re-checks the capability server-side.
let pendingCreateResolve: ((v: string) => void) | null = null;

interface CreateTableArgs {
  name?: string;
  folder?: string;
  columns?: CreateTableRequest["columns"];
  reason?: string;
}

function CreateTableApprovalCard({ args }: { args: CreateTableArgs }) {
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "rejected">("idle");
  const [outcome, setOutcome] = useState("");
  const [failed, setFailed] = useState(false);
  const cols = args.columns ?? [];
  const target = `${args.folder ? `${args.folder}.` : ""}${args.name ?? ""}`;

  const approve = async () => {
    setPhase("running");
    try {
      const res = await runAgentCreateTable({ name: args.name ?? "", folder: args.folder, columns: cols });
      const text = `Created ${target} in ${res.durationMs} ms.`;
      setOutcome(text);
      setPhase("done");
      void useStore.getState().refreshObjects();
      pendingCreateResolve?.(JSON.stringify({ approved: true, status: "ok", summary: text }));
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setFailed(true);
      setOutcome(text);
      setPhase("done");
      pendingCreateResolve?.(JSON.stringify({ approved: true, status: "error", summary: text }));
    }
    pendingCreateResolve = null;
  };

  const reject = () => {
    setPhase("rejected");
    pendingCreateResolve?.(JSON.stringify({ approved: false }));
    pendingCreateResolve = null;
  };

  return (
    <div className="my-2 rounded-md border border-brass/40 bg-brass/5 p-3">
      <div className="ledger-label mb-1 text-brass">New table approval</div>
      {args.reason && <div className="mb-2 text-[length:var(--fs-base)] text-paper-dim">{args.reason}</div>}
      <div className="mb-2 text-[length:var(--fs-base)] text-paper-dim">
        <span className="font-semibold">{target}</span>
        <span className="text-muted"> — new empty table</span>
      </div>
      <pre className="mb-2 overflow-x-auto rounded bg-ink-950 p-2 text-[length:var(--fs-sm)] font-mono text-paper-dim border border-line-soft">
        {cols.map((c) => `${c.name} ${c.type}${c.type === "vector" && c.dim ? `(${c.dim})` : ""}`).join("\n") || "(no columns)"}
      </pre>
      {phase === "idle" ? (
        <div className="flex gap-2">
          <button
            className="rounded bg-ok/20 px-3 py-1 text-[length:var(--fs-base)] text-ok border border-ok/40 hover:bg-ok/30"
            onClick={approve}
          >
            Approve &amp; create
          </button>
          <button
            className="rounded bg-err/15 px-3 py-1 text-[length:var(--fs-base)] text-err border border-err/40 hover:bg-err/25"
            onClick={reject}
          >
            Reject
          </button>
        </div>
      ) : phase === "running" ? (
        <div className="text-[length:var(--fs-base)] text-muted pulse-soft">Creating…</div>
      ) : phase === "rejected" ? (
        <div className="text-[length:var(--fs-base)] text-err">Rejected — nothing was created.</div>
      ) : (
        <div className={`text-[length:var(--fs-base)] ${failed ? "text-err" : "text-ok"}`}>{outcome}</div>
      )}
    </div>
  );
}

export const capiTools: Record<string, ToolDefinition> = {
  list_tabs: {
    definition: capiToolDefs.list_tabs,
    isFrontend: true,
    handler: () => {
      const state = useStore.getState();
      const ctx = buildTabContext(state);
      const tabs = ctx.openTabs.map((t) => {
        const full = state.tabs.find((x) => x.id === t.id);
        if (full?.kind === "query") {
          return {
            ...t,
            running: full.running,
            resultSets: full.resultSets.map((rs) => ({ rowCount: rs.rowCount, truncated: rs.truncated })),
          };
        }
        return t;
      });
      return JSON.stringify({ activeTabId: state.activeTabId, tabs });
    },
  },

  get_tab: {
    definition: capiToolDefs.get_tab,
    isFrontend: true,
    handler: (args: { tabId?: string; maxRows?: number }) => {
      const state = useStore.getState();
      const tab = state.tabs.find((t) => t.id === args.tabId);
      if (!tab) {
        return JSON.stringify({
          error: `Unknown tab "${args.tabId}"`,
          validTabIds: state.tabs.filter((t) => !(t.kind === "query" && t.parentTabId)).map((t) => t.id),
        });
      }
      if (tab.kind === "query") {
        const maxRows = Math.max(1, Math.min(GET_TAB_MAX_ROWS, Math.floor(args.maxRows ?? GET_TAB_DEFAULT_ROWS)));
        return JSON.stringify({
          ...summarizeQueryTab(tab, maxRows),
          sql: tab.content,
          results: tab.resultSets.map((rs) => serializeResultRows(rs, maxRows)),
          output: tab.output.map((l) => `${l.kind}: ${l.text}`),
        });
      }
      if (tab.kind === "table") {
        return JSON.stringify({
          tabId: tab.id,
          kind: tab.kind,
          title: tab.title,
          schema: tab.schema,
          table: tab.table,
          objectType: tab.objectType,
          view: tab.view,
          columns: tab.columns?.map((c) => ({ name: c.name, type: c.type, nullable: c.nullable, isPrimaryKey: c.isPrimaryKey })),
          definition: clip(tab.definition),
        });
      }
      if (tab.kind === "routine") {
        return JSON.stringify({
          tabId: tab.id,
          kind: tab.kind,
          title: tab.title,
          schema: tab.schema,
          name: tab.name,
          routineType: tab.routineType,
          parameters: tab.parameters,
          definition: clip(tab.definition),
        });
      }
      return JSON.stringify({ tabId: tab.id, kind: tab.kind, title: tab.title });
    },
  },

  // Traces: BASED-AGENT-SHOW-RESULTS — "put the rows in a real grid" as one stable tool name across
  // every engine. On a SQL connection it opens and runs a query tab; on one without SQL (LanceDB
  // Cloud) it opens the table's Data tab with an optional `where`. Dropping it on SQL-less
  // connections would take the "don't paste rows into chat" norm away exactly where the agent also
  // can't aggregate, which is the worst possible place to lose it.
  show_results: {
    definition: capiToolDefs.show_results,
    isFrontend: true,
    handler: async (args: { sql?: string; table?: string; where?: string; schema?: string; run?: boolean; title?: string }) => {
      const sql = args.sql ?? "";
      const store = useStore.getState();
      if (!sql.trim()) {
        if (!args.table?.trim()) return JSON.stringify({ error: "Provide `sql` (SQL connections) or `table` (connections without SQL)." });
        const tabId = await store.openTableTabWithQuery(args.schema ?? "", args.table, args.where?.trim() || undefined);
        return JSON.stringify({
          tabId,
          status: "opened",
          table: args.table,
          where: args.where ?? null,
          note: "The table's data grid is now open for the user, filtered as requested.",
        });
      }
      const tabId = store.newQueryTabWithContent(args.title ?? null, sql);
      if (!tabId) {
        return JSON.stringify({
          error: "This connection has no SQL editor — pass `table` (and optionally `where`) instead of `sql`.",
        });
      }
      if (args.run === false) {
        return JSON.stringify({ tabId, title: args.title ?? useStore.getState().tabs.find((t) => t.id === tabId)?.title, status: "not_run" });
      }
      const runPromise = useStore.getState().runQuery(tabId);
      const timedOut = await Promise.race([
        runPromise.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), OPEN_TAB_RUN_TIMEOUT_MS)),
      ]);
      const tab = useStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== "query") return JSON.stringify({ tabId, status: "unknown" });
      if (timedOut && tab.running) {
        return JSON.stringify({
          tabId,
          title: tab.title,
          status: "running",
          note: "The query is still executing; results will appear in the tab when it finishes.",
        });
      }
      return JSON.stringify(summarizeQueryTab(tab, OPEN_TAB_PREVIEW_ROWS));
    },
    renderer: (_args, result) => <OpenedTabChip result={result} />,
  },

  import_csv: {
    definition: capiToolDefs.import_csv,
    isFrontend: true,
    handler: () =>
      new Promise<string>((resolve) => {
        pendingImportResolve = resolve;
      }),
    renderer: (args) => <ImportApprovalCard args={args as ImportArgs} />,
  },

  run_mutation: {
    definition: capiToolDefs.run_mutation,
    isFrontend: true,
    handler: () =>
      new Promise<string>((resolve) => {
        pendingResolve = resolve;
      }),
    renderer: (args) => <ApprovalCard args={args as { sql?: string; reason?: string }} />,
  },

  create_table: {
    definition: capiToolDefs.create_table,
    isFrontend: true,
    handler: () =>
      new Promise<string>((resolve) => {
        pendingCreateResolve = resolve;
      }),
    renderer: (args) => <CreateTableApprovalCard args={args as CreateTableArgs} />,
  },
};

// Traces: BASED-AGENT-SURFACE-VARIANT — frontend tools were previously handed to the model
// unconditionally, so `run_mutation` and `import_csv` were advertised on read-only LanceDB
// connections. The backend surface test asserting "no run_mutation" only ever inspected the backend
// half, so nothing caught it: the agent would cheerfully offer to fix data on a connection that
// cannot accept a write, and look incompetent when it was refused. The tools a model can see are the
// tools it will eventually propose, so the ones that can't work here are removed, not error-gated.
export function capiToolsFor(capabilities: EngineCapabilities | null): Record<string, ToolDefinition> {
  return filterToolsByCapabilities(capiTools, capabilities);
}
