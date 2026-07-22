// Phase 0 spike #2 — tedious/mssql in-process under Bun vs Node.
// Portable script: run identically under `bun run spike.mjs` and `node spike.mjs`.
// Read-only: SELECT 1 + INFORMATION_SCHEMA queries only.
//
// Checks:
//   A. AzureCliCredential token acquisition in-process (az CLI spawn under this runtime)
//   B. Connect to Azure SQL via azure-active-directory-access-token
//   C. Pooled sequential query latency (bun #13093 check) - 30x SELECT 1
//   D. Concurrent pooled queries (10 at once)
//   E. Metadata query (INFORMATION_SCHEMA.TABLES)
//   F. Clean pool.close() (tedious #1681 hang check) + natural process exit

import sql from 'mssql';

const RUNTIME = typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`;
const SERVER = process.env.SPIKE_SQL_SERVER || 'zl5qolt7t8.database.windows.net';
const DATABASE = process.env.SPIKE_SQL_DB || 'learnermobile_db_ci';

const out = { runtime: RUNTIME, server: SERVER, database: DATABASE };
const t0 = Date.now();
const mark = (k, v) => { out[k] = v; console.log(`[${Date.now() - t0}ms] ${k}: ${JSON.stringify(v)}`); };

// --- A. token ---
let token = process.env.SPIKE_SQL_TOKEN;
if (token) {
  mark('token_source', 'env');
} else {
  try {
    const { AzureCliCredential } = await import('@azure/identity');
    const cred = new AzureCliCredential();
    const t = Date.now();
    const res = await cred.getToken('https://database.windows.net/.default');
    token = res.token;
    mark('azure_cli_credential', { ok: true, ms: Date.now() - t });
  } catch (e) {
    mark('azure_cli_credential', { ok: false, error: String(e?.message || e) });
    console.error('FALLBACK: set SPIKE_SQL_TOKEN env var (az account get-access-token --resource https://database.windows.net --query accessToken -o tsv)');
    process.exit(2);
  }
}

// --- B. connect ---
const config = {
  server: SERVER,
  database: DATABASE,
  options: { encrypt: true, trustServerCertificate: false },
  pool: { min: 1, max: 5 },
  authentication: { type: 'azure-active-directory-access-token', options: { token } },
  connectionTimeout: 30000,
  requestTimeout: 30000,
};

let pool;
try {
  const t = Date.now();
  pool = await new sql.ConnectionPool(config).connect();
  mark('connect', { ok: true, ms: Date.now() - t });
} catch (e) {
  mark('connect', { ok: false, error: String(e?.message || e) });
  process.exit(3);
}

// --- C. sequential latency ---
await pool.request().query('SELECT 1 AS warmup'); // warmup
const seq = [];
for (let i = 0; i < 30; i++) {
  const t = Date.now();
  await pool.request().query('SELECT 1 AS x');
  seq.push(Date.now() - t);
}
const sorted = [...seq].sort((a, b) => a - b);
mark('sequential_30x', {
  mean: +(seq.reduce((a, b) => a + b, 0) / seq.length).toFixed(1),
  p50: sorted[15], p95: sorted[28], min: sorted[0], max: sorted[29],
});

// --- D. concurrent ---
{
  const t = Date.now();
  await Promise.all(Array.from({ length: 10 }, () => pool.request().query('SELECT 1 AS x')));
  mark('concurrent_10x', { total_ms: Date.now() - t });
}

// --- E. metadata ---
try {
  const t = Date.now();
  const r = await pool.request().query(
    "SELECT TOP 5 TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_SCHEMA, TABLE_NAME");
  mark('metadata_query', { ok: true, ms: Date.now() - t, rows: r.recordset.length });
} catch (e) {
  mark('metadata_query', { ok: false, error: String(e?.message || e) });
}

// --- F. clean close ---
{
  const t = Date.now();
  const hang = new Promise((res) => setTimeout(() => res('HANG'), 10000).unref?.());
  const closed = pool.close().then(() => 'OK');
  const result = await Promise.race([closed, hang]);
  mark('close', { result, ms: Date.now() - t });
  if (result === 'HANG') process.exit(4);
}

console.log('SUMMARY ' + JSON.stringify(out));
// No process.exit() here on purpose: if the process lingers, that is itself a
// finding (event-loop handle leak). The runner applies an outer timeout.
