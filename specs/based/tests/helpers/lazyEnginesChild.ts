// Traces: BASED-LAZY-ENGINES — child probe run by integration.lazyEngines.test.ts in a fresh bun
// process: import the @based/core barrel, then report which engine modules got evaluated.
await import("@based/core");
const keys = Object.keys(require.cache);
const hit = (re: RegExp) => keys.filter((k) => re.test(k));
console.log(
  JSON.stringify({
    total: keys.length,
    mssql: hit(/mssqlAdapter|[\\/]node_modules[\\/].*(mssql|tedious)/i).length,
    lance: hit(/lanceAdapter|@lancedb/i).length,
    duckdb: hit(/lanceSql|@duckdb/i).length,
    snowflake: hit(/snowflakeAdapter|[\/]node_modules[\/].*snowflake-sdk/i).length,
  }),
);
