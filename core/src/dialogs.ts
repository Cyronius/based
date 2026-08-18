// Traces: BASED-DIALOG-CHANNEL — native file dialogs, owned by the Tauri shell.
//
// Core has no windowing system of its own, so it cannot open a native picker. It used to shell out
// to `powershell.exe` with WinForms: Windows-only, and it made a database client spawn a PowerShell
// process to choose a file. The shell now owns dialogs via tauri-plugin-dialog (native on all three
// targets), and core reaches it over the one channel that exists in *every* run mode — the shell
// already talks to core's loopback HTTP server, in dev too, where core is started separately by
// scripts/dev.ts and the shell knows only BASED_DEV_URL + BASED_TOKEN.
//
// Protocol (both routes behind the standard token auth, see server.ts):
//   GET  /api/shell/dialog/next    long-poll; 200 with a request, or 204 when nothing is pending
//   POST /api/shell/dialog/result  { id, path } — resolves the awaiting caller; path null = cancel
//
// Consequence worth knowing: a core with no shell attached (`bun run dev:core` plus a browser tab,
// or a test) has no dialogs, and callers get a named error rather than a hang. Every endpoint that
// opens or saves a file also accepts an explicit `path` that skips the picker, so scripted and test
// flows are unaffected.
//
// State is module-level, i.e. one broker per process. That matches the single-server reality of
// both the packaged app and dev; two startServer() calls in one process would share this queue.

/** A picker filter entry. Mirrors tauri-plugin-dialog's `add_filter(name, extensions)`. */
export interface DialogFilter {
  /** Shown in the picker's filter dropdown. */
  name: string;
  /** Extensions without the leading dot. `["*"]` means "all files". */
  extensions: string[];
}

export type DialogKind = "open-file" | "save-file" | "open-folder" | "open-path";

/** One unit of work for the shell. Fields are per-kind; the shell ignores the ones it doesn't need. */
export interface DialogRequest {
  id: string;
  kind: DialogKind;
  filters?: DialogFilter[];
  defaultName?: string;
  startingFolder?: string;
  /** `open-path` only: the file to hand to the OS's default application. */
  path?: string;
}

/** How long a shell poll is held open before answering 204. Must stay well under the shell's own
 *  request timeout (35 s, see start_dialog_worker in main.rs) so the poll ends server-side as a
 *  normal empty answer rather than client-side as a timeout error. */
const POLL_HOLD_MS = 25_000;

/** A shell that polled within this window counts as attached. Polls re-issue immediately, so a live
 *  shell is always inside it; a dead one falls out within one hold period plus slack. */
const SHELL_GRACE_MS = 60_000;

/** How long a caller waits for the user to finish with the picker before giving up and reporting a
 *  cancel. Generous on purpose — someone browsing for a file is not a stuck request. */
const DIALOG_TIMEOUT_MS = 10 * 60_000;

/** Requests raised while no poll was parked, waiting for the next one. */
const queued: DialogRequest[] = [];
/** In-flight requests the shell has taken but not yet answered, keyed by request id. */
const awaiting = new Map<string, { resolve: (path: string | null) => void; timer: ReturnType<typeof setTimeout> }>();
/** Parked polls, waiting for a request to hand back. */
const pollers: Array<(req: DialogRequest | null) => void> = [];
let lastPollAt = 0;

function shellAttached(): boolean {
  return pollers.length > 0 || Date.now() - lastPollAt < SHELL_GRACE_MS;
}

/** Hand `req` to a parked poll, or queue it for the next one. */
function dispatch(req: DialogRequest): void {
  const poller = pollers.shift();
  if (poller) poller(req);
  else queued.push(req);
}

/** Shell side of the channel: take the next request, waiting up to `holdMs` for one to appear. */
export function nextDialogRequest(holdMs: number = POLL_HOLD_MS): Promise<DialogRequest | null> {
  lastPollAt = Date.now();
  const ready = queued.shift();
  if (ready) return Promise.resolve(ready);
  return new Promise((resolve) => {
    const settle = (req: DialogRequest | null): void => {
      clearTimeout(timer);
      const i = pollers.indexOf(settle);
      if (i >= 0) pollers.splice(i, 1);
      resolve(req);
    };
    const timer = setTimeout(() => settle(null), holdMs);
    pollers.push(settle);
  });
}

/** Shell side of the channel: answer a request. Unknown ids are ignored — the caller may already
 *  have timed out, and `open-path` never registers a waiter in the first place. */
export function resolveDialogResult(id: string, path: string | null): void {
  const waiter = awaiting.get(id);
  if (!waiter) return;
  awaiting.delete(id);
  clearTimeout(waiter.timer);
  waiter.resolve(path);
}

/** Raised when core is running without a shell, so there is nothing that can draw a picker. */
export class NoShellError extends Error {
  constructor(what: string) {
    super(
      `Cannot open the ${what}: no based shell is attached. Native dialogs are drawn by the app shell, ` +
        "so a core started on its own (dev:core, tests) has none — pass an explicit path instead.",
    );
    this.name = "NoShellError";
  }
}

function requestDialog(what: string, req: Omit<DialogRequest, "id">): Promise<string | null> {
  if (!shellAttached()) throw new NoShellError(what);
  const id = crypto.randomUUID();
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      awaiting.delete(id);
      const i = queued.findIndex((q) => q.id === id);
      if (i >= 0) queued.splice(i, 1);
      resolve(null); // indistinguishable from a cancel, which is the safe reading
    }, DIALOG_TIMEOUT_MS);
    awaiting.set(id, { resolve, timer });
    dispatch({ id, ...req });
  });
}

const ALL_FILES: DialogFilter = { name: "All files", extensions: ["*"] };

const FILTERS: Record<"sql" | "csv" | "xlsx" | "md", DialogFilter[]> = {
  sql: [{ name: "SQL files", extensions: ["sql"] }, ALL_FILES],
  csv: [{ name: "CSV files", extensions: ["csv"] }, ALL_FILES],
  xlsx: [{ name: "Excel workbook", extensions: ["xlsx"] }, ALL_FILES],
  md: [{ name: "Markdown files", extensions: ["md"] }, ALL_FILES],
};

export function filterFor(kind: "sql" | "csv" | "xlsx" | "md"): DialogFilter[] {
  return FILTERS[kind];
}

export function saveFileDialog(defaultName: string, filters: DialogFilter[]): Promise<string | null> {
  return requestDialog("save dialog", { kind: "save-file", defaultName, filters });
}

// Traces: BASED-DIALOG-OPEN-FILE — native open-file picker (CSV import, open .sql).
export function openFileDialog(filters: DialogFilter[]): Promise<string | null> {
  return requestDialog("file picker", { kind: "open-file", filters });
}

/** Native folder picker (e.g. for the LanceDB directory-path field). */
export function openFolderDialog(startingFolder?: string): Promise<string | null> {
  return requestDialog("folder picker", { kind: "open-folder", startingFolder });
}

/** Hand a file to the OS's default application (e.g. .xlsx → Excel). Fire-and-forget: the agent
 *  tools call this after a successful export and must not fail because of it, so a core with no
 *  shell attached warns and moves on rather than throwing. */
export function openWithDefaultApp(path: string): void {
  if (!shellAttached()) {
    console.warn(`based: cannot open ${path} with its default app — no shell attached`);
    return;
  }
  dispatch({ id: crypto.randomUUID(), kind: "open-path", path });
}
