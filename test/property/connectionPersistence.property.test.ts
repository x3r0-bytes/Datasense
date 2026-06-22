import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { deserializeConnections, filterValidConnections, removeConnectionFromList } from '../../src/objectExplorer/connectionPersistence';
import { ServerConnectionConfig } from '../../src/objectExplorer/types';

/**
 * Property-based tests for connection persistence
 * Feature: object-explorer-panel
 *
 * Property 10: Error-tolerant loading skips invalid entries and loads valid ones
 * Validates: Requirements 12.5
 *
 * Property 11: Connection removal produces list without the removed connection
 * Validates: Requirements 12.6
 */

// --- Generators ---

/** Generator: valid authType */
const arbitraryAuthType: fc.Arbitrary<'sql' | 'windows'> = fc.constantFrom('sql', 'windows');

/** Generator: non-empty trimmed string for required fields */
const arbitraryNonEmptyString: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')),
    fc.string({ minLength: 0, maxLength: 20 })
  )
  .map(([first, rest]) => first + rest);

/** Generator: valid port number (1-65535) or undefined */
const arbitraryOptionalPort: fc.Arbitrary<number | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.integer({ min: 1, max: 65535 })
);

/** Generator: a valid connection entry object (has name, host, authType at minimum) */
const arbitraryValidEntry: fc.Arbitrary<Record<string, unknown>> = fc
  .tuple(
    arbitraryNonEmptyString,
    arbitraryNonEmptyString,
    arbitraryAuthType,
    arbitraryOptionalPort,
    fc.option(arbitraryNonEmptyString, { nil: undefined }),
    fc.boolean(),
    fc.boolean()
  )
  .map(([name, host, authType, port, database, encrypt, trustServerCertificate]) => {
    const entry: Record<string, unknown> = { name, host, authType };
    if (port !== undefined) { entry.port = port; }
    if (database !== undefined) { entry.database = database; }
    entry.encrypt = encrypt;
    entry.trustServerCertificate = trustServerCertificate;
    return entry;
  });

/** Generator: an invalid connection entry (missing required fields, wrong types, null, etc.) */
const arbitraryInvalidEntry: fc.Arbitrary<unknown> = fc.oneof(
  // null
  fc.constant(null),
  // undefined-like
  fc.constant(undefined),
  // number instead of object
  fc.integer(),
  // string instead of object
  fc.string(),
  // boolean instead of object
  fc.boolean(),
  // empty object (missing all required fields)
  fc.constant({}),
  // object with name but missing host and authType
  arbitraryNonEmptyString.map((name) => ({ name })),
  // object with name and host but missing authType
  fc.tuple(arbitraryNonEmptyString, arbitraryNonEmptyString).map(([name, host]) => ({ name, host })),
  // object with name and host but invalid authType
  fc.tuple(arbitraryNonEmptyString, arbitraryNonEmptyString, fc.string()).map(([name, host, authType]) => ({
    name,
    host,
    authType: authType === 'sql' || authType === 'windows' ? 'invalid' : authType,
  })),
  // object with empty name
  fc.tuple(arbitraryNonEmptyString, arbitraryAuthType).map(([host, authType]) => ({
    name: '',
    host,
    authType,
  })),
  // object with whitespace-only name
  fc.tuple(arbitraryNonEmptyString, arbitraryAuthType).map(([host, authType]) => ({
    name: '   ',
    host,
    authType,
  })),
  // object with empty host
  fc.tuple(arbitraryNonEmptyString, arbitraryAuthType).map(([name, authType]) => ({
    name,
    host: '',
    authType,
  })),
  // object with invalid port (out of range)
  fc.tuple(arbitraryNonEmptyString, arbitraryNonEmptyString, arbitraryAuthType).map(([name, host, authType]) => ({
    name,
    host,
    authType,
    port: 99999,
  })),
  // object with invalid port (non-integer)
  fc.tuple(arbitraryNonEmptyString, arbitraryNonEmptyString, arbitraryAuthType).map(([name, host, authType]) => ({
    name,
    host,
    authType,
    port: 3.14,
  })),
  // array instead of object
  fc.array(fc.anything(), { minLength: 0, maxLength: 3 })
);

/**
 * Generator: a mixed array of valid and invalid entries, along with the expected valid entries.
 * Returns { mixedArray, validEntries } where validEntries are the valid ones in order.
 */
const arbitraryMixedEntries: fc.Arbitrary<{ mixedArray: unknown[]; validEntries: Record<string, unknown>[] }> = fc
  .tuple(
    fc.array(arbitraryValidEntry, { minLength: 0, maxLength: 5 }),
    fc.array(arbitraryInvalidEntry, { minLength: 0, maxLength: 5 })
  )
  .chain(([validEntries, invalidEntries]) => {
    // Interleave valid and invalid entries in a random order
    const allEntries = [
      ...validEntries.map((e) => ({ entry: e as unknown, isValid: true })),
      ...invalidEntries.map((e) => ({ entry: e, isValid: false })),
    ];
    return fc.shuffledSubarray(allEntries, { minLength: allEntries.length, maxLength: allEntries.length }).map(
      (shuffled) => ({
        mixedArray: shuffled.map((item) => item.entry),
        validEntries: shuffled.filter((item) => item.isValid).map((item) => item.entry as Record<string, unknown>),
      })
    );
  });

// --- Tests ---

describe('Connection Persistence Property Tests', () => {
  describe('Feature: object-explorer-panel, Property 10: Error-tolerant loading skips invalid entries and loads valid ones', () => {
    /**
     * Validates: Requirements 12.5
     *
     * For any JSON array containing a mix of valid and invalid connection entries,
     * the loading function SHALL return exactly the valid entries (in order) and
     * skip all invalid entries without throwing.
     */

    it('deserializeConnections returns only valid entries from a mixed array and never throws', () => {
      fc.assert(
        fc.property(arbitraryMixedEntries, ({ mixedArray, validEntries }) => {
          const json = JSON.stringify({ connections: mixedArray });

          // Must never throw
          let result: ServerConnectionConfig[];
          expect(() => {
            result = deserializeConnections(json);
          }).not.toThrow();

          result = deserializeConnections(json);

          // Result count must equal valid entries count
          expect(result.length).toBe(validEntries.length);

          // Each result must match the corresponding valid entry in order
          for (let i = 0; i < result.length; i++) {
            expect(result[i].name).toBe(validEntries[i].name);
            expect(result[i].host).toBe(validEntries[i].host);
            expect(result[i].authType).toBe(validEntries[i].authType);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('filterValidConnections returns only valid entries from a mixed array and preserves order', () => {
      fc.assert(
        fc.property(arbitraryMixedEntries, ({ mixedArray, validEntries }) => {
          // Must never throw
          let result: ServerConnectionConfig[];
          expect(() => {
            result = filterValidConnections(mixedArray);
          }).not.toThrow();

          result = filterValidConnections(mixedArray);

          // Result count must equal valid entries count
          expect(result.length).toBe(validEntries.length);

          // Each result must match the corresponding valid entry in order
          for (let i = 0; i < result.length; i++) {
            expect(result[i].name).toBe(validEntries[i].name);
            expect(result[i].host).toBe(validEntries[i].host);
            expect(result[i].authType).toBe(validEntries[i].authType);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('deserializeConnections returns empty array for completely invalid entries', () => {
      fc.assert(
        fc.property(
          fc.array(arbitraryInvalidEntry, { minLength: 1, maxLength: 10 }),
          (invalidEntries) => {
            const json = JSON.stringify({ connections: invalidEntries });

            let result: ServerConnectionConfig[];
            expect(() => {
              result = deserializeConnections(json);
            }).not.toThrow();

            result = deserializeConnections(json);
            expect(result.length).toBe(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('deserializeConnections returns all entries when all are valid', () => {
      fc.assert(
        fc.property(
          fc.array(arbitraryValidEntry, { minLength: 1, maxLength: 10 }),
          (validEntries) => {
            const json = JSON.stringify({ connections: validEntries });

            let result: ServerConnectionConfig[];
            expect(() => {
              result = deserializeConnections(json);
            }).not.toThrow();

            result = deserializeConnections(json);
            expect(result.length).toBe(validEntries.length);

            for (let i = 0; i < result.length; i++) {
              expect(result[i].name).toBe(validEntries[i].name);
              expect(result[i].host).toBe(validEntries[i].host);
              expect(result[i].authType).toBe(validEntries[i].authType);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Feature: object-explorer-panel, Property 11: Connection removal produces list without the removed connection', () => {
    /**
     * Validates: Requirements 12.6
     *
     * For any list of connections and any connection name present in that list,
     * removing that connection SHALL produce a list that contains all other
     * connections unchanged and does not contain the removed connection.
     */

    /** Generator: a non-empty array of ServerConnectionConfig with unique names, plus a target name to remove */
    const arbitraryConnectionsWithTarget: fc.Arbitrary<{
      connections: ServerConnectionConfig[];
      targetName: string;
    }> = fc
      .uniqueArray(arbitraryNonEmptyString, { minLength: 2, maxLength: 10, comparator: (a, b) => a === b })
      .chain((names) =>
        fc
          .tuple(
            fc.tuple(
              ...names.map((name) =>
                fc
                  .tuple(
                    fc.constant(name),
                    arbitraryNonEmptyString,
                    arbitraryAuthType,
                    arbitraryOptionalPort,
                    fc.option(arbitraryNonEmptyString, { nil: undefined }),
                    fc.boolean(),
                    fc.boolean()
                  )
                  .map(([n, host, authType, port, database, encrypt, trustServerCertificate]): ServerConnectionConfig => {
                    const config: ServerConnectionConfig = { name: n, host, authType };
                    if (port !== undefined) { config.port = port; }
                    if (database !== undefined) { config.database = database; }
                    config.encrypt = encrypt;
                    config.trustServerCertificate = trustServerCertificate;
                    return config;
                  })
              )
            ),
            fc.integer({ min: 0, max: names.length - 1 })
          )
          .map(([configs, targetIndex]) => ({
            connections: configs as unknown as ServerConnectionConfig[],
            targetName: names[targetIndex],
          }))
      );

    it('result does not contain any connection with the removed name', () => {
      fc.assert(
        fc.property(arbitraryConnectionsWithTarget, ({ connections, targetName }) => {
          const result = removeConnectionFromList(connections, targetName);

          // No connection in the result should have the removed name
          expect(result.every((c) => c.name !== targetName)).toBe(true);
        }),
        { numRuns: 100 }
      );
    });

    it('result contains all other connections unchanged (same order, same data)', () => {
      fc.assert(
        fc.property(arbitraryConnectionsWithTarget, ({ connections, targetName }) => {
          const result = removeConnectionFromList(connections, targetName);

          // Filter original list to get expected result
          const expected = connections.filter((c) => c.name !== targetName);

          // Same length
          expect(result.length).toBe(expected.length);

          // Same order and same data
          for (let i = 0; i < expected.length; i++) {
            expect(result[i]).toEqual(expected[i]);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('result.length === original.length - 1', () => {
      fc.assert(
        fc.property(arbitraryConnectionsWithTarget, ({ connections, targetName }) => {
          // Target name appears exactly once (unique names guaranteed by generator)
          const result = removeConnectionFromList(connections, targetName);

          expect(result.length).toBe(connections.length - 1);
        }),
        { numRuns: 100 }
      );
    });
  });
});
