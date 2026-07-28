// Traces: BASED-TABLE-DML, BASED-SCRIPT-TSQL
// The per-engine SQL spelling rules, as data. Every place that used to ask "is this mssql?" to
// decide how to quote an identifier, name a bind, or page a result asks a SqlDialect instead — so
// adding an engine adds a dialect object, not another ternary. Pure: no DB access, no engine
// imports, fully unit-testable.
//
// This is deliberately the *spelling* layer only. What an engine can DO lives in EngineCapabilities;
// what its namespaces are CALLED will live in the engine descriptor. Keep those apart — conflating
// them is what produced the mssql-vs-everything-else branches this replaces.

export interface SqlDialect {
  id: string;
  /** Agent-facing name of the dialect, e.g. "T-SQL". Used verbatim in tool descriptions. */
  name: string;
  /** Strict-guarded quoting for the write path. Throws on anything outside the safe charset —
   *  this is an injection guard, not a formatter (see tableEdit.ts). */
  quoteIdent(name: string): string;
  /** Permissive quoting for the read/scripting path: escapes rather than rejects, so any legal
   *  object name round-trips. Never use this on a string that reaches a write command. */
  escapeIdent(name: string): string;
  qualified(schema: string, name: string): string;
  /** Placeholder for the i-th bound parameter of a command. Named on engines that support it
   *  (`@p0`), positional on engines that don't (`?`) — in which case binds ride in emission order. */
  param(i: number, name: string): string;
  /** True when `param()` is positional, so the adapter binds an ordered array rather than a map. */
  positionalParams: boolean;
  /** The tail of a paged SELECT, after ORDER BY. */
  page(offset: number, limit: number): string;
  /** What an unquoted identifier becomes in the catalog. Snowflake upper-cases; SQL Server keeps
   *  the declared case. Consumers must match the stored form rather than normalizing defensively. */
  identifierCase: "preserve" | "upper";
  /** Namespace used when the caller names none. */
  defaultSchema: string;
  /** Whether `INSERT INTO t DEFAULT VALUES` exists. Where it doesn't (Snowflake), inserting an
   *  all-defaults row is refused with a clear error rather than emitted as invalid SQL. */
  supportsDefaultValues: boolean;
}

/** Column/table names containing only letters, digits, spaces, underscores — rejects `;`, brackets,
 *  quotes. Shared by every dialect's strict `quoteIdent`: the guard is about what we refuse to
 *  emit, which is engine-independent, not about how the survivor is spelled. */
const SAFE_IDENT = /^[A-Za-z0-9_ ]+$/;

function guard(name: string): string {
  if (!SAFE_IDENT.test(name)) throw new Error(`Invalid identifier: ${JSON.stringify(name)}`);
  return name;
}

export const TSQL_DIALECT: SqlDialect = {
  id: "tsql",
  name: "T-SQL",
  quoteIdent: (name) => `[${guard(name)}]`,
  escapeIdent: (name) => `[${name.replace(/]/g, "]]")}]`,
  qualified(schema, name) {
    return `${this.escapeIdent(schema)}.${this.escapeIdent(name)}`;
  },
  param: (_i, name) => `@${name}`,
  positionalParams: false,
  page: (offset, limit) => `OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`,
  identifierCase: "preserve",
  defaultSchema: "dbo",
  supportsDefaultValues: true,
};

export const SNOWFLAKE_DIALECT: SqlDialect = {
  id: "snowflake",
  name: "Snowflake SQL",
  quoteIdent: (name) => `"${guard(name)}"`,
  escapeIdent: (name) => `"${name.replace(/"/g, '""')}"`,
  qualified(schema, name) {
    return `${this.escapeIdent(schema)}.${this.escapeIdent(name)}`;
  },
  // snowflake-sdk binds positionally: `binds: [...]` matched to `?` in emission order.
  param: () => `?`,
  positionalParams: true,
  page: (offset, limit) => `LIMIT ${limit} OFFSET ${offset}`,
  identifierCase: "upper",
  defaultSchema: "PUBLIC",
  supportsDefaultValues: false,
};

/** DuckDB (the LanceDB SQL bridge). Present so no consumer has to special-case a missing dialect;
 *  LanceDB has `write: false`, so the write-path members are never exercised. */
export const DUCKDB_DIALECT: SqlDialect = {
  id: "duckdb",
  name: "DuckDB SQL",
  quoteIdent: (name) => `"${guard(name)}"`,
  escapeIdent: (name) => `"${name.replace(/"/g, '""')}"`,
  qualified(schema, name) {
    return `${this.escapeIdent(schema)}.${this.escapeIdent(name)}`;
  },
  param: () => `?`,
  positionalParams: true,
  page: (offset, limit) => `LIMIT ${limit} OFFSET ${offset}`,
  identifierCase: "preserve",
  defaultSchema: "main",
  supportsDefaultValues: false,
};
