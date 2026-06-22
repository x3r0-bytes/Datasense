import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  detectContext,
  getCompletions,
  getContextualKeywords,
  getClausePresenceSet,
  CompletionContext,
  ClausePresenceSet,
} from '../../server/src/completionProvider';
import { ISchemaCache, ProcedureInfo } from '../../server/src/schemaCache';
import * as mssql from 'mssql';

/**
 * Bug Condition Exploration Property Tests — EXEC/Keyword/SELECT Bugs
 *
 * **Property 1: Bug Condition** — Schema Duplication, Cross-Statement EXEC Leakage, and INTO After Star
 *
 * CRITICAL: These tests encode the EXPECTED (correct) behavior.
 * They are EXPECTED TO FAIL on unfixed code — failure confirms the bugs exist.
 * DO NOT fix the code or modify the tests when they fail.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3**
 */

// --- Helpers ---

function createMockSchemaCache(options: {
  procedures?: ProcedureInfo[];
}): ISchemaCache {
  return {
    tables: [],
    views: [],
    procedures: options.procedures ?? [],
    foreignKeys: [],
    isPopulating: false,
    refresh: async (_pool: mssql.ConnectionPool) => {},
    getForeignKeysForTable: (_schema: string, _tableName: string) => [],
  };
}

// --- Generators ---

/** Generator: random valid SQL schema name (alphanumeric, starts with letter) */
const arbitrarySchemaName: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')),
      { minLength: 1, maxLength: 10 }
    )
  )
  .map(([first, rest]) => first + rest);

/** Generator: random valid SQL procedure name (alphanumeric, starts with letter) */
const arbitraryProcName: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')),
      { minLength: 1, maxLength: 15 }
    )
  )
  .map(([first, rest]) => first + rest);

/** Generator: random TOP N value (positive integer) */
const arbitraryTopN: fc.Arbitrary<number> = fc.integer({ min: 1, max: 10000 });

/** Generator: random EXEC variant keyword */
const arbitraryExecKeyword: fc.Arbitrary<string> = fc.constantFrom('EXEC', 'EXECUTE', 'exec', 'execute', 'Exec');

/** Generator: random prior-statement procedure call */
const arbitraryPriorExecStatement: fc.Arbitrary<string> = fc
  .tuple(arbitraryExecKeyword, arbitrarySchemaName, arbitraryProcName)
  .map(([exec, schema, proc]) => `${exec} ${schema}.${proc}`);

// --- Tests ---

describe('Bug Condition Exploration: EXEC/Keyword/SELECT Bugs', () => {
  /**
   * Bug 1.1: Schema Duplication in Procedure Completions
   *
   * When the user types `EXEC schema.` (prefix contains a dot), the completion items
   * returned by getProcedureCompletions should have `insertText` set to just the
   * procedure name (without schema prefix) to avoid duplication.
   *
   * On unfixed code: `insertText` is `undefined` on procedure items, causing VS Code
   * to insert the full label (schema.name) after the already-typed schema prefix,
   * resulting in `schema.schema.name`.
   *
   * **Validates: Requirements 1.1**
   */
  it('Bug 1.1: procedure completions with schema prefix should set insertText to procedure name only', () => {
    fc.assert(
      fc.property(
        arbitrarySchemaName,
        arbitraryProcName,
        fc.array(fc.tuple(arbitrarySchemaName, arbitraryProcName), { minLength: 0, maxLength: 4 }),
        (typedSchema, matchingProcName, extraProcedures) => {
          // Ensure at least one procedure matches the typed schema prefix
          const procs: ProcedureInfo[] = [
            { schema: typedSchema, name: matchingProcName },
            ...extraProcedures.map(([schema, name]) => ({ schema, name })),
          ];
          const schemaCache = createMockSchemaCache({ procedures: procs });

          // Simulate typing `EXEC typedSchema.` — prefix contains a dot
          const textBeforeCursor = `EXEC ${typedSchema}.`;
          const documentText = textBeforeCursor;
          const offset = documentText.length;

          // Get completions in connected mode
          const items = getCompletions(documentText, offset, schemaCache, true);

          // Filter to procedure items (kind === Method)
          const procItems = items.filter(item => item.detail === 'Stored Procedure');

          // There should be at least one procedure item (the one matching the typed schema)
          expect(procItems.length).toBeGreaterThan(0);

          // For all procedure items returned, they MUST have insertText set
          // to just the procedure name (without schema) to avoid duplication
          for (const item of procItems) {
            expect(item.insertText).toBeDefined();
            // insertText should NOT contain a dot (should be just the proc name)
            expect(item.insertText).not.toContain('.');
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Bug 1.2: Cross-Statement EXEC Context Leakage
   *
   * When the user types at the start of a new statement (e.g., `EX` on a new line)
   * and a prior EXEC/EXECUTE keyword exists in an earlier statement (terminated by `;`),
   * the context should be detected as NONE (not EXEC), and keyword completions should
   * be returned.
   *
   * On unfixed code: `detectContext` is called with the full document text before cursor,
   * which finds the prior EXEC keyword and incorrectly returns 'EXEC' context, causing
   * stored procedure completions instead of keyword completions.
   *
   * **Validates: Requirements 1.2**
   */
  it('Bug 1.2: new statement after prior EXEC should not detect EXEC context', () => {
    fc.assert(
      fc.property(
        arbitraryPriorExecStatement,
        (priorStatement) => {
          // Document: prior EXEC statement terminated by semicolon, then new line with `EX`
          const documentText = `${priorStatement};\nEX`;
          const offset = documentText.length;

          // Create a schema cache with some procedures
          const schemaCache = createMockSchemaCache({
            procedures: [
              { schema: 'dbo', name: 'GetUsers' },
              { schema: 'dbo', name: 'UpdateOrder' },
            ],
          });

          // Get completions — should return keyword completions (EXEC, EXECUTE, etc.)
          // NOT stored procedure completions
          const items = getCompletions(documentText, offset, schemaCache, true);

          // The result should contain keyword items matching "EX" prefix
          const keywordItems = items.filter(item => item.kind === 14); // CompletionItemKind.Keyword = 14
          const procItems = items.filter(item => item.detail === 'Stored Procedure');

          // Should have keyword completions (EXEC, EXECUTE, EXISTS, EXCEPT)
          expect(keywordItems.length).toBeGreaterThan(0);
          // Should NOT have stored procedure completions
          expect(procItems.length).toBe(0);
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Bug 1.3: INTO Keyword Suggested After SELECT *
   *
   * When the user types `SELECT * ` (star-only select list with trailing space),
   * the contextual keywords should NOT include INTO. Only FROM and WHERE should
   * be suggested. Similarly for `SELECT TOP N * `.
   *
   * On unfixed code: INTO is unconditionally included in the SELECT successors
   * because there is no check for star-only select lists.
   *
   * **Validates: Requirements 1.3**
   */
  it('Bug 1.3: SELECT * should not suggest INTO keyword', () => {
    fc.assert(
      fc.property(
        fc.constant(null), // Simple case: SELECT *
        () => {
          const textBeforeCursor = 'SELECT * ';
          const context: CompletionContext = 'SELECT';

          // Call getContextualKeywords directly
          const items = getContextualKeywords(context, textBeforeCursor);
          const labels = items.map(item => item.label as string);

          // INTO should NOT be in the suggestions after SELECT *
          expect(labels).not.toContain('INTO');
          // FROM and WHERE should still be suggested
          expect(labels).toContain('FROM');
        }
      ),
      { numRuns: 1 }
    );
  });

  it('Bug 1.3: SELECT TOP N * should not suggest INTO keyword', () => {
    fc.assert(
      fc.property(
        arbitraryTopN,
        (topN) => {
          const textBeforeCursor = `SELECT TOP ${topN} * `;
          const context: CompletionContext = 'SELECT';

          // Call getContextualKeywords directly
          const items = getContextualKeywords(context, textBeforeCursor);
          const labels = items.map(item => item.label as string);

          // INTO should NOT be in the suggestions after SELECT TOP N *
          expect(labels).not.toContain('INTO');
          // FROM and WHERE should still be suggested
          expect(labels).toContain('FROM');
        }
      ),
      { numRuns: 50 }
    );
  });

  it('Bug 1.3: SELECT * with presentClauses should not suggest INTO keyword', () => {
    fc.assert(
      fc.property(
        arbitraryTopN,
        (topN) => {
          const textBeforeCursor = `SELECT TOP ${topN} * `;
          const context: CompletionContext = 'SELECT';

          // Also test with presentClauses (clause-flow state machine path)
          const presentClauses: ClausePresenceSet = new Set(['SELECT']);
          const items = getContextualKeywords(context, textBeforeCursor, presentClauses);
          const labels = items.map(item => item.label as string);

          // INTO should NOT be in the suggestions after SELECT *
          expect(labels).not.toContain('INTO');
          // FROM should still be suggested
          expect(labels).toContain('FROM');
        }
      ),
      { numRuns: 50 }
    );
  });
});
