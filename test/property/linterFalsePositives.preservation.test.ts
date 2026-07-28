import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { lintObjectReferences, ObjectReferenceLinterContext } from '../../server/src/objectReferenceLinter';
import { semanticLint } from '../../server/src/semanticLinter';
import { lintEnhancedSyntax, EnhancedSyntaxLinterContext } from '../../server/src/enhancedSyntaxLinter';
import { ISchemaCache, TableInfo, ForeignKeyInfo } from '../../server/src/schemaCache';
import * as mssql from 'mssql';

/**
 * Preservation Property Tests — Linter False Positives Bugfix
 *
 * **Property 2: Preservation** — Genuinely Invalid SQL Still Flagged
 *
 * These tests capture existing CORRECT behavior on UNFIXED code.
 * They MUST PASS on unfixed code — passing confirms baseline behavior to preserve.
 * After the fix is applied, these tests are re-run to verify no regressions.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

// --- Helpers ---

function createMockSchemaCache(options: {
  tables?: TableInfo[];
}): ISchemaCache {
  return {
    tables: options.tables ?? [],
    views: [],
    procedures: [],
    foreignKeys: [],
    isPopulating: false,
    refresh: async (_pool: mssql.ConnectionPool) => {},
    getForeignKeysForTable: (_schema: string, _tableName: string): ForeignKeyInfo[] => [],
    getPrimaryKeyColumns: (_schema: string, _tableName: string): string[] => [],
  };
}

// --- Generators ---

/** Generator: random table alias that IS defined (single letter) */
const arbitraryDefinedAlias: fc.Arbitrary<string> = fc.constantFrom('a', 'b', 'c', 'd', 'e');

/** Generator: random table name for schema cache */
const arbitraryTableName: fc.Arbitrary<string> = fc.constantFrom(
  'Employees', 'Orders', 'Customers', 'Products', 'Invoices'
);

/** Generator: fake function names that are genuinely unrecognized */
const arbitraryFakeFunction: fc.Arbitrary<string> = fc.constantFrom(
  'FAKEFUNC', 'BLAHBLAH', 'NOTREAL', 'BROKENFN', 'XYZFUNC',
  'MISSINGFN', 'BADCALL', 'NOPEFUNC'
);

/** Generator: table names that do NOT exist in the schema cache */
const arbitraryNonExistentTable: fc.Arbitrary<string> = fc.constantFrom(
  'NonExistentTable', 'FakeTable', 'MissingTable', 'GhostTable',
  'NoSuchTable', 'PhantomTable', 'BogusTable'
);

// --- Tests ---

describe('Preservation Property Tests: Genuinely Invalid SQL Still Flagged', () => {
  describe('ORL002 Preservation: Invalid column on known alias still flagged', () => {
    /**
     * Validates: Requirements 3.1
     *
     * When a column reference uses a KNOWN alias but references a column that does NOT
     * exist on the resolved table, ORL002 must still be emitted. This ensures the fix
     * for Bug 1 (alias resolution) does not suppress warnings for truly non-existent columns.
     *
     * Note: The current code skips validation entirely for unknown aliases (with comment
     * "table may already be flagged"). ORL002 is only emitted for known aliases with
     * non-existent columns. This preservation test captures that actual behavior.
     */

    it('SELECT a.NonExistentCol FROM Employees a → ORL002 emitted for column not on table', () => {
      fc.assert(
        fc.property(
          arbitraryDefinedAlias,
          fc.constantFrom('FakeCol', 'BadColumn', 'NoSuchField', 'MissingProp', 'XyzColumn'),
          arbitraryTableName,
          (alias, fakeColumn, tableName) => {
            const sql = `SELECT ${alias}.${fakeColumn} FROM ${tableName} ${alias}`;

            const schemaCache = createMockSchemaCache({
              tables: [{
                schema: 'dbo',
                name: tableName,
                columns: [
                  { name: 'Id', dataType: 'int', isNullable: false },
                  { name: 'Name', dataType: 'nvarchar', isNullable: false },
                  { name: 'Email', dataType: 'nvarchar', isNullable: true },
                ],
              }],
            });

            const context: ObjectReferenceLinterContext = {
              schemaCache,
              isConnected: true,
              isRefreshing: false,
            };

            const diagnostics = lintObjectReferences(sql, 0, context);
            const orl002Diagnostics = diagnostics.filter(d => d.code === 'ORL002');

            // ORL002 MUST be emitted — column doesn't exist on the resolved table
            expect(orl002Diagnostics.length).toBeGreaterThan(0);
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  describe('E004 Preservation: ORDER BY in subquery without TOP/OFFSET still flagged', () => {
    /**
     * Validates: Requirements 3.2
     *
     * When ORDER BY appears in a subquery without TOP or OFFSET, and is NOT inside
     * an OVER clause, E004 must still be emitted.
     */

    it('SELECT * FROM (SELECT id FROM t ORDER BY id) sub → E004 emitted', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('id', 'name', 'created_date', 'amount', 'status'),
          fc.constantFrom('t', 'orders', 'employees', 'items'),
          (column, table) => {
            const sql = `SELECT * FROM (SELECT ${column} FROM ${table} ORDER BY ${column}) sub`;

            const diagnostics = semanticLint(sql, 0);
            const e004Diagnostics = diagnostics.filter(d => d.code === 'E004');

            // E004 MUST be emitted — ORDER BY in subquery without TOP/OFFSET
            expect(e004Diagnostics.length).toBeGreaterThan(0);
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  describe('ESL003 Preservation: Genuinely unrecognized functions still flagged', () => {
    /**
     * Validates: Requirements 3.3
     *
     * When a genuinely unrecognized function name is called in connected mode,
     * ESL003 must still be emitted.
     */

    it('SELECT FAKEFUNC(x) in connected mode → ESL003 emitted', () => {
      fc.assert(
        fc.property(
          arbitraryFakeFunction,
          fc.constantFrom('x', '1', 'col1', 'Name'),
          (fakeFunc, arg) => {
            const sql = `SELECT ${fakeFunc}(${arg})`;

            const schemaCache = createMockSchemaCache({
              tables: [{
                schema: 'dbo',
                name: 'Employees',
                columns: [{ name: 'Id', dataType: 'int', isNullable: false }],
              }],
            });

            const context: EnhancedSyntaxLinterContext = {
              schemaCache,
              isConnected: true,
            };

            const diagnostics = lintEnhancedSyntax(sql, 0, context);
            const esl003Diagnostics = diagnostics.filter(d => d.code === 'ESL003');

            // ESL003 MUST be emitted for genuinely unrecognized function names
            expect(esl003Diagnostics.length).toBeGreaterThan(0);
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  describe('ORL001 Preservation: Tables not in schema cache still flagged', () => {
    /**
     * Validates: Requirements 3.4
     *
     * When a table reference does not exist in the schema cache (whether bracketed or not),
     * ORL001 must still be emitted.
     */

    it('SELECT * FROM NonExistentTable → ORL001 emitted', () => {
      fc.assert(
        fc.property(
          arbitraryNonExistentTable,
          (tableName) => {
            const sql = `SELECT * FROM ${tableName}`;

            // Schema cache does NOT contain the referenced table
            const schemaCache = createMockSchemaCache({
              tables: [{
                schema: 'dbo',
                name: 'Employees',
                columns: [{ name: 'Id', dataType: 'int', isNullable: false }],
              }],
            });

            const context: ObjectReferenceLinterContext = {
              schemaCache,
              isConnected: true,
              isRefreshing: false,
            };

            const diagnostics = lintObjectReferences(sql, 0, context);
            const orl001Diagnostics = diagnostics.filter(d => d.code === 'ORL001');

            // ORL001 MUST be emitted — table not in schema cache
            expect(orl001Diagnostics.length).toBeGreaterThan(0);
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  describe('ESL001 Preservation: Invalid keyword sequences at paren depth 0 still flagged', () => {
    /**
     * Validates: Requirements 3.6
     *
     * When invalid keyword sequences occur at top-level (paren depth 0),
     * ESL001 must still be emitted. For example, SELECT immediately followed by FROM.
     */

    it('SELECT FROM Employees → ESL001 emitted', () => {
      fc.assert(
        fc.property(
          arbitraryTableName,
          (tableName) => {
            // SELECT immediately followed by FROM — missing column list
            const sql = `SELECT FROM ${tableName}`;

            const context: EnhancedSyntaxLinterContext = {
              schemaCache: null,
              isConnected: false,
            };

            const diagnostics = lintEnhancedSyntax(sql, 0, context);
            const esl001Diagnostics = diagnostics.filter(d => d.code === 'ESL001');

            // ESL001 MUST be emitted — invalid keyword sequence at paren depth 0
            expect(esl001Diagnostics.length).toBeGreaterThan(0);
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  describe('E004 Non-OVER Preservation: ORDER BY at paren depth > 0 without TOP/OFFSET, not in OVER', () => {
    /**
     * Validates: Requirements 3.5
     *
     * ORDER BY at paren depth > 0 without TOP/OFFSET that is genuinely NOT inside
     * an OVER clause must still be flagged with E004.
     */

    it('subquery ORDER BY without TOP/OFFSET and not in OVER → E004 emitted', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('id', 'name', 'created_date', 'price', 'qty'),
          fc.constantFrom('t1', 'orders', 'products', 'users'),
          fc.constantFrom('a', 'b', 'sub', 'derived'),
          (column, table, alias) => {
            // Subquery with ORDER BY but no TOP/OFFSET and definitely not in OVER
            const sql = `SELECT * FROM (SELECT ${column} FROM ${table} ORDER BY ${column}) ${alias}`;

            const diagnostics = semanticLint(sql, 0);
            const e004Diagnostics = diagnostics.filter(d => d.code === 'E004');

            // E004 MUST be emitted — ORDER BY in non-OVER subquery without TOP/OFFSET
            expect(e004Diagnostics.length).toBeGreaterThan(0);
          }
        ),
        { numRuns: 20 }
      );
    });
  });
});
