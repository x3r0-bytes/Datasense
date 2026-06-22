import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';

// Mock vscode module (required because destructiveQueryGuard.ts imports vscode)
vi.mock('vscode', () => ({
  window: {
    showWarningMessage: vi.fn(),
  },
}));

import {
  analyze,
  classifyStatement,
  hasTopLevelWhere,
  parseStatements,
  stripCommentsAndStrings,
  DestructiveStatement,
} from '../../src/destructiveStatementAnalyzer';
import { formatStatementForDialog } from '../../src/destructiveQueryGuard';

/**
 * Property-based tests for Destructive Statement Analyzer
 * Feature: destructive-query-warning
 *
 * Shared generators are defined at the top for reuse across all 11 property tests.
 */

// =============================================================================
// --- Shared Generators ---
// =============================================================================

/**
 * Generator: random SQL identifier (unquoted).
 * Produces valid SQL identifiers like column/table names: starts with letter or underscore,
 * followed by alphanumeric/underscore characters.
 */
export const arbitraryIdentifier: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')),
      { minLength: 0, maxLength: 12 }
    )
  )
  .map(([first, rest]) => first + rest);

/**
 * Generator: random SQL table name.
 * Produces one of: plain identifier, schema-qualified (schema.table), or bracket-quoted ([schema].[table]).
 */
export const arbitraryTableName: fc.Arbitrary<string> = fc.oneof(
  // Plain identifier: MyTable
  arbitraryIdentifier,
  // Schema-qualified: dbo.MyTable
  fc.tuple(arbitraryIdentifier, arbitraryIdentifier).map(([schema, table]) => `${schema}.${table}`),
  // Bracket-quoted: [dbo].[MyTable]
  fc.tuple(arbitraryIdentifier, arbitraryIdentifier).map(([schema, table]) => `[${schema}].[${table}]`),
  // Bracket-quoted single: [MyTable]
  arbitraryIdentifier.map(id => `[${id}]`)
);

/**
 * Generator: random alias (short identifier, 1-4 chars).
 */
export const arbitraryAlias: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
      { minLength: 0, maxLength: 3 }
    )
  )
  .map(([first, rest]) => first + rest);

/**
 * Generator: random whitespace (1 or more spaces/tabs/newlines).
 * Produces whitespace that won't be confused with a GO separator line.
 */
export const arbitraryWhitespace: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(' ', ' ', ' ', '\t'), { minLength: 1, maxLength: 4 })
  .map(arr => arr.join(''));

/**
 * Generator: random keyword casing.
 * Takes a keyword string and randomizes the case of each character.
 */
export function arbitraryCasing(keyword: string): fc.Arbitrary<string> {
  return fc
    .array(fc.boolean(), { minLength: keyword.length, maxLength: keyword.length })
    .map(bools =>
      keyword
        .split('')
        .map((ch, i) => (bools[i] ? ch.toUpperCase() : ch.toLowerCase()))
        .join('')
    );
}

/**
 * Generator: random column name (just an identifier).
 */
export const arbitraryColumnName: fc.Arbitrary<string> = arbitraryIdentifier;

/**
 * Generator: random simple value for SET clauses.
 * Produces numeric literals or identifiers (avoids string literals and WHERE keyword).
 */
export const arbitrarySimpleValue: fc.Arbitrary<string> = fc.oneof(
  fc.integer({ min: 0, max: 9999 }).map(n => n.toString()),
  arbitraryIdentifier,
  fc.constant('NULL'),
  fc.constant('GETDATE()')
);

/**
 * Generator: random SET clause content (col = val pairs).
 * Never includes a top-level WHERE keyword.
 */
export const arbitrarySetClause: fc.Arbitrary<string> = fc
  .array(
    fc.tuple(arbitraryColumnName, arbitrarySimpleValue).map(([col, val]) => `${col} = ${val}`),
    { minLength: 1, maxLength: 3 }
  )
  .map(pairs => pairs.join(', '));

// =============================================================================
// --- Property 1 Generators ---
// =============================================================================

/**
 * Generator: random UPDATE statement WITHOUT a top-level WHERE clause.
 *
 * Patterns generated:
 * 1. Simple: UPDATE tableName SET col = val
 * 2. Aliased: UPDATE alias SET col = val FROM tableName alias
 * 3. With JOIN (no WHERE): UPDATE alias SET col = val FROM tableName alias JOIN tableName2 alias2 ON alias.col = alias2.col
 * 4. With subquery in SET (WHERE only inside parens): UPDATE tableName SET col = (SELECT x FROM y WHERE y.id = 1)
 */
const arbitraryUpdateWithoutWhere: fc.Arbitrary<string> = fc.oneof(
  // Pattern 1: Simple UPDATE tableName SET col = val
  fc.tuple(
    arbitraryCasing('UPDATE'),
    arbitraryWhitespace,
    arbitraryTableName,
    arbitraryWhitespace,
    arbitraryCasing('SET'),
    arbitraryWhitespace,
    arbitrarySetClause
  ).map(([upd, ws1, table, ws2, set, ws3, setCols]) =>
    `${upd}${ws1}${table}${ws2}${set}${ws3}${setCols}`
  ),

  // Pattern 2: Aliased UPDATE alias SET col = val FROM tableName alias
  fc.tuple(
    arbitraryCasing('UPDATE'),
    arbitraryWhitespace,
    arbitraryAlias,
    arbitraryWhitespace,
    arbitraryCasing('SET'),
    arbitraryWhitespace,
    arbitrarySetClause,
    arbitraryWhitespace,
    arbitraryCasing('FROM'),
    arbitraryWhitespace,
    arbitraryTableName,
    arbitraryWhitespace,
    arbitraryAlias
  ).map(([upd, ws1, alias, ws2, set, ws3, setCols, ws4, from, ws5, table, ws6, alias2]) =>
    `${upd}${ws1}${alias}${ws2}${set}${ws3}${setCols}${ws4}${from}${ws5}${table}${ws6}${alias2}`
  ),

  // Pattern 3: With subquery WHERE (only inside parens — NOT a top-level WHERE)
  fc.tuple(
    arbitraryCasing('UPDATE'),
    arbitraryWhitespace,
    arbitraryTableName,
    arbitraryWhitespace,
    arbitraryCasing('SET'),
    arbitraryWhitespace,
    arbitraryColumnName,
    arbitraryCasing('SELECT'),
    arbitraryWhitespace,
    arbitraryColumnName,
    arbitraryWhitespace,
    arbitraryCasing('FROM'),
    arbitraryWhitespace,
    arbitraryTableName,
    arbitraryWhitespace,
    arbitraryCasing('WHERE'),
    arbitraryWhitespace,
    arbitraryColumnName
  ).map(([upd, ws1, table, ws2, set, ws3, col, sel, ws4, selCol, ws5, from, ws6, subTable, ws7, where, ws8, filterCol]) =>
    `${upd}${ws1}${table}${ws2}${set}${ws3}${col} = (${sel}${ws4}${selCol}${ws5}${from}${ws6}${subTable}${ws7}${where}${ws8}${filterCol} = 1)`
  )
);

/**
 * Generator: random DELETE statement WITHOUT a top-level WHERE clause.
 *
 * Patterns generated:
 * 1. Simple: DELETE FROM tableName
 * 2. Aliased: DELETE alias FROM tableName alias
 * 3. DELETE TOP(n) FROM tableName
 * 4. Multi-table JOIN: DELETE alias FROM tableName alias JOIN tableName2 alias2 ON alias.col = alias2.col
 */
const arbitraryDeleteWithoutWhere: fc.Arbitrary<string> = fc.oneof(
  // Pattern 1: Simple DELETE FROM tableName
  fc.tuple(
    arbitraryCasing('DELETE'),
    arbitraryWhitespace,
    arbitraryCasing('FROM'),
    arbitraryWhitespace,
    arbitraryTableName
  ).map(([del, ws1, from, ws2, table]) =>
    `${del}${ws1}${from}${ws2}${table}`
  ),

  // Pattern 2: Aliased DELETE: DELETE alias FROM tableName alias
  fc.tuple(
    arbitraryCasing('DELETE'),
    arbitraryWhitespace,
    arbitraryAlias,
    arbitraryWhitespace,
    arbitraryCasing('FROM'),
    arbitraryWhitespace,
    arbitraryTableName,
    arbitraryWhitespace,
    arbitraryAlias
  ).map(([del, ws1, alias, ws2, from, ws3, table, ws4, alias2]) =>
    `${del}${ws1}${alias}${ws2}${from}${ws3}${table}${ws4}${alias2}`
  ),

  // Pattern 3: DELETE TOP(n) FROM tableName
  fc.tuple(
    arbitraryCasing('DELETE'),
    arbitraryWhitespace,
    fc.constantFrom('TOP(10)', 'TOP(100)', 'TOP(1000)', 'TOP (5)'),
    arbitraryWhitespace,
    arbitraryCasing('FROM'),
    arbitraryWhitespace,
    arbitraryTableName
  ).map(([del, ws1, top, ws2, from, ws3, table]) =>
    `${del}${ws1}${top}${ws2}${from}${ws3}${table}`
  ),

  // Pattern 4: Multi-table JOIN DELETE (no WHERE)
  fc.tuple(
    arbitraryCasing('DELETE'),
    arbitraryWhitespace,
    arbitraryAlias,
    arbitraryWhitespace,
    arbitraryCasing('FROM'),
    arbitraryWhitespace,
    arbitraryTableName,
    arbitraryWhitespace,
    arbitraryAlias,
    arbitraryWhitespace,
    arbitraryCasing('JOIN'),
    arbitraryWhitespace,
    arbitraryTableName,
    arbitraryWhitespace,
    arbitraryAlias,
    arbitraryWhitespace,
    arbitraryCasing('ON'),
    arbitraryWhitespace,
    arbitraryColumnName
  ).map(([del, ws1, alias1, ws2, from, ws3, table1, ws4, alias1b, ws5, join, ws6, table2, ws7, alias2, ws8, on, ws9, col]) =>
    `${del}${ws1}${alias1}${ws2}${from}${ws3}${table1}${ws4}${alias1b}${ws5}${join}${ws6}${table2}${ws7}${alias2}${ws8}${on}${ws9}${alias1b}.${col} = ${alias2}.${col}`
  )
);

// =============================================================================
// --- Tests ---
// =============================================================================

describe('Destructive Statement Analyzer Property Tests', () => {
  // Feature: destructive-query-warning, Property 1: UPDATE/DELETE without top-level WHERE is destructive
  describe('Property 1: UPDATE/DELETE without top-level WHERE is destructive', () => {
    /**
     * Validates: Requirements 1.1, 1.3, 2.1, 2.3, 2.5, 2.6, 10.1
     *
     * For any syntactically valid UPDATE statement that does NOT contain a WHERE keyword
     * at parenthesis depth 0 (regardless of table name, alias usage, SET clause content,
     * JOIN presence, or keyword casing), the analyzer SHALL classify it as destructive
     * with reason UPDATE_WITHOUT_WHERE.
     */
    it('UPDATE statements without top-level WHERE are classified as destructive', () => {
      fc.assert(
        fc.property(arbitraryUpdateWithoutWhere, (sql) => {
          const reason = classifyStatement(sql);
          expect(reason).toBe('UPDATE_WITHOUT_WHERE');
        }),
        { numRuns: 200 }
      );
    });

    /**
     * Validates: Requirements 2.1, 2.3, 2.5, 2.6, 10.1
     *
     * For any syntactically valid DELETE statement that does NOT contain a WHERE keyword
     * at parenthesis depth 0 (regardless of table name, alias usage, DELETE TOP(n),
     * JOIN presence, or keyword casing), the analyzer SHALL classify it as destructive
     * with reason DELETE_WITHOUT_WHERE.
     */
    it('DELETE statements without top-level WHERE are classified as destructive', () => {
      fc.assert(
        fc.property(arbitraryDeleteWithoutWhere, (sql) => {
          const reason = classifyStatement(sql);
          expect(reason).toBe('DELETE_WITHOUT_WHERE');
        }),
        { numRuns: 200 }
      );
    });

    /**
     * Validates: Requirements 1.1, 1.3, 2.1, 2.3, 10.1
     *
     * End-to-end: the full analyze() pipeline correctly flags UPDATE/DELETE without WHERE
     * as destructive statements with proper reason codes.
     */
    it('analyze() flags UPDATE/DELETE without WHERE with correct reason via full pipeline', () => {
      fc.assert(
        fc.property(
          fc.oneof(arbitraryUpdateWithoutWhere, arbitraryDeleteWithoutWhere),
          (sql) => {
            const result = analyze(sql);
            expect(result.statements.length).toBeGreaterThanOrEqual(1);

            const statement = result.statements[0];
            expect(
              statement.reason === 'UPDATE_WITHOUT_WHERE' ||
              statement.reason === 'DELETE_WITHOUT_WHERE'
            ).toBe(true);
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  // Feature: destructive-query-warning, Property 2: UPDATE/DELETE with top-level WHERE is safe
  describe('Property 2: UPDATE/DELETE with top-level WHERE is safe', () => {
    // =========================================================================
    // --- Property 2 Generators ---
    // =========================================================================

    /**
     * Generator: random simple WHERE condition (col = val, col > val, etc.).
     * Produces conditions that don't contain parentheses to ensure WHERE stays at depth 0.
     */
    const arbitraryWhereCondition: fc.Arbitrary<string> = fc
      .tuple(
        arbitraryColumnName,
        fc.constantFrom('=', '>', '<', '>=', '<=', '<>', '!=', 'LIKE', 'IS NOT NULL'),
        arbitrarySimpleValue
      )
      .map(([col, op, val]) => {
        if (op === 'IS NOT NULL') {
          return `${col} IS NOT NULL`;
        }
        return `${col} ${op} ${val}`;
      });

    /**
     * Generator: random UPDATE statement WITH a top-level WHERE clause.
     *
     * Patterns:
     * 1. Simple: UPDATE tableName SET col = val WHERE col = val
     * 2. Aliased: UPDATE alias SET col = val FROM tableName alias WHERE alias.col = val
     */
    const arbitraryUpdateWithWhere: fc.Arbitrary<string> = fc.oneof(
      // Pattern 1: Simple UPDATE with WHERE
      fc.tuple(
        arbitraryCasing('UPDATE'),
        arbitraryWhitespace,
        arbitraryTableName,
        arbitraryWhitespace,
        arbitraryCasing('SET'),
        arbitraryWhitespace,
        arbitrarySetClause,
        arbitraryWhitespace,
        arbitraryCasing('WHERE'),
        arbitraryWhitespace,
        arbitraryWhereCondition
      ).map(([upd, ws1, table, ws2, set, ws3, setCols, ws4, where, ws5, cond]) =>
        `${upd}${ws1}${table}${ws2}${set}${ws3}${setCols}${ws4}${where}${ws5}${cond}`
      ),

      // Pattern 2: Aliased UPDATE with WHERE
      fc.tuple(
        arbitraryCasing('UPDATE'),
        arbitraryWhitespace,
        arbitraryAlias,
        arbitraryWhitespace,
        arbitraryCasing('SET'),
        arbitraryWhitespace,
        arbitrarySetClause,
        arbitraryWhitespace,
        arbitraryCasing('FROM'),
        arbitraryWhitespace,
        arbitraryTableName,
        arbitraryWhitespace,
        arbitraryAlias,
        arbitraryWhitespace,
        arbitraryCasing('WHERE'),
        arbitraryWhitespace,
        arbitraryWhereCondition
      ).map(([upd, ws1, alias, ws2, set, ws3, setCols, ws4, from, ws5, table, ws6, alias2, ws7, where, ws8, cond]) =>
        `${upd}${ws1}${alias}${ws2}${set}${ws3}${setCols}${ws4}${from}${ws5}${table}${ws6}${alias2}${ws7}${where}${ws8}${cond}`
      )
    );

    /**
     * Generator: random DELETE statement WITH a top-level WHERE clause.
     *
     * Patterns:
     * 1. Simple: DELETE FROM tableName WHERE col = val
     * 2. Aliased: DELETE alias FROM tableName alias WHERE alias.col = val
     */
    const arbitraryDeleteWithWhere: fc.Arbitrary<string> = fc.oneof(
      // Pattern 1: Simple DELETE with WHERE
      fc.tuple(
        arbitraryCasing('DELETE'),
        arbitraryWhitespace,
        arbitraryCasing('FROM'),
        arbitraryWhitespace,
        arbitraryTableName,
        arbitraryWhitespace,
        arbitraryCasing('WHERE'),
        arbitraryWhitespace,
        arbitraryWhereCondition
      ).map(([del, ws1, from, ws2, table, ws3, where, ws4, cond]) =>
        `${del}${ws1}${from}${ws2}${table}${ws3}${where}${ws4}${cond}`
      ),

      // Pattern 2: Aliased DELETE with WHERE
      fc.tuple(
        arbitraryCasing('DELETE'),
        arbitraryWhitespace,
        arbitraryAlias,
        arbitraryWhitespace,
        arbitraryCasing('FROM'),
        arbitraryWhitespace,
        arbitraryTableName,
        arbitraryWhitespace,
        arbitraryAlias,
        arbitraryWhitespace,
        arbitraryCasing('WHERE'),
        arbitraryWhitespace,
        arbitraryWhereCondition
      ).map(([del, ws1, alias, ws2, from, ws3, table, ws4, alias2, ws5, where, ws6, cond]) =>
        `${del}${ws1}${alias}${ws2}${from}${ws3}${table}${ws4}${alias2}${ws5}${where}${ws6}${cond}`
      )
    );

    /**
     * Validates: Requirements 1.2, 1.4, 2.2, 2.4, 10.1
     *
     * For any syntactically valid UPDATE statement that contains a WHERE keyword
     * at parenthesis depth 0 (regardless of table name, alias usage, or keyword casing),
     * the analyzer SHALL NOT classify it as destructive.
     */
    it('UPDATE statements with top-level WHERE are classified as safe', () => {
      fc.assert(
        fc.property(arbitraryUpdateWithWhere, (sql) => {
          const reason = classifyStatement(sql);
          expect(reason).toBeNull();
        }),
        { numRuns: 200 }
      );
    });

    /**
     * Validates: Requirements 2.2, 2.4, 10.1
     *
     * For any syntactically valid DELETE statement that contains a WHERE keyword
     * at parenthesis depth 0 (regardless of table name, alias usage, or keyword casing),
     * the analyzer SHALL NOT classify it as destructive.
     */
    it('DELETE statements with top-level WHERE are classified as safe', () => {
      fc.assert(
        fc.property(arbitraryDeleteWithWhere, (sql) => {
          const reason = classifyStatement(sql);
          expect(reason).toBeNull();
        }),
        { numRuns: 200 }
      );
    });

    /**
     * Validates: Requirements 1.2, 1.4, 2.2, 2.4, 10.1
     *
     * End-to-end: the full analyze() pipeline correctly classifies UPDATE/DELETE with WHERE
     * as safe (no destructive statements reported).
     */
    it('analyze() does not flag UPDATE/DELETE with WHERE', () => {
      fc.assert(
        fc.property(
          fc.oneof(arbitraryUpdateWithWhere, arbitraryDeleteWithWhere),
          (sql) => {
            const result = analyze(sql);
            expect(result.statements.length).toBe(0);
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  // Feature: destructive-query-warning, Property 3: TRUNCATE TABLE is always destructive
  describe('Property 3: TRUNCATE TABLE is always destructive', () => {
    /**
     * Generator: random TRUNCATE TABLE statement.
     * Produces: {TRUNCATE} {whitespace} {TABLE} {whitespace} {tableName}
     * with randomized casing, whitespace between keywords, and varied table name formats.
     */
    const arbitraryTruncateTable: fc.Arbitrary<string> = fc.tuple(
      arbitraryCasing('TRUNCATE'),
      arbitraryWhitespace,
      arbitraryCasing('TABLE'),
      arbitraryWhitespace,
      arbitraryTableName
    ).map(([truncate, ws1, table, ws2, tableName]) =>
      `${truncate}${ws1}${table}${ws2}${tableName}`
    );

    /**
     * Validates: Requirements 3.1, 3.2, 10.1
     *
     * For any SQL statement beginning with TRUNCATE followed by one or more whitespace
     * characters followed by TABLE (case-insensitive, with any table name format including
     * schema-qualified and bracket-quoted), the analyzer SHALL classify it as destructive
     * with reason TRUNCATE_TABLE.
     */
    it('TRUNCATE TABLE with varied table names and casing is always classified as destructive', () => {
      fc.assert(
        fc.property(arbitraryTruncateTable, (sql) => {
          const reason = classifyStatement(sql);
          expect(reason).toBe('TRUNCATE_TABLE');
        }),
        { numRuns: 200 }
      );
    });

    /**
     * Validates: Requirements 3.1, 3.2, 10.1
     *
     * End-to-end: the full analyze() pipeline correctly flags TRUNCATE TABLE statements
     * as destructive with reason TRUNCATE_TABLE.
     */
    it('analyze() flags TRUNCATE TABLE with reason TRUNCATE_TABLE', () => {
      fc.assert(
        fc.property(arbitraryTruncateTable, (sql) => {
          const result = analyze(sql);
          expect(result.statements.length).toBeGreaterThanOrEqual(1);
          expect(result.statements[0].reason).toBe('TRUNCATE_TABLE');
        }),
        { numRuns: 200 }
      );
    });
  });

  // Feature: destructive-query-warning, Property 4: DROP TABLE/DATABASE is always destructive
  describe('Property 4: DROP TABLE/DATABASE is always destructive', () => {
    // =========================================================================
    // --- Property 4 Generators ---
    // =========================================================================

    /**
     * Generator: optional IF EXISTS clause with random casing and whitespace.
     */
    const arbitraryOptionalIfExists: fc.Arbitrary<string> = fc.oneof(
      fc.constant(''),
      fc.tuple(
        arbitraryWhitespace,
        arbitraryCasing('IF'),
        arbitraryWhitespace,
        arbitraryCasing('EXISTS')
      ).map(([ws1, ifKw, ws2, existsKw]) => `${ws1}${ifKw}${ws2}${existsKw}`)
    );

    /**
     * Generator: random DROP TABLE statement.
     * Produces: {DROP} {ws} {TABLE} {optionalIfExists} {ws} {tableName} {optionalMultiTable}
     * with randomized casing, whitespace, IF EXISTS, and varied table name formats.
     */
    const arbitraryDropTable: fc.Arbitrary<string> = fc.tuple(
      arbitraryCasing('DROP'),
      arbitraryWhitespace,
      arbitraryCasing('TABLE'),
      arbitraryOptionalIfExists,
      arbitraryWhitespace,
      arbitraryTableName,
      // Optional second table (multi-table DROP)
      fc.oneof(
        fc.constant(''),
        fc.tuple(fc.constant(','), arbitraryWhitespace, arbitraryTableName)
          .map(([comma, ws, table]) => `${comma}${ws}${table}`)
      )
    ).map(([drop, ws1, table, ifExists, ws2, tableName, multiTable]) =>
      `${drop}${ws1}${table}${ifExists}${ws2}${tableName}${multiTable}`
    );

    /**
     * Generator: random DROP DATABASE statement.
     * Produces: {DROP} {ws} {DATABASE} {optionalIfExists} {ws} {dbName}
     * with randomized casing, whitespace, IF EXISTS, and plain or bracket-quoted names.
     */
    const arbitraryDropDatabase: fc.Arbitrary<string> = fc.tuple(
      arbitraryCasing('DROP'),
      arbitraryWhitespace,
      arbitraryCasing('DATABASE'),
      arbitraryOptionalIfExists,
      arbitraryWhitespace,
      // DB names: plain identifier or bracket-quoted
      fc.oneof(
        arbitraryIdentifier,
        arbitraryIdentifier.map(id => `[${id}]`)
      )
    ).map(([drop, ws1, database, ifExists, ws2, dbName]) =>
      `${drop}${ws1}${database}${ifExists}${ws2}${dbName}`
    );

    /**
     * Validates: Requirements 4.1, 4.3, 10.1
     *
     * For any SQL statement beginning with DROP followed by one or more whitespace
     * characters followed by TABLE (case-insensitive, with any variations including
     * IF EXISTS, schema-qualified names, bracket-quoted identifiers, and multi-table lists),
     * the analyzer SHALL classify it as destructive with reason DROP_TABLE.
     */
    it('DROP TABLE with varied forms is always classified as DROP_TABLE', () => {
      fc.assert(
        fc.property(arbitraryDropTable, (sql) => {
          const reason = classifyStatement(sql);
          expect(reason).toBe('DROP_TABLE');
        }),
        { numRuns: 200 }
      );
    });

    /**
     * Validates: Requirements 4.2, 4.3, 10.1
     *
     * For any SQL statement beginning with DROP followed by one or more whitespace
     * characters followed by DATABASE (case-insensitive, with any variations including
     * IF EXISTS and bracket-quoted identifiers), the analyzer SHALL classify it as
     * destructive with reason DROP_DATABASE.
     */
    it('DROP DATABASE with varied forms is always classified as DROP_DATABASE', () => {
      fc.assert(
        fc.property(arbitraryDropDatabase, (sql) => {
          const reason = classifyStatement(sql);
          expect(reason).toBe('DROP_DATABASE');
        }),
        { numRuns: 200 }
      );
    });

    /**
     * Validates: Requirements 4.1, 4.2, 4.3, 10.1
     *
     * End-to-end: the full analyze() pipeline correctly flags DROP TABLE/DATABASE
     * statements as destructive with the correct reason codes.
     */
    it('analyze() flags DROP TABLE/DATABASE with correct reasons', () => {
      fc.assert(
        fc.property(
          fc.oneof(arbitraryDropTable, arbitraryDropDatabase),
          (sql) => {
            const result = analyze(sql);
            expect(result.statements.length).toBeGreaterThanOrEqual(1);
            expect(
              result.statements[0].reason === 'DROP_TABLE' ||
              result.statements[0].reason === 'DROP_DATABASE'
            ).toBe(true);
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  // Feature: destructive-query-warning, Property 5: DROP of non-TABLE/DATABASE objects is safe
  describe('Property 5: DROP of non-TABLE/DATABASE objects is safe', () => {
    // =========================================================================
    // --- Property 5 Generators ---
    // =========================================================================

    /**
     * Generator: random non-TABLE/DATABASE object type keyword.
     * These are DROP targets that should NOT be flagged as destructive.
     */
    const arbitraryNonTableObjectType: fc.Arbitrary<string> = fc.constantFrom(
      'VIEW', 'PROCEDURE', 'PROC', 'INDEX', 'FUNCTION', 'TRIGGER', 'SCHEMA', 'TYPE', 'SEQUENCE'
    ).chain(keyword => arbitraryCasing(keyword));

    /**
     * Generator: optional IF EXISTS clause with random casing and whitespace.
     */
    const arbitraryOptionalIfExists: fc.Arbitrary<string> = fc.oneof(
      fc.constant(''),
      fc.tuple(
        arbitraryWhitespace,
        arbitraryCasing('IF'),
        arbitraryWhitespace,
        arbitraryCasing('EXISTS')
      ).map(([ws1, ifKw, ws2, existsKw]) => `${ws1}${ifKw}${ws2}${existsKw}`)
    );

    /**
     * Generator: random object name (plain, schema-qualified, or bracket-quoted).
     */
    const arbitraryObjectName: fc.Arbitrary<string> = fc.oneof(
      arbitraryIdentifier,
      fc.tuple(arbitraryIdentifier, arbitraryIdentifier).map(([schema, obj]) => `${schema}.${obj}`),
      fc.tuple(arbitraryIdentifier, arbitraryIdentifier).map(([schema, obj]) => `[${schema}].[${obj}]`),
      arbitraryIdentifier.map(id => `[${id}]`)
    );

    /**
     * Generator: random DROP statement for non-TABLE/DATABASE objects.
     * Produces: {DROP} {ws} {objectType} {optionalIfExists} {ws} {objectName}
     */
    const arbitraryDropNonTable: fc.Arbitrary<string> = fc.tuple(
      arbitraryCasing('DROP'),
      arbitraryWhitespace,
      arbitraryNonTableObjectType,
      arbitraryOptionalIfExists,
      arbitraryWhitespace,
      arbitraryObjectName
    ).map(([drop, ws1, objType, ifExists, ws2, objName]) =>
      `${drop}${ws1}${objType}${ifExists}${ws2}${objName}`
    );

    /**
     * Validates: Requirements 4.4
     *
     * For any SQL statement beginning with DROP followed by an object type keyword
     * other than TABLE or DATABASE (e.g., VIEW, PROCEDURE, INDEX, FUNCTION, TRIGGER,
     * SCHEMA, TYPE, SEQUENCE), the analyzer SHALL NOT classify it as destructive.
     */
    it('DROP VIEW/PROCEDURE/INDEX/FUNCTION/TRIGGER are NOT classified as destructive', () => {
      fc.assert(
        fc.property(arbitraryDropNonTable, (sql) => {
          const reason = classifyStatement(sql);
          expect(reason).toBeNull();
        }),
        { numRuns: 200 }
      );
    });

    /**
     * Validates: Requirements 4.4
     *
     * End-to-end: the full analyze() pipeline does not flag DROP statements for
     * non-TABLE/DATABASE objects as destructive.
     */
    it('analyze() does not flag non-TABLE/DATABASE DROP statements', () => {
      fc.assert(
        fc.property(arbitraryDropNonTable, (sql) => {
          const result = analyze(sql);
          expect(result.statements.length).toBe(0);
        }),
        { numRuns: 200 }
      );
    });
  });

  // Feature: destructive-query-warning, Property 6: Comment and string literal exclusion
  describe('Property 6: Comment and string literal exclusion', () => {
    // =========================================================================
    // --- Property 6 Generators ---
    // =========================================================================

    /**
     * Generator: random destructive statement.
     * Picks from: DELETE FROM table, UPDATE table SET col = val,
     * TRUNCATE TABLE table, DROP TABLE table, DROP DATABASE db
     */
    const arbitraryDestructiveStatement: fc.Arbitrary<string> = fc.oneof(
      fc.tuple(arbitraryCasing('DELETE'), arbitraryCasing('FROM'), arbitraryTableName)
        .map(([del, from, table]) => `${del} ${from} ${table}`),
      fc.tuple(arbitraryCasing('UPDATE'), arbitraryTableName, arbitraryCasing('SET'), arbitraryColumnName, arbitrarySimpleValue)
        .map(([upd, table, set, col, val]) => `${upd} ${table} ${set} ${col} = ${val}`),
      fc.tuple(arbitraryCasing('TRUNCATE'), arbitraryCasing('TABLE'), arbitraryTableName)
        .map(([trunc, tbl, name]) => `${trunc} ${tbl} ${name}`),
      fc.tuple(arbitraryCasing('DROP'), arbitraryCasing('TABLE'), arbitraryTableName)
        .map(([drop, tbl, name]) => `${drop} ${tbl} ${name}`),
      fc.tuple(arbitraryCasing('DROP'), arbitraryCasing('DATABASE'), arbitraryIdentifier)
        .map(([drop, db, name]) => `${drop} ${db} ${name}`)
    );

    /**
     * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5
     *
     * For any destructive keyword pattern that appears exclusively within a
     * single-line comment (-- to end of line), the analyzer SHALL NOT classify
     * it as destructive.
     */
    it('destructive statements inside single-line comments are NOT detected', () => {
      fc.assert(
        fc.property(arbitraryDestructiveStatement, (stmt) => {
          const sql = `-- ${stmt}`;
          const result = analyze(sql);
          expect(result.statements.length).toBe(0);
        }),
        { numRuns: 200 }
      );
    });

    /**
     * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5
     *
     * For any destructive keyword pattern that appears exclusively within a
     * block comment (/* ... * /), the analyzer SHALL NOT classify it as destructive.
     */
    it('destructive statements inside block comments are NOT detected', () => {
      fc.assert(
        fc.property(arbitraryDestructiveStatement, (stmt) => {
          const sql = `/* ${stmt} */`;
          const result = analyze(sql);
          expect(result.statements.length).toBe(0);
        }),
        { numRuns: 200 }
      );
    });

    /**
     * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5
     *
     * For any destructive keyword pattern that appears exclusively within a
     * nested block comment (/* outer /* inner * / end * /), the analyzer SHALL
     * NOT classify it as destructive.
     */
    it('destructive statements inside nested block comments are NOT detected', () => {
      fc.assert(
        fc.property(arbitraryDestructiveStatement, (stmt) => {
          const sql = `/* outer /* ${stmt} */ end */`;
          const result = analyze(sql);
          expect(result.statements.length).toBe(0);
        }),
        { numRuns: 200 }
      );
    });

    /**
     * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5
     *
     * For any destructive keyword pattern that appears exclusively within a
     * string literal delimited by single quotes, the analyzer SHALL NOT classify
     * it as destructive.
     */
    it('destructive statements inside string literals are NOT detected', () => {
      fc.assert(
        fc.property(arbitraryDestructiveStatement, (stmt) => {
          // Escape any single quotes within the generated statement to keep the literal valid
          const escaped = stmt.replace(/'/g, "''");
          const sql = `SELECT '${escaped}' AS cmd`;
          const result = analyze(sql);
          expect(result.statements.length).toBe(0);
        }),
        { numRuns: 200 }
      );
    });
  });

  // Feature: destructive-query-warning, Property 7: Independent per-statement classification
  describe('Property 7: Independent per-statement classification', () => {
    // =========================================================================
    // --- Property 7 Generators ---
    // =========================================================================

    /**
     * Safe SQL statements that should never be flagged as destructive.
     */
    const safeStatements: string[] = [
      'SELECT * FROM t WHERE id = 1',
      'INSERT INTO t VALUES (1)',
      'CREATE TABLE t (id INT)',
      'SELECT COUNT(*) FROM orders',
      'INSERT INTO logs (msg) VALUES (\'hello\')',
      'CREATE INDEX idx_t ON t (col)',
    ];

    /**
     * Destructive SQL statements that should always be flagged.
     */
    const destructiveStatements: string[] = [
      'DELETE FROM t',
      'UPDATE t SET x = 1',
      'DROP TABLE t',
      'TRUNCATE TABLE t',
      'DELETE FROM orders',
      'UPDATE users SET active = 0',
      'DROP TABLE IF EXISTS temp',
    ];

    /**
     * Generator: produces a tagged statement object with its text and whether it's safe or destructive.
     */
    interface TaggedStatement {
      text: string;
      isSafe: boolean;
    }

    const arbitrarySafeStatement: fc.Arbitrary<TaggedStatement> = fc
      .constantFrom(...safeStatements)
      .map(text => ({ text, isSafe: true }));

    const arbitraryDestructiveTagged: fc.Arbitrary<TaggedStatement> = fc
      .constantFrom(...destructiveStatements)
      .map(text => ({ text, isSafe: false }));

    /**
     * Generator: array of tagged statements with a mix of safe and destructive,
     * guaranteed to have at least one of each type.
     */
    const arbitraryMixedStatements: fc.Arbitrary<TaggedStatement[]> = fc
      .tuple(
        // At least one safe
        fc.array(arbitrarySafeStatement, { minLength: 1, maxLength: 3 }),
        // At least one destructive
        fc.array(arbitraryDestructiveTagged, { minLength: 1, maxLength: 3 }),
        // Additional random mix
        fc.array(fc.oneof(arbitrarySafeStatement, arbitraryDestructiveTagged), { minLength: 0, maxLength: 4 })
      )
      .map(([safe, destructive, extra]) => {
        // Interleave: safe, destructive, extra — then shuffle deterministically
        const all = [...safe, ...destructive, ...extra];
        // Simple deterministic interleave: alternate safe/destructive then append extras
        const result: TaggedStatement[] = [];
        let si = 0, di = 0, ei = 0;
        while (si < safe.length || di < destructive.length) {
          if (si < safe.length) result.push(safe[si++]);
          if (di < destructive.length) result.push(destructive[di++]);
        }
        while (ei < extra.length) result.push(extra[ei++]);
        return result;
      });

    /**
     * Validates: Requirements 6.1, 6.2, 6.3, 6.4
     *
     * For any multi-statement SQL text containing a mix of safe and destructive
     * statements separated by semicolons, a safe statement surrounded by destructive
     * statements SHALL NOT be flagged.
     */
    it('safe statements surrounded by destructive ones are NOT flagged', () => {
      fc.assert(
        fc.property(arbitraryMixedStatements, (stmts) => {
          // Join each statement on its own line separated by semicolons
          const sql = stmts.map(s => s.text).join(';\n');
          const result = analyze(sql);

          // Collect the texts of flagged statements (trimmed for comparison)
          const flaggedTexts = result.statements.map(s => s.text.trim());

          // Assert: safe statements are NOT in the flagged results
          for (const stmt of stmts) {
            if (stmt.isSafe) {
              const found = flaggedTexts.some(ft => ft === stmt.text.trim());
              expect(found).toBe(false);
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Validates: Requirements 6.1, 6.2, 6.3, 6.4
     *
     * For any multi-statement SQL text containing a mix of safe and destructive
     * statements separated by semicolons, a destructive statement surrounded by
     * safe statements SHALL be flagged.
     */
    it('destructive statements surrounded by safe ones ARE flagged', () => {
      fc.assert(
        fc.property(arbitraryMixedStatements, (stmts) => {
          // Join each statement on its own line separated by semicolons
          const sql = stmts.map(s => s.text).join(';\n');
          const result = analyze(sql);

          // Collect the texts of flagged statements (trimmed for comparison)
          const flaggedTexts = result.statements.map(s => s.text.trim());

          // Assert: every destructive statement IS in the flagged results
          for (const stmt of stmts) {
            if (!stmt.isSafe) {
              const found = flaggedTexts.some(ft => ft === stmt.text.trim());
              expect(found).toBe(true);
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Validates: Requirements 6.1, 6.2, 6.3, 6.4
     *
     * For any multi-statement SQL text containing statements separated by semicolons
     * (each on its own line), the reported line number for each flagged statement
     * SHALL equal the 1-based line of its first non-whitespace content in the
     * original document.
     */
    it('reported line numbers match actual positions in the document', () => {
      fc.assert(
        fc.property(arbitraryMixedStatements, (stmts) => {
          // Each statement on its own line, separated by semicolons + newline
          const sql = stmts.map(s => s.text).join(';\n');
          const result = analyze(sql);

          // Calculate expected line numbers for each destructive statement.
          // With ";\n" as separator, each statement starts on a new line.
          // Statement 0 is at line 1 (1-based), statement 1 at line 2, etc.
          const expectedDestructive: { text: string; lineNumber: number }[] = [];
          for (let i = 0; i < stmts.length; i++) {
            if (!stmts[i].isSafe) {
              expectedDestructive.push({
                text: stmts[i].text.trim(),
                lineNumber: i + 1, // 1-based, each stmt is on its own line
              });
            }
          }

          // Assert: flagged count matches expected destructive count
          expect(result.statements.length).toBe(expectedDestructive.length);

          // Assert: each flagged statement has the correct line number
          for (let i = 0; i < result.statements.length; i++) {
            const actual = result.statements[i];
            const expected = expectedDestructive[i];
            expect(actual.text.trim()).toBe(expected.text);
            expect(actual.lineNumber).toBe(expected.lineNumber);
          }
        }),
        { numRuns: 100 }
      );
    });
  });

  // Feature: destructive-query-warning, Property 8: Statement snippet truncation
  describe('Property 8: Statement snippet truncation', () => {
    // =========================================================================
    // --- Property 8 Generators ---
    // =========================================================================

    /**
     * Generator: random DestructiveReason.
     */
    const arbitraryReason = fc.constantFrom(
      'UPDATE_WITHOUT_WHERE' as const,
      'DELETE_WITHOUT_WHERE' as const,
      'TRUNCATE_TABLE' as const,
      'DROP_TABLE' as const,
      'DROP_DATABASE' as const
    );

    /**
     * Generator: random line number (1-100).
     */
    const arbitraryLineNumber = fc.integer({ min: 1, max: 100 });

    /**
     * Generator: short destructive statement text (< 200 chars).
     */
    const arbitraryShortText = fc.oneof(
      arbitraryIdentifier.map(table => `DELETE FROM ${table}`),
      fc.tuple(arbitraryIdentifier, arbitraryIdentifier).map(
        ([table, col]) => `UPDATE ${table} SET ${col} = 1`
      ),
      arbitraryIdentifier.map(table => `TRUNCATE TABLE ${table}`),
      arbitraryIdentifier.map(table => `DROP TABLE ${table}`)
    ).filter(text => text.trim().length <= 200);

    /**
     * Generator: statement text of exactly 200 chars.
     */
    const arbitraryExact200Text = fc.constant('DELETE FROM ' + 'x'.repeat(188));

    /**
     * Generator: long destructive statement text (> 200 chars).
     */
    const arbitraryLongText = fc.integer({ min: 10, max: 30 }).map(n => {
      const base = 'UPDATE LongTableName SET ';
      const cols = Array.from({ length: n }, (_, i) => `column${i} = value${i}`).join(', ');
      return base + cols;
    }).filter(text => text.trim().length > 200);

    /**
     * Validates: Requirements 7.1, 7.2
     *
     * For any destructive statement, the formatted output SHALL always
     * start with "Line N: " where N is the 1-based line number.
     */
    it('formatted output always starts with "Line N: " prefix', () => {
      fc.assert(
        fc.property(
          fc.oneof(arbitraryShortText, arbitraryExact200Text, arbitraryLongText),
          arbitraryLineNumber,
          arbitraryReason,
          (text, lineNumber, reason) => {
            const stmt: DestructiveStatement = { text, lineNumber, reason };
            const result = formatStatementForDialog(stmt);
            expect(result.startsWith(`Line ${lineNumber}: `)).toBe(true);
          }
        ),
        { numRuns: 200 }
      );
    });

    /**
     * Validates: Requirements 7.1, 7.2
     *
     * For any destructive statement whose trimmed text is <= 200 characters,
     * the formatted output SHALL contain the full trimmed text and SHALL NOT
     * end with "...".
     */
    it('statements <= 200 chars are NOT truncated', () => {
      fc.assert(
        fc.property(
          fc.oneof(arbitraryShortText, arbitraryExact200Text),
          arbitraryLineNumber,
          arbitraryReason,
          (text, lineNumber, reason) => {
            const stmt: DestructiveStatement = { text, lineNumber, reason };
            const result = formatStatementForDialog(stmt);
            const prefix = `Line ${lineNumber}: `;
            const body = result.substring(prefix.length);
            expect(body).toBe(text.trim());
            expect(result.endsWith('...')).toBe(false);
          }
        ),
        { numRuns: 200 }
      );
    });

    /**
     * Validates: Requirements 7.1, 7.2
     *
     * For any destructive statement whose trimmed text exceeds 200 characters,
     * the formatted output SHALL end with "..." and the body (after prefix,
     * before "...") SHALL be the first 200 characters of the trimmed text.
     */
    it('statements > 200 chars are truncated to 200 chars with "..." suffix', () => {
      fc.assert(
        fc.property(
          arbitraryLongText,
          arbitraryLineNumber,
          arbitraryReason,
          (text, lineNumber, reason) => {
            const stmt: DestructiveStatement = { text, lineNumber, reason };
            const result = formatStatementForDialog(stmt);
            const prefix = `Line ${lineNumber}: `;
            const body = result.substring(prefix.length);
            expect(body.endsWith('...')).toBe(true);
            const truncatedBody = body.substring(0, body.length - 3);
            expect(truncatedBody.length).toBe(200);
            expect(truncatedBody).toBe(text.trim().substring(0, 200));
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  // Feature: destructive-query-warning, Property 9: Results ordered by line number
  describe('Property 9: Results ordered by line number', () => {
    // =========================================================================
    // --- Property 9 Generators ---
    // =========================================================================

    /**
     * Generator: a single destructive SQL statement (one of DELETE FROM, UPDATE SET,
     * DROP TABLE, TRUNCATE TABLE) with randomized casing.
     */
    const arbitraryDestructiveStatementForOrdering: fc.Arbitrary<string> = fc.oneof(
      // DELETE FROM <table>
      fc.tuple(
        arbitraryCasing('DELETE'),
        arbitraryCasing('FROM'),
        arbitraryTableName
      ).map(([del, from, table]) => `${del} ${from} ${table}`),

      // UPDATE <table> SET <col> = <val>
      fc.tuple(
        arbitraryCasing('UPDATE'),
        arbitraryTableName,
        arbitraryCasing('SET'),
        arbitraryColumnName,
        arbitrarySimpleValue
      ).map(([upd, table, set, col, val]) => `${upd} ${table} ${set} ${col} = ${val}`),

      // DROP TABLE <table>
      fc.tuple(
        arbitraryCasing('DROP'),
        arbitraryCasing('TABLE'),
        arbitraryTableName
      ).map(([drop, tbl, name]) => `${drop} ${tbl} ${name}`),

      // TRUNCATE TABLE <table>
      fc.tuple(
        arbitraryCasing('TRUNCATE'),
        arbitraryCasing('TABLE'),
        arbitraryTableName
      ).map(([trunc, tbl, name]) => `${trunc} ${tbl} ${name}`)
    );

    /**
     * Generator: optional blank lines (0-3 newlines) to create varied line positions.
     */
    const arbitraryBlankLines: fc.Arbitrary<string> = fc
      .integer({ min: 0, max: 3 })
      .map(n => '\n'.repeat(n));

    /**
     * Generator: SQL text with 2-5 destructive statements at various line positions,
     * separated by semicolons and newlines with optional blank lines between them.
     */
    const arbitraryMultiDestructiveSQL: fc.Arbitrary<string> = fc
      .array(
        fc.tuple(arbitraryDestructiveStatementForOrdering, arbitraryBlankLines),
        { minLength: 2, maxLength: 5 }
      )
      .map(pairs => {
        // Build SQL: each statement followed by a semicolon, then blank lines before next
        return pairs
          .map(([stmt, blanks], idx) => {
            if (idx < pairs.length - 1) {
              return stmt + ';' + blanks;
            }
            return stmt;
          })
          .join('\n');
      });

    /**
     * Validates: Requirements 7.6
     *
     * For any SQL text containing multiple destructive statements, the
     * AnalysisResult.statements array SHALL be sorted in ascending order by lineNumber.
     */
    it('AnalysisResult.statements are always sorted ascending by lineNumber', () => {
      fc.assert(
        fc.property(arbitraryMultiDestructiveSQL, (sql) => {
          const result = analyze(sql);

          // We expect at least 2 destructive statements
          expect(result.statements.length).toBeGreaterThanOrEqual(2);

          // Verify ascending order by lineNumber
          for (let i = 1; i < result.statements.length; i++) {
            expect(result.statements[i].lineNumber).toBeGreaterThanOrEqual(
              result.statements[i - 1].lineNumber
            );
          }
        }),
        { numRuns: 200 }
      );
    });
  });

  // Feature: destructive-query-warning, Property 10: Statement boundary character coverage
  describe('Property 10: Statement boundary character coverage', () => {
    // =========================================================================
    // --- Property 10 Generators ---
    // =========================================================================

    /**
     * Generator: random SQL-like statement content (safe keywords with identifiers).
     * Avoids semicolons and GO on its own line inside the content.
     */
    const arbitrarySqlContent: fc.Arbitrary<string> = fc.oneof(
      fc.tuple(
        fc.constantFrom('SELECT', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'CREATE TABLE'),
        arbitraryIdentifier,
        fc.constantFrom(' col1', ' col1, col2', ' *')
      ).map(([keyword, table, cols]) => `${keyword} ${table}${cols}`),
      fc.tuple(
        fc.constantFrom('SELECT'),
        fc.constantFrom('1', 'GETDATE()', 'COUNT(*)'),
        fc.constantFrom(' AS result', '')
      ).map(([sel, expr, alias]) => `${sel} ${expr}${alias}`)
    );

    /**
     * Generator: a batch of 1-5 statements separated by semicolons.
     */
    const arbitraryBatch: fc.Arbitrary<string> = fc
      .array(arbitrarySqlContent, { minLength: 1, maxLength: 5 })
      .map(stmts => stmts.join(';'));

    /**
     * Generator: random SQL text with 1-10 batches separated by GO on its own line.
     * Total length capped under 10,000 characters.
     */
    const arbitraryMultiBatchSql: fc.Arbitrary<string> = fc
      .array(arbitraryBatch, { minLength: 1, maxLength: 10 })
      .map(batches => batches.join('\nGO\n'))
      .filter(sql => sql.length <= 10000);

    /**
     * Validates: Requirements 11.1, 11.3
     *
     * For any SQL text input containing up to 50 statements across up to 10 batches
     * with a maximum length of 10,000 characters, parsed statement texts match their
     * corresponding regions in the original input (no characters added or removed).
     */
    it('parsed statement texts match their corresponding regions in the original input', () => {
      fc.assert(
        fc.property(arbitraryMultiBatchSql, (sql) => {
          const statements = parseStatements(sql);

          for (const stmt of statements) {
            // Each statement's text should exactly match the substring at its startOffset
            const region = sql.substring(stmt.startOffset, stmt.startOffset + stmt.text.length);
            expect(stmt.text).toBe(region);
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Validates: Requirements 11.1, 11.3
     *
     * For any SQL text input containing up to 50 statements across up to 10 batches
     * with a maximum length of 10,000 characters, parsed statement character ranges
     * do not overlap (no characters duplicated).
     */
    it('parsed statement ranges do not overlap', () => {
      fc.assert(
        fc.property(arbitraryMultiBatchSql, (sql) => {
          const statements = parseStatements(sql);

          // Sort by startOffset to check for overlaps
          const sorted = [...statements].sort((a, b) => a.startOffset - b.startOffset);

          for (let i = 1; i < sorted.length; i++) {
            const prevEnd = sorted[i - 1].startOffset + sorted[i - 1].text.length;
            // The next statement's start should be at or after the previous statement's end
            expect(sorted[i].startOffset).toBeGreaterThanOrEqual(prevEnd);
          }
        }),
        { numRuns: 100 }
      );
    });
  });

  // Feature: destructive-query-warning, Property 11: Deterministic analysis
  describe('Property 11: Deterministic analysis', () => {
    // =========================================================================
    // --- Property 11 Generators ---
    // =========================================================================

    /**
     * Generator: random SQL text mixing safe and destructive statements with varying
     * whitespace, comments, and string literals. Reuses the multi-batch pattern from
     * Property 10 and adds comments/strings for additional coverage.
     */
    const arbitrarySqlContentForDeterminism: fc.Arbitrary<string> = fc.oneof(
      // Safe statements
      fc.tuple(
        fc.constantFrom('SELECT', 'INSERT INTO', 'CREATE TABLE'),
        arbitraryIdentifier,
        fc.constantFrom(' col1', ' col1, col2', ' *')
      ).map(([keyword, table, cols]) => `${keyword} ${table}${cols}`),
      // Destructive statements
      fc.tuple(
        arbitraryCasing('DELETE'),
        arbitraryCasing('FROM'),
        arbitraryTableName
      ).map(([del, from, table]) => `${del} ${from} ${table}`),
      fc.tuple(
        arbitraryCasing('UPDATE'),
        arbitraryTableName,
        arbitraryCasing('SET'),
        arbitraryColumnName,
        arbitrarySimpleValue
      ).map(([upd, table, set, col, val]) => `${upd} ${table} ${set} ${col} = ${val}`),
      fc.tuple(
        arbitraryCasing('DROP'),
        arbitraryCasing('TABLE'),
        arbitraryTableName
      ).map(([drop, tbl, name]) => `${drop} ${tbl} ${name}`),
      fc.tuple(
        arbitraryCasing('TRUNCATE'),
        arbitraryCasing('TABLE'),
        arbitraryTableName
      ).map(([trunc, tbl, name]) => `${trunc} ${tbl} ${name}`)
    );

    /**
     * Generator: optional comment or string literal to intersperse in SQL.
     */
    const arbitraryCommentOrString: fc.Arbitrary<string> = fc.oneof(
      // Single-line comment
      fc.tuple(
        fc.constant('--'),
        fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz '.split('')), { minLength: 1, maxLength: 20 })
      ).map(([prefix, text]) => `${prefix} ${text}\n`),
      // Block comment
      fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz '.split('')), { minLength: 1, maxLength: 15 })
        .map(text => `/* ${text} */`),
      // String literal
      fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz '.split('')), { minLength: 1, maxLength: 15 })
        .map(text => `'${text}'`),
      // Just whitespace/newlines
      fc.integer({ min: 1, max: 3 }).map(n => '\n'.repeat(n))
    );

    /**
     * Generator: random SQL text with 1-8 statements across 1-4 batches,
     * interspersed with comments, strings, and varied whitespace.
     * Capped at 10,000 characters.
     */
    const arbitraryDeterminismSql: fc.Arbitrary<string> = fc
      .array(
        fc.tuple(
          fc.oneof(fc.constant(''), arbitraryCommentOrString),
          arbitrarySqlContentForDeterminism
        ).map(([prefix, stmt]) => `${prefix}${stmt}`),
        { minLength: 1, maxLength: 8 }
      )
      .chain(stmts => {
        // Join with semicolons and optionally insert GO batch separators
        return fc.integer({ min: 1, max: 4 }).map(batchCount => {
          if (batchCount === 1 || stmts.length <= 1) {
            return stmts.join(';\n');
          }
          // Split statements into batches separated by GO
          const batchSize = Math.max(1, Math.floor(stmts.length / batchCount));
          const batches: string[] = [];
          for (let i = 0; i < stmts.length; i += batchSize) {
            batches.push(stmts.slice(i, i + batchSize).join(';\n'));
          }
          return batches.join('\nGO\n');
        });
      })
      .filter(sql => sql.length <= 10000);

    /**
     * Validates: Requirements 11.2
     *
     * For any SQL text input, invoking the analyzer twice consecutively SHALL produce
     * identical results: same number of destructive statements, same line numbers,
     * same text values, and same classification order.
     */
    it('invoking analyze() twice on the same input produces identical results', () => {
      fc.assert(
        fc.property(arbitraryDeterminismSql, (sql) => {
          const result1 = analyze(sql);
          const result2 = analyze(sql);

          // Same number of destructive statements
          expect(result1.statements.length).toBe(result2.statements.length);

          // Same line numbers, text, and reason at each index
          for (let i = 0; i < result1.statements.length; i++) {
            expect(result1.statements[i].lineNumber).toBe(result2.statements[i].lineNumber);
            expect(result1.statements[i].text).toBe(result2.statements[i].text);
            expect(result1.statements[i].reason).toBe(result2.statements[i].reason);
          }
        }),
        { numRuns: 200 }
      );
    });
  });
});
