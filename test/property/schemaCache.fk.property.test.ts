import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { SchemaCache, ForeignKeyInfo, ForeignKeyColumnPair } from '../../server/src/schemaCache';

/**
 * Property-based tests for SchemaCache FK metadata storage (Properties 1, 2)
 * Feature: smart-join-generator
 *
 * Validates: Requirements 1.2, 1.3, 1.4
 */

// --- Generators ---

/** Generator: random valid SQL identifier */
const arbitraryIdentifier: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')),
      { minLength: 1, maxLength: 15 }
    )
  )
  .map(([first, rest]) => first + rest);

/** Generator: random schema name */
const arbitrarySchemaName: fc.Arbitrary<string> = fc.constantFrom(
  'dbo', 'sales', 'hr', 'admin', 'app', 'staging', 'inventory', 'auth'
);

/** Generator: random constraint name */
const arbitraryConstraintName: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom('FK_', 'fk_', 'FK'), arbitraryIdentifier)
  .map(([prefix, name]) => `${prefix}${name}`);

/** Generator: a single ForeignKeyColumnPair */
const arbitraryColumnPair = (ordinal: number): fc.Arbitrary<ForeignKeyColumnPair> =>
  fc.record({
    referencingColumn: arbitraryIdentifier,
    referencedColumn: arbitraryIdentifier,
    ordinalPosition: fc.constant(ordinal),
  });

/** Generator: array of column pairs with sequential ordinal positions (1-based) */
const arbitraryColumnPairs: fc.Arbitrary<ForeignKeyColumnPair[]> = fc
  .integer({ min: 1, max: 5 })
  .chain((count) => {
    const pairArbs = Array.from({ length: count }, (_, i) => arbitraryColumnPair(i + 1));
    return fc.tuple(...(pairArbs as [fc.Arbitrary<ForeignKeyColumnPair>, ...fc.Arbitrary<ForeignKeyColumnPair>[]]));
  })
  .map((pairs) => pairs as unknown as ForeignKeyColumnPair[]);

/** Generator: a single ForeignKeyInfo record */
const arbitraryForeignKeyInfo: fc.Arbitrary<ForeignKeyInfo> = fc.record({
  constraintName: arbitraryConstraintName,
  referencingSchema: arbitrarySchemaName,
  referencingTable: arbitraryIdentifier,
  referencedSchema: arbitrarySchemaName,
  referencedTable: arbitraryIdentifier,
  columnPairs: arbitraryColumnPairs,
});

/** Generator: array of FK records with unique constraint names */
const arbitraryForeignKeyList: fc.Arbitrary<ForeignKeyInfo[]> = fc
  .array(arbitraryForeignKeyInfo, { minLength: 1, maxLength: 8 })
  .map((fks) => {
    // Ensure unique constraint names
    const seen = new Set<string>();
    return fks.filter((fk) => {
      if (seen.has(fk.constraintName)) return false;
      seen.add(fk.constraintName);
      return true;
    });
  })
  .filter((fks) => fks.length > 0);

// --- Helpers ---

/**
 * Populate a SchemaCache with FK data by simulating what parseForeignKeys + buildForeignKeyIndex do.
 * We access private fields via (cache as any) since refresh() requires a real DB connection.
 */
function populateCacheWithFKs(cache: SchemaCache, fkList: ForeignKeyInfo[]): void {
  // Sort column pairs by ordinal position (as parseForeignKeys does)
  const normalizedList = fkList.map((fk) => ({
    ...fk,
    columnPairs: [...fk.columnPairs].sort((a, b) => a.ordinalPosition - b.ordinalPosition),
  }));

  // Set the foreignKeyList
  (cache as any).snapshot.foreignKeyList = normalizedList;

  // Build the index (same logic as buildForeignKeyIndex)
  const index = new Map<string, ForeignKeyInfo[]>();
  for (const fk of normalizedList) {
    const referencingKey = `${fk.referencingSchema}.${fk.referencingTable}`.toLowerCase();
    const referencedKey = `${fk.referencedSchema}.${fk.referencedTable}`.toLowerCase();

    if (!index.has(referencingKey)) {
      index.set(referencingKey, []);
    }
    index.get(referencingKey)!.push(fk);

    if (!index.has(referencedKey)) {
      index.set(referencedKey, []);
    }
    index.get(referencedKey)!.push(fk);
  }

  (cache as any).snapshot.foreignKeyIndex = index;
}

/**
 * Simulate the full parseForeignKeys + buildForeignKeyIndex pipeline
 * by converting ForeignKeyInfo[] into raw query rows and calling the private methods.
 */
function populateCacheViaParsePipeline(cache: SchemaCache, fkList: ForeignKeyInfo[]): void {
  // Convert ForeignKeyInfo[] into raw rows (as returned by the SQL query)
  const rows: any[] = [];
  for (const fk of fkList) {
    for (const pair of fk.columnPairs) {
      rows.push({
        constraint_name: fk.constraintName,
        referencing_schema: fk.referencingSchema,
        referencing_table: fk.referencingTable,
        referencing_column: pair.referencingColumn,
        referenced_schema: fk.referencedSchema,
        referenced_table: fk.referencedTable,
        referenced_column: pair.referencedColumn,
        ordinal_position: pair.ordinalPosition,
      });
    }
  }

  // Shuffle rows to simulate non-ordered DB results
  // (parseForeignKeys should still produce correct ordinal order)
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }

  // Call the private parseForeignKeys method
  const parsedList: ForeignKeyInfo[] = (cache as any).parseForeignKeys(rows);
  const index = (cache as any).buildForeignKeyIndex(parsedList);

  (cache as any).snapshot.foreignKeyList = parsedList;
  (cache as any).snapshot.foreignKeyIndex = index;
}

// --- Tests ---

describe('SchemaCache FK Property Tests', () => {
  describe('Feature: smart-join-generator, Property 1: FK metadata round-trip preservation', () => {
    /**
     * Validates: Requirements 1.2, 1.3
     *
     * For any set of FK relationships, after cache population, all fields are
     * stored intact (constraint name, referencing schema/table, referenced
     * schema/table, column pairs) and composite keys have column pairs in
     * ordinal order.
     */

    it('all FK fields are preserved after cache population via parse pipeline', () => {
      fc.assert(
        fc.property(arbitraryForeignKeyList, (fkList) => {
          const cache = new SchemaCache();
          populateCacheViaParsePipeline(cache, fkList);

          const stored = cache.foreignKeys;

          // Same number of FK records
          expect(stored.length).toBe(fkList.length);

          // Each FK should be present with all fields intact
          for (const originalFk of fkList) {
            const match = stored.find((s) => s.constraintName === originalFk.constraintName);
            expect(match).toBeDefined();
            expect(match!.referencingSchema).toBe(originalFk.referencingSchema);
            expect(match!.referencingTable).toBe(originalFk.referencingTable);
            expect(match!.referencedSchema).toBe(originalFk.referencedSchema);
            expect(match!.referencedTable).toBe(originalFk.referencedTable);

            // Column pairs should have same count
            expect(match!.columnPairs.length).toBe(originalFk.columnPairs.length);

            // Column pairs should be in ordinal order
            for (let i = 0; i < match!.columnPairs.length; i++) {
              if (i > 0) {
                expect(match!.columnPairs[i].ordinalPosition)
                  .toBeGreaterThan(match!.columnPairs[i - 1].ordinalPosition);
              }
            }

            // Each column pair should have matching data
            const sortedOriginal = [...originalFk.columnPairs].sort(
              (a, b) => a.ordinalPosition - b.ordinalPosition
            );
            for (let i = 0; i < match!.columnPairs.length; i++) {
              expect(match!.columnPairs[i].referencingColumn).toBe(sortedOriginal[i].referencingColumn);
              expect(match!.columnPairs[i].referencedColumn).toBe(sortedOriginal[i].referencedColumn);
              expect(match!.columnPairs[i].ordinalPosition).toBe(sortedOriginal[i].ordinalPosition);
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    it('composite keys have column pairs sorted by ordinal position', () => {
      fc.assert(
        fc.property(arbitraryForeignKeyList, (fkList) => {
          const cache = new SchemaCache();
          populateCacheViaParsePipeline(cache, fkList);

          const stored = cache.foreignKeys;

          for (const fk of stored) {
            // Verify ordinal positions are strictly increasing
            for (let i = 1; i < fk.columnPairs.length; i++) {
              expect(fk.columnPairs[i].ordinalPosition)
                .toBeGreaterThan(fk.columnPairs[i - 1].ordinalPosition);
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    it('foreignKeys getter returns the full list of stored FKs', () => {
      fc.assert(
        fc.property(arbitraryForeignKeyList, (fkList) => {
          const cache = new SchemaCache();
          populateCacheWithFKs(cache, fkList);

          const stored = cache.foreignKeys;
          expect(stored.length).toBe(fkList.length);

          // Verify constraint names match
          const storedNames = new Set(stored.map((fk) => fk.constraintName));
          for (const fk of fkList) {
            expect(storedNames.has(fk.constraintName)).toBe(true);
          }
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Feature: smart-join-generator, Property 2: FK lookup returns all relationships for a table', () => {
    /**
     * Validates: Requirements 1.4
     *
     * For any table name and schema, getForeignKeysForTable returns exactly
     * those ForeignKeyInfo records where the table is either the referencing
     * or referenced table, and returns an empty array when no matching records exist.
     */

    it('returns all FKs where the table is referencing or referenced', () => {
      fc.assert(
        fc.property(arbitraryForeignKeyList, (fkList) => {
          const cache = new SchemaCache();
          populateCacheWithFKs(cache, fkList);

          // For each FK, check that both the referencing and referenced tables can find it
          for (const fk of fkList) {
            const referencingResult = cache.getForeignKeysForTable(
              fk.referencingSchema,
              fk.referencingTable
            );
            const referencedResult = cache.getForeignKeysForTable(
              fk.referencedSchema,
              fk.referencedTable
            );

            // The FK should appear in the results for the referencing table
            expect(
              referencingResult.some((r) => r.constraintName === fk.constraintName)
            ).toBe(true);

            // The FK should appear in the results for the referenced table
            expect(
              referencedResult.some((r) => r.constraintName === fk.constraintName)
            ).toBe(true);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('returns exactly the correct set of FKs for each table (no extras)', () => {
      fc.assert(
        fc.property(arbitraryForeignKeyList, (fkList) => {
          const cache = new SchemaCache();
          populateCacheWithFKs(cache, fkList);

          // Collect all unique table keys from the FK list
          const tableKeys = new Set<string>();
          for (const fk of fkList) {
            tableKeys.add(`${fk.referencingSchema}.${fk.referencingTable}`.toLowerCase());
            tableKeys.add(`${fk.referencedSchema}.${fk.referencedTable}`.toLowerCase());
          }

          // For each table, verify the result set is exactly correct
          for (const tableKey of tableKeys) {
            const [schema, tableName] = tableKey.split('.');
            const result = cache.getForeignKeysForTable(schema, tableName);

            // Compute expected: all FKs where this table is referencing OR referenced
            const expected = fkList.filter((fk) => {
              const refKey = `${fk.referencingSchema}.${fk.referencingTable}`.toLowerCase();
              const recdKey = `${fk.referencedSchema}.${fk.referencedTable}`.toLowerCase();
              return refKey === tableKey || recdKey === tableKey;
            });

            // Same count
            expect(result.length).toBe(expected.length);

            // Same constraint names
            const resultNames = new Set(result.map((r) => r.constraintName));
            for (const exp of expected) {
              expect(resultNames.has(exp.constraintName)).toBe(true);
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    it('returns empty array for tables with no FK relationships', () => {
      fc.assert(
        fc.property(
          arbitraryForeignKeyList,
          arbitrarySchemaName,
          arbitraryIdentifier,
          (fkList, schema, tableName) => {
            const cache = new SchemaCache();
            populateCacheWithFKs(cache, fkList);

            // Generate a table key that is NOT in any FK relationship
            const lookupKey = `${schema}.${tableName}`.toLowerCase();
            const isInFKs = fkList.some((fk) => {
              const refKey = `${fk.referencingSchema}.${fk.referencingTable}`.toLowerCase();
              const recdKey = `${fk.referencedSchema}.${fk.referencedTable}`.toLowerCase();
              return refKey === lookupKey || recdKey === lookupKey;
            });

            if (!isInFKs) {
              const result = cache.getForeignKeysForTable(schema, tableName);
              expect(result).toEqual([]);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('lookup is case-insensitive', () => {
      fc.assert(
        fc.property(arbitraryForeignKeyList, (fkList) => {
          const cache = new SchemaCache();
          populateCacheWithFKs(cache, fkList);

          // Pick the first FK and look up with different cases
          const fk = fkList[0];

          const resultLower = cache.getForeignKeysForTable(
            fk.referencingSchema.toLowerCase(),
            fk.referencingTable.toLowerCase()
          );
          const resultUpper = cache.getForeignKeysForTable(
            fk.referencingSchema.toUpperCase(),
            fk.referencingTable.toUpperCase()
          );
          const resultMixed = cache.getForeignKeysForTable(
            fk.referencingSchema,
            fk.referencingTable
          );

          // All should return the same results
          expect(resultLower.length).toBe(resultUpper.length);
          expect(resultLower.length).toBe(resultMixed.length);

          const namesLower = new Set(resultLower.map((r) => r.constraintName));
          const namesUpper = new Set(resultUpper.map((r) => r.constraintName));
          const namesMixed = new Set(resultMixed.map((r) => r.constraintName));

          expect(namesLower).toEqual(namesUpper);
          expect(namesLower).toEqual(namesMixed);
        }),
        { numRuns: 100 }
      );
    });

    it('empty FK list results in empty lookups for any table', () => {
      fc.assert(
        fc.property(arbitrarySchemaName, arbitraryIdentifier, (schema, tableName) => {
          const cache = new SchemaCache();
          // Don't populate any FKs — default state

          const result = cache.getForeignKeysForTable(schema, tableName);
          expect(result).toEqual([]);
        }),
        { numRuns: 100 }
      );
    });
  });
});
