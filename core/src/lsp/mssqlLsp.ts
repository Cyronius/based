// Traces: BASED-LSP-MSSQL-NATIVE
// In-house language server for SQL Server, replacing the external sqls bridge. Everything is
// sourced from the session's LIVE authenticated adapter (listObjects + a bulk column query), so
// every auth type works — including Entra, which sqls' DSN model never could — with no external
// binary, no download, no password-embedding DSN. Deliberately heuristic (sqls-grade, not a
// parser): context detection and alias resolution are exported pure functions, unit-tested.
// Shape mirrors duckdbLsp.ts: full-document sync, UTF-16 positions, completion + hover, no
// diagnostics v1 (the client degrades gracefully).
import {
  CompletionItemKind,
  isNotification,
  isRequest,
  type CompletionItem,
  type Hover,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type Position,
} from "./protocol";
import { offsetAt } from "./duckdbLsp";
import type { DbObject } from "../db/types";

const CATALOG_CACHE_MS = 5_000;

const TSQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "TOP", "JOIN", "LEFT JOIN",
  "RIGHT JOIN", "FULL JOIN", "INNER JOIN", "CROSS JOIN", "CROSS APPLY", "OUTER APPLY", "ON",
  "AS", "AND", "OR", "NOT", "IN", "EXISTS", "BETWEEN", "LIKE", "IS NULL", "IS NOT NULL", "CASE",
  "WHEN", "THEN", "ELSE", "END", "DISTINCT", "UNION", "UNION ALL", "EXCEPT", "INTERSECT", "WITH",
  "OVER", "PARTITION BY", "CAST", "CONVERT", "COALESCE", "ISNULL", "DESC", "ASC", "INSERT INTO",
  "VALUES", "UPDATE", "SET", "DELETE FROM", "MERGE", "OUTPUT", "DECLARE", "EXEC", "BEGIN",
  "COMMIT", "ROLLBACK", "TRANSACTION", "OFFSET", "FETCH NEXT", "ROWS ONLY", "PIVOT", "UNPIVOT",
  "COUNT", "SUM", "AVG", "MIN", "MAX", "ROW_NUMBER", "GETDATE", "SYSUTCDATETIME", "NEWID",
];

/** Catalog sources the server needs from the adapter — a structural seam (like the Lance
 *  requireSqlBridge cast) so DatabaseAdapter stays clean of LSP plumbing. */
export interface MssqlCatalogSource {
  listObjects(): Promise<DbObject[]>;
  listAllColumns(): Promise<Array<{ schema: string; table: string; column: string; type: string; isPrimaryKey: boolean }>>;
}

interface Catalog {
  objects: DbObject[];
  columns: Array<{ schema: string; table: string; column: string; type: string; isPrimaryKey: boolean }>;
}

// --- pure helpers (exported for unit tests) ---

export type CompletionContext =
  | { kind: "object"; partial?: string }
  | { kind: "procedure"; partial?: string }
  | { kind: "member"; owner: string; partial?: string }
  | { kind: "general"; partial?: string };

const OBJECT_LEADERS = /\b(from|join|apply|update|into|truncate\s+table)\s+$/i;
const PROC_LEADERS = /\b(exec|execute)\s+$/i;

/** Classify the completion position from the text before the cursor. Heuristic by design. */
export function completionContext(prefix: string): CompletionContext {
  // Peel a trailing partial word so "FROM cust" classifies like "FROM " with partial "cust".
  const m = /^([\s\S]*?)([\w$]*)$/.exec(prefix)!;
  const before = m[1]!;
  const partial = m[2]!;
  const withPartial = <T extends CompletionContext>(ctx: T): T => (partial ? { ...ctx, partial } : ctx);

  const dotted = /(\[([^\]]+)\]|[\w$]+)\.\s*$/.exec(before.slice(-140));
  if (dotted) return withPartial({ kind: "member", owner: dotted[2] ?? dotted[1]! });

  if (OBJECT_LEADERS.test(before)) return withPartial({ kind: "object" });
  if (PROC_LEADERS.test(before)) return withPartial({ kind: "procedure" });
  return withPartial({ kind: "general" });
}

const KEYWORDS_NOT_ALIASES = new Set([
  "where", "on", "join", "inner", "left", "right", "full", "cross", "outer", "group", "order",
  "having", "union", "except", "intersect", "as", "set", "select", "with", "apply", "pivot",
  "unpivot", "for", "option", "and", "or", "not", "values", "output", "when", "then", "else",
  "end", "case", "asc", "desc", "top", "distinct", "into", "from", "update", "delete", "insert",
]);

/** Resolve table aliases (and bare table names) from the whole document: FROM/JOIN/APPLY/UPDATE
 *  targets, `AS` or bare alias form, bracket-quoted names included. */
export function resolveAliases(doc: string): Map<string, { schema: string | null; name: string }> {
  const aliases = new Map<string, { schema: string | null; name: string }>();
  const ident = String.raw`(?:\[[^\]]+\]|[\w$]+)`;
  const re = new RegExp(
    String.raw`\b(?:from|join|apply|update)\s+(${ident})(?:\s*\.\s*(${ident}))?(?:\s+(?:as\s+)?(${ident}))?`,
    "gi",
  );
  const unbracket = (s: string) => (s.startsWith("[") ? s.slice(1, -1) : s);
  for (const m of doc.matchAll(re)) {
    const first = unbracket(m[1]!);
    const second = m[2] ? unbracket(m[2]) : null;
    const schema = second ? first : null;
    const name = second ?? first;
    const aliasRaw = m[3] ? unbracket(m[3]) : null;
    const alias = aliasRaw && !KEYWORDS_NOT_ALIASES.has(aliasRaw.toLowerCase()) ? aliasRaw : null;
    if (alias) aliases.set(alias, { schema, name });
    // The bare table name also resolves to itself so `table.` completes without an alias.
    if (!aliases.has(name)) aliases.set(name, { schema, name });
  }
  return aliases;
}

// --- the server ---

export class MssqlLspServer {
  private documents = new Map<string, string>();
  private catalog: { at: number; data: Catalog } | null = null;
  private disposed = false;

  constructor(
    private readonly source: MssqlCatalogSource,
    private readonly send: (message: JsonRpcMessage) => void,
  ) {}

  onClientMessage(text: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(text) as JsonRpcMessage;
    } catch {
      return;
    }
    if (isRequest(message)) void this.handleRequest(message);
    else if (isNotification(message)) this.handleNotification(message.method, message.params);
  }

  dispose(): void {
    this.disposed = true;
    this.documents.clear();
  }

  private respond(id: number | string, result: unknown): void {
    if (this.disposed) return;
    this.send({ jsonrpc: "2.0", id, result });
  }

  private async handleRequest(req: JsonRpcRequest): Promise<void> {
    try {
      switch (req.method) {
        case "initialize":
          this.respond(req.id, {
            capabilities: {
              positionEncoding: "utf-16",
              textDocumentSync: { openClose: true, change: 1 /* Full */ },
              completionProvider: { triggerCharacters: [".", "[", " "] },
              hoverProvider: true,
            },
            serverInfo: { name: "based-mssql-lsp" },
          });
          return;
        case "shutdown":
          this.respond(req.id, null);
          return;
        case "textDocument/completion":
          this.respond(req.id, await this.completion(req.params as DocPositionParams));
          return;
        case "textDocument/hover":
          this.respond(req.id, await this.hover(req.params as DocPositionParams));
          return;
        default:
          this.send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Unhandled method: ${req.method}` } });
      }
    } catch (err) {
      this.send({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private handleNotification(method: string, params: unknown): void {
    switch (method) {
      case "textDocument/didOpen": {
        const p = params as { textDocument: { uri: string; text: string } };
        this.documents.set(p.textDocument.uri, p.textDocument.text);
        return;
      }
      case "textDocument/didChange": {
        const p = params as { textDocument: { uri: string }; contentChanges: Array<{ text: string }> };
        const last = p.contentChanges.at(-1);
        if (last) this.documents.set(p.textDocument.uri, last.text);
        return;
      }
      case "textDocument/didClose": {
        const p = params as { textDocument: { uri: string } };
        this.documents.delete(p.textDocument.uri);
        return;
      }
      default:
        return;
    }
  }

  // --- completion ---

  private async completion(params: DocPositionParams): Promise<{ isIncomplete: boolean; items: CompletionItem[] }> {
    const doc = this.documents.get(params.textDocument.uri);
    if (doc == null) return { isIncomplete: false, items: [] };
    const prefix = doc.slice(0, offsetAt(doc, params.position));
    const ctx = completionContext(prefix);

    const items = new Map<string, CompletionItem>();
    const put = (item: CompletionItem) => {
      if (!items.has(item.label)) items.set(item.label, item);
    };

    // A dead catalog (connection blip) degrades to keywords — never an error to the client.
    const catalog = await this.getCatalog().catch(() => null);
    if (!catalog) {
      for (const k of TSQL_KEYWORDS) put({ label: k, kind: CompletionItemKind.Keyword });
      return { isIncomplete: false, items: [...items.values()] };
    }

    const putObject = (o: DbObject, sort: string) => {
      const label = o.schema === "dbo" ? o.name : `${o.schema}.${o.name}`;
      put({ label, kind: CompletionItemKind.Class, detail: `${o.type} — ${o.schema}.${o.name}`, sortText: `${sort}${label}` });
    };

    switch (ctx.kind) {
      case "object": {
        for (const o of catalog.objects.filter((o) => o.type === "table" || o.type === "view")) putObject(o, "0");
        break;
      }
      case "procedure": {
        for (const o of catalog.objects.filter((o) => o.type === "procedure" || o.type === "function")) putObject(o, "0");
        break;
      }
      case "member": {
        // schema.… → that schema's objects; alias./table.… → that object's columns.
        const owner = ctx.owner;
        for (const o of catalog.objects.filter((o) => o.schema === owner)) {
          put({ label: o.name, kind: CompletionItemKind.Class, detail: `${o.type} — ${o.schema}.${o.name}` });
        }
        const target = resolveAliases(doc).get(owner) ?? { schema: null, name: owner };
        for (const c of catalog.columns.filter(
          (c) => c.table === target.name && (target.schema == null || c.schema === target.schema),
        )) {
          put({
            label: c.column,
            kind: CompletionItemKind.Field,
            detail: `${c.type}${c.isPrimaryKey ? " ⚿" : ""} — ${c.schema}.${c.table}`,
            sortText: `0${c.column}`,
          });
        }
        break;
      }
      case "general": {
        for (const k of TSQL_KEYWORDS) put({ label: k, kind: CompletionItemKind.Keyword, sortText: `2${k}` });
        for (const o of catalog.objects.filter((o) => o.type === "table" || o.type === "view")) putObject(o, "1");
        // Columns of every object the document references — the useful narrow set, not the DB.
        const referenced = resolveAliases(doc);
        const wanted = new Set([...referenced.values()].map((t) => t.name));
        for (const c of catalog.columns.filter((c) => wanted.has(c.table))) {
          put({ label: c.column, kind: CompletionItemKind.Field, detail: `${c.type} — ${c.schema}.${c.table}`, sortText: `0${c.column}` });
        }
        break;
      }
    }

    return { isIncomplete: false, items: [...items.values()] };
  }

  // --- hover ---

  private async hover(params: DocPositionParams): Promise<Hover | null> {
    const doc = this.documents.get(params.textDocument.uri);
    if (doc == null) return null;
    const word = wordAt(doc, params.position);
    if (!word) return null;
    const catalog = await this.getCatalog().catch(() => null);
    if (!catalog) return null;

    const object = catalog.objects.find((o) => o.name === word);
    if (object && (object.type === "table" || object.type === "view")) {
      const cols = catalog.columns.filter((c) => c.table === object.name && c.schema === object.schema);
      const colLines = cols.map((c) => `- \`${c.column}\` ${c.type}${c.isPrimaryKey ? " ⚿" : ""}`);
      return {
        contents: { kind: "markdown", value: [`**${object.type}** \`${object.schema}.${object.name}\``, "", ...colLines].join("\n") },
      };
    }
    if (object) {
      return { contents: { kind: "markdown", value: `**${object.type}** \`${object.schema}.${object.name}\`` } };
    }
    const column = catalog.columns.find((c) => c.column === word);
    if (column) {
      return {
        contents: {
          kind: "markdown",
          value: `**column** \`${column.schema}.${column.table}.${column.column}\` — \`${column.type}\`${column.isPrimaryKey ? " (primary key)" : ""}`,
        },
      };
    }
    return null;
  }

  private async getCatalog(): Promise<Catalog> {
    if (this.catalog && Date.now() - this.catalog.at < CATALOG_CACHE_MS) return this.catalog.data;
    const [objects, columns] = await Promise.all([this.source.listObjects(), this.source.listAllColumns()]);
    const data: Catalog = { objects, columns };
    this.catalog = { at: Date.now(), data };
    return data;
  }
}

interface DocPositionParams {
  textDocument: { uri: string };
  position: Position;
}

function wordAt(text: string, pos: Position): string | null {
  const offset = offsetAt(text, pos);
  let start = offset;
  while (start > 0 && /[\w$]/.test(text[start - 1]!)) start--;
  let end = offset;
  while (end < text.length && /[\w$]/.test(text[end]!)) end++;
  return end > start ? text.slice(start, end) : null;
}
