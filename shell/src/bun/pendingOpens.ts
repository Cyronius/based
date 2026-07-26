// BASED-OPEN-SQL-ARGV: hand-off channel between based-open.exe (the .sql file-association stub)
// and the shell. Electrobun's launcher.exe does not forward its argv to the bun process (verified
// against 1.18.1 — it spawns `bun.exe main.js` with exactly those two args), so the stub instead
// appends each requested path as one line to <dataDir>/pending-open.txt and starts the launcher.
// Whichever shell instance boots next (primary or a secondary that forwards to the primary)
// consumes the file. Plain lines, not JSON: Windows paths can't contain newlines, and it keeps the
// stub's C# side trivial.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@based/core";

const pendingPath = () => join(dataDir(), "pending-open.txt");

/** Read, delete, and return the pending open requests (existing files only). Best-effort: a
 *  concurrent stub append between read and delete can lose a request in theory; in practice the
 *  window is milliseconds and another double-click re-creates it. */
export function consumePendingOpens(): string[] {
  const file = pendingPath();
  if (!existsSync(file)) return [];
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
    rmSync(file, { force: true });
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && existsSync(l));
}
