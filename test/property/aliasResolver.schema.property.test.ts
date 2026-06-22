import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { resolveAlias } from '../../server/src/aliasResolver';
import { TableReference } from '../../server/src/completionProvider';
import { ISchemaCache, TableInfo, ViewInfo, ProcedureInfo, ForeignKeyInfo, ColumnInfo } from '../../server/src/schemaCache';

/**
 * Property-based tests for schema name fallthrough (Property 19)
 * Feature: next-iteration-features, Property 19: Schema name fallthrough
 *
 * **Validates: Requirements 3.9**
 *
 * For any T-SQL query where the typed prefix before the dot matches a schema name
 * present in the schema cache (and does not match any defined table alias), the
 * completion provider SHALL return table/view completions for that schema rather
 * than column completions.
 */

// --- Generators ---

/** Generator: random valid SQL identifier (starts with letter, alphanumeric) */
const arbitraryIdentifier: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')),
      { minLength: 1, maxLength: 8 }
    )
  )
  .map(([first, rest]) => first + rest)
  .filter((id) => !/^(select|from|where|join|inner|left|right|full|cross|on|order|group|having|exec|execute|insert|update|delete|create|alter|drop|begin|end|if|else|while|return|declare|set|union|all|except|intersect|into|values|as|and|or|not|in|exists|between|like|is|null|case|when|then|distinct|top|with|go|use|print|by|dbo)$/i.test(id));

/** Generator: a schema name that is distinct from common keywords */
const arbitrarySchemaName: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')),
      { minLength: 2, maxLength: 8 }
    )
  )
  .map(([first, rest]) => first + rest)
  .filter((id) => !/^(select|from|where|join|inner|left|right|full|cross|on|order|group|having|exec|execute|insert|update|delete|create|alter|drop|begin|end|if|else|while|return|declare|set|union|all|except|intersect|into|values|as|and|or|not|in|exists|between|like|is|null|case|when|then|distinct|top|with|go|use|print|by)$/i.test(id));

/** Generator: a short alias (1-3 lowercase letters, not a keyword) */
const arbitraryAlias: fc.Arbitrary<string> = fc
  .stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    { minLength: 1, maxLength: 3 }
  )
  .filter((a) => !/^(as|on|in|or|is|if|go|by|to|do|no)$/i.test(a));

/** Generator: a column with a name and data type */
const arbitraryColumn: fc.Arbitrary<ColumnInfo> = fc
  .tuple(
    arbitraryIdentifier,
    fc.constantFrom('int', 'varchar', 'datetime', 'bit', 'decimal', 'nvarchar'),
    fc.boolean()
  )
  .map(([name, dataType, isNullable]) => ({ name, dataType, isNullable }));

/** Generator: a table with schema, name, and 1-3 columns with unique names */
const arbitraryTable: fc.Arbitrary<TableInfo> = fc
  .tuple(
    arbitrarySchemaName,
    arbitraryIdentifier,
    fc.array(arbitraryColumn, { minLength: 1, maxLength: 3 })
  )
  .map(([schema, name, columns]) => {
    const seen = new Set<string>();
    const uniqueColumns = columns.filter((col) => {
      const key = col.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { schema, name, columns: uniqueColumns };
  });

/** Generator: a view with schema, name, and 1-3 columns with unique names */
const arbitraryView: fc.Arbitrary<ViewInfo> = fc
  .tuple(
    arbitrarySchemaName,
    arbitraryIdentifier,
    fc.array(arbitraryColumn, { minLength: 1, maxLength: 3 })
  )
  .map(([schema, name, columns]) => {
    const seen = new Set<string>();
    const uniqueColumns = columns.filter((col) => {
      const key = col.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { schema, name, columns: uniqueColumns };
  });

/**
 * Creates a mock ISchemaCache containing the specified tables and views.
 */
function createMockSchemaCache(tables: TableInfo[], views: ViewInfo[] = []): ISchemaCache {
  return {
    tables,
    views,
    procedures: [] as ProcedureInfo[],
    foreignKeys: [] as ForeignKeyInfo[],
    isPopulating: false,
    refresh: async () => {},
    getForeignKeysForTable: () => [],
  };
}

// --- Tests ---

describe('Schema Name Fallthrough Property Tests', () => {
  describe('Property 19: Schema name fallthrough', () => {
    /**
     * **Validates: Requirements 3.9**
     *
     * For any T-SQL query where the typed prefix before the dot matches a schema
     * name present in the schema cache (and does not match any defined table alias),
     * the resolveAlias function SHALL return isSchemaName: true and found: false,
     * indicating the completion provider should fall through to schema-qualified
     * table/view completions.
     */

    it('prefix matching a schema name (not an alias) returns schema resolution type', () => {
      fc.assert(
        fc.property(
          // Generate tables with a known schema, plus table references with aliases that differ from the schema
          fc.tuple(
            fc.array(arbitraryTable, { minLength: 1, maxLength: 4 }),
            fc.array(arbitraryView, { minLength: 0, maxLength: 2 }),
            fc.array(
              fc.tuple(arbitraryIdentifier, arbitraryAlias),
              { minLength: 0, maxLength: 3 }
            )
          ),
          ([tables, views, aliasedRefs]) => {
            // Pick a schema name from the tables/views in the cache
            const allSchemas = new Set<string>();
            for (const t of tables) allSchemas.add(t.schema.toLowerCase());
            for (const v of views) allSchemas.add(v.schema.toLowerCase());

            const schemaNames = Array.from(allSchemas);
            if (schemaNames.length === 0) return; // skip degenerate case

            const targetSchema = schemaNames[0];

            // Build table references where aliases do NOT match the target schema
            const tableReferences: TableReference[] = aliasedRefs
              .filter(([_, alias]) => alias.toLowerCase() !== targetSchema)
              .map(([name, alias]) => ({ name, alias }));

            const schemaCache = createMockSchemaCache(tables, views);
            const cteColumns = new Map<string, ColumnInfo[]>();

            // Call resolveAlias with the schema name as the prefix
            const result = resolveAlias(targetSchema, tableReferences, cteColumns, schemaCache);

            // Assert: should indicate schema name fallthrough
            expect(result.isSchemaName).toBe(true);
            expect(result.found).toBe(false);
            expect(result.columns).toEqual([]);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('prefix matching a schema name is case-insensitive', () => {
      fc.assert(
        fc.property(
          fc.tuple(
            arbitrarySchemaName,
            fc.array(arbitraryTable, { minLength: 1, maxLength: 3 })
          ),
          ([schemaName, baseTables]) => {
            // Ensure at least one table uses the generated schema name
            const tables: TableInfo[] = [
              { schema: schemaName, name: 'TestTable', columns: [{ name: 'Id', dataType: 'int', isNullable: false }] },
              ...baseTables,
            ];

            const schemaCache = createMockSchemaCache(tables);
            const tableReferences: TableReference[] = [];
            const cteColumns = new Map<string, ColumnInfo[]>();

            // Try with different casings of the schema name
            const upperCase = schemaName.toUpperCase();
            const mixedCase = schemaName.charAt(0).toUpperCase() + schemaName.slice(1).toLowerCase();

            const resultLower = resolveAlias(schemaName.toLowerCase(), tableReferences, cteColumns, schemaCache);
            const resultUpper = resolveAlias(upperCase, tableReferences, cteColumns, schemaCache);
            const resultMixed = resolveAlias(mixedCase, tableReferences, cteColumns, schemaCache);

            // All casings should resolve as schema name
            expect(resultLower.isSchemaName).toBe(true);
            expect(resultUpper.isSchemaName).toBe(true);
            expect(resultMixed.isSchemaName).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('alias takes priority over schema name when both match', () => {
      fc.assert(
        fc.property(
          fc.tuple(
            arbitrarySchemaName,
            arbitraryIdentifier,
            fc.array(arbitraryColumn, { minLength: 1, maxLength: 3 })
          ),
          ([schemaName, tableName, columns]) => {
            // Create a table in the schema
            const table: TableInfo = { schema: schemaName, name: tableName, columns };
            const schemaCache = createMockSchemaCache([table]);

            // Create a table reference where the alias IS the schema name
            // This means the alias should take priority
            const tableReferences: TableReference[] = [
              { schema: 'dbo', name: tableName, alias: schemaName },
            ];

            // Also add a dbo table so the alias can resolve
            const dboTable: TableInfo = {
              schema: 'dbo',
              name: tableName,
              columns,
            };
            const cacheWithDbo = createMockSchemaCache([table, dboTable]);

            const cteColumns = new Map<string, ColumnInfo[]>();

            const result = resolveAlias(schemaName, tableReferences, cteColumns, cacheWithDbo);

            // Alias match takes priority — should be found as alias, not schema
            expect(result.found).toBe(true);
            expect(result.isSchemaName).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('prefix not matching any alias or schema returns empty with no schema flag', () => {
      fc.assert(
        fc.property(
          fc.tuple(
            fc.array(arbitraryTable, { minLength: 1, maxLength: 3 }),
            arbitraryIdentifier
          ),
          ([tables, unknownPrefix]) => {
            // Ensure the unknown prefix doesn't match any schema in the cache
            const allSchemas = new Set(tables.map(t => t.schema.toLowerCase()));
            if (allSchemas.has(unknownPrefix.toLowerCase())) return; // skip if collision

            const schemaCache = createMockSchemaCache(tables);
            const tableReferences: TableReference[] = [];
            const cteColumns = new Map<string, ColumnInfo[]>();

            const result = resolveAlias(unknownPrefix, tableReferences, cteColumns, schemaCache);

            // Should not be found and not be a schema name
            expect(result.found).toBe(false);
            expect(result.isSchemaName).toBe(false);
            expect(result.columns).toEqual([]);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('schema name from views also triggers fallthrough', () => {
      fc.assert(
        fc.property(
          fc.tuple(
            arbitrarySchemaName,
            arbitraryIdentifier,
            fc.array(arbitraryColumn, { minLength: 1, maxLength: 3 })
          ),
          ([schemaName, viewName, columns]) => {
            // Only views in the cache, no tables with this schema
            const view: ViewInfo = { schema: schemaName, name: viewName, columns };
            const schemaCache = createMockSchemaCache([], [view]);

            const tableReferences: TableReference[] = [];
            const cteColumns = new Map<string, ColumnInfo[]>();

            const result = resolveAlias(schemaName, tableReferences, cteColumns, schemaCache);

            // Should detect schema name from views too
            expect(result.isSchemaName).toBe(true);
            expect(result.found).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
