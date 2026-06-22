import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { analyzeSelectList, buildGroupByColumnList } from '../../server/src/groupByAnalyzer';
import { FULL_AGGREGATE_FUNCTIONS } from '../../server/src/aggregationContextDetector';

/**
 * Property-based tests for GROUP BY Analyzer (Properties 7, 8, 9, 11)
 * Feature: aggregation-group-by
 *
 * Validates: Requirements 4.1, 4.2, 4.4, 4.5, 5.2, 5.5, 8.3
 */

// --- Generators ---

/** SQL keywords that cannot be used as column/table identifiers */
const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'join', 'inner', 'left', 'right', 'full', 'cross',
  'outer', 'on', 'and', 'or', 'not', 'in', 'is', 'null', 'as', 'by', 'order',
  'group', 'having', 'union', 'except', 'intersect', 'into', 'set', 'values',
  'exec', 'execute', 'insert', 'update', 'delete', 'create', 'alter', 'drop',
  'table', 'view', 'index', 'with', 'top', 'distinct', 'all', 'between', 'like',
  'exists', 'case', 'when', 'then', 'else', 'end', 'asc', 'desc', 'limit',
  'offset', 'fetch', 'next', 'rows', 'only', 'count', 'sum', 'avg', 'min', 'max',
  'stdev', 'stdevp', 'var', 'varp', 'string_agg', 'checksum_agg', 'count_big',
]);

/** Generator: valid SQL column identifier (excludes SQL keywords and aggregate function names) */
const arbitraryColumnName: fc.Arbitrary<string> = fc.tuple(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
  fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
    { minLength: 1, maxLength: 8 }
  )
).map(([first, rest]) => first + rest)
  .filter(id => !SQL_KEYWORDS.has(id.toLowerCase()))
  .filter(id => !FULL_AGGREGATE_FUNCTIONS.has(id.toUpperCase()));

/** Generator: table alias (short lowercase, 1-3 chars) */
const arbitraryAlias: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
  { minLength: 1, maxLength: 3 }
).filter(a => !SQL_KEYWORDS.has(a.toLowerCase()))
  .filter(a => !FULL_AGGREGATE_FUNCTIONS.has(a.toUpperCase()));

/** Generator: table name */
const arbitraryTableName: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('Orders', 'Customers', 'Products', 'Employees', 'Invoices'),
  arbitraryColumnName.map(n => n.charAt(0).toUpperCase() + n.slice(1))
);

/** Generator: aggregate function name from the full set */
const arbitraryAggregateFunction: fc.Arbitrary<string> = fc.constantFrom(
  ...Array.from(FULL_AGGREGATE_FUNCTIONS)
);

/** Generator: qualified column reference (alias.column) */
const arbitraryQualifiedColumn: fc.Arbitrary<string> = fc.tuple(
  arbitraryAlias,
  arbitraryColumnName
).map(([alias, col]) => `${alias}.${col}`);

/** Generator: bare column reference (no alias) */
const arbitraryBareColumn: fc.Arbitrary<string> = arbitraryColumnName;

/** Generator: column expression (either bare or qualified) */
const arbitraryColumnExpr: fc.Arbitrary<string> = fc.oneof(
  arbitraryBareColumn,
  arbitraryQualifiedColumn
);

// --- Tests ---

describe('GroupByAnalyzer Property Tests', () => {
  describe('Feature: aggregation-group-by, Property 7: SELECT list analysis correctly classifies aggregated vs non-aggregated columns', () => {
    /**
     * Validates: Requirements 4.1, 4.2
     *
     * For any SELECT list containing a mix of aggregate-wrapped expressions and bare
     * column references, analyzeSelectList SHALL classify every expression inside an
     * aggregate function call as isAggregated: true and every bare column reference
     * as isAggregated: false, and nonAggregatedExpressions SHALL contain exactly the
     * bare column references.
     */

    it('bare columns are classified as non-aggregated', () => {
      fc.assert(
        fc.property(
          fc.array(arbitraryColumnExpr, { minLength: 1, maxLength: 5 }),
          arbitraryAggregateFunction,
          arbitraryColumnExpr,
          arbitraryTableName,
          (bareCols, aggFunc, aggCol, tableName) => {
            // Ensure unique column expressions
            const uniqueBareCols = [...new Set(bareCols)];
            fc.pre(uniqueBareCols.length >= 1);

            // Build SELECT: bare columns + one aggregate
            const selectItems = [...uniqueBareCols, `${aggFunc}(${aggCol})`];
            const sql = `SELECT ${selectItems.join(', ')} FROM ${tableName}`;

            const result = analyzeSelectList(sql);

            // All bare columns should be in nonAggregatedExpressions
            for (const col of uniqueBareCols) {
              expect(result.nonAggregatedExpressions).toContain(col);
            }

            // The aggregate expression should NOT be in nonAggregatedExpressions
            expect(result.nonAggregatedExpressions).not.toContain(`${aggFunc}(${aggCol})`);

            // hasAggregates should be true
            expect(result.hasAggregates).toBe(true);

            // needsGroupBy should be true (we have both aggregated and non-aggregated)
            expect(result.needsGroupBy).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('aggregate-wrapped expressions are classified as aggregated', () => {
      fc.assert(
        fc.property(
          fc.array(arbitraryAggregateFunction, { minLength: 1, maxLength: 4 }),
          fc.array(arbitraryColumnExpr, { minLength: 1, maxLength: 4 }),
          arbitraryColumnExpr,
          arbitraryTableName,
          (aggFuncs, aggCols, bareCol, tableName) => {
            // Build aggregate expressions
            const aggExprs = aggFuncs.map((func, i) => {
              const col = aggCols[i % aggCols.length];
              return `${func}(${col})`;
            });

            const sql = `SELECT ${bareCol}, ${aggExprs.join(', ')} FROM ${tableName}`;

            const result = analyzeSelectList(sql);

            // Each aggregate expression should be classified as aggregated
            for (const col of result.columns) {
              if (col.expression === bareCol) {
                expect(col.isAggregated).toBe(false);
              } else {
                // Aggregate-wrapped expressions
                expect(col.isAggregated).toBe(true);
              }
            }

            expect(result.hasAggregates).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('nonAggregatedExpressions contains exactly the bare column references', () => {
      fc.assert(
        fc.property(
          fc.array(arbitraryColumnExpr, { minLength: 1, maxLength: 4 }),
          fc.array(
            fc.tuple(arbitraryAggregateFunction, arbitraryColumnExpr),
            { minLength: 1, maxLength: 3 }
          ),
          arbitraryTableName,
          (bareCols, aggPairs, tableName) => {
            const uniqueBareCols = [...new Set(bareCols)];
            fc.pre(uniqueBareCols.length >= 1);

            const aggExprs = aggPairs.map(([func, col]) => `${func}(${col})`);
            const selectItems = [...uniqueBareCols, ...aggExprs];
            const sql = `SELECT ${selectItems.join(', ')} FROM ${tableName}`;

            const result = analyzeSelectList(sql);

            // nonAggregatedExpressions should have exactly the bare columns
            expect(result.nonAggregatedExpressions.length).toBe(uniqueBareCols.length);
            for (const col of uniqueBareCols) {
              expect(result.nonAggregatedExpressions).toContain(col);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Feature: aggregation-group-by, Property 8: Aliased expressions use original reference for GROUP BY', () => {
    /**
     * Validates: Requirements 4.4
     *
     * For any column expression with an alias (e.g., expr AS Name), analyzeSelectList
     * SHALL include the original expression (not the alias) in nonAggregatedExpressions.
     */

    it('aliased columns use original expression in nonAggregatedExpressions', () => {
      fc.assert(
        fc.property(
          arbitraryColumnExpr,
          arbitraryColumnName,
          arbitraryAggregateFunction,
          arbitraryColumnExpr,
          arbitraryTableName,
          (colExpr, aliasName, aggFunc, aggCol, tableName) => {
            // Ensure alias is different from column expression
            fc.pre(aliasName.toLowerCase() !== colExpr.toLowerCase());
            // Ensure alias doesn't look like a keyword
            fc.pre(!SQL_KEYWORDS.has(aliasName.toLowerCase()));

            const aliasedExpr = `${colExpr} AS ${aliasName}`;
            const sql = `SELECT ${aliasedExpr}, ${aggFunc}(${aggCol}) FROM ${tableName}`;

            const result = analyzeSelectList(sql);

            // The original expression (not the alias) should be in nonAggregatedExpressions
            expect(result.nonAggregatedExpressions).toContain(colExpr);
            // The alias should NOT be in nonAggregatedExpressions
            expect(result.nonAggregatedExpressions).not.toContain(aliasName);

            // The column entry should have the alias recorded
            const matchingCol = result.columns.find(c => c.expression === colExpr);
            expect(matchingCol).toBeDefined();
            expect(matchingCol!.alias).toBe(aliasName);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('multiple aliased columns all use original expressions', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(arbitraryColumnExpr, arbitraryColumnName),
            { minLength: 2, maxLength: 4 }
          ),
          arbitraryAggregateFunction,
          arbitraryColumnExpr,
          arbitraryTableName,
          (colAliasPairs, aggFunc, aggCol, tableName) => {
            // Ensure unique column expressions and aliases
            const seenExprs = new Set<string>();
            const seenAliases = new Set<string>();
            const uniquePairs = colAliasPairs.filter(([expr, alias]) => {
              const exprLower = expr.toLowerCase();
              const aliasLower = alias.toLowerCase();
              if (seenExprs.has(exprLower) || seenAliases.has(aliasLower)) return false;
              if (exprLower === aliasLower) return false;
              seenExprs.add(exprLower);
              seenAliases.add(aliasLower);
              return true;
            });
            fc.pre(uniquePairs.length >= 2);

            const aliasedItems = uniquePairs.map(([expr, alias]) => `${expr} AS ${alias}`);
            const sql = `SELECT ${aliasedItems.join(', ')}, ${aggFunc}(${aggCol}) FROM ${tableName}`;

            const result = analyzeSelectList(sql);

            // Each original expression should be in nonAggregatedExpressions
            for (const [expr, alias] of uniquePairs) {
              expect(result.nonAggregatedExpressions).toContain(expr);
              expect(result.nonAggregatedExpressions).not.toContain(alias);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Feature: aggregation-group-by, Property 9: All-aggregate SELECT lists do not trigger GROUP BY', () => {
    /**
     * Validates: Requirements 4.5
     *
     * For any SELECT list where every column expression is wrapped in an aggregate
     * function, analyzeSelectList SHALL return needsGroupBy: false and
     * nonAggregatedExpressions SHALL be empty.
     */

    it('all-aggregate SELECT returns needsGroupBy false', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(arbitraryAggregateFunction, arbitraryColumnExpr),
            { minLength: 1, maxLength: 5 }
          ),
          arbitraryTableName,
          (aggPairs, tableName) => {
            const aggExprs = aggPairs.map(([func, col]) => `${func}(${col})`);
            const sql = `SELECT ${aggExprs.join(', ')} FROM ${tableName}`;

            const result = analyzeSelectList(sql);

            expect(result.needsGroupBy).toBe(false);
            expect(result.nonAggregatedExpressions).toHaveLength(0);
            expect(result.hasAggregates).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('COUNT(*) alone does not trigger GROUP BY', () => {
      fc.assert(
        fc.property(
          arbitraryTableName,
          (tableName) => {
            const sql = `SELECT COUNT(*) FROM ${tableName}`;

            const result = analyzeSelectList(sql);

            expect(result.needsGroupBy).toBe(false);
            expect(result.nonAggregatedExpressions).toHaveLength(0);
            expect(result.hasAggregates).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('multiple aggregates with different functions do not trigger GROUP BY', () => {
      fc.assert(
        fc.property(
          fc.tuple(
            arbitraryAggregateFunction,
            arbitraryAggregateFunction,
            arbitraryAggregateFunction
          ),
          fc.tuple(
            arbitraryColumnExpr,
            arbitraryColumnExpr,
            arbitraryColumnExpr
          ),
          arbitraryTableName,
          ([func1, func2, func3], [col1, col2, col3], tableName) => {
            const sql = `SELECT ${func1}(${col1}), ${func2}(${col2}), ${func3}(${col3}) FROM ${tableName}`;

            const result = analyzeSelectList(sql);

            expect(result.needsGroupBy).toBe(false);
            expect(result.nonAggregatedExpressions).toHaveLength(0);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Feature: aggregation-group-by, Property 11: GROUP BY column list preserves alias qualification and SELECT order', () => {
    /**
     * Validates: Requirements 5.2, 5.5, 8.3
     *
     * For any ordered list of non-aggregated column expressions (including
     * dot-qualified aliases like o.CustomerID), buildGroupByColumnList SHALL
     * produce a comma-separated string preserving the original qualification
     * and the order in which they appear in the SELECT list.
     */

    it('buildGroupByColumnList preserves order of expressions', () => {
      fc.assert(
        fc.property(
          fc.array(arbitraryColumnExpr, { minLength: 1, maxLength: 6 }),
          (expressions) => {
            const uniqueExprs = [...new Set(expressions)];
            fc.pre(uniqueExprs.length >= 1);

            const result = buildGroupByColumnList(uniqueExprs);
            const parts = result.split(', ');

            // Same number of parts
            expect(parts.length).toBe(uniqueExprs.length);

            // Order is preserved
            for (let i = 0; i < uniqueExprs.length; i++) {
              expect(parts[i]).toBe(uniqueExprs[i]);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('buildGroupByColumnList preserves alias qualification (dot notation)', () => {
      fc.assert(
        fc.property(
          fc.array(arbitraryQualifiedColumn, { minLength: 1, maxLength: 5 }),
          (qualifiedCols) => {
            const uniqueCols = [...new Set(qualifiedCols)];
            fc.pre(uniqueCols.length >= 1);

            const result = buildGroupByColumnList(uniqueCols);
            const parts = result.split(', ');

            // Each part should contain a dot (alias.column)
            for (const part of parts) {
              expect(part).toContain('.');
            }

            // Each qualified column should appear exactly as provided
            for (let i = 0; i < uniqueCols.length; i++) {
              expect(parts[i]).toBe(uniqueCols[i]);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('end-to-end: analyzeSelectList + buildGroupByColumnList preserves SELECT order and qualification', () => {
      fc.assert(
        fc.property(
          fc.array(arbitraryQualifiedColumn, { minLength: 2, maxLength: 5 }),
          arbitraryAggregateFunction,
          arbitraryColumnExpr,
          arbitraryTableName,
          arbitraryAlias,
          (qualifiedCols, aggFunc, aggCol, tableName, tableAlias) => {
            const uniqueCols = [...new Set(qualifiedCols)];
            fc.pre(uniqueCols.length >= 2);

            const selectItems = [...uniqueCols, `${aggFunc}(${aggCol})`];
            const sql = `SELECT ${selectItems.join(', ')} FROM ${tableName} ${tableAlias}`;

            const analysis = analyzeSelectList(sql);
            const groupByList = buildGroupByColumnList(analysis.nonAggregatedExpressions);
            const parts = groupByList.split(', ');

            // Order matches the SELECT list order
            for (let i = 0; i < uniqueCols.length; i++) {
              expect(parts[i]).toBe(uniqueCols[i]);
            }

            // Qualification is preserved (all have dots)
            for (const part of parts) {
              expect(part).toContain('.');
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
