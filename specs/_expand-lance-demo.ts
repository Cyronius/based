// Pad the 270-row demo table to ~1080 rows by jittering copies of the real embeddings, so the
// Atlas's PCA/UMAP pipeline takes long enough to visibly animate for a screenshot capture (270
// rows resolves in under one frame). Jitter is small relative to inter-cluster distance, so
// cluster structure is preserved. Throwaway; delete when screenshot capture is done.
import * as lancedb from "@lancedb/lancedb";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: bun run specs/_expand-lance-demo.ts <outDir>");
  process.exit(1);
}

let seed = 42;
function rand(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function gaussian(): number {
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const db = await lancedb.connect(outDir);
const table = await db.openTable("support_tickets");
const rows = (await table.query().toArray()).map((r: Record<string, unknown>) => ({
  id: Number(r.id),
  category: String(r.category),
  text: String(r.text),
  priority: String(r.priority),
  vector: Array.from(r.vector as Iterable<number>),
}));
console.log(`read ${rows.length} base rows`);

const COPIES = 3;
const JITTER = 0.06; // fraction of per-dim spread
const expanded = [...rows];
let nextId = Math.max(...rows.map((r) => r.id)) + 1;
for (let c = 0; c < COPIES; c++) {
  for (const r of rows) {
    const vector = r.vector.map((v) => v + gaussian() * JITTER);
    expanded.push({ ...r, id: nextId++, vector });
  }
}

await db.createTable("support_tickets", expanded, { mode: "overwrite" });
console.log(`wrote ${expanded.length} rows (${rows.length} base x ${COPIES + 1}) into ${outDir}/support_tickets.lance`);
