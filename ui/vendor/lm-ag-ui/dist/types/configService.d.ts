import { AgentConfig } from './index';
import { TokenProvider } from './AgentClient';
import { RequestHandler } from './CustomHttpAgent';
export declare function loadAgentConfig(baseUrl: string, agentId: string, tokenProvider?: TokenProvider, requestHandler?: RequestHandler, timeout?: number, configParams?: Record<string, string | string[]>): Promise<AgentConfig>;
