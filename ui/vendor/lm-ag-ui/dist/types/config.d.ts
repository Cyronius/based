/**
 * Optional config loading subpath.
 *
 * Provides helpers for loading agent configuration from a backend endpoint
 * (GET /agent/{agentId}). This is NOT part of the ag-ui spec — import from
 * the main entry point for core ag-ui functionality.
 *
 * Usage: import { useAgentSetup, loadAgentConfig } from '@itkennel/lm-ag-ui/config';
 */
export { loadAgentConfig } from './configService';
export { useAgentSetup } from './useAgentSetup';
export type { UseAgentSetupOptions, UseAgentSetupResult } from './useAgentSetup';
