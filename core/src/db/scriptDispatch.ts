// Traces: BASED-SCRIPT-OBJECT, BASED-SNOWFLAKE-SCRIPT
// The one place that decides *who* scripts an object. An engine that can generate its own DDL
// (Snowflake's GET_DDL) always beats rebuilding it from catalog rows, so its adapter's scriptObject
// wins; everything else falls back to the pure T-SQL scripter. Keeping this decision here is what
// stops scripter.ts — which is deliberately pure and DB-free — from growing a dialect per engine.
import { scriptObject as scriptTsql, type ScriptAction, type ScriptInput } from "./scripter";
import type { DatabaseAdapter } from "./types";

export function scriptWithAdapter(
  adapter: DatabaseAdapter,
  input: ScriptInput,
  action: ScriptAction,
): Promise<string> {
  if (adapter.scriptObject) return adapter.scriptObject(input, action);
  return Promise.resolve(scriptTsql(input, action));
}
