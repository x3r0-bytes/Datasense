import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';
import { getCompletions, detectContext } from '../../server/src/completionProvider';
import { ISchemaCache, TableInfo, ViewInfo, ProcedureInfo } from '../../server/src/schemaCache';
import * as mssql from 'mssql';

/**
 * Bug Condition Exploration Property Tests — IntelliSense QA Fixes
 *
 * **Property 1: Bug Condition** — IntelliSense QA Bugs (Schema Duplication, Missing Keywords, CTE Context)
 *
 * CRITICAL: These tests encode the EXPECTED (correct) behavior.
 * They are EXPECTED TO FAIL on unfixed code — failure confirms the bugs exist.
 * DO NOT fix the code or modify the tests when they fail.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.6
 */

// --- Helpers ---

function createMockSchemaCache(options: {
  tables?: TableInfo[];
  views?: ViewInfo[];
  procedures?: ProcedureInfo[];
}): ISchemaCache {
  return {
    tables: options.tables ?? [],
    views: options.views ?? [],
    procedures: options.procedures ?? [],
    foreignKeys: [],
    isPopulating: false,
    refresh: async (_pool: mssql.ConnectionPool) => {},
    getForeignKeysForTable: (_schema: string, _tableName: string) => [],
  };
}

// --- Generators ---

/** Generator: random valid SQL schema name */
const arbitrarySchemaName: fc.Arbitrary<string> = fc.constantFrom('dbo', 'sales', 'hr', 'admin', 'app', 'staging');

/** Generator: random valid SQL identifier (table name) */
const arbitraryTableName: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')),
      { minLength: 1, maxLength: 12 }
    )
  )
  .map(([first, rest]) => first + rest)
  .filter((id) => !/^(select|from|where|join|inner|left|right|full|cross|on|order|group|having|exec|execute|insert|update|delete|create|alter|drop|begin|end|with|as)$/i.test(id));

// --- Tests ---

describe('Bug Condition Exploration: IntelliSense QA Bugs', () => {
  describe('Bug 1 — Schema Duplication: insertText must strip schema prefix', () => {
    /**
     * Validates: Requirements 1.1, 1.2
     *
     * When a user types a schema prefix (e.g., `dbo.`) and the completion list shows
     * schema-qualified items (e.g., `dbo.Users`), each completion item MUST have an
     * `insertText` that contains ONLY the table name (e.g., `Users`), NOT the full
     * schema-qualified label.
     *
     * On unfixed code: items have no `insertText` field, so VS Code inserts the full
     * label `dbo.Users` after the already-typed `dbo.`, producing `dbo.dbo.Users`.
     */

    it('completion items after typed schema prefix have insertText without schema', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          fc.array(arbitraryTableName, { minLength: 1, maxLength: 5 }),
          (schema, tableNames) => {
            // Ensure unique table names
            const uniqueNames = [...new Set(tableNames)];
            if (uniqueNames.length === 0) return;

            const tables: TableInfo[] = uniqueNames.map(name => ({
              schema,
              name,
              columns: [{ name: 'Id', dataType: 'int', isNullable: false }],
            }));

            const schemaCache = createMockSchemaCache({ tables });

            // User has typed "SELECT * FROM dbo." (schema prefix with dot)
            const text = `SELECT * FROM ${schema}.`;
            const items = getCompletions(text, text.length, schemaCache, true);

            // Filter to items that match the typed schema prefix
            const matchingItems = items.filter(item =>
              (item.label as string).toLowerCase().startsWith(`${schema.toLowerCase()}.`)
            );

            // Every matching item MUST have an insertText that is ONLY the table name
            // (without the schema prefix), to prevent duplication
            for (const item of matchingItems) {
              const label = item.label as string;
              const expectedTableName = label.substring(label.indexOf('.') + 1);

              expect(item.insertText).toBeDefined();
              expect(item.insertText).toBe(expectedTableName);
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('concrete case: dbo.Users completion after typing "dbo." has insertText "Users"', () => {
      const schemaCache = createMockSchemaCache({
        tables: [
          { schema: 'dbo', name: 'Users', columns: [{ name: 'Id', dataType: 'int', isNullable: false }] },
          { schema: 'dbo', name: 'Orders', columns: [{ name: 'Id', dataType: 'int', isNullable: false }] },
        ],
      });

      const text = 'SELECT * FROM dbo.';
      const items = getCompletions(text, text.length, schemaCache, true);

      const usersItem = items.find(item => (item.label as string) === 'dbo.Users');
      expect(usersItem).toBeDefined();
      expect(usersItem!.insertText).toBeDefined();
      expect(usersItem!.insertText).toBe('Users');
    });
  });

  describe('Bug 2 — Missing Keywords: FROM and JOIN must appear in completions', () => {
    /**
     * Validates: Requirements 1.3, 1.4
     *
     * When a user types `SELECT * ` (end of column list), the completion list MUST
     * include the `FROM` keyword. When a user types a partial JOIN keyword like
     * `INNER`, the completion list MUST include `JOIN`.
     *
     * On unfixed code: only column/table completions are returned — no keywords.
     */

    it('FROM keyword appears in completions after "SELECT * "', () => {
      fc.assert(
        fc.property(
          fc.array(arbitraryTableName, { minLength: 1, maxLength: 3 }),
          (tableNames) => {
            const uniqueNames = [...new Set(tableNames)];
            if (uniqueNames.length === 0) return;

            const tables: TableInfo[] = uniqueNames.map(name => ({
              schema: 'dbo',
              name,
              columns: [{ name: 'Id', dataType: 'int', isNullable: false }],
            }));

            const schemaCache = createMockSchemaCache({ tables });

            const text = 'SELECT * ';
            const items = getCompletions(text, text.length, schemaCache, true);

            const labels = items.map(i => (i.label as string).toUpperCase());
            expect(labels).toContain('FROM');
          }
        ),
        { numRuns: 50 }
      );
    });

    it('JOIN keyword appears in completions after "SELECT * FROM dbo.Users INNER"', () => {
      const schemaCache = createMockSchemaCache({
        tables: [
          { schema: 'dbo', name: 'Users', columns: [{ name: 'Id', dataType: 'int', isNullable: false }] },
          { schema: 'dbo', name: 'Orders', columns: [{ name: 'UserId', dataType: 'int', isNullable: false }] },
        ],
      });

      const text = 'SELECT * FROM dbo.Users INNER';
      const items = getCompletions(text, text.length, schemaCache, true);

      const labels = items.map(i => (i.label as string).toUpperCase());
      expect(labels).toContain('JOIN');
    });

    it('JOIN keyword appears after partial join keywords (LEFT, RIGHT, FULL, CROSS)', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('LEFT', 'RIGHT', 'FULL', 'CROSS'),
          (partialKeyword) => {
            const schemaCache = createMockSchemaCache({
              tables: [
                { schema: 'dbo', name: 'Users', columns: [{ name: 'Id', dataType: 'int', isNullable: false }] },
              ],
            });

            const text = `SELECT * FROM dbo.Users ${partialKeyword}`;
            const items = getCompletions(text, text.length, schemaCache, true);

            const labels = items.map(i => (i.label as string).toUpperCase());
            expect(labels).toContain('JOIN');
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  describe('Bug 4 — CTE Context: detectContext recognizes WITH...AS pattern', () => {
    /**
     * Validates: Requirements 1.6
     *
     * When a user types `WITH MyCTE AS` (CTE preamble), `detectContext()` MUST
     * return `'CTE'` and completions MUST include CTE-appropriate items (e.g.,
     * `(SELECT` snippet or opening parenthesis).
     *
     * On unfixed code: `detectContext()` returns `'NONE'` and generic keywords
     * are returned instead of CTE guidance.
     */

    it('detectContext returns CTE for "WITH <name> AS" patterns', () => {
      fc.assert(
        fc.property(
          arbitraryTableName,
          (cteName) => {
            const text = `WITH ${cteName} AS`;
            const context = detectContext(text);
            expect(context).toBe('CTE');
          }
        ),
        { numRuns: 50 }
      );
    });

    it('concrete case: detectContext("WITH MyCTE AS") returns CTE', () => {
      const context = detectContext('WITH MyCTE AS');
      expect(context).toBe('CTE');
    });

    it('completions for CTE preamble include CTE-specific items (not just generic keywords)', () => {
      const schemaCache = createMockSchemaCache({
        tables: [
          { schema: 'dbo', name: 'Users', columns: [{ name: 'Id', dataType: 'int', isNullable: false }] },
        ],
      });

      const text = 'WITH MyCTE AS ';
      const items = getCompletions(text, text.length, schemaCache, true);

      // Should include CTE-specific completions like "(SELECT" snippet or opening parenthesis
      // Generic keywords (SELECT, INSERT, etc.) are NOT sufficient — we need CTE body guidance
      const labels = items.map(i => (i.label as string));
      const hasCteSpecificGuidance = labels.some(label =>
        label.includes('(SELECT') || label === '('
      );

      expect(hasCteSpecificGuidance).toBe(true);
    });
  });

  describe('Bug 3 — Disconnect Command: sqlServer.disconnect must be registered', () => {
    /**
     * Validates: Requirements 1.5 (structural verification)
     *
     * The `sqlServer.disconnect` command MUST be registered in package.json
     * (contributes.commands) and have a corresponding activation event.
     *
     * On unfixed code: the command does not exist in package.json or extension.ts.
     */

    it('package.json contains sqlServer.disconnect in contributes.commands', () => {
      const packageJsonPath = path.resolve(__dirname, '../../package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

      const commands: Array<{ command: string; title: string }> = packageJson.contributes?.commands ?? [];
      const disconnectCommand = commands.find(cmd => cmd.command === 'sqlServer.disconnect');

      expect(disconnectCommand).toBeDefined();
      expect(disconnectCommand!.title).toContain('Disconnect');
    });

    it('package.json contains onCommand:sqlServer.disconnect in activationEvents', () => {
      const packageJsonPath = path.resolve(__dirname, '../../package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

      const activationEvents: string[] = packageJson.activationEvents ?? [];
      expect(activationEvents).toContain('onCommand:sqlServer.disconnect');
    });
  });
});
