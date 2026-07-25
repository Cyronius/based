// Traces: BASED-AGENT-TAB-CONTEXT
// Render the client's workspace snapshot (RunAgentInput.forwardedProps.tabContext) into a
// <workspace_context> instructions block. Pure and defensive: the wire shape is client-supplied
// and untrusted — absent/malformed input returns null and the agent runs without context. NOTE:
// this rides forwardedProps (rendered server-side into instructions) because a client-injected
// system message would be silently dropped by @ag-ui/mastra's converter (user/assistant/tool only).

const MAX_SQL_CHARS = 4_000;
const MAX_TABS = 30;
const MAX_TOTAL_CHARS = 8_000;

interface RawResultSummary {
  columns?: unknown;
  rowCount?: unknown;
  truncated?: unknown;
}

interface RawActiveTab {
  id?: unknown;
  kind?: unknown;
  title?: unknown;
  sql?: unknown;
  schema?: unknown;
  table?: unknown;
  name?: unknown;
  view?: unknown;
  lastRun?: { status?: unknown; durationMs?: unknown } | null;
  resultSummaries?: unknown;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function describeResultSummary(raw: RawResultSummary): string | null {
  const rowCount = typeof raw.rowCount === "number" ? raw.rowCount : null;
  if (rowCount == null) return null;
  const cols = Array.isArray(raw.columns) ? raw.columns.filter((c): c is string => typeof c === "string") : [];
  const colText = cols.length > 0 ? ` [${cols.slice(0, 20).join(", ")}${cols.length > 20 ? ", …" : ""}]` : "";
  return `${rowCount} rows${raw.truncated === true ? " (truncated)" : ""}${colText}`;
}

function describeActiveTab(raw: RawActiveTab): string[] {
  const lines: string[] = [];
  const title = str(raw.title) ?? "(untitled)";
  const kind = str(raw.kind) ?? "unknown";
  const id = str(raw.id) ?? "?";
  lines.push(`Active tab: "${title}" (${kind}, id ${id})`);
  if (kind === "table" || kind === "routine") {
    const objectName = [str(raw.schema), str(raw.table) ?? str(raw.name)].filter(Boolean).join(".");
    if (objectName) lines.push(`Object: ${objectName}${str(raw.view) ? ` (viewing: ${str(raw.view)})` : ""}`);
  }
  const sql = str(raw.sql);
  if (sql) {
    const clipped = sql.length > MAX_SQL_CHARS ? `${sql.slice(0, MAX_SQL_CHARS)}\n-- …truncated…` : sql;
    lines.push(`The tab's SQL editor contains:\n${clipped}`);
  }
  const lastRun = raw.lastRun;
  if (lastRun && typeof lastRun === "object" && str(lastRun.status)) {
    lines.push(`Last run: ${str(lastRun.status)}${typeof lastRun.durationMs === "number" ? ` in ${lastRun.durationMs} ms` : ""}`);
  }
  if (Array.isArray(raw.resultSummaries) && raw.resultSummaries.length > 0) {
    const summaries = raw.resultSummaries
      .map((rs) => describeResultSummary((rs ?? {}) as RawResultSummary))
      .filter((s): s is string => s != null);
    if (summaries.length > 0) lines.push(`Result sets: ${summaries.join("; ")}`);
  }
  return lines;
}

/** Validate + render the workspace snapshot. Returns null for absent/garbage input. */
export function renderTabContext(raw: unknown): string | null {
  if (raw == null || typeof raw !== "object") return null;
  const ctx = raw as { activeTab?: unknown; openTabs?: unknown };
  const hasActive = ctx.activeTab != null && typeof ctx.activeTab === "object";
  const openTabs = Array.isArray(ctx.openTabs) ? ctx.openTabs : [];
  if (!hasActive && openTabs.length === 0) return null;

  const lines: string[] = [];
  if (hasActive) lines.push(...describeActiveTab(ctx.activeTab as RawActiveTab));
  else lines.push("Active tab: none");

  const tabLines = openTabs
    .slice(0, MAX_TABS)
    .map((t) => {
      const tab = (t ?? {}) as { id?: unknown; kind?: unknown; title?: unknown };
      const id = str(tab.id);
      if (!id) return null;
      return `[${id}] ${str(tab.kind) ?? "?"} "${str(tab.title) ?? ""}"`;
    })
    .filter((s): s is string => s != null);
  if (tabLines.length > 0) {
    const more = openTabs.length > MAX_TABS ? ` (+${openTabs.length - MAX_TABS} more)` : "";
    lines.push(`Open tabs: ${tabLines.join(", ")}${more}`);
  }

  let body = lines.join("\n");
  if (body.length > MAX_TOTAL_CHARS) body = `${body.slice(0, MAX_TOTAL_CHARS)}\n…truncated…`;
  return `<workspace_context>\n${body}\n</workspace_context>`;
}
