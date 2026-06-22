import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  getCompletions,
  getContextualKeywords,
  CompletionContext,
  ClausePresenceSet,
} from '../../server/src/completionProvider';
import { ISchemaCache, ProcedureInfo } from '../../server/src/schemaCache';
import * as mssql from 'mssql';

/**
 * Preservation Property Tests — EXEC/Keyword/SELECT Bugs
 *
 * **Property 2: Preservation** — Non-Prefixed EXEC, Same-Statement EXEC,
 * Named Column INTO, and Disconnected Keywords
 *
 * These tests capture CORRECT behavior on UNFIXED code that must NOT regress
 * after the fix is applied. They are expected to PASS on the current code.
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.11**
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

/** Generator: random EXEC variant keyword */
const arbitraryExecKeyword: fc.Arbitrary<string> = fc.constantFrom(
  'EXEC', 'EXECUTE', 'exec', 'execute', 'Exec'
);

/** Generator: random valid SQL column name (alphanumeric, starts with letter) */
const arbitraryColumnName: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')),
      { minLength: 1, maxLength: 10 }
    )
  )
  .map(([first, rest]) => first + rest);

/** Generator: random non-empty column list (1 to 4 columns, comma-separated) */
const arbitraryColumnList: fc.Arbitrary<string> = fc
  .array(arbitraryColumnName, { minLength: 1, maxLength: 4 })
  .map(cols => cols.join(', '));

/** Generator: random keyword prefix (1-4 uppercase letters that match at least one SQL keyword) */
const arbitraryKeywordPrefix: fc.Arbitrary<string> = fc.constantFrom(
  'S', 'SE', 'SEL', 'SELE',
  'E', 'EX', 'EXE', 'EXEC',
  'I', 'IN', 'INS', 'INSE',
  'U', 'UP', 'UPD', 'UPDA',
  'D', 'DE', 'DEC', 'DECL',
  'W', 'WH', 'WHE', 'WHER',
  'C', 'CR', 'CRE', 'CREA',
  'A', 'AL', 'ALT', 'ALTE',
  'G', 'GO',
  'T', 'TR', 'TRA', 'TRAN',
);

// --- Tests ---

describe('Preservation: EXEC/Keyword/SELECT Bugs', () => {
  /**
   * Property: For all non-dot prefixes in EXEC context, procedure items have
   * NO `insertText` override (full `schema.name` label is used).
   *
   * This preserves the correct behavior where typing `EXEC ` (without schema prefix)
   * and selecting a procedure inserts the full `schema.name` label.
   *
   * **Validates: Requirements 3.1, 3.2**
   */
  it('Preservation: non-prefixed EXEC completions have no insertText override', () => {
    fc.assert(
      fc.property(
        arbitraryExecKeyword,
        arbitrarySchemaName,
        arbitraryProcName,
        fc.array(fc.tuple(arbitrarySchemaName, arbitraryProcName), { minLength: 0, maxLength: 3 }),
        (execKeyword, schema, procName, extraProcs) => {
          // Create procedures in the schema cache
          const procs: ProcedureInfo[] = [
            { schema, name: procName },
            ...extraProcs.map(([s, n]) => ({ schema: s, name: n })),
          ];
          const schemaCache = createMockSchemaCache({ procedures: procs });

          // Simulate typing `EXEC ` (no dot in prefix — just the EXEC keyword with trailing space)
          const textBeforeCursor = `${execKeyword} `;
          const documentText = textBeforeCursor;
          const offset = documentText.length;

          // Get completions in connected mode
          const items = getCompletions(documentText, offset, schemaCache, true);

          // Filter to procedure items
          const procItems = items.filter(item => item.detail === 'Stored Procedure');

          // There should be procedure items returned
          expect(procItems.length).toBeGreaterThan(0);

          // For all procedure items, insertText should be undefined (no override)
          // The full label (schema.name) is used as-is by VS Code
          for (const item of procItems) {
            expect(item.insertText).toBeUndefined();
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: For all inputs where EXEC/EXECUTE is in the current statement text,
   * context detection returns EXEC and procedure completions are provided.
   *
   * This preserves the correct behavior where typing `EXEC ` immediately after
   * the EXEC keyword (same statement) returns stored procedure completions.
   *
   * **Validates: Requirements 3.5, 3.6**
   */
  it('Preservation: same-statement EXEC returns procedure completions', () => {
    fc.assert(
      fc.property(
        arbitraryExecKeyword,
        arbitrarySchemaName,
        arbitraryProcName,
        (execKeyword, schema, procName) => {
          // Create a schema cache with at least one procedure
          const schemaCache = createMockSchemaCache({
            procedures: [{ schema, name: procName }],
          });

          // Simulate typing `EXEC ` in the same statement (no prior statements)
          const documentText = `${execKeyword} `;
          const offset = documentText.length;

          // Get completions in connected mode
          const items = getCompletions(documentText, offset, schemaCache, true);

          // Should return procedure completions (not keyword completions)
          const procItems = items.filter(item => item.detail === 'Stored Procedure');
          expect(procItems.length).toBeGreaterThan(0);

          // Verify the procedure item has the expected label format
          const expectedLabel = `${schema}.${procName}`;
          const matchingItem = procItems.find(item => item.label === expectedLabel);
          expect(matchingItem).toBeDefined();
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: For all non-star column lists (e.g., `SELECT col1`, `SELECT a, b`),
   * INTO is included in contextual keyword suggestions.
   *
   * This preserves the correct behavior where `SELECT col1 INTO #temp FROM ...`
   * is a valid T-SQL pattern and INTO should be suggested after named columns.
   *
   * **Validates: Requirements 3.7, 3.11**
   */
  it('Preservation: named column SELECT includes INTO in keyword suggestions', () => {
    fc.assert(
      fc.property(
        arbitraryColumnList,
        (columnList) => {
          const textBeforeCursor = `SELECT ${columnList} `;
          const context: CompletionContext = 'SELECT';

          // Call getContextualKeywords directly (fallback path, no presentClauses)
          const items = getContextualKeywords(context, textBeforeCursor);
          const labels = items.map(item => item.label as string);

          // INTO should be in the suggestions after named columns
          expect(labels).toContain('INTO');
          // FROM and WHERE should also be present
          expect(labels).toContain('FROM');
          expect(labels).toContain('WHERE');
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: For all non-star column lists with presentClauses (clause-flow path),
   * INTO is included in contextual keyword suggestions.
   *
   * **Validates: Requirements 3.7, 3.11**
   */
  it('Preservation: named column SELECT with presentClauses includes INTO', () => {
    fc.assert(
      fc.property(
        arbitraryColumnList,
        (columnList) => {
          const textBeforeCursor = `SELECT ${columnList} `;
          const context: CompletionContext = 'SELECT';
          const presentClauses: ClausePresenceSet = new Set(['SELECT']);

          // Call getContextualKeywords with presentClauses (clause-flow state machine path)
          const items = getContextualKeywords(context, textBeforeCursor, presentClauses);
          const labels = items.map(item => item.label as string);

          // INTO should be in the suggestions after named columns
          expect(labels).toContain('INTO');
          // FROM should also be present
          expect(labels).toContain('FROM');
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: For all inputs in disconnected mode, keyword completions are
   * returned matching the prefix.
   *
   * This preserves the correct behavior where disconnected mode always returns
   * keyword completions regardless of what text is typed.
   *
   * **Validates: Requirements 3.3, 3.4**
   */
  it('Preservation: disconnected mode returns keyword completions for any prefix', () => {
    fc.assert(
      fc.property(
        arbitraryKeywordPrefix,
        (prefix) => {
          const documentText = prefix;
          const offset = documentText.length;

          // Get completions in disconnected mode (no schema cache)
          const items = getCompletions(documentText, offset, null, false);

          // Should return keyword completions matching the prefix
          expect(items.length).toBeGreaterThan(0);

          // All items should be keywords, built-in functions, or snippets
          for (const item of items) {
            expect(item.kind).toSatisfy(
              (kind: number) => kind === 14 || kind === 3 || kind === 15, // Keyword=14, Function=3, Snippet=15
            );
          }

          // All returned items should match the prefix (case-insensitive)
          // Snippet items use filterText for matching, not label
          const lowerPrefix = prefix.toLowerCase();
          for (const item of items) {
            if (item.kind === 15) continue; // Snippets use filterText, not label
            const label = (item.label as string).toLowerCase();
            expect(label.startsWith(lowerPrefix)).toBe(true);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});
