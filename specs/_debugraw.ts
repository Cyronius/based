import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";

const cred = new AzureCliCredential();
const tokenResp = await cred.getToken("https://database.windows.net/.default");

const pool = new sql.ConnectionPool({
  server: "zl5qolt7t8.database.windows.net",
  port: 1433,
  database: "learnermobile_db_ci",
  authentication: { type: "azure-active-directory-access-token", options: { token: tokenResp!.token } },
  options: { encrypt: true, trustServerCertificate: false, enableArithAbort: true, useUTC: false },
} as any);
await pool.connect();

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
request.on("error", (e: any) => console.log("ERROR:", e.message ?? e));
request.on("done", () => console.log("DONE"));

const sqlText = `SET STATISTICS XML OFF;
SET STATISTICS IO, TIME OFF;
SET STATISTICS XML ON;
BEGIN TRY
SELECT 1 AS a
END TRY
BEGIN CATCH
  SET STATISTICS XML OFF;
SET STATISTICS IO, TIME OFF;
  THROW;
END CATCH
SET STATISTICS XML OFF;
SET STATISTICS IO, TIME OFF;`;

await request.batch(sqlText);
await pool.close();
