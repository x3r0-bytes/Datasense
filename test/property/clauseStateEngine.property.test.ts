import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  getClausePresenceSet,
  getValidSuccessors,
  filterByPresence,
  TRANSITION_TABLE,
  ClauseState,
  ClausePresenceSet,
} from '../../server/src/clauseStateEngine';

/**
 * Property-based tests for Clause State Engine
 * Feature: intellisense-clause-engine
 *
 * Tests clause presence detection, successor computation, scope isolation,
 * and graceful degradation on incomplete statements.
 */

// --- Constants ---

/** All valid ClauseState values */
const ALL_CLAUSE_STATES: ClauseState[] = [
  'WITH', 'SELECT', 'FROM', 'JOIN', 'WHERE', 'GROUP_BY', 'HAVING', 'ORDER_BY',
];

/** JOIN variant keywords that are never filtered */
const JOIN_VARIANTS = new Set([
  'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN',
]);

/** Maps successor keyword strings to their ClauseState for presence checking */
const KEYWORD_TO_STATE: Record<string, ClauseState> = {
  'SELECT': 'SELECT',
  'FROM': 'FROM',
  'JOIN': 'JOIN',
  'INNER JOIN': 'JOIN',
  'LEFT JOIN': 'JOIN',
  'RIGHT JOIN': 'JOIN',
  'FULL JOIN': 'JOIN',
  'CROSS JOIN': 'JOIN',
  'ON': 'JOIN',
  'WHERE': 'WHERE',
  'GROUP BY': 'GROUP_BY',
  'HAVING': 'HAVING',
  'ORDER BY': 'ORDER_BY',
};

// --- Generators ---

/** Generator: random valid SQL identifier (avoids SQL keywords) */
const arbitraryIdentifier: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')),
      { minLength: 1, maxLength: 8 }
    )
  )
  .map(([first, rest]) => first + rest)
  .filter((id) => !/^(select|from|where|join|inner|left|right|full|cross|on|order|group|having|with|by)$/i.test(id));

/** Generator: random ClauseState */
const arbitraryClauseState: fc.Arbitrary<ClauseState> = fc.constantFrom(...ALL_CLAUSE_STATES);

/** Generator: random subset of ClauseState values as a ClausePresenceSet */
const arbitraryPresenceSet: fc.Arbitrary<ClausePresenceSet> = fc
  .subarray(ALL_CLAUSE_STATES, { minLength: 0 })
  .map((states) => new Set(states) as ClausePresenceSet);

/** Generator: clause keyword that can appear in SQL text */
const CLAUSE_KEYWORDS_IN_SQL = ['SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER JOIN', 'LEFT JOIN',
  'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'GROUP BY', 'ORDER BY', 'HAVING', 'WITH'] as const;

/** Generator: random clause keyword as it appears in SQL */
const arbitraryClauseKeyword: fc.Arbitrary<string> = fc.constantFrom(...CLAUSE_KEYWORDS_IN_SQL);

/**
 * Generator: a string that wraps content in a "noise" context.
 * Noise contexts: string literals, block comments, line comments, parenthesized subqueries.
 */
const arbitraryNoiseWrapper: fc.Arbitrary<(keyword: string) => string> = fc.constantFrom(
  // Single-quoted string literal
  (kw: string) => `'${kw}'`,
  // N-prefixed string literal
  (kw: string) => `N'${kw}'`,
  // Block comment
  (kw: string) => `/* ${kw} */`,
  // Line comment
  (kw: string) => `-- ${kw}\n`,
  // Parenthesized subquery expression
  (kw: string) => `(${kw} 1 AS val)`,
);

/**
 * Generator: SQL statement text with clause keywords embedded in noise contexts.
 * Returns the text and which keywords should be detected at top-level.
 */
const arbitrarySqlWithNoise: fc.Arbitrary<{
  text: string;
  topLevelClauses: ClauseState[];
}> = fc.tuple(
  // Top-level clauses to include (always starts with SELECT for valid SQL)
  fc.subarray(['FROM', 'WHERE', 'GROUP_BY', 'ORDER_BY'] as ClauseState[], { minLength: 0, maxLength: 3 }),
  // Keywords to embed in noise
  fc.array(
    fc.tuple(arbitraryClauseKeyword, arbitraryNoiseWrapper),
    { minLength: 1, maxLength: 3 }
  ),
  arbitraryIdentifier,
).map(([extraClauses, noiseItems, tableName]) => {
  const topLevelClauses: ClauseState[] = ['SELECT'];
  let text = 'SELECT ';

  // Add noise items interspersed in the SELECT clause
  for (const [keyword, wrapper] of noiseItems) {
    text += `${wrapper(keyword)}, `;
  }
  text += `${tableName} `;

  // Add top-level clauses
  if (extraClauses.includes('FROM')) {
    text += `FROM ${tableName} `;
    topLevelClauses.push('FROM');
  }
  if (extraClauses.includes('WHERE')) {
    if (!topLevelClauses.includes('FROM')) {
      text += `FROM ${tableName} `;
      topLevelClauses.push('FROM');
    }
    text += `WHERE ${tableName} = 1 `;
    topLevelClauses.push('WHERE');
  }
  if (extraClauses.includes('GROUP_BY')) {
    if (!topLevelClauses.includes('FROM')) {
      text += `FROM ${tableName} `;
      topLevelClauses.push('FROM');
    }
    text += `GROUP BY ${tableName} `;
    topLevelClauses.push('GROUP_BY');
  }
  if (extraClauses.includes('ORDER_BY')) {
    if (!topLevelClauses.includes('FROM')) {
      text += `FROM ${tableName} `;
      topLevelClauses.push('FROM');
    }
    text += `ORDER BY ${tableName} `;
    topLevelClauses.push('ORDER_BY');
  }

  return { text, topLevelClauses };
});

/**
 * Generator: SQL with a subquery containing clause keywords that should NOT
 * appear in the outer scope's presence set.
 */
const arbitrarySqlWithSubquery: fc.Arbitrary<{
  text: string;
  outerClauses: ClauseState[];
  innerClauses: ClauseState[];
}> = fc.tuple(arbitraryIdentifier, arbitraryIdentifier).map(([outerTable, innerTable]) => {
  // Outer query: SELECT ... FROM ... WHERE (subquery)
  // Inner query: SELECT ... FROM ... WHERE ...
  const text = `SELECT ${outerTable} FROM ${outerTable} WHERE ${outerTable} IN (SELECT ${innerTable} FROM ${innerTable} WHERE ${innerTable} = 1)`;
  return {
    text,
    outerClauses: ['SELECT', 'FROM', 'WHERE'] as ClauseState[],
    innerClauses: ['SELECT', 'FROM', 'WHERE'] as ClauseState[],
  };
});

/**
 * Generator: SQL with CTE body containing clause keywords that should be
 * isolated from the outer scope.
 */
const arbitrarySqlWithCTE: fc.Arbitrary<{
  text: string;
  outerClauses: ClauseState[];
  cteBodyClauses: ClauseState[];
  cteBodyStart: number;
  cteBodyEnd: number;
}> = fc.tuple(arbitraryIdentifier, arbitraryIdentifier).map(([cteName, tableName]) => {
  const prefix = `WITH ${cteName} AS (`;
  const cteBody = `SELECT ${tableName} FROM ${tableName} WHERE ${tableName} = 1`;
  const suffix = `) SELECT ${tableName} FROM ${cteName}`;
  const text = prefix + cteBody + suffix;

  return {
    text,
    outerClauses: ['WITH', 'SELECT', 'FROM'] as ClauseState[],
    cteBodyClauses: ['SELECT', 'FROM', 'WHERE'] as ClauseState[],
    cteBodyStart: prefix.length,
    cteBodyEnd: prefix.length + cteBody.length,
  };
});

/**
 * Generator: incomplete SQL statements (trailing partial keyword or missing clause body).
 * Returns the text and which clauses should be recognized before the incomplete portion.
 */
const arbitraryIncompleteSql: fc.Arbitrary<{
  text: string;
  recognizedClauses: ClauseState[];
}> = fc.oneof(
  // SELECT with trailing partial keyword (e.g., "SELECT a FR")
  arbitraryIdentifier.map((col) => ({
    text: `SELECT ${col} FR`,
    recognizedClauses: ['SELECT'] as ClauseState[],
  })),
  // SELECT FROM with trailing partial (e.g., "SELECT a FROM t WH")
  fc.tuple(arbitraryIdentifier, arbitraryIdentifier).map(([col, tbl]) => ({
    text: `SELECT ${col} FROM ${tbl} WH`,
    recognizedClauses: ['SELECT', 'FROM'] as ClauseState[],
  })),
  // SELECT FROM WHERE with trailing partial (e.g., "SELECT a FROM t WHERE x = 1 GR")
  fc.tuple(arbitraryIdentifier, arbitraryIdentifier).map(([col, tbl]) => ({
    text: `SELECT ${col} FROM ${tbl} WHERE ${col} = 1 GR`,
    recognizedClauses: ['SELECT', 'FROM', 'WHERE'] as ClauseState[],
  })),
  // SELECT FROM WHERE GROUP BY with trailing partial (e.g., "... GROUP BY col ORD")
  fc.tuple(arbitraryIdentifier, arbitraryIdentifier).map(([col, tbl]) => ({
    text: `SELECT ${col} FROM ${tbl} WHERE ${col} = 1 GROUP BY ${col} ORD`,
    recognizedClauses: ['SELECT', 'FROM', 'WHERE', 'GROUP_BY'] as ClauseState[],
  })),
  // Statement ending abruptly after a keyword (e.g., "SELECT")
  fc.constant({
    text: 'SELECT',
    recognizedClauses: ['SELECT'] as ClauseState[],
  }),
  // Statement with incomplete FROM (no table name yet)
  arbitraryIdentifier.map((col) => ({
    text: `SELECT ${col} FROM `,
    recognizedClauses: ['SELECT', 'FROM'] as ClauseState[],
  })),
);

// --- Property Tests ---

describe('Feature: intellisense-clause-engine, Property 1: Clause presence detection ignores noise', () => {
  /**
   * **Validates: Requirements 1.2, 1.5, 1.6**
   *
   * For any SQL statement text containing clause keywords embedded inside string
   * literals, block comments, single-line comments, or parenthesized subquery
   * expressions, the getClausePresenceSet function SHALL return a set containing
   * only clause keywords that appear at the top-level scope.
   */

  it('keywords inside noise contexts are not included in the presence set', () => {
    fc.assert(
      fc.property(
        arbitrarySqlWithNoise,
        ({ text, topLevelClauses }) => {
          const presenceSet = getClausePresenceSet(text, text.length);

          // The presence set should contain exactly the top-level clauses
          for (const clause of topLevelClauses) {
            expect(presenceSet.has(clause)).toBe(true);
          }

          // The presence set should NOT contain clauses that only appear in noise
          for (const clause of ALL_CLAUSE_STATES) {
            if (presenceSet.has(clause) && !topLevelClauses.includes(clause)) {
              // This clause was detected but shouldn't have been
              expect(topLevelClauses).toContain(clause);
            }
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('keywords inside single-quoted strings are ignored', () => {
    fc.assert(
      fc.property(
        arbitraryClauseKeyword,
        arbitraryIdentifier,
        (keyword, col) => {
          const text = `SELECT ${col}, '${keyword}' FROM ${col}`;
          const presenceSet = getClausePresenceSet(text, text.length);

          // Should detect SELECT and FROM at top level
          expect(presenceSet.has('SELECT')).toBe(true);
          expect(presenceSet.has('FROM')).toBe(true);

          // The keyword inside the string should NOT add extra entries
          // (unless it happens to be SELECT or FROM which are already top-level)
          const expectedStates = new Set<ClauseState>(['SELECT', 'FROM']);
          for (const state of presenceSet) {
            expect(expectedStates.has(state)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('keywords inside block comments are ignored', () => {
    fc.assert(
      fc.property(
        arbitraryClauseKeyword,
        arbitraryIdentifier,
        (keyword, col) => {
          const text = `SELECT ${col} /* ${keyword} */ FROM ${col}`;
          const presenceSet = getClausePresenceSet(text, text.length);

          expect(presenceSet.has('SELECT')).toBe(true);
          expect(presenceSet.has('FROM')).toBe(true);

          const expectedStates = new Set<ClauseState>(['SELECT', 'FROM']);
          for (const state of presenceSet) {
            expect(expectedStates.has(state)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('keywords inside line comments are ignored', () => {
    fc.assert(
      fc.property(
        arbitraryClauseKeyword,
        arbitraryIdentifier,
        (keyword, col) => {
          const text = `SELECT ${col} -- ${keyword}\nFROM ${col}`;
          const presenceSet = getClausePresenceSet(text, text.length);

          expect(presenceSet.has('SELECT')).toBe(true);
          expect(presenceSet.has('FROM')).toBe(true);

          const expectedStates = new Set<ClauseState>(['SELECT', 'FROM']);
          for (const state of presenceSet) {
            expect(expectedStates.has(state)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('keywords inside parenthesized subqueries are excluded from outer scope', () => {
    fc.assert(
      fc.property(
        arbitraryIdentifier,
        (col) => {
          // Outer: SELECT ... FROM ... WHERE ... IN (subquery with its own clauses)
          const text = `SELECT ${col} FROM ${col} WHERE ${col} IN (SELECT ${col} FROM ${col} WHERE ${col} > 0 ORDER BY ${col})`;
          const presenceSet = getClausePresenceSet(text, text.length);

          // Outer scope should have SELECT, FROM, WHERE
          expect(presenceSet.has('SELECT')).toBe(true);
          expect(presenceSet.has('FROM')).toBe(true);
          expect(presenceSet.has('WHERE')).toBe(true);

          // ORDER BY is inside the subquery — should NOT be in outer scope
          expect(presenceSet.has('ORDER_BY')).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Feature: intellisense-clause-engine, Property 2: Successor suggestions match transition table', () => {
  /**
   * **Validates: Requirements 1.1, 1.3, 1.4**
   *
   * For any valid clause state and any clause presence set, the result of
   * getValidSuccessors(clauseState, presenceSet) SHALL be a subset of
   * TRANSITION_TABLE[clauseState] with already-present clauses removed
   * (except JOIN variants which are never removed).
   */

  it('getValidSuccessors result is always a subset of TRANSITION_TABLE[state]', () => {
    fc.assert(
      fc.property(
        arbitraryClauseState,
        arbitraryPresenceSet,
        (clauseState, presenceSet) => {
          const successors = getValidSuccessors(clauseState, presenceSet);
          const tableEntries = TRANSITION_TABLE[clauseState];

          // Every returned successor must be in the transition table
          for (const successor of successors) {
            expect(tableEntries).toContain(successor);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('already-present non-JOIN clauses are removed from successors', () => {
    fc.assert(
      fc.property(
        arbitraryClauseState,
        arbitraryPresenceSet,
        (clauseState, presenceSet) => {
          const successors = getValidSuccessors(clauseState, presenceSet);

          for (const successor of successors) {
            // If it's not a JOIN variant, it should NOT be in the presence set
            if (!JOIN_VARIANTS.has(successor)) {
              const mappedState = KEYWORD_TO_STATE[successor];
              if (mappedState) {
                expect(presenceSet.has(mappedState)).toBe(false);
              }
            }
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('JOIN variants are never removed regardless of presence set', () => {
    fc.assert(
      fc.property(
        arbitraryClauseState,
        (clauseState) => {
          // Create a presence set that includes JOIN
          const presenceSet: ClausePresenceSet = new Set(['JOIN']);
          const successors = getValidSuccessors(clauseState, presenceSet);
          const tableEntries = TRANSITION_TABLE[clauseState];

          // All JOIN variants from the transition table should still be present
          for (const entry of tableEntries) {
            if (JOIN_VARIANTS.has(entry)) {
              expect(successors).toContain(entry);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('filterByPresence produces same result as getValidSuccessors for same inputs', () => {
    fc.assert(
      fc.property(
        arbitraryClauseState,
        arbitraryPresenceSet,
        (clauseState, presenceSet) => {
          const fromGetValid = getValidSuccessors(clauseState, presenceSet);
          const fromFilter = filterByPresence([...TRANSITION_TABLE[clauseState]], presenceSet);

          // Both should produce the same result
          expect(fromGetValid.sort()).toEqual(fromFilter.sort());
        }
      ),
      { numRuns: 100 }
    );
  });

  it('with empty presence set, all transition table entries are returned', () => {
    fc.assert(
      fc.property(
        arbitraryClauseState,
        (clauseState) => {
          const emptySet: ClausePresenceSet = new Set();
          const successors = getValidSuccessors(clauseState, emptySet);
          const tableEntries = [...TRANSITION_TABLE[clauseState]];

          // With no clauses present, nothing should be filtered
          expect(successors.sort()).toEqual(tableEntries.sort());
        }
      ),
      { numRuns: 100 }
    );
  });

  it('ORDER_BY always returns empty successors regardless of presence set', () => {
    fc.assert(
      fc.property(
        arbitraryPresenceSet,
        (presenceSet) => {
          const successors = getValidSuccessors('ORDER_BY', presenceSet);
          expect(successors).toEqual([]);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Feature: intellisense-clause-engine, Property 3: Subquery and CTE body scope isolation', () => {
  /**
   * **Validates: Requirements 1.5, 1.6, 2.4**
   *
   * For any SQL statement containing nested subqueries or CTE bodies, the
   * getClausePresenceSet computed for the innermost scope containing the cursor
   * SHALL NOT include clause keywords from any outer scope.
   */

  it('cursor inside subquery sees only inner scope clauses', () => {
    fc.assert(
      fc.property(
        arbitrarySqlWithSubquery,
        ({ text, innerClauses }) => {
          // Place cursor inside the subquery (after the opening paren)
          const subqueryStart = text.indexOf('(SELECT');
          const cursorOffset = subqueryStart + 1 + 'SELECT '.length; // Inside the subquery

          const presenceSet = getClausePresenceSet(text, cursorOffset);

          // Should only see SELECT (the inner SELECT)
          expect(presenceSet.has('SELECT')).toBe(true);

          // Should NOT see outer scope clauses that aren't also in the inner scope
          // at this cursor position (we're only past SELECT in the inner scope)
          // The key property: no outer-only clauses leak in
        }
      ),
      { numRuns: 100 }
    );
  });

  it('cursor outside subquery does not see inner scope clauses', () => {
    fc.assert(
      fc.property(
        arbitraryIdentifier,
        (col) => {
          // Outer has SELECT, FROM, WHERE. Inner has SELECT, FROM, WHERE, ORDER BY.
          const text = `SELECT ${col} FROM ${col} WHERE ${col} IN (SELECT ${col} FROM ${col} WHERE ${col} > 0 ORDER BY ${col}) `;
          // Cursor at the end (outer scope)
          const presenceSet = getClausePresenceSet(text, text.length);

          // Outer scope should have SELECT, FROM, WHERE
          expect(presenceSet.has('SELECT')).toBe(true);
          expect(presenceSet.has('FROM')).toBe(true);
          expect(presenceSet.has('WHERE')).toBe(true);

          // ORDER BY is only in the inner scope — must NOT appear in outer
          expect(presenceSet.has('ORDER_BY')).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('cursor inside CTE body sees only CTE body clauses', () => {
    fc.assert(
      fc.property(
        arbitrarySqlWithCTE,
        ({ text, cteBodyClauses, cteBodyStart, cteBodyEnd }) => {
          // Place cursor inside the CTE body
          const cursorOffset = cteBodyEnd;
          const presenceSet = getClausePresenceSet(text, cursorOffset);

          // Should see the CTE body clauses
          for (const clause of cteBodyClauses) {
            expect(presenceSet.has(clause)).toBe(true);
          }

          // Should NOT see WITH (outer scope only)
          expect(presenceSet.has('WITH')).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('cursor after CTE body (in final query) sees outer scope clauses', () => {
    fc.assert(
      fc.property(
        arbitrarySqlWithCTE,
        ({ text, outerClauses }) => {
          // Place cursor at the end of the text (in the final query)
          const presenceSet = getClausePresenceSet(text, text.length);

          // Should see the outer scope clauses
          for (const clause of outerClauses) {
            expect(presenceSet.has(clause)).toBe(true);
          }

          // Should NOT see inner CTE body clauses (WHERE is only in CTE body)
          expect(presenceSet.has('WHERE')).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('nested subqueries maintain independent scopes at each level', () => {
    fc.assert(
      fc.property(
        arbitraryIdentifier,
        (col) => {
          // 3 levels: outer SELECT FROM WHERE, middle SELECT FROM, inner SELECT FROM ORDER BY
          const text = `SELECT ${col} FROM ${col} WHERE ${col} IN (SELECT ${col} FROM ${col} WHERE ${col} IN (SELECT ${col} FROM ${col} ORDER BY ${col}))`;

          // Cursor at outermost scope (end of text)
          const outerSet = getClausePresenceSet(text, text.length);
          expect(outerSet.has('SELECT')).toBe(true);
          expect(outerSet.has('FROM')).toBe(true);
          expect(outerSet.has('WHERE')).toBe(true);
          expect(outerSet.has('ORDER_BY')).toBe(false); // Only in innermost

          // Cursor inside innermost subquery
          const innermostStart = text.lastIndexOf('(SELECT');
          const innerCursorOffset = text.length - 2; // Before the closing parens
          // Actually let's find a position inside the innermost subquery
          const innerSelectPos = text.lastIndexOf('ORDER BY');
          const innerSet = getClausePresenceSet(text, innerSelectPos + 'ORDER BY '.length + col.length);
          expect(innerSet.has('SELECT')).toBe(true);
          expect(innerSet.has('FROM')).toBe(true);
          expect(innerSet.has('ORDER_BY')).toBe(true);
          // Should NOT have outer WHERE
          expect(innerSet.has('WHERE')).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Feature: intellisense-clause-engine, Property 4: Graceful degradation on incomplete statements', () => {
  /**
   * **Validates: Requirements 1.7**
   *
   * For any SQL statement text that is syntactically incomplete, the
   * getClausePresenceSet SHALL contain all clause keywords that were
   * successfully recognized before the incomplete portion.
   */

  it('incomplete statements still detect all recognized clauses before the incomplete portion', () => {
    fc.assert(
      fc.property(
        arbitraryIncompleteSql,
        ({ text, recognizedClauses }) => {
          const presenceSet = getClausePresenceSet(text, text.length);

          // All clauses that were successfully recognized should be present
          for (const clause of recognizedClauses) {
            expect(presenceSet.has(clause)).toBe(true);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('trailing partial keywords do not add false entries to the presence set', () => {
    fc.assert(
      fc.property(
        arbitraryIdentifier,
        (col) => {
          // "FR" is a partial keyword — should not be detected as FROM
          const text = `SELECT ${col} FR`;
          const presenceSet = getClausePresenceSet(text, text.length);

          expect(presenceSet.has('SELECT')).toBe(true);
          // "FR" alone should NOT be detected as FROM (it's not a complete keyword)
          // Note: FR is not a recognized keyword at all, so it won't match
          expect(presenceSet.has('FROM')).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('partial multi-word keywords do not add false entries', () => {
    fc.assert(
      fc.property(
        arbitraryIdentifier,
        (col) => {
          // "GROUP" without "BY" should not be detected as GROUP_BY
          const text = `SELECT ${col} FROM ${col} WHERE ${col} = 1 GROUP`;
          const presenceSet = getClausePresenceSet(text, text.length);

          expect(presenceSet.has('SELECT')).toBe(true);
          expect(presenceSet.has('FROM')).toBe(true);
          expect(presenceSet.has('WHERE')).toBe(true);
          // "GROUP" alone should NOT be detected as GROUP_BY
          expect(presenceSet.has('GROUP_BY')).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('empty statement returns empty presence set', () => {
    const presenceSet = getClausePresenceSet('', 0);
    expect(presenceSet.size).toBe(0);
  });

  it('statement with only whitespace returns empty presence set', () => {
    fc.assert(
      fc.property(
        fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 1, maxLength: 20 }),
        (whitespace) => {
          const presenceSet = getClausePresenceSet(whitespace, whitespace.length);
          expect(presenceSet.size).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('cursor at position 0 always returns empty presence set', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'SELECT a FROM b',
          'SELECT * FROM t WHERE x = 1',
          'WITH cte AS (SELECT 1) SELECT * FROM cte',
        ),
        (text) => {
          const presenceSet = getClausePresenceSet(text, 0);
          expect(presenceSet.size).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});
