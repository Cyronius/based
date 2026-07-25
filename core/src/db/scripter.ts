// Traces: BASED-SCRIPT-TSQL, BASED-SCRIPT-MODULE-ALTER
// Pure T-SQL scripter: TableDetails / sql_modules text in → runnable DDL out. No DB access, fully
// unit-testable (the tableEdit.ts doctrine). Identifier quoting here is deliberately NOT
// tableEdit's strict `quoteIdent`: that regex is an injection guard on the write path and must
// stay strict; the scripter must handle any legal object name, so it escapes instead.
import type { ScriptTableColumn, TableDetails } from "./types";

export type ScriptAction = "create" | "drop" | "drop-create" | "alter" | "select" | "insert";
export type ModuleType = "view" | "procedure" | "function" | "trigger";

/** Bracket-quote any legal identifier (escaping `]` by doubling). */
export function bq(name: string): string {
  return `[${name.replace(/]/g, "]]")}]`;
}

function qualified(schema: string, name: string): string {
  return `${bq(schema)}.${bq(name)}`;
}

/** Types whose max_length is a character/byte count worth emitting; -1 = max. */
const LENGTH_TYPES = /^(n?var)?(char|binary)$/;
const PRECISION_TYPES = /^(decimal|numeric)$/;
const SCALE_ONLY_TYPES = /^(datetime2|datetimeoffset|time)$/;

/** Render a column's T-SQL type: nvarchar(50)/(max), decimal(10,2), datetime2(3), int, … */
export function formatTypeTsql(c: ScriptTableColumn): string {
  const t = c.type;
  if (LENGTH_TYPES.test(t)) {
    if (c.maxLength === -1) return `${t}(max)`;
    if (c.maxLength != null) return `${t}(${c.maxLength})`;
    return t;
  }
  if (PRECISION_TYPES.test(t) && c.precision != null) return `${t}(${c.precision}${c.scale != null ? `,${c.scale}` : ""})`;
  if (SCALE_ONLY_TYPES.test(t) && c.scale != null) return `${t}(${c.scale})`;
  return t;
}

function keyList(keys: Array<{ name: string; descending: boolean }>): string {
  return keys.map((k) => `${bq(k.name)} ${k.descending ? "DESC" : "ASC"}`).join(", ");
}

function refAction(kind: "DELETE" | "UPDATE", action: string): string {
  if (!action || action === "NO_ACTION") return "";
  return ` ON ${kind} ${action.replace(/_/g, " ")}`;
}

/** SSMS-style CREATE TABLE: columns (identity/computed/nullability), inline PK/UNIQUE constraints,
 *  then ALTER TABLE ADD for defaults/checks/FKs, then CREATE INDEX for the rest. Features outside
 *  v1 scope (partitioning, temporal, FILESTREAM, COLLATE) emit `-- not scripted:` comments. */
export function scriptCreateTable(d: TableDetails): string {
  const target = qualified(d.schema, d.name);
  const lines: string[] = [];

  for (const c of d.columns) {
    if (c.computedDefinition != null) {
      lines.push(`${bq(c.name)} AS ${c.computedDefinition}${c.computedPersisted ? " PERSISTED" : ""}`);
      continue;
    }
    let line = `${bq(c.name)} ${formatTypeTsql(c)}`;
    if (c.isIdentity) line += ` IDENTITY(${c.identitySeed ?? 1},${c.identityIncrement ?? 1})`;
    line += c.nullable ? " NULL" : " NOT NULL";
    lines.push(line);
  }

  // Inline PK + UNIQUE constraints come from the flagged indexes.
  const constraintIndexes = d.indexes.filter((i) => i.isPrimaryKey || i.isUniqueConstraint);
  for (const i of constraintIndexes) {
    const kind = i.isPrimaryKey ? "PRIMARY KEY" : "UNIQUE";
    lines.push(`CONSTRAINT ${bq(i.name)} ${kind} ${i.typeDesc} (${keyList(i.keyColumns)})`);
  }

  const parts: string[] = [`CREATE TABLE ${target} (\n  ${lines.join(",\n  ")}\n);`];

  const notScripted: string[] = [];
  for (const i of d.indexes) {
    if (i.isPrimaryKey || i.isUniqueConstraint) continue;
    if (!/^(NON)?CLUSTERED$/.test(i.typeDesc)) {
      notScripted.push(`index ${i.name} (${i.typeDesc})`);
      continue;
    }
    let stmt = `CREATE ${i.isUnique ? "UNIQUE " : ""}${i.typeDesc} INDEX ${bq(i.name)} ON ${target} (${keyList(i.keyColumns)})`;
    if (i.includedColumns.length > 0) stmt += ` INCLUDE (${i.includedColumns.map(bq).join(", ")})`;
    if (i.filterDefinition) stmt += ` WHERE ${i.filterDefinition}`;
    parts.push(`${stmt};`);
  }

  for (const df of d.defaultConstraints) {
    parts.push(`ALTER TABLE ${target} ADD CONSTRAINT ${bq(df.name)} DEFAULT ${df.definition} FOR ${bq(df.column)};`);
  }
  for (const ck of d.checkConstraints) {
    const withCheck = ck.isDisabled ? "WITH NOCHECK" : "WITH CHECK";
    parts.push(`ALTER TABLE ${target} ${withCheck} ADD CONSTRAINT ${bq(ck.name)} CHECK (${ck.definition});`);
    if (ck.isDisabled) parts.push(`ALTER TABLE ${target} NOCHECK CONSTRAINT ${bq(ck.name)};`);
  }
  for (const fk of d.foreignKeys) {
    const withCheck = fk.isDisabled ? "WITH NOCHECK" : "WITH CHECK";
    parts.push(
      `ALTER TABLE ${target} ${withCheck} ADD CONSTRAINT ${bq(fk.name)} FOREIGN KEY (${fk.columns.map(bq).join(", ")})` +
        ` REFERENCES ${qualified(fk.refSchema, fk.refTable)} (${fk.refColumns.map(bq).join(", ")})` +
        `${refAction("DELETE", fk.onDelete)}${refAction("UPDATE", fk.onUpdate)};`,
    );
    parts.push(`ALTER TABLE ${target} ${fk.isDisabled ? "NOCHECK" : "CHECK"} CONSTRAINT ${bq(fk.name)};`);
  }

  if (notScripted.length > 0) parts.push(`-- not scripted: ${notScripted.join(", ")}`);
  return parts.join("\n");
}

export function scriptDropTable(ref: { schema: string; name: string }): string {
  return `DROP TABLE IF EXISTS ${qualified(ref.schema, ref.name)};`;
}

export function scriptDropModule(type: ModuleType, ref: { schema: string; name: string }): string {
  return `DROP ${type.toUpperCase()} IF EXISTS ${qualified(ref.schema, ref.name)};`;
}

export function scriptSelectTemplate(d: TableDetails): string {
  const cols = d.columns.map((c) => `  ${bq(c.name)}`).join(",\n");
  return `SELECT TOP (1000)\n${cols}\nFROM ${qualified(d.schema, d.name)};`;
}

export function scriptInsertTemplate(d: TableDetails): string {
  const cols = d.columns.filter((c) => !c.isIdentity && c.computedDefinition == null);
  const names = cols.map((c) => bq(c.name)).join(", ");
  const values = cols.map((c) => `/* ${c.name} (${formatTypeTsql(c)}) */`).join(", ");
  return `INSERT INTO ${qualified(d.schema, d.name)} (${names})\nVALUES (${values});`;
}

/**
 * Rewrite a module's CREATE (from sys.sql_modules) to ALTER. Comment-aware: leading whitespace,
 * `--` line comments, and (nestable) block comments are skipped, not searched — the word CREATE
 * inside a leading comment is never rewritten. `CREATE OR ALTER` collapses to `ALTER`. No match →
 * the original text prefixed with a warning comment (never corrupt DDL).
 */
export function rewriteCreateToAlter(definition: string): string {
  // Find the end of the leading trivia (whitespace + comments).
  let i = 0;
  const n = definition.length;
  outer: while (i < n) {
    const ch = definition[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (definition.startsWith("--", i)) {
      const nl = definition.indexOf("\n", i);
      if (nl === -1) break;
      i = nl + 1;
      continue;
    }
    if (definition.startsWith("/*", i)) {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (definition.startsWith("/*", j)) {
          depth++;
          j += 2;
        } else if (definition.startsWith("*/", j)) {
          depth--;
          j += 2;
        } else j++;
      }
      i = j;
      continue;
    }
    break outer;
  }

  const head = definition.slice(0, i);
  const body = definition.slice(i);
  const m = /^create(\s+or\s+alter)?(?=\s+(view|proc(?:edure)?|function|trigger)\b)/i.exec(body);
  if (!m) return `-- based: could not rewrite to ALTER (no CREATE found) — original definition below\n${definition}`;
  return `${head}ALTER${body.slice(m[0].length)}`;
}

export interface ScriptModuleInput {
  kind: "module";
  type: ModuleType;
  schema: string;
  name: string;
  /** The CREATE body from sys.sql_modules. */
  definition: string;
}
export interface ScriptTableInput {
  kind: "table";
  details: TableDetails;
}
export type ScriptInput = ScriptTableInput | ScriptModuleInput;

/** Dispatcher: route an object + action to the right generator; invalid combos throw (the server
 *  collects these per object into the response's `errors`). */
export function scriptObject(input: ScriptInput, action: ScriptAction): string {
  if (input.kind === "table") {
    const ref = { schema: input.details.schema, name: input.details.name };
    switch (action) {
      case "create":
        return scriptCreateTable(input.details);
      case "drop":
        return scriptDropTable(ref);
      case "drop-create":
        return joinScripts([scriptDropTable(ref), scriptCreateTable(input.details)]);
      case "select":
        return scriptSelectTemplate(input.details);
      case "insert":
        return scriptInsertTemplate(input.details);
      case "alter":
        throw new Error('"alter" is not valid for tables (SSMS parity — script CREATE or DROP and CREATE instead)');
    }
  }
  const ref = { schema: input.schema, name: input.name };
  switch (action) {
    case "create":
      return input.definition;
    case "alter":
      return rewriteCreateToAlter(input.definition);
    case "drop":
      return scriptDropModule(input.type, ref);
    case "drop-create":
      return joinScripts([scriptDropModule(input.type, ref), input.definition]);
    case "select":
      if (input.type === "view") return `SELECT TOP (1000) *\nFROM ${qualified(input.schema, input.name)};`;
      throw new Error(`"select" is only valid for tables and views`);
    case "insert":
      throw new Error(`"insert" is only valid for tables`);
  }
}

/** Join scripts with GO separators — each module CREATE must be first in its batch. */
export function joinScripts(scripts: string[]): string {
  return scripts.join("\nGO\n\n");
}
