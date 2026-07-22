import type { TableTabState } from "../store";
import type { TableColumn } from "../api/types";

function typeDisplay(c: TableColumn): string {
  const t = c.type;
  if (/char|binary/.test(t) && c.maxLength != null) return `${t}(${c.maxLength === -1 ? "MAX" : c.maxLength})`;
  if (/^(decimal|numeric)$/.test(t)) return `${t}(${c.precision},${c.scale})`;
  if (/^(datetime2|datetimeoffset|time)$/.test(t) && c.scale != null) return `${t}(${c.scale})`;
  return t;
}

export function TableDetailsView({ tab }: { tab: TableTabState }) {
  return (
    <div className="flex-1 min-h-0 overflow-auto bg-ink-900">
      <div className="px-5 pt-4 pb-3 flex items-baseline gap-3">
        <h1 className="font-display text-xl text-paper">
          <span className="text-muted">{tab.schema}.</span>
          {tab.table}
        </h1>
        <span className="ledger-label">{tab.objectType}</span>
        {tab.columns && <span className="text-[11px] text-faint font-mono">{tab.columns.length} columns</span>}
      </div>

      {tab.error && <div className="mx-5 px-3 py-2 text-[12px] text-err bg-err/10 border border-err/30 rounded font-mono">{tab.error}</div>}
      {!tab.columns && !tab.error && <div className="px-5 text-muted pulse-soft text-[12px]">Loading columns…</div>}

      {tab.columns && (
        <table className="mx-5 mb-6 text-[12px] border-collapse">
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
    </div>
  );
}
