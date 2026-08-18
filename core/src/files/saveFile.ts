// Traces: BASED-AGENT-SAVE-FILE
// Writing a *document* to the user's machine — the counterpart to export/exportData.ts, which
// writes *data*. Two deliberate differences from sanitizeExportFileName:
//
//  1. The extension is a WHITELIST, not a format the caller forces. The agent picks the name here,
//     so the guard has to be "only these document types" rather than "not these bad ones" — a
//     blacklist is one unlisted-but-runnable extension away from dropping an executable into
//     Downloads, and there is no reason a database client needs to write one.
//  2. Writes never clobber. export_data's default names are timestamped, so a collision is
//     essentially impossible; a model-chosen "report.html" collides with a file the user already
//     had, and silently overwriting it is not recoverable.
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Document formats the agent may write. Text/markup only — nothing the shell will execute. */
export const SAVE_FILE_EXTENSIONS = [
  "html",
  "htm",
  "md",
  "markdown",
  "txt",
  "sql",
  "json",
  "csv",
  "tsv",
  "xml",
  "yaml",
  "yml",
  "svg",
  "log",
] as const;

export type SaveFileExtension = (typeof SAVE_FILE_EXTENSIONS)[number];

/** Upper bound on one written document. A guard against a runaway generation, not a real limit —
 *  a model-authored report is kilobytes. */
export const MAX_SAVE_FILE_BYTES = 5_000_000;

const ALLOWED = new Set<string>(SAVE_FILE_EXTENSIONS);

/** How many `-2`, `-3`… variants to try before giving up on finding a free name. */
const MAX_COLLISION_SUFFIX = 200;

export function isAllowedSaveExtension(ext: string): boolean {
  return ALLOWED.has(ext.toLowerCase());
}

function splitExtension(name: string): { base: string; ext: string | null } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return { base: name, ext: null };
  return { base: name.slice(0, dot), ext: name.slice(dot + 1) };
}

/**
 * Validate a model-supplied file name: a bare name (no directories, no traversal) whose extension
 * is on the whitelist. `defaultExt` supplies the extension when the name has none — it never
 * overrides one that is already there, so "notes.txt" stays .txt even when md was requested.
 * Throws with a message written for the model to read back to the user.
 */
export function sanitizeSaveFileName(name: string, defaultExt?: SaveFileExtension | string): string {
  if (/[/\\]/.test(name) || name.includes("..")) {
    throw new Error("fileName must be a bare file name (no directories or '..')");
  }
  const trimmed = name.trim();
  if (!trimmed) throw new Error("fileName must not be empty");

  const { ext } = splitExtension(trimmed);
  if (ext === null) {
    if (!defaultExt) {
      throw new Error(`fileName needs an extension — one of: ${SAVE_FILE_EXTENSIONS.join(", ")}`);
    }
    if (!isAllowedSaveExtension(defaultExt)) throw new Error(`Unsupported file type ".${defaultExt}"`);
    return `${trimmed}.${defaultExt}`;
  }
  if (!isAllowedSaveExtension(ext)) {
    throw new Error(`Unsupported file type ".${ext}" — save_file writes only: ${SAVE_FILE_EXTENSIONS.join(", ")}`);
  }
  return trimmed;
}

/**
 * Read `XDG_DOWNLOAD_DIR` out of a freedesktop `user-dirs.dirs` body. Returns an absolute path, or
 * null when the file names no usable one.
 *
 * This exists because the Downloads folder is **localized on Linux**: a French desktop has
 * `~/Téléchargements` and no `~/Downloads` at all, so the hardcoded name silently fell through to
 * the temp directory. Windows and macOS use the literal `~/Downloads` path whatever the display
 * language is, so neither needs this.
 *
 * The file is a shell-sourceable fragment — `XDG_DOWNLOAD_DIR="$HOME/Downloads"`, comments with
 * `#`. `$HOME` is the only expansion performed: the generator writes nothing else, and a value
 * naming some other variable is treated as unusable rather than half-expanded into a wrong path.
 * Last assignment wins, matching shell semantics.
 *
 * Pure, and separate from the file read, so every branch is unit-testable from any build host.
 */
export function parseXdgDownloadDir(body: string, home: string): string | null {
  let found: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    // A commented-out line cannot match: `#` is not whitespace, so the anchor rejects it.
    const match = /^\s*XDG_DOWNLOAD_DIR\s*=\s*"(.*)"\s*$/.exec(line);
    if (!match) continue;
    const raw = match[1]!;
    const expanded = raw === "$HOME" ? home : raw.startsWith("$HOME/") ? join(home, raw.slice("$HOME/".length)) : raw;
    found = expanded && !expanded.includes("$") && isAbsolute(expanded) ? expanded : null;
  }
  return found;
}

/** The Linux Downloads folder per the user's freedesktop config, or null when there is no usable
 *  entry (file absent, unreadable, or naming a path we cannot expand). */
function xdgDownloadDir(env: Record<string, string | undefined>, home: string): string | null {
  const configured = env.XDG_CONFIG_HOME;
  const configHome = configured && isAbsolute(configured) ? configured : join(home, ".config");
  try {
    return parseXdgDownloadDir(readFileSync(join(configHome, "user-dirs.dirs"), "utf8"), home);
  } catch {
    return null; // no user-dirs.dirs on this machine — fall back to the literal name
  }
}

/** Where agent-written files land: the user's Downloads folder, falling back to the temp dir on a
 *  machine that has none. `override` is how tests keep runs out of the real Downloads. */
export function resolveDownloadDir(override?: string): string {
  if (override) return override;
  const home = homedir();
  const candidates = process.platform === "linux" ? [xdgDownloadDir(process.env, home)] : [];
  candidates.push(join(home, "Downloads"));
  for (const dir of candidates) {
    if (dir && existsSync(dir)) return dir;
  }
  return tmpdir();
}

/** Write `content` into `dir` under `fileName`, suffixing `-2`, `-3`… rather than overwriting an
 *  existing file. Returns the path actually written and its byte length. */
export async function writeTextFileUnique(
  dir: string,
  fileName: string,
  content: string,
): Promise<{ path: string; bytes: number }> {
  const { base, ext } = splitExtension(fileName);
  let target = join(dir, fileName);
  for (let n = 2; existsSync(target); n++) {
    if (n > MAX_COLLISION_SUFFIX) throw new Error(`Could not find a free file name for "${fileName}" in ${dir}`);
    target = join(dir, ext === null ? `${base}-${n}` : `${base}-${n}.${ext}`);
  }
  await Bun.write(target, content);
  return { path: target, bytes: Buffer.byteLength(content, "utf8") };
}
