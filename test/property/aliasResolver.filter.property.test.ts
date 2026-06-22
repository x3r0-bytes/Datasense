import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { filterColumnsByPrefix } from '../../server/src/aliasResolver';
import { ColumnInfo } from '../../server/src/schemaCache';

/**
 * Property-based tests for Alias Column Prefix Filtering (Property 20)
 * Feature: next-iteration-features
 *
 * **Validates: Requirements 3.10**
 *
 * For any resolved alias with N columns, typing `alias.prefix` (where prefix
 * is a non-empty string) SHALL return only those columns whose names start
 * with the typed prefix (case-insensitive), and the count of returned columns
 * SHALL be ≤ N.
 */

// --- Generators ---

/** Generator: valid SQL column name */
const arbitraryColumnName: fc.Arbitrary<string> = fc.oneof(
  // Standard column names
  fc.tuple(
    fc.constantFrom('First', 'Last', 'User', 'Order', 'Product', 'Customer', 'Date', 'Total', 'Name', 'Id'),
    fc.constantFrom('Name', 'Id', 'Date', 'Count', 'Amount', 'Type', 'Status', 'Code', '')
  ).map(([a, b]) => a + b),
  // Underscore-separated names
  fc.tuple(
    fc.constantFrom('first', 'last', 'user', 'order', 'product', 'customer', 'created', 'updated'),
    fc.constantFrom('_name', '_id', '_date', '_count', '_amount', '_type', '_at', '')
  ).map(([a, b]) => a + b),
  // Single word names
  fc.constantFrom('Id', 'Name', 'Email', 'Phone', 'Address', 'City', 'State', 'Zip', 'Country', 'Active')
);

/** Generator: valid SQL data type */
const arbitraryDataType: fc.Arbitrary<string> = fc.constantFrom(
  'int', 'bigint', 'varchar(255)', 'nvarchar(100)', 'datetime', 'bit',
  'decimal(18,2)', 'float', 'uniqueidentifier', 'text', 'ntext', 'date'
);

/** Generator: a ColumnInfo object */
const arbitraryColumnInfo: fc.Arbitrary<ColumnInfo> = fc.record({
  name: arbitraryColumnName,
  dataType: arbitraryDataType,
  isNullable: fc.boolean()
});

/** Generator: array of ColumnInfo (simulating a resolved alias's columns) */
const arbitraryColumns: fc.Arbitrary<ColumnInfo[]> = fc.array(
  arbitraryColumnInfo,
  { minLength: 1, maxLength: 20 }
);

/** Generator: a non-empty prefix string (letters only, to simulate typing after alias.) */
const arbitraryPrefix: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
  { minLength: 1, maxLength: 10 }
);

// --- Tests ---

describe('Alias Column Prefix Filtering Property Tests', () => {
  describe('Feature: next-iteration-features, Property 20: Alias column prefix filtering', () => {
    /**
     * **Validates: Requirements 3.10**
     *
     * For any resolved alias with N columns, typing `alias.prefix` SHALL return
     * only those columns whose names start with the typed prefix (case-insensitive),
     * and the count of returned columns SHALL be ≤ N.
     */

    it('filtered result count is always ≤ input column count', () => {
      fc.assert(
        fc.property(arbitraryColumns, arbitraryPrefix, (columns, prefix) => {
          const result = filterColumnsByPrefix(columns, prefix);
          expect(result.length).toBeLessThanOrEqual(columns.length);
        }),
        { numRuns: 200 }
      );
    });

    it('all returned columns start with the typed prefix (case-insensitive)', () => {
      fc.assert(
        fc.property(arbitraryColumns, arbitraryPrefix, (columns, prefix) => {
          const result = filterColumnsByPrefix(columns, prefix);
          const prefixLower = prefix.toLowerCase();
          for (const col of result) {
            expect(col.name.toLowerCase().startsWith(prefixLower)).toBe(true);
          }
        }),
        { numRuns: 200 }
      );
    });

    it('no matching columns are excluded from the result', () => {
      fc.assert(
        fc.property(arbitraryColumns, arbitraryPrefix, (columns, prefix) => {
          const result = filterColumnsByPrefix(columns, prefix);
          const prefixLower = prefix.toLowerCase();
          // Every column that matches the prefix should be in the result
          const expectedMatches = columns.filter(
            col => col.name.toLowerCase().startsWith(prefixLower)
          );
          expect(result.length).toBe(expectedMatches.length);
        }),
        { numRuns: 200 }
      );
    });

    it('filtering is case-insensitive (uppercase prefix matches lowercase column names)', () => {
      fc.assert(
        fc.property(arbitraryColumns, arbitraryPrefix, (columns, prefix) => {
          const upperResult = filterColumnsByPrefix(columns, prefix.toUpperCase());
          const lowerResult = filterColumnsByPrefix(columns, prefix.toLowerCase());
          // Both should return the same columns regardless of prefix case
          expect(upperResult.length).toBe(lowerResult.length);
          const upperNames = upperResult.map(c => c.name).sort();
          const lowerNames = lowerResult.map(c => c.name).sort();
          expect(upperNames).toEqual(lowerNames);
        }),
        { numRuns: 200 }
      );
    });

    it('empty prefix returns all columns unchanged', () => {
      fc.assert(
        fc.property(arbitraryColumns, (columns) => {
          const result = filterColumnsByPrefix(columns, '');
          expect(result).toEqual(columns);
        }),
        { numRuns: 100 }
      );
    });

    it('result preserves column metadata (dataType and isNullable)', () => {
      fc.assert(
        fc.property(arbitraryColumns, arbitraryPrefix, (columns, prefix) => {
          const result = filterColumnsByPrefix(columns, prefix);
          for (const col of result) {
            // Find the original column in the input
            const original = columns.find(c => c.name === col.name && c.dataType === col.dataType && c.isNullable === col.isNullable);
            expect(original).toBeDefined();
          }
        }),
        { numRuns: 100 }
      );
    });
  });
});
