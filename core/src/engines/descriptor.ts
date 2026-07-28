// Traces: BASED-ENGINE-REGISTRY, BASED-AGENT-SURFACE-VARIANT, BASED-ENGINE-PROFILE-WIRE
// What an engine IS, as data. Everything the rest of the app used to learn by asking
// "is this mssql?" lives here instead, so adding an engine is writing one descriptor and one
// registry line — not editing twenty call sites, two of which used to be silent `else` branches
// that meant "LanceDB" and would have mis-routed a new engine without a compile error.
//
// The descriptor is split in two on purpose:
//   - `profile` is JSON-serializable and is served to the webview over the wire (GET /api/engines),
//     so the UI renders connection forms, tree grouping and quoting without importing core and
//     without a hand-mirrored copy of the engine list to drift against.
//   - everything else is core-only runtime: adapter loader, dialect, persona, briefing, tools.
//
// Adapter and LSP construction are behind loaders so this module never pulls a native stack
// (BASED-LAZY-ENGINES): importing the registry must stay free.
import type { SqlDialect } from "../db/dialect";
import type { SecretProvider } from "../db/entra";
import type {
  ConnectionConfig,
  DatabaseAdapter,
  DbEngine,
  EngineCapabilities,
} from "../db/types";

// ---------------------------------------------------------------------------------------------
// Wire half — serialized to the UI. Nothing here may be a function or hold a class reference.
// ---------------------------------------------------------------------------------------------

/** One control in the connection dialog. The UI knows the closed set of `kind`s and nothing about
 *  which engine it is rendering, so a new engine's form is new data, not new JSX. */
export interface FieldSpec {
  /** The ConnectionConfig key this control reads and writes. */
  key: string;
  label: string;
  kind:
    | "text"
    | "password"
    | "select"
    | "checkbox"
    /** Filesystem directory with a Browse button (LanceDB local). */
    | "directory"
    /** Filesystem file with a Browse button — for the file-backed sources on the roadmap. */
    | "file"
    /** Picker over the configured embedding profiles. */
    | "embedding-profile"
    /** Picker over the configured reranker profiles. */
    | "reranker-profile";
  required?: boolean;
  placeholder?: string;
  help?: string;
  default?: string | boolean;
  options?: Array<{ value: string; label: string }>;
  /** Show this field only when another field holds one of these values (e.g. region only on
   *  lancedb-cloud). Absent = always visible. */
  visibleWhen?: { field: string; equals: string[] };
}

export interface AuthModeSpec {
  /** An AuthType value. */
  id: string;
  label: string;
  /** Label for the secret input, or null when this mode stores no secret. */
  secretLabel: string | null;
  /** Rendered under the secret input. */
  secretHelp?: string;
  /** The secret spans lines (a PEM, a JSON blob). A single-line `<input>` cannot hold one — the
   *  browser strips newlines on paste — so the dialog must render a textarea for these. */
  secretMultiline?: boolean;
  /** Rendered under the engine picker when this mode is selected — what the user gets by choosing
   *  it (e.g. "LanceDB Cloud has no SQL editor"). Data rather than JSX so a new engine's caveats
   *  ship with its descriptor. */
  note?: string;
}

/** How an engine names the things inside it. This is the abstraction that lets the roadmap's
 *  non-relational and file-backed engines land without another round of branches: a schema, a base
 *  folder, a dataset and a directory of parquet files are the same slot with different words. */
export interface NamespaceProfile {
  /** The namespace's name in the UI and in tool params ("schema", "folder", "dataset"), or null
   *  for engines with no namespace level at all. */
  key: string | null;
  label: string;
  /** Namespace used when a caller names none ("dbo", "PUBLIC", ""). */
  default: string;
  /** What the leaf objects are called, for generated prose. */
  objectNoun: string;
  objectNounPlural: string;
  /** Object explorer layout: "typed" groups tables/views/procedures/functions; "flat" is one list. */
  grouping: "typed" | "flat";
}

export interface EngineProfile {
  id: DbEngine;
  label: string;
  fields: FieldSpec[];
  authModes: AuthModeSpec[];
  namespace: NamespaceProfile;
  /** Which ConnectionConfig field the connection list shows under the name. */
  subtitleField: string;
  /** Identifier quoting, so the webview can build SQL snippets without importing a dialect. */
  quote: { open: string; close: string; escape: string };
  /** What a connection of this engine can do before one is live. Real sessions always use the
   *  adapter's own capabilities, which is the only thing that knows cloud from local. */
  defaultCapabilities: EngineCapabilities;
}

// ---------------------------------------------------------------------------------------------
// Runtime half — core only.
// ---------------------------------------------------------------------------------------------

/** Mastra ToolSet shape kept loose so this module (and db/types) need not depend on mastra. */
export type ToolSet = Record<string, unknown>;

/** The LSP server contract, restated structurally so the registry doesn't import the LSP
 *  subsystem (which would cycle back through the server). */
export interface LspBackend {
  onClientMessage(text: string): void;
  dispose(): void;
}

/** The engine-specific sentences in the shared tools' descriptions. These exist because a tool's
 *  prose must be unconditionally true for the connection it was generated for — the model cannot
 *  evaluate "if this is SQL Server, then…" against a variant it can't see. Keeping them as data per
 *  engine is what replaced the `caps.engine === "mssql" ? A : B` ternaries in shared.ts, whose
 *  else-branch silently meant LanceDB. */
export interface EngineAgentProse {
  /** Description of the namespace tool param, when the engine exposes one for this connection.
   *  Returning null hides the param entirely — a capability the connection lacks means the
   *  parameter is ABSENT, not present-and-ignored. */
  namespaceParam: (caps: EngineCapabilities) => { key: string; description: string } | null;
  /** Namespace used when the caller supplies none — the same value as profile.namespace.default,
   *  repeated here so tool code has one thing to read. */
  namespaceDefault: string;
  /** What list_objects returns, as a noun phrase completing "List everything in this database: …". */
  objectsSummary: (caps: EngineCapabilities) => string;
  /** describe_table's format enum and prose. */
  describeFormats: readonly string[];
  describeDescription: string;
  /** The `table` parameter's description on describe_table / read_table / count_rows. */
  tableParam: string;
  /** run_query's description and its `sql` parameter description. Only read when caps.sql. */
  runQuery: (caps: EngineCapabilities) => { description: string; sqlParam: string };
  /** read_table's description on engines without structured filters. Ignored when the connection
   *  has structuredFilters, which generates its own. */
  readTable?: (caps: EngineCapabilities) => string;
  /** get_indexes prose. Only read when caps.indexIntrospect. */
  indexes?: { description: string; emptyNote: string };
}

export interface EngineDescriptor {
  profile: EngineProfile;
  dialect: SqlDialect;
  /** Lazy so the registry never evaluates an engine's native stack (BASED-LAZY-ENGINES). */
  loadAdapter: (
    cfg: ConnectionConfig,
    getSecret: SecretProvider,
    opts?: { database?: string },
  ) => Promise<DatabaseAdapter>;
  /** Generated facts about a live connection. Injected between the core instructions and the
   *  persona and NEVER user-editable — a fact that can be forked into a fixed string is a fact that
   *  can go stale against the connection it describes. */
  briefing: (caps: EngineCapabilities) => string;
  /** The editable half: voice and policy, deliberately connection-neutral so a user's fork can
   *  never contradict the live briefing. */
  persona: string;
  agentProse: EngineAgentProse;
  /** Tools that exist only on this engine (LanceDB's search family). Shared tools are added by
   *  the surface itself and are never listed here. */
  tools?: (deps: unknown, caps: EngineCapabilities) => ToolSet;
  /** Skill catalog tags this engine opts into; undefined = only universal (untagged) skills. */
  skillTags?: DbEngine[];
  /** SQL keywords offered by the editor's completion, when this engine has a SQL surface. */
  lspKeywords?: readonly string[];
  /** Build the editor's language server for a live connection. Absent = no LSP for this engine
   *  (the editor degrades to Monaco's built-ins, which is the documented fallback). Lazy for the
   *  same reason loadAdapter is. The structural cast each engine needs to reach its own adapter's
   *  catalog methods lives inside this function, not at the call site. */
  loadLsp?: (
    adapter: DatabaseAdapter,
    send: (message: unknown) => void,
  ) => Promise<LspBackend>;
}
