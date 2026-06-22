import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { resolveAlias } from '../../server/src/aliasResolver';
import { TableReference } from '../../server/src/completionProvider';
import { ISchemaCache, TableInfo, ViewInfo, ProcedureInfo, ForeignKeyInfo, ColumnInfo } from '../../server/src/schemaCache';

/**
 * Property-based tests for Alias Scope Boundaries (Property 16)
 * Feature: next-iteration-features
 *
 * **Validates: Requirements 3.2**
 *
 * For any T-SQL query containing a subquery, aliases defined in the outer query
 * SHALL NOT be visible inside the subquery's WHERE clause, and aliases defined
 * inside the subquery SHALL NOT be visible in the outer query's WHERE clause.
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
  .filter((id) => !/^(select|from|where|join|inner|left|right|full|cross|on|order|group|having|exec|execute|insert|update|delete|create|alter|drop|begin|end|if|else|while|return|declare|set|union|all|except|intersect|into|values|as|and|or|not|in|exists|between|like|is|null|case|when|then|distinct|top|with|go|use|print|by)$/i.test(id));

/** Generator: random schema name */
const arbitrarySchemaName: fc.Arbitrary<string> = fc.constantFrom('dbo', 'sales', 'hr', 'admin', 'app');

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
const arbitraryTableWithColumns: fc.Arbitrary<TableInfo> = fc
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
 * Generator: a scenario with outer and inner (subquery) table references
 * that have distinct aliases, simulating scope boundaries.
 *
 * Returns:
 * - outerReferences: table references visible in the outer query scope
 * - innerReferences: table references visible in the subquery scope
 * - schemaCache: schema cache containing all tables
 * - outerAlias: an alias defined only in the outer scope
 * - innerAlias: an alias defined only in the inner (subquery) scope
 */
const arbitraryScopeBoundaryScenario: fc.Arbitrary<{
  outerReferences: TableReference[];
  innerReferences: TableReference[];
  schemaCache: ISchemaCache;
  outerAlias: string;
  innerAlias: string;
  outerTable: TableInfo;
  innerTable: TableInfo;
}> = fc
  .tuple(
    arbitraryTableWithColumns,
    arbitraryTableWithColumns,
    arbitraryAlias,
    arbitraryAlias
  )
  .filter(([outerTable, innerTable, outerAlias, innerAlias]) => {
    // Ensure aliases are different from each other
    if (outerAlias.toLowerCase() === innerAlias.toLowerCase()) return false;
    // Ensure table names are different
    if (outerTable.name.toLowerCase() === innerTable.name.toLowerCase() &&
        outerTable.schema.toLowerCase() === innerTable.schema.toLowerCase()) return false;
    // Ensure aliases don't match table names
    if (outerAlias.toLowerCase() === outerTable.name.toLowerCase()) return false;
    if (outerAlias.toLowerCase() === innerTable.name.toLowerCase()) return false;
    if (innerAlias.toLowerCase() === outerTable.name.toLowerCase()) return false;
    if (innerAlias.toLowerCase() === innerTable.name.toLowerCase()) return false;
    // Ensure aliases don't match ANY schema name in the scenario
    if (outerAlias.toLowerCase() === outerTable.schema.toLowerCase()) return false;
    if (outerAlias.toLowerCase() === innerTable.schema.toLowerCase()) return false;
    if (innerAlias.toLowerCase() === innerTable.schema.toLowerCase()) return false;
    if (innerAlias.toLowerCase() === outerTable.schema.toLowerCase()) return false;
    return true;
  })
  .map(([outerTable, innerTable, outerAlias, innerAlias]) => {
    const allTables = [outerTable, innerTable];
    const schemaCache = createMockSchemaCache(allTables);

    // Outer query references: only the outer table with its alias
    const outerReferences: TableReference[] = [
      { schema: outerTable.schema, name: outerTable.name, alias: outerAlias }
    ];

    // Inner (subquery) references: only the inner table with its alias
    const innerReferences: TableReference[] = [
      { schema: innerTable.schema, name: innerTable.name, alias: innerAlias }
    ];

    return {
      outerReferences,
      innerReferences,
      schemaCache,
      outerAlias,
      innerAlias,
      outerTable,
      innerTable,
    };
  });

/**
 * Generator: a scenario with multiple tables in both outer and inner scopes.
 */
const arbitraryMultiTableScopeBoundary: fc.Arbitrary<{
  outerReferences: TableReference[];
  innerReferences: TableReference[];
  schemaCache: ISchemaCache;
  outerAliases: string[];
  innerAliases: string[];
}> = fc
  .tuple(
    fc.array(fc.tuple(arbitraryTableWithColumns, arbitraryAlias), { minLength: 1, maxLength: 3 }),
    fc.array(fc.tuple(arbitraryTableWithColumns, arbitraryAlias), { minLength: 1, maxLength: 3 })
  )
  .filter(([outerPairs, innerPairs]) => {
    // Collect all aliases and ensure uniqueness across both scopes
    const allAliases = new Set<string>();
    const allTableKeys = new Set<string>();

    for (const [table, alias] of outerPairs) {
      const aliasLower = alias.toLowerCase();
      if (allAliases.has(aliasLower)) return false;
      allAliases.add(aliasLower);
      const tableKey = `${table.schema}.${table.name}`.toLowerCase();
      if (allTableKeys.has(tableKey)) return false;
      allTableKeys.add(tableKey);
      // Alias shouldn't match any schema name
      if (['dbo', 'sales', 'hr', 'admin', 'app'].includes(aliasLower)) return false;
    }

    for (const [table, alias] of innerPairs) {
      const aliasLower = alias.toLowerCase();
      if (allAliases.has(aliasLower)) return false;
      allAliases.add(aliasLower);
      const tableKey = `${table.schema}.${table.name}`.toLowerCase();
      if (allTableKeys.has(tableKey)) return false;
      allTableKeys.add(tableKey);
      if (['dbo', 'sales', 'hr', 'admin', 'app'].includes(aliasLower)) return false;
    }

    return true;
  })
  .map(([outerPairs, innerPairs]) => {
    const allTables = [
      ...outerPairs.map(([table]) => table),
      ...innerPairs.map(([table]) => table),
    ];
    const schemaCache = createMockSchemaCache(allTables);

    const outerReferences: TableReference[] = outerPairs.map(([table, alias]) => ({
      schema: table.schema,
      name: table.name,
      alias,
    }));

    const innerReferences: TableReference[] = innerPairs.map(([table, alias]) => ({
      schema: table.schema,
      name: table.name,
      alias,
    }));

    return {
      outerReferences,
      innerReferences,
      schemaCache,
      outerAliases: outerPairs.map(([, alias]) => alias),
      innerAliases: innerPairs.map(([, alias]) => alias),
    };
  });

// --- Tests ---

describe('Alias Scope Boundaries Property Tests', () => {
  describe('Feature: next-iteration-features, Property 16: Alias scope boundaries', () => {
    /**
     * **Validates: Requirements 3.2**
     *
     * For any T-SQL query containing a subquery, aliases defined in the outer
     * query SHALL NOT be visible inside the subquery's WHERE clause, and aliases
     * defined inside the subquery SHALL NOT be visible in the outer query's
     * WHERE clause.
     */

    it('outer alias is NOT visible when resolving in the inner (subquery) scope', () => {
      fc.assert(
        fc.property(arbitraryScopeBoundaryScenario, ({
          innerReferences,
          schemaCache,
          outerAlias,
        }) => {
          // When resolving the outer alias using only the inner scope's references,
          // it should NOT be found (scope boundary enforced)
          const result = resolveAlias(
            outerAlias,
            innerReferences,
            new Map(),
            schemaCache
          );

          expect(result.found).toBe(false);
          expect(result.isSchemaName).toBe(false);
          expect(result.columns).toHaveLength(0);
        }),
        { numRuns: 100 }
      );
    });

    it('inner (subquery) alias is NOT visible when resolving in the outer scope', () => {
      fc.assert(
        fc.property(arbitraryScopeBoundaryScenario, ({
          outerReferences,
          schemaCache,
          innerAlias,
        }) => {
          // When resolving the inner alias using only the outer scope's references,
          // it should NOT be found (scope boundary enforced)
          const result = resolveAlias(
            innerAlias,
            outerReferences,
            new Map(),
            schemaCache
          );

          expect(result.found).toBe(false);
          expect(result.isSchemaName).toBe(false);
          expect(result.columns).toHaveLength(0);
        }),
        { numRuns: 100 }
      );
    });

    it('outer alias resolves correctly within its own scope', () => {
      fc.assert(
        fc.property(arbitraryScopeBoundaryScenario, ({
          outerReferences,
          schemaCache,
          outerAlias,
          outerTable,
        }) => {
          // When resolving the outer alias using the outer scope's references,
          // it SHOULD be found with the correct columns
          const result = resolveAlias(
            outerAlias,
            outerReferences,
            new Map(),
            schemaCache
          );

          expect(result.found).toBe(true);
          expect(result.isSchemaName).toBe(false);
          expect(result.columns.length).toBe(outerTable.columns.length);

          // Verify column names match
          const expectedNames = new Set(outerTable.columns.map(c => c.name.toLowerCase()));
          const actualNames = new Set(result.columns.map(c => c.name.toLowerCase()));
          expect(actualNames).toEqual(expectedNames);
        }),
        { numRuns: 100 }
      );
    });

    it('inner alias resolves correctly within its own scope', () => {
      fc.assert(
        fc.property(arbitraryScopeBoundaryScenario, ({
          innerReferences,
          schemaCache,
          innerAlias,
          innerTable,
        }) => {
          // When resolving the inner alias using the inner scope's references,
          // it SHOULD be found with the correct columns
          const result = resolveAlias(
            innerAlias,
            innerReferences,
            new Map(),
            schemaCache
          );

          expect(result.found).toBe(true);
          expect(result.isSchemaName).toBe(false);
          expect(result.columns.length).toBe(innerTable.columns.length);

          // Verify column names match
          const expectedNames = new Set(innerTable.columns.map(c => c.name.toLowerCase()));
          const actualNames = new Set(result.columns.map(c => c.name.toLowerCase()));
          expect(actualNames).toEqual(expectedNames);
        }),
        { numRuns: 100 }
      );
    });

    it('no inner alias is visible in the outer scope (multi-table scenario)', () => {
      fc.assert(
        fc.property(arbitraryMultiTableScopeBoundary, ({
          outerReferences,
          schemaCache,
          innerAliases,
        }) => {
          // None of the inner aliases should resolve when using outer references
          for (const innerAlias of innerAliases) {
            const result = resolveAlias(
              innerAlias,
              outerReferences,
              new Map(),
              schemaCache
            );

            expect(result.found).toBe(false);
            expect(result.isSchemaName).toBe(false);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('no outer alias is visible in the inner scope (multi-table scenario)', () => {
      fc.assert(
        fc.property(arbitraryMultiTableScopeBoundary, ({
          innerReferences,
          schemaCache,
          outerAliases,
        }) => {
          // None of the outer aliases should resolve when using inner references
          for (const outerAlias of outerAliases) {
            const result = resolveAlias(
              outerAlias,
              innerReferences,
              new Map(),
              schemaCache
            );

            expect(result.found).toBe(false);
            expect(result.isSchemaName).toBe(false);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('CTE aliases in outer scope are not visible in inner scope', () => {
      fc.assert(
        fc.property(
          arbitraryScopeBoundaryScenario,
          fc.array(arbitraryColumn, { minLength: 1, maxLength: 3 }),
          ({
            innerReferences,
            schemaCache,
          }, cteColumns) => {
            // Create a CTE that exists in the outer scope
            const cteName = 'outercte';
            const outerCteColumns = new Map<string, ColumnInfo[]>();
            outerCteColumns.set(cteName, cteColumns);

            // When resolving the CTE alias using the inner scope's references
            // and an EMPTY CTE map (inner scope doesn't have the CTE),
            // it should NOT be found
            const result = resolveAlias(
              cteName,
              innerReferences,
              new Map(), // inner scope has no CTEs
              schemaCache
            );

            expect(result.found).toBe(false);
            expect(result.isSchemaName).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
