// Phase 0 spike #5 — @lancedb/lancedb napi binding under Bun on Windows.
// Checks: native .node addon loads, create table, insert vectors, ANN/vector
// search returns sane results, clean process exit.
// Run under bun AND node for comparison: bun run spike.mjs / node spike.mjs

import * as lancedb from '@lancedb/lancedb';

const RUNTIME = typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`;
console.log(`runtime: ${RUNTIME}`);
const t0 = Date.now();
const mark = (m) => console.log(`[${Date.now() - t0}ms] ${m}`);

const db = await lancedb.connect('./data/spike5-db');
mark('NAPI_LOAD_OK + connect');

const dim = 64;
const rows = Array.from({ length: 500 }, (_, i) => ({
  id: i,
  text: `row-${i}`,
  vector: Array.from({ length: dim }, (_, j) => Math.sin(i * 0.7 + j * 0.13)),
}));

const table = await db.createTable('vectors', rows, { mode: 'overwrite' });
mark(`CREATE_TABLE_OK (${await table.countRows()} rows)`);

const query = rows[123].vector;
const hits = await table.vectorSearch(query).limit(5).toArray();
mark(`VECTOR_SEARCH_OK top=${hits[0]?.id} (expect 123) hits=[${hits.map((h) => h.id).join(',')}]`);

const filtered = await table.query().where('id < 50').limit(5).toArray();
mark(`FILTER_QUERY_OK rows=${filtered.length}`);

if (hits[0]?.id !== 123) {
  console.log('SPIKE 5 FAIL: nearest neighbor is not the query row');
  process.exit(1);
}
console.log('SPIKE 5 PASS');
