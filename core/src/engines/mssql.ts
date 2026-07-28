// Traces: BASED-ENGINE-REGISTRY — SQL Server as a descriptor. The prose here is verbatim what
// shared.ts used to select with `caps.engine === "mssql" ? … : …`; moving it makes the "else"
// belong to whichever engine is actually being described rather than to LanceDB by default.
import { TSQL_DIALECT } from "../db/dialect";
import { MSSQL_PERSONA, mssqlBriefing } from "../agent/tools/mssql";
import { TSQL_KEYWORDS } from "../lsp/keywords";
import type { EngineDescriptor } from "./descriptor";

export const MSSQL_ENGINE: EngineDescriptor = {
  profile: {
    id: "mssql",
    label: "SQL Server",
    fields: [
      { key: "server", label: "Server", kind: "text", required: true, placeholder: "localhost,1433" },
      { key: "database", label: "Database", kind: "text", required: true, placeholder: "master" },
      {
        key: "username",
        label: "Username",
        kind: "text",
        visibleWhen: { field: "authType", equals: ["sql-login"] },
      },
      {
        key: "tenantId",
        label: "Tenant id",
        kind: "text",
        visibleWhen: { field: "authType", equals: ["entra-interactive", "azure-cli", "service-principal"] },
      },
      {
        key: "clientId",
        label: "Client id",
        kind: "text",
        visibleWhen: { field: "authType", equals: ["service-principal"] },
      },
      { key: "encrypt", label: "Encrypt connection", kind: "checkbox", default: true },
      { key: "trustServerCertificate", label: "Trust server certificate", kind: "checkbox", default: false },
    ],
    authModes: [
      { id: "entra-interactive", label: "Microsoft Entra (interactive)", secretLabel: null },
      { id: "azure-cli", label: "Azure CLI", secretLabel: null },
      { id: "sql-login", label: "SQL login", secretLabel: "Password" },
      { id: "service-principal", label: "Service principal", secretLabel: "Client secret" },
    ],
    namespace: {
      key: "schema",
      label: "Schema",
      default: "dbo",
      objectNoun: "table",
      objectNounPlural: "tables",
      grouping: "typed",
    },
    subtitleField: "server",
    quote: { open: "[", close: "]", escape: "]]" },
    defaultCapabilities: {
      sql: true,
      search: false,
      write: true,
      orderedBrowse: true,
      script: true,
      relations: true,
      engine: "mssql",
      variant: "mssql",
      containers: null,
      wherePredicate: false,
      structuredFilters: true,
      countRows: true,
      takeByKey: false,
      indexIntrospect: true,
    },
  },
  dialect: TSQL_DIALECT,
  loadAdapter: async (cfg, getSecret, opts) => {
    const { MssqlAdapter } = await import("../db/mssqlAdapter");
    return new MssqlAdapter(cfg, getSecret, { database: opts?.database });
  },
  briefing: mssqlBriefing,
  persona: MSSQL_PERSONA,
  lspKeywords: TSQL_KEYWORDS,
  // Traces: BASED-LSP-MSSQL-NATIVE — the in-house server rides the session's live authenticated
  // adapter, so every auth type works (Entra included). listAllColumns is an MssqlAdapter method,
  // not part of the engine-agnostic DatabaseAdapter, so the structural cast lives here.
  loadLsp: async (adapter, send) => {
    const { MssqlLspServer } = await import("../lsp/mssqlLsp");
    const source = adapter as typeof adapter & {
      listAllColumns(): Promise<Array<{ schema: string; table: string; column: string; type: string; isPrimaryKey: boolean }>>;
    };
    return new MssqlLspServer(
      { listObjects: () => adapter.listObjects(), listAllColumns: () => source.listAllColumns() },
      send as never,
      TSQL_KEYWORDS,
    );
  },
  agentProse: {
    namespaceParam: () => ({ key: "schema", description: "Schema (defaults to dbo)" }),
    namespaceDefault: "dbo",
    objectsSummary: () => "tables, views, stored procedures, and functions, with their schema names",
    describeFormats: ["columns", "ddl", "drop", "drop-create", "alter", "select", "insert"],
    describeDescription:
      'Describe one table, view, procedure, or function. format: "columns" (default) returns each column with its type, nullability, and key/FK metadata. "ddl" returns a CREATE script (columns, PK, defaults, checks, FKs, indexes) for a table, or the CREATE body for a view/procedure/function; "drop", "drop-create", "alter", "select", and "insert" return the corresponding T-SQL templates. Returns text and schema only — it never executes anything; to run DDL, propose it through run_mutation.',
    tableParam: "Table, view, procedure, or function name",
    runQuery: () => ({
      description:
        "Execute a read-only T-SQL query against this connection: aggregates, JOINs, GROUP BY, window functions, CTEs. Mutating statements are rejected — propose those through run_mutation.",
      sqlParam: "A single read-only SELECT / CTE statement (T-SQL)",
    }),
    indexes: {
      description:
        "List a table's indexes: name, type, uniqueness, key and included columns, and any filter. Use it to judge whether a query has a usable index before proposing one.",
      emptyNote: "This table has no indexes.",
    },
  },
};
