// Traces: BASED-HELP-DOCS — the help tab's content. The shortcut table must match the canonical
// one in BASED-UI-SHORTCUTS; the vim section must match BASED-EDITOR-VIM. Static content; the only
// state is a one-shot "scroll to this section" request from a ? button elsewhere.
import { useEffect, type ReactNode } from "react";
import { useStore } from "../store";
import { accel, cancelLabel, isMac } from "../platform";

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-block font-mono text-[length:var(--fs-sm)] text-paper-dim bg-ink-850 border border-line border-b-2 rounded px-1.5 py-0.5">
      {children}
    </kbd>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[length:var(--fs-base)] text-brass">{children}</code>;
}

function Rows({ rows }: { rows: Array<[ReactNode, ReactNode]> }) {
  return (
    <table className="w-full border-collapse mt-2">
      <tbody>
        {rows.map(([keys, what], i) => (
          <tr key={i}>
            <td className="w-px whitespace-nowrap align-baseline py-1.5 pr-8 border-b border-line-soft">{keys}</td>
            <td className="align-baseline py-1.5 border-b border-line-soft text-paper-dim">{what}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const SHORTCUTS: Array<[ReactNode, ReactNode]> = [
  [<Kbd>F5</Kbd>, "Run the selection, or the whole query tab when nothing is selected"],
  [<Kbd>{accel("Enter")}</Kbd>, "Run the selection, or the statement at the cursor"],
  [<Kbd>{cancelLabel}</Kbd>, "Cancel the running query"],
  [
    <Kbd>{accel("S")}</Kbd>,
    <>
      Save tab to <Mono>.sql</Mono> (overwrites in place when file-backed)
    </>,
  ],
  [
    <Kbd>{accel("Shift+S")}</Kbd>,
    <>
      Save to a new <Mono>.sql</Mono> file
    </>,
  ],
  [
    <Kbd>{accel("O")}</Kbd>,
    <>
      Open a <Mono>.sql</Mono> file
    </>,
  ],
  [<Kbd>{accel("T")}</Kbd>, "New query tab"],
  [<Kbd>{accel("W")}</Kbd>, "Close the active tab"],
  [<Kbd>{accel("Shift+T")}</Kbd>, "Reopen the last closed tab (or the whole batch from Close All)"],
  [
    <>
      <Kbd>Ctrl+PageUp</Kbd> / <Kbd>Ctrl+PageDown</Kbd>
    </>,
    "Previous / next tab",
  ],
  [<Kbd>{accel("J")}</Kbd>, "Toggle the Capi rail"],
  [<Kbd>{accel("N")}</Kbd>, "New window"],
  [
    <>
      <Kbd>{isMac ? "Pinch" : "Ctrl+Scroll"}</Kbd> / <Kbd>{accel("=")}</Kbd> / <Kbd>{accel("-")}</Kbd>
    </>,
    "Zoom the app text size in / out",
  ],
  [<Kbd>{accel("0")}</Kbd>, "Reset the text size to 100%"],
  [<Kbd>{isMac ? "⌃⇧M" : "Ctrl+M"}</Kbd>, "In the editor: switch Tab between indenting and moving focus out"],
];

const VIM_COMMANDS: Array<[ReactNode, ReactNode]> = [
  [
    <Mono>:w</Mono>,
    <>
      Save the tab (same path as <Kbd>{accel("S")}</Kbd>)
    </>,
  ],
  [
    <Mono>:q</Mono>,
    <>
      Close the tab — discards unsaved changes, like <Mono>q!</Mono>
    </>,
  ],
  [<Mono>:wq</Mono>, "Save, then close"],
];

const SEARCH_MODES_HELP: Array<[ReactNode, ReactNode]> = [
  ["Keyword", "Full-text search (BM25) over a column with a full-text index. Rows that use your words rank first."],
  ["Vector", "Finds rows whose embedding is closest in meaning to your text. Needs an embedding profile (Settings → Search) to turn the text into a vector."],
  ["Hybrid", "Runs Keyword and Vector and merges the two rankings. Needs both a full-text index and a vector column."],
];

const TUNING_HELP: Array<[ReactNode, ReactNode]> = [
  ["Where", <>A filter applied before the search, written like SQL: <Mono>priority &gt; 2</Mono>.</>],
  ["Keep", "How many results the search returns (10 by default). A full result says \"top 10\"."],
  ["Embedding, Vector column", "Which embedding profile turns your text into a vector, and which vector column to search."],
  ["Min score, Max gap", "Drop weak results: below a score, or too far behind the best one."],
  ["Reranker, Rerank column, Top n, Temperature", "Reorder the results with a reranker model, reading the chosen text column."],
  ["Pool", "How many candidates to fetch before reranking and filtering."],
  [
    "Score columns",
    <>
      <Mono>_distance</Mono>: smaller is closer. <Mono>_score</Mono>, <Mono>_relevance_score</Mono>, <Mono>_rerank_score</Mono>: bigger is better.
      The bar under each score shows it against the best in the result.
    </>,
  ],
];

const EMBEDDINGS_HELP: Array<[ReactNode, ReactNode]> = [
  ["The map", "Each point is a row. Rows with similar embeddings sit close together. 2D and 3D are two layouts of the same data."],
  ["Colors and names", "Colors are clusters of nearby rows. Each cluster is named from the words that set it apart in the text column. Improve names with AI asks the agent's model for better names (it may cost money)."],
  ["Sample size", "How many rows to place on the map. Bigger samples take longer to lay out."],
  ["Text column", "The column used to name clusters and shown when you point at a row."],
  ["Select area", "Draw around points to list those rows in a grid below the map (2D only)."],
  ["Rebuild map", "Lay the map out again. Shift+click for a new random arrangement."],
];

export function DocsView() {
  const section = useStore((s) => s.docsSection);
  useEffect(() => {
    if (!section) return;
    document.getElementById(`help-${section}`)?.scrollIntoView({ block: "start" });
    useStore.setState({ docsSection: null });
  }, [section]);
  return (
    <div className="flex-1 min-h-0 overflow-auto bg-ink-900">
      <div className="max-w-[46rem] mx-auto px-6 pt-8 pb-16 text-[length:var(--fs-md)] leading-relaxed">
        <header className="flex items-baseline gap-2 pb-7">
          <span className="font-display italic font-semibold text-xl tracking-tight text-paper">based</span>
          <span className="text-muted">— help</span>
        </header>

        <section>
          <h1 className="font-display font-semibold text-xl text-paper mb-3">Keyboard shortcuts</h1>
          <Rows rows={SHORTCUTS} />
        </section>

        <section className="mt-11">
          <h1 className="font-display font-semibold text-xl text-paper mb-3">Vim mode</h1>
          <p className="text-paper-dim mb-3">
            Turn it on under Settings (the gear) → General → Editor keymap → Vim. The query editor gains modal editing —
            motions, operators, registers, search — with the current mode and the <Mono>:</Mono> command input shown in
            the status bar.
          </p>
          <Rows rows={VIM_COMMANDS} />
          <p className="mt-3 text-[length:var(--fs-base)] text-muted">
            The app shortcuts above keep working in every vim mode. <Kbd>{accel("W")}</Kbd> stays bound to close-tab
            {isMac ? "." : ", shadowing vim's window prefix."}
          </p>
        </section>

        <section id="help-search" className="mt-11 scroll-mt-6">
          <h1 className="font-display font-semibold text-xl text-paper mb-3">Searching a LanceDB table</h1>
          <p className="text-paper-dim mb-1">
            In a table's Data tab, press <Kbd>{accel("F")}</Kbd> or click Search rows…, pick a mode, and type.
          </p>
          <Rows rows={SEARCH_MODES_HELP} />
          <h2 className="font-semibold text-paper mt-6 mb-1">Tuning</h2>
          <Rows rows={TUNING_HELP} />
        </section>

        <section id="help-embeddings" className="mt-11 scroll-mt-6">
          <h1 className="font-display font-semibold text-xl text-paper mb-3">Embeddings map</h1>
          <Rows rows={EMBEDDINGS_HELP} />
        </section>
      </div>
    </div>
  );
}
