// The paid product (based.ai) lives in its own private repo next to this one, never inside it.
// This is the backstop: refuses a commit or a tree that carries paid-product directories, env
// files, or private keys. Runs from .githooks/pre-commit (--staged) and CI (--tree).
//
//   bun scripts/check-private.ts --staged
//   bun scripts/check-private.ts --tree

const PRIVATE_DIRS = ["based-ai", "paid", "private"];
const KEY_FILE = /(\.p8|\.pem|\.key)$|_rsa_key/;

export function isPrivatePath(path: string): boolean {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length === 0) return false;
  const file = parts[parts.length - 1]!;
  if (parts.some((seg) => PRIVATE_DIRS.includes(seg) || seg.endsWith(".private"))) return true;
  if (file === ".env" || file.startsWith(".env.")) return true;
  return KEY_FILE.test(file);
}

async function gitLines(args: string[]): Promise<string[]> {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "inherit" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return out.split(/\r?\n/).filter(Boolean);
}

if (import.meta.main) {
  const mode = process.argv[2];
  const files =
    mode === "--staged"
      ? await gitLines(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
      : mode === "--tree"
        ? await gitLines(["ls-files"])
        : null;
  if (!files) {
    console.error("usage: bun scripts/check-private.ts --staged | --tree");
    process.exit(2);
  }
  const hits = files.filter(isPrivatePath);
  if (hits.length) {
    console.error("private paths must not be committed to this repo:\n  " + hits.join("\n  "));
    process.exit(1);
  }
  console.log(`private guard ok (${files.length} files)`);
}
