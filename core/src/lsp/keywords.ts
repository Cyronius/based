// Traces: BASED-ENGINE-REGISTRY, BASED-LSP-MSSQL-NATIVE
// Completion keyword lists, one per SQL dialect. They live apart from the LSP server because the
// server itself is dialect-neutral — object and column completion works the same everywhere — and
// what actually differs between engines is this list. An engine's descriptor names the list it
// wants; the server takes it as a constructor argument. That is why there is one SQL LSP server
// rather than one per engine.

export const TSQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "TOP", "JOIN", "LEFT JOIN",
  "RIGHT JOIN", "FULL JOIN", "INNER JOIN", "CROSS JOIN", "CROSS APPLY", "OUTER APPLY", "ON",
  "AS", "AND", "OR", "NOT", "IN", "EXISTS", "BETWEEN", "LIKE", "IS NULL", "IS NOT NULL", "CASE",
  "WHEN", "THEN", "ELSE", "END", "DISTINCT", "UNION", "UNION ALL", "EXCEPT", "INTERSECT", "WITH",
  "OVER", "PARTITION BY", "CAST", "CONVERT", "COALESCE", "ISNULL", "DESC", "ASC", "INSERT INTO",
  "VALUES", "UPDATE", "SET", "DELETE FROM", "MERGE", "OUTPUT", "DECLARE", "EXEC", "BEGIN",
  "COMMIT", "ROLLBACK", "TRANSACTION", "OFFSET", "FETCH NEXT", "ROWS ONLY", "PIVOT", "UNPIVOT",
  "COUNT", "SUM", "AVG", "MIN", "MAX", "ROW_NUMBER", "GETDATE", "SYSUTCDATETIME", "NEWID",
] as const;

/** Snowflake SQL. Deliberately excludes the T-SQL-only spellings (TOP, ISNULL, GETDATE, CROSS
 *  APPLY, MERGE OUTPUT) whose presence would coach the user toward statements Snowflake rejects,
 *  and adds the ones that carry Snowflake's actual model: QUALIFY, SAMPLE, FLATTEN, TIME TRAVEL. */
export const SNOWFLAKE_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "QUALIFY", "LIMIT", "OFFSET",
  "JOIN", "LEFT JOIN", "RIGHT JOIN", "FULL JOIN", "INNER JOIN", "CROSS JOIN", "LATERAL", "ON",
  "AS", "AND", "OR", "NOT", "IN", "EXISTS", "BETWEEN", "LIKE", "ILIKE", "RLIKE", "IS NULL",
  "IS NOT NULL", "CASE", "WHEN", "THEN", "ELSE", "END", "DISTINCT", "UNION", "UNION ALL",
  "EXCEPT", "INTERSECT", "WITH", "RECURSIVE", "OVER", "PARTITION BY", "CAST", "TRY_CAST",
  "COALESCE", "IFNULL", "NVL", "DESC", "ASC", "INSERT INTO", "VALUES", "UPDATE", "SET",
  "DELETE FROM", "MERGE INTO", "COPY INTO", "CREATE OR REPLACE", "BEGIN", "COMMIT", "ROLLBACK",
  "SAMPLE", "TABLESAMPLE", "PIVOT", "UNPIVOT", "FLATTEN", "LATERAL FLATTEN", "AT", "BEFORE",
  "CLUSTER BY", "COUNT", "SUM", "AVG", "MIN", "MAX", "ROW_NUMBER", "LISTAGG", "ARRAY_AGG",
  "OBJECT_CONSTRUCT", "PARSE_JSON", "TO_VARIANT", "CURRENT_TIMESTAMP", "CURRENT_DATE", "UUID_STRING",
] as const;

/** DuckDB (the LanceDB SQL bridge). */
export const DUCKDB_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "QUALIFY",
  "JOIN", "LEFT JOIN", "RIGHT JOIN", "FULL JOIN", "INNER JOIN", "CROSS JOIN", "USING", "ON",
  "AS", "AND", "OR", "NOT", "IN", "EXISTS", "BETWEEN", "LIKE", "ILIKE", "IS NULL", "IS NOT NULL",
  "CASE", "WHEN", "THEN", "ELSE", "END", "DISTINCT", "DISTINCT ON", "UNION", "UNION ALL",
  "EXCEPT", "INTERSECT", "WITH", "RECURSIVE", "OVER", "PARTITION BY", "CAST", "TRY_CAST",
  "COALESCE", "DESC", "ASC", "VALUES", "PIVOT", "UNPIVOT", "UNNEST", "LIST", "STRUCT",
  "COUNT", "SUM", "AVG", "MIN", "MAX", "ROW_NUMBER", "STRING_AGG", "ARRAY_AGG",
] as const;
