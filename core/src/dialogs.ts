// Native file dialogs via PowerShell (WinForms) — keeps the Electrobun shell dialog-free,
// so the "shell is disposable" principle holds. Windows-only, like the rest of Phase 1.

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

const SQL_FILTER = "SQL files (*.sql)|*.sql|All files (*.*)|*.*";
const CSV_FILTER = "CSV files (*.csv)|*.csv|All files (*.*)|*.*";
const XLSX_FILTER = "Excel workbook (*.xlsx)|*.xlsx|All files (*.*)|*.*";
const MD_FILTER = "Markdown files (*.md)|*.md|All files (*.*)|*.*";

export function filterFor(kind: "sql" | "csv" | "xlsx" | "md"): string {
  return kind === "sql" ? SQL_FILTER : kind === "csv" ? CSV_FILTER : kind === "md" ? MD_FILTER : XLSX_FILTER;
}

// PowerShell single-quoted strings do zero escape processing (only '' -> literal '), unlike
// double-quoted strings — so this, not JSON.stringify, is the correct way to inject a literal
// value (e.g. a Windows path with backslashes) into a -EncodedCommand script.
function psSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export function saveFileDialog(defaultName: string, filter: string): Promise<string | null> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.SaveFileDialog
$d.FileName = ${psSingleQuote(defaultName)}
$d.Filter = ${psSingleQuote(filter)}
$d.OverwritePrompt = $true
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }
`;
  return runPwshDialog(script);
}

// Traces: BASED-DIALOG-OPEN-FILE — native open-file picker (CSV import).
export function openFileDialog(filter: string): Promise<string | null> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Filter = ${psSingleQuote(filter)}
$d.CheckFileExists = $true
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }
`;
  return runPwshDialog(script);
}

/** Native folder picker (e.g. for the LanceDB directory-path field). */
export function openFolderDialog(startingFolder?: string): Promise<string | null> {
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

/** Shell-open a file with its default app (e.g. .xlsx → Excel). */
export function openWithDefaultApp(path: string): void {
  Bun.spawn(["cmd.exe", "/c", "start", "", path], { stdout: "ignore", stderr: "ignore" });
}
