// Traces: BASED-HELP-DOCS — the help tab's content. The shortcut table must match the canonical
// one in BASED-UI-SHORTCUTS; the vim section must match BASED-EDITOR-VIM. Static content, so this
// takes no props: the docs tab carries no state beyond its own identity.
import type { ReactNode } from "react";
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
  [
    <>
      <Kbd>F5</Kbd> / <Kbd>{accel("Enter")}</Kbd>
    </>,
    "Run the active query tab",
  ],
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

export function DocsView() {
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
      </div>
    </div>
  );
}
