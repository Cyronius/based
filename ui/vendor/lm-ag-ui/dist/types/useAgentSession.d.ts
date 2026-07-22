import { AgentClient } from './AgentClient';
import { Session, UseAgentOptions } from './index';
export interface SessionHandle {
    client: AgentClient;
    session: Session;
    isStreaming: boolean;
    startNewRun: () => void;
    endRun: () => void;
    abortRun: () => void;
}
/**
 * Owns the AgentClient lifecycle and session state. Knows nothing about
 * messages, streaming, or tools — purely the transport + session layer.
 */
export declare function useAgentSession(options: UseAgentOptions): SessionHandle;
