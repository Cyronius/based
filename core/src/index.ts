export { APP_VERSION } from "./version";
export { startServer, type ServerOptions, type RunningServer } from "./server";
// Concrete adapter classes are deliberately NOT re-exported here (BASED-LAZY-ENGINES): importing
// @based/core must not evaluate an engine's native stack. Use @based/core/mssql or
// @based/core/lancedb to reach a concrete class (tests do); runtime code goes through createAdapter.
export { serializeLanceValue } from "./db/lanceSerialize";
export { encodeVectorSample, decodeVectorSample } from "./db/vectorWire";
export { createAdapter, engineOf, testConnection } from "./db/adapterFactory";
export { splitBatches } from "./db/batch";
export { serializeValue, serializeRow, formatSqlDate } from "./db/serialize";
export { buildEditCommands, quoteIdent, qualified, type TableChangeSet, type EditColumnMeta } from "./db/tableEdit";
export { isRetryableError, withReconnect, MAX_RECONNECT_ATTEMPTS } from "./db/retry";
export { RowCollector, DEFAULT_ROW_CAP } from "./db/rowcap";
export { toCsv, cellText } from "./export/csv";
export { writeXlsx } from "./export/xlsx";
export { openDb, dataDir, appDataRoot } from "./storage/db";
export { ConnectionStore } from "./storage/connections";
export { TabStore, type TabRecord, type TabKind } from "./storage/tabs";
export { WindowStateStore, type WindowStateRecord } from "./storage/windowState";
export { HistoryStore, type HistoryEntry } from "./storage/history";
export { SettingsStore, DEFAULT_SETTINGS, type AppSettings } from "./storage/settings";
export {
  MAX_SECRET_BYTES,
  keyringUnavailableReason,
  setSecret,
  getSecret,
  deleteSecret,
  setAiKey,
  getAiKey,
  deleteAiKey,
  setEmbeddingKey,
  getEmbeddingKey,
  deleteEmbeddingKey,
  setRerankerKey,
  getRerankerKey,
  deleteRerankerKey,
} from "./secrets";
export { EmbeddingProfileStore, type EmbeddingProfile, type EmbeddingProfileInput } from "./storage/embeddingProfiles";
export { RerankerProfileStore, type RerankerProfile, type RerankerProfileInput } from "./storage/rerankerProfiles";
export { AiProfileStore, type AiProfile, type AiProfileInput } from "./storage/aiProfiles";
export { resolveEmbeddingProfile, resolveRerankerProfile } from "./db/searchProfileResolve";
export { embedQuery } from "./db/embeddings";
export { rerank, parseCohereRerankResults, scoreFromTopLogprobs, type RerankResult } from "./db/reranker";
export { isReadOnly, firstKeyword, stripSqlComments, stripStringLiterals } from "./db/classify";
export { wrapBatch, skipsWrap } from "./db/planWrap";
export {
  scriptObject,
  scriptCreateTable,
  scriptDropTable,
  scriptDropModule,
  scriptSelectTemplate,
  scriptInsertTemplate,
  rewriteCreateToAlter,
  formatTypeTsql,
  joinScripts,
  type ScriptAction,
  type ScriptInput,
  type ModuleType,
} from "./db/scripter";
export {
  AiConfigStore,
  resolveModel,
  resolveExecutionDefaults,
  providerOptionsNamespace,
  resolveAiTimeouts,
  DEFAULT_AI_TIMEOUT_SECONDS,
  AI_RUN_TIMEOUT_MULTIPLIER,
  type AiConfig,
  type ProviderKind,
  type ExecutionDefaults,
  type AiTimeouts,
} from "./agent/provider";
export { AuditStore, type AuditEntry, type AuditSink } from "./agent/audit";
export { collectQuery, AGENT_ROW_CAP, type CollectedResult } from "./agent/runSql";
export { buildAgentTools, type ToolDeps } from "./agent/tools";
export { agentSurfaceFor, defaultCapabilitiesFor, type EngineAgentSurface } from "./agent/surface";
export { buildAgent, AGENT_ID, agentInstructions, GENERIC_CORE } from "./agent/agent";
export {
  delegateTool,
  reportFindingsTool,
  DELEGATE_MAX_TASKS,
  SUBAGENT_CONCURRENCY,
  SUBAGENT_MAX_STEPS,
  SUBAGENT_SAMPLE_ROWS,
  SUBAGENT_SUMMARY_CAP,
  type SubagentArtifact,
  type SubagentResult,
  type SubagentRunner,
  type SubagentTask,
} from "./agent/tools/delegate";
export { createSubagentRunner, taggedAudit, SUBAGENT_CORE, type SubagentRunnerOptions } from "./agent/subagent";
export { mssqlBriefing, MSSQL_PERSONA } from "./agent/tools/mssql";
export { lanceBriefing, LANCE_PERSONA } from "./agent/tools/lancedb";
export { snowflakeBriefing, SNOWFLAKE_PERSONA } from "./agent/tools/snowflake";
// Traces: BASED-ENGINE-REGISTRY — the registry itself, so tests can assert every engine is complete
// rather than enumerating engines a second time and drifting from it.
export {
  ENGINES,
  ENGINE_IDS,
  descriptorFor,
  descriptorForConfig,
  engineProfiles,
} from "./engines/registry";
export type {
  AuthModeSpec,
  EngineAgentProse,
  EngineDescriptor,
  EngineProfile,
  FieldSpec,
  NamespaceProfile,
} from "./engines/descriptor";
export { migrateConnection, settingBool, settingStr } from "./db/connectionSettings";
export {
  DUCKDB_DIALECT,
  SNOWFLAKE_DIALECT,
  TSQL_DIALECT,
  type SqlDialect,
} from "./db/dialect";
export {
  AgentInstructionsStore,
  DEFAULT_INSTRUCTIONS_CONFIG,
  type AgentInstructionsConfig,
  type InstructionSet,
} from "./agent/instructionsStore";
export * as skills from "./agent/skills";
export { createAgentMemory, MEMORY_LAST_MESSAGES } from "./agent/memory";
export {
  boundRows,
  payloadBudget,
  TOOL_CELL_CAP,
  TOOL_PAYLOAD_CAP,
  type BoundedRows,
  type PayloadBudget,
} from "./agent/toolPayload";
export {
  contextRecoveryProcessor,
  isContextOverflowError,
  shedLargestToolResult,
  CONTEXT_RECOVERY_MAX_ATTEMPTS,
  SHED_TOOL_RESULT_NOTE,
} from "./agent/contextRecovery";
export { describeLanceSchema } from "./db/lanceDescribe";
export { exportData, sanitizeExportFileName, EXPORT_ROW_CAP, type ExportSource, type ExportResult } from "./export/exportData";
export {
  sanitizeSaveFileName,
  isAllowedSaveExtension,
  resolveDownloadDir,
  parseXdgDownloadDir,
  writeTextFileUnique,
  SAVE_FILE_EXTENSIONS,
  MAX_SAVE_FILE_BYTES,
  type SaveFileExtension,
} from "./files/saveFile";
export { transcriptMarkdown, defaultTranscriptFileName, type TranscriptOptions } from "./agent/transcript";
export { renderTabContext } from "./agent/tabContext";
export {
  buildLabelPrompt,
  clampClusters,
  parseLabelResponse,
  labelClusters,
  MAX_LABEL_CLUSTERS,
  MAX_LABEL_SAMPLES,
  MAX_SAMPLE_CHARS,
  type LabelCluster,
} from "./agent/labelClusters";
export { mapDbMessagesToAgui, type DbMessageLike } from "./agent/threadMessages";
export * from "./db/types";
