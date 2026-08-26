// Traces: BASED-LANCE-ENGINE, BASED-LANCE-AGENT-SURFACE, BASED-ENGINE-REGISTRY
// LanceDB is the engine that proves the descriptor has to be capability-aware rather than a flat
// table of strings: its three variants (local, base-folder, cloud) differ on SQL, on whether a
// namespace exists at all, and on what a table name even means. Every function below takes the
// live capabilities for exactly that reason.
import { DUCKDB_DIALECT } from "../db/dialect";
import { LANCE_PERSONA, lanceBriefing, lanceTools } from "../agent/tools/lancedb";
import { WHERE_GRAMMAR } from "../agent/tools/whereGrammar";
import { DUCKDB_KEYWORDS } from "../lsp/keywords";
import type { EngineDescriptor, ToolSet } from "./descriptor";

const PAGING_NOTE =
  "Page by increasing `offset`; `hasMore` tells you whether another page may exist. Vector cells are summarized rather than dumped in full — use `columns` to project further.";

export const LANCEDB_ENGINE: EngineDescriptor = {
  profile: {
    id: "lancedb",
    label: "LanceDB",
    fields: [
      {
        key: "uri",
        label: "Directory path",
        kind: "directory",
        required: true,
        placeholder: "C:\\data\\my-lancedb",
        help: "Point this at a single LanceDB directory, or at a folder containing several — subfolders holding their own LanceDB tables are auto-detected and their tables appear flattened in the explorer.",
        visibleWhen: { field: "authType", equals: ["lancedb-local"] },
      },
      {
        key: "uri",
        label: "Database URI",
        kind: "text",
        required: true,
        placeholder: "db://my-database",
        visibleWhen: { field: "authType", equals: ["lancedb-cloud"] },
      },
      {
        key: "region",
        label: "Region",
        kind: "text",
        required: true,
        placeholder: "us-east-1",
        visibleWhen: { field: "authType", equals: ["lancedb-cloud"] },
      },
      // Traces: BASED-LANCE-CONN-DEFAULT-PROFILES — the embedding model that built THIS directory's
      // vectors belongs to the connection, not to app-wide settings. These two keys are top-level on
      // ConnectionConfig rather than in `settings` (the profile-deletion sweep scans them), which the
      // dialog handles by kind rather than by key.
      {
        key: "defaultEmbeddingProfileId",
        label: "Embedding profile",
        kind: "embedding-profile",
        help: "Capi embeds text queries for this connection with this profile, and the Data tab's search preselects it.",
      },
      {
        key: "defaultRerankerProfileId",
        label: "Reranker profile",
        kind: "reranker-profile",
        help: "Only applied when explicitly asked for — it can cost one model call per candidate row.",
      },
    ],
    authModes: [
      {
        id: "lancedb-local",
        label: "Local directory",
        secretLabel: null,
        note: "Local LanceDB folders get a SQL editor (DuckDB with the Lance extension) plus vector, full-text, and hybrid search through Ask Capi.",
      },
      {
        id: "lancedb-cloud",
        label: "LanceDB Cloud",
        secretLabel: "API key",
        note: "LanceDB Cloud has no SQL editor. Browse tables in the left rail and query them with vector, full-text, or hybrid search through Ask Capi.",
      },
    ],
    namespace: {
      // Only the base-folder variant has a namespace, and that isn't knowable until connect() has
      // scanned the directory — so the static profile advertises the folder slot and the runtime
      // agentProse below hides the tool param on the variants that don't have one.
      key: "folder",
      label: "Folder",
      default: "",
      objectNoun: "table",
      objectNounPlural: "tables",
      grouping: "flat",
    },
    subtitleField: "uri",
    quote: { open: '"', close: '"', escape: '""' },
    defaultCapabilities: {
      sql: true,
      search: true,
      write: false,
      createTable: true,
      orderedBrowse: false,
      script: false,
      relations: false,
      engine: "lancedb",
      variant: "lancedb-local",
      containers: null,
      wherePredicate: true,
      structuredFilters: false,
      countRows: true,
      takeByKey: true,
      indexIntrospect: true,
    },
  },
  dialect: DUCKDB_DIALECT,
  loadAdapter: async (cfg, getSecret, opts) => {
    const { LanceDbAdapter } = await import("../db/lanceAdapter");
    return new LanceDbAdapter(cfg, getSecret, { database: opts?.database });
  },
  briefing: lanceBriefing,
  persona: LANCE_PERSONA,
  skillTags: ["lancedb"],
  lspKeywords: DUCKDB_KEYWORDS,
  // DuckDB's own server, because completion here resolves against the lance extension's attached
  // views rather than a relational catalog. requireSqlBridge is LanceDbAdapter's structural seam.
  loadLsp: async (adapter, send) => {
    const { DuckDbLspServer } = await import("../lsp/duckdbLsp");
    const withBridge = adapter as typeof adapter & {
      requireSqlBridge(): import("../db/lanceSql").LanceSqlBridge;
    };
    return new DuckDbLspServer(async () => {
      const bridge = withBridge.requireSqlBridge();
      await bridge.ensureReady();
      return bridge;
    }, send as never);
  },
  tools: (deps, caps) => lanceTools(deps as Parameters<typeof lanceTools>[0], caps) as ToolSet,
  agentProse: {
    namespaceParam: (caps) => {
      if (caps.variant !== "lancedb-basefolder") return null;
      const names = (caps.containers ?? []).join(", ");
      return {
        key: "folder",
        description: `Base folder holding the table${names ? ` — one of: ${names}` : ""}. Required only when the same table name exists in more than one folder.`,
      };
    },
    namespaceDefault: "",
    objectsSummary: (caps) =>
      caps.variant === "lancedb-basefolder" ? "tables, with the base folder each one lives in" : "tables",
    describeFormats: ["columns", "pyarrow"],
    describeDescription:
      'Describe one table\'s schema. format: "columns" (default) returns each column with its type and nullability, and each vector column with its dimension, element type, and index metric. "pyarrow" additionally returns a pyarrow schema snippet for creating a compatible table. Schema only — never row data.',
    tableParam: "Table name",
    runQuery: (caps) => ({
      description:
        caps.variant === "lancedb-basefolder"
          ? "Execute a read-only SQL query (DuckDB dialect) over this base folder's Lance tables. Qualify every table as `folder.main.table` — an unqualified name will not resolve. Aggregates, JOINs, GROUP BY, and CTEs are available. This is a different grammar from the `where` predicates used by read_table and the search tools, so don't carry phrasing between them. Mutating statements are rejected; Lance connections are read-only."
          : "Execute a read-only SQL query (DuckDB dialect) over this connection's Lance tables: aggregates, JOINs, GROUP BY, CTEs. Reads Lance files directly — this is a different grammar from the `where` predicates used by read_table and the search tools, so don't carry phrasing between them. Mutating statements are rejected; Lance connections are read-only.",
      sqlParam: "A single read-only SELECT / CTE statement (DuckDB dialect)",
    }),
    readTable: (caps) =>
      caps.sql
        ? `Read a page of rows from a Lance table, optionally narrowed by a \`where\` predicate. ${PAGING_NOTE} ${WHERE_GRAMMAR} Use run_query for anything this grammar can't express.`
        : `Read a page of rows from a Lance table, optionally narrowed by a \`where\` predicate. This connection has no SQL, so \`where\` is the only way to filter rows. ${PAGING_NOTE} ${WHERE_GRAMMAR}`,
    indexes: {
      description:
        "List a table's indexes: name, index type (IVF_*, HNSW_*, FTS, BTREE, …), the column indexed, the ANN distance metric, and how many rows are indexed vs still unindexed. Call this BEFORE tuning a search: nprobes only applies to IVF indexes and ef only to HNSW ones, and text_search/hybrid_search require an FTS index to exist at all. A large numUnindexedRows is the usual reason a search got slow or missed a recently added row.",
      emptyNote:
        "This table has no indexes: vector search will run exact (slow but precise, and the tuning knobs are no-ops), and text_search/hybrid_search cannot run at all without a full-text index.",
    },
  },
};
