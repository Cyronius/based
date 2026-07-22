import { StandardTool, ToolDefinition, ToolRenderer, ToolConfigResponse } from './index';
export declare function getAllToolDefinitions(tools: Record<string, ToolDefinition>): StandardTool[];
export declare function getFrontendToolDefinitions(tools: Record<string, ToolDefinition>): StandardTool[];
export declare function getBackendToolDefinitions(tools: Record<string, ToolDefinition>): StandardTool[];
export declare function getFrontEndTools(tools: Record<string, ToolDefinition>): Record<string, ToolDefinition>;
/**
 * Merge backend tool configs with frontend-supplied handlers/renderers/onResult.
 *
 * The backend owns the schema and configJson; the frontend owns the code that runs
 * handlers and renders results. This helper joins them by tool name, producing a
 * full ToolDefinition map ready to pass into useAgent.
 *
 * Behavior:
 *  - Backend-only tools (no matching frontend entry) are treated as backend tools
 *    (isFrontend defaults to false), with no handler.
 *  - Frontend-only tools (no matching backend entry) are skipped — the backend
 *    must know about a tool for the agent to invoke it.
 *  - When both sides supply isFrontend, the frontend entry wins (callers who
 *    provide a handler generally mean to run locally).
 */
export declare function hydrateToolConfigs(backendConfigs: ToolConfigResponse[] | undefined, frontendTools: Record<string, Partial<ToolDefinition>>): Record<string, ToolDefinition>;
export declare function getToolRenderers(tools: Record<string, ToolDefinition>): Record<string, ToolRenderer>;
