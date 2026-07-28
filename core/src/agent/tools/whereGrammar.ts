// Traces: BASED-LANCE-SCAN
// Its own module so both the shared tools and the LanceDB engine descriptor can state the grammar
// without importing each other — descriptor → tools → shared → descriptor would otherwise cycle.

/** The `where` grammar, stated once. LanceDB predicates are NOT DuckDB SQL, and a connection can
 *  expose both at the same time — which is exactly how the two get confused. */
export const WHERE_GRAMMAR =
  "Uses LanceDB predicate syntax, not DuckDB SQL: comparisons, AND/OR/NOT, IN, LIKE, IS [NOT] NULL over scalar columns, single-quoted string literals, dotted access into struct fields. No subqueries, JOINs, aggregates, or CTEs.";
