import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";

const cred = new AzureCliCredential();
const tokenResp = await cred.getToken("https://database.windows.net/.default");

async function run(sqlText: string, label: string) {
  const pool = new sql.ConnectionPool({
    server: "zl5qolt7t8.database.windows.net",
    port: 1433,
    database: "learnermobile_db_ci",
    authentication: { type: "azure-active-directory-access-token", options: { token: tokenResp!.token } },
    options: { encrypt: true, trustServerCertificate: false, enableArithAbort: true, useUTC: false },
  } as any);
  await pool.connect();
  console.log(`--- ${label} ---`);
  const request = new sql.Request(pool);
  request.stream = true;
  (request as any).arrayRowMode = true;
  request.on("recordset", (cols: any) => {
    const arr = Array.isArray(cols) ? cols : Object.values(cols);
    console.log("RECORDSET cols:", arr.map((c: any) => c.name));
  });
  request.on("row", (row: any) => {
    const values = Array.isArray(row) ? row : Object.values(row);
    console.log("ROW:", JSON.stringify(values).slice(0, 200));
  });
  request.on("info", (m: any) => console.log("INFO:", m.message));
  request.on("error", (e: any) => console.log("ERROR:", e.message ?? e));
  await new Promise<void>((resolve) => {
    request.on("done", () => {
      console.log("DONE");
      resolve();
    });
    request.batch(sqlText).catch((e: any) => {
      console.log("BATCH REJECTED:", e.message ?? e);
      resolve();
    });
  });
  await pool.close();
}

await run("SET SHOWPLAN_XML ON;\nSELECT 1 AS a;", "SHOWPLAN_XML (estimated)");
await run("SET STATISTICS PROFILE ON;\nSELECT 1 AS a;\nSET STATISTICS PROFILE OFF;", "STATISTICS PROFILE (legacy actual)");
await run("SELECT SERVERPROPERTY('Edition') AS edition, SERVERPROPERTY('EngineEdition') AS engineEdition;", "edition check");
