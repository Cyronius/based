import { Message, ToolCall } from '@ag-ui/client';
export interface AssembleInput {
    finalText: string;
    toolCalls: ToolCall[];
    existingMessages: Message[];
    streamingMessageId: string | null;
}
export interface AssembleResult {
    messages: Message[];
    suppressedDuplicate: boolean;
    announcedAssistantText: string | null;
}
/**
 * Assemble one assistant turn into the running message list. A turn is the unit
 * the model emits in a single "thought": optional preamble text plus zero or
 * more tool calls. Their tool results may already have streamed into
 * existingMessages by the time we get here.
 *
 * Output shape:
 *   - No text and no tool calls → no-op.
 *   - Text only → append assistant(content).
 *   - Tool calls only → append assistant(toolCalls).
 *   - Text + tool calls → ONE assistant message with both fields, spliced
 *     in immediately before any trailing tool-result messages owned by these
 *     tool calls. History stays assistant(content+toolCalls) → tool(result).
 *
 * Duplicate suppression: if the most recent assistant text within the same user
 * turn already matches finalText, drop the duplicate text. When tool calls are
 * also present, the message is still appended for the protocol but its content
 * field is omitted.
 */
export declare function assembleFinalMessages(input: AssembleInput): AssembleResult;
