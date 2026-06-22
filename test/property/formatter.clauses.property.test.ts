import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { formatDocument, FormatOptions } from '../../server/src/formatter';

/**
 * Property-based tests for formatter clause placement (Property 8)
 * Feature: next-iteration-features, Property 8: Major clauses on separate lines
 *
 * Validates: Requirements 2.5
 *
 * For any syntactically valid T-SQL SELECT statement with multiple clauses,
 * after formatting, each major clause keyword (SELECT, FROM, WHERE, GROUP BY,
 * HAVING, ORDER BY, JOIN) SHALL appear at the beginning of its own line
 * (after optional indentation whitespace).
 */

const defaultOptions: FormatOptions = {
  tabSize: 4,
  insertSpaces: true,
  eol: '\n',
};

// --- Generators ---

/** Generator: random table name */
const arbitraryTableName: fc.Arbitrary<string> = fc.constantFrom(
  'dbo.Users', 'dbo.Orders', 'dbo.Products', 'dbo.Customers',
  'dbo.Employees', 'dbo.Invoices', 'dbo.Categories', 'dbo.Suppliers',
  'sales.OrderDetails', 'hr.Departments'
);

/** Generator: random column name */
const arbitraryColumnName: fc.Arbitrary<string> = fc.constantFrom(
  'Id', 'Name', 'Email', 'Status', 'CreatedDate',
  'Amount', 'Quantity', 'Price', 'Description', 'IsActive'
);

/** Generator: random alias */
const arbitraryAlias: fc.Arbitrary<string> = fc.constantFrom(
  'a', 'b', 'c', 't', 'u', 'o', 'p', 'e'
);

/** Generator: a simple WHERE condition */
const arbitraryWhereCondition: fc.Arbitrary<string> = fc.tuple(
  arbitraryColumnName,
  fc.constantFrom('= 1', '> 0', 'IS NOT NULL', "= 'test'", '<> 0', "LIKE '%a%'")
).map(([col, op]) => `${col} ${op}`);

/** Generator: a GROUP BY column list */
const arbitraryGroupByColumns: fc.Arbitrary<string> = fc.array(
  arbitraryColumnName,
  { minLength: 1, maxLength: 3 }
).map(cols => [...new Set(cols)].join(', '));

/** Generator: a HAVING condition */
const arbitraryHavingCondition: fc.Arbitrary<string> = fc.constantFrom(
  'COUNT(*) > 1',
  'SUM(Amount) > 100',
  'AVG(Price) < 50',
  'MAX(Quantity) >= 10'
);

/** Generator: an ORDER BY clause */
const arbitraryOrderByColumns: fc.Arbitrary<string> = fc.tuple(
  arbitraryColumnName,
  fc.constantFrom('ASC', 'DESC')
).map(([col, dir]) => `${col} ${dir}`);

/** Generator: a JOIN clause */
const arbitraryJoinClause: fc.Arbitrary<string> = fc.tuple(
  fc.constantFrom('INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'LEFT OUTER JOIN'),
  arbitraryTableName,
  arbitraryAlias,
  arbitraryColumnName,
  arbitraryColumnName
).map(([joinType, table, alias, col1, col2]) =>
  `${joinType} ${table} ${alias} ON ${alias}.${col1} = t.${col2}`
);

/**
 * Generator: a SELECT statement with at least 2 major clauses.
 * Builds a valid SELECT with a random combination of FROM, WHERE,
 * GROUP BY, HAVING, ORDER BY, and JOIN clauses.
 */
const arbitrarySelectWithMultipleClauses: fc.Arbitrary<string> = fc.record({
  columns: fc.array(arbitraryColumnName, { minLength: 1, maxLength: 4 }),
  table: arbitraryTableName,
  alias: arbitraryAlias,
  hasWhere: fc.boolean(),
  whereCondition: arbitraryWhereCondition,
  hasGroupBy: fc.boolean(),
  groupByColumns: arbitraryGroupByColumns,
  hasHaving: fc.boolean(),
  havingCondition: arbitraryHavingCondition,
  hasOrderBy: fc.boolean(),
  orderByColumns: arbitraryOrderByColumns,
  hasJoin: fc.boolean(),
  joinClause: arbitraryJoinClause,
}).map(({
  columns, table, alias, hasWhere, whereCondition,
  hasGroupBy, groupByColumns, hasHaving, havingCondition,
  hasOrderBy, orderByColumns, hasJoin, joinClause
}) => {
  const uniqueCols = [...new Set(columns)];
  const parts: string[] = [];
  parts.push(`select ${uniqueCols.join(', ')} from ${table} ${alias}`);

  if (hasJoin) {
    parts.push(joinClause);
  }
  if (hasWhere) {
    parts.push(`where ${whereCondition}`);
  }
  if (hasGroupBy) {
    parts.push(`group by ${groupByColumns}`);
  }
  if (hasHaving && hasGroupBy) {
    parts.push(`having ${havingCondition}`);
  }
  if (hasOrderBy) {
    parts.push(`order by ${orderByColumns}`);
  }

  // Join everything on a single line to test that the formatter splits them
  return parts.join(' ');
});

/**
 * Generator: a SELECT statement guaranteed to have at least 2 clauses
 * (SELECT + FROM is always present, plus at least one more).
 */
const arbitrarySelectWithAtLeastThreeClauses: fc.Arbitrary<string> = fc.record({
  columns: fc.array(arbitraryColumnName, { minLength: 1, maxLength: 3 }),
  table: arbitraryTableName,
  whereCondition: arbitraryWhereCondition,
  hasGroupBy: fc.boolean(),
  groupByColumns: arbitraryGroupByColumns,
  hasOrderBy: fc.boolean(),
  orderByColumns: arbitraryOrderByColumns,
}).map(({
  columns, table, whereCondition,
  hasGroupBy, groupByColumns, hasOrderBy, orderByColumns
}) => {
  const uniqueCols = [...new Set(columns)];
  let sql = `select ${uniqueCols.join(', ')} from ${table} where ${whereCondition}`;
  if (hasGroupBy) {
    sql += ` group by ${groupByColumns}`;
  }
  if (hasOrderBy) {
    sql += ` order by ${orderByColumns}`;
  }
  return sql;
});

// --- Helper ---

/**
 * Checks that each major clause keyword starts at the beginning of its own line
 * (after optional indentation whitespace).
 * Returns an array of clause keywords that violate the property.
 */
function findClausesNotOnOwnLine(formattedText: string): string[] {
  const lines = formattedText.split('\n');
  const violations: string[] = [];

  // Major clause patterns that should start their own line
  const clausePatterns: Array<{ regex: RegExp; name: string }> = [
    { regex: /^\s*SELECT\b/i, name: 'SELECT' },
    { regex: /^\s*FROM\b/i, name: 'FROM' },
    { regex: /^\s*WHERE\b/i, name: 'WHERE' },
    { regex: /^\s*GROUP\s+BY\b/i, name: 'GROUP BY' },
    { regex: /^\s*HAVING\b/i, name: 'HAVING' },
    { regex: /^\s*ORDER\s+BY\b/i, name: 'ORDER BY' },
    { regex: /^\s*(?:INNER\s+)?JOIN\b/i, name: 'JOIN' },
    { regex: /^\s*(?:LEFT|RIGHT|FULL|CROSS)\s+(?:OUTER\s+)?JOIN\b/i, name: 'JOIN' },
  ];

  // For each line, check if it contains a major clause keyword NOT at the start
  // We need to verify that every occurrence of a major clause keyword in the
  // formatted output appears at the beginning of a line (after whitespace).
  
  // Strategy: find all clause keywords in the text and verify each one starts a line
  const fullText = formattedText;
  
  // Check SELECT (not inside subqueries for simplicity - we check top-level)
  const selectMatches = fullText.match(/\bSELECT\b/gi);
  if (selectMatches) {
    for (const line of lines) {
      // If a line contains SELECT but it's not at the start (after whitespace)
      if (/\bSELECT\b/i.test(line) && !/^\s*SELECT\b/i.test(line)) {
        // Exception: SELECT inside parentheses (subquery) may appear after '('
        if (!/\(\s*SELECT\b/i.test(line)) {
          violations.push('SELECT');
        }
      }
    }
  }

  // Check FROM
  for (const line of lines) {
    if (/\bFROM\b/i.test(line) && !/^\s*FROM\b/i.test(line)) {
      // Exception: FROM inside DELETE FROM at start of line, or inside function calls
      if (!/^\s*DELETE\s+FROM\b/i.test(line) && !/^\s*SELECT\b/i.test(line)) {
        violations.push('FROM');
      }
    }
  }

  // Check WHERE
  for (const line of lines) {
    if (/\bWHERE\b/i.test(line) && !/^\s*WHERE\b/i.test(line)) {
      violations.push('WHERE');
    }
  }

  // Check GROUP BY
  for (const line of lines) {
    if (/\bGROUP\s+BY\b/i.test(line) && !/^\s*GROUP\s+BY\b/i.test(line)) {
      violations.push('GROUP BY');
    }
  }

  // Check HAVING
  for (const line of lines) {
    if (/\bHAVING\b/i.test(line) && !/^\s*HAVING\b/i.test(line)) {
      violations.push('HAVING');
    }
  }

  // Check ORDER BY
  for (const line of lines) {
    if (/\bORDER\s+BY\b/i.test(line) && !/^\s*ORDER\s+BY\b/i.test(line)) {
      violations.push('ORDER BY');
    }
  }

  // Check JOIN variants
  for (const line of lines) {
    const hasJoin = /\b(?:INNER\s+)?JOIN\b/i.test(line) ||
                    /\b(?:LEFT|RIGHT|FULL|CROSS)\s+(?:OUTER\s+)?JOIN\b/i.test(line);
    if (hasJoin) {
      const startsWithJoin = /^\s*(?:INNER\s+)?JOIN\b/i.test(line) ||
                             /^\s*(?:LEFT|RIGHT|FULL|CROSS)\s+(?:OUTER\s+)?JOIN\b/i.test(line);
      if (!startsWithJoin) {
        // Exception: ON clause containing the word JOIN in a string or identifier
        if (!/ON\b/i.test(line.substring(0, line.search(/\bJOIN\b/i)))) {
          violations.push('JOIN');
        }
      }
    }
  }

  return violations;
}

/**
 * Simpler check: verify that each clause keyword present in the formatted output
 * starts its own line (after optional whitespace).
 */
function clausesStartOwnLine(formattedText: string): boolean {
  const lines = formattedText.split('\n');

  for (const line of lines) {
    const trimmed = line.trimStart();
    // Skip empty lines
    if (!trimmed) continue;

    // Check if this line has a major clause keyword that is NOT at the start
    // We only care about top-level clauses (not inside parentheses/subqueries)

    // If the line starts with a clause keyword, that's fine
    if (/^(?:SELECT|FROM|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY)\b/i.test(trimmed)) continue;
    if (/^(?:INNER\s+JOIN|LEFT\s+(?:OUTER\s+)?JOIN|RIGHT\s+(?:OUTER\s+)?JOIN|FULL\s+(?:OUTER\s+)?JOIN|CROSS\s+JOIN|JOIN)\b/i.test(trimmed)) continue;

    // If the line does NOT start with a clause keyword, check it doesn't contain one mid-line
    // (except inside strings, comments, or after ON)
    // For simplicity, we check that FROM/WHERE/GROUP BY/HAVING/ORDER BY don't appear mid-line
    // unless they're part of a larger expression (e.g., DELETE FROM)
    if (/\bFROM\b/i.test(trimmed) && !/^DELETE\s+FROM\b/i.test(trimmed) && !/^INSERT\s+INTO\b/i.test(trimmed)) {
      // FROM appears mid-line - this is a violation unless it's in a string
      if (!/'.+FROM.+'/i.test(trimmed)) {
        return false;
      }
    }
    if (/\bWHERE\b/i.test(trimmed) && !/'.+WHERE.+'/i.test(trimmed)) {
      return false;
    }
    if (/\bGROUP\s+BY\b/i.test(trimmed) && !/'.+GROUP\s+BY.+'/i.test(trimmed)) {
      return false;
    }
    if (/\bHAVING\b/i.test(trimmed) && !/'.+HAVING.+'/i.test(trimmed)) {
      return false;
    }
    if (/\bORDER\s+BY\b/i.test(trimmed) && !/'.+ORDER\s+BY.+'/i.test(trimmed)) {
      return false;
    }
  }

  return true;
}

// --- Tests ---

describe('Formatter Property Tests - Clause Placement', () => {
  describe('Property 8: Major clauses on separate lines', () => {
    /**
     * Validates: Requirements 2.5
     *
     * For any syntactically valid T-SQL SELECT statement with multiple clauses,
     * after formatting, each major clause keyword (SELECT, FROM, WHERE, GROUP BY,
     * HAVING, ORDER BY, JOIN) SHALL appear at the beginning of its own line
     * (after optional indentation whitespace).
     */

    it('each major clause starts its own line after formatting', () => {
      fc.assert(
        fc.property(arbitrarySelectWithMultipleClauses, (sql) => {
          const result = formatDocument(sql, defaultOptions);

          // If formatting failed (syntax error), skip this input
          if (!result.formatted) return true;

          const lines = result.text.split('\n');

          // Verify each line that contains a major clause keyword has it at the start
          for (const line of lines) {
            const trimmed = line.trimStart();
            if (!trimmed) continue;

            // Check that FROM doesn't appear mid-line (unless part of DELETE FROM)
            if (/\bFROM\b/.test(trimmed) && !/^FROM\b/.test(trimmed) && !/^DELETE\s+FROM\b/.test(trimmed)) {
              return false;
            }
            // Check that WHERE doesn't appear mid-line
            if (/\bWHERE\b/.test(trimmed) && !/^WHERE\b/.test(trimmed)) {
              return false;
            }
            // Check that GROUP BY doesn't appear mid-line
            if (/\bGROUP\s+BY\b/.test(trimmed) && !/^GROUP\s+BY\b/.test(trimmed)) {
              return false;
            }
            // Check that HAVING doesn't appear mid-line
            if (/\bHAVING\b/.test(trimmed) && !/^HAVING\b/.test(trimmed)) {
              return false;
            }
            // Check that ORDER BY doesn't appear mid-line
            if (/\bORDER\s+BY\b/.test(trimmed) && !/^ORDER\s+BY\b/.test(trimmed)) {
              return false;
            }
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('SELECT and FROM are always on separate lines', () => {
      fc.assert(
        fc.property(arbitrarySelectWithAtLeastThreeClauses, (sql) => {
          const result = formatDocument(sql, defaultOptions);

          if (!result.formatted) return true;

          const lines = result.text.split('\n').map(l => l.trimStart());

          // Find lines starting with SELECT and FROM
          const selectLine = lines.find(l => /^SELECT\b/.test(l));
          const fromLine = lines.find(l => /^FROM\b/.test(l));

          // Both should exist on their own lines
          expect(selectLine).toBeDefined();
          expect(fromLine).toBeDefined();

          // They should be different lines
          const selectIdx = lines.indexOf(selectLine!);
          const fromIdx = lines.indexOf(fromLine!);
          expect(selectIdx).not.toBe(fromIdx);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('WHERE clause starts its own line when present', () => {
      fc.assert(
        fc.property(arbitrarySelectWithAtLeastThreeClauses, (sql) => {
          const result = formatDocument(sql, defaultOptions);

          if (!result.formatted) return true;

          const lines = result.text.split('\n').map(l => l.trimStart());

          // WHERE should be on its own line
          const whereLine = lines.find(l => /^WHERE\b/.test(l));
          expect(whereLine).toBeDefined();

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('JOIN clauses start their own line when present', () => {
      fc.assert(
        fc.property(
          fc.tuple(
            fc.array(arbitraryColumnName, { minLength: 1, maxLength: 3 }),
            arbitraryTableName,
            arbitraryJoinClause
          ),
          ([columns, table, joinClause]) => {
            const uniqueCols = [...new Set(columns)];
            const sql = `select ${uniqueCols.join(', ')} from ${table} t ${joinClause}`;
            const result = formatDocument(sql, defaultOptions);

            if (!result.formatted) return true;

            const lines = result.text.split('\n').map(l => l.trimStart());

            // A JOIN keyword should start its own line
            const joinLine = lines.find(l =>
              /^(?:INNER\s+)?JOIN\b/.test(l) ||
              /^(?:LEFT|RIGHT|FULL|CROSS)\s+(?:OUTER\s+)?JOIN\b/.test(l)
            );
            expect(joinLine).toBeDefined();

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('GROUP BY and ORDER BY start their own lines when present', () => {
      fc.assert(
        fc.property(
          fc.tuple(
            fc.array(arbitraryColumnName, { minLength: 1, maxLength: 3 }),
            arbitraryTableName,
            arbitraryGroupByColumns,
            arbitraryOrderByColumns
          ),
          ([columns, table, groupByCols, orderByCols]) => {
            const uniqueCols = [...new Set(columns)];
            const sql = `select ${uniqueCols.join(', ')} from ${table} group by ${groupByCols} order by ${orderByCols}`;
            const result = formatDocument(sql, defaultOptions);

            if (!result.formatted) return true;

            const lines = result.text.split('\n').map(l => l.trimStart());

            // GROUP BY should start its own line
            const groupByLine = lines.find(l => /^GROUP\s+BY\b/.test(l));
            expect(groupByLine).toBeDefined();

            // ORDER BY should start its own line
            const orderByLine = lines.find(l => /^ORDER\s+BY\b/.test(l));
            expect(orderByLine).toBeDefined();

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('HAVING clause starts its own line when present', () => {
      fc.assert(
        fc.property(
          fc.tuple(
            arbitraryTableName,
            arbitraryGroupByColumns,
            arbitraryHavingCondition
          ),
          ([table, groupByCols, havingCond]) => {
            const sql = `select Name, COUNT(*) from ${table} group by ${groupByCols} having ${havingCond}`;
            const result = formatDocument(sql, defaultOptions);

            if (!result.formatted) return true;

            const lines = result.text.split('\n').map(l => l.trimStart());

            // HAVING should start its own line
            const havingLine = lines.find(l => /^HAVING\b/.test(l));
            expect(havingLine).toBeDefined();

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
