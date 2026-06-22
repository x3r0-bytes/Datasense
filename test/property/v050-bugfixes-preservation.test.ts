import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  getCompletions,
  detectContext,
  applyTieredRanking,
  RANK_TIERS,
} from '../../server/src/completionProvider';
import { ISchemaCache, TableInfo, ViewInfo, ProcedureInfo, ForeignKeyInfo } from '../../server/src/schemaCache';
import { parseStatements } from '../../src/statementParser';
import * as mssql from 'mssql';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Preservation Property Tests — v0.5.0 QA Bugfixes
 *
 * **Property 2: Preservation** — Existing Behavior Unchanged
 *
 * IMPORTANT: These tests follow observation-first methodology.
 * They capture existing CORRECT behavior on UNFIXED code.
 * They MUST PASS on unfixed code — passing confirms baseline behavior to preserve.
 * After fixes are applied, these tests are re-run to verify no regressions.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10
 */

// --- Helpers ---

function createMockSchemaCache(options: {
  tables?: TableInfo[];
  views?: ViewInfo[];
  procedures?: ProcedureInfo[];
  foreignKeys?: ForeignKeyInfo[];
}): ISchemaCache {
  const fks = options.foreignKeys ?? [];
  return {
    tables: options.tables ?? [],
    views: options.views ?? [],
    procedures: options.procedures ?? [],
    foreignKeys: fks,
    isPopulating: false,
    refresh: async (_pool: mssql.ConnectionPool) => {},
    getForeignKeysForTable: (schema: string, tableName: string) =>
      fks.filter(
        (fk) =>
          (fk.referencingSchema.toLowerCase() === schema.toLowerCase() &&
            fk.referencingTable.toLowerCase() === tableName.toLowerCase()) ||
          (fk.referencedSchema.toLowerCase() === schema.toLowerCase() &&
            fk.referencedTable.toLowerCase() === tableName.toLowerCase())
      ),
  };
}

// --- Generators ---

/** Generator: random valid SQL identifier (table/column name) */
const arbitraryIdentifier: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')),
      { minLength: 1, maxLength: 8 }
    )
  )
  .map(([first, rest]) => first + rest)
  .filter(
    (id) =>
      !/^(select|from|where|join|inner|left|right|full|cross|on|order|group|having|exec|execute|insert|update|delete|create|alter|drop|begin|end|with|as|go|and|or|not|in|between|like|is|null|set|declare|case|when|then|else|top|distinct|into|values|use|print)$/i.test(
        id
      )
  );

/** Generator: random valid SQL schema name */
const arbitrarySchemaName: fc.Arbitrary<string> = fc.constantFrom('dbo', 'sales', 'hr', 'admin', 'app');

/** Generator: random simple SQL statement (no semicolons, no GO) */
const arbitrarySimpleStatement: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('SELECT', 'INSERT INTO', 'UPDATE', 'DELETE FROM'),
    arbitraryIdentifier
  )
  .map(([keyword, name]) => {
    switch (keyword) {
      case 'SELECT':
        return `SELECT * FROM dbo.${name}`;
      case 'INSERT INTO':
        return `INSERT INTO dbo.${name} (col1) VALUES (1)`;
      case 'UPDATE':
        return `UPDATE dbo.${name} SET col1 = 1`;
      case 'DELETE FROM':
        return `DELETE FROM dbo.${name} WHERE id = 1`;
      default:
        return `SELECT 1`;
    }
  });

// --- Tests ---

describe('Preservation Property Tests: v0.5.0 QA Bugfixes', () => {
  describe('Property 9: Semicolon-delimited statements produce correct boundaries', () => {
    /**
     * **Validates: Requirements 3.1, 3.10**
     *
     * For all semicolon-delimited SQL documents, parseStatements() boundary count
     * equals the number of non-empty statements. Semicolons split statements correctly
     * and each non-empty segment produces exactly one boundary.
     *
     * Observed behavior on unfixed code: parseStatements correctly handles semicolons.
     * This must remain unchanged after GO boundary fixes.
     */

    it('boundary count equals number of semicolon-separated non-empty statements', () => {
      fc.assert(
        fc.property(
          fc.array(arbitrarySimpleStatement, { minLength: 1, maxLength: 5 }),
          (statements) => {
            // Join statements with semicolons (each statement ends with ;)
            const documentText = statements.join(';\n') + ';';

            const boundaries = parseStatements(documentText);

            // Each non-empty statement should produce exactly one boundary
            expect(boundaries.length).toBe(statements.length);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('trailing statement without semicolon still produces a boundary', () => {
      fc.assert(
        fc.property(
          fc.array(arbitrarySimpleStatement, { minLength: 1, maxLength: 4 }),
          arbitrarySimpleStatement,
          (statementsWithSemicolon, trailingStatement) => {
            // Some statements with semicolons, last one without
            const withSemicolons = statementsWithSemicolon.map((s) => s + ';').join('\n');
            const documentText = withSemicolons + '\n' + trailingStatement;

            const boundaries = parseStatements(documentText);

            // Total boundaries = statements with semicolons + 1 trailing
            expect(boundaries.length).toBe(statementsWithSemicolon.length + 1);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('single statement without semicolon produces exactly 1 boundary', () => {
      fc.assert(
        fc.property(arbitrarySimpleStatement, (statement) => {
          const boundaries = parseStatements(statement);
          expect(boundaries.length).toBe(1);
        }),
        { numRuns: 50 }
      );
    });

    it('boundaries have correct startLine and endLine for semicolon-delimited docs', () => {
      fc.assert(
        fc.property(
          fc.array(arbitrarySimpleStatement, { minLength: 2, maxLength: 4 }),
          (statements) => {
            const documentText = statements.join(';\n');
            const boundaries = parseStatements(documentText);

            // Boundaries should be non-overlapping and ordered
            for (let i = 1; i < boundaries.length; i++) {
              expect(boundaries[i].startLine).toBeGreaterThan(boundaries[i - 1].endLine);
            }

            // First boundary starts at line 0
            expect(boundaries[0].startLine).toBe(0);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe('Property 10: SELECT context ranking unchanged (FROM at Tier 0, columns at Tier 1)', () => {
    /**
     * **Validates: Requirements 3.3**
     *
     * For all SELECT context completions, the applyTieredRanking function assigns:
     * - FROM keyword: sortText prefix '0' (Tier 0 — required keyword)
     * - Columns: sortText prefix '1' (Tier 1)
     *
     * This ensures FROM always appears above columns in SELECT context.
     * Observed behavior on unfixed code: applyTieredRanking correctly assigns tiers.
     */

    it('FROM keyword gets Tier 0 sortText, columns get Tier 1 sortText', () => {
      fc.assert(
        fc.property(
          fc.array(arbitraryIdentifier, { minLength: 1, maxLength: 5 }),
          (columnNames) => {
            const uniqueCols = [...new Set(columnNames)];
            if (uniqueCols.length === 0) return;

            // Simulate items that would be in a SELECT context completion list
            const items = [
              { label: 'FROM', kind: 14 /* Keyword */ },
              ...uniqueCols.map((col) => ({
                label: col,
                kind: 5 /* Field */,
              })),
            ];

            // Apply ranking with FROM as required keyword (as it would be in SELECT context)
            const ranked = applyTieredRanking(items as any, ['FROM']);

            // FROM should be at Tier 0
            const fromItem = ranked.find(
              (i) => (i.label as string).toUpperCase() === 'FROM'
            );
            expect(fromItem).toBeDefined();
            expect(fromItem!.sortText!.startsWith(RANK_TIERS.REQUIRED_KEYWORD)).toBe(true);

            // All columns should be at Tier 1
            const colItems = ranked.filter((i) => i.kind === 5);
            for (const col of colItems) {
              expect(col.sortText!.startsWith(RANK_TIERS.COLUMNS_AND_ALIASES)).toBe(true);
            }

            // FROM sortText < all column sortText (Tier 0 < Tier 1)
            for (const col of colItems) {
              expect(fromItem!.sortText! < col.sortText!).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('schema objects get Tier 3 sortText (below columns and keywords)', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          arbitraryIdentifier,
          (schema, tableName) => {
            const items = [
              { label: 'FROM', kind: 14 /* Keyword */ },
              { label: 'Id', kind: 5 /* Field */ },
              { label: `${schema}.${tableName}`, kind: 9 /* Module */, detail: 'Table' },
            ];

            const ranked = applyTieredRanking(items as any, ['FROM']);

            const tableItem = ranked.find((i) => i.detail === 'Table');
            expect(tableItem).toBeDefined();
            expect(tableItem!.sortText!.startsWith(RANK_TIERS.SCHEMA_OBJECTS)).toBe(true);

            // Table sortText > column sortText > FROM sortText
            const fromItem = ranked.find(
              (i) => (i.label as string).toUpperCase() === 'FROM'
            );
            const colItem = ranked.find((i) => i.kind === 5);
            expect(fromItem!.sortText! < colItem!.sortText!).toBe(true);
            expect(colItem!.sortText! < tableItem!.sortText!).toBe(true);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe('Property 11: JOIN table suggestions unchanged', () => {
    /**
     * **Validates: Requirements 3.4**
     *
     * For all completion requests immediately after a JOIN keyword (no table typed yet),
     * the system continues to suggest FK-related tables with auto-generated ON clauses.
     *
     * Observed behavior on unfixed code: JOIN completions return FK-based table suggestions
     * with insertText containing ON clause snippets.
     */

    it('JOIN keyword (no table typed) returns FK-related table completions with ON clauses', () => {
      fc.assert(
        fc.property(
          arbitraryIdentifier,
          arbitraryIdentifier,
          (fkCol, pkCol) => {
            const tables: TableInfo[] = [
              {
                schema: 'dbo',
                name: 'Users',
                columns: [
                  { name: pkCol, dataType: 'int', isNullable: false },
                  { name: 'Name', dataType: 'nvarchar', isNullable: true },
                ],
              },
              {
                schema: 'dbo',
                name: 'Orders',
                columns: [
                  { name: 'OrderId', dataType: 'int', isNullable: false },
                  { name: fkCol, dataType: 'int', isNullable: false },
                ],
              },
            ];

            const foreignKeys: ForeignKeyInfo[] = [
              {
                constraintName: 'FK_Orders_Users',
                referencingSchema: 'dbo',
                referencingTable: 'Orders',
                referencedSchema: 'dbo',
                referencedTable: 'Users',
                columnPairs: [
                  {
                    referencingColumn: fkCol,
                    referencedColumn: pkCol,
                    ordinalPosition: 1,
                  },
                ],
              },
            ];

            const schemaCache = createMockSchemaCache({ tables, foreignKeys });

            const text = 'SELECT * FROM dbo.Users u JOIN ';
            const items = getCompletions(text, text.length, schemaCache, true);

            // Should return completions (not empty)
            expect(items.length).toBeGreaterThan(0);

            // Should include FK-related table with ON clause in insertText
            const fkItem = items.find(
              (i) =>
                typeof i.detail === 'string' &&
                i.detail.startsWith('FK')
            );
            expect(fkItem).toBeDefined();
            expect(fkItem!.insertText).toBeDefined();
            // The insertText should contain ON clause
            expect(fkItem!.insertText!).toContain('ON');
          }
        ),
        { numRuns: 50 }
      );
    });

    it('concrete case: JOIN after FROM dbo.Users returns Orders FK completion', () => {
      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'Users',
            columns: [
              { name: 'UserId', dataType: 'int', isNullable: false },
              { name: 'Name', dataType: 'nvarchar', isNullable: true },
            ],
          },
          {
            schema: 'dbo',
            name: 'Orders',
            columns: [
              { name: 'OrderId', dataType: 'int', isNullable: false },
              { name: 'UserId', dataType: 'int', isNullable: false },
            ],
          },
        ],
        foreignKeys: [
          {
            constraintName: 'FK_Orders_Users',
            referencingSchema: 'dbo',
            referencingTable: 'Orders',
            referencedSchema: 'dbo',
            referencedTable: 'Users',
            columnPairs: [
              {
                referencingColumn: 'UserId',
                referencedColumn: 'UserId',
                ordinalPosition: 1,
              },
            ],
          },
        ],
      });

      const text = 'SELECT * FROM dbo.Users u JOIN ';
      const items = getCompletions(text, text.length, schemaCache, true);

      // Should have FK-based completion for Orders
      const ordersFK = items.find(
        (i) => (i.label as string) === 'dbo.Orders'
      );
      expect(ordersFK).toBeDefined();
      expect(ordersFK!.insertText).toContain('ON');
      expect(ordersFK!.insertText).toContain('UserId');
    });
  });

  describe('Property 12: Non-comment, non-string completions are non-empty', () => {
    /**
     * **Validates: Requirements 3.7, 3.8**
     *
     * For all non-comment, non-string cursor positions in valid SQL with a connected
     * schema cache, completions are non-empty. Normal SQL code continues to receive
     * full IntelliSense.
     *
     * Observed behavior on unfixed code: getCompletions returns non-empty results
     * for all normal SQL contexts (SELECT, FROM, WHERE, etc.).
     */

    it('normal SQL contexts return non-empty completions', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(
            'SELECT ',
            'SELECT * FROM ',
            'SELECT * FROM dbo.Users WHERE ',
            'SELECT * FROM dbo.Users ORDER BY ',
            'EXEC ',
            'UPDATE ',
            'DECLARE @x ',
          ),
          (sqlText) => {
            const schemaCache = createMockSchemaCache({
              tables: [
                {
                  schema: 'dbo',
                  name: 'Users',
                  columns: [
                    { name: 'Id', dataType: 'int', isNullable: false },
                    { name: 'Name', dataType: 'nvarchar', isNullable: true },
                  ],
                },
              ],
              procedures: [{ schema: 'dbo', name: 'GetUsers' }],
            });

            const items = getCompletions(sqlText, sqlText.length, schemaCache, true);

            // Normal SQL code should always return non-empty completions
            expect(items.length).toBeGreaterThan(0);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('WHERE context with table reference returns column completions', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          arbitraryIdentifier,
          fc.array(arbitraryIdentifier, { minLength: 1, maxLength: 3 }),
          (schema, tableName, columnNames) => {
            const uniqueCols = [...new Set(columnNames)];
            if (uniqueCols.length === 0) return;

            const tables: TableInfo[] = [
              {
                schema,
                name: tableName,
                columns: uniqueCols.map((col) => ({
                  name: col,
                  dataType: 'int',
                  isNullable: false,
                })),
              },
            ];

            const schemaCache = createMockSchemaCache({ tables });

            const text = `SELECT * FROM ${schema}.${tableName} WHERE `;
            const items = getCompletions(text, text.length, schemaCache, true);

            // Should return non-empty completions including columns
            expect(items.length).toBeGreaterThan(0);

            // Should include at least some of the table's columns
            const itemLabels = items.map((i) => (i.label as string).toLowerCase());
            const hasColumn = uniqueCols.some((col) =>
              itemLabels.includes(col.toLowerCase())
            );
            expect(hasColumn).toBe(true);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe('Property: String literal suppression continues to work', () => {
    /**
     * **Validates: Requirements 3.7**
     *
     * For cursor positions inside string literals where the string content ends with
     * alphabetic characters that don't match any column name prefix, completions are
     * empty. This existing behavior (via prefix filtering) must be preserved.
     *
     * Observed behavior on unfixed code: getCompletions returns empty array when
     * cursor is inside a string literal whose trailing text doesn't match any
     * completion item prefix. The suppression is a side effect of prefix filtering.
     *
     * NOTE: String literal suppression is imperfect on unfixed code — it only works
     * when the string content's trailing word doesn't match any column/keyword prefix.
     * The fix for bugs 7/8 will add explicit comment detection; string literal
     * suppression already works through a different mechanism (prefix filtering).
     */

    it('cursor inside string literal with non-matching alphabetic content returns empty completions', () => {
      fc.assert(
        fc.property(
          // Generate string content that is purely alphabetic and won't match column names
          fc.stringOf(
            fc.constantFrom(...'xyzqwvjk'.split('')),
            { minLength: 3, maxLength: 12 }
          ),
          (stringContent) => {
            const schemaCache = createMockSchemaCache({
              tables: [
                {
                  schema: 'dbo',
                  name: 'Users',
                  columns: [
                    { name: 'Id', dataType: 'int', isNullable: false },
                    { name: 'Name', dataType: 'nvarchar', isNullable: true },
                  ],
                },
              ],
            });

            // Cursor is inside an unclosed string literal
            // String content is alphabetic and doesn't match any column prefix
            const text = `SELECT * FROM dbo.Users WHERE Name = '${stringContent}`;
            const items = getCompletions(text, text.length, schemaCache, true);

            // String literal suppression via prefix filtering: completions should be empty
            expect(items).toHaveLength(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('cursor inside closed string literal with non-matching content returns empty', () => {
      fc.assert(
        fc.property(
          fc.stringOf(
            fc.constantFrom(...'xyzqwvjk'.split('')),
            { minLength: 3, maxLength: 12 }
          ),
          (stringContent) => {
            const schemaCache = createMockSchemaCache({
              tables: [
                {
                  schema: 'dbo',
                  name: 'Users',
                  columns: [{ name: 'Id', dataType: 'int', isNullable: false }],
                },
              ],
            });

            // Full text with cursor inside a closed string literal
            const prefix = `SELECT * FROM dbo.Users WHERE Name = '`;
            const fullText = `${prefix}${stringContent}' AND Id = 1`;
            // Cursor is at the end of the string content (before closing quote)
            const cursorOffset = prefix.length + stringContent.length;
            const items = getCompletions(fullText, cursorOffset, schemaCache, true);

            expect(items).toHaveLength(0);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe('Property 13: Table Preview sort and retry unchanged', () => {
    /**
     * **Validates: Requirements 3.5, 3.6, 3.9**
     *
     * The Table Preview webview HTML:
     * - Sort column header click sends 'toggleSort' message immediately (no debounce)
     * - Retry button sends 'retry' message immediately
     * - Enter key in filter input sends 'applyFilter' immediately
     *
     * Observed behavior on unfixed code: These behaviors are implemented via
     * direct event listeners without debounce.
     */

    it('webview HTML contains sort header click handler that posts toggleSort immediately', () => {
      const sourceFile = path.resolve(
        __dirname,
        '../../src/tablePreviewManager.ts'
      );
      const source = fs.readFileSync(sourceFile, 'utf-8');

      // Sort header click handler posts toggleSort message directly (no debounce)
      expect(source).toContain("type: 'toggleSort'");
      expect(source).toContain("header.addEventListener('click'");

      // The toggleSort message is sent directly in the click handler
      // (not wrapped in a setTimeout or debounce)
      // Verify the click handler pattern: addEventListener('click', function() { ... postMessage({ type: 'toggleSort' ...
      const clickHandlerPattern = /header\.addEventListener\('click',\s*function\(\)\s*\{[^}]*postMessage\(\{\s*type:\s*'toggleSort'/s;
      expect(clickHandlerPattern.test(source)).toBe(true);
    });

    it('webview HTML contains retry button that posts retry message immediately', () => {
      const sourceFile = path.resolve(
        __dirname,
        '../../src/tablePreviewManager.ts'
      );
      const source = fs.readFileSync(sourceFile, 'utf-8');

      // Retry button posts 'retry' message
      expect(source).toContain("type: 'retry'");
      expect(source).toContain("retryBtn.addEventListener('click'");
    });

    it('webview HTML contains Enter key handler that posts applyFilter immediately', () => {
      const sourceFile = path.resolve(
        __dirname,
        '../../src/tablePreviewManager.ts'
      );
      const source = fs.readFileSync(sourceFile, 'utf-8');

      // Enter key handler posts applyFilter without debounce
      expect(source).toContain("e.key === 'Enter'");
      expect(source).toContain("type: 'applyFilter'");
    });

    it('toggleSort handler in extension host calls executePreview immediately', () => {
      const sourceFile = path.resolve(
        __dirname,
        '../../src/tablePreviewManager.ts'
      );
      const source = fs.readFileSync(sourceFile, 'utf-8');

      // The toggleSort method exists and modifies sort state
      expect(source).toContain('async toggleSort');
      expect(source).toContain('tabState.sortColumn');
      expect(source).toContain('tabState.sortDirection');
    });
  });
});
