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

/** Input for create/update/test — may carry the secret transiently; never persisted with it. */
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

/** JSON-safe cell value on the wire. */
export type WireValue = string | number | boolean | null | { $: "bin"; len: number; preview: string };

export type QueryChunk =
  | { type: "resultset"; columns: ColumnInfo[] }
  | { type: "rows"; rows: WireValue[][] }
  | { type: "resultsetEnd"; rowCount: number; truncated: boolean }
  | { type: "message"; text: string }
  | { type: "error"; message: string; line?: number; code?: number }
  | { type: "cancelled" }
  | { type: "done"; durationMs: number; status: "ok" | "error" | "cancelled" };

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface QueryExecution {
  cancel(): void;
  completion: Promise<{ status: "ok" | "error" | "cancelled"; durationMs: number }>;
}

export interface TestResult {
  ok: boolean;
  error?: string;
  serverVersion?: string;
  identity?: string;
}

export interface DatabaseAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  readonly database: string;
  listDatabases(): Promise<string[]>;
  listSchemas(): Promise<string[]>;
  listObjects(): Promise<DbObject[]>;
  getTableColumns(schema: string, table: string): Promise<TableColumn[]>;
  execute(sql: string, onChunk: (chunk: QueryChunk) => void): QueryExecution;
  onStatus(cb: (status: ConnectionStatus, detail?: string) => void): void;
}
