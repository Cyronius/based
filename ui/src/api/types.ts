// Wire types mirroring core/src/db/types.ts (kept separate so the webview never imports Bun-flavored modules).
export type AuthType = "entra-interactive" | "azure-cli" | "sql-login" | "service-principal";

export interface ConnectionConfig {
  id: string;
  name: string;
  server: string;
  database: string;
  authType: AuthType;
  username?: string;
  tenantId?: string;
  clientId?: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionInput extends Omit<ConnectionConfig, "id" | "createdAt" | "updatedAt"> {
  id?: string;
  secret?: string;
}

export type DbObjectType = "table" | "view" | "procedure" | "function";

export interface DbObject {
  schema: string;
  name: string;
  type: DbObjectType;
}

export interface TableColumn {
  name: string;
  type: string;
  maxLength: number | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  fkTarget: string | null;
}

export interface ColumnInfo {
  name: string;
  type: string;
}

export type WireValue = string | number | boolean | null | { $: "bin"; len: number; preview: string };

export type QueryChunk =
  | { type: "start"; queryId: string }
  | { type: "resultset"; columns: ColumnInfo[] }
  | { type: "rows"; rows: WireValue[][] }
  | { type: "resultsetEnd"; rowCount: number; truncated: boolean }
  | { type: "message"; text: string }
  | { type: "error"; message: string; line?: number; code?: number }
  | { type: "cancelled" }
  | { type: "done"; durationMs: number; status: "ok" | "error" | "cancelled" };

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface TestResult {
  ok: boolean;
  error?: string;
  serverVersion?: string;
  identity?: string;
}

export interface TabRecord {
  id: string;
  connectionId: string;
  title: string;
  content: string;
  filePath: string | null;
  position: number;
  updatedAt: string;
}

export interface ConnectResponse {
  connectionId: string;
  database: string;
  databases: string[];
  schemas: string[];
  objects: DbObject[];
}

export type ProviderKind = "openai-compatible" | "openai" | "azure-openai" | "anthropic";

export interface AiConfig {
  providerId: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  deployment?: string;
  hasKey: boolean;
}

export interface MutationResult {
  status: "ok" | "error";
  messages: string[];
  errors: string[];
  rowCounts: number[];
  durationMs: number;
}

export function cellText(v: WireValue): string {
  if (v === null) return "NULL";
  if (typeof v === "object") return `<binary ${v.len} bytes> ${v.preview}`;
  return String(v);
}
