// Traces: BASED-TABLE-DETAILS-UI, BASED-UI-SCRIPT-AS
// "Script ▾" dropdown shared by the table and routine detail views: scripts the object via
// /api/session/script into a new query tab. Gated by callers on capabilities.script.
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { ScriptAction } from "../api/types";

export type ScriptableType = "table" | "view" | "procedure" | "function";

/** The SSMS-parity action menu per object type: tables have no ALTER; only tables get INSERT;
 *  tables and views get SELECT. */
export function actionsFor(type: ScriptableType): Array<{ action: ScriptAction; label: string }> {
  const acts: Array<{ action: ScriptAction; label: string }> = [{ action: "create", label: "Script as create" }];
  if (type !== "table") acts.push({ action: "alter", label: "Script as alter" });
  acts.push({ action: "drop", label: "Script as drop" }, { action: "drop-create", label: "Script as drop and create" });
  if (type === "table" || type === "view") acts.push({ action: "select", label: "Script as select" });
  if (type === "table") acts.push({ action: "insert", label: "Script as insert" });
  return acts;
}

export function ScriptDropdown({ schema, name, type }: { schema: string; name: string; type: ScriptableType }) {
  const scriptObjects = useStore((s) => s.scriptObjects);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        className={`px-2.5 py-1 text-[length:var(--fs-base)] rounded border ${
          open ? "border-brass-soft/60 text-brass bg-brass/5" : "border-line text-muted hover:text-paper"
        }`}
        onClick={() => setOpen(!open)}
      >
        Script ▾
      </button>
      {open && (
        <div className="absolute z-30 mt-1 left-0 w-56 rounded border border-line bg-ink-850 shadow-xl shadow-black/40 fade-up py-1">
          {actionsFor(type).map(({ action, label }) => (
            <button
              key={action}
              className="w-full text-left px-3 py-1.5 text-[length:var(--fs-base)] text-paper-dim hover:bg-ink-900"
              onClick={() => {
                setOpen(false);
                void scriptObjects([{ schema, name, type }], action);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
