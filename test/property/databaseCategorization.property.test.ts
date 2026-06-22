import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { categorizeDatabases } from '../../src/objectExplorer/nodeUtils';
import { DatabaseInfo } from '../../src/objectExplorer/types';

/**
 * Property-based tests for database categorization
 * Feature: object-explorer-panel, Property 12: Database categorization separates user and system databases
 *
 * Validates: Requirements 6.1
 */

// --- Generators ---

/** Generator: a valid database state */
const arbitraryDatabaseState: fc.Arbitrary<DatabaseInfo['state']> = fc.constantFrom(
  'online',
  'offline',
  'restoring',
  'recovering',
  'suspect'
);

/** Generator: a non-empty database name */
const arbitraryDatabaseName: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')
  ),
  { minLength: 1, maxLength: 50 }
);

/** Generator: a DatabaseInfo object with random isSystem value */
const arbitraryDatabaseInfo: fc.Arbitrary<DatabaseInfo> = fc.record({
  name: arbitraryDatabaseName,
  isSystem: fc.boolean(),
  state: arbitraryDatabaseState,
});

/** Generator: an array of DatabaseInfo objects */
const arbitraryDatabaseList: fc.Arbitrary<DatabaseInfo[]> = fc.array(arbitraryDatabaseInfo, {
  minLength: 0,
  maxLength: 30,
});

// --- Tests ---

describe('Database Categorization Property Tests', () => {
  describe('Property 12: Database categorization separates user and system databases', () => {
    /**
     * Validates: Requirements 6.1
     *
     * For any list of DatabaseInfo objects, the categorizeDatabases function SHALL
     * place databases with isSystem: true under the system array and databases with
     * isSystem: false under the user array.
     */

    it('all items in result.system have isSystem: true', () => {
      fc.assert(
        fc.property(arbitraryDatabaseList, (databases) => {
          const result = categorizeDatabases(databases);
          for (const db of result.system) {
            expect(db.isSystem).toBe(true);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('all items in result.user have isSystem: false', () => {
      fc.assert(
        fc.property(arbitraryDatabaseList, (databases) => {
          const result = categorizeDatabases(databases);
          for (const db of result.user) {
            expect(db.isSystem).toBe(false);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('total count of user + system equals input count', () => {
      fc.assert(
        fc.property(arbitraryDatabaseList, (databases) => {
          const result = categorizeDatabases(databases);
          expect(result.user.length + result.system.length).toBe(databases.length);
        }),
        { numRuns: 100 }
      );
    });

    it('no items are lost or duplicated', () => {
      fc.assert(
        fc.property(arbitraryDatabaseList, (databases) => {
          const result = categorizeDatabases(databases);
          const combined = [...result.user, ...result.system];

          // Every input database must appear in the output exactly as many times as in the input
          for (const db of databases) {
            const countInInput = databases.filter(
              (d) => d.name === db.name && d.isSystem === db.isSystem && d.state === db.state
            ).length;
            const countInOutput = combined.filter(
              (d) => d.name === db.name && d.isSystem === db.isSystem && d.state === db.state
            ).length;
            expect(countInOutput).toBe(countInInput);
          }
        }),
        { numRuns: 100 }
      );
    });
  });
});
