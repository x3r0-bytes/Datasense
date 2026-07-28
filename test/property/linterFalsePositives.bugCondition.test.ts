import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { semanticLint } from '../../server/src/semanticLinter';
import { lintObjectReferences } from '../../server/src/objectReferenceLinter';
import { lintEnhancedSyntax } from '../../server/src/enhancedSyntaxLinter';
import { ISchemaCache, TableInfo, ViewInfo, ProcedureInfo, ForeignKeyInfo } from '../../server/src/schemaCache';
import * as mssql from 'mssql';

/**
 * Bug Condition Exploration Property Tests — Linter False Positives
 *
 * **Property 1: Bug Condition** — Linter False Positive Diagnostics
 *
 * CRITICAL: These tests encode the EXPECTED (correct) behavior.
 * They are EXPECTED TO FAIL on unfixed code — failure confirms the bugs exist.
 * DO NOT fix the code or modify the tests when they fail.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
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
    getPrimaryKeyColumns: (_schema: string, _tableName: string) => [],
  };
}

// --- Generators ---

/** Generator: random valid single-letter alias */
const arbitraryAlias: fc.Arbitrary<string> = fc.constantFrom(
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'm', 'n', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z'
);

/** Generator: random valid SQL identifier (table name) */
const arbitraryTableName: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
      { minLength: 2, maxLength: 10 }
    )
  )
  .map(([first, rest]) => first + rest)
  .filter((id) => !/^(select|from|where|join|inner|left|right|full|cross|on|order|group|having|exec|execute|insert|update|delete|create|alter|drop|begin|end|with|as|top|by|set|into|values|declare|table|index|view|grant|revoke|over|partition)$/i.test(id));

/** Generator: random valid column name */
const arbitraryColumnName: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')),
      { minLength: 2, maxLength: 10 }
    )
  )
  .map(([first, rest]) => first + rest)
  .filter((id) => !/^(select|from|where|join|inner|left|right|full|cross|on|order|group|having|exec|execute|insert|update|delete|create|alter|drop|begin|end|with|as|top|by|set|into|values|declare|table|index|view)$/i.test(id));

/** Generator: random TOP value */
const arbitraryTopN: fc.Arbitrary<number> = fc.integer({ min: 1, max: 1000 });

/** Generator: random valid T-SQL data types that take size params */
const arbitraryDataTypeWithParams: fc.Arbitrary<string> = fc.constantFrom(
  'VARCHAR', 'NVARCHAR', 'CHAR', 'NCHAR', 'DECIMAL', 'NUMERIC', 'FLOAT', 'VARBINARY', 'BINARY', 'DATETIME2', 'DATETIMEOFFSET', 'TIME'
);

/** Generator: random data type size parameter */
const arbitraryDataTypeSize: fc.Arbitrary<string> = fc.oneof(
  fc.integer({ min: 1, max: 8000 }).map(n => `${n}`),
  fc.constant('MAX'),
  fc.tuple(fc.integer({ min: 1, max: 38 }), fc.integer({ min: 0, max: 18 })).map(([p, s]) => `${p},${s}`)
);

/** Generator: date/time function names for use in PARTITION BY */
const arbitraryDateFunction: fc.Arbitrary<string> = fc.constantFrom(
  'YEAR', 'MONTH', 'DAY', 'DATEPART'
);

/** Generator: window functions */
const arbitraryWindowFunction: fc.Arbitrary<string> = fc.constantFrom(
  'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE'
);

// --- Tests ---

describe('Bug Condition Exploration: Linter False Positives', () => {
  describe('Bug 1 (ORL002) — Alias-qualified column references should not be flagged', () => {
    /**
     * Validates: Requirements 1.1
     *
     * When a query uses a table alias (e.g., `SELECT a.Name FROM Employees a`) and the
     * column exists on the aliased table in the schema cache, ORL002 should NOT be emitted.
     *
     * On unfixed code: ORL002 is incorrectly produced because the alias is not resolved
     * to the underlying table's column set.
     */

    it('alias-qualified column references do not produce ORL002 when column exists on resolved table', () => {
      fc.assert(
        fc.property(
          arbitraryAlias,
          arbitraryTableName,
          arbitraryColumnName,
          (alias, tableName, columnName) => {
            // Ensure alias and tableName are distinct
            if (alias.toLowerCase() === tableName.toLowerCase()) return;

            const schemaCache = createMockSchemaCache({
              tables: [
                {
                  schema: 'dbo',
                  name: tableName,
                  columns: [
                    { name: columnName, dataType: 'varchar', isNullable: true },
                    { name: 'Id', dataType: 'int', isNullable: false },
                  ],
                },
              ],
            });

            const sql = `SELECT ${alias}.${columnName} FROM ${tableName} ${alias}`;

            const diagnostics = lintObjectReferences(sql, 0, {
              schemaCache,
              isConnected: true,
              isRefreshing: false,
            });

            // Filter for ORL002 diagnostics
            const orl002 = diagnostics.filter(d => d.code === 'ORL002');

            // Should NOT produce ORL002 — the alias resolves to the table which has the column
            expect(orl002).toHaveLength(0);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('concrete case: SELECT a.Name FROM Employees a — no ORL002', () => {
      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'Employees',
            columns: [
              { name: 'Name', dataType: 'varchar', isNullable: true },
              { name: 'Id', dataType: 'int', isNullable: false },
            ],
          },
        ],
      });

      const sql = 'SELECT a.Name FROM Employees a';

      const diagnostics = lintObjectReferences(sql, 0, {
        schemaCache,
        isConnected: true,
        isRefreshing: false,
      });

      const orl002 = diagnostics.filter(d => d.code === 'ORL002');
      expect(orl002).toHaveLength(0);
    });
  });

  describe('Bug 2 (E004) — ORDER BY in subquery with TOP should not be flagged', () => {
    /**
     * Validates: Requirements 1.2
     *
     * When a subquery contains ORDER BY accompanied by TOP, E004 should NOT be emitted.
     *
     * On unfixed code: E004 is incorrectly produced because the linter doesn't properly
     * detect TOP in the enclosing SELECT of the subquery.
     */

    it('ORDER BY in subquery with TOP does not produce E004', () => {
      fc.assert(
        fc.property(
          arbitraryTopN,
          arbitraryColumnName,
          arbitraryTableName,
          (topN, colName, tableName) => {
            const sql = `SELECT * FROM (SELECT TOP ${topN} ${colName} FROM ${tableName} ORDER BY ${colName}) sub`;

            const diagnostics = semanticLint(sql);

            // Filter for E004 diagnostics
            const e004 = diagnostics.filter(d => d.code === 'E004');

            // Should NOT produce E004 — ORDER BY is valid with TOP
            expect(e004).toHaveLength(0);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('concrete case: SELECT * FROM (SELECT TOP 5 id FROM t ORDER BY id) sub — no E004', () => {
      const sql = 'SELECT * FROM (SELECT TOP 5 id FROM t ORDER BY id) sub';

      const diagnostics = semanticLint(sql);
      const e004 = diagnostics.filter(d => d.code === 'E004');

      expect(e004).toHaveLength(0);
    });
  });

  describe('Bug 3 (ESL003) — Data types with parens should not be flagged as functions', () => {
    /**
     * Validates: Requirements 1.3
     *
     * When a DECLARE statement or DDL uses a data type with parentheses (e.g., VARCHAR(50)),
     * ESL003 should NOT be emitted.
     *
     * On unfixed code: ESL003 is incorrectly produced because the data type check fails
     * in connected mode.
     */

    it('data types with size parameters in DECLARE do not produce ESL003', () => {
      fc.assert(
        fc.property(
          arbitraryDataTypeWithParams,
          arbitraryDataTypeSize,
          (dataType, size) => {
            // Only use single-value sizes for types that don't support precision/scale
            const nonPrecisionTypes = ['VARCHAR', 'NVARCHAR', 'CHAR', 'NCHAR', 'VARBINARY', 'BINARY', 'DATETIME2', 'DATETIMEOFFSET', 'TIME'];
            const effectiveSize = nonPrecisionTypes.includes(dataType) && size.includes(',')
              ? size.split(',')[0]
              : size;

            const sql = `DECLARE @v ${dataType}(${effectiveSize})`;

            const schemaCache = createMockSchemaCache({
              tables: [
                { schema: 'dbo', name: 'Dummy', columns: [{ name: 'Id', dataType: 'int', isNullable: false }] },
              ],
            });

            const diagnostics = lintEnhancedSyntax(sql, 0, {
              schemaCache,
              isConnected: true,
            });

            // Filter for ESL003 diagnostics referencing the data type
            const esl003 = diagnostics.filter(d =>
              d.code === 'ESL003' && d.message?.toLowerCase().includes(dataType.toLowerCase())
            );

            // Should NOT produce ESL003 — these are valid data types, not functions
            expect(esl003).toHaveLength(0);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('concrete case: DECLARE @v VARCHAR(50) — no ESL003', () => {
      const schemaCache = createMockSchemaCache({
        tables: [
          { schema: 'dbo', name: 'Dummy', columns: [{ name: 'Id', dataType: 'int', isNullable: false }] },
        ],
      });

      const sql = 'DECLARE @v VARCHAR(50)';

      const diagnostics = lintEnhancedSyntax(sql, 0, {
        schemaCache,
        isConnected: true,
      });

      const esl003 = diagnostics.filter(d =>
        d.code === 'ESL003' && d.message?.toLowerCase().includes('varchar')
      );

      expect(esl003).toHaveLength(0);
    });
  });

  describe('Bug 4 (ORL001) — Bracketed identifiers should match schema cache', () => {
    /**
     * Validates: Requirements 1.4
     *
     * When a query uses bracketed identifiers (e.g., [dbo].[Employees]) and the stripped
     * identifier exists in the schema cache, ORL001 should NOT be emitted.
     *
     * On unfixed code: ORL001 is incorrectly produced because bracket-stripping fails
     * for multi-part names.
     */

    it('bracketed schema.table references do not produce ORL001 when table exists in cache', () => {
      fc.assert(
        fc.property(
          arbitraryTableName,
          arbitraryColumnName,
          (tableName, columnName) => {
            const schemaCache = createMockSchemaCache({
              tables: [
                {
                  schema: 'dbo',
                  name: tableName,
                  columns: [
                    { name: columnName, dataType: 'varchar', isNullable: true },
                    { name: 'Id', dataType: 'int', isNullable: false },
                  ],
                },
              ],
            });

            const sql = `SELECT * FROM [dbo].[${tableName}]`;

            const diagnostics = lintObjectReferences(sql, 0, {
              schemaCache,
              isConnected: true,
              isRefreshing: false,
            });

            // Filter for ORL001 diagnostics
            const orl001 = diagnostics.filter(d => d.code === 'ORL001');

            // Should NOT produce ORL001 — the bracketed identifier resolves to a cached table
            expect(orl001).toHaveLength(0);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('concrete case: SELECT * FROM [dbo].[Employees] — no ORL001', () => {
      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'Employees',
            columns: [
              { name: 'Name', dataType: 'varchar', isNullable: true },
              { name: 'Id', dataType: 'int', isNullable: false },
            ],
          },
        ],
      });

      const sql = 'SELECT * FROM [dbo].[Employees]';

      const diagnostics = lintObjectReferences(sql, 0, {
        schemaCache,
        isConnected: true,
        isRefreshing: false,
      });

      const orl001 = diagnostics.filter(d => d.code === 'ORL001');
      expect(orl001).toHaveLength(0);
    });
  });

  describe('Bug 5 (E004) — ORDER BY in OVER clause with nested functions should not be flagged', () => {
    /**
     * Validates: Requirements 1.5
     *
     * When ORDER BY appears inside an OVER() clause whose PARTITION BY contains
     * function calls (e.g., YEAR(hire_date)), E004 should NOT be emitted.
     *
     * On unfixed code: E004 is incorrectly produced because isInsideOverClause's backward
     * scan stops at the function call's opening paren instead of OVER's paren.
     */

    it('ORDER BY in OVER clause with PARTITION BY containing function calls does not produce E004', () => {
      fc.assert(
        fc.property(
          arbitraryWindowFunction,
          arbitraryDateFunction,
          arbitraryColumnName,
          arbitraryColumnName,
          (windowFn, dateFn, partCol, orderCol) => {
            // Ensure columns are different
            if (partCol.toLowerCase() === orderCol.toLowerCase()) return;

            const sql = `SELECT ${windowFn}() OVER (PARTITION BY ${dateFn}(${partCol}) ORDER BY ${orderCol}) FROM Employees`;

            const diagnostics = semanticLint(sql);

            // Filter for E004 diagnostics
            const e004 = diagnostics.filter(d => d.code === 'E004');

            // Should NOT produce E004 — ORDER BY inside OVER() is valid
            expect(e004).toHaveLength(0);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('concrete case: ROW_NUMBER() OVER (PARTITION BY YEAR(hire_date) ORDER BY salary) — no E004', () => {
      const sql = 'SELECT ROW_NUMBER() OVER (PARTITION BY YEAR(hire_date) ORDER BY salary) FROM Employees';

      const diagnostics = semanticLint(sql);
      const e004 = diagnostics.filter(d => d.code === 'E004');

      expect(e004).toHaveLength(0);
    });
  });

  describe('Bug 6 (E012) — TOP without ORDER BY should not produce a warning', () => {
    /**
     * Validates: Requirements 1.6
     *
     * When a query uses SELECT TOP N without ORDER BY, E012 should NOT be emitted.
     * The warning is deemed unhelpful noise for exploratory queries.
     *
     * On unfixed code: E012 warning is produced.
     */

    it('SELECT TOP N without ORDER BY does not produce E012', () => {
      fc.assert(
        fc.property(
          arbitraryTopN,
          arbitraryTableName,
          (topN, tableName) => {
            const sql = `SELECT TOP ${topN} * FROM ${tableName}`;

            const diagnostics = semanticLint(sql);

            // Filter for E012 diagnostics
            const e012 = diagnostics.filter(d => d.code === 'E012');

            // Should NOT produce E012 — TOP without ORDER BY is valid exploratory SQL
            expect(e012).toHaveLength(0);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('concrete case: SELECT TOP 10 * FROM Employees — no E012', () => {
      const sql = 'SELECT TOP 10 * FROM Employees';

      const diagnostics = semanticLint(sql);
      const e012 = diagnostics.filter(d => d.code === 'E012');

      expect(e012).toHaveLength(0);
    });
  });
});
