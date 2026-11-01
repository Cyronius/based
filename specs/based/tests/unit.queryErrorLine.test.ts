// Traces: BASED-QUERY-ERROR-LINE
import { describe, expect, test } from "bun:test";
import { duckErrorLine, duckErrorPosition, statementStartLines } from "../../../core/src/db/errorLine";

describe("BASED-QUERY-ERROR-LINE duckErrorLine", () => {
  test("reads the LINE n: suffix of a DuckDB parser error", () => {
    expect(duckErrorLine('Failed to extract statements: Parser Error: syntax error at or near "selec"\n\nLINE 4: selec 3 fom t;\n        ^')).toBe(4);
  });

  test("an error without a LINE suffix has no line", () => {
    expect(duckErrorLine('Binder Error: Referenced column "zz" not found in FROM clause!\nCandidate bindings: "a"')).toBeNull();
  });

  test("a one-line message has no line", () => {
    expect(duckErrorLine("Catalog Error: Table with name nope does not exist!")).toBeNull();
  });
});

describe("BASED-QUERY-ERROR-LINE duckErrorPosition", () => {
  test("the caret gives the column, counted inside the script line", () => {
    const msg = 'Failed to extract statements: Parser Error: syntax error at or near "selec"\n\nLINE 2:     selec 3 fom t;\n            ^';
    expect(duckErrorPosition(msg)).toEqual({ line: 2, column: 5 });
  });

  test("a binder error points at the bad column name", () => {
    const msg = 'Binder Error: Referenced column "zz" not found in FROM clause!\n\nLINE 2: select zz from t;\n               ^';
    expect(duckErrorPosition(msg)).toEqual({ line: 2, column: 8 });
  });

  test("a line DuckDB cut short keeps its line but has no column", () => {
    const msg = "Parser Error: syntax error\n\nLINE 1: ...,x,x, from;\n                 ^";
    expect(duckErrorPosition(msg)).toEqual({ line: 1, column: null });
  });
});

describe("BASED-QUERY-ERROR-LINE statementStartLines", () => {
  test("finds each statement's first line in a three-statement script", () => {
    expect(statementStartLines("select 1;\n\n-- note\nselect 2\nfrom t;\nselect\n  3;")).toEqual([1, 4, 6]);
  });

  test("a ; inside a string or a comment does not split", () => {
    expect(statementStartLines("select ';'\n/* a;\nb */ ;\nselect 2 -- x;\n;")).toEqual([1, 4]);
  });

  test("empty statements and blank lines after the last ; are dropped", () => {
    expect(statementStartLines(";;\nselect 1;\n\n")).toEqual([2]);
  });
});
