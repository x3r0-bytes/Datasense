import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  getJoinCompletions,
  filterByJoinPrefix,
  formatTargetTableName,
  formatSourceReference,
  buildOnClause,
  JoinCompletionContext,
} from '../../server/src/joinGenerator';
import { ISchemaCache, ForeignKeyInfo, TableInfo, ViewInfo } from '../../server/src/schemaCache';
import { TableReference } from '../../server/src/completionProvider';

/**
 * Property-based tests for JoinGenerator (Properties 5, 6, 7, 8, 9, 12, 13, 22)
 * Feature: smart-join-generator
 *
 * Validates: Requirements 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1-4.6, 6.1-6.4, 7.1-7.4, 8.1
 */

// --- Generators ---

/** Generator: valid SQL identifier (letters, digits, underscores, starting with letter) */
const arbitraryIdentifier: fc.Arbitrary<string> = fc.tuple(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
  fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')),
    { minLength: 0, maxLength: 15 }
  )
).map(([first, rest]) => first + rest);

/** Generator: schema name */
const arbitrarySchema: fc.Arbitrary<string> = fc.oneof(
  fc.constant('dbo'),
  fc.constant('DBO'),
  fc.constant('Dbo'),
  fc.constant('sales'),
  fc.constant('hr'),
  fc.constant('inventory'),
  arbitraryIdentifier
);

/** Generator: table name (PascalCase style) */
const arbitraryTableName: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('Orders', 'Customers', 'Products', 'OrderDetails', 'Employees', 'Invoices', 'Categories', 'Suppliers'),
  fc.tuple(
    fc.constantFrom('Order', 'Customer', 'Product', 'Invoice', 'Employee'),
    fc.constantFrom('Details', 'Items', 'History', 'Log', 'Data')
  ).map(([a, b]) => a + b),
  arbitraryIdentifier
);

/** Generator: column name */
const arbitraryColumnName: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('Id', 'Name', 'CustomerID', 'OrderID', 'ProductID', 'Amount', 'Date', 'Status'),
  arbitraryIdentifier
);

/** Generator: ForeignKeyColumnPair */
const arbitraryColumnPair = (ordinal: number) => fc.tuple(
  arbitraryColumnName,
  arbitraryColumnName
).map(([refCol, refdCol]) => ({
  referencingColumn: refCol,
  referencedColumn: refdCol,
  ordinalPosition: ordinal,
}));

/** Generator: ForeignKeyInfo with 1-3 column pairs */
const arbitraryForeignKey: fc.Arbitrary<ForeignKeyInfo> = fc.tuple(
  arbitraryIdentifier, // constraintName
  arbitrarySchema,     // referencingSchema
  arbitraryTableName,  // referencingTable
  arbitrarySchema,     // referencedSchema
  arbitraryTableName,  // referencedTable
  fc.integer({ min: 1, max: 3 }) // number of column pairs
).chain(([constraintName, refSchema, refTable, refdSchema, refdTable, pairCount]) => {
  const pairs = Array.from({ length: pairCount }, (_, i) => arbitraryColumnPair(i + 1));
  return fc.tuple(...pairs).map(columnPairs => ({
    constraintName,
    referencingSchema: refSchema,
    referencingTable: refTable,
    referencedSchema: refdSchema,
    referencedTable: refdTable,
    columnPairs,
  }));
});

/** Generator: TableReference */
const arbitraryTableRef: fc.Arbitrary<TableReference> = fc.tuple(
  fc.option(arbitrarySchema, { nil: undefined }),
  arbitraryTableName,
  fc.option(fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 1, maxLength: 5 }), { nil: undefined })
).map(([schema, name, alias]) => ({ schema, name, alias }));

/** Helper: create a mock ISchemaCache */
function createMockSchemaCache(opts: {
  tables?: TableInfo[];
  views?: ViewInfo[];
  foreignKeys?: ForeignKeyInfo[];
  isPopulating?: boolean;
}): ISchemaCache {
  const tables = opts.tables || [];
  const views = opts.views || [];
  const foreignKeys = opts.foreignKeys || [];
  const isPopulating = opts.isPopulating || false;

  // Build FK index
  const fkIndex = new Map<string, ForeignKeyInfo[]>();
  for (const fk of foreignKeys) {
    const referencingKey = `${fk.referencingSchema}.${fk.referencingTable}`.toLowerCase();
    const referencedKey = `${fk.referencedSchema}.${fk.referencedTable}`.toLowerCase();

    if (!fkIndex.has(referencingKey)) fkIndex.set(referencingKey, []);
    fkIndex.get(referencingKey)!.push(fk);

    if (!fkIndex.has(referencedKey)) fkIndex.set(referencedKey, []);
    fkIndex.get(referencedKey)!.push(fk);
  }

  return {
    tables,
    views,
    procedures: [],
    foreignKeys,
    isPopulating,
    refresh: async () => {},
    getForeignKeysForTable(schema: string, tableName: string): ForeignKeyInfo[] {
      const key = `${schema}.${tableName}`.toLowerCase();
      return fkIndex.get(key) || [];
    },
  };
}


// --- Tests ---

describe('JoinGenerator Property Tests', () => {
  describe('Feature: smart-join-generator, Property 5: FK-related tables suggested in JOIN context', () => {
    /**
     * Validates: Requirements 2.3, 3.1, 3.2, 3.3
     *
     * For any set of source tables with foreign key relationships, the Join Generator
     * SHALL return completion items for all target tables that share a FK relationship
     * with any source table, with FK-related items appearing before unrelated items,
     * and one item per distinct FK constraint.
     */

    it('FK-related items appear before unrelated items in the result', () => {
      fc.assert(
        fc.property(
          arbitrarySchema,
          arbitraryTableName,
          arbitrarySchema,
          arbitraryTableName,
          arbitrarySchema,
          arbitraryTableName,
          (sourceSchema, sourceTable, targetSchema, targetTable, unrelatedSchema, unrelatedTable) => {
            // Ensure distinct tables
            fc.pre(sourceTable.toLowerCase() !== targetTable.toLowerCase() ||
                   sourceSchema.toLowerCase() !== targetSchema.toLowerCase());
            fc.pre(targetTable.toLowerCase() !== unrelatedTable.toLowerCase() ||
                   targetSchema.toLowerCase() !== unrelatedSchema.toLowerCase());
            fc.pre(sourceTable.toLowerCase() !== unrelatedTable.toLowerCase() ||
                   sourceSchema.toLowerCase() !== unrelatedSchema.toLowerCase());

            const fk: ForeignKeyInfo = {
              constraintName: 'FK_Test',
              referencingSchema: sourceSchema,
              referencingTable: sourceTable,
              referencedSchema: targetSchema,
              referencedTable: targetTable,
              columnPairs: [{ referencingColumn: 'Col1', referencedColumn: 'Col2', ordinalPosition: 1 }],
            };

            const cache = createMockSchemaCache({
              tables: [
                { schema: sourceSchema, name: sourceTable, columns: [] },
                { schema: targetSchema, name: targetTable, columns: [] },
                { schema: unrelatedSchema, name: unrelatedTable, columns: [] },
              ],
              foreignKeys: [fk],
            });

            const context: JoinCompletionContext = {
              sourceTableRefs: [{ schema: sourceSchema, name: sourceTable }],
              existingAliases: [],
              prefix: '',
            };

            const result = getJoinCompletions(context, cache);

            // Find FK items and unrelated items
            const fkItems = result.items.filter(i => (i.detail || '').startsWith('FK'));
            const unrelatedItems = result.items.filter(i => !(i.detail || '').startsWith('FK'));

            // FK items should exist
            expect(fkItems.length).toBeGreaterThan(0);

            // If there are unrelated items, all FK items should come before them
            if (unrelatedItems.length > 0 && fkItems.length > 0) {
              const lastFkIndex = Math.max(...fkItems.map(fi => result.items.indexOf(fi)));
              const firstUnrelatedIndex = Math.min(...unrelatedItems.map(ui => result.items.indexOf(ui)));
              expect(lastFkIndex).toBeLessThan(firstUnrelatedIndex);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('produces one completion item per distinct target table (consolidating multiple FKs to same target)', () => {
      fc.assert(
        fc.property(
          arbitrarySchema,
          arbitraryTableName,
          fc.array(arbitraryForeignKey, { minLength: 1, maxLength: 5 }),
          (sourceSchema, sourceTable, fks) => {
            // Make all FKs reference from the source table
            const adjustedFks = fks.map((fk, i) => ({
              ...fk,
              constraintName: `FK_${i}_${fk.constraintName}`, // Ensure unique constraint names
              referencingSchema: sourceSchema,
              referencingTable: sourceTable,
            }));

            // Collect all target tables for the cache
            const allTables: TableInfo[] = [
              { schema: sourceSchema, name: sourceTable, columns: [] },
              ...adjustedFks.map(fk => ({ schema: fk.referencedSchema, name: fk.referencedTable, columns: [] })),
            ];

            const cache = createMockSchemaCache({
              tables: allTables,
              foreignKeys: adjustedFks,
            });

            const context: JoinCompletionContext = {
              sourceTableRefs: [{ schema: sourceSchema, name: sourceTable }],
              existingAliases: [],
              prefix: '',
            };

            const result = getJoinCompletions(context, cache);
            const fkItems = result.items.filter(i => (i.detail || '').startsWith('FK'));

            // Number of FK items should equal number of distinct target tables (case-insensitive).
            // Multiple FK constraints to the same target table are consolidated into one item
            // with AND-separated ON conditions (Bug 3 fix: never comma-delimit).
            const uniqueTargets = new Set(
              adjustedFks.map(fk => `${fk.referencedSchema}.${fk.referencedTable}`.toLowerCase())
            );
            expect(fkItems.length).toBe(uniqueTargets.size);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Feature: smart-join-generator, Property 6: Fallback to all tables when no FK relationships exist', () => {
    /**
     * Validates: Requirements 2.4, 3.6, 8.1
     *
     * For any schema cache where no foreign key relationships exist for the source tables,
     * the Join Generator SHALL return all tables and views as completion items without
     * ON clause generation.
     */

    it('returns all tables and views when no FK relationships exist', () => {
      fc.assert(
        fc.property(
          arbitrarySchema,
          arbitraryTableName,
          fc.array(
            fc.tuple(arbitrarySchema, arbitraryTableName),
            { minLength: 1, maxLength: 5 }
          ),
          fc.array(
            fc.tuple(arbitrarySchema, arbitraryTableName),
            { minLength: 0, maxLength: 3 }
          ),
          (sourceSchema, sourceTable, otherTables, views) => {
            const allTables: TableInfo[] = [
              { schema: sourceSchema, name: sourceTable, columns: [] },
              ...otherTables.map(([s, n]) => ({ schema: s, name: n, columns: [] })),
            ];
            const allViews: ViewInfo[] = views.map(([s, n]) => ({ schema: s, name: n, columns: [] }));

            const cache = createMockSchemaCache({
              tables: allTables,
              views: allViews,
              foreignKeys: [], // No FK relationships
            });

            const context: JoinCompletionContext = {
              sourceTableRefs: [{ schema: sourceSchema, name: sourceTable }],
              existingAliases: [],
              prefix: '',
            };

            const result = getJoinCompletions(context, cache);

            // Should return items for all tables + views
            expect(result.items.length).toBe(allTables.length + allViews.length);

            // No item should have an ON clause (no 'ON ' in insertText)
            for (const item of result.items) {
              expect((item.insertText as string)).not.toContain(' ON ');
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('fallback items do not contain ON clause', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(arbitrarySchema, arbitraryTableName),
            { minLength: 1, maxLength: 5 }
          ),
          (tables) => {
            const allTables: TableInfo[] = tables.map(([s, n]) => ({ schema: s, name: n, columns: [] }));

            const cache = createMockSchemaCache({
              tables: allTables,
              views: [],
              foreignKeys: [],
            });

            // No source tables (no FROM clause) → fallback
            const context: JoinCompletionContext = {
              sourceTableRefs: [],
              existingAliases: [],
              prefix: '',
            };

            const result = getJoinCompletions(context, cache);

            for (const item of result.items) {
              const text = item.insertText as string;
              expect(text).not.toContain(' ON ');
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Feature: smart-join-generator, Property 7: JOIN prefix filtering', () => {
    /**
     * Validates: Requirements 3.5
     *
     * For any typed prefix after a JOIN keyword, the Join Generator SHALL filter
     * suggested target tables by case-insensitive prefix match against the
     * schema-qualified table name, returning exactly those tables whose names
     * start with the prefix.
     */

    it('filters items by case-insensitive prefix match', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(arbitrarySchema, arbitraryTableName),
            { minLength: 2, maxLength: 8 }
          ),
          fc.integer({ min: 0, max: 4 }),
          (tables, prefixIdx) => {
            const allTables: TableInfo[] = tables.map(([s, n]) => ({ schema: s, name: n, columns: [] }));

            const cache = createMockSchemaCache({
              tables: allTables,
              views: [],
              foreignKeys: [],
            });

            // Pick a prefix from one of the table names
            const targetTable = allTables[prefixIdx % allTables.length];
            const fullLabel = `${targetTable.schema}.${targetTable.name}`;
            // Use first 1-3 chars of the table name as prefix
            const prefixLen = Math.min(3, targetTable.name.length);
            const prefix = targetTable.name.substring(0, prefixLen);

            const context: JoinCompletionContext = {
              sourceTableRefs: [],
              existingAliases: [],
              prefix,
            };

            const result = getJoinCompletions(context, cache);

            // All returned items should match the prefix (case-insensitive)
            const lowerPrefix = prefix.toLowerCase();
            for (const item of result.items) {
              const label = (item.label as string).toLowerCase();
              const dotIndex = label.indexOf('.');
              const tablePart = dotIndex >= 0 ? label.substring(dotIndex + 1) : label;
              // Either full label or table name part should start with prefix
              expect(
                label.startsWith(lowerPrefix) || tablePart.startsWith(lowerPrefix)
              ).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('filterByJoinPrefix is case-insensitive', () => {
      fc.assert(
        fc.property(
          arbitrarySchema,
          arbitraryTableName,
          (schema, tableName) => {
            fc.pre(tableName.length >= 2);

            const allTables: TableInfo[] = [{ schema, name: tableName, columns: [] }];
            const cache = createMockSchemaCache({ tables: allTables, views: [], foreignKeys: [] });

            const context: JoinCompletionContext = {
              sourceTableRefs: [],
              existingAliases: [],
              prefix: '',
            };

            const allItems = getJoinCompletions(context, cache).items;

            // Filter with uppercase prefix
            const upperPrefix = tableName.substring(0, 2).toUpperCase();
            const upperResult = filterByJoinPrefix(allItems, upperPrefix);

            // Filter with lowercase prefix
            const lowerPrefix = tableName.substring(0, 2).toLowerCase();
            const lowerResult = filterByJoinPrefix(allItems, lowerPrefix);

            // Both should return the same items
            expect(upperResult.length).toBe(lowerResult.length);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('empty prefix returns all items', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(arbitrarySchema, arbitraryTableName),
            { minLength: 1, maxLength: 5 }
          ),
          (tables) => {
            const allTables: TableInfo[] = tables.map(([s, n]) => ({ schema: s, name: n, columns: [] }));
            const cache = createMockSchemaCache({ tables: allTables, views: [], foreignKeys: [] });

            const context: JoinCompletionContext = {
              sourceTableRefs: [],
              existingAliases: [],
              prefix: '',
            };

            const result = getJoinCompletions(context, cache);
            expect(result.items.length).toBe(allTables.length);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Feature: smart-join-generator, Property 8: ON clause generation preserves all FK column pairs', () => {
    /**
     * Validates: Requirements 4.1, 4.2, 4.3
     *
     * For any foreign key relationship (single or composite), the generated ON clause
     * SHALL pair all FK columns with their referenced columns using AND operators,
     * in the ordinal position order defined by the constraint.
     */

    it('ON clause contains all column pairs joined with AND in ordinal order', () => {
      fc.assert(
        fc.property(
          arbitrarySchema,
          arbitraryTableName,
          arbitrarySchema,
          arbitraryTableName,
          fc.integer({ min: 1, max: 4 }),
          (srcSchema, srcTable, tgtSchema, tgtTable, pairCount) => {
            fc.pre(srcTable.toLowerCase() !== tgtTable.toLowerCase() ||
                   srcSchema.toLowerCase() !== tgtSchema.toLowerCase());

            const columnPairs = Array.from({ length: pairCount }, (_, i) => ({
              referencingColumn: `SrcCol${i + 1}`,
              referencedColumn: `TgtCol${i + 1}`,
              ordinalPosition: i + 1,
            }));

            const fk: ForeignKeyInfo = {
              constraintName: 'FK_Test',
              referencingSchema: srcSchema,
              referencingTable: srcTable,
              referencedSchema: tgtSchema,
              referencedTable: tgtTable,
              columnPairs,
            };

            const sourceRef: TableReference = { schema: srcSchema, name: srcTable, alias: 'src' };
            const sourceKey = `${srcSchema}.${srcTable}`.toLowerCase();

            const onClause = buildOnClause(fk, sourceRef, sourceKey, 'tgt');

            // Verify all column pairs are present
            for (let i = 0; i < pairCount; i++) {
              expect(onClause).toContain(`SrcCol${i + 1}`);
              expect(onClause).toContain(`TgtCol${i + 1}`);
            }

            // Verify AND count: composite FKs have (pairCount - 1) ANDs
            const andCount = (onClause.match(/ AND /g) || []).length;
            expect(andCount).toBe(pairCount - 1);

            // Verify ordinal order: SrcCol1 appears before SrcCol2, etc.
            for (let i = 0; i < pairCount - 1; i++) {
              const pos1 = onClause.indexOf(`SrcCol${i + 1}`);
              const pos2 = onClause.indexOf(`SrcCol${i + 2}`);
              expect(pos1).toBeLessThan(pos2);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('single-column FK produces ON clause without AND', () => {
      fc.assert(
        fc.property(
          arbitrarySchema,
          arbitraryTableName,
          arbitraryColumnName,
          arbitraryColumnName,
          (schema, table, srcCol, tgtCol) => {
            const fk: ForeignKeyInfo = {
              constraintName: 'FK_Single',
              referencingSchema: schema,
              referencingTable: table,
              referencedSchema: 'dbo',
              referencedTable: 'Target',
              columnPairs: [{ referencingColumn: srcCol, referencedColumn: tgtCol, ordinalPosition: 1 }],
            };

            const sourceRef: TableReference = { schema, name: table, alias: 'a' };
            const sourceKey = `${schema}.${table}`.toLowerCase();

            const onClause = buildOnClause(fk, sourceRef, sourceKey, 'b');

            expect(onClause).not.toContain(' AND ');
            expect(onClause).toContain(srcCol);
            expect(onClause).toContain(tgtCol);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Feature: smart-join-generator, Property 9: Source table reference resolution in ON clause', () => {
    /**
     * Validates: Requirements 4.4, 4.5, 7.3, 7.4
     *
     * For any source table, the ON clause SHALL use the source table's alias when one
     * exists in the query, or the schema-qualified table name when no alias is defined.
     */

    it('uses alias when source table has an alias', () => {
      fc.assert(
        fc.property(
          arbitrarySchema,
          arbitraryTableName,
          fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 1, maxLength: 5 }),
          arbitraryColumnName,
          arbitraryColumnName,
          (schema, table, alias, srcCol, tgtCol) => {
            const sourceRef: TableReference = { schema, name: table, alias };

            const result = formatSourceReference(sourceRef);
            expect(result).toBe(alias);

            // Also verify in buildOnClause
            const fk: ForeignKeyInfo = {
              constraintName: 'FK_Test',
              referencingSchema: schema,
              referencingTable: table,
              referencedSchema: 'dbo',
              referencedTable: 'Target',
              columnPairs: [{ referencingColumn: srcCol, referencedColumn: tgtCol, ordinalPosition: 1 }],
            };

            const sourceKey = `${schema}.${table}`.toLowerCase();
            const onClause = buildOnClause(fk, sourceRef, sourceKey, 'tgt');

            expect(onClause).toContain(`${alias}.${srcCol}`);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('uses schema-qualified name when source table has no alias', () => {
      fc.assert(
        fc.property(
          arbitrarySchema,
          arbitraryTableName,
          arbitraryColumnName,
          arbitraryColumnName,
          (schema, table, srcCol, tgtCol) => {
            const sourceRef: TableReference = { schema, name: table };

            const result = formatSourceReference(sourceRef);
            expect(result).toBe(`${schema}.${table}`);

            // Also verify in buildOnClause
            const fk: ForeignKeyInfo = {
              constraintName: 'FK_Test',
              referencingSchema: schema,
              referencingTable: table,
              referencedSchema: 'dbo',
              referencedTable: 'Target',
              columnPairs: [{ referencingColumn: srcCol, referencedColumn: tgtCol, ordinalPosition: 1 }],
            };

            const sourceKey = `${schema}.${table}`.toLowerCase();
            const onClause = buildOnClause(fk, sourceRef, sourceKey, 'tgt');

            expect(onClause).toContain(`${schema}.${table}.${srcCol}`);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('defaults to dbo schema when source has no schema specified and no alias', () => {
      fc.assert(
        fc.property(
          arbitraryTableName,
          (table) => {
            const sourceRef: TableReference = { name: table };

            const result = formatSourceReference(sourceRef);
            expect(result).toBe(`dbo.${table}`);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Feature: smart-join-generator, Property 12: Snippet tab stop structure', () => {
    /**
     * Validates: Requirements 6.1, 6.2, 6.3, 6.4
     *
     * For any join completion snippet, the output SHALL contain exactly one $1 tab stop
     * positioned on the alias and one $0 tab stop positioned after the ON clause
     * (or after the alias if no ON clause), and SHALL NOT repeat the JOIN keyword.
     */

    it('FK completion snippet has exactly one $1 and one $0', () => {
      fc.assert(
        fc.property(
          arbitrarySchema,
          arbitraryTableName,
          arbitrarySchema,
          arbitraryTableName,
          arbitraryColumnName,
          arbitraryColumnName,
          (srcSchema, srcTable, tgtSchema, tgtTable, srcCol, tgtCol) => {
            fc.pre(srcTable.toLowerCase() !== tgtTable.toLowerCase() ||
                   srcSchema.toLowerCase() !== tgtSchema.toLowerCase());

            const fk: ForeignKeyInfo = {
              constraintName: 'FK_Test',
              referencingSchema: srcSchema,
              referencingTable: srcTable,
              referencedSchema: tgtSchema,
              referencedTable: tgtTable,
              columnPairs: [{ referencingColumn: srcCol, referencedColumn: tgtCol, ordinalPosition: 1 }],
            };

            const cache = createMockSchemaCache({
              tables: [
                { schema: srcSchema, name: srcTable, columns: [] },
                { schema: tgtSchema, name: tgtTable, columns: [] },
              ],
              foreignKeys: [fk],
            });

            const context: JoinCompletionContext = {
              sourceTableRefs: [{ schema: srcSchema, name: srcTable }],
              existingAliases: [],
              prefix: '',
            };

            const result = getJoinCompletions(context, cache);
            const fkItems = result.items.filter(i => (i.detail || '').startsWith('FK'));

            for (const item of fkItems) {
              const text = item.insertText as string;

              // Count $1 occurrences (as ${1:...} patterns)
              const dollar1Matches = text.match(/\$\{1:[^}]+\}/g) || [];
              // There should be at least 2 occurrences of ${1:alias} - one for the alias position
              // and one or more in the ON clause referencing the alias
              expect(dollar1Matches.length).toBeGreaterThanOrEqual(2);

              // All ${1:...} should have the same placeholder value (the alias)
              const placeholders = dollar1Matches.map(m => m.replace(/\$\{1:([^}]+)\}/, '$1'));
              const uniquePlaceholders = new Set(placeholders);
              expect(uniquePlaceholders.size).toBe(1);

              // Exactly one $0 at the end
              const dollar0Count = (text.match(/\$0/g) || []).length;
              expect(dollar0Count).toBe(1);
              expect(text.endsWith('$0')).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('non-FK completion snippet has exactly one $1 and one $0', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(arbitrarySchema, arbitraryTableName),
            { minLength: 1, maxLength: 3 }
          ),
          (tables) => {
            const allTables: TableInfo[] = tables.map(([s, n]) => ({ schema: s, name: n, columns: [] }));

            const cache = createMockSchemaCache({
              tables: allTables,
              views: [],
              foreignKeys: [],
            });

            const context: JoinCompletionContext = {
              sourceTableRefs: [],
              existingAliases: [],
              prefix: '',
            };

            const result = getJoinCompletions(context, cache);

            for (const item of result.items) {
              const text = item.insertText as string;

              // Exactly one ${1:...} for the alias
              const dollar1Matches = text.match(/\$\{1:[^}]+\}/g) || [];
              expect(dollar1Matches.length).toBe(1);

              // Exactly one $0
              const dollar0Count = (text.match(/\$0/g) || []).length;
              expect(dollar0Count).toBe(1);
              expect(text.endsWith('$0')).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('snippet does not contain JOIN keyword', () => {
      fc.assert(
        fc.property(
          arbitrarySchema,
          arbitraryTableName,
          arbitrarySchema,
          arbitraryTableName,
          (srcSchema, srcTable, tgtSchema, tgtTable) => {
            fc.pre(srcTable.toLowerCase() !== tgtTable.toLowerCase() ||
                   srcSchema.toLowerCase() !== tgtSchema.toLowerCase());

            const fk: ForeignKeyInfo = {
              constraintName: 'FK_Test',
              referencingSchema: srcSchema,
              referencingTable: srcTable,
              referencedSchema: tgtSchema,
              referencedTable: tgtTable,
              columnPairs: [{ referencingColumn: 'Col1', referencedColumn: 'Col2', ordinalPosition: 1 }],
            };

            const cache = createMockSchemaCache({
              tables: [
                { schema: srcSchema, name: srcTable, columns: [] },
                { schema: tgtSchema, name: tgtTable, columns: [] },
              ],
              foreignKeys: [fk],
            });

            const context: JoinCompletionContext = {
              sourceTableRefs: [{ schema: srcSchema, name: srcTable }],
              existingAliases: [],
              prefix: '',
            };

            const result = getJoinCompletions(context, cache);

            for (const item of result.items) {
              const text = item.insertText as string;
              // Should not start with or contain JOIN keyword
              expect(text.toUpperCase()).not.toMatch(/^(INNER |LEFT |RIGHT |FULL |CROSS )?JOIN /);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Feature: smart-join-generator, Property 13: Schema qualification in generated text', () => {
    /**
     * Validates: Requirements 7.1, 7.2
     *
     * For any target table, the generated join text SHALL omit the schema prefix when
     * the schema is 'dbo' (case-insensitive) and SHALL include the schema prefix when
     * the schema is not 'dbo'.
     */

    it('omits schema prefix for dbo schema (case-insensitive)', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('dbo', 'DBO', 'Dbo', 'dBo', 'dbO'),
          arbitraryTableName,
          (schema, tableName) => {
            const result = formatTargetTableName(schema, tableName);
            expect(result).toBe(tableName);
            expect(result).not.toContain('.');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('includes schema prefix for non-dbo schema', () => {
      fc.assert(
        fc.property(
          arbitrarySchema.filter(s => s.toLowerCase() !== 'dbo'),
          arbitraryTableName,
          (schema, tableName) => {
            const result = formatTargetTableName(schema, tableName);
            expect(result).toBe(`${schema}.${tableName}`);
            expect(result).toContain('.');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('schema qualification is applied correctly in full completion items', () => {
      fc.assert(
        fc.property(
          arbitrarySchema.filter(s => s.toLowerCase() !== 'dbo'),
          arbitraryTableName,
          (nonDboSchema, tableName) => {
            // Non-dbo target table
            const fk: ForeignKeyInfo = {
              constraintName: 'FK_Test',
              referencingSchema: 'dbo',
              referencingTable: 'Source',
              referencedSchema: nonDboSchema,
              referencedTable: tableName,
              columnPairs: [{ referencingColumn: 'Col1', referencedColumn: 'Col2', ordinalPosition: 1 }],
            };

            const cache = createMockSchemaCache({
              tables: [
                { schema: 'dbo', name: 'Source', columns: [] },
                { schema: nonDboSchema, name: tableName, columns: [] },
              ],
              foreignKeys: [fk],
            });

            const context: JoinCompletionContext = {
              sourceTableRefs: [{ schema: 'dbo', name: 'Source' }],
              existingAliases: [],
              prefix: '',
            };

            const result = getJoinCompletions(context, cache);
            const fkItems = result.items.filter(i => (i.detail || '').startsWith('FK'));

            for (const item of fkItems) {
              const text = item.insertText as string;
              // Non-dbo schema should be included in the insert text
              expect(text).toContain(`${nonDboSchema}.${tableName}`);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('dbo schema is omitted in full completion items', () => {
      fc.assert(
        fc.property(
          arbitraryTableName,
          (tableName) => {
            fc.pre(tableName !== 'Source');

            const fk: ForeignKeyInfo = {
              constraintName: 'FK_Test',
              referencingSchema: 'dbo',
              referencingTable: 'Source',
              referencedSchema: 'dbo',
              referencedTable: tableName,
              columnPairs: [{ referencingColumn: 'Col1', referencedColumn: 'Col2', ordinalPosition: 1 }],
            };

            const cache = createMockSchemaCache({
              tables: [
                { schema: 'dbo', name: 'Source', columns: [] },
                { schema: 'dbo', name: tableName, columns: [] },
              ],
              foreignKeys: [fk],
            });

            const context: JoinCompletionContext = {
              sourceTableRefs: [{ schema: 'dbo', name: 'Source' }],
              existingAliases: [],
              prefix: '',
            };

            const result = getJoinCompletions(context, cache);
            const fkItems = result.items.filter(i => (i.detail || '').startsWith('FK'));

            for (const item of fkItems) {
              const text = item.insertText as string;
              // The insert text should start with just the table name (no dbo. prefix)
              expect(text.startsWith(tableName)).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Feature: smart-join-generator, Property 22: FK detail text in completion items', () => {
    /**
     * Validates: Requirements 3.4
     *
     * For any FK-related completion item, the detail text SHALL include the
     * relationship direction (referencing or referenced) and the foreign key column names.
     */

    it('detail text includes direction and column names for referencing direction', () => {
      fc.assert(
        fc.property(
          arbitrarySchema,
          arbitraryTableName,
          arbitrarySchema,
          arbitraryTableName,
          fc.array(
            fc.tuple(arbitraryColumnName, arbitraryColumnName),
            { minLength: 1, maxLength: 3 }
          ),
          (srcSchema, srcTable, tgtSchema, tgtTable, colPairs) => {
            fc.pre(srcTable.toLowerCase() !== tgtTable.toLowerCase() ||
                   srcSchema.toLowerCase() !== tgtSchema.toLowerCase());

            const columnPairs = colPairs.map(([refCol, refdCol], i) => ({
              referencingColumn: refCol,
              referencedColumn: refdCol,
              ordinalPosition: i + 1,
            }));

            // Source is referencing → target is referenced
            const fk: ForeignKeyInfo = {
              constraintName: 'FK_Test',
              referencingSchema: srcSchema,
              referencingTable: srcTable,
              referencedSchema: tgtSchema,
              referencedTable: tgtTable,
              columnPairs,
            };

            const cache = createMockSchemaCache({
              tables: [
                { schema: srcSchema, name: srcTable, columns: [] },
                { schema: tgtSchema, name: tgtTable, columns: [] },
              ],
              foreignKeys: [fk],
            });

            const context: JoinCompletionContext = {
              sourceTableRefs: [{ schema: srcSchema, name: srcTable }],
              existingAliases: [],
              prefix: '',
            };

            const result = getJoinCompletions(context, cache);
            const fkItems = result.items.filter(i => (i.detail || '').startsWith('FK'));

            expect(fkItems.length).toBeGreaterThan(0);

            for (const item of fkItems) {
              const detail = item.detail as string;
              // Should include direction
              expect(detail).toContain('referenced');
              // Should include column names
              for (const [refCol, refdCol] of colPairs) {
                expect(detail).toContain(refCol);
                expect(detail).toContain(refdCol);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('detail text includes direction and column names for referenced direction', () => {
      fc.assert(
        fc.property(
          arbitrarySchema,
          arbitraryTableName,
          arbitrarySchema,
          arbitraryTableName,
          arbitraryColumnName,
          arbitraryColumnName,
          (srcSchema, srcTable, tgtSchema, tgtTable, srcCol, tgtCol) => {
            fc.pre(srcTable.toLowerCase() !== tgtTable.toLowerCase() ||
                   srcSchema.toLowerCase() !== tgtSchema.toLowerCase());

            // Source is the referenced table → target is the referencing table
            const fk: ForeignKeyInfo = {
              constraintName: 'FK_Test',
              referencingSchema: tgtSchema,
              referencingTable: tgtTable,
              referencedSchema: srcSchema,
              referencedTable: srcTable,
              columnPairs: [{ referencingColumn: srcCol, referencedColumn: tgtCol, ordinalPosition: 1 }],
            };

            const cache = createMockSchemaCache({
              tables: [
                { schema: srcSchema, name: srcTable, columns: [] },
                { schema: tgtSchema, name: tgtTable, columns: [] },
              ],
              foreignKeys: [fk],
            });

            const context: JoinCompletionContext = {
              sourceTableRefs: [{ schema: srcSchema, name: srcTable }],
              existingAliases: [],
              prefix: '',
            };

            const result = getJoinCompletions(context, cache);
            const fkItems = result.items.filter(i => (i.detail || '').startsWith('FK'));

            expect(fkItems.length).toBeGreaterThan(0);

            for (const item of fkItems) {
              const detail = item.detail as string;
              // Should include direction
              expect(detail).toContain('referencing');
              // Should include column names
              expect(detail).toContain(srcCol);
              expect(detail).toContain(tgtCol);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('detail text always starts with FK prefix', () => {
      fc.assert(
        fc.property(
          arbitrarySchema,
          arbitraryTableName,
          arbitrarySchema,
          arbitraryTableName,
          (srcSchema, srcTable, tgtSchema, tgtTable) => {
            fc.pre(srcTable.toLowerCase() !== tgtTable.toLowerCase() ||
                   srcSchema.toLowerCase() !== tgtSchema.toLowerCase());

            const fk: ForeignKeyInfo = {
              constraintName: 'FK_Test',
              referencingSchema: srcSchema,
              referencingTable: srcTable,
              referencedSchema: tgtSchema,
              referencedTable: tgtTable,
              columnPairs: [{ referencingColumn: 'Col1', referencedColumn: 'Col2', ordinalPosition: 1 }],
            };

            const cache = createMockSchemaCache({
              tables: [
                { schema: srcSchema, name: srcTable, columns: [] },
                { schema: tgtSchema, name: tgtTable, columns: [] },
              ],
              foreignKeys: [fk],
            });

            const context: JoinCompletionContext = {
              sourceTableRefs: [{ schema: srcSchema, name: srcTable }],
              existingAliases: [],
              prefix: '',
            };

            const result = getJoinCompletions(context, cache);
            const fkItems = result.items.filter(i => (i.detail || '').startsWith('FK'));

            for (const item of fkItems) {
              expect(item.detail).toMatch(/^FK \(/);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
