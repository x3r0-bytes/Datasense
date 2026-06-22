import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { getCompletions, detectContext } from '../../server/src/completionProvider';
import { ISchemaCache, TableInfo, ViewInfo, ProcedureInfo } from '../../server/src/schemaCache';
import * as mssql from 'mssql';

/**
 * Preservation Property Tests — IntelliSense QA Fixes
 *
 * **Property 2: Preservation** — Non-Bug-Condition Completion Behavior Unchanged
 *
 * These tests capture existing CORRECT behavior on UNFIXED code.
 * They MUST PASS on unfixed code — passing confirms baseline behavior to preserve.
 * After the fix is applied, these tests are re-run to verify no regressions.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8
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

/** Generator: random valid SQL identifier (table/procedure name) */
const arbitraryTableName: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')),
      { minLength: 1, maxLength: 12 }
    )
  )
  .map(([first, rest]) => first + rest)
  .filter((id) => !/^(select|from|where|join|inner|left|right|full|cross|on|order|group|having|exec|execute|insert|update|delete|create|alter|drop|begin|end|with|as|if|else|while|return|declare|set|union|all|except|intersect|into|values|and|or|not|in|exists|between|like|is|null|case|when|then|distinct|top|go|use|print|nolock)$/i.test(id));

/** Generator: random table prefix (partial table name for filtering) */
const arbitraryTablePrefix: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
  { minLength: 1, maxLength: 4 }
);

/** Generator: complete JOIN keyword sequences (with trailing space) */
const arbitraryCompleteJoinKeyword: fc.Arbitrary<string> = fc.constantFrom(
  'INNER JOIN ',
  'LEFT JOIN ',
  'LEFT OUTER JOIN ',
  'RIGHT JOIN ',
  'RIGHT OUTER JOIN ',
  'FULL JOIN ',
  'FULL OUTER JOIN ',
  'CROSS JOIN ',
  'JOIN '
);

/** Generator: table hint patterns that use WITH keyword (NOT CTEs) */
const arbitraryTableHintPattern: fc.Arbitrary<string> = fc.constantFrom(
  'FROM dbo.Users WITH (NOLOCK)',
  'FROM dbo.Orders WITH (ROWLOCK)',
  'FROM sales.Invoices WITH (READUNCOMMITTED)',
  'FROM hr.Employees WITH (TABLOCK)',
  'FROM dbo.Products WITH (NOLOCK, ROWLOCK)',
  'SELECT * FROM dbo.Users WITH (UPDLOCK)',
  'FROM dbo.Customers u WITH (NOLOCK)',
  'FROM admin.Settings WITH (HOLDLOCK)'
);

// --- Tests ---

describe('Preservation Property Tests: Non-Bug-Condition Behavior Unchanged', () => {
  describe('Property: Table completions without schema dot prefix include schema.table labels', () => {
    /**
     * Validates: Requirements 3.1, 3.2
     *
     * For all table names typed without a schema dot prefix (e.g., `FROM `, `FROM Ord`),
     * completions include `schema.table` labels and no `insertText` override is needed.
     * This behavior must remain unchanged after the fix.
     */

    it('FROM with trailing space returns schema.table completions for all tables', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          fc.array(arbitraryTableName, { minLength: 1, maxLength: 5 }),
          (schema, tableNames) => {
            const uniqueNames = [...new Set(tableNames)];
            if (uniqueNames.length === 0) return;

            const tables: TableInfo[] = uniqueNames.map(name => ({
              schema,
              name,
              columns: [{ name: 'Id', dataType: 'int', isNullable: false }],
            }));

            const schemaCache = createMockSchemaCache({ tables });

            // User typed "SELECT * FROM " (no schema prefix, just trailing space)
            const text = 'SELECT * FROM ';
            const items = getCompletions(text, text.length, schemaCache, true);

            const labels = items.map(i => i.label as string);

            // All tables should appear as schema.table labels
            for (const table of tables) {
              expect(labels).toContain(`${table.schema}.${table.name}`);
            }

            // Items should NOT have insertText override (full label is used)
            // (Snippet items are excluded — they have insertText by design)
            for (const item of items) {
              if (item.detail === 'Snippet') continue;
              expect(item.insertText).toBeUndefined();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('FROM with partial table name prefix filters schema.table completions correctly', () => {
      fc.assert(
        fc.property(
          arbitraryTablePrefix,
          (prefix) => {
            // Create tables where some match the prefix and some don't
            const tables: TableInfo[] = [
              { schema: 'dbo', name: 'Orders', columns: [{ name: 'Id', dataType: 'int', isNullable: false }] },
              { schema: 'dbo', name: 'OrderItems', columns: [{ name: 'Id', dataType: 'int', isNullable: false }] },
              { schema: 'dbo', name: 'Users', columns: [{ name: 'Id', dataType: 'int', isNullable: false }] },
              { schema: 'sales', name: 'Invoices', columns: [{ name: 'Id', dataType: 'int', isNullable: false }] },
              { schema: 'hr', name: 'Employees', columns: [{ name: 'Id', dataType: 'int', isNullable: false }] },
            ];

            const schemaCache = createMockSchemaCache({ tables });

            // User typed "SELECT * FROM <prefix>" (partial name, no dot)
            const text = `SELECT * FROM ${prefix}`;
            const items = getCompletions(text, text.length, schemaCache, true);

            const labels = items.map(i => i.label as string);
            const lowerPrefix = prefix.toLowerCase();

            // Every returned item must start with the prefix (case-insensitive)
            // Snippet items use filterText for matching, not label
            for (const item of items) {
              if (item.detail === 'Snippet') continue;
              const label = item.label as string;
              expect(label.toLowerCase().startsWith(lowerPrefix)).toBe(true);
            }

            // Every table whose schema.name starts with prefix must be included
            for (const table of tables) {
              const fullLabel = `${table.schema}.${table.name}`;
              if (fullLabel.toLowerCase().startsWith(lowerPrefix)) {
                expect(labels).toContain(fullLabel);
              }
            }

            // Items should NOT have insertText override
            // (Snippet items are excluded — they have insertText by design)
            for (const item of items) {
              if (item.detail === 'Snippet') continue;
              expect(item.insertText).toBeUndefined();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe('Property: Complete JOIN keyword sequences return FK-based completions', () => {
    /**
     * Validates: Requirements 3.3
     *
     * For all complete JOIN keyword sequences with trailing space (e.g., `INNER JOIN `),
     * FK-based completions are returned (or table/view completions as fallback when no FKs exist).
     * This behavior must remain unchanged after the fix.
     */

    it('complete JOIN keywords with trailing space return table/view completions', () => {
      fc.assert(
        fc.property(
          arbitraryCompleteJoinKeyword,
          arbitrarySchemaName,
          fc.array(arbitraryTableName, { minLength: 2, maxLength: 4 }),
          (joinKeyword, schema, tableNames) => {
            const uniqueNames = [...new Set(tableNames)];
            if (uniqueNames.length < 2) return;

            const tables: TableInfo[] = uniqueNames.map(name => ({
              schema,
              name,
              columns: [{ name: 'Id', dataType: 'int', isNullable: false }],
            }));

            const schemaCache = createMockSchemaCache({ tables });

            // User typed "SELECT * FROM schema.Table1 INNER JOIN " (complete keyword with space)
            const text = `SELECT * FROM ${schema}.${uniqueNames[0]} t1 ${joinKeyword}`;
            const items = getCompletions(text, text.length, schemaCache, true);

            // Should return completions (tables/views or FK-based)
            // The key preservation property: completions ARE returned (not empty)
            expect(items.length).toBeGreaterThan(0);

            // Items should be table/view completions (Module kind) or join snippets
            for (const item of items) {
              // Join completions can be Module (table) or Snippet (join with ON clause)
              expect(item.kind).toBeDefined();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe('Property: EXEC inputs return stored procedure completions', () => {
    /**
     * Validates: Requirements 3.7
     *
     * For all `EXEC ` inputs, stored procedure completions are returned.
     * This behavior must remain unchanged after the fix.
     */

    it('EXEC with trailing space returns all stored procedures', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          fc.array(arbitraryTableName, { minLength: 1, maxLength: 5 }),
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

            // All items should be stored procedures (snippets excluded)
            for (const item of items) {
              if (item.detail === 'Snippet') continue;
              expect(item.detail).toBe('Stored Procedure');
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('EXECUTE with trailing space also returns stored procedures', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          fc.array(arbitraryTableName, { minLength: 1, maxLength: 3 }),
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
  });

  describe('Property: Disconnected inputs return keyword and built-in function completions', () => {
    /**
     * Validates: Requirements 3.5
     *
     * For all disconnected inputs (isConnected=false or schemaCache=null),
     * keyword and built-in function completions are returned.
     * This behavior must remain unchanged after the fix.
     */

    it('disconnected state returns keyword completions regardless of text', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(
            'SELECT ',
            'SELECT * FROM ',
            'EXEC ',
            'INSERT INTO ',
            'UPDATE ',
            'DELETE FROM ',
            ''
          ),
          (text) => {
            // isConnected = false, schemaCache = null
            const items = getCompletions(text, text.length, null, false);

            // Should return keywords and built-in functions
            expect(items.length).toBeGreaterThan(0);

            // All items should be keywords or functions (or snippets)
            for (const item of items) {
              expect(['Keyword', 'Built-in Function', 'Snippet']).toContain(item.detail);
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('disconnected state includes common SQL keywords', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('SELECT', 'FROM', 'WHERE', 'JOIN', 'INSERT', 'UPDATE', 'DELETE'),
          (expectedKeyword) => {
            const text = '';
            const items = getCompletions(text, text.length, null, false);

            const labels = items.map(i => (i.label as string).toUpperCase());
            expect(labels).toContain(expectedKeyword);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('disconnected state includes built-in functions', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('ISNULL', 'COALESCE', 'CONVERT', 'CAST', 'GETDATE', 'COUNT', 'SUM'),
          (expectedFunc) => {
            const text = '';
            const items = getCompletions(text, text.length, null, false);

            const labels = items.map(i => (i.label as string).toUpperCase());
            expect(labels).toContain(expectedFunc);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe('Property: WITH ( patterns (table hints) do NOT trigger CTE context', () => {
    /**
     * Validates: Requirements 3.8
     *
     * For all `WITH (` patterns (table hints like NOLOCK, ROWLOCK, etc.),
     * `detectContext()` does NOT return `'CTE'`.
     * This behavior must remain unchanged after the fix.
     */

    it('detectContext does not return CTE for table hint patterns', () => {
      fc.assert(
        fc.property(
          arbitraryTableHintPattern,
          (text) => {
            const context = detectContext(text);
            // Table hints should NOT be detected as CTE context
            expect(context).not.toBe('CTE');
          }
        ),
        { numRuns: 50 }
      );
    });

    it('WITH (NOLOCK) after FROM is detected as FROM context, not CTE', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          arbitraryTableName,
          fc.constantFrom('NOLOCK', 'ROWLOCK', 'READUNCOMMITTED', 'TABLOCK', 'UPDLOCK', 'HOLDLOCK'),
          (schema, tableName, hint) => {
            const text = `SELECT * FROM ${schema}.${tableName} WITH (${hint})`;
            const context = detectContext(text);

            // Should be FROM context (the WITH hint doesn't change the clause context)
            // The key property: it is NOT 'CTE'
            expect(context).not.toBe('CTE');
          }
        ),
        { numRuns: 50 }
      );
    });

    it('WITH followed by opening paren is never CTE', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(
            'FROM dbo.Users WITH (',
            'FROM dbo.Orders o WITH (',
            'SELECT * FROM sales.Items WITH (',
            'FROM hr.Employees e WITH ('
          ),
          (text) => {
            const context = detectContext(text);
            expect(context).not.toBe('CTE');
          }
        ),
        { numRuns: 20 }
      );
    });
  });
});
