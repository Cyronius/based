export function DefinitionBlock({ definition }: { definition: string }) {
  return (
    <div className="mx-5 mb-4">
      <div className="ledger-label mb-1.5">Definition</div>
      <pre className="text-[length:var(--fs-base)] font-mono text-paper-dim bg-ink-950 border border-line-soft rounded px-3 py-2.5 overflow-auto whitespace-pre">
        {definition}
      </pre>
    </div>
  );
}
