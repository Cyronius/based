// Traces: BASED-ENGINE-PROFILE-WIRE
// Reading a connection through its engine's served profile. Every helper here replaces a place the
// UI used to compare an engine id or index a hardcoded Record<AuthType, string> — both of which
// silently produce wrong output (or `undefined`) for an engine added after they were written.
import { engineOf, type ConnectionConfig, type EngineProfile } from "../api/types";

export function profileFor(conn: { engine?: string }, profiles: EngineProfile[]): EngineProfile | undefined {
  return profiles.find((p) => p.id === engineOf(conn));
}

/** The human label of a connection's auth mode. Falls back to the raw id rather than to
 *  `undefined`, which is what a hardcoded Record produced for an unrecognized auth type. */
export function authLabel(conn: ConnectionConfig, profiles: EngineProfile[]): string {
  return profileFor(conn, profiles)?.authModes.find((m) => m.id === conn.authType)?.label ?? conn.authType;
}

/** The dim subtitle under a connection name: whichever field the engine nominates (server, uri,
 *  account …), plus the human label of its auth mode. */
export function connSubtitle(conn: ConnectionConfig, profiles: EngineProfile[]): string {
  const target = connTarget(conn, profiles) || "local";
  const auth = authLabel(conn, profiles);
  return auth ? `${target} · ${auth}` : target;
}

/** The connection's primary target, for the status bar. */
export function connTarget(conn: ConnectionConfig, profiles: EngineProfile[]): string {
  const profile = profileFor(conn, profiles);
  return String(conn.settings?.[profile?.subtitleField ?? "server"] ?? "") || conn.database || "";
}

/** Identifier quoting for SQL the UI generates itself. Falls back to double quotes, which is the
 *  SQL standard and correct for every engine here except SQL Server. */
export function quoteIdent(name: string, profile: EngineProfile | undefined): string {
  const q = profile?.quote ?? { open: '"', close: '"', escape: '""' };
  return `${q.open}${name.split(q.close).join(q.escape)}${q.close}`;
}
