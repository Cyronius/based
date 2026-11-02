// Traces: BASED-TAB-CLOSE-CONFIRM
// Opt-in only (Settings → General, off by default): one question per close action, naming every
// unsaved tab in the batch.
import { useStore } from "../store";
import { Dialog } from "./Dialog";
import { accel } from "../platform";

export function CloseConfirmDialog() {
  const pending = useStore((s) => s.closeConfirm);
  const closeTabs = useStore((s) => s.closeTabs);
  const cancel = useStore((s) => s.cancelCloseConfirm);
  if (!pending) return null;
  const many = pending.titles.length > 1;
  return (
    <Dialog title={many ? "Close tabs with unsaved changes?" : "Close a tab with unsaved changes?"} onClose={cancel}>
      <div className="px-5 py-4 space-y-2 text-[length:var(--fs-base)] text-paper-dim">
        <ul className="list-disc pl-5">
          {pending.titles.map((t, i) => (
            <li key={i} className="truncate">
              {t}
            </li>
          ))}
        </ul>
        <p className="text-muted text-[length:var(--fs-sm)]">You can bring closed tabs back with {accel("Shift+T")}.</p>
      </div>
      <div className="px-5 pb-4 flex justify-end gap-2">
        <button
          className="px-3 py-1.5 text-[length:var(--fs-base)] rounded border border-line text-paper-dim hover:bg-ink-800"
          onClick={cancel}
        >
          Cancel
        </button>
        <button
          data-autofocus
          className="px-3 py-1.5 text-[length:var(--fs-base)] rounded border border-brass/50 bg-brass/15 text-brass hover:bg-brass/25"
          onClick={() => closeTabs(pending.ids, { force: true })}
        >
          {many ? "Close tabs" : "Close tab"}
        </button>
      </div>
    </Dialog>
  );
}
