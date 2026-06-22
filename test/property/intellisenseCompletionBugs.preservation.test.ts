import { describe, it, beforeAll, expect } from 'vitest';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';
import * as vsctm from 'vscode-textmate';
import * as oniguruma from 'vscode-oniguruma';
import {
  detectContext,
  getContextualKeywords,
  detectCTEChain,
  getCompletions,
  CompletionContext,
  ClausePresenceSet,
} from '../../server/src/completionProvider';
import { ISchemaCache, TableInfo, ViewInfo, ProcedureInfo } from '../../server/src/schemaCache';
import * as mssql from 'mssql';

/**
 * Preservation Property Tests — IntelliSense Completion Bugs
 *
 * **Property 2: Preservation** — Non-Bug-Condition Completion Behavior Unchanged
 *
 * These tests capture existing CORRECT behavior on UNFIXED code.
 * They MUST PASS on unfixed code — passing confirms baseline behavior to preserve.
 * After the fix is applied, these tests are re-run to verify no regressions.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8
 */

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

/** Generator: random valid SQL identifier (not a keyword) */
const arbitraryIdentifier: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')),
      { minLength: 1, maxLength: 10 }
    )
  )
  .map(([first, rest]) => first + rest)
  .filter((id) => !/^(select|from|where|join|inner|left|right|full|cross|on|order|group|having|exec|execute|insert|update|delete|create|alter|drop|begin|end|if|else|while|return|declare|set|union|all|except|intersect|into|values|as|and|or|not|in|exists|between|like|is|null|case|when|then|distinct|top|with|go|use|by|print)$/i.test(id));

/** Generator: random schema name */
const arbitrarySchemaName: fc.Arbitrary<string> = fc.constantFrom('dbo', 'sales', 'hr', 'admin', 'app', 'staging');

/** Generator: random temp table name (#name or ##name) */
const arbitraryTempTableName: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('#', '##'),
    arbitraryIdentifier
  )
  .map(([prefix, name]) => prefix + name);

/** Generator: CTE name (valid identifier) */
const arbitraryCTEName: fc.Arbitrary<string> = arbitraryIdentifier;

/** Generator: random number of CTEs (1-4) with unique names */
const arbitraryCTENames: fc.Arbitrary<string[]> = fc
  .array(arbitraryCTEName, { minLength: 1, maxLength: 4 })
  .map((names) => [...new Set(names)])
  .filter((names) => names.length >= 1);

// --- Tests ---

describe('Preservation Property Tests: IntelliSense Completion Bugs', () => {
  beforeAll(async () => {
    grammar = await createGrammar();
  });

  describe('Property: For all existing context patterns, detectContext() returns the correct context', () => {
    /**
     * Validates: Requirements 3.1, 3.2, 3.5, 3.8
     *
     * Observed on UNFIXED code:
     * - detectContext('SELECT * FROM ') returns 'FROM'
     * - detectContext('SELECT ') returns 'SELECT'
     * - detectContext('EXEC ') returns 'EXEC'
     *
     * Property: For all existing context patterns (FROM, JOIN, SELECT, WHERE, ORDER_BY, GROUP_BY, EXEC, CTE),
     * detectContext() returns the correct context.
     */

    it('FROM context detected for all FROM-ending inputs', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          arbitraryIdentifier,
          (schema, table) => {
            // Various FROM patterns
            const inputs = [
              'SELECT * FROM ',
              `SELECT ${table} FROM `,
              `SELECT * FROM ${schema}.${table}, `,
            ];
            for (const input of inputs) {
              expect(detectContext(input)).toBe('FROM');
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('SELECT context detected for all SELECT-ending inputs', () => {
      fc.assert(
        fc.property(
          arbitraryIdentifier,
          (col) => {
            const inputs = [
              'SELECT ',
              `SELECT ${col}, `,
              'SELECT DISTINCT ',
              'SELECT TOP 10 ',
            ];
            for (const input of inputs) {
              expect(detectContext(input)).toBe('SELECT');
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('EXEC context detected for all EXEC/EXECUTE inputs', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('EXEC ', 'EXECUTE ', 'exec ', 'execute ', 'Exec ', 'Execute '),
          (input) => {
            expect(detectContext(input)).toBe('EXEC');
          }
        ),
        { numRuns: 20 }
      );
    });

    it('JOIN context detected for all JOIN-ending inputs', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          arbitraryIdentifier,
          fc.constantFrom(
            'JOIN ',
            'INNER JOIN ',
            'LEFT JOIN ',
            'RIGHT JOIN ',
            'FULL JOIN ',
            'CROSS JOIN ',
            'LEFT OUTER JOIN ',
            'RIGHT OUTER JOIN ',
            'FULL OUTER JOIN '
          ),
          (schema, table, joinKeyword) => {
            const input = `SELECT * FROM ${schema}.${table} ${joinKeyword}`;
            expect(detectContext(input)).toBe('JOIN');
          }
        ),
        { numRuns: 50 }
      );
    });

    it('WHERE context detected for all WHERE-ending inputs', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          arbitraryIdentifier,
          (schema, table) => {
            const inputs = [
              `SELECT * FROM ${schema}.${table} WHERE `,
              `SELECT * FROM ${schema}.${table} WHERE col1 = 1 AND `,
            ];
            for (const input of inputs) {
              expect(detectContext(input)).toBe('WHERE');
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('ORDER_BY context detected for all ORDER BY-ending inputs', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          arbitraryIdentifier,
          (schema, table) => {
            const input = `SELECT * FROM ${schema}.${table} ORDER BY `;
            expect(detectContext(input)).toBe('ORDER_BY');
          }
        ),
        { numRuns: 50 }
      );
    });

    it('GROUP_BY context detected for all GROUP BY-ending inputs', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          arbitraryIdentifier,
          (schema, table) => {
            const input = `SELECT * FROM ${schema}.${table} GROUP BY `;
            expect(detectContext(input)).toBe('GROUP_BY');
          }
        ),
        { numRuns: 50 }
      );
    });

    it('CTE context detected for WITH <name> AS patterns', () => {
      fc.assert(
        fc.property(
          arbitraryIdentifier,
          (cteName) => {
            const input = `WITH ${cteName} AS `;
            expect(detectContext(input)).toBe('CTE');
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe('Property: For all FROM-context inputs at whitespace boundary, JOIN variants and clause keywords remain in suggestions', () => {
    /**
     * Validates: Requirements 3.6
     *
     * Observed on UNFIXED code:
     * getContextualKeywords('FROM', ...) includes JOIN, INNER JOIN, LEFT JOIN, RIGHT JOIN, FULL JOIN, WHERE, GROUP BY, ORDER BY
     *
     * Property: For all FROM-context inputs at whitespace boundary,
     * JOIN/INNER JOIN/LEFT JOIN/RIGHT JOIN/FULL JOIN/WHERE/GROUP BY/ORDER BY remain in suggestions.
     */

    it('FROM context with clause-flow returns expected successor keywords', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          arbitraryIdentifier,
          (schema, table) => {
            const text = `SELECT * FROM ${schema}.${table} `;
            const presentClauses: ClausePresenceSet = new Set(['SELECT', 'FROM']);

            const items = getContextualKeywords('FROM', text, presentClauses);
            const labels = items.map(i => i.label as string);

            // These must all be present (preservation requirement)
            expect(labels).toContain('JOIN');
            expect(labels).toContain('INNER JOIN');
            expect(labels).toContain('LEFT JOIN');
            expect(labels).toContain('RIGHT JOIN');
            expect(labels).toContain('FULL JOIN');
            expect(labels).toContain('WHERE');
            expect(labels).toContain('GROUP BY');
            expect(labels).toContain('ORDER BY');
          }
        ),
        { numRuns: 50 }
      );
    });

    it('FROM context fallback (no presentClauses) returns expected keywords', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          arbitraryIdentifier,
          (schema, table) => {
            const text = `SELECT * FROM ${schema}.${table} `;

            // Fallback path: no presentClauses
            const items = getContextualKeywords('FROM', text);
            const labels = items.map(i => i.label as string);

            // Fallback includes WHERE and JOIN variants
            expect(labels).toContain('WHERE');
            expect(labels).toContain('JOIN');
            expect(labels).toContain('INNER JOIN');
            expect(labels).toContain('LEFT JOIN');
            expect(labels).toContain('RIGHT JOIN');
            expect(labels).toContain('FULL JOIN');
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe('Property: For all CTE chains where cursor is inside consuming statement, CTE names are available', () => {
    /**
     * Validates: Requirements 3.3
     *
     * Observed on UNFIXED code:
     * detectCTEChain() returns inCTEChain: true with CTE names when cursor is inside consuming statement
     *
     * Property: For all CTE chains where cursor is inside consuming statement, CTE names are available.
     */

    it('single CTE: cursor in consuming statement returns CTE name', () => {
      fc.assert(
        fc.property(
          arbitraryCTEName,
          (cteName) => {
            const statement = `WITH ${cteName} AS (SELECT 1 AS id) SELECT * FROM `;
            const cursorOffset = statement.length;

            const result = detectCTEChain(statement, cursorOffset);

            expect(result.inCTEChain).toBe(true);
            expect(result.availableNames).toContain(cteName);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('multiple CTEs: cursor in consuming statement returns all CTE names', () => {
      fc.assert(
        fc.property(
          arbitraryCTENames,
          (cteNames) => {
            if (cteNames.length < 2) return; // Need at least 2 for multi-CTE

            // Build a multi-CTE statement
            const cteDefs = cteNames.map(name => `${name} AS (SELECT 1 AS id)`).join(', ');
            const statement = `WITH ${cteDefs} SELECT * FROM `;
            const cursorOffset = statement.length;

            const result = detectCTEChain(statement, cursorOffset);

            expect(result.inCTEChain).toBe(true);
            // All CTE names should be available in the consuming statement
            for (const name of cteNames) {
              expect(result.availableNames).toContain(name);
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('CTE: cursor inside second CTE body returns first CTE name only', () => {
      fc.assert(
        fc.property(
          arbitraryCTENames,
          (cteNames) => {
            if (cteNames.length < 2) return;

            // Build statement with cursor inside the second CTE body
            const firstCte = `${cteNames[0]} AS (SELECT 1 AS id)`;
            const secondCteStart = `${cteNames[1]} AS (SELECT * FROM `;
            const statement = `WITH ${firstCte}, ${secondCteStart}`;
            const cursorOffset = statement.length;

            const result = detectCTEChain(statement, cursorOffset);

            expect(result.inCTEChain).toBe(true);
            // Only the first CTE name should be available inside the second CTE body
            expect(result.availableNames).toContain(cteNames[0]);
            expect(result.availableNames).not.toContain(cteNames[1]);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe('Property: For all #table/##globalTemp patterns, TextMate grammar assigns entity.name.table.temp.sql scope', () => {
    /**
     * Validates: Requirements 3.4
     *
     * Observed on UNFIXED code:
     * TextMate grammar assigns entity.name.table.temp.sql to #tempTable and ##globalTemp
     *
     * Property: For all #table/##globalTemp patterns, TextMate grammar assigns entity.name.table.temp.sql scope.
     */

    it('temp table names receive entity.name.table.temp.sql scope', () => {
      fc.assert(
        fc.property(arbitraryTempTableName, (tempName) => {
          const line = `SELECT * FROM ${tempName}`;
          const result = tokenizeLine(line);

          const hasTempScope = result.tokens.some(
            (t) =>
              line.substring(t.startIndex, t.endIndex).includes(tempName) &&
              t.scopes.some((s) => s === 'entity.name.table.temp.sql')
          );
          expect(hasTempScope).toBe(true);
        }),
        { numRuns: 100 }
      );
    });

    it('temp table names in various SQL contexts receive correct scope', () => {
      fc.assert(
        fc.property(
          arbitraryTempTableName,
          fc.constantFrom(
            'INSERT INTO ',
            'DELETE FROM ',
            'SELECT * FROM ',
            'DROP TABLE ',
            'CREATE TABLE '
          ),
          (tempName, prefix) => {
            const line = `${prefix}${tempName}`;
            const result = tokenizeLine(line);

            const hasTempScope = result.tokens.some(
              (t) =>
                line.substring(t.startIndex, t.endIndex).includes(tempName) &&
                t.scopes.some((s) => s === 'entity.name.table.temp.sql')
            );
            expect(hasTempScope).toBe(true);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe('Property: For all WHERE-context inputs without a complete condition, AND/OR are NOT suggested', () => {
    /**
     * Validates: Requirements 3.7
     *
     * Observed on UNFIXED code:
     * getContextualKeywords('WHERE', 'SELECT * FROM t WHERE ', ...) does NOT include AND or OR (no complete condition)
     *
     * Property: For all WHERE-context inputs without a complete condition, AND/OR are NOT suggested.
     */

    it('WHERE context without complete condition does not suggest AND/OR (clause-flow path)', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          arbitraryIdentifier,
          (schema, table) => {
            // Text with WHERE but no complete condition (just "WHERE " with no col=val)
            const text = `SELECT * FROM ${schema}.${table} WHERE `;
            const presentClauses: ClausePresenceSet = new Set(['SELECT', 'FROM', 'WHERE']);

            const items = getContextualKeywords('WHERE', text, presentClauses);
            const labels = items.map(i => i.label as string);

            // AND and OR should NOT be in suggestions when there's no complete condition
            expect(labels).not.toContain('AND');
            expect(labels).not.toContain('OR');
          }
        ),
        { numRuns: 50 }
      );
    });

    it('WHERE context without complete condition does not suggest AND/OR (fallback path)', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          arbitraryIdentifier,
          (schema, table) => {
            // Text with WHERE but no complete condition
            const text = `SELECT * FROM ${schema}.${table} WHERE `;

            // Fallback path: no presentClauses
            const items = getContextualKeywords('WHERE', text);
            const labels = items.map(i => i.label as string);

            // AND and OR should NOT be in suggestions
            expect(labels).not.toContain('AND');
            expect(labels).not.toContain('OR');
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe('Property: For all EXEC/EXECUTE inputs, stored procedure completions are returned', () => {
    /**
     * Validates: Requirements 3.5
     *
     * Property: For all EXEC/EXECUTE inputs, stored procedure completions are returned.
     */

    it('EXEC with trailing space returns stored procedure completions', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          fc.array(arbitraryIdentifier, { minLength: 1, maxLength: 5 }),
          (schema, procNames) => {
            const uniqueNames = [...new Set(procNames)];
            if (uniqueNames.length === 0) return;

            const procedures: ProcedureInfo[] = uniqueNames.map(name => ({
              schema,
              name,
            }));

            const schemaCache = createMockSchemaCache({ procedures });

            const text = 'EXEC ';
            const items = getCompletions(text, text.length, schemaCache, true);

            const labels = items.map(i => i.label as string);

            // All procedures should appear as schema.name
            for (const proc of procedures) {
              expect(labels).toContain(`${proc.schema}.${proc.name}`);
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('EXECUTE with trailing space returns stored procedure completions', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          fc.array(arbitraryIdentifier, { minLength: 1, maxLength: 3 }),
          (schema, procNames) => {
            const uniqueNames = [...new Set(procNames)];
            if (uniqueNames.length === 0) return;

            const procedures: ProcedureInfo[] = uniqueNames.map(name => ({
              schema,
              name,
            }));

            const schemaCache = createMockSchemaCache({ procedures });

            const text = 'EXECUTE ';
            const items = getCompletions(text, text.length, schemaCache, true);

            const labels = items.map(i => i.label as string);

            for (const proc of procedures) {
              expect(labels).toContain(`${proc.schema}.${proc.name}`);
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('EXEC with mixed case returns stored procedure completions', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('exec ', 'Exec ', 'EXEC ', 'ExEc '),
          arbitrarySchemaName,
          arbitraryIdentifier,
          (execKeyword, schema, procName) => {
            const procedures: ProcedureInfo[] = [{ schema, name: procName }];
            const schemaCache = createMockSchemaCache({ procedures });

            const text = execKeyword;
            const items = getCompletions(text, text.length, schemaCache, true);

            const labels = items.map(i => i.label as string);
            expect(labels).toContain(`${schema}.${procName}`);
          }
        ),
        { numRuns: 30 }
      );
    });
  });
});
