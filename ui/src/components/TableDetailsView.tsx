// Traces: BASED-UI-TABLE-EDIT, BASED-TABLE-SQL-VIEW, BASED-VIEW-DEFINITION (manual)
import type { TableTabState } from "../store";
import { useStore } from "../store";
import type { TableColumn } from "../api/types";
import { engineOf } from "../api/types";
import { TableDataGrid } from "./TableDataGrid";
import { QueryTabView } from "./QueryTabView";
import { DefinitionBlock } from "./DefinitionBlock";

function typeDisplay(c: TableColumn): string {
  const t = c.type;
  if (c.isVector) return `vector${c.vectorDimension ? `[${c.vectorDimension}]` : ""}${c.elementType ? ` ${c.elementType}` : ""}`;
  if (/char|binary/.test(t) && c.maxLength != null) return `${t}(${c.maxLength === -1 ? "MAX" : c.maxLength})`;
  if (/^(decimal|numeric)$/.test(t)) return `${t}(${c.precision},${c.scale})`;
  if (/^(datetime2|datetimeoffset|time)$/.test(t) && c.scale != null) return `${t}(${c.scale})`;
  return t;
}

function ColumnsTable({ tab }: { tab: TableTabState }) {
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

      {tab.definition && <DefinitionBlock definition={tab.definition} />}
    </div>
  );
}

export function TableDetailsView({ tab }: { tab: TableTabState }) {
  const setTableView = useStore((s) => s.setTableView);
  const linkedSqlTab = useStore((s) => s.tabs.find((t) => t.kind === "query" && t.parentTabId === tab.id));
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const connections = useStore((s) => s.connections);
  const activeConn = connections.find((c) => c.id === activeConnectionId);
  const sqlCapable = !activeConn || engineOf(activeConn) === "mssql";

  const tabBtn = (view: "details" | "data" | "sql", label: string) => (
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
        </div>
        <h1 className="font-display text-xl text-paper">
          {tab.schema && (
            <span className="text-muted">{tab.schema}{sqlCapable ? "." : "/"}</span>
          )}
          {tab.table}
        </h1>
        <span className="ledger-label">{tab.objectType}</span>
        {tab.columns && <span className="text-[length:var(--fs-sm)] text-faint font-mono">{tab.columns.length} columns</span>}
      </div>

      {tab.view === "sql" && linkedSqlTab?.kind === "query" && <QueryTabView key={linkedSqlTab.id} tab={linkedSqlTab} />}
      {tab.view === "data" && <TableDataGrid tab={tab} />}
      {tab.view === "details" && <ColumnsTable tab={tab} />}
    </div>
  );
}
