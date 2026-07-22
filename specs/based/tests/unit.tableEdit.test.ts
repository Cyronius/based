// Traces: BASED-TABLE-DML (canonical spec: specs/based/spec.md)
// Pure edit→SQL builder: parameterized, bracket-quoted, identifier-validated, PK-required for update/delete.
import { describe, expect, test } from "bun:test";
import { buildEditCommands, type TableChangeSet } from "@based/core";

const cols = [
  { name: "id", isPrimaryKey: true },
  { name: "name", isPrimaryKey: false },
  { name: "note", isPrimaryKey: false },
];

function base(over: Partial<TableChangeSet>): TableChangeSet {
  return { schema: "s", table: "t", columns: cols, ...over };
}

describe("BASED-TABLE-DML: edit → parameterized SQL builder", () => {
  test("update of one column → parameterized UPDATE, value carried as a param", () => {
    const [cmd, ...rest] = buildEditCommands(base({ updates: [{ key: { id: 7 }, set: { name: "Ann" } }] }));
    expect(rest.length).toBe(0);
    expect(cmd!.sql).toBe("UPDATE [s].[t] SET [name]=@p0 WHERE [id]=@k0");
    expect(cmd!.params).toEqual([
      { name: "p0", value: "Ann" },
      { name: "k0", value: 7 },
    ]);
    // the value never appears interpolated in the SQL text
    expect(cmd!.sql).not.toContain("Ann");
  });

  test("insert → parameterized INSERT with bracketed column list", () => {
    const [cmd] = buildEditCommands(base({ inserts: [{ name: "Bo", note: "hi" }] }));
    expect(cmd!.sql).toBe("INSERT INTO [s].[t] ([name],[note]) VALUES (@p0,@p1)");
    expect(cmd!.params).toEqual([
      { name: "p0", value: "Bo" },
      { name: "p1", value: "hi" },
    ]);
  });

  test("delete → parameterized DELETE keyed by PK", () => {
    const [cmd] = buildEditCommands(base({ deletes: [{ id: 3 }] }));
    expect(cmd!.sql).toBe("DELETE FROM [s].[t] WHERE [id]=@k0");
    expect(cmd!.params).toEqual([{ name: "k0", value: 3 }]);
  });

  test("composite PK → all key columns in the WHERE", () => {
    const composite = [
      { name: "a", isPrimaryKey: true },
      { name: "b", isPrimaryKey: true },
      { name: "v", isPrimaryKey: false },
    ];
    const [cmd] = buildEditCommands({
      schema: "s",
      table: "t",
      columns: composite,
      updates: [{ key: { a: 1, b: 2 }, set: { v: 9 } }],
    });
    expect(cmd!.sql).toBe("UPDATE [s].[t] SET [v]=@p0 WHERE [a]=@k0 AND [b]=@k1");
    expect(cmd!.params).toEqual([
      { name: "p0", value: 9 },
      { name: "k0", value: 1 },
      { name: "k1", value: 2 },
    ]);
  });

  test("update/delete with no PK column → throws, no command emitted", () => {
    const noPk = [{ name: "x", isPrimaryKey: false }];
    expect(() => buildEditCommands({ schema: "s", table: "t", columns: noPk, updates: [{ key: {}, set: { x: 1 } }] })).toThrow(
      /primary key/i,
    );
    expect(() => buildEditCommands({ schema: "s", table: "t", columns: noPk, deletes: [{ x: 1 }] })).toThrow(/primary key/i);
  });

  test("invalid identifier (;, brackets, quotes) is rejected without emitting SQL", () => {
    expect(() => buildEditCommands(base({ table: "t; DROP TABLE u", updates: [{ key: { id: 1 }, set: { name: "x" } }] }))).toThrow(
      /invalid identifier/i,
    );
    const badCol = [
      { name: "id", isPrimaryKey: true },
      { name: "na]me", isPrimaryKey: false },
    ];
    expect(() =>
      buildEditCommands({ schema: "s", table: "t", columns: badCol, updates: [{ key: { id: 1 }, set: { "na]me": "x" } }] }),
    ).toThrow(/invalid identifier/i);
  });

  test("null and multi-column set are carried as params in order", () => {
    const [cmd] = buildEditCommands(base({ updates: [{ key: { id: 1 }, set: { name: "N", note: null } }] }));
    expect(cmd!.sql).toBe("UPDATE [s].[t] SET [name]=@p0, [note]=@p1 WHERE [id]=@k0");
    expect(cmd!.params).toEqual([
      { name: "p0", value: "N" },
      { name: "p1", value: null },
      { name: "k0", value: 1 },
    ]);
  });

  test("delete → update → insert ordering across a mixed change set", () => {
    const cmds = buildEditCommands(
      base({ inserts: [{ name: "I" }], updates: [{ key: { id: 1 }, set: { name: "U" } }], deletes: [{ id: 2 }] }),
    );
    expect(cmds.map((c) => c.sql.split(" ")[0])).toEqual(["DELETE", "UPDATE", "INSERT"]);
  });
});
