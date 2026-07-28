// Traces: BASED-TABLE-DML, BASED-SNOWFLAKE-DML, BASED-ENGINE-REGISTRY
//
// The dialect is the *spelling* layer: quoting, bind placeholders, paging. It is separate from
// EngineCapabilities (what an engine can DO) on purpose — conflating the two is what produced the
// mssql-vs-everything-else branches this replaced.
//
// The strict/permissive quoting split matters and is easy to get backwards: `quoteIdent` is an
// injection guard on the write path and REFUSES anything outside a safe charset; `escapeIdent` is
// for the read/scripting path and must round-trip any legal object name.
import { describe, expect, test } from "bun:test";
import {
  buildEditCommands,
  DUCKDB_DIALECT,
  ENGINE_IDS,
  ENGINES,
  SNOWFLAKE_DIALECT,
  TSQL_DIALECT,
  type SqlDialect,
} from "@based/core";

const ALL: SqlDialect[] = [TSQL_DIALECT, SNOWFLAKE_DIALECT, DUCKDB_DIALECT];

describe("SqlDialect: spelling per engine", () => {
  test("T-SQL brackets, Snowflake and DuckDB double-quote", () => {
    expect(TSQL_DIALECT.quoteIdent("Orders")).toBe("[Orders]");
    expect(SNOWFLAKE_DIALECT.quoteIdent("ORDERS")).toBe('"ORDERS"');
    expect(DUCKDB_DIALECT.quoteIdent("orders")).toBe('"orders"');
  });

  test("paging: OFFSET…FETCH on T-SQL, LIMIT…OFFSET elsewhere", () => {
    expect(TSQL_DIALECT.page(20, 10)).toBe("OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY");
    expect(SNOWFLAKE_DIALECT.page(20, 10)).toBe("LIMIT 10 OFFSET 20");
    expect(DUCKDB_DIALECT.page(20, 10)).toBe("LIMIT 10 OFFSET 20");
  });

  test("binds: named on T-SQL, positional elsewhere", () => {
    expect(TSQL_DIALECT.param(0, "p0")).toBe("@p0");
    expect(TSQL_DIALECT.positionalParams).toBe(false);
    expect(SNOWFLAKE_DIALECT.param(0, "p0")).toBe("?");
    expect(SNOWFLAKE_DIALECT.positionalParams).toBe(true);
  });

  test("Snowflake declares upper-cased identifiers; SQL Server preserves case", () => {
    // Not cosmetic: the Snowflake adapter's catalog predicates depend on this being declared
    // rather than assumed, because a quoted lower-case name really is a different object.
    expect(SNOWFLAKE_DIALECT.identifierCase).toBe("upper");
    expect(TSQL_DIALECT.identifierCase).toBe("preserve");
  });

  describe("quoteIdent is an injection guard, not a formatter", () => {
    for (const d of ALL) {
      test(`${d.id} refuses identifiers carrying syntax`, () => {
        for (const bad of ["a;DROP TABLE x", "a]b", 'a"b', "a'b", "a--b", "a)b"]) {
          expect(() => d.quoteIdent(bad)).toThrow(/Invalid identifier/);
        }
        // …and accepts the ordinary ones.
        expect(() => d.quoteIdent("Order Details")).not.toThrow();
        expect(() => d.quoteIdent("customer_id2")).not.toThrow();
      });

      test(`${d.id} escapeIdent round-trips a hostile-but-legal name instead of refusing it`, () => {
        const { open, close, escape } = quoteCharsOf(d);
        const escaped = d.escapeIdent(`weird${close}name`);
        expect(escaped.startsWith(open)).toBe(true);
        expect(escaped.endsWith(close)).toBe(true);
        // The inner terminator was doubled, so the quoting is not broken out of.
        expect(escaped.slice(open.length, -close.length)).toBe(`weird${escape}name`);
      });
    }
  });

  test("each engine's served quote characters match the dialect its adapter uses", () => {
    // The UI quotes with the profile's characters and core quotes with the dialect's. They are two
    // renderings of one fact, so a mismatch would show up only as subtly wrong generated SQL.
    for (const id of ENGINE_IDS) {
      const engine = ENGINES[id];
      const { open, close } = engine.profile.quote;
      expect(engine.dialect.escapeIdent("x")).toBe(`${open}x${close}`);
    }
  });
});

/** An engine's quote characters, read from the profile that serves them to the UI. */
function quoteCharsOf(d: SqlDialect): { open: string; close: string; escape: string } {
  const profile = ENGINE_IDS.map((id) => ENGINES[id]).find((e) => e.dialect.id === d.id)?.profile;
  return profile?.quote ?? { open: '"', close: '"', escape: '""' };
}

describe("BASED-SNOWFLAKE-DML: buildEditCommands speaks the connection's dialect", () => {
  const change = {
    schema: "SALES",
    table: "ORDERS",
    columns: [
      { name: "ID", isPrimaryKey: true },
      { name: "NOTE", isPrimaryKey: false },
    ],
  };

  test("T-SQL stays exactly as it was — brackets and named binds", () => {
    const [cmd] = buildEditCommands({ ...change, updates: [{ key: { ID: 1 }, set: { NOTE: "hi" } }] });
    expect(cmd!.sql).toBe("UPDATE [SALES].[ORDERS] SET [NOTE]=@p0 WHERE [ID]=@k0");
    expect(cmd!.params).toEqual([
      { name: "p0", value: "hi" },
      { name: "k0", value: 1 },
    ]);
  });

  test("Snowflake quotes with \" and binds positionally", () => {
    const [cmd] = buildEditCommands({ ...change, updates: [{ key: { ID: 1 }, set: { NOTE: "hi" } }] }, SNOWFLAKE_DIALECT);
    expect(cmd!.sql).toBe('UPDATE "SALES"."ORDERS" SET "NOTE"=? WHERE "ID"=?');
  });

  test("on a positional dialect, param order IS bind order — SET before WHERE", () => {
    // The failure this guards against is silent and data-corrupting: with `?` placeholders, a
    // params array ordered WHERE-first would write the key into the value column and filter on
    // the new value. It cannot be caught by reading the SQL alone.
    const [cmd] = buildEditCommands(
      { ...change, updates: [{ key: { ID: 7 }, set: { NOTE: "new" } }] },
      SNOWFLAKE_DIALECT,
    );
    expect(cmd!.params!.map((p) => p.value)).toEqual(["new", 7]);
  });

  test("INSERT and DELETE round-trip on both dialects", () => {
    const ins = buildEditCommands({ ...change, inserts: [{ ID: 1, NOTE: "a" }] }, SNOWFLAKE_DIALECT);
    expect(ins[0]!.sql).toBe('INSERT INTO "SALES"."ORDERS" ("ID","NOTE") VALUES (?,?)');
    const del = buildEditCommands({ ...change, deletes: [{ ID: 3 }] }, SNOWFLAKE_DIALECT);
    expect(del[0]!.sql).toBe('DELETE FROM "SALES"."ORDERS" WHERE "ID"=?');
    expect(del[0]!.params).toEqual([{ name: "k0", value: 3 }]);
  });

  test("an all-defaults insert is refused on Snowflake rather than emitted as invalid SQL", () => {
    // T-SQL has DEFAULT VALUES; Snowflake does not. Emitting something that merely looks plausible
    // would fail at the server with a syntax error the user cannot act on.
    expect(() => buildEditCommands({ ...change, inserts: [{}] }, SNOWFLAKE_DIALECT)).toThrow(/at least one column/i);
    expect(buildEditCommands({ ...change, inserts: [{}] })[0]!.sql).toBe("INSERT INTO [SALES].[ORDERS] DEFAULT VALUES");
  });

  test("the identifier guard still fires through the dialect seam", () => {
    expect(() =>
      buildEditCommands({ ...change, table: "ORDERS; DROP TABLE X", inserts: [{ ID: 1 }] }, SNOWFLAKE_DIALECT),
    ).toThrow(/Invalid identifier/);
  });

  test("update/delete without a primary key throw before emitting anything", () => {
    const noPk = { ...change, columns: [{ name: "ID", isPrimaryKey: false }] };
    expect(() => buildEditCommands({ ...noPk, deletes: [{ ID: 1 }] }, SNOWFLAKE_DIALECT)).toThrow(/primary key/i);
    expect(() => buildEditCommands({ ...noPk, updates: [{ key: { ID: 1 }, set: { NOTE: "x" } }] }, SNOWFLAKE_DIALECT)).toThrow(
      /primary key/i,
    );
  });
});
