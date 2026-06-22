import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  CompletionItemKind,
  InsertTextFormat,
} from 'vscode-languageserver/node';
import {
  getAggregateColumnCompletions,
  getAggregateFunctionSnippets,
  NUMERIC_DATA_TYPES,
} from '../../server/src/completionProvider';
import {
  FULL_AGGREGATE_FUNCTIONS,
  NUMERIC_AGGREGATE_FUNCTIONS,
  WILDCARD_AGGREGATE_FUNCTIONS,
} from '../../server/src/aggregationContextDetector';
import { ColumnInfo } from '../../server/src/schemaCache';

/**
 * Property-based tests for Aggregate Column Completions
 * Feature: aggregation-group-by, Properties 1, 2, 3, 4, 6, 12, 13, 14
 *
 * **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 2.1, 2.3, 2.4, 3.3, 8.1, 8.2, 8.3, 8.4**
 */

// --- Constants ---

/** SQL keywords that cannot be used as column/table identifiers */
const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'join', 'inner', 'left', 'right', 'full', 'cross',
  'outer', 'on', 'and', 'or', 'not', 'in', 'is', 'null', 'as', 'by', 'order',
  'group', 'having', 'union', 'except', 'intersect', 'into', 'set', 'values',
  'count', 'sum', 'avg', 'min', 'max', 'stdev', 'stdevp', 'var', 'varp',
  'string_agg', 'checksum_agg', 'count_big',
]);

/** Numeric data types for generating numeric columns */
const NUMERIC_TYPES_ARRAY = ['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric', 'float', 'real', 'money', 'smallmoney'];

/** Non-numeric data types for generating non-numeric columns */
const NON_NUMERIC_TYPES_ARRAY = ['varchar', 'nvarchar', 'datetime', 'bit', 'uniqueidentifier', 'date', 'char', 'nchar'];

// --- Generators ---

/** Generator: valid SQL column identifier */
const arbColumnName: fc.Arbitrary<string> = fc.tuple(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
  fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
    { minLength: 1, maxLength: 8 }
  )
).map(([first, rest]) => first + rest)
  .filter(id => !SQL_KEYWORDS.has(id.toLowerCase()))
  .filter(id => !FULL_AGGREGATE_FUNCTIONS.has(id.toUpperCase()));

/** Generator: table alias (short lowercase, 1-3 chars) */
const arbAlias: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
  { minLength: 1, maxLength: 3 }
).filter(a => !SQL_KEYWORDS.has(a.toLowerCase()))
  .filter(a => !FULL_AGGREGATE_FUNCTIONS.has(a.toUpperCase()));

/** Generator: numeric data type */
const arbNumericType: fc.Arbitrary<string> = fc.constantFrom(...NUMERIC_TYPES_ARRAY);

/** Generator: non-numeric data type */
const arbNonNumericType: fc.Arbitrary<string> = fc.constantFrom(...NON_NUMERIC_TYPES_ARRAY);

/** Generator: any data type */
const arbDataType: fc.Arbitrary<string> = fc.oneof(arbNumericType, arbNonNumericType);

/** Generator: a column with a numeric data type */
const arbNumericColumn: fc.Arbitrary<ColumnInfo & { tableAlias?: string }> = fc.tuple(
  arbColumnName,
  arbNumericType,
  fc.boolean()
).map(([name, dataType, isNullable]) => ({ name, dataType, isNullable }));

/** Generator: a column with a non-numeric data type */
const arbNonNumericColumn: fc.Arbitrary<ColumnInfo & { tableAlias?: string }> = fc.tuple(
  arbColumnName,
  arbNonNumericType,
  fc.boolean()
).map(([name, dataType, isNullable]) => ({ name, dataType, isNullable }));

/** Generator: a column with any data type */
const arbColumn: fc.Arbitrary<ColumnInfo & { tableAlias?: string }> = fc.tuple(
  arbColumnName,
  arbDataType,
  fc.boolean()
).map(([name, dataType, isNullable]) => ({ name, dataType, isNullable }));

/** Generator: a column with a table alias */
const arbColumnWithAlias: fc.Arbitrary<ColumnInfo & { tableAlias?: string }> = fc.tuple(
  arbColumnName,
  arbDataType,
  fc.boolean(),
  arbAlias
).map(([name, dataType, isNullable, tableAlias]) => ({ name, dataType, isNullable, tableAlias }));

/** Generator: numeric aggregate function */
const arbNumericAggregateFunction: fc.Arbitrary<string> = fc.constantFrom(
  ...Array.from(NUMERIC_AGGREGATE_FUNCTIONS)
);

/** Generator: wildcard aggregate function (COUNT, COUNT_BIG) */
const arbWildcardAggregateFunction: fc.Arbitrary<string> = fc.constantFrom(
  ...Array.from(WILDCARD_AGGREGATE_FUNCTIONS)
);

/** Generator: any aggregate function */
const arbAggregateFunction: fc.Arbitrary<string> = fc.constantFrom(
  ...Array.from(FULL_AGGREGATE_FUNCTIONS)
);

// --- Property Tests ---

describe('Feature: aggregation-group-by, Property 1: Numeric columns ranked higher in numeric aggregates', () => {
  /**
   * **Validates: Requirements 1.3**
   *
   * For any set of columns with mixed data types (at least one numeric and one non-numeric),
   * when generating completions inside a numeric-preferring aggregate function (SUM, AVG, STDEV,
   * STDEVP, VAR, VARP), all numeric columns SHALL have a lower sortText value than all non-numeric columns.
   */
  it('numeric columns have lower sortText than non-numeric columns in numeric aggregates', () => {
    fc.assert(
      fc.property(
        fc.array(arbNumericColumn, { minLength: 1, maxLength: 5 }),
        fc.array(arbNonNumericColumn, { minLength: 1, maxLength: 5 }),
        arbNumericAggregateFunction,
        (numericCols, nonNumericCols, funcName) => {
          // Ensure unique column names
          const allNames = new Set<string>();
          const uniqueNumeric = numericCols.filter(c => {
            if (allNames.has(c.name.toLowerCase())) return false;
            allNames.add(c.name.toLowerCase());
            return true;
          });
          const uniqueNonNumeric = nonNumericCols.filter(c => {
            if (allNames.has(c.name.toLowerCase())) return false;
            allNames.add(c.name.toLowerCase());
            return true;
          });

          fc.pre(uniqueNumeric.length >= 1 && uniqueNonNumeric.length >= 1);

          const columns = [...uniqueNumeric, ...uniqueNonNumeric];
          const items = getAggregateColumnCompletions(columns, funcName);

          // Get sortText values for numeric and non-numeric columns
          const numericSortTexts: string[] = [];
          const nonNumericSortTexts: string[] = [];

          for (const item of items) {
            const label = typeof item.label === 'string' ? item.label : '';
            const isNumericCol = uniqueNumeric.some(c => c.name === label);
            const isNonNumericCol = uniqueNonNumeric.some(c => c.name === label);

            if (isNumericCol && item.sortText) {
              numericSortTexts.push(item.sortText);
            } else if (isNonNumericCol && item.sortText) {
              nonNumericSortTexts.push(item.sortText);
            }
          }

          // All numeric sortTexts should be less than all non-numeric sortTexts
          for (const numSort of numericSortTexts) {
            for (const nonNumSort of nonNumericSortTexts) {
              expect(numSort < nonNumSort).toBe(true);
            }
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe('Feature: aggregation-group-by, Property 2: Wildcard aggregates include all columns plus star', () => {
  /**
   * **Validates: Requirements 1.4**
   *
   * For any set of columns from referenced tables, when generating completions inside
   * COUNT or COUNT_BIG, the completion list SHALL contain an item for every column AND a `*` item.
   */
  it('COUNT/COUNT_BIG completions include all columns and a * item', () => {
    fc.assert(
      fc.property(
        fc.array(arbColumn, { minLength: 1, maxLength: 8 }),
        arbWildcardAggregateFunction,
        (columns, funcName) => {
          // Ensure unique column names
          const seen = new Set<string>();
          const uniqueColumns = columns.filter(c => {
            if (seen.has(c.name.toLowerCase())) return false;
            seen.add(c.name.toLowerCase());
            return true;
          });

          fc.pre(uniqueColumns.length >= 1);

          const items = getAggregateColumnCompletions(uniqueColumns, funcName);
          const labels = items.map(i => typeof i.label === 'string' ? i.label : '');

          // Must include * item
          expect(labels).toContain('*');

          // Must include all column names
          for (const col of uniqueColumns) {
            expect(labels).toContain(col.name);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe('Feature: aggregation-group-by, Property 3: MIN/MAX suggest all columns without type restriction', () => {
  /**
   * **Validates: Requirements 1.5**
   *
   * For any set of columns from referenced tables, when generating completions inside
   * MIN or MAX, the completion list SHALL contain an item for every column regardless of data type.
   */
  it('MIN/MAX completions include all columns regardless of data type', () => {
    fc.assert(
      fc.property(
        fc.array(arbColumn, { minLength: 1, maxLength: 8 }),
        fc.constantFrom('MIN', 'MAX'),
        (columns, funcName) => {
          // Ensure unique column names
          const seen = new Set<string>();
          const uniqueColumns = columns.filter(c => {
            if (seen.has(c.name.toLowerCase())) return false;
            seen.add(c.name.toLowerCase());
            return true;
          });

          fc.pre(uniqueColumns.length >= 1);

          const items = getAggregateColumnCompletions(uniqueColumns, funcName);
          const labels = items.map(i => typeof i.label === 'string' ? i.label : '');

          // Must include all column names
          for (const col of uniqueColumns) {
            expect(labels).toContain(col.name);
          }

          // Should NOT include * (MIN/MAX don't support wildcard)
          expect(labels).not.toContain('*');
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe('Feature: aggregation-group-by, Property 4: Aggregate function completion items have correct structure', () => {
  /**
   * **Validates: Requirements 2.1, 2.3, 2.4**
   *
   * For any aggregate function in FULL_AGGREGATE_FUNCTIONS, the generated completion item SHALL have:
   * (a) insertText matching the snippet pattern `FUNCNAME($1)` (or `FUNCNAME($1, $2)` for STRING_AGG),
   * (b) kind equal to CompletionItemKind.Function, and
   * (c) a command property that triggers re-completion.
   */
  it('all aggregate function snippets have correct structure', () => {
    fc.assert(
      fc.property(
        arbAggregateFunction,
        (funcName) => {
          const items = getAggregateFunctionSnippets();
          const item = items.find(i => i.label === funcName);

          expect(item).toBeDefined();
          if (!item) return;

          // (a) insertText matches snippet pattern
          if (funcName === 'STRING_AGG') {
            expect(item.insertText).toBe(`${funcName}($1, $2)`);
          } else {
            expect(item.insertText).toBe(`${funcName}($1)`);
          }

          // (b) kind is Function
          expect(item.kind).toBe(CompletionItemKind.Function);

          // (c) insertTextFormat is Snippet
          expect(item.insertTextFormat).toBe(InsertTextFormat.Snippet);

          // (d) command triggers re-completion
          expect(item.command).toBeDefined();
          expect(item.command!.command).toBe('editor.action.triggerSuggest');
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Feature: aggregation-group-by, Property 6: Aggregation context suppresses table/view suggestions', () => {
  /**
   * **Validates: Requirements 3.3**
   *
   * For any detected aggregation context (inAggregate=true), the returned completion items
   * SHALL NOT include items with kind=Module and detail="Table" or detail="View".
   */
  it('getAggregateColumnCompletions never returns table/view items', () => {
    fc.assert(
      fc.property(
        fc.array(arbColumn, { minLength: 1, maxLength: 8 }),
        arbAggregateFunction,
        (columns, funcName) => {
          // Ensure unique column names
          const seen = new Set<string>();
          const uniqueColumns = columns.filter(c => {
            if (seen.has(c.name.toLowerCase())) return false;
            seen.add(c.name.toLowerCase());
            return true;
          });

          fc.pre(uniqueColumns.length >= 1);

          const items = getAggregateColumnCompletions(uniqueColumns, funcName);

          // No item should have kind=Module with detail="Table" or "View"
          for (const item of items) {
            if (item.kind === CompletionItemKind.Module) {
              expect(item.detail).not.toBe('Table');
              expect(item.detail).not.toBe('View');
            }
          }

          // All items should be Field kind (columns or *)
          for (const item of items) {
            expect(item.kind).toBe(CompletionItemKind.Field);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe('Feature: aggregation-group-by, Property 12: Multi-table aggregation includes columns from all referenced tables', () => {
  /**
   * **Validates: Requirements 1.2, 8.1**
   *
   * For any set of tables referenced via FROM/JOIN clauses, when the cursor is inside
   * an aggregate function's parentheses, the completion list SHALL include columns from
   * every referenced table.
   */
  it('columns from all tables appear in aggregate completions when multiple tables referenced', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.array(arbColumnName, { minLength: 1, maxLength: 4 }),
          fc.array(arbColumnName, { minLength: 1, maxLength: 4 }),
          arbAlias,
          arbAlias,
          arbAggregateFunction
        ).filter(([_, __, alias1, alias2]) => alias1 !== alias2),
        ([table1Cols, table2Cols, alias1, alias2, funcName]) => {
          // Ensure unique column names within each table
          const seen1 = new Set<string>();
          const uniqueT1 = table1Cols.filter(n => {
            if (seen1.has(n.toLowerCase())) return false;
            seen1.add(n.toLowerCase());
            return true;
          });
          const seen2 = new Set<string>();
          const uniqueT2 = table2Cols.filter(n => {
            if (seen2.has(n.toLowerCase())) return false;
            seen2.add(n.toLowerCase());
            return true;
          });

          fc.pre(uniqueT1.length >= 1 && uniqueT2.length >= 1);

          // Build columns with table aliases (simulating multi-table scenario)
          const columns: Array<ColumnInfo & { tableAlias?: string }> = [
            ...uniqueT1.map(name => ({
              name,
              dataType: 'int',
              isNullable: false,
              tableAlias: alias1,
            })),
            ...uniqueT2.map(name => ({
              name,
              dataType: 'varchar',
              isNullable: true,
              tableAlias: alias2,
            })),
          ];

          const items = getAggregateColumnCompletions(columns, funcName);
          const labels = items.map(i => typeof i.label === 'string' ? i.label : '');

          // All columns from table 1 should appear (qualified with alias)
          for (const colName of uniqueT1) {
            expect(labels).toContain(`${alias1}.${colName}`);
          }

          // All columns from table 2 should appear (qualified with alias)
          for (const colName of uniqueT2) {
            expect(labels).toContain(`${alias2}.${colName}`);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe('Feature: aggregation-group-by, Property 13: Ambiguous column names require qualification', () => {
  /**
   * **Validates: Requirements 8.2**
   *
   * For any two or more tables with at least one shared column name, when generating
   * column completions inside an aggregate function, the shared column name SHALL only
   * appear with table alias/name prefix (qualified), never unqualified.
   */
  it('shared column names only appear qualified when multiple tables have the same column', () => {
    fc.assert(
      fc.property(
        arbColumnName,
        arbAlias,
        arbAlias,
        arbAggregateFunction,
        (sharedColName, alias1, alias2, funcName) => {
          fc.pre(alias1 !== alias2);

          // Both tables have a column with the same name
          const columns: Array<ColumnInfo & { tableAlias?: string }> = [
            { name: sharedColName, dataType: 'int', isNullable: false, tableAlias: alias1 },
            { name: sharedColName, dataType: 'varchar', isNullable: true, tableAlias: alias2 },
          ];

          const items = getAggregateColumnCompletions(columns, funcName);
          const labels = items.map(i => typeof i.label === 'string' ? i.label : '');

          // The unqualified column name should NOT appear
          const unqualifiedLabels = labels.filter(l => l === sharedColName);
          expect(unqualifiedLabels.length).toBe(0);

          // The qualified versions should appear
          expect(labels).toContain(`${alias1}.${sharedColName}`);
          expect(labels).toContain(`${alias2}.${sharedColName}`);
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe('Feature: aggregation-group-by, Property 14: Alias resolution determines data type for ranking', () => {
  /**
   * **Validates: Requirements 8.4**
   *
   * For any column reference using a table alias (e.g., o.Amount), when inside a
   * numeric-preferring aggregate, the system SHALL resolve the alias to the underlying
   * table, look up the column's data type, and rank it according to whether that data
   * type is numeric.
   */
  it('aliased columns are ranked by their resolved data type in numeric aggregates', () => {
    fc.assert(
      fc.property(
        arbColumnName,
        arbColumnName,
        arbAlias,
        arbNumericAggregateFunction,
        (numericColName, nonNumericColName, alias, funcName) => {
          fc.pre(numericColName.toLowerCase() !== nonNumericColName.toLowerCase());

          // Simulate columns with alias — one numeric, one non-numeric
          const columns: Array<ColumnInfo & { tableAlias?: string }> = [
            { name: numericColName, dataType: 'decimal', isNullable: false, tableAlias: alias },
            { name: nonNumericColName, dataType: 'varchar', isNullable: true, tableAlias: alias },
          ];

          const items = getAggregateColumnCompletions(columns, funcName);

          // Find the items for our columns
          const numericItem = items.find(i => i.label === `${alias}.${numericColName}`);
          const nonNumericItem = items.find(i => i.label === `${alias}.${nonNumericColName}`);

          expect(numericItem).toBeDefined();
          expect(nonNumericItem).toBeDefined();

          if (numericItem && nonNumericItem) {
            // Numeric column should have lower sortText (higher priority)
            expect(numericItem.sortText! < nonNumericItem.sortText!).toBe(true);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});
