import { describe, it, beforeAll, expect } from 'vitest';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';
import * as vsctm from 'vscode-textmate';
import * as oniguruma from 'vscode-oniguruma';

/**
 * Property-based tests for T-SQL TextMate grammar (Properties 1-5)
 * Validates: Requirements 1.3, 1.4, 1.5, 1.6, 1.7, 1.8
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
const grammarJson = JSON.parse(grammarContent);

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

/**
 * Tokenize a single line and return all tokens with their scopes.
 */
function tokenizeLine(line: string, prevState: vsctm.StateStack | null = null) {
  const result = grammar.tokenizeLine(line, prevState ?? vsctm.INITIAL);
  return result;
}

/**
 * Check if any token in the line has the given scope.
 */
function lineHasScope(line: string, scope: string, prevState?: vsctm.StateStack | null): boolean {
  const result = tokenizeLine(line, prevState ?? null);
  return result.tokens.some((t) =>
    t.scopes.some((s) => s.includes(scope))
  );
}

/**
 * Get the scope of the token that covers a specific character offset.
 */
function getScopesAtOffset(line: string, offset: number, prevState?: vsctm.StateStack | null): string[] {
  const result = tokenizeLine(line, prevState ?? null);
  for (const token of result.tokens) {
    if (offset >= token.startIndex && offset < token.endIndex) {
      return token.scopes;
    }
  }
  return [];
}

// --- Generators ---

const DML_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL',
  'OUTER', 'CROSS', 'ON', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN',
  'LIKE', 'IS', 'NULL', 'AS', 'ORDER', 'BY', 'GROUP', 'HAVING', 'UNION',
  'ALL', 'INTERSECT', 'EXCEPT', 'INSERT', 'INTO', 'VALUES', 'UPDATE',
  'SET', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TABLE', 'VIEW', 'INDEX',
  'PROCEDURE', 'FUNCTION', 'TRIGGER', 'BEGIN', 'END', 'IF', 'ELSE',
  'WHILE', 'RETURN', 'DECLARE', 'EXEC', 'EXECUTE', 'CASE', 'WHEN',
  'THEN', 'DISTINCT', 'ASC', 'DESC', 'OVER', 'PARTITION', 'OFFSET',
  'FETCH', 'NEXT', 'ROWS', 'ONLY', 'WITH', 'TIES', 'PERCENT'
];

const SQL_SERVER_KEYWORDS = [
  'TOP', 'NOLOCK', 'MERGE', 'PIVOT', 'UNPIVOT',
  'OUTPUT', 'INSERTED', 'DELETED', 'READUNCOMMITTED',
  'READCOMMITTED', 'REPEATABLEREAD', 'SERIALIZABLE', 'SNAPSHOT',
  'ROWLOCK', 'PAGELOCK', 'TABLOCK', 'TABLOCKX', 'UPDLOCK', 'XLOCK',
  'HOLDLOCK', 'NOWAIT', 'IDENTITY', 'NEWSEQUENTIALID'
];

const BUILTIN_FUNCTIONS = [
  'ISNULL', 'COALESCE', 'CONVERT', 'CAST', 'DATEADD', 'DATEDIFF',
  'STRING_AGG', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'LAG',
  'LEAD', 'FIRST_VALUE', 'LAST_VALUE', 'COUNT', 'SUM', 'AVG', 'MIN',
  'MAX', 'LEN', 'CHARINDEX', 'SUBSTRING', 'REPLACE', 'UPPER', 'LOWER',
  'TRIM', 'LTRIM', 'RTRIM', 'GETDATE', 'GETUTCDATE', 'SYSDATETIME',
  'DATEDIFF_BIG', 'DATEPART', 'DATENAME', 'EOMONTH', 'FORMAT',
  'TRY_CONVERT', 'TRY_CAST', 'IIF', 'CHOOSE', 'STUFF', 'CONCAT',
  'CONCAT_WS', 'JSON_VALUE', 'JSON_QUERY', 'OPENJSON', 'ISJSON',
  'NEWID', 'SCOPE_IDENTITY', 'OBJECT_ID', 'DB_NAME', 'SCHEMA_NAME',
  'USER_NAME'
];

/** Randomize case of a string: each character randomly upper or lower */
function randomizeCase(s: string): fc.Arbitrary<string> {
  return fc.array(fc.boolean(), { minLength: s.length, maxLength: s.length }).map((bools) =>
    s
      .split('')
      .map((ch, i) => (bools[i] ? ch.toUpperCase() : ch.toLowerCase()))
      .join('')
  );
}

/** Generator: random T-SQL keyword (DML or SQL Server-specific) in random case */
const arbitraryTSqlKeyword: fc.Arbitrary<{ keyword: string; scope: string }> = fc.oneof(
  fc.constantFrom(...DML_KEYWORDS).chain((kw) =>
    randomizeCase(kw).map((cased) => ({ keyword: cased, scope: 'keyword.other.DML.sql' }))
  ),
  fc.constantFrom(...SQL_SERVER_KEYWORDS).chain((kw) =>
    randomizeCase(kw).map((cased) => ({ keyword: cased, scope: 'keyword.other.sql-server.sql' }))
  )
);

/** Generator: random built-in function name in random case */
const arbitraryBuiltinFunction: fc.Arbitrary<string> = fc
  .constantFrom(...BUILTIN_FUNCTIONS)
  .chain((fn) => randomizeCase(fn));

/** Generator: random valid SQL identifier (starts with letter/underscore, alphanumeric) */
const arbitraryIdentifier: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')),
      { minLength: 0, maxLength: 20 }
    )
  )
  .map(([first, rest]) => first + rest);

/** Generator: random temp table name (#name or ##name) */
const arbitraryTempTableName: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('#', '##'),
    arbitraryIdentifier
  )
  .map(([prefix, name]) => prefix + name);

/** Generator: random bracket-delimited identifier */
const arbitraryBracketedIdentifier: fc.Arbitrary<string> = fc
  .stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 !@#$%^&*()-_=+;:\'",.<>?/'.split('')
    ),
    { minLength: 1, maxLength: 30 }
  )
  .filter((s) => !s.includes(']')) // brackets inside would break the pattern
  .map((s) => `[${s}]`);

// --- Tests ---

describe('T-SQL TextMate Grammar Property Tests', () => {
  beforeAll(async () => {
    grammar = await createGrammar();
  });

  describe('Property 1: Case-insensitive keyword and function recognition', () => {
    /**
     * Validates: Requirements 1.3, 1.7
     *
     * For any T-SQL keyword or built-in function written in any case combination,
     * the grammar SHALL assign the correct scope.
     */
    it('keywords in any case receive correct keyword scope', () => {
      fc.assert(
        fc.property(arbitraryTSqlKeyword, ({ keyword, scope }) => {
          // Place keyword in a simple context so it's recognized as a standalone word
          const line = `${keyword} `;
          const result = tokenizeLine(line);
          const hasCorrectScope = result.tokens.some(
            (t) =>
              line.substring(t.startIndex, t.endIndex).trim() === keyword &&
              t.scopes.some((s) => s === scope)
          );
          expect(hasCorrectScope).toBe(true);
        }),
        { numRuns: 200 }
      );
    });

    it('built-in functions in any case receive support.function.sql scope', () => {
      fc.assert(
        fc.property(arbitraryBuiltinFunction, (fn) => {
          // Place function in a context where it's a standalone word
          const line = `${fn}(`;
          const result = tokenizeLine(line);
          const hasCorrectScope = result.tokens.some(
            (t) =>
              line.substring(t.startIndex, t.endIndex).includes(fn) &&
              t.scopes.some((s) => s === 'support.function.sql')
          );
          expect(hasCorrectScope).toBe(true);
        }),
        { numRuns: 200 }
      );
    });
  });

  describe('Property 2: CTE WITH disambiguation', () => {
    /**
     * Validates: Requirements 1.4
     *
     * WITH...AS patterns get keyword.other.cte.sql scope.
     * WITH in table hint context does NOT get that scope.
     */
    it('WITH <identifier> AS ( receives keyword.other.cte.sql scope', () => {
      fc.assert(
        fc.property(arbitraryIdentifier, (id) => {
          const line = `WITH ${id} AS (`;
          const result = tokenizeLine(line);
          const withToken = result.tokens.find(
            (t) => line.substring(t.startIndex, t.endIndex).trim().toUpperCase() === 'WITH'
          );
          expect(withToken).toBeDefined();
          expect(withToken!.scopes).toContain('keyword.other.cte.sql');
        }),
        { numRuns: 100 }
      );
    });

    it('WITH in table hint context does NOT receive keyword.other.cte.sql scope', () => {
      fc.assert(
        fc.property(arbitraryIdentifier, (tableName) => {
          // Table hint context: FROM table WITH (NOLOCK)
          const line = `FROM ${tableName} WITH (NOLOCK)`;
          const result = tokenizeLine(line);
          // Find the WITH token
          const withTokens = result.tokens.filter(
            (t) => line.substring(t.startIndex, t.endIndex).trim().toUpperCase() === 'WITH'
          );
          // None of the WITH tokens should have CTE scope
          for (const wt of withTokens) {
            expect(wt.scopes).not.toContain('keyword.other.cte.sql');
          }
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 3: Temporary table identifier tokenization', () => {
    /**
     * Validates: Requirements 1.5
     *
     * Identifiers prefixed with # or ## get entity.name.table.temp.sql scope.
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
  });

  describe('Property 4: Square bracket delimited identifier recognition', () => {
    /**
     * Validates: Requirements 1.6
     *
     * Any string enclosed in square brackets gets entity.name.bracket.sql scope.
     */
    it('bracket-delimited identifiers receive entity.name.bracket.sql scope', () => {
      fc.assert(
        fc.property(arbitraryBracketedIdentifier, (bracketId) => {
          const line = `SELECT ${bracketId} FROM table1`;
          const result = tokenizeLine(line);
          const hasBracketScope = result.tokens.some(
            (t) =>
              line.substring(t.startIndex, t.endIndex) === bracketId &&
              t.scopes.some((s) => s === 'entity.name.bracket.sql')
          );
          expect(hasBracketScope).toBe(true);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 5: GO batch separator context sensitivity', () => {
    /**
     * Validates: Requirements 1.8
     *
     * GO on its own line gets keyword.control.batch.sql scope.
     * GO within other text does NOT get that scope.
     */
    it('GO as sole content on a line receives keyword.control.batch.sql scope', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('GO', 'go', 'Go', 'gO'),
          fc.stringOf(fc.constantFrom(' ', '\t'), { minLength: 0, maxLength: 5 }),
          fc.stringOf(fc.constantFrom(' ', '\t'), { minLength: 0, maxLength: 5 }),
          (goVariant, leadingWs, trailingWs) => {
            const line = `${leadingWs}${goVariant}${trailingWs}`;
            const result = tokenizeLine(line);
            const hasGoScope = result.tokens.some((t) =>
              t.scopes.some((s) => s === 'keyword.control.batch.sql')
            );
            expect(hasGoScope).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('GO within other text does NOT receive keyword.control.batch.sql scope', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('GO', 'go', 'Go', 'gO'),
          arbitraryIdentifier,
          (goVariant, extraText) => {
            // GO preceded by non-whitespace text
            const line = `SELECT ${extraText} ${goVariant} something`;
            const result = tokenizeLine(line);
            // Find tokens that contain "GO" text
            const goTokens = result.tokens.filter((t) => {
              const text = line.substring(t.startIndex, t.endIndex);
              return text.trim().toUpperCase() === goVariant.toUpperCase();
            });
            // None should have the batch separator scope
            for (const gt of goTokens) {
              expect(gt.scopes).not.toContain('keyword.control.batch.sql');
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
