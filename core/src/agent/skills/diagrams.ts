// Traces: BASED-DIAGRAM-RENDER
// Skill #1: visualize on request by emitting ```mermaid blocks (Streamdown renders them in the rail).
// No chart library, no chart card — mermaid does both structural diagrams and small quantitative charts.
import type { Skill } from "./types";

export const diagrams: Skill = {
  name: "diagrams",
  description:
    "Draw diagrams and charts by emitting mermaid code blocks — ER/schema diagrams, foreign-key graphs, sequence/flow charts, and small pie/bar/line charts of aggregated query results.",
  body: `# Skill: diagrams

You can visualize by emitting a fenced \`\`\`mermaid code block. The chat rail renders mermaid
automatically — do NOT describe the diagram in prose instead, and do NOT use any chart library.

## Structural diagrams (from the schema)

Inspect the schema first with list_objects / describe_table; never invent tables or columns.

- **ER / schema shape** — use \`erDiagram\`. One entity per table; list key columns with types; draw
  relationships from foreign keys (\`CUSTOMER ||--o{ ORDER : places\`).
- **Foreign-key graph** ("what references X?") — a \`flowchart LR\` with a node per table and an edge
  per FK is often clearer than a full ER diagram.
- **Procedure / query logic** — \`sequenceDiagram\` or \`flowchart TD\` to show control flow or the
  call order between objects.

## Quantitative charts (from real numbers)

Chart the numbers the database actually returns — never guess counts.

1. Write an **aggregate** query that yields a *small* group set (a \`GROUP BY\` returning a handful of
   rows, e.g. counts by status, totals by month). Do not chart thousands of raw rows.
2. Run it with **run_query** to get the real numbers. If this connection has no \`run_query\`, there is
   no server-side aggregation: build the group set from repeated **count_rows** calls (one per
   category, each with its own filter) instead. Never chart a number you didn't read back.
3. Emit a mermaid chart of those numbers:
   - **\`pie\`** — best for a small categorical distribution. Stable and well-supported.

     \`\`\`mermaid
     pie title Orders by status
       "Shipped" : 412
       "Pending" : 87
       "Cancelled" : 23
     \`\`\`
   - **\`xychart-beta\`** — bar/line for a trend or comparison. It is *beta*: axis and series control
     are limited, so keep it simple (one series, few points) and prefer \`pie\` when a distribution
     will do.

     \`\`\`mermaid
     xychart-beta
       title "Signups by month"
       x-axis [Jan, Feb, Mar, Apr]
       y-axis "Count"
       bar [120, 145, 132, 190]
     \`\`\`

## Rules

- Aggregate to a small group set and chart only numbers a tool actually returned.
- Label the chart (a title, axis names) so it reads on its own.
- If a value is unknown, run a query for it rather than inventing it.`,
};
