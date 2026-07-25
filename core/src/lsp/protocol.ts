// Traces: BASED-LSP-TRANSPORT
// Minimal LSP/JSON-RPC plumbing shared by the in-house DuckDB language server and the sqls stdio
// bridge. Deliberately not vscode-languageserver: we implement exactly the handful of methods the
// thin Monaco client uses, and the wire format is one JSON-RPC message per WebSocket text frame
// (Content-Length framing exists only on the sqls stdio pipe).

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return "id" in m && "method" in m;
}
export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return !("id" in m) && "method" in m;
}
export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return "id" in m && !("method" in m);
}

// --- the LSP shapes we actually produce/consume ---

export interface Position {
  line: number;
  /** UTF-16 code units from the line start (LSP default encoding — matches JS string indexing). */
  character: number;
}
export interface Range {
  start: Position;
  end: Position;
}

export const CompletionItemKind = {
  Text: 1,
  Function: 3,
  Field: 5,
  Class: 7,
  Keyword: 14,
} as const;

export interface CompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: { kind: "markdown"; value: string };
  insertText?: string;
  textEdit?: { range: Range; newText: string };
  sortText?: string;
}

export interface Hover {
  contents: { kind: "markdown"; value: string };
  range?: Range;
}

/** Incremental parser for LSP's stdio framing (`Content-Length: N\r\n\r\n<body>`), used to read the
 *  sqls child's stdout. Feed it raw chunks; it yields complete JSON messages. */
export class StdioFrameReader {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): JsonRpcMessage[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    const messages: JsonRpcMessage[] = [];
    for (;;) {
      const headerEnd = indexOfSeq(this.buffer, HEADER_END);
      if (headerEnd < 0) break;
      const header = new TextDecoder().decode(this.buffer.subarray(0, headerEnd));
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Malformed header — drop it and resync rather than wedging the stream.
        this.buffer = this.buffer.subarray(headerEnd + HEADER_END.length);
        continue;
      }
      const bodyLen = Number(match[1]);
      const bodyStart = headerEnd + HEADER_END.length;
      if (this.buffer.length < bodyStart + bodyLen) break;
      const body = new TextDecoder().decode(this.buffer.subarray(bodyStart, bodyStart + bodyLen));
      this.buffer = this.buffer.subarray(bodyStart + bodyLen);
      try {
        messages.push(JSON.parse(body) as JsonRpcMessage);
      } catch {
        // Skip unparseable bodies; the stream remains framed.
      }
    }
    return messages;
  }
}

const HEADER_END = new Uint8Array([13, 10, 13, 10]); // \r\n\r\n

function indexOfSeq(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Encode one message with stdio framing for the sqls child's stdin. */
export function encodeStdioFrame(message: JsonRpcMessage): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message));
  const header = new TextEncoder().encode(`Content-Length: ${body.length}\r\n\r\n`);
  const out = new Uint8Array(header.length + body.length);
  out.set(header);
  out.set(body, header.length);
  return out;
}
