// Traces: BASED-QUERY-ERROR-LINE
import { describe, expect, test } from "bun:test";
import { duckErrorLine, statementStartLines } from "../../../core/src/db/errorLine";

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
