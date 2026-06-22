import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { getCompletions, extractTableReferences } from '../../server/src/completionProvider';
import { ISchemaCache, TableInfo, ViewInfo, ProcedureInfo, ForeignKeyInfo, ColumnInfo } from '../../server/src/schemaCache';

/**
 * Property-based tests for alias-qualified column suggestions (Property 10)
 * Feature: query-scoped-intellisense, Property 10: Alias-qualified column suggestions
 *
 * Validates: Requirements 6.1, 6.2, 6.3
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
  // Exclude SQL keywords that would confuse the parser
  .filter((id) => !/^(select|from|where|join|inner|left|right|full|cross|on|order|group|having|exec|execute|insert|update|delete|create|alter|drop|begin|end|if|else|while|return|declare|set|union|all|except|intersect|into|values|as|and|or|not|in|exists|between|like|is|null|case|when|then|distinct|top|with|go|use|print|by)$/i.test(id));

/** Generator: random schema name */
const arbitrarySchemaName: fc.Arbitrary<string> = fc.constantFrom('dbo', 'sales', 'hr', 'admin', 'app');

/** Generator: a short alias (1-3 lowercase letters, not a keyword) */
const arbitraryAlias: fc.Arbitrary<string> = fc
  .stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    { minLength: 1, maxLength: 3 }
  )
  .filter((a) => !/^(as|on|in|or|is|if|go|by|to|do|no|set|top|not|all|and|end|for|add|use|asc|avg|bit|day|int|key|max|min|new|off|old|out|row|sum|try)$/i.test(a));

/** Generator: a column with a name and data type */
const arbitraryColumn: fc.Arbitrary<ColumnInfo> = fc
  .tuple(
    arbitraryIdentifier,
    fc.constantFrom('int', 'varchar', 'datetime', 'bit', 'decimal', 'nvarchar'),
    fc.boolean()
  )
  .map(([name, dataType, isNullable]) => ({ name, dataType, isNullable }));

/** Generator: a table with schema, name, and 1-3 columns with unique names */
const arbitraryTableWithColumns: fc.Arbitrary<TableInfo> = fc
  .tuple(
    arbitrarySchemaName,
    arbitraryIdentifier,
    fc.array(arbitraryColumn, { minLength: 1, maxLength: 3 })
  )
  .map(([schema, name, columns]) => {
    // Ensure column names are unique within the table
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
 * Creates a mock ISchemaCache containing the specified tables.
 */
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

/**
 * Generator: a WHERE context query with a mix of aliased and unaliased tables.
 * Returns the document text, cursor offset, schema cache, and expected behavior.
 */
const arbitraryAliasedWhereQuery: fc.Arbitrary<{
  documentText: string;
  cursorOffset: number;
  schemaCache: ISchemaCache;
  aliasedTables: Array<{ table: TableInfo; alias: string }>;
  unaliasedTables: TableInfo[];
}> = fc
  .tuple(
    // At least one aliased table
    fc.array(
      fc.tuple(arbitraryTableWithColumns, arbitraryAlias),
      { minLength: 1, maxLength: 2 }
    ),
    // Zero or more unaliased tables
    fc.array(arbitraryTableWithColumns, { minLength: 0, maxLength: 2 })
  )
  .filter(([aliasedPairs, unaliasedTables]) => {
    // Ensure all table names are unique
    const names = new Set<string>();
    for (const [table] of aliasedPairs) {
      const key = `${table.schema}.${table.name}`.toLowerCase();
      if (names.has(key)) return false;
      names.add(key);
    }
    for (const table of unaliasedTables) {
      const key = `${table.schema}.${table.name}`.toLowerCase();
      if (names.has(key)) return false;
      names.add(key);
    }
    // Ensure aliases are unique and don't conflict with table names
    const aliases = new Set<string>();
    for (const [table, alias] of aliasedPairs) {
      const aliasLower = alias.toLowerCase();
      if (aliases.has(aliasLower)) return false;
      aliases.add(aliasLower);
      // Alias shouldn't match any table name
      if (names.has(`dbo.${aliasLower}`) || names.has(`sales.${aliasLower}`)) return false;
    }
    return true;
  })
  .map(([aliasedPairs, unaliasedTables]) => {
    const allTables: TableInfo[] = [];
    const aliasedTables: Array<{ table: TableInfo; alias: string }> = [];

    // Build FROM clause parts
    const fromParts: string[] = [];

    for (const [table, alias] of aliasedPairs) {
      allTables.push(table);
      aliasedTables.push({ table, alias });
      fromParts.push(`${table.schema}.${table.name} ${alias}`);
    }

    for (const table of unaliasedTables) {
      allTables.push(table);
      fromParts.push(`${table.schema}.${table.name}`);
    }

    // Build the query with cursor in WHERE clause
    const query = `SELECT * FROM ${fromParts.join(', ')} WHERE `;
    const cursorOffset = query.length;

    const schemaCache = createMockSchemaCache(allTables);

    return {
      documentText: query,
      cursorOffset,
      schemaCache,
      aliasedTables,
      unaliasedTables,
    };
  });

// --- Tests ---

describe('Alias-Qualified Column Suggestions Property Tests', () => {
  describe('Property 10: Alias-qualified column suggestions', () => {
    /**
     * Validates: Requirements 6.1, 6.2, 6.3
     *
     * For any WHERE clause context with table references where at least one table
     * has an alias, columns from aliased tables SHALL be suggested with the format
     * `alias.ColumnName`, and columns from unaliased tables SHALL be suggested
     * without any qualifier prefix.
     */

    it('columns from aliased tables are suggested with alias.ColumnName format in WHERE context', () => {
      fc.assert(
        fc.property(arbitraryAliasedWhereQuery, ({ documentText, cursorOffset, schemaCache, aliasedTables }) => {
          const completions = getCompletions(documentText, cursorOffset, schemaCache, true);

          // Extract column completions (kind === Field = 5)
          const columnCompletions = completions.filter((c) => c.kind === 5);
          const completionLabels = new Set(
            columnCompletions.map((c) => (c.label as string))
          );

          // All columns from aliased tables should appear with alias.ColumnName format
          for (const { table, alias } of aliasedTables) {
            for (const col of table.columns) {
              const expectedLabel = `${alias}.${col.name}`;
              expect(completionLabels.has(expectedLabel)).toBe(true);
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    it('columns from unaliased tables are suggested without any qualifier prefix in WHERE context', () => {
      fc.assert(
        fc.property(arbitraryAliasedWhereQuery, ({ documentText, cursorOffset, schemaCache, unaliasedTables }) => {
          // Skip if there are no unaliased tables in this test case
          if (unaliasedTables.length === 0) return;

          const completions = getCompletions(documentText, cursorOffset, schemaCache, true);

          // Extract column completions (kind === Field = 5)
          const columnCompletions = completions.filter((c) => c.kind === 5);
          const completionLabels = new Set(
            columnCompletions.map((c) => (c.label as string))
          );

          // Columns from unaliased tables should appear without any prefix
          for (const table of unaliasedTables) {
            for (const col of table.columns) {
              // The label should be just the column name (no dot)
              expect(completionLabels.has(col.name)).toBe(true);
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    it('aliased table columns do NOT appear without the alias prefix in WHERE context', () => {
      fc.assert(
        fc.property(arbitraryAliasedWhereQuery, ({ documentText, cursorOffset, schemaCache, aliasedTables, unaliasedTables }) => {
          const completions = getCompletions(documentText, cursorOffset, schemaCache, true);

          // Extract column completions (kind === Field = 5)
          const columnCompletions = completions.filter((c) => c.kind === 5);
          const completionLabels = new Set(
            columnCompletions.map((c) => (c.label as string))
          );

          // Collect column names that are ONLY in aliased tables (not in unaliased)
          const unaliasedColumnNames = new Set(
            unaliasedTables.flatMap((t) => t.columns.map((c) => c.name.toLowerCase()))
          );

          for (const { table } of aliasedTables) {
            for (const col of table.columns) {
              // If this column name is unique to aliased tables (not in unaliased),
              // it should NOT appear as a bare name
              if (!unaliasedColumnNames.has(col.name.toLowerCase())) {
                expect(completionLabels.has(col.name)).toBe(false);
              }
            }
          }
        }),
        { numRuns: 100 }
      );
    });
  });
});
