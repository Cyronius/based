// Traces: BASED-UI-EXEC-PLAN — the per-run fetch cap sits next to Run, the control it changes.
import { useState } from "react";
import { useStore } from "../store";

const MAX_FETCH_SIZE = 50_000;

export function FetchSizeInput() {
  const rowPageSize = useStore((s) => s.rowPageSize);
  const setRowPageSize = useStore((s) => s.setRowPageSize);
  const [text, setText] = useState(String(rowPageSize));

  function commit(): void {
    const n = Math.min(MAX_FETCH_SIZE, Math.max(1, Math.floor(Number(text)) || rowPageSize));
    setText(String(n));
    if (n !== rowPageSize) setRowPageSize(n);
  }

  return (
    <label className="flex items-baseline gap-1.5 pl-1 select-none">
      <span className="text-[length:var(--fs-sm)] leading-none text-muted">Rows</span>
      <input
        type="text"
        inputMode="numeric"
        className="field-sizing-content min-w-8 px-1.5 py-1 border border-line-soft rounded-sm bg-transparent text-[length:var(--fs-sm)] leading-none text-muted font-mono focus:text-paper focus:border-brass focus:outline-none"
        value={text}
        title="Max rows to fetch per query run"
        aria-label="Fetch size"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}
