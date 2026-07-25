// Traces: BASED-ROUTINE-DETAILS, BASED-UI-EXPLORER (manual), BASED-TABLE-DETAILS-UI (Script dropdown)
import type { RoutineTabState } from "../store";
import { useStore } from "../store";
import { DefinitionBlock } from "./DefinitionBlock";
import { ScriptDropdown } from "./ScriptDropdown";

function ParametersTable({ tab }: { tab: RoutineTabState }) {
  return (
    <div className="flex-1 min-h-0 overflow-auto">
      {tab.error && (
        <div className="mx-5 mt-3 px-3 py-2 text-[length:var(--fs-base)] text-err bg-err/10 border border-err/30 rounded font-mono">{tab.error}</div>
      )}
      {!tab.parameters && !tab.error && <div className="px-5 pt-3 text-muted pulse-soft text-[length:var(--fs-base)]">Loading definition…</div>}

      {tab.parameters && tab.parameters.length > 0 && (
        <table className="mx-5 my-4 text-[length:var(--fs-base)] border-collapse">
          <thead>
            <tr className="text-left">
              {["#", "Name", "Type", "Mode"].map((h) => (
                <th key={h} className="ledger-label font-semibold px-3 py-2 border-b border-line whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tab.parameters.map((p) => (
              <tr key={p.ordinal} className="hover:bg-ink-850">
                <td className="px-3 py-1.5 border-b border-line-soft font-mono text-muted text-right">{p.ordinal}</td>
                <td className="px-3 py-1.5 border-b border-line-soft font-mono text-paper">{p.name}</td>
                <td className="px-3 py-1.5 border-b border-line-soft font-mono text-paper-dim">{p.type}</td>
                <td className="px-3 py-1.5 border-b border-line-soft text-muted">{p.mode}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {tab.parameters && tab.parameters.length === 0 && (
        <div className="px-5 pt-3 text-faint text-[length:var(--fs-base)] italic">No parameters.</div>
      )}

      {tab.definition && <DefinitionBlock definition={tab.definition} />}
    </div>
  );
}

export function RoutineDetailsView({ tab }: { tab: RoutineTabState }) {
  const capabilities = useStore((s) => s.capabilities);
  return (
    <div className="flex-1 min-h-0 flex flex-col bg-ink-900">
      <div className="px-5 pt-4 pb-3 flex items-center gap-3 shrink-0">
        {capabilities?.script && <ScriptDropdown schema={tab.schema} name={tab.name} type={tab.routineType} />}
        <h1 className="font-display text-xl text-paper">
          <span className="text-muted">{tab.schema}.</span>
          {tab.name}
        </h1>
        <span className="ledger-label">{tab.routineType}</span>
        {tab.parameters && <span className="text-[length:var(--fs-sm)] text-faint font-mono">{tab.parameters.length} parameters</span>}
      </div>
      <ParametersTable tab={tab} />
    </div>
  );
}
