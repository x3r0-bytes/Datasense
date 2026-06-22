import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { getCompletions, detectContext, applyTieredRanking, RANK_TIERS } from '../../server/src/completionProvider';
import { ISchemaCache, TableInfo, ViewInfo, ProcedureInfo, ForeignKeyInfo } from '../../server/src/schemaCache';
import { parseStatements } from '../../src/statementParser';
import * as mssql from 'mssql';

/**
 * Bug Condition Exploration Property Tests — v0.5.0 QA Bugfixes
 *
 * **Property 1: Bug Condition** — v0.5.0 QA Bugs Exploration
 *
 * CRITICAL: These tests encode the EXPECTED (correct) behavior.
 * They are EXPECTED TO FAIL on unfixed code — failure confirms the bugs exist.
 * DO NOT fix the code or modify the tests when they fail.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 1.8
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
        fk =>
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
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')),
      { minLength: 1, maxLength: 10 }
    )
  )
  .map(([first, rest]) => first + rest)
  .filter(
    (id) =>
      !/^(select|from|where|join|inner|left|right|full|cross|on|order|group|having|exec|execute|insert|update|delete|create|alter|drop|begin|end|with|as|go|and|or|not|in|between|like|is|null|set|declare|case|when|then|else|top|distinct|into|values)$/i.test(
        id
      )
  );

/** Generator: random valid SQL schema name */
const arbitrarySchemaName: fc.Arbitrary<string> = fc.constantFrom('dbo', 'sales', 'hr', 'admin', 'app');

/** Generator: random comment content (no newlines, no closing block comment) */
const arbitraryCommentContent: fc.Arbitrary<string> = fc
  .stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz 0123456789.,!?:;-_'.split('')), {
    minLength: 1,
    maxLength: 20,
  })
  .filter((s) => !s.includes('*/'));

// --- Tests ---

describe('Bug Condition Exploration: v0.5.0 QA Bugs', () => {
  describe('Bug 1 — GO-only documents: parseStatements() returns correct boundary count', () => {
    /**
     * Validates: Requirements 1.1
     *
     * When a SQL document contains multiple statements separated only by GO batch
     * boundaries (no semicolons), parseStatements() SHALL return one StatementBoundary
     * per batch.
     *
     * On unfixed code: This may fail if the parser doesn't correctly produce separate
     * boundaries for GO-separated batches.
     */

    it('GO-separated statements produce one boundary per batch', () => {
      fc.assert(
        fc.property(
          fc.array(arbitraryIdentifier, { minLength: 2, maxLength: 5 }),
          (tableNames) => {
            // Build a document with N SELECT statements separated by GO
            const statements = tableNames.map((name) => `SELECT * FROM ${name}`);
            const documentText = statements.join('\nGO\n');

            const boundaries = parseStatements(documentText);

            // Should have exactly N boundaries (one per batch)
            expect(boundaries.length).toBe(tableNames.length);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('concrete case: "SELECT 1\\nGO\\nSELECT 2" yields 2 boundaries', () => {
      const documentText = 'SELECT 1\nGO\nSELECT 2';
      const boundaries = parseStatements(documentText);
      expect(boundaries.length).toBe(2);
    });

    it('concrete case: three batches separated by GO', () => {
      const documentText = 'SELECT 1\nGO\nSELECT 2\nGO\nSELECT 3';
      const boundaries = parseStatements(documentText);
      expect(boundaries.length).toBe(3);
    });
  });

  describe('Bug 2 — StatementOutlineDecorator uses border style (not backgroundColor)', () => {
    /**
     * Validates: Requirements 1.2
     *
     * The StatementOutlineDecorator decoration type SHALL use a visible border style
     * (e.g., borderLeft, border, outline) instead of backgroundColor.
     *
     * On unfixed code: The decorator uses backgroundColor: 'rgba(100, 100, 100, 0.15)'
     * which is nearly invisible in many themes.
     *
     * NOTE: We cannot instantiate vscode.window.createTextEditorDecorationType in tests,
     * so we verify the source code directly to confirm the decoration style.
     */

    it('StatementOutlineDecorator source uses border style, not backgroundColor', () => {
      // Read the source file and verify it uses border-based styling
      const fs = require('fs');
      const path = require('path');
      const sourceFile = path.resolve(
        __dirname,
        '../../src/statementOutlineDecorator.ts'
      );
      const source = fs.readFileSync(sourceFile, 'utf-8');

      // The decoration type should use a border property (borderLeft, border, outline)
      const usesBorder =
        /border(?:Left|Right|Top|Bottom|Width|Style|Color)?\s*:/i.test(source) ||
        /outline\s*:/i.test(source);

      // The decoration type should NOT use backgroundColor
      const usesBackgroundColor = /backgroundColor\s*:/i.test(source);

      expect(usesBorder).toBe(true);
      expect(usesBackgroundColor).toBe(false);
    });
  });

  describe('Bug 3 — FROM context: tables ranked above keywords', () => {
    /**
     * Validates: Requirements 1.3
     *
     * In FROM context, tables and views SHALL have lower sortText values than
     * successor keywords, so tables appear first in the completion list.
     *
     * On unfixed code: Keywords get sortText prefix '0_' (Tier 0) while tables
     * get sortText prefix '3_' (Tier 3), causing keywords to appear above tables.
     */

    it('tables have lower sortText than keywords in FROM context', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          fc.array(arbitraryIdentifier, { minLength: 1, maxLength: 3 }),
          (schema, tableNames) => {
            const uniqueNames = [...new Set(tableNames)];
            if (uniqueNames.length === 0) return;

            const tables: TableInfo[] = uniqueNames.map((name) => ({
              schema,
              name,
              columns: [{ name: 'Id', dataType: 'int', isNullable: false }],
            }));

            const schemaCache = createMockSchemaCache({ tables });

            const text = 'SELECT * FROM ';
            const items = getCompletions(text, text.length, schemaCache, true);

            // Separate tables and keywords
            const tableItems = items.filter(
              (item) => item.kind === 5 /* Module */ && (item.detail === 'Table' || item.detail === 'View')
            );
            const keywordItems = items.filter(
              (item) => item.kind === 14 /* Keyword */ && item.sortText !== undefined
            );

            if (tableItems.length === 0 || keywordItems.length === 0) return;

            // All table sortText values should be LESS than all keyword sortText values
            // (lower sortText = higher priority in VS Code)
            const maxTableSortText = tableItems
              .map((i) => i.sortText || '')
              .sort()
              .pop()!;
            const minKeywordSortText = keywordItems
              .map((i) => i.sortText || '')
              .sort()
              .shift()!;

            expect(maxTableSortText < minKeywordSortText).toBe(true);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('concrete case: dbo.Users table sortText < WHERE keyword sortText in FROM context', () => {
      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'Users',
            columns: [{ name: 'Id', dataType: 'int', isNullable: false }],
          },
        ],
      });

      const text = 'SELECT * FROM ';
      const items = getCompletions(text, text.length, schemaCache, true);

      const usersItem = items.find((i) => (i.label as string) === 'dbo.Users');
      const whereItem = items.find(
        (i) => (i.label as string).toUpperCase() === 'WHERE'
      );

      expect(usersItem).toBeDefined();
      expect(whereItem).toBeDefined();
      expect(usersItem!.sortText! < whereItem!.sortText!).toBe(true);
    });
  });

  describe('Bug 4 — WHERE context: columns ranked above keywords', () => {
    /**
     * Validates: Requirements 1.4
     *
     * In WHERE context, columns SHALL have lower sortText values than successor
     * keywords, so columns appear first in the completion list.
     *
     * On unfixed code: Keywords get sortText prefix '0_' (Tier 0) while columns
     * get sortText prefix '1_' (Tier 1), but keywords still appear above columns.
     */

    it('columns have lower sortText than keywords in WHERE context', () => {
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

            // Separate columns and keywords
            const columnItems = items.filter((item) => item.kind === 5 /* Field */);
            const keywordItems = items.filter(
              (item) => item.kind === 14 /* Keyword */ && item.sortText !== undefined
            );

            if (columnItems.length === 0 || keywordItems.length === 0) return;

            // All column sortText values should be LESS than all keyword sortText values
            const maxColumnSortText = columnItems
              .map((i) => i.sortText || '')
              .sort()
              .pop()!;
            const minKeywordSortText = keywordItems
              .map((i) => i.sortText || '')
              .sort()
              .shift()!;

            expect(maxColumnSortText < minKeywordSortText).toBe(true);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('concrete case: column sortText < AND keyword sortText in WHERE context', () => {
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

      // Use a complete condition so AND appears in completions
      const text = 'SELECT * FROM dbo.Users WHERE Id = 1 ';
      const items = getCompletions(text, text.length, schemaCache, true);

      const columnItems = items.filter((i) => i.kind === 5 /* Field */);
      const andItem = items.find(
        (i) => (i.label as string).toUpperCase() === 'AND'
      );

      expect(columnItems.length).toBeGreaterThan(0);
      expect(andItem).toBeDefined();

      // Every column should have lower sortText than AND
      for (const col of columnItems) {
        expect(col.sortText! < andItem!.sortText!).toBe(true);
      }
    });
  });

  describe('Bug 5 — JOIN ON context: FK-related columns present in completions', () => {
    /**
     * Validates: Requirements 1.5
     *
     * When the user types `JOIN dbo.Orders o ON `, the completion list SHALL include
     * FK-related columns that form valid ON conditions.
     *
     * On unfixed code: detectContext() returns 'WHERE' for the ON position, and
     * generic column completions are returned without FK awareness.
     */

    it('JOIN ON context includes FK-related column completions', () => {
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

            const text = 'SELECT * FROM dbo.Users u JOIN dbo.Orders o ON ';
            const items = getCompletions(text, text.length, schemaCache, true);

            // Should contain FK-related column references
            const labels = items.map((i) => (i.label as string));
            const insertTexts = items.map((i) => i.insertText || (i.label as string));

            // Look for FK column references (e.g., "u.pkCol = o.fkCol" or individual FK columns)
            const hasFKColumns =
              labels.some((l) => l.includes(fkCol) || l.includes(pkCol)) ||
              insertTexts.some((t) => t.includes(fkCol) || t.includes(pkCol));

            expect(hasFKColumns).toBe(true);
          }
        ),
        { numRuns: 30 }
      );
    });

    it('concrete case: JOIN dbo.Orders o ON suggests UserId FK columns', () => {
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

      const text = 'SELECT * FROM dbo.Users u JOIN dbo.Orders o ON ';
      const items = getCompletions(text, text.length, schemaCache, true);

      const labels = items.map((i) => (i.label as string));
      const insertTexts = items.map((i) => i.insertText || (i.label as string));

      // Should contain FK-related column references (UserId from either table)
      const hasFKReference =
        labels.some((l) => l.includes('UserId')) ||
        insertTexts.some((t) => t.includes('UserId'));

      expect(hasFKReference).toBe(true);
    });
  });

  describe('Bug 7 — No completions inside single-line comments', () => {
    /**
     * Validates: Requirements 1.7
     *
     * When the cursor is inside a single-line comment (-- ...), getCompletions()
     * SHALL return an empty completion list.
     *
     * On unfixed code: getCompletions() returns keyword completions even inside comments.
     */

    it('getCompletions returns empty array when cursor is inside -- comment', () => {
      fc.assert(
        fc.property(arbitraryCommentContent, (commentText) => {
          const schemaCache = createMockSchemaCache({
            tables: [
              {
                schema: 'dbo',
                name: 'Users',
                columns: [{ name: 'Id', dataType: 'int', isNullable: false }],
              },
            ],
          });

          // Cursor is inside the comment text
          const text = `SELECT * FROM dbo.Users\n-- ${commentText}`;
          const items = getCompletions(text, text.length, schemaCache, true);

          expect(items).toHaveLength(0);
        }),
        { numRuns: 50 }
      );
    });

    it('concrete case: cursor inside "-- this is a comm" returns empty completions', () => {
      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'Users',
            columns: [{ name: 'Id', dataType: 'int', isNullable: false }],
          },
        ],
      });

      const text = 'SELECT * FROM dbo.Users\n-- this is a comm';
      const items = getCompletions(text, text.length, schemaCache, true);

      expect(items).toHaveLength(0);
    });

    it('concrete case: cursor at start of comment after -- returns empty', () => {
      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'Users',
            columns: [{ name: 'Id', dataType: 'int', isNullable: false }],
          },
        ],
      });

      const text = 'SELECT * FROM dbo.Users -- ';
      const items = getCompletions(text, text.length, schemaCache, true);

      expect(items).toHaveLength(0);
    });
  });

  describe('Bug 8 — No completions inside block comments', () => {
    /**
     * Validates: Requirements 1.8
     *
     * When the cursor is inside a block comment (/* ... * /), getCompletions()
     * SHALL return an empty completion list.
     *
     * On unfixed code: getCompletions() returns keyword completions even inside
     * block comments.
     */

    it('getCompletions returns empty array when cursor is inside /* block comment */', () => {
      fc.assert(
        fc.property(arbitraryCommentContent, (commentText) => {
          const schemaCache = createMockSchemaCache({
            tables: [
              {
                schema: 'dbo',
                name: 'Users',
                columns: [{ name: 'Id', dataType: 'int', isNullable: false }],
              },
            ],
          });

          // Cursor is inside an unclosed block comment
          const text = `SELECT * FROM dbo.Users\n/* ${commentText}`;
          const items = getCompletions(text, text.length, schemaCache, true);

          expect(items).toHaveLength(0);
        }),
        { numRuns: 50 }
      );
    });

    it('concrete case: cursor inside "/* this is a comm" returns empty completions', () => {
      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'Users',
            columns: [{ name: 'Id', dataType: 'int', isNullable: false }],
          },
        ],
      });

      const text = 'SELECT * FROM dbo.Users\n/* this is a comm';
      const items = getCompletions(text, text.length, schemaCache, true);

      expect(items).toHaveLength(0);
    });

    it('concrete case: cursor inside multi-line block comment returns empty', () => {
      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'Users',
            columns: [{ name: 'Id', dataType: 'int', isNullable: false }],
          },
        ],
      });

      const text = 'SELECT * FROM dbo.Users\n/* this is\na multi-line\ncomm';
      const items = getCompletions(text, text.length, schemaCache, true);

      expect(items).toHaveLength(0);
    });

    it('concrete case: cursor inside closed block comment returns empty', () => {
      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'Users',
            columns: [{ name: 'Id', dataType: 'int', isNullable: false }],
          },
        ],
      });

      // Cursor is between /* and */ (offset points to inside the comment)
      const fullText = 'SELECT * FROM dbo.Users /* comment here */ WHERE Id = 1';
      const cursorOffset = 'SELECT * FROM dbo.Users /* comment '.length;
      const items = getCompletions(fullText, cursorOffset, schemaCache, true);

      expect(items).toHaveLength(0);
    });
  });
});
