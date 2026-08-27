// Traces: BASED-SNOWFLAKE-ENGINE, BASED-SNOWFLAKE-AUTH, BASED-ENGINE-REGISTRY
import { SNOWFLAKE_DIALECT } from "../db/dialect";
import { SNOWFLAKE_PERSONA, snowflakeBriefing } from "../agent/tools/snowflake";
import { SNOWFLAKE_KEYWORDS } from "../lsp/keywords";
import type { EngineDescriptor } from "./descriptor";

export const SNOWFLAKE_ENGINE: EngineDescriptor = {
  profile: {
    id: "snowflake",
    label: "Snowflake",
    fields: [
      {
        key: "account",
        label: "Account",
        kind: "text",
        required: true,
        placeholder: "myorg-myaccount",
        // The region/cloud half is the part people leave off, and leaving it off does not fail
        // loudly: the wildcard domain still resolves and Snowflake's shared balancer just 404s.
        help: 'Everything before .snowflakecomputing.com in your Snowflake URL — either "myorg-myaccount", or a legacy locator with its region and cloud, e.g. "xy12345.us-east-2.aws". A bare locator works only in AWS us-west-2.',
      },
      { key: "database", label: "Database", kind: "text", required: true },
      { key: "schema", label: "Schema", kind: "text", placeholder: "PUBLIC" },
      { key: "warehouse", label: "Warehouse", kind: "text", help: "The virtual warehouse that runs this connection's queries" },
      { key: "role", label: "Role", kind: "text", help: "Optional — the role to assume on connect" },
      { key: "username", label: "Username", kind: "text", required: true },
    ],
    authModes: [
      { id: "snowflake-password", label: "Password", secretLabel: "Password" },
      {
        id: "snowflake-keypair",
        label: "Key pair (JWT)",
        secretLabel: "Private key (PEM)",
        secretMultiline: true,
        // The passphrase has no field of its own on purpose: it is a credential, so it belongs in
        // the keyring rather than the connections store, and the secret channel holds one string
        // per connection — hence the JSON blob (see BASED-SNOWFLAKE-AUTH). Say so here, since the
        // blob is otherwise undiscoverable.
        secretHelp:
          'Paste the full PEM, including the BEGIN/END lines. For an encrypted key, paste {"key":"<PEM>","pass":"<passphrase>"} instead. Key-pair auth is also how a service account satisfies Snowflake\'s MFA policy, which blocks password sign-in.',
      },
      { id: "snowflake-oauth", label: "SSO (external browser)", secretLabel: null },
    ],
    namespace: {
      key: "schema",
      label: "Schema",
      default: "PUBLIC",
      objectNoun: "table",
      objectNounPlural: "tables",
      grouping: "typed",
    },
    subtitleField: "account",
    quote: { open: '"', close: '"', escape: '""' },
    // Traces: BASED-AGENT-SURFACE-VARIANT — indexIntrospect is false because Snowflake has no
    // user-defined indexes. get_indexes is therefore ABSENT from the surface rather than present
    // and answering a question the engine cannot answer.
    defaultCapabilities: {
      sql: true,
      search: false,
      write: true,
      createTable: false,
      orderedBrowse: true,
      script: true,
      relations: true,
      engine: "snowflake",
      variant: "snowflake",
      containers: null,
      wherePredicate: false,
      structuredFilters: true,
      countRows: true,
      takeByKey: false,
      indexIntrospect: false,
    },
  },
  dialect: SNOWFLAKE_DIALECT,
  loadAdapter: async (cfg, getSecret, opts) => {
    const { SnowflakeAdapter } = await import("../db/snowflakeAdapter");
    return new SnowflakeAdapter(cfg, getSecret, { database: opts?.database });
  },
  briefing: snowflakeBriefing,
  persona: SNOWFLAKE_PERSONA,
  lspKeywords: SNOWFLAKE_KEYWORDS,
  // The same catalog-backed server SQL Server uses — object and column completion is dialect-
  // neutral — with Snowflake's keyword list instead of T-SQL's, so the editor never suggests TOP
  // or GETDATE on a connection that rejects them.
  loadLsp: async (adapter, send) => {
    const { MssqlLspServer } = await import("../lsp/mssqlLsp");
    const source = adapter as typeof adapter & {
      listAllColumns(): Promise<Array<{ schema: string; table: string; column: string; type: string; isPrimaryKey: boolean }>>;
    };
    return new MssqlLspServer(
      { listObjects: () => adapter.listObjects(), listAllColumns: () => source.listAllColumns() },
      send as never,
      SNOWFLAKE_KEYWORDS,
    );
  },
  agentProse: {
    namespaceParam: () => ({ key: "schema", description: "Schema (defaults to PUBLIC)" }),
    namespaceDefault: "PUBLIC",
    objectsSummary: () => "tables, views, stored procedures, and functions, with their schema names",
    // No "alter": Snowflake's GET_DDL already emits CREATE OR REPLACE for modules, and there is no
    // ALTER template for a table worth generating.
    describeFormats: ["columns", "ddl", "drop", "drop-create", "select", "insert"],
    describeDescription:
      'Describe one table, view, procedure, or function. format: "columns" (default) returns each column with its type, nullability, and key/FK metadata. "ddl" returns Snowflake\'s own GET_DDL output for the object; "drop", "drop-create", "select", and "insert" return the corresponding Snowflake SQL templates. Returns text and schema only — it never executes anything; to run DDL, propose it through run_mutation.',
    tableParam: "Table, view, procedure, or function name",
    runQuery: () => ({
      description:
        "Execute a read-only Snowflake SQL query against this connection: aggregates, JOINs, GROUP BY, QUALIFY, window functions, CTEs. Every query consumes warehouse credits, so prefer LIMIT or SAMPLE while exploring. Mutating statements are rejected — propose those through run_mutation.",
      sqlParam: "A single read-only SELECT / CTE statement (Snowflake SQL)",
    }),
  },
};
