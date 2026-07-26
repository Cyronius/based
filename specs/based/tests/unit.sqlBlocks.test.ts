// Traces: BASED-CHAT-SQL-LABELS
// Parsing of ```sql fences in assistant markdown into labeled Insert/Run blocks, plus the persona
// instruction that makes the model emit the leading purpose comment those labels come from.
import { describe, it, expect } from "bun:test";
import { parseSqlBlocks } from "../../../ui/src/lib/sqlBlocks";
// The fenced-sql-block convention is a capability fact (it only matters where SQL exists), so it
// lives in the generated briefing rather than the editable persona.
import { mssqlBriefing } from "../../../core/src/agent/tools/mssql";
import { defaultCapabilitiesFor } from "../../../core/src/agent/surface";
const MSSQL_PERSONA = mssqlBriefing(defaultCapabilitiesFor("mssql"));

describe("BASED-CHAT-SQL-LABELS: parseSqlBlocks", () => {
  it("extracts the leading -- comment as label and the first SQL line", () => {
    const md = "Here you go:\n```sql\n-- Add covering index\nCREATE INDEX IX_Orders_CustomerId ON dbo.Orders (CustomerId);\n```\n";
    const blocks = parseSqlBlocks(md);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.label).toBe("Add covering index");
    expect(blocks[0]!.firstLine).toBe("CREATE INDEX IX_Orders_CustomerId ON dbo.Orders (CustomerId);");
    // Insert/Run get the full text, comment included.
    expect(blocks[0]!.sql).toBe(
      "-- Add covering index\nCREATE INDEX IX_Orders_CustomerId ON dbo.Orders (CustomerId);",
    );
  });

  it("returns label null when there is no leading comment", () => {
    const md = "```sql\nSELECT TOP 10 * FROM dbo.Orders;\n```";
    const blocks = parseSqlBlocks(md);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.label).toBeNull();
    expect(blocks[0]!.firstLine).toBe("SELECT TOP 10 * FROM dbo.Orders;");
  });

  it("uses only the first comment line as the label; later comments stay in sql", () => {
    const md = "```sql\n-- Widen the column\n-- (required before the index)\nALTER TABLE dbo.T ALTER COLUMN Name nvarchar(200);\n```";
    const [block] = parseSqlBlocks(md);
    expect(block!.label).toBe("Widen the column");
    expect(block!.firstLine).toBe("ALTER TABLE dbo.T ALTER COLUMN Name nvarchar(200);");
    expect(block!.sql).toContain("-- (required before the index)");
  });

  it("parses multiple fences in order", () => {
    const md = [
      "First:",
      "```sql\n-- Create the table\nCREATE TABLE dbo.A (Id int);\n```",
      "then",
      "```sql\n-- Seed it\nINSERT INTO dbo.A VALUES (1);\n```",
    ].join("\n");
    const blocks = parseSqlBlocks(md);
    expect(blocks.map((b) => b.label)).toEqual(["Create the table", "Seed it"]);
    expect(blocks.map((b) => b.firstLine)).toEqual([
      "CREATE TABLE dbo.A (Id int);",
      "INSERT INTO dbo.A VALUES (1);",
    ]);
  });

  it("skips blank lines when finding the first SQL line", () => {
    const md = "```sql\n-- Count rows\n\nSELECT COUNT(*) FROM dbo.Orders;\n```";
    const [block] = parseSqlBlocks(md);
    expect(block!.firstLine).toBe("SELECT COUNT(*) FROM dbo.Orders;");
  });

  it("falls back to the raw first line when the block is all comments", () => {
    const md = "```sql\n-- nothing to run here\n```";
    const [block] = parseSqlBlocks(md);
    expect(block!.label).toBe("nothing to run here");
    expect(block!.firstLine).toBe("-- nothing to run here");
  });

  it("ignores empty fences and non-sql fences", () => {
    const md = "```sql\n\n```\n```json\n{\"a\":1}\n```";
    expect(parseSqlBlocks(md).length).toBe(0);
  });
});

describe("BASED-CHAT-SQL-LABELS: persona instruction", () => {
  it("MSSQL_PERSONA tells the model to lead each sql fence with a one-line -- comment", () => {
    expect(MSSQL_PERSONA).toContain("```sql");
    expect(MSSQL_PERSONA).toMatch(/first line[\s\S]*comment[\s\S]*`-- \.\.\.`/i);
  });
});
