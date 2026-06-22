import { describe, it, beforeAll, expect } from 'vitest';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';
import * as vsctm from 'vscode-textmate';
import * as oniguruma from 'vscode-oniguruma';
import {
  detectContext,
  getCompletions,
  getContextualKeywords,
  detectCTEChain,
  extractCurrentStatement,
  ClausePresenceSet,
} from '../../server/src/completionProvider';
import { ISchemaCache, TableInfo, ViewInfo, ProcedureInfo } from '../../server/src/schemaCache';
import * as mssql from 'mssql';

/**
 * Bug Condition Exploration Property Tests — IntelliSense Completion Bugs
 *
 * **Property 1: Bug Condition** — IntelliSense Completion Bugs
 * (UPDATE, CROSS JOIN, CTE Leak, Variables, DECLARE, WHERE AND/OR)
 *
 * CRITICAL: These tests encode the EXPECTED (correct) behavior.
 * They are EXPECTED TO FAIL on unfixed code — failure confirms the bugs exist.
 * DO NOT fix the code or modify the tests when they fail.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6**
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

// --- Grammar loading helpers ---

const wasmBin = fs.readFileSync(
  path.resolve(__dirname, '../../node_modules/vscode-oniguruma/release/onig.wasm')
);

const onigLib: vsctm.IOnigLib = oniguruma.loadWASM(wasmBin.buffer).then(() => ({
  createOnigScanner: (patterns: string[]) => new oniguruma.OnigScanner(patterns),
  createOnigString: (s: string) => new oniguruma.OnigString(s),
})) as unknown as vsctm.IOnigLib;

const grammarPath = path.resolve(__dirname, '../../syntaxes/tsql.tmLanguage.json');
const grammarContent = fs.readFileSync(grammarPath, 'utf-8');

let grammar: vsctm.IGrammar;

async function createGrammar(): Promise<vsctm.IGrammar> {
  const registry = new vsctm.Registry({
    onigLib: Promise.resolve(await onigLib),
    loadGrammar: async (scopeName: string) => {
      if (scopeName === 'source.sql') {
        return vsctm.parseRawGrammar(grammarContent, grammarPath);
      }
      return null;
    },
  });
  const g = await registry.loadGrammar('source.sql');
  if (!g) throw new Error('Failed to load grammar');
  return g;
}

function tokenizeLine(line: string, prevState: vsctm.StateStack | null = null) {
  return grammar.tokenizeLine(line, prevState ?? vsctm.INITIAL);
}

// --- Generators ---

/** Generator: random valid SQL schema name */
const arbitrarySchemaName: fc.Arbitrary<string> = fc.constantFrom(
  'dbo', 'sales', 'hr', 'admin', 'app', 'staging'
);

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
  .filter((id) => !/^(select|from|where|join|inner|left|right|full|cross|on|order|group|having|exec|execute|insert|update|delete|create|alter|drop|begin|end|with|as|declare|set|and|or)$/i.test(id));

/** Generator: random valid SQL variable name (local) */
const arbitraryVariableName: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')),
      { minLength: 1, maxLength: 12 }
    )
  )
  .map(([first, rest]) => '@' + first + rest);

/** Generator: random system variable name */
const arbitrarySystemVariable: fc.Arbitrary<string> = fc.constantFrom(
  '@@ROWCOUNT', '@@IDENTITY', '@@ERROR', '@@TRANCOUNT',
  '@@FETCH_STATUS', '@@SPID', '@@VERSION', '@@SERVERNAME'
);

// --- Tests ---

describe('Bug Condition Exploration: IntelliSense Completion Bugs', () => {
  beforeAll(async () => {
    grammar = await createGrammar();
  });

  describe('Bug 1 — UPDATE context: detectContext and getCompletions', () => {
    /**
     * Validates: Requirements 1.1
     *
     * When the user types `UPDATE ` (UPDATE keyword followed by a space),
     * detectContext() MUST return 'UPDATE' and getCompletions() MUST return
     * table/view completions from the schema cache.
     *
     * On unfixed code: detectContext('UPDATE ') returns 'NONE' because there
     * is no UPDATE pattern in the patterns array.
     */

    it('detectContext("UPDATE ") returns "UPDATE"', () => {
      const context = detectContext('UPDATE ');
      expect(context).toBe('UPDATE');
    });

    it('getCompletions returns table/view items for UPDATE context', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          arbitraryTableName,
          (schema, tableName) => {
            const schemaCache = createMockSchemaCache({
              tables: [
                { schema, name: tableName, columns: [{ name: 'Id', dataType: 'int', isNullable: false }] },
              ],
              views: [
                { schema, name: `v_${tableName}`, columns: [{ name: 'Id', dataType: 'int', isNullable: false }] },
              ],
            });

            const text = 'UPDATE ';
            const items = getCompletions(text, text.length, schemaCache, true);

            // Should contain table/view items (Module kind with Table/View detail)
            const tableViewItems = items.filter(
              (item) => item.detail === 'Table' || item.detail === 'View'
            );
            expect(tableViewItems.length).toBeGreaterThan(0);
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  describe('Bug 2 — CROSS JOIN in FROM: must NOT appear in FROM context keywords', () => {
    /**
     * Validates: Requirements 1.2
     *
     * When the user is in a FROM context and contextual keywords are requested,
     * CROSS JOIN must NOT be in the result labels. CROSS JOIN should only appear
     * in JOIN context.
     *
     * On unfixed code: CROSS JOIN is included in VALID_SUCCESSORS['FROM'] and
     * in the fallback branch of getContextualKeywords() for FROM context.
     */

    it('getContextualKeywords("FROM", ...) does NOT include CROSS JOIN', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          arbitraryTableName,
          (schema, tableName) => {
            const textBeforeCursor = `SELECT * FROM ${schema}.${tableName} `;
            const presentClauses: ClausePresenceSet = new Set(['SELECT', 'FROM']);

            const items = getContextualKeywords('FROM', textBeforeCursor, presentClauses);
            const labels = items.map((item) => item.label as string);

            expect(labels).not.toContain('CROSS JOIN');
          }
        ),
        { numRuns: 30 }
      );
    });

    it('concrete case: CROSS JOIN not in FROM fallback keywords', () => {
      const textBeforeCursor = 'SELECT * FROM dbo.Users ';
      // Call without presentClauses to trigger fallback branch
      const items = getContextualKeywords('FROM', textBeforeCursor);
      const labels = items.map((item) => item.label as string);

      expect(labels).not.toContain('CROSS JOIN');
    });
  });

  describe('Bug 3 — CTE leak: CTE names must NOT be available after consuming statement', () => {
    /**
     * Validates: Requirements 1.3
     *
     * When a CTE-consuming statement is complete (terminated by semicolon)
     * and the cursor is in a new statement, detectCTEChain() MUST return
     * { inCTEChain: false, availableNames: [] }.
     *
     * On unfixed code: CTE names leak into subsequent statements because
     * extractCurrentStatement() or detectCTEChain() doesn't properly bound
     * CTE scope at statement termination.
     */

    it('detectCTEChain returns inCTEChain: false for text after consuming statement', () => {
      fc.assert(
        fc.property(
          arbitraryTableName,
          (cteName) => {
            // Full document: CTE block + consuming statement + semicolon + new statement
            const fullText = `WITH ${cteName} AS (SELECT 1) SELECT * FROM ${cteName};\nSELECT * FROM `;

            // Extract the current statement for the cursor at the end
            const cursorOffset = fullText.length;
            const currentStatement = extractCurrentStatement(fullText, cursorOffset);
            const cursorOffsetInStatement = currentStatement.length;

            const cteChain = detectCTEChain(currentStatement, cursorOffsetInStatement);

            expect(cteChain.inCTEChain).toBe(false);
            expect(cteChain.availableNames).toHaveLength(0);
          }
        ),
        { numRuns: 30 }
      );
    });

    it('concrete case: CTE "cte" not available in second statement after semicolon', () => {
      const fullText = 'WITH cte AS (SELECT 1) SELECT * FROM cte;\nSELECT * FROM ';
      const cursorOffset = fullText.length;
      const currentStatement = extractCurrentStatement(fullText, cursorOffset);
      const cursorOffsetInStatement = currentStatement.length;

      const cteChain = detectCTEChain(currentStatement, cursorOffsetInStatement);

      expect(cteChain.inCTEChain).toBe(false);
      expect(cteChain.availableNames).toHaveLength(0);
    });
  });

  describe('Bug 4 — Variable highlighting: @var and @@var must receive variable scopes', () => {
    /**
     * Validates: Requirements 1.4
     *
     * When the user types a SQL variable (@variableName or @@globalVariable),
     * the TextMate grammar MUST assign a scope containing 'variable.other.sql'
     * (for local variables) or 'variable.language.sql' (for system variables).
     *
     * On unfixed code: the grammar has no rule matching @variable patterns,
     * so variables receive no distinct scope.
     */

    it('local variables (@name) receive variable.other.sql scope', () => {
      fc.assert(
        fc.property(
          arbitraryVariableName,
          (varName) => {
            const line = `SELECT ${varName} `;
            const result = tokenizeLine(line);

            const hasVariableScope = result.tokens.some(
              (t) =>
                line.substring(t.startIndex, t.endIndex).includes(varName) &&
                t.scopes.some((s) => s === 'variable.other.sql')
            );

            expect(hasVariableScope).toBe(true);
          }
        ),
        { numRuns: 30 }
      );
    });

    it('system variables (@@name) receive variable.language.sql scope', () => {
      fc.assert(
        fc.property(
          arbitrarySystemVariable,
          (sysVar) => {
            const line = `SELECT ${sysVar} `;
            const result = tokenizeLine(line);

            const hasVariableScope = result.tokens.some(
              (t) =>
                line.substring(t.startIndex, t.endIndex).includes(sysVar) &&
                t.scopes.some((s) => s === 'variable.language.sql')
            );

            expect(hasVariableScope).toBe(true);
          }
        ),
        { numRuns: 20 }
      );
    });

    it('concrete case: @myVar gets variable.other.sql scope', () => {
      const line = 'SELECT @myVar';
      const result = tokenizeLine(line);

      const hasVariableScope = result.tokens.some(
        (t) =>
          line.substring(t.startIndex, t.endIndex).includes('@myVar') &&
          t.scopes.some((s) => s === 'variable.other.sql')
      );

      expect(hasVariableScope).toBe(true);
    });

    it('concrete case: @@ROWCOUNT gets variable.language.sql scope', () => {
      const line = 'SELECT @@ROWCOUNT';
      const result = tokenizeLine(line);

      const hasVariableScope = result.tokens.some(
        (t) =>
          line.substring(t.startIndex, t.endIndex).includes('@@ROWCOUNT') &&
          t.scopes.some((s) => s === 'variable.language.sql')
      );

      expect(hasVariableScope).toBe(true);
    });
  });

  describe('Bug 5 — DECLARE context: detectContext and getCompletions', () => {
    /**
     * Validates: Requirements 1.5
     *
     * When the user types `DECLARE @count ` (DECLARE keyword followed by a
     * variable name and space), detectContext() MUST return 'DECLARE' and
     * getCompletions() MUST return data type keyword completions.
     *
     * On unfixed code: detectContext('DECLARE @count ') returns 'NONE' because
     * there is no DECLARE pattern in the patterns array.
     */

    it('detectContext("DECLARE @count ") returns "DECLARE"', () => {
      const context = detectContext('DECLARE @count ');
      expect(context).toBe('DECLARE');
    });

    it('getCompletions returns data type keywords for DECLARE context', () => {
      fc.assert(
        fc.property(
          arbitraryVariableName,
          (varName) => {
            const schemaCache = createMockSchemaCache({
              tables: [
                { schema: 'dbo', name: 'Users', columns: [{ name: 'Id', dataType: 'int', isNullable: false }] },
              ],
            });

            const text = `DECLARE ${varName} `;
            const items = getCompletions(text, text.length, schemaCache, true);

            // Should contain data type keywords like INT, VARCHAR, NVARCHAR, etc.
            const labels = items.map((item) => (item.label as string).toUpperCase());
            const hasDataTypes = labels.some((label) =>
              ['INT', 'VARCHAR', 'NVARCHAR', 'BIT', 'DATETIME', 'BIGINT', 'DECIMAL', 'FLOAT'].includes(label)
            );

            expect(hasDataTypes).toBe(true);
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  describe('Bug 6 — WHERE AND/OR: must appear after complete condition', () => {
    /**
     * Validates: Requirements 1.6
     *
     * When the user has typed a WHERE clause with a complete condition
     * (e.g., `WHERE col1 = 1 `), getContextualKeywords() MUST include
     * AND and OR as keyword completions.
     *
     * On unfixed code: VALID_SUCCESSORS['WHERE'] only contains
     * ['GROUP BY', 'ORDER BY'] — no AND or OR.
     */

    it('getContextualKeywords("WHERE", ...) includes AND and OR after complete condition', () => {
      fc.assert(
        fc.property(
          arbitraryTableName,
          (colName) => {
            const textBeforeCursor = `SELECT * FROM dbo.Users WHERE ${colName} = 1 `;
            const presentClauses: ClausePresenceSet = new Set(['SELECT', 'FROM', 'WHERE']);

            const items = getContextualKeywords('WHERE', textBeforeCursor, presentClauses);
            const labels = items.map((item) => item.label as string);

            expect(labels).toContain('AND');
            expect(labels).toContain('OR');
          }
        ),
        { numRuns: 30 }
      );
    });

    it('concrete case: AND and OR in WHERE keywords after "WHERE col1 = 1 "', () => {
      const textBeforeCursor = 'SELECT * FROM dbo.Users WHERE col1 = 1 ';
      const presentClauses: ClausePresenceSet = new Set(['SELECT', 'FROM', 'WHERE']);

      const items = getContextualKeywords('WHERE', textBeforeCursor, presentClauses);
      const labels = items.map((item) => item.label as string);

      expect(labels).toContain('AND');
      expect(labels).toContain('OR');
    });
  });
});
