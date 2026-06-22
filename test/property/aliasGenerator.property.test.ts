import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { generateAlias } from '../../server/src/aliasGenerator';

/**
 * Property-based tests for AliasGenerator (Properties 10, 11)
 * Feature: smart-join-generator
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 4.6
 */

// --- Generators ---

/** Generator: arbitrary table name (any string including edge cases) */
const arbitraryTableName: fc.Arbitrary<string> = fc.oneof(
  // Normal PascalCase names
  fc.stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')
    ),
    { minLength: 0, maxLength: 30 }
  ),
  // Fully random strings (including special characters, unicode, etc.)
  fc.string({ minLength: 0, maxLength: 30 }),
  // PascalCase-style names
  fc.tuple(
    fc.constantFrom('Order', 'Customer', 'Product', 'Invoice', 'Employee', 'XML', 'IO'),
    fc.constantFrom('Details', 'Items', 'History', 'Parser', 'Stream', 'Log', 'Data')
  ).map(([a, b]) => a + b),
  // Underscore-separated names
  fc.tuple(
    fc.constantFrom('order', 'customer', 'product', 'invoice', 'employee'),
    fc.constantFrom('details', 'items', 'history', 'log', 'data')
  ).map(([a, b]) => `${a}_${b}`),
  // Single word names
  fc.constantFrom('Orders', 'Customers', 'Products', 'Users', 'Items'),
  // Edge cases
  fc.constant(''),
  fc.constant('___'),
  fc.constant('!!!'),
  fc.constant('123')
);

/** Generator: valid alias (lowercase letters and digits, 1-10 chars) */
const arbitraryAlias: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  { minLength: 1, maxLength: 10 }
);

/** Generator: array of existing aliases */
const arbitraryExistingAliases: fc.Arbitrary<string[]> = fc.array(
  arbitraryAlias,
  { minLength: 0, maxLength: 20 }
);

// --- Tests ---

describe('AliasGenerator Property Tests', () => {
  describe('Feature: smart-join-generator, Property 10: Alias generation produces valid, deterministic aliases', () => {
    /**
     * Validates: Requirements 5.1, 5.3, 5.4, 5.5
     *
     * For any table name, the Alias Generator SHALL produce an alias containing
     * only lowercase ASCII letters and digits (matching /^[a-z0-9]{1,10}$/),
     * derived from the first letter of each word boundary in the name,
     * defaulting to 't' when derivation produces an empty string.
     */

    it('output always matches /^[a-z0-9]{1,10}$/ for any table name', () => {
      fc.assert(
        fc.property(arbitraryTableName, arbitraryExistingAliases, (tableName, existingAliases) => {
          const alias = generateAlias(tableName, existingAliases);
          expect(alias).toMatch(/^[a-z0-9]{1,10}$/);
        }),
        { numRuns: 200 }
      );
    });

    it('alias generation is deterministic (same input produces same output)', () => {
      fc.assert(
        fc.property(arbitraryTableName, arbitraryExistingAliases, (tableName, existingAliases) => {
          const alias1 = generateAlias(tableName, existingAliases);
          const alias2 = generateAlias(tableName, existingAliases);
          expect(alias1).toBe(alias2);
        }),
        { numRuns: 200 }
      );
    });

    it('empty derivation defaults to t', () => {
      fc.assert(
        fc.property(
          // Generate strings that contain no ASCII alphanumeric characters
          fc.stringOf(
            fc.constantFrom(...'!@#$%^&*()+-=[]{}|;:,.<>?/~`'.split('')),
            { minLength: 0, maxLength: 10 }
          ),
          (tableName) => {
            const alias = generateAlias(tableName, []);
            // When derivation produces empty string, should default to 't'
            expect(alias).toBe('t');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('alias length is always between 1 and 10 characters', () => {
      fc.assert(
        fc.property(arbitraryTableName, arbitraryExistingAliases, (tableName, existingAliases) => {
          const alias = generateAlias(tableName, existingAliases);
          expect(alias.length).toBeGreaterThanOrEqual(1);
          expect(alias.length).toBeLessThanOrEqual(10);
        }),
        { numRuns: 200 }
      );
    });

    it('alias contains only lowercase ASCII letters and digits', () => {
      fc.assert(
        fc.property(arbitraryTableName, arbitraryExistingAliases, (tableName, existingAliases) => {
          const alias = generateAlias(tableName, existingAliases);
          for (const char of alias) {
            const code = char.charCodeAt(0);
            const isLowerLetter = code >= 97 && code <= 122; // a-z
            const isDigit = code >= 48 && code <= 57; // 0-9
            expect(isLowerLetter || isDigit).toBe(true);
          }
        }),
        { numRuns: 200 }
      );
    });
  });

  describe('Feature: smart-join-generator, Property 11: Alias conflict resolution produces unique aliases', () => {
    /**
     * Validates: Requirements 4.6, 5.2
     *
     * For any generated alias that conflicts with existing aliases in the query,
     * the Alias Generator SHALL produce a unique alias by appending numeric
     * suffixes (2-99), and the resulting alias SHALL not match any existing
     * alias in the query.
     */

    it('result is never in the existing aliases set (case-insensitive)', () => {
      fc.assert(
        fc.property(arbitraryTableName, arbitraryExistingAliases, (tableName, existingAliases) => {
          const alias = generateAlias(tableName, existingAliases);
          const existingLower = new Set(existingAliases.map(a => a.toLowerCase()));
          expect(existingLower.has(alias.toLowerCase())).toBe(false);
        }),
        { numRuns: 200 }
      );
    });

    it('when base alias conflicts, result is unique with numeric suffix', () => {
      fc.assert(
        fc.property(
          arbitraryTableName.filter(name => {
            // Only use names that produce a non-empty derivation
            const cleaned = name.replace(/[^a-zA-Z0-9_]/g, '');
            return cleaned.length > 0;
          }),
          (tableName) => {
            // Generate the base alias first (no conflicts)
            const baseAlias = generateAlias(tableName, []);

            // Now create a conflict by including the base alias in existing
            const existingAliases = [baseAlias];
            const resolvedAlias = generateAlias(tableName, existingAliases);

            // The resolved alias should be different from the base
            expect(resolvedAlias).not.toBe(baseAlias);
            // It should still be valid
            expect(resolvedAlias).toMatch(/^[a-z0-9]{1,10}$/);
            // It should not be in the existing set
            const existingLower = new Set(existingAliases.map(a => a.toLowerCase()));
            expect(existingLower.has(resolvedAlias.toLowerCase())).toBe(false);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('handles multiple conflicts by producing unique aliases each time', () => {
      fc.assert(
        fc.property(
          arbitraryTableName.filter(name => {
            const cleaned = name.replace(/[^a-zA-Z0-9_]/g, '');
            return cleaned.length > 0;
          }),
          fc.integer({ min: 2, max: 10 }),
          (tableName, conflictCount) => {
            // Build up a set of conflicting aliases incrementally
            const existingAliases: string[] = [];

            for (let i = 0; i < conflictCount; i++) {
              const alias = generateAlias(tableName, existingAliases);
              // Each generated alias must not be in the existing set
              const existingLower = new Set(existingAliases.map(a => a.toLowerCase()));
              expect(existingLower.has(alias.toLowerCase())).toBe(false);
              // Each alias must be valid
              expect(alias).toMatch(/^[a-z0-9]{1,10}$/);
              // Add it to existing for next iteration
              existingAliases.push(alias);
            }

            // All generated aliases should be unique
            const allLower = existingAliases.map(a => a.toLowerCase());
            const uniqueSet = new Set(allLower);
            expect(uniqueSet.size).toBe(existingAliases.length);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('conflict resolution is case-insensitive', () => {
      fc.assert(
        fc.property(
          arbitraryTableName.filter(name => {
            const cleaned = name.replace(/[^a-zA-Z0-9_]/g, '');
            return cleaned.length > 0;
          }),
          (tableName) => {
            // Get the base alias
            const baseAlias = generateAlias(tableName, []);

            // Create conflict with uppercase version
            const upperConflict = baseAlias.toUpperCase();
            const resolvedAlias = generateAlias(tableName, [upperConflict]);

            // Should still resolve the conflict (case-insensitive)
            expect(resolvedAlias.toLowerCase()).not.toBe(baseAlias.toLowerCase());
            expect(resolvedAlias).toMatch(/^[a-z0-9]{1,10}$/);
          }
        ),
        { numRuns: 200 }
      );
    });
  });
});
