export function CellView({ text }: { text: string | null }) {
  return (
    <div className="h-full overflow-auto px-3 py-2 font-mono text-[length:var(--fs-sm)] leading-relaxed whitespace-pre-wrap break-words text-paper-dim">
      {text === null ? <span className="text-faint italic">No cell selected.</span> : text}
    </div>
  );
}
