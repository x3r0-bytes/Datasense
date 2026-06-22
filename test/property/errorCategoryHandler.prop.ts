// Feature: ui-iteration-v05, Property 3: Connection error categorization
import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';

/**
 * Property-based tests for connection error categorization
 * Feature: ui-iteration-v05, Property 3: Connection error categorization
 *
 * Validates: Requirements 2.1, 2.5, 2.6, 2.8
 *
 * For any error object with a message string and optional error number,
 * categorizeConnectionError SHALL return:
 * - 'odbc-missing' if the message contains "Data source name not found" or "ODBC Driver"
 * - 'invalid-credentials' if the error number is 18456
 * - 'unreachable' if the message contains "ECONNREFUSED", "ENOTFOUND", or "getaddrinfo"
 * - 'timeout' if the message contains "ETIMEOUT" or "connect ETIMEDOUT"
 * - 'generic' for all other errors
 *
 * And the displayMessage for 'unreachable' errors SHALL contain the configured host and port.
 */

// Mock vscode module
vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn().mockResolvedValue(undefined),
  },
  env: {
    openExternal: vi.fn().mockResolvedValue(true),
  },
  Uri: {
    parse: vi.fn((url: string) => ({ toString: () => url })),
  },
  commands: {
    executeCommand: vi.fn().mockResolvedValue(undefined),
  },
}));

import { categorizeConnectionError } from '../../src/errorCategoryHandler';
import { ConnectionConfig } from '../../src/types';

// --- Generators ---

/** Generator: random host string (non-empty, alphanumeric with dots) */
const arbitraryHost: fc.Arbitrary<string> = fc
  .tuple(
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 1, maxLength: 10 }),
    fc.constantFrom('.local', '.com', '.internal', '.net', '')
  )
  .map(([name, suffix]) => name + suffix);

/** Generator: random port number (1–65535) */
const arbitraryPort: fc.Arbitrary<number> = fc.integer({ min: 1, max: 65535 });

/** Generator: random ConnectionConfig with host and port */
const arbitraryConnectionConfig: fc.Arbitrary<ConnectionConfig> = fc
  .tuple(
    fc.string({ minLength: 1, maxLength: 20 }),
    arbitraryHost,
    fc.option(arbitraryPort, { nil: undefined })
  )
  .map(([name, host, port]) => ({
    name,
    host,
    ...(port !== undefined ? { port } : {}),
  }));

/** Known error patterns that trigger specific categories */
const knownPatterns = [
  'Data source name not found',
  'ODBC Driver',
  'ECONNREFUSED',
  'ENOTFOUND',
  'getaddrinfo',
  'ETIMEOUT',
  'connect ETIMEDOUT',
];

/** Generator: random string that does NOT contain any known error patterns */
const arbitraryGenericMessage: fc.Arbitrary<string> = fc
  .string({ minLength: 0, maxLength: 50 })
  .filter((msg) => !knownPatterns.some((pattern) => msg.includes(pattern)));

/** Generator: error message containing ODBC-missing patterns */
const arbitraryOdbcMessage: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('Data source name not found', 'ODBC Driver'),
    fc.string({ minLength: 0, maxLength: 20 }),
    fc.string({ minLength: 0, maxLength: 20 })
  )
  .map(([pattern, prefix, suffix]) => prefix + pattern + suffix);

/** Generator: error message containing unreachable patterns */
const arbitraryUnreachableMessage: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('ECONNREFUSED', 'ENOTFOUND', 'getaddrinfo'),
    fc.string({ minLength: 0, maxLength: 20 }),
    fc.string({ minLength: 0, maxLength: 20 })
  )
  .map(([pattern, prefix, suffix]) => prefix + pattern + suffix)
  .filter((msg) => !msg.includes('Data source name not found') && !msg.includes('ODBC Driver'));

/** Generator: error message containing timeout patterns */
const arbitraryTimeoutMessage: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('ETIMEOUT', 'connect ETIMEDOUT'),
    fc.string({ minLength: 0, maxLength: 20 }),
    fc.string({ minLength: 0, maxLength: 20 })
  )
  .map(([pattern, prefix, suffix]) => prefix + pattern + suffix)
  .filter(
    (msg) =>
      !msg.includes('Data source name not found') &&
      !msg.includes('ODBC Driver') &&
      !msg.includes('ECONNREFUSED') &&
      !msg.includes('ENOTFOUND') &&
      !msg.includes('getaddrinfo')
  );

// --- Helper to create Error with optional number property ---

function createError(message: string, number?: number): Error {
  const err = new Error(message);
  if (number !== undefined) {
    (err as any).number = number;
  }
  return err;
}

// --- Tests ---

describe('ErrorCategoryHandler Property Tests', () => {
  describe('Feature: ui-iteration-v05, Property 3: Connection error categorization', () => {
    /**
     * Validates: Requirements 2.1, 2.5, 2.6, 2.8
     */

    it('categorizes ODBC-missing errors when message contains "Data source name not found" or "ODBC Driver"', () => {
      fc.assert(
        fc.property(
          arbitraryOdbcMessage,
          arbitraryConnectionConfig,
          (message, config) => {
            const error = createError(message);
            const result = categorizeConnectionError(error, config);
            expect(result.category).toBe('odbc-missing');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('categorizes invalid-credentials errors when error number is 18456', () => {
      fc.assert(
        fc.property(
          arbitraryGenericMessage,
          arbitraryConnectionConfig,
          (message, config) => {
            const error = createError(message, 18456);
            const result = categorizeConnectionError(error, config);
            expect(result.category).toBe('invalid-credentials');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('categorizes unreachable errors when message contains "ECONNREFUSED", "ENOTFOUND", or "getaddrinfo"', () => {
      fc.assert(
        fc.property(
          arbitraryUnreachableMessage,
          arbitraryConnectionConfig,
          (message, config) => {
            const error = createError(message);
            const result = categorizeConnectionError(error, config);
            expect(result.category).toBe('unreachable');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('categorizes timeout errors when message contains "ETIMEOUT" or "connect ETIMEDOUT"', () => {
      fc.assert(
        fc.property(
          arbitraryTimeoutMessage,
          arbitraryConnectionConfig,
          (message, config) => {
            const error = createError(message);
            const result = categorizeConnectionError(error, config);
            expect(result.category).toBe('timeout');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('categorizes all other errors as generic', () => {
      fc.assert(
        fc.property(
          arbitraryGenericMessage,
          arbitraryConnectionConfig,
          fc.integer().filter((n) => n !== 18456),
          (message, config, errorNumber) => {
            const error = createError(message, errorNumber);
            const result = categorizeConnectionError(error, config);
            expect(result.category).toBe('generic');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('unreachable errors displayMessage contains the configured host and port', () => {
      fc.assert(
        fc.property(
          arbitraryUnreachableMessage,
          arbitraryHost,
          arbitraryPort,
          fc.string({ minLength: 1, maxLength: 10 }),
          (message, host, port, name) => {
            const config: ConnectionConfig = { name, host, port };
            const error = createError(message);
            const result = categorizeConnectionError(error, config);

            expect(result.category).toBe('unreachable');
            expect(result.displayMessage).toContain(host);
            expect(result.displayMessage).toContain(String(port));
          }
        ),
        { numRuns: 100 }
      );
    });

    it('unreachable errors displayMessage uses default port 1433 when port is not specified', () => {
      fc.assert(
        fc.property(
          arbitraryUnreachableMessage,
          arbitraryHost,
          fc.string({ minLength: 1, maxLength: 10 }),
          (message, host, name) => {
            const config: ConnectionConfig = { name, host };
            const error = createError(message);
            const result = categorizeConnectionError(error, config);

            expect(result.category).toBe('unreachable');
            expect(result.displayMessage).toContain(host);
            expect(result.displayMessage).toContain('1433');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('ODBC-missing takes priority over invalid-credentials (error number 18456)', () => {
      fc.assert(
        fc.property(
          arbitraryOdbcMessage,
          arbitraryConnectionConfig,
          (message, config) => {
            const error = createError(message, 18456);
            const result = categorizeConnectionError(error, config);
            expect(result.category).toBe('odbc-missing');
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
