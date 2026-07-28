// Traces: BASED-TABLE-DML
// Pure edit→SQL builder: turns a grid change set into parameterized commands. No DB access, no
// string-interpolated cell data — every value rides as a param. Identifier-validated so a
// malicious/garbled column or table name can never inject SQL (it throws before emitting anything).
// Spelling (quoting, bind placeholders) comes from a SqlDialect so this stays one builder across
// engines; the *guard* is dialect-independent and lives in dialect.ts.
import { TSQL_DIALECT, type SqlDialect } from "./dialect";
import type { DbCommand, WireValue } from "./types";

/** T-SQL bracket-quoting with the strict injection guard. Retained for existing callers; new code
 *  should reach for a SqlDialect's quoteIdent so it works on every engine. */
export function quoteIdent(name: string): string {
  return TSQL_DIALECT.quoteIdent(name);
}

export function qualified(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/** Minimal column metadata the builder needs (structurally satisfied by TableColumn). */
export interface EditColumnMeta {
  name: string;
  isPrimaryKey: boolean;
}

export interface TableChangeSet {
  schema: string;
  table: string;
  columns: EditColumnMeta[];
  /** Existing rows to update: `key` locates the row by PK, `set` carries the changed columns. */
  updates?: Array<{ key: Record<string, WireValue>; set: Record<string, WireValue> }>;
  /** New rows to insert: a map of column name → value. */
  inserts?: Array<Record<string, WireValue>>;
  /** Rows to delete, located by PK. */
  deletes?: Array<Record<string, WireValue>>;
}

function keyValue(key: Record<string, WireValue>, col: string): WireValue {
  if (!(col in key)) throw new Error(`Missing key column value: ${col}`);
  return key[col]!;
}

/**
 * Build the parameterized commands for a change set, in delete→update→insert order.
 * Update/delete require a primary key (throws otherwise — no command emitted). Param names are
 * per-command (`p0…` for set/insert values, `k0…` for key predicates), so each command binds
 * independently under its own request. On a positional dialect the placeholders are all `?` and
 * `params` order IS the bind order — so within one command, params must be pushed in the same
 * order their placeholders appear in the SQL. UPDATE therefore pushes SET params before WHERE.
 */
export function buildEditCommands(change: TableChangeSet, dialect: SqlDialect = TSQL_DIALECT): DbCommand[] {
  const q = (name: string) => dialect.quoteIdent(name);
  const target = `${q(change.schema)}.${q(change.table)}`;
  const pkCols = change.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
  const commands: DbCommand[] = [];

  for (const del of change.deletes ?? []) {
    if (pkCols.length === 0) throw new Error("Cannot delete rows from a table without a primary key");
    const params: DbCommand["params"] = [];
    const where = pkCols
      .map((col, i) => {
        params!.push({ name: `k${i}`, value: keyValue(del, col) });
        return `${q(col)}=${dialect.param(params!.length - 1, `k${i}`)}`;
      })
      .join(" AND ");
    commands.push({ sql: `DELETE FROM ${target} WHERE ${where}`, params });
  }

  for (const up of change.updates ?? []) {
    if (pkCols.length === 0) throw new Error("Cannot update rows in a table without a primary key");
    const setCols = Object.keys(up.set);
    if (setCols.length === 0) continue;
    const params: DbCommand["params"] = [];
    const setSql = setCols
      .map((col, i) => {
        params!.push({ name: `p${i}`, value: up.set[col]! });
        return `${q(col)}=${dialect.param(params!.length - 1, `p${i}`)}`;
      })
      .join(", ");
    const where = pkCols
      .map((col, i) => {
        params!.push({ name: `k${i}`, value: keyValue(up.key, col) });
        return `${q(col)}=${dialect.param(params!.length - 1, `k${i}`)}`;
      })
      .join(" AND ");
    commands.push({ sql: `UPDATE ${target} SET ${setSql} WHERE ${where}`, params });
  }

  for (const ins of change.inserts ?? []) {
    const cols = Object.keys(ins);
    if (cols.length === 0) {
      if (!dialect.supportsDefaultValues) {
        throw new Error(`${dialect.name} cannot insert an all-defaults row: set at least one column`);
      }
      commands.push({ sql: `INSERT INTO ${target} DEFAULT VALUES`, params: [] });
      continue;
    }
    const params: DbCommand["params"] = [];
    const colSql = cols.map((c) => q(c)).join(",");
    const valSql = cols
      .map((col, i) => {
        params!.push({ name: `p${i}`, value: ins[col]! });
        return dialect.param(params!.length - 1, `p${i}`);
      })
      .join(",");
    commands.push({ sql: `INSERT INTO ${target} (${colSql}) VALUES (${valSql})`, params });
  }

  return commands;
}
