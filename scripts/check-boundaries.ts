// Keeps core and ui from importing each other. ui talks to core over HTTP only, and core knows
// nothing about the webview - that is what lets each build on its own and lets based.ai run core
// without the desktop frontend. The shell is the one package allowed to import core.
//
//   bun scripts/check-boundaries.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";

const PACKAGES = ["core", "ui", "shell-tauri"] as const;
type Pkg = (typeof PACKAGES)[number];

const PACKAGE_NAMES: Record<string, Pkg> = {
  "@cyronius/based-core": "core",
  "@based/ui": "ui",
  "@based/shell-tauri": "shell-tauri",
};

const ALLOWED: Record<Pkg, Pkg[]> = {
  core: [],
  ui: [],
  "shell-tauri": ["core"],
};

function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

function packageOf(repoPath: string): Pkg | null {
  const top = norm(repoPath).split("/")[0];
  return (PACKAGES as readonly string[]).includes(top) ? (top as Pkg) : null;
}

/** True when `specifier`, imported from `fromFile` (repo-relative), lands in a sibling package the
 *  importing package is not allowed to depend on. */
export function crossesBoundary(fromFile: string, specifier: string): boolean {
  const from = packageOf(fromFile);
  if (!from) return false;
  const spec = norm(specifier);

  let target: Pkg | null = null;
  if (spec.startsWith(".")) {
    const resolved = posix.normalize(posix.join(posix.dirname(norm(fromFile)), spec));
    target = packageOf(resolved);
  } else {
    const scoped = spec.split("/").slice(0, 2).join("/");
    target = PACKAGE_NAMES[scoped] ?? null;
  }
  if (!target || target === from) return false;
  return !ALLOWED[from].includes(target);
}

const IMPORT_RE = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["']([^"']+)["']/g;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "vendor" || name === "target") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(name)) yield full;
  }
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const roots = [join(root, "core", "src"), join(root, "ui", "src"), join(root, "shell-tauri")];
  const violations: string[] = [];
  for (const r of roots) {
    for (const file of walk(r)) {
      const rel = norm(relative(root, file));
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(IMPORT_RE)) {
        if (crossesBoundary(rel, m[1]!)) violations.push(`${rel}: imports ${m[1]}`);
      }
    }
  }
  if (violations.length) {
    console.error("package boundary violations:\n  " + violations.join("\n  "));
    process.exit(1);
  }
  console.log("boundaries ok");
}
