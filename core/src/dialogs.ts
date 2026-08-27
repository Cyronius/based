// Native file dialogs. Primary path: the request is relayed to the Tauri shell over the
// shell-dialog channel (GET /api/shell/dialogs SSE + POST /api/shell/dialog-result — see
// shell-tauri/src/main.rs), which shows a real native dialog parented to the focused window on any
// platform. Dialogs are the one piece of app behavior that lives in the shell: they are a
// windowing-system concern, and a core-owned subprocess dialog can neither parent to a window nor
// exist at all on macOS.
//
// Fallback when no shell is attached (browser dev, core run standalone): a per-OS subprocess dialog
// — PowerShell WinForms on Windows, osascript on macOS. Tests never hit either path: endpoints take
// an explicit `path` that skips the dialog, and the relay itself is exercised by
// integration.shellDialogs.test.ts with a fake shell subscriber.

const encoder = new TextEncoder();

/** One selectable file-type entry. `extensions: ["*"]` means "all files". */
export interface FileFilter {
  name: string;
  extensions: string[];
}

export function filterFor(kind: "sql" | "csv" | "xlsx" | "md"): FileFilter[] {
  const typed: FileFilter =
    kind === "sql"
      ? { name: "SQL files", extensions: ["sql"] }
      : kind === "csv"
        ? { name: "CSV files", extensions: ["csv"] }
        : kind === "md"
          ? { name: "Markdown files", extensions: ["md"] }
          : { name: "Excel workbook", extensions: ["xlsx"] };
  return [typed, { name: "All files", extensions: ["*"] }];
}

/** What rides the SSE stream to the shell (an `id` is stamped on at send time). */
export type ShellDialogRequest =
  | { kind: "open-file"; filters: FileFilter[] }
  | { kind: "save-file"; filters: FileFilter[]; defaultName: string }
  | { kind: "folder"; startingFolder?: string };

/**
 * The core side of the shell-dialog channel: at most one subscriber (the shell), a pending map of
 * requests awaiting its answer. A vanished shell resolves every in-flight dialog as cancelled —
 * null is what every caller already treats as "the user backed out".
 */
export class ShellDialogBroker {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private readonly pending = new Map<string, (path: string | null) => void>();

  get connected(): boolean {
    return this.controller !== null;
  }

  /** A new subscription replaces any previous one (shell reconnect after a dev-core restart). */
  attach(controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (this.controller && this.controller !== controller) {
      try {
        this.controller.close();
      } catch {
        // already closed
      }
      this.cancelPending(); // the shell that could answer these is gone
    }
    this.controller = controller;
  }

  detach(controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (this.controller !== controller) return; // stale detach from a replaced subscription
    this.controller = null;
    this.cancelPending();
  }

  private cancelPending(): void {
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
  }

  request(req: ShellDialogRequest): Promise<string | null> {
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      try {
        this.controller!.enqueue(encoder.encode(`data: ${JSON.stringify({ ...req, id })}\n\n`));
      } catch {
        this.pending.delete(id);
        this.controller = null;
        resolve(null);
      }
    });
  }

  resolve(id: string, path: string | null): void {
    const resolver = this.pending.get(id);
    this.pending.delete(id);
    resolver?.(path);
  }
}

export interface Dialogs {
  openFile(filters: FileFilter[]): Promise<string | null>;
  saveFile(defaultName: string, filters: FileFilter[]): Promise<string | null>;
  openFolder(startingFolder?: string): Promise<string | null>;
}

export function createDialogs(broker: ShellDialogBroker): Dialogs {
  return {
    openFile(filters) {
      if (broker.connected) return broker.request({ kind: "open-file", filters });
      return process.platform === "darwin" ? osaOpenFile() : pwshOpenFile(filters);
    },
    saveFile(defaultName, filters) {
      if (broker.connected) return broker.request({ kind: "save-file", filters, defaultName });
      return process.platform === "darwin" ? osaSaveFile(defaultName) : pwshSaveFile(defaultName, filters);
    },
    openFolder(startingFolder) {
      if (broker.connected) return broker.request({ kind: "folder", startingFolder });
      return process.platform === "darwin" ? osaOpenFolder(startingFolder) : pwshOpenFolder(startingFolder);
    },
  };
}

/** Shell-open a file with its default app (e.g. .xlsx → Excel). */
export function openWithDefaultApp(path: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", path]
      : process.platform === "win32"
        ? ["cmd.exe", "/c", "start", "", path]
        : ["xdg-open", path];
  Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
}

// --- Windows fallback: PowerShell WinForms subprocess dialogs (pre-shell-relay mechanism) ---

function runPwshDialog(script: string): Promise<string | null> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-STA", "-EncodedCommand", encoded], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return new Response(proc.stdout).text().then(async (out) => {
    await proc.exited;
    const path = out.trim();
    return path.length > 0 ? path : null;
  });
}

// PowerShell single-quoted strings do zero escape processing (only '' -> literal '), unlike
// double-quoted strings — so this, not JSON.stringify, is the correct way to inject a literal
// value (e.g. a Windows path with backslashes) into a -EncodedCommand script.
function psSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** `{name: "SQL files", extensions: ["sql"]}` → the WinForms `"SQL files (*.sql)|*.sql"` form. */
export function winFormsFilter(filters: FileFilter[]): string {
  return filters
    .map((f) => {
      const patterns = f.extensions.map((e) => (e === "*" ? "*.*" : `*.${e}`)).join(";");
      return `${f.name} (${patterns})|${patterns}`;
    })
    .join("|");
}

function pwshSaveFile(defaultName: string, filters: FileFilter[]): Promise<string | null> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.SaveFileDialog
$d.FileName = ${psSingleQuote(defaultName)}
$d.Filter = ${psSingleQuote(winFormsFilter(filters))}
$d.OverwritePrompt = $true
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }
`;
  return runPwshDialog(script);
}

function pwshOpenFile(filters: FileFilter[]): Promise<string | null> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Filter = ${psSingleQuote(winFormsFilter(filters))}
$d.CheckFileExists = $true
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }
`;
  return runPwshDialog(script);
}

function pwshOpenFolder(startingFolder?: string): Promise<string | null> {
  // RootFolder=MyComputer stops WinForms from honoring SelectedPath (a long-standing
  // FolderBrowserDialog quirk), so only set it when there's no starting path to seed.
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
${
  startingFolder
    ? `$d.SelectedPath = ${psSingleQuote(startingFolder)}`
    : `$d.RootFolder = [System.Environment+SpecialFolder]::MyComputer`
}
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }
`;
  return runPwshDialog(script);
}

// --- macOS fallback: osascript `choose …` dialogs (shell-less dev only; unfiltered on purpose —
// the packaged app always has the shell attached) ---

function runOsascript(script: string): Promise<string | null> {
  // Cancel exits non-zero with empty stdout, which falls out as null — same contract as the rest.
  const proc = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "ignore" });
  return new Response(proc.stdout).text().then(async (out) => {
    await proc.exited;
    const path = out.trim();
    return path.length > 0 ? path : null;
  });
}

/** AppleScript double-quoted string literal (its only escapes are \\ and \"). */
function osaQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function osaOpenFile(): Promise<string | null> {
  return runOsascript(`POSIX path of (choose file)`);
}

function osaSaveFile(defaultName: string): Promise<string | null> {
  return runOsascript(`POSIX path of (choose file name default name ${osaQuote(defaultName)})`);
}

function osaOpenFolder(startingFolder?: string): Promise<string | null> {
  const loc = startingFolder ? ` default location POSIX file ${osaQuote(startingFolder)}` : "";
  return runOsascript(`POSIX path of (choose folder${loc})`);
}
