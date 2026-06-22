import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';

/**
 * Property-based tests for editor connection indicator
 * Feature: ui-overhaul-v2, Property 6: Connection Indicator Formatting
 * Feature: ui-overhaul-v2, Property 7: Connection Indicator Visibility
 *
 * Validates: Requirements 6.1, 6.2
 */

// Mock vscode module (required because editorConnectionIndicator.ts imports vscode)
vi.mock('vscode', () => ({
  window: {
    createStatusBarItem: vi.fn(() => ({
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      text: '',
      tooltip: '',
      command: '',
    })),
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
    activeTextEditor: undefined,
  },
  StatusBarAlignment: {
    Right: 2,
  },
}));

import {
  formatServerText,
  formatDatabaseText,
  shouldShowIndicator,
} from '../../src/editorConnectionIndicator';
import { ConnectionConfig } from '../../src/types';

// --- Generators ---

/** Generator: arbitrary non-empty string for server names */
const arbitraryServerName: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 128 });

/** Generator: arbitrary non-empty string for database names */
const arbitraryDatabaseName: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 128 });

/** Generator: arbitrary ConnectionConfig with non-empty name and database */
const arbitraryConnectionConfig: fc.Arbitrary<ConnectionConfig> = fc.record({
  name: arbitraryServerName,
  host: fc.string({ minLength: 1, maxLength: 128 }),
  port: fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
  database: arbitraryDatabaseName,
  user: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  password: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  encrypt: fc.option(fc.boolean(), { nil: undefined }),
  trustServerCertificate: fc.option(fc.boolean(), { nil: undefined }),
  authType: fc.option(fc.constantFrom('sql' as const, 'windows' as const), { nil: undefined }),
});

/** Generator: arbitrary language ID string that is NOT "sql" */
const arbitraryNonSqlLanguageId: fc.Arbitrary<string> = fc
  .string({ minLength: 0, maxLength: 50 })
  .filter((s) => s !== 'sql');

// --- Tests ---

describe('Editor Connection Indicator Property Tests', () => {
  describe('Property 6: Connection Indicator Formatting', () => {
    /**
     * Validates: Requirements 6.1
     *
     * For any valid ConnectionConfig with non-empty name and database fields,
     * the indicator text SHALL contain both the server name and the database
     * name as substrings.
     */

    it('server text contains the server name for any valid config', () => {
      fc.assert(
        fc.property(arbitraryConnectionConfig, (config) => {
          const serverText = formatServerText(config);
          expect(serverText).toContain(config.name);
        }),
        { numRuns: 100 }
      );
    });

    it('database text contains the database name for any valid config', () => {
      fc.assert(
        fc.property(arbitraryConnectionConfig, (config) => {
          const databaseText = formatDatabaseText(config);
          expect(databaseText).toContain(config.database);
        }),
        { numRuns: 100 }
      );
    });

    it('indicator texts together contain both server name and database name', () => {
      fc.assert(
        fc.property(arbitraryConnectionConfig, (config) => {
          const serverText = formatServerText(config);
          const databaseText = formatDatabaseText(config);
          const combinedText = `${serverText} ${databaseText}`;
          expect(combinedText).toContain(config.name);
          expect(combinedText).toContain(config.database);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 7: Connection Indicator Visibility', () => {
    /**
     * Validates: Requirements 6.2
     *
     * For any language ID string that is not equal to "sql",
     * the connection indicator SHALL be in a hidden state (visible === false).
     */

    it('returns false for any language ID that is not "sql"', () => {
      fc.assert(
        fc.property(arbitraryNonSqlLanguageId, (languageId) => {
          const visible = shouldShowIndicator(languageId);
          expect(visible).toBe(false);
        }),
        { numRuns: 100 }
      );
    });

    it('returns true only when language ID is exactly "sql"', () => {
      const visible = shouldShowIndicator('sql');
      expect(visible).toBe(true);
    });

    it('returns false for language IDs that are close to "sql" but not exact', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('SQL', 'Sql', 'sql ', ' sql', 'tsql', 'plsql', 'mysql', 'nosql', 'sqll', 'sq'),
          (languageId) => {
            const visible = shouldShowIndicator(languageId);
            expect(visible).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('returns false for arbitrary non-empty strings that are not "sql"', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s !== 'sql'),
          (languageId) => {
            const visible = shouldShowIndicator(languageId);
            expect(visible).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
