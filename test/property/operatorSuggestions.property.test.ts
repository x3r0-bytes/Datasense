import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  getOperatorCompletions,
  STRING_TYPES,
  NUMERIC_TYPES,
  DATETIME_TYPES,
} from '../../server/src/completionProvider';
import { ISchemaCache, TableInfo, ViewInfo, ProcedureInfo, ForeignKeyInfo, ColumnInfo } from '../../server/src/schemaCache';

/**
 * Property-based tests for operator suggestions (Properties 12–14)
 * Feature: query-scoped-intellisense
 */

// --- Helpers ---

function createMockSchemaCache(tables: TableInfo[]): ISchemaCache {
  return {
    tables,
    views: [] as ViewInfo[],
    procedures: [] as ProcedureInfo[],
    foreignKeys: [] as ForeignKeyInfo[],
    isPopulating: false,
    refresh: async () => {},
    getForeignKeysForTable: () => [],
  };
}

// --- Generators ---

/** Generator: random valid SQL identifier */
const arbitraryIdentifier: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')),
      { minLength: 1, maxLength: 8 }
    )
  )
  .map(([first, rest]) => first + rest)
  .filter((id) => !/^(select|from|where|join|inner|left|right|full|cross|on|order|group|having|exec|execute|insert|update|delete|create|alter|drop|begin|end|if|else|while|return|declare|set|union|all|except|intersect|into|values|as|and|or|not|in|exists|between|like|is|null|case|when|then|distinct|top|with|go|use|print|by)$/i.test(id));

/** Generator: random schema name */
const arbitrarySchemaName: fc.Arbitrary<string> = fc.constantFrom('dbo', 'sales', 'hr');

/** Generator: a string data type */
const arbitraryStringType: fc.Arbitrary<string> = fc.constantFrom(
  ...Array.from(STRING_TYPES)
);

/** Generator: a numeric data type */
const arbitraryNumericType: fc.Arbitrary<string> = fc.constantFrom(
  ...Array.from(NUMERIC_TYPES)
);

/** Generator: a datetime data type */
const arbitraryDatetimeType: fc.Arbitrary<string> = fc.constantFrom(
  ...Array.from(DATETIME_TYPES)
);

/** Generator: an unrecognized data type (not in any known category) */
const arbitraryUnknownType: fc.Arbitrary<string> = fc.constantFrom(
  'xml', 'uniqueidentifier', 'varbinary', 'image', 'sql_variant', 'geography', 'geometry', 'hierarchyid'
);

/** Generator: a column with a specific data type */
function arbitraryColumnWithType(dataTypeArb: fc.Arbitrary<string>): fc.Arbitrary<ColumnInfo> {
  return fc
    .tuple(arbitraryIdentifier, dataTypeArb, fc.boolean())
    .map(([name, dataType, isNullable]) => ({ name, dataType, isNullable }));
}

/**
 * Generator: a WHERE context scenario with a column of a specific data type category.
 * Returns the textBeforeCursor, batchText, schemaCache, and the target column.
 */
function arbitraryWhereContextWithColumnType(dataTypeArb: fc.Arbitrary<string>): fc.Arbitrary<{
  textBeforeCursor: string;
  batchText: string;
  schemaCache: ISchemaCache;
  targetColumn: ColumnInfo;
}> {
  return fc
    .tuple(
      arbitrarySchemaName,
      arbitraryIdentifier,
      arbitraryColumnWithType(dataTypeArb),
      // Additional columns to make the table realistic
      fc.array(arbitraryColumnWithType(fc.constantFrom('int', 'varchar', 'datetime', 'bit')), { minLength: 0, maxLength: 3 })
    )
    .map(([schema, tableName, targetColumn, otherColumns]) => {
      // Ensure column names are unique
      const seen = new Set<string>([targetColumn.name.toLowerCase()]);
      const uniqueOthers = otherColumns.filter((col) => {
        const key = col.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const table: TableInfo = {
        schema,
        name: tableName,
        columns: [targetColumn, ...uniqueOthers],
      };

      const schemaCache = createMockSchemaCache([table]);
      const batchText = `SELECT * FROM ${schema}.${tableName} WHERE ${targetColumn.name} `;
      const textBeforeCursor = batchText;

      return { textBeforeCursor, batchText, schemaCache, targetColumn };
    });
}

// --- Property 13 Tests ---

describe('Operator Suggestions Property Tests', () => {
  describe('Property 13: Data-type-aware operator ordering', () => {
    /**
     * Validates: Requirements 7.2, 7.3, 7.4, 7.5
     *
     * For any WHERE clause context where operator suggestions are triggered after a column name:
     * - if the column's data type is a string type, LIKE and = SHALL have lower sortText than other operators
     * - if numeric, =, <>, <, >, >=, <= SHALL have lower sortText
     * - if date/time, BETWEEN, >=, <= SHALL have lower sortText
     * - if unrecognized, all operators SHALL have equal sortText
     */

    it('string type columns prioritize LIKE and = operators (lower sortText)', () => {
      fc.assert(
        fc.property(
          arbitraryWhereContextWithColumnType(arbitraryStringType),
          ({ textBeforeCursor, batchText, schemaCache }) => {
            const result = getOperatorCompletions(textBeforeCursor, batchText, schemaCache);

            // Should have operator suggestions
            expect(result.length).toBeGreaterThan(0);

            // LIKE and = should have priority sortText (prefix "0_")
            const likeItem = result.find(item => item.label === 'LIKE');
            const eqItem = result.find(item => item.label === '=');
            expect(likeItem).toBeDefined();
            expect(eqItem).toBeDefined();
            expect((likeItem!.sortText as string).startsWith('0_')).toBe(true);
            expect((eqItem!.sortText as string).startsWith('0_')).toBe(true);

            // Other operators should have non-priority sortText (prefix "1_")
            const nonPriorityOps = result.filter(
              item => item.label !== 'LIKE' && item.label !== '='
            );
            for (const op of nonPriorityOps) {
              expect((op.sortText as string).startsWith('1_')).toBe(true);
            }

            // Priority operators have lower sortText than non-priority
            for (const priorityOp of [likeItem!, eqItem!]) {
              for (const otherOp of nonPriorityOps) {
                expect(priorityOp.sortText! < otherOp.sortText!).toBe(true);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('numeric type columns prioritize =, <>, <, >, >=, <= operators (lower sortText)', () => {
      fc.assert(
        fc.property(
          arbitraryWhereContextWithColumnType(arbitraryNumericType),
          ({ textBeforeCursor, batchText, schemaCache }) => {
            const result = getOperatorCompletions(textBeforeCursor, batchText, schemaCache);

            expect(result.length).toBeGreaterThan(0);

            const numericPriorityOps = ['=', '<>', '<', '>', '>=', '<='];
            const numericPrioritySet = new Set(numericPriorityOps);

            // Priority operators should have sortText prefix "0_"
            for (const opLabel of numericPriorityOps) {
              const item = result.find(i => i.label === opLabel);
              expect(item).toBeDefined();
              expect((item!.sortText as string).startsWith('0_')).toBe(true);
            }

            // Non-priority operators (LIKE, IN, BETWEEN, IS NULL, IS NOT NULL) should have prefix "1_"
            const nonPriorityItems = result.filter(
              item => !numericPrioritySet.has(item.label as string)
            );
            for (const op of nonPriorityItems) {
              expect((op.sortText as string).startsWith('1_')).toBe(true);
            }

            // Priority operators have lower sortText than non-priority
            const priorityItems = result.filter(
              item => numericPrioritySet.has(item.label as string)
            );
            for (const priorityOp of priorityItems) {
              for (const otherOp of nonPriorityItems) {
                expect(priorityOp.sortText! < otherOp.sortText!).toBe(true);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('datetime type columns prioritize BETWEEN, >=, <= operators (lower sortText)', () => {
      fc.assert(
        fc.property(
          arbitraryWhereContextWithColumnType(arbitraryDatetimeType),
          ({ textBeforeCursor, batchText, schemaCache }) => {
            const result = getOperatorCompletions(textBeforeCursor, batchText, schemaCache);

            expect(result.length).toBeGreaterThan(0);

            const datetimePriorityOps = ['BETWEEN', '>=', '<='];
            const datetimePrioritySet = new Set(datetimePriorityOps);

            // Priority operators should have sortText prefix "0_"
            for (const opLabel of datetimePriorityOps) {
              const item = result.find(i => i.label === opLabel);
              expect(item).toBeDefined();
              expect((item!.sortText as string).startsWith('0_')).toBe(true);
            }

            // Non-priority operators should have prefix "1_"
            const nonPriorityItems = result.filter(
              item => !datetimePrioritySet.has(item.label as string)
            );
            for (const op of nonPriorityItems) {
              expect((op.sortText as string).startsWith('1_')).toBe(true);
            }

            // Priority operators have lower sortText than non-priority
            const priorityItems = result.filter(
              item => datetimePrioritySet.has(item.label as string)
            );
            for (const priorityOp of priorityItems) {
              for (const otherOp of nonPriorityItems) {
                expect(priorityOp.sortText! < otherOp.sortText!).toBe(true);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('unrecognized data type columns give all operators equal sortText', () => {
      fc.assert(
        fc.property(
          arbitraryWhereContextWithColumnType(arbitraryUnknownType),
          ({ textBeforeCursor, batchText, schemaCache }) => {
            const result = getOperatorCompletions(textBeforeCursor, batchText, schemaCache);

            expect(result.length).toBeGreaterThan(0);

            // All operators should have the same tier prefix ("1_" since no priority ops)
            const sortTexts = result.map(item => item.sortText as string);
            const prefixes = sortTexts.map(st => st.split('_')[0]);
            for (const prefix of prefixes) {
              expect(prefix).toBe('1');
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
