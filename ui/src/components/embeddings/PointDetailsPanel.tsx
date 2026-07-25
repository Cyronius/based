// Traces: BASED-EMBED-UI
// Dossier for a clicked point: the row's non-vector cells (already client-side from the vector
// sample — no refetch), plus the find-similar trigger. Mirrors the Data view's cell-panel tone.
import { cellText, type VectorSampleHeader } from "../../api/types";
import { IconButton } from "../IconButton";

export function PointDetailsPanel({
  header,
  index,
  clusterName,
  similarActive,
  onFindSimilar,
  onClearSimilar,
  onClose,
}: {
  header: VectorSampleHeader;
  index: number;
  clusterName: string | null;
  similarActive: boolean;
  onFindSimilar: () => void;
  onClearSimilar: () => void;
  onClose: () => void;
}) {
  const row = header.rows[index];
  return (
    <div className="h-full flex flex-col bg-ink-950 border-l border-line-soft">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-line-soft shrink-0">
        <span className="ledger-label">Point</span>
        <span className="font-mono text-[length:var(--fs-sm)] text-paper-dim">#{index}</span>
        {clusterName && <span className="text-[length:var(--fs-sm)] text-brass truncate">{clusterName}</span>}
        <div className="flex-1" />
        <IconButton size="sm" title="Close" aria-label="Close" className="text-muted hover:text-paper" onClick={onClose}>
          ✕
        </IconButton>
      </div>
      <div className="px-3 py-2 flex gap-2 shrink-0">
        {!similarActive ? (
          <button
            className="px-2.5 py-1 text-[length:var(--fs-base)] rounded border border-line text-muted hover:text-paper hover:border-brass-soft/60"
            onClick={onFindSimilar}
          >
            Find similar
          </button>
        ) : (
          <button
            className="px-2.5 py-1 text-[length:var(--fs-base)] rounded border border-brass-soft/60 text-brass bg-brass/5"
            onClick={onClearSimilar}
          >
            Clear similar
          </button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-3 pb-3">
        <table className="w-full text-[length:var(--fs-sm)] border-collapse">
          <tbody>
            {header.columns.map((c, i) => (
              <tr key={c.name} className="align-top">
                <td className="py-1 pr-3 font-mono text-muted whitespace-nowrap">{c.name}</td>
                <td className="py-1 font-mono text-paper-dim wrap-anywhere whitespace-pre-wrap">
                  {row?.[i] == null ? <span className="text-faint italic">NULL</span> : cellText(row[i]!)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
