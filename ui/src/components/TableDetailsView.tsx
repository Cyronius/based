// Traces: BASED-UI-TABLE-EDIT, BASED-TABLE-SQL-VIEW, BASED-VIEW-DEFINITION (manual), BASED-CAPABILITIES-WIRE,
//         BASED-TABLE-DETAILS-UI (indexes/FKs/constraints/triggers sections + DDL + Script dropdown)
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import type { TableTabState, TableViewId } from "../store";
import { useStore } from "../store";
import { EmbeddingsView } from "./embeddings/EmbeddingsView";
import type { TableColumn, TableDetails, TableIndex } from "../api/types";
import { TableDataGrid } from "./TableDataGrid";
import { QueryTabView } from "./QueryTabView";
import { DefinitionBlock } from "./DefinitionBlock";
import { BottomTabPanel } from "./BottomTabPanel";
import { CellView } from "./CellView";
import { ScriptDropdown } from "./ScriptDropdown";
import { IconButton } from "./IconButton";
import { CopyIcon } from "./icons";

function typeDisplay(c: TableColumn): string {
  const t = c.type;
  if (c.isVector) return `vector${c.vectorDimension ? `[${c.vectorDimension}]` : ""}${c.elementType ? ` ${c.elementType}` : ""}`;
  if (/char|binary/.test(t) && c.maxLength != null) return `${t}(${c.maxLength === -1 ? "MAX" : c.maxLength})`;
  if (/^(decimal|numeric)$/.test(t)) return `${t}(${c.precision},${c.scale})`;
  if (/^(datetime2|datetimeoffset|time)$/.test(t) && c.scale != null) return `${t}(${c.scale})`;
  return t;
}

/** Shared shell for the Details sections (Indexes / Foreign Keys / Constraints / Triggers) —
 *  ledger-table styling matching the columns table; omitted entirely by callers when empty. */
function DetailSection({ label, headers, children }: { label: string; headers: string[]; children: ReactNode }) {
  return (
    <div className="mx-5 mb-4">
      <div className="ledger-label mb-1.5">{label}</div>
      <table className="text-[length:var(--fs-base)] border-collapse">
        <thead>
          <tr className="text-left">
            {headers.map((h) => (
              <th key={h} className="ledger-label font-semibold px-3 py-2 border-b border-line whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const td = "px-3 py-1.5 border-b border-line-soft";

/** Copy-to-clipboard control for a text block (the DDL). Swaps to a transient ✓ because the
 *  clipboard itself gives no feedback that the copy landed. */
function CopyTextButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <IconButton
      size="sm"
      title={copied ? "Copied" : label}
      aria-label={label}
      className={copied ? "text-ok" : "text-faint hover:text-brass"}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
      }}
    >
      {copied ? "✓" : <CopyIcon />}
    </IconButton>
  );
}

// Traces: BASED-INDEX-INTROSPECT — indexes for EVERY engine that exposes them, not just the
// DDL-scriptable ones. It used to live inside DetailSections, which only renders when getTableDetails
// succeeded — i.e. SQL Server only — so a LanceDB table showed no index information at all, and the
// most load-bearing facts about a vector table (is there an FTS index? is it IVF or HNSW? how many
// rows aren't indexed yet?) were invisible in the UI and unanswerable by the agent.
//
// Absence is rendered explicitly rather than hidden: "no indexes" is the actionable fact on a vector
// table, since text/hybrid search cannot run without one.
function IndexSection({ indexes, isVectorEngine }: { indexes: TableIndex[]; isVectorEngine: boolean }) {
  const unindexed = indexes.reduce((n, i) => n + (i.numUnindexedRows ?? 0), 0);
  if (indexes.length === 0) {
    return (
      <div className="mx-5 mb-4">
        <div className="ledger-label mb-1.5">Indexes</div>
        <div className="text-[length:var(--fs-base)] text-muted">
          None.
          {isVectorEngine && " Vector search will run exact (slow but precise); keyword and hybrid search need a full-text index and cannot run."}
        </div>
      </div>
    );
  }
  const headers = isVectorEngine
    ? ["Name", "Type", "Columns", "Metric", "Indexed", "Unindexed"]
    : ["Name", "Type", "Key columns", "Included", "Filter"];
  return (
    <div className="mx-5 mb-4">
      <div className="ledger-label mb-1.5">Indexes</div>
      <table className="text-[length:var(--fs-base)] border-collapse">
        <thead>
          <tr className="text-left">
            {headers.map((h) => (
              <th key={h} className="ledger-label font-semibold px-3 py-2 border-b border-line whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {indexes.map((i) => (
            <tr key={i.name} className="hover:bg-ink-850">
              <td className={`${td} font-mono text-paper`}>
                {i.name}
                {i.isPrimaryKey && (
                  <span className="text-brass ml-1.5" title="Primary key">
                    ⚿
                  </span>
                )}
              </td>
              <td className={`${td} text-muted`}>
                {i.typeDesc.toLowerCase()}
                {i.isUnique && !i.isPrimaryKey ? ", unique" : ""}
                {i.isUniqueConstraint ? " (constraint)" : ""}
              </td>
              <td className={`${td} font-mono text-paper-dim`}>
                {i.keyColumns.map((k) => `${k.name}${k.descending ? " desc" : ""}`).join(", ")}
              </td>
              {isVectorEngine ? (
                <>
                  <td className={`${td} text-muted`}>{i.distanceType ?? ""}</td>
                  <td className={`${td} font-mono text-paper-dim`}>{i.numIndexedRows?.toLocaleString() ?? ""}</td>
                  <td className={`${td} font-mono ${i.numUnindexedRows ? "text-warn" : "text-faint"}`}>
                    {i.numUnindexedRows?.toLocaleString() ?? ""}
                  </td>
                </>
              ) : (
                <>
                  <td className={`${td} font-mono text-faint`}>{i.includedColumns.join(", ")}</td>
                  <td className={`${td} font-mono text-faint`}>{i.filterDefinition ?? ""}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {unindexed > 0 && (
        <div className="mt-1.5 text-[length:var(--fs-sm)] text-warn">
          {unindexed.toLocaleString()} row{unindexed === 1 ? "" : "s"} not yet covered by an index — searches scan those
          exactly, which is the usual reason a search got slow or missed a recently added row.
        </div>
      )}
    </div>
  );
}

// Traces: BASED-TABLE-DETAILS-UI — the enriched sections from getTableDetails. Indexes moved out to
// IndexSection so both engines get them.
function DetailSections({ details }: { details: TableDetails }) {
  return (
    <>
      {details.foreignKeys.length > 0 && (
        <DetailSection label="Foreign keys" headers={["Name", "Columns", "References", "On delete", "On update"]}>
          {details.foreignKeys.map((fk) => (
            <tr key={fk.name} className="hover:bg-ink-850">
              <td className={`${td} font-mono text-paper`}>
                {fk.name}
                {fk.isDisabled && <span className="text-faint ml-1.5">(disabled)</span>}
              </td>
              <td className={`${td} font-mono text-paper-dim`}>{fk.columns.join(", ")}</td>
              <td className={`${td} font-mono text-paper-dim`}>
                {fk.refSchema}.{fk.refTable}({fk.refColumns.join(", ")})
              </td>
              <td className={`${td} text-muted`}>{fk.onDelete.replace(/_/g, " ").toLowerCase()}</td>
              <td className={`${td} text-muted`}>{fk.onUpdate.replace(/_/g, " ").toLowerCase()}</td>
            </tr>
          ))}
        </DetailSection>
      )}

      {(details.checkConstraints.length > 0 || details.defaultConstraints.length > 0) && (
        <DetailSection label="Constraints" headers={["Name", "Kind", "Column", "Definition"]}>
          {details.checkConstraints.map((c) => (
            <tr key={c.name} className="hover:bg-ink-850">
              <td className={`${td} font-mono text-paper`}>
                {c.name}
                {c.isDisabled && <span className="text-faint ml-1.5">(disabled)</span>}
              </td>
              <td className={`${td} text-muted`}>check</td>
              <td className={`${td} font-mono text-paper-dim`}>{c.column ?? ""}</td>
              <td className={`${td} font-mono text-faint`}>{c.definition}</td>
            </tr>
          ))}
          {details.defaultConstraints.map((c) => (
            <tr key={c.name} className="hover:bg-ink-850">
              <td className={`${td} font-mono text-paper`}>{c.name}</td>
              <td className={`${td} text-muted`}>default</td>
              <td className={`${td} font-mono text-paper-dim`}>{c.column}</td>
              <td className={`${td} font-mono text-faint`}>{c.definition}</td>
            </tr>
          ))}
        </DetailSection>
      )}

      {details.triggers.length > 0 && (
        <DetailSection label="Triggers" headers={["Name", "Events", "Timing"]}>
          {details.triggers.map((t) => (
            <tr key={t.name} className="hover:bg-ink-850">
              <td className={`${td} font-mono text-paper`}>
                {t.name}
                {t.isDisabled && <span className="text-faint ml-1.5">(disabled)</span>}
              </td>
              <td className={`${td} text-muted`}>{t.events.map((e) => e.toLowerCase()).join(", ")}</td>
              <td className={`${td} text-muted`}>{t.isInsteadOf ? "instead of" : "after"}</td>
            </tr>
          ))}
        </DetailSection>
      )}
    </>
  );
}

function ColumnsTable({ tab, isVectorEngine }: { tab: TableTabState; isVectorEngine: boolean }) {
  return (
    <div className="flex-1 min-h-0 overflow-auto">
      {tab.error && (
        <div className="mx-5 mt-3 px-3 py-2 text-[length:var(--fs-base)] text-err bg-err/10 border border-err/30 rounded font-mono">{tab.error}</div>
      )}
      {!tab.columns && !tab.error && <div className="px-5 pt-3 text-muted pulse-soft text-[length:var(--fs-base)]">Loading columns…</div>}

      {tab.columns && (
        <table className="mx-5 my-4 text-[length:var(--fs-base)] border-collapse">
          <thead>
            <tr className="text-left">
              {["Key", "Name", "Data Type", "Size", "Nullable", "References"].map((h) => (
                <th key={h} className="ledger-label font-semibold px-3 py-2 border-b border-line whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tab.columns.map((c) => (
              <tr key={c.name} className="hover:bg-ink-850">
                <td className="px-3 py-1.5 border-b border-line-soft text-center">
                  {c.isPrimaryKey && (
                    <span className="text-brass" title="Primary key">
                      ⚿
                    </span>
                  )}
                  {c.isForeignKey && !c.isPrimaryKey && (
                    <span className="text-info" title="Foreign key">
                      ⚷
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 border-b border-line-soft font-mono text-paper">{c.name}</td>
                <td className="px-3 py-1.5 border-b border-line-soft font-mono text-paper-dim">{typeDisplay(c)}</td>
                <td className="px-3 py-1.5 border-b border-line-soft font-mono text-muted text-right">
                  {c.maxLength === -1 ? "MAX" : (c.maxLength ?? "")}
                </td>
                <td className="px-3 py-1.5 border-b border-line-soft text-muted">{c.nullable ? "yes" : "no"}</td>
                <td className="px-3 py-1.5 border-b border-line-soft font-mono text-faint">{c.fkTarget ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab.indexes && <IndexSection indexes={tab.indexes} isVectorEngine={isVectorEngine} />}

      {tab.details && <DetailSections details={tab.details} />}

      {tab.definition && <DefinitionBlock definition={tab.definition} />}
      {/* Traces: BASED-TABLE-DETAILS-UI — tables show their CREATE DDL like views show their definition. */}
      {tab.createScript && (
        <div className="mx-5 mb-4">
          <div className="flex items-center gap-1 mb-1.5">
            <div className="ledger-label">DDL</div>
            <CopyTextButton text={tab.createScript} label="Copy DDL to clipboard" />
          </div>
          <pre className="text-[length:var(--fs-base)] font-mono text-paper-dim bg-ink-950 border border-line-soft rounded px-3 py-2.5 overflow-auto whitespace-pre">
            {tab.createScript}
          </pre>
        </div>
      )}
    </div>
  );
}

/** Data view + a collapsible Cell viewer panel, opened on double-click and closable — mirrors the
 *  Output/Cell tab strip in QueryTabView, but with only a Cell tab (no query log to show here). */
function DataView({ tab, searchCapable }: { tab: TableTabState; searchCapable: boolean }) {
  const cellPanelRef = useRef<ImperativePanelHandle>(null);
  const [cellOpen, setCellOpen] = useState(false);
  const [cellText, setCellText] = useState<string | null>(null);

  // Start collapsed — the panel only matters once a cell has been double-clicked.
  useLayoutEffect(() => {
    cellPanelRef.current?.collapse();
  }, []);

  const openCell = (text: string) => {
    setCellText(text);
    setCellOpen(true);
    cellPanelRef.current?.expand();
  };

  return (
    <PanelGroup direction="vertical" className="flex-1 min-h-0" autoSaveId={`table-data:${tab.id}`}>
      <Panel minSize={20}>
        <TableDataGrid tab={tab} searchCapable={searchCapable} onCellTextChange={setCellText} onCellActivate={openCell} />
      </Panel>
      <PanelResizeHandle className="pane-handle" />
      <Panel ref={cellPanelRef} defaultSize={20} minSize={6} collapsible collapsedSize={0}>
        {cellOpen && (
          <BottomTabPanel
            tabs={[{ id: "cell", label: "Cell", content: <CellView text={cellText} /> }]}
            activeId="cell"
            onActivate={() => {}}
            onClose={() => {
              setCellOpen(false);
              cellPanelRef.current?.collapse();
            }}
          />
        )}
      </Panel>
    </PanelGroup>
  );
}

export function TableDetailsView({ tab }: { tab: TableTabState }) {
  const setTableView = useStore((s) => s.setTableView);
  const linkedSqlTab = useStore((s) => s.tabs.find((t) => t.kind === "query" && t.parentTabId === tab.id));
  const capabilities = useStore((s) => s.capabilities);
  const sqlCapable = capabilities?.sql ?? true;
  const searchCapable = capabilities?.search ?? false;

  // Traces: BASED-EMBED-UI — the Embeddings sub-view exists only where it can work: a search-
  // capable engine (LanceDB) and a table that actually has a vector column.
  const embedCapable = searchCapable && (tab.columns?.some((c) => c.isVector) ?? false);

  const tabBtn = (view: TableViewId, label: string) => (
    <button
      className={`px-2.5 py-1 text-[length:var(--fs-base)] rounded border ${
        tab.view === view ? "border-brass-soft/60 text-brass bg-brass/5" : "border-line text-muted hover:text-paper"
      }`}
      onClick={() => setTableView(tab.id, view)}
    >
      {label}
    </button>
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-ink-900">
      <div className="px-5 pt-4 pb-3 flex items-center gap-3 shrink-0">
        <div className="flex items-center gap-1.5">
          {tabBtn("details", "Details")}
          {tabBtn("data", "Data")}
          {sqlCapable && tabBtn("sql", "SQL")}
          {embedCapable && tabBtn("embeddings", "Embeddings")}
          {capabilities?.script && <ScriptDropdown schema={tab.schema} name={tab.table} type={tab.objectType} />}
        </div>
        <h1 className="font-display text-xl text-paper">
          {tab.schema && (
            <span className="text-muted">{tab.schema}{sqlCapable ? "." : "/"}</span>
          )}
          {tab.table}
        </h1>
        <span className="ledger-label">{tab.objectType}</span>
        {tab.columns && <span className="text-[length:var(--fs-sm)] text-faint font-mono">{tab.columns.length} columns</span>}
        {/* Traces: BASED-LANCE-SCAN — the exact total, so "how big is this table" never needs a query. */}
        {tab.rowCount != null && (
          <span className="text-[length:var(--fs-sm)] text-faint font-mono">{tab.rowCount.toLocaleString()} rows</span>
        )}
      </div>

      {tab.view === "sql" && linkedSqlTab?.kind === "query" && <QueryTabView key={linkedSqlTab.id} tab={linkedSqlTab} />}
      {tab.view === "data" && <DataView key={tab.id} tab={tab} searchCapable={searchCapable} />}
      {tab.view === "details" && <ColumnsTable tab={tab} isVectorEngine={searchCapable} />}
      {tab.view === "embeddings" && embedCapable && <EmbeddingsView key={tab.id} tab={tab} />}
    </div>
  );
}
