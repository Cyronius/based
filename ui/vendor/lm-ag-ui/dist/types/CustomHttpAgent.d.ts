import { HttpAgent, RunAgentInput, BaseEvent, HttpAgentConfig } from '@ag-ui/client';
import { Observable } from '../../../node_modules/rxjs';
export type RequestHandler = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
/**
 * Subclass of HttpAgent that routes HTTP requests through a custom handler
 * instead of the global fetch. This allows consumers to inject their own
 * request pipeline (e.g., SessionManager with retries/resilience).
 */
export declare class CustomHttpAgent extends HttpAgent {
    private _handler;
    constructor(config: HttpAgentConfig, handler: RequestHandler);
    run(input: RunAgentInput): Observable<BaseEvent>;
}
