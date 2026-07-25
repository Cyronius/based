// Traces: BASED-LSP-DUCKDB
// In-house language server for the Lance/DuckDB SQL dialect. No such LSP exists anywhere, so we
// speak the protocol ourselves and source everything from the session's embedded DuckDB (the same
// instance that runs the queries — so completions see the exact attached Lance catalog): DuckDB's
// `autocomplete` extension (sql_auto_complete) for context-aware suggestions, plus
// duckdb_tables()/duckdb_columns()/duckdb_functions() for catalog completions and hover.
// Documents use full-content sync — query tabs are small, and it keeps both sides trivial.
import type { LanceSqlBridge } from "../db/lanceSql";
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

const CATALOG_CACHE_MS = 5_000;

const SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "JOIN",
  "LEFT JOIN", "RIGHT JOIN", "FULL JOIN", "INNER JOIN", "CROSS JOIN", "ON", "AS", "AND", "OR",
  "NOT", "IN", "EXISTS", "BETWEEN", "LIKE", "ILIKE", "IS NULL", "IS NOT NULL", "CASE", "WHEN",
  "THEN", "ELSE", "END", "DISTINCT", "UNION", "UNION ALL", "EXCEPT", "INTERSECT", "WITH",
  "QUALIFY", "WINDOW", "OVER", "PARTITION BY", "USING", "CAST", "DESC", "ASC",
];

interface CatalogTable {
  database: string;
  schema: string;
  name: string;
}
interface CatalogColumn {
  table: string;
  name: string;
  type: string;
}
interface CatalogFunction {
  name: string;
  type: string;
}
interface Catalog {
  tables: CatalogTable[];
  columns: CatalogColumn[];
  functions: CatalogFunction[];
}

export class DuckDbLspServer {
  private documents = new Map<string, string>();
  private catalog: { at: number; data: Catalog } | null = null;
  private autocompleteReady: Promise<boolean> | null = null;
  private disposed = false;

  constructor(
    private readonly getBridge: () => Promise<LanceSqlBridge>,
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
              completionProvider: { triggerCharacters: [".", '"', " "] },
              hoverProvider: true,
            },
            serverInfo: { name: "based-duckdb-lsp" },
          });
          return;
        case "shutdown":
          this.respond(req.id, null);
          return;
        case "textDocument/completion":
          this.respond(req.id, await this.completion(req.params as CompletionParams));
          return;
        case "textDocument/hover":
          this.respond(req.id, await this.hover(req.params as CompletionParams));
          return;
        default:
          // Method we don't implement — LSP requires a response to every request.
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
        return; // initialized, exit, $/… — nothing to do
    }
  }

  // --- completion ---

  private async completion(params: CompletionParams): Promise<{ isIncomplete: boolean; items: CompletionItem[] }> {
    const doc = this.documents.get(params.textDocument.uri);
    if (doc == null) return { isIncomplete: false, items: [] };
    const offset = offsetAt(doc, params.position);
    const prefix = doc.slice(0, offset);

    const items = new Map<string, CompletionItem>();
    const put = (item: CompletionItem) => {
      if (!items.has(item.label)) items.set(item.label, item);
    };

    // 1) Context-aware suggestions from DuckDB's autocomplete extension (best source — it parses
    //    the dialect and sees the attached Lance catalog).
    if (await this.ensureAutocomplete()) {
      try {
        const bridge = await this.getBridge();
        const res = await bridge.runInternal("SELECT suggestion, suggestion_start FROM sql_auto_complete(?)", [prefix]);
        const catalog = await this.getCatalog();
        const tableNames = new Set(catalog.tables.map((t) => t.name));
        const columnNames = new Set(catalog.columns.map((c) => c.name));
        for (const [suggestionRaw, startRaw] of res.rows) {
          const suggestion = String(suggestionRaw);
          const start = Number(startRaw);
          const trimmed = suggestion.trim();
          if (!trimmed) continue;
          put({
            label: trimmed,
            kind: tableNames.has(trimmed)
              ? CompletionItemKind.Class
              : columnNames.has(trimmed)
                ? CompletionItemKind.Field
                : /^[A-Z_ ]+$/.test(trimmed)
                  ? CompletionItemKind.Keyword
                  : CompletionItemKind.Text,
            textEdit: {
              range: { start: positionAt(doc, Math.min(start, offset)), end: params.position },
              newText: suggestion,
            },
            sortText: `0${trimmed}`,
          });
        }
      } catch {
        // Autocomplete hiccup — catalog + keyword fallback below still applies.
      }
    }

    // 2) Catalog + keyword completions (also the entire offline fallback).
    try {
      const catalog = await this.getCatalog();
      const dotted = /([A-Za-z_][\w$]*)\.\s*$/.exec(prefix.slice(-64));
      if (dotted) {
        // `alias.` / `table.` — offer that table's columns (or a namespace's tables).
        const owner = dotted[1]!;
        for (const c of catalog.columns.filter((c) => c.table === owner)) {
          put({ label: c.name, kind: CompletionItemKind.Field, detail: `${c.type} — ${c.table}` });
        }
        for (const t of catalog.tables.filter((t) => t.database === owner || t.schema === owner)) {
          put({ label: t.name, kind: CompletionItemKind.Class, detail: `${t.database}.${t.schema}` });
        }
      } else {
        for (const t of catalog.tables) {
          put({ label: t.name, kind: CompletionItemKind.Class, detail: `table — ${t.database}.${t.schema}` });
        }
        for (const c of catalog.columns) put({ label: c.name, kind: CompletionItemKind.Field, detail: `${c.type} — ${c.table}` });
        for (const f of catalog.functions) put({ label: f.name, kind: CompletionItemKind.Function, detail: f.type });
        for (const k of SQL_KEYWORDS) put({ label: k, kind: CompletionItemKind.Keyword });
      }
    } catch {
      for (const k of SQL_KEYWORDS) put({ label: k, kind: CompletionItemKind.Keyword });
    }

    return { isIncomplete: false, items: [...items.values()] };
  }

  // --- hover ---

  private async hover(params: CompletionParams): Promise<Hover | null> {
    const doc = this.documents.get(params.textDocument.uri);
    if (doc == null) return null;
    const word = wordAt(doc, params.position);
    if (!word) return null;
    const catalog = await this.getCatalog().catch(() => null);
    if (!catalog) return null;

    const table = catalog.tables.find((t) => t.name === word);
    if (table) {
      const cols = catalog.columns.filter((c) => c.table === word);
      const colLines = cols.map((c) => `- \`${c.name}\` ${c.type}${/\bFLOAT\[\d+\]|\bDOUBLE\[\d+\]/.test(c.type) ? " — Lance vector column" : ""}`);
      return {
        contents: {
          kind: "markdown",
          value: [`**table** \`${table.database}.${table.schema}.${table.name}\``, "", ...colLines].join("\n"),
        },
      };
    }
    const column = catalog.columns.find((c) => c.name === word);
    if (column) {
      const vec = /^(FLOAT|DOUBLE)\[(\d+)\]$/i.exec(column.type);
      const desc = vec ? `\`${column.type}\` — Lance vector column (${vec[2]} dims)` : `\`${column.type}\``;
      return { contents: { kind: "markdown", value: `**column** \`${column.table}.${column.name}\` — ${desc}` } };
    }
    const fns = catalog.functions.filter((f) => f.name === word.toLowerCase());
    if (fns.length > 0) {
      return { contents: { kind: "markdown", value: `**${fns[0]!.type}** \`${word}\` (DuckDB)` } };
    }
    return null;
  }

  // --- data sources ---

  private ensureAutocomplete(): Promise<boolean> {
    this.autocompleteReady ??= (async () => {
      try {
        const bridge = await this.getBridge();
        await bridge.runInternal("INSTALL autocomplete; LOAD autocomplete;");
        return true;
      } catch {
        return false; // offline — catalog-only completions
      }
    })();
    return this.autocompleteReady;
  }

  private async getCatalog(): Promise<Catalog> {
    if (this.catalog && Date.now() - this.catalog.at < CATALOG_CACHE_MS) return this.catalog.data;
    const bridge = await this.getBridge();
    const [tables, columns, functions] = await Promise.all([
      bridge.runInternal(
        "SELECT database_name, schema_name, table_name FROM duckdb_tables() WHERE NOT internal ORDER BY database_name, table_name",
      ),
      bridge.runInternal(
        "SELECT table_name, column_name, data_type FROM duckdb_columns() WHERE NOT internal ORDER BY table_name, column_index",
      ),
      bridge.runInternal(
        "SELECT DISTINCT function_name, function_type FROM duckdb_functions() WHERE NOT internal AND function_name NOT LIKE '\\_\\_%' ESCAPE '\\' ORDER BY function_name",
      ),
    ]);
    const data: Catalog = {
      tables: tables.rows.map((r) => ({ database: String(r[0]), schema: String(r[1]), name: String(r[2]) })),
      columns: columns.rows.map((r) => ({ table: String(r[0]), name: String(r[1]), type: String(r[2]) })),
      functions: functions.rows.map((r) => ({ name: String(r[0]), type: String(r[1]) })),
    };
    this.catalog = { at: Date.now(), data };
    return data;
  }
}

interface CompletionParams {
  textDocument: { uri: string };
  position: Position;
}

// --- text/position helpers (UTF-16 code units — LSP default, matches JS string indexing) ---

export function offsetAt(text: string, pos: Position): number {
  let offset = 0;
  let line = 0;
  while (line < pos.line) {
    const nl = text.indexOf("\n", offset);
    if (nl < 0) return text.length;
    offset = nl + 1;
    line++;
  }
  const lineEnd = text.indexOf("\n", offset);
  const lineLen = (lineEnd < 0 ? text.length : lineEnd) - offset;
  return offset + Math.min(pos.character, lineLen);
}

export function positionAt(text: string, offset: number): Position {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: clamped - lineStart };
}

function wordAt(text: string, pos: Position): string | null {
  const offset = offsetAt(text, pos);
  let start = offset;
  while (start > 0 && /[\w$]/.test(text[start - 1]!)) start--;
  let end = offset;
  while (end < text.length && /[\w$]/.test(text[end]!)) end++;
  return end > start ? text.slice(start, end) : null;
}
