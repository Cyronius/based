// Traces: BASED-EDITOR-VIM
// Vim keybindings for the query editor, via monaco-vim (a port of CodeMirror's vim keymap onto
// Monaco). Loaded on demand — the module is only fetched once a user actually turns the keymap on,
// so the default bundle carries none of it.
//
// monaco-vim wants a DOM node to own for the mode indicator and the `:`/`/` command input. It gets
// the slot in the app's bottom status bar rather than a second bar of its own (StatusBar.tsx); the
// node is borrowed, and dispose() empties it again.
import type * as MonacoEditor from "monaco-editor";
import { activeQueryTab, useStore } from "./store";

type Editor = MonacoEditor.editor.IStandaloneCodeEditor;

/** The status-bar slot monaco-vim renders into. StatusBar owns the node; EditorPane looks it up. */
export const VIM_STATUS_NODE_ID = "vim-status";

/** What monaco-vim's status bar exposes that we care about. Its `setMode` is the only thing we
 *  override, so the class we subclass is reached through the module's own export. */
type MonacoVim = typeof import("monaco-vim");

export interface VimAttachment {
  dispose(): void;
}

/** monaco-vim writes `--INSERT--` / `--VISUAL LINE--`. The project's UI rules rule out shouting
 *  labels, so the mode reads as a word in the status bar's own voice; emphasis comes from weight
 *  (see the `.vim-status` rule in index.css), not capitals. */
function themedStatusBar(vim: MonacoVim) {
  return class ThemedStatusBar extends vim.StatusBar {
    setMode(ev: { mode: string; subMode?: string }): void {
      const sub = ev.subMode ? ` ${ev.subMode.replace("wise", "")}` : "";
      const mode = ev.mode.charAt(0).toUpperCase() + ev.mode.slice(1);
      this.setText(`${mode}${sub}`);
    }
  };
}

/** The ex commands live in a module-global map inside monaco-vim, so they are defined once and
 *  resolve the tab they act on at call time — never closing over the tab that happened to be open
 *  when vim was first switched on. */
let exDefined = false;

function defineExCommands(vim: MonacoVim): void {
  if (exDefined) return;
  exDefined = true;
  // `Vim` is attached to the adapter class at runtime (keymap_vim.ts: `CodeMirror.Vim = Vim()`),
  // but monaco-vim's types stop at the adapter, so the accessor is asserted here.
  const Vim = (vim.VimMode as unknown as { Vim: { defineEx(name: string, prefix: string, fn: () => void): void } }).Vim;
  const tabId = () => activeQueryTab(useStore.getState())?.id ?? null;

  Vim.defineEx("write", "w", () => {
    const id = tabId();
    if (id) void useStore.getState().saveTab(id);
  });
  // `:q!` parses as `quit` with a `!` argument, so both land here. closeTab discards without
  // prompting, which is what `q!` means; plain `:q` therefore discards too.
  Vim.defineEx("quit", "q", () => {
    const id = tabId();
    if (id) useStore.getState().closeTab(id);
  });
  Vim.defineEx("wq", "wq", () => {
    const id = tabId();
    if (!id) return;
    void useStore.getState().saveTab(id).then(() => useStore.getState().closeTab(id));
  });
}

/** Attach vim mode to an editor, rendering its status into `statusNode`. Resolves once monaco-vim
 *  has loaded; callers must dispose the result (see EditorPane's effect — StrictMode runs it twice). */
export async function attachVim(editor: Editor, statusNode: HTMLElement): Promise<VimAttachment> {
  const vim = await import("monaco-vim");
  defineExCommands(vim);
  const mode = vim.initVimMode(editor, statusNode, themedStatusBar(vim));
  return {
    dispose() {
      // Fires monaco-vim's own teardown, which clears the borrowed node for us.
      mode.dispose();
    },
  };
}
