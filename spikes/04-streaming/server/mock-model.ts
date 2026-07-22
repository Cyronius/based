// Keyless scripted model for spike 4 — AI SDK v7 MockLanguageModelV4.
// Turn 1: streams markdown (SQL block + GFM table), then calls the FRONTEND
// tool `confirm_mutation`. Turn 2 (prompt contains the tool result): streams
// the "approved" wrap-up including a mermaid ER diagram.
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 40, text: 40, reasoning: undefined },
};

const TURN1 = `### Top customers by order total

Here's the query I'd run against **dbo.Customers** / **sales.Orders**:

\`\`\`sql
SELECT TOP 10 c.CustomerID, c.Name, SUM(o.Total) AS OrderTotal
FROM dbo.Customers c
JOIN sales.Orders o ON o.CustomerID = c.CustomerID
GROUP BY c.CustomerID, c.Name
ORDER BY OrderTotal DESC;
\`\`\`

Preview of expected shape:

| CustomerID | Name | OrderTotal |
|---|---|---|
| 42 | Contoso | 12,050.00 |
| 17 | Fabrikam | 9,801.25 |

To also flag these rows I need to run an \`UPDATE\` — requesting your approval.`;

const TURN2 = `**Approved — mutation executed.** 2 rows affected.

Relationship of the tables involved:

\`\`\`mermaid
erDiagram
    CUSTOMERS ||--o{ ORDERS : places
    CUSTOMERS { int CustomerID PK string Name }
    ORDERS { int OrderID PK int CustomerID FK decimal Total }
\`\`\`
`;

function textChunks(text: string, id: string) {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += 14) parts.push(text.slice(i, i + 14));
  return [
    { type: "text-start", id },
    ...parts.map((delta) => ({ type: "text-delta", id, delta })),
    { type: "text-end", id },
  ];
}

export const mockModel = new MockLanguageModelV4({
  doStream: async ({ prompt }: any) => {
    const promptStr = JSON.stringify(prompt);
    const isFollowUp = promptStr.includes("tool-result") || promptStr.includes('"tool"');
    console.log(`[spike4] mock doStream, follow-up=${isFollowUp}`);

    const chunks = isFollowUp
      ? [
          { type: "stream-start", warnings: [] },
          ...textChunks(TURN2, "t2"),
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
        ]
      : [
          { type: "stream-start", warnings: [] },
          ...textChunks(TURN1, "t1"),
          { type: "tool-input-start", id: "call-1", toolName: "confirm_mutation" },
          {
            type: "tool-input-delta",
            id: "call-1",
            delta: '{"sql":"UPDATE dbo.Customers SET IsTopCustomer = 1 WHERE CustomerID IN (42, 17);","reason":"Flag top customers"}',
          },
          { type: "tool-input-end", id: "call-1" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "confirm_mutation",
            input: '{"sql":"UPDATE dbo.Customers SET IsTopCustomer = 1 WHERE CustomerID IN (42, 17);","reason":"Flag top customers"}',
          },
          { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
        ];

    return { stream: simulateReadableStream({ chunkDelayInMs: 20, chunks }) };
  },
});
