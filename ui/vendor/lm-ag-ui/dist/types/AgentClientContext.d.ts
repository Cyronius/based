import { default as React } from 'react';
import { AgentClientContextValue } from './index';
interface AgentProviderProps {
    value: AgentClientContextValue;
    children: React.ReactNode;
}
export declare function AgentProvider({ value, children }: AgentProviderProps): JSX.Element;
export declare function useAgentContext(): AgentClientContextValue;
export {};
