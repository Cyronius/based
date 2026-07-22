import { MssqlAdapter, testConnection } from "@based/core";

const cfg = {
  id: "spec-dev",
  name: "spec-dev",
  server: process.env.BASED_TEST_SERVER ?? "zl5qolt7t8.database.windows.net",
  database: process.env.BASED_TEST_DB ?? "learnermobile_db_ci",
  authType: "azure-cli" as const,
  encrypt: true,
  trustServerCertificate: false,
  createdAt: "",
  updatedAt: "",
};
const noSecret = () => null;

const adapter = new MssqlAdapter(cfg, noSecret);
const chunks: any[] = [];
const exec = adapter.execute(
  "SELECT 1 AS a",
  (c) => {
    chunks.push(c);
    console.log(JSON.stringify(c).slice(0, 400));
  },
  { capturePlan: true },
);
const r = await exec.completion;
console.log("status", r);
await adapter.disconnect();
