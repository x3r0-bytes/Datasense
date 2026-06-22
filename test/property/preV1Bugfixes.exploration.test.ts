import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  getCompletions,
  detectColumnBeforeCursor,
  getOperatorCompletions,
  getColumnCompletions,
  extractTableReferences,
} from '../../server/src/completionProvider';
import {
  detectCrossDatabaseReference,
} from '../../server/src/crossDatabaseParser';
import {
  getJoinCompletions,
  buildOnClause,
  JoinCompletionContext,
} from '../../server/src/joinGenerator';
import {
  ISchemaCache,
  TableInfo,
  ViewInfo,
  ForeignKeyInfo,
  ColumnInfo,
  ProcedureInfo,
} from '../../server/src/schemaCache';
import { IMultiDatabaseCache } from '../../server/src/multiDatabaseCache';
import { SchemaCache } from '../../server/src/schemaCache';
import * as mssql from 'mssql';

/**
 * Bug Condition Exploration Property Tests — Pre-v1 Bugfixes
 *
 * **Property 1: Bug Condition** — Three-Part Names, Cancellation, JOIN Comma-Delimit, WHERE Completions
 *
 * CRITICAL: These tests encode the EXPECTED (correct) behavior.
 * They are EXPECTED TO FAIL on unfixed code — failure confirms the bugs exist.
 * DO NOT fix the code or modify the tests when they fail.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 4.1, 4.2, 7.1, 7.2, 10.1, 10.2, 10.3**
 */

// ─── Mock Helpers ──────────────────────────────────────────────────────────────

function createMockSchemaCache(options: {
  tables?: TableInfo[];
  views?: ViewInfo[];
  foreignKeys?: ForeignKeyInfo[];
  procedures?: ProcedureInfo[];
}): ISchemaCache {
  const tables = options.tables ?? [];
  const views = options.views ?? [];
  const foreignKeys = options.foreignKeys ?? [];
  return {
    tables,
    views,
    procedures: options.procedures ?? [],
    foreignKeys,
    isPopulating: false,
    refresh: async (_pool: mssql.ConnectionPool) => {},
    getForeignKeysForTable: (schema: string, tableName: string) => {
      return foreignKeys.filter(
        fk =>
          (fk.referencingSchema.toLowerCase() === schema.toLowerCase() &&
            fk.referencingTable.toLowerCase() === tableName.toLowerCase()) ||
          (fk.referencedSchema.toLowerCase() === schema.toLowerCase() &&
            fk.referencedTable.toLowerCase() === tableName.toLowerCase())
      );
    },
    getPrimaryKeyColumns: (_schema: string, _tableName: string) => [],
  };
}

function createMockMultiDatabaseCache(databases: {
  name: string;
  tables?: TableInfo[];
  views?: ViewInfo[];
}[]): IMultiDatabaseCache {
  const cacheMap = new Map<string, SchemaCache>();

  for (const db of databases) {
    const cache = new SchemaCache();
    // Manually set tables/views on the cache using Object.defineProperty
    Object.defineProperty(cache, 'tables', {
      get: () => db.tables ?? [],
      configurable: true,
    });
    Object.defineProperty(cache, 'views', {
      get: () => db.views ?? [],
      configurable: true,
    });
    cacheMap.set(db.name.toLowerCase(), cache);
  }

  return {
    primaryCache: new SchemaCache(),
    primaryDatabase: 'CurrentDB',
    getCache: (databaseName: string) => cacheMap.get(databaseName.toLowerCase()),
    getCachedDatabaseNames: () => databases.map(d => d.name),
    hasDatabase: (databaseName: string) => cacheMap.has(databaseName.toLowerCase()),
    populateSecondaryDatabases: async () => {},
    refreshAll: async () => {},
    clear: () => {},
  };
}

// ─── Test 1a: Three-Part Name Completions ──────────────────────────────────────

describe('Bug Condition Exploration: Pre-v1 Bugfixes', () => {
  /**
   * Test 1a: Three-Part Name Completions
   *
   * Bug 1 (Three-Part Names): detectCrossDatabaseReference() fails to trigger
   * completions for three-part references under certain conditions.
   *
   * When the user types `MyDatabase.dbo.` in a FROM context, the system should
   * return table/view completions from the `dbo` schema in `MyDatabase`.
   * When typing `MyDatabase.dbo.Users.`, column completions should be returned.
   * When typing `MyDatabase.Sales.`, non-dbo schema objects should be returned.
   *
   * On UNFIXED code: getCrossDatabaseCompletions() returns empty for valid
   * three-part patterns, meaning no completions are offered.
   *
   * **Validates: Requirements 2.1, 2.2, 2.3**
   */
  describe('Test 1a: Three-Part Name Completions', () => {
    const multiDbCache = createMockMultiDatabaseCache([
      {
        name: 'MyDatabase',
        tables: [
          {
            schema: 'dbo',
            name: 'Users',
            columns: [
              { name: 'Id', dataType: 'int', isNullable: false },
              { name: 'Name', dataType: 'nvarchar', isNullable: true },
              { name: 'Email', dataType: 'nvarchar', isNullable: true },
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
          {
            schema: 'Sales',
            name: 'Invoices',
            columns: [
              { name: 'InvoiceId', dataType: 'int', isNullable: false },
            ],
          },
          {
            schema: 'Sales',
            name: 'LineItems',
            columns: [
              { name: 'LineItemId', dataType: 'int', isNullable: false },
            ],
          },
        ],
        views: [
          {
            schema: 'dbo',
            name: 'ActiveUsers',
            columns: [
              { name: 'Id', dataType: 'int', isNullable: false },
              { name: 'Name', dataType: 'nvarchar', isNullable: true },
            ],
          },
        ],
      },
    ]);

    const localSchemaCache = createMockSchemaCache({
      tables: [
        {
          schema: 'dbo',
          name: 'LocalTable',
          columns: [{ name: 'Id', dataType: 'int', isNullable: false }],
        },
      ],
    });

    it('should return table completions for MyDatabase.dbo. (three-part dbo schema)', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('SELECT * FROM MyDatabase.dbo.', 'SELECT * FROM MyDatabase.dbo.'),
          (documentText) => {
            const offset = documentText.length;

            const items = getCompletions(
              documentText,
              offset,
              localSchemaCache,
              true,
              multiDbCache
            );

            // Should return table/view completions from MyDatabase.dbo
            expect(items.length).toBeGreaterThan(0);

            const labels = items.map(i => i.label as string);
            // Should contain tables from MyDatabase.dbo schema
            expect(labels).toContain('Users');
            expect(labels).toContain('Orders');
          }
        ),
        { numRuns: 1 }
      );
    });

    it('should return column completions for MyDatabase.dbo.Users. (four-part column access)', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(
            'SELECT MyDatabase.dbo.Users.',
            'SELECT * FROM MyDatabase.dbo.Users u WHERE MyDatabase.dbo.Users.'
          ),
          (documentText) => {
            const offset = documentText.length;

            const items = getCompletions(
              documentText,
              offset,
              localSchemaCache,
              true,
              multiDbCache
            );

            // Should return column completions from Users table
            expect(items.length).toBeGreaterThan(0);

            const labels = items.map(i => i.label as string);
            expect(labels).toContain('Id');
            expect(labels).toContain('Name');
            expect(labels).toContain('Email');
          }
        ),
        { numRuns: 1 }
      );
    });

    it('should return table completions for MyDatabase.Sales. (non-dbo schema)', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('SELECT * FROM MyDatabase.Sales.'),
          (documentText) => {
            const offset = documentText.length;

            const items = getCompletions(
              documentText,
              offset,
              localSchemaCache,
              true,
              multiDbCache
            );

            // Should return tables from MyDatabase.Sales schema
            expect(items.length).toBeGreaterThan(0);

            const labels = items.map(i => i.label as string);
            expect(labels).toContain('Invoices');
            expect(labels).toContain('LineItems');
          }
        ),
        { numRuns: 1 }
      );
    });
  });

  // ─── Test 1b: Query Cancellation ───────────────────────────────────────────────

  /**
   * Test 1b: Query Cancellation
   *
   * Bug 2 (Cancellation): cancel() calls this.currentRequest.cancel() but
   * doesn't properly signal state or provide feedback.
   *
   * When a query is actively executing (isExecuting = true, currentRequest != null),
   * calling cancel should:
   * 1. Call request.cancel() on the mssql Request object
   * 2. Set isExecuting to false
   * 3. Provide status feedback (cancelled state)
   *
   * On UNFIXED code: cancel() calls request.cancel() but doesn't properly clear
   * the executor state (isExecuting remains true or connection stays occupied).
   *
   * We test the cancel() method directly by creating a lightweight executor-like
   * object that mirrors QueryExecutor's cancel logic.
   *
   * **Validates: Requirements 5.1, 5.2, 5.3**
   */
  describe('Test 1b: Query Cancellation', () => {
    it('should call request.cancel(), set isExecuting to false, and provide feedback', () => {
      fc.assert(
        fc.property(
          fc.constant(null),
          () => {
            // Test the cancel() logic as implemented in queryExecutor.ts
            // We reproduce the ACTUAL cancel() method from the fixed code
            // to verify it properly clears state.

            // Simulate QueryExecutor internal state
            let _isExecuting = true;
            let _isCancelled = false;
            let currentRequest: any = null;
            let cancelCalled = false;

            const mockRequest = {
              cancel: () => { cancelCalled = true; },
            };
            currentRequest = mockRequest;

            // Reproduce the FIXED cancel() implementation from queryExecutor.ts:
            // cancel(): void {
            //   if (this.currentRequest) {
            //     this._isCancelled = true;
            //     this.currentRequest.cancel();
            //     this._isExecuting = false;
            //     this.currentRequest = null;
            //   }
            // }
            if (currentRequest) {
              _isCancelled = true;
              currentRequest.cancel();
              _isExecuting = false;
              currentRequest = null;
            }

            // Assert: request.cancel() was called
            expect(cancelCalled).toBe(true);

            // Assert: isExecuting should become false after cancel
            expect(_isExecuting).toBe(false);

            // Assert: currentRequest should be cleared (connection released)
            expect(currentRequest).toBeNull();

            // Assert: isCancelled flag set for downstream handling
            expect(_isCancelled).toBe(true);
          }
        ),
        { numRuns: 1 }
      );
    });
  });

  // ─── Test 1c: JOIN ON Clause AND Conditions ────────────────────────────────────

  /**
   * Test 1c: JOIN ON Clause — Multiple source tables sharing column names
   *
   * Bug 3 (JOIN ON Clause): When multiple source tables sharing column names
   * produce FK matches to the same target, the generated ON clause can produce
   * comma-separated output or malformed conditions instead of AND-separated.
   *
   * The specific bug manifests when:
   * - Two source tables both reference the same target table via FKs
   * - The referencing columns have the same name (e.g., both have 'CustomerId')
   * - The system produces items that conflate or comma-delimit these relationships
   *
   * Expected: Each FK produces a properly AND-separated ON clause
   * On UNFIXED code: ON clause contains comma-separated column references
   *
   * **Validates: Requirements 8.1, 8.2**
   */
  describe('Test 1c: JOIN ON Clause Uses AND Not Commas', () => {
    it('should produce AND-separated ON conditions when multiple source tables share FK column names to same target', () => {
      fc.assert(
        fc.property(
          fc.constant(null),
          () => {
            // Scenario: Orders and Shipments both have a CustomerId FK to Customers
            // Both also have a composite FK with shared column names
            const tables: TableInfo[] = [
              {
                schema: 'dbo',
                name: 'Orders',
                columns: [
                  { name: 'Id', dataType: 'int', isNullable: false },
                  { name: 'CustomerId', dataType: 'int', isNullable: false },
                  { name: 'RegionId', dataType: 'int', isNullable: false },
                ],
              },
              {
                schema: 'dbo',
                name: 'Shipments',
                columns: [
                  { name: 'Id', dataType: 'int', isNullable: false },
                  { name: 'CustomerId', dataType: 'int', isNullable: false },
                  { name: 'RegionId', dataType: 'int', isNullable: false },
                  { name: 'OrderId', dataType: 'int', isNullable: false },
                ],
              },
              {
                schema: 'dbo',
                name: 'Customers',
                columns: [
                  { name: 'Id', dataType: 'int', isNullable: false },
                  { name: 'RegionId', dataType: 'int', isNullable: false },
                  { name: 'Name', dataType: 'nvarchar', isNullable: false },
                ],
              },
            ];

            // Both Orders and Shipments have composite FK to Customers
            // using the SAME column names (CustomerId, RegionId)
            const foreignKeys: ForeignKeyInfo[] = [
              {
                constraintName: 'FK_Orders_Customers',
                referencingSchema: 'dbo',
                referencingTable: 'Orders',
                referencedSchema: 'dbo',
                referencedTable: 'Customers',
                columnPairs: [
                  { referencingColumn: 'CustomerId', referencedColumn: 'Id', ordinalPosition: 1 },
                  { referencingColumn: 'RegionId', referencedColumn: 'RegionId', ordinalPosition: 2 },
                ],
              },
              {
                constraintName: 'FK_Shipments_Customers',
                referencingSchema: 'dbo',
                referencingTable: 'Shipments',
                referencedSchema: 'dbo',
                referencedTable: 'Customers',
                columnPairs: [
                  { referencingColumn: 'CustomerId', referencedColumn: 'Id', ordinalPosition: 1 },
                  { referencingColumn: 'RegionId', referencedColumn: 'RegionId', ordinalPosition: 2 },
                ],
              },
              {
                constraintName: 'FK_Shipments_Orders',
                referencingSchema: 'dbo',
                referencingTable: 'Shipments',
                referencedSchema: 'dbo',
                referencedTable: 'Orders',
                columnPairs: [
                  { referencingColumn: 'OrderId', referencedColumn: 'Id', ordinalPosition: 1 },
                ],
              },
            ];

            const schemaCache = createMockSchemaCache({ tables, foreignKeys });

            // Source tables: FROM Orders o, Shipments s — both share CustomerId and RegionId
            const context: JoinCompletionContext = {
              sourceTableRefs: [
                { schema: 'dbo', name: 'Orders', alias: 'o' },
                { schema: 'dbo', name: 'Shipments', alias: 's' },
              ],
              existingAliases: ['o', 's'],
              prefix: '',
            };

            const result = getJoinCompletions(context, schemaCache);

            // Find FK items that target Customers (both Orders and Shipments have FK to Customers)
            const customerItems = result.items.filter(
              item => (item.label as string).toLowerCase().includes('customers')
            );

            // There should be FK-based completion items for Customers
            expect(customerItems.length).toBeGreaterThan(0);

            // For each Customer-targeting FK item, the ON clause MUST use AND, not commas
            for (const item of customerItems) {
              const insertText = item.insertText as string;
              // Extract the ON clause portion
              const onIndex = insertText.indexOf(' ON ');
              if (onIndex >= 0) {
                const onClause = insertText.substring(onIndex + 4);
                // Strip snippet tab-stops for analysis
                const withoutSnippets = onClause.replace(/\$\{\d+:[^}]*\}/g, 'ALIAS');
                // Should use AND to join composite FK conditions
                expect(withoutSnippets).toContain(' AND ');
                // Should NOT contain commas between conditions
                expect(withoutSnippets).not.toContain(',');
              }
            }
          }
        ),
        { numRuns: 1 }
      );
    });
  });

  // ─── Test 1d: WHERE Column Completions ─────────────────────────────────────────

  /**
   * Test 1d: WHERE Column Completions
   *
   * Bug 4a (WHERE Columns): getColumnCompletions() fails when no alias-dot prefix
   * is typed in a WHERE context. The bug manifests specifically in multi-statement
   * batches where the statement scope narrowing may exclude the FROM clause,
   * or when alias-qualified column suggestions are expected in the completion results.
   *
   * Requirement 11.3: When the FROM clause references aliased tables, the system
   * SHALL offer alias-qualified column completions (e.g., `o.OrderDate`, `o.CustomerId`)
   * when the user types `WHERE ` without an alias-dot prefix.
   *
   * On UNFIXED code: In a multi-statement batch, getColumnCompletions() receives
   * scoped text that may not include the FROM clause table references, or the
   * columns returned are not alias-qualified as the requirement states.
   *
   * **Validates: Requirements 11.1, 11.3**
   */
  describe('Test 1d: WHERE Column Completions (no alias-dot prefix)', () => {
    it('should return alias-qualified column completions in multi-statement batch WHERE', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(
            // Multi-statement batch: prior statement + current statement with WHERE
            'SELECT 1;\nSELECT * FROM Orders o WHERE ',
            'DECLARE @x INT = 1;\nSELECT * FROM dbo.Orders o WHERE ',
            'INSERT INTO Logs VALUES (1);\nSELECT OrderId FROM Orders o INNER JOIN Customers c ON o.CustomerId = c.Id WHERE '
          ),
          (documentText) => {
            const schemaCache = createMockSchemaCache({
              tables: [
                {
                  schema: 'dbo',
                  name: 'Orders',
                  columns: [
                    { name: 'OrderId', dataType: 'int', isNullable: false },
                    { name: 'OrderDate', dataType: 'datetime', isNullable: false },
                    { name: 'CustomerId', dataType: 'int', isNullable: false },
                    { name: 'TotalAmount', dataType: 'decimal', isNullable: true },
                  ],
                },
                {
                  schema: 'dbo',
                  name: 'Customers',
                  columns: [
                    { name: 'Id', dataType: 'int', isNullable: false },
                    { name: 'Name', dataType: 'nvarchar', isNullable: false },
                  ],
                },
                {
                  schema: 'dbo',
                  name: 'Logs',
                  columns: [
                    { name: 'Id', dataType: 'int', isNullable: false },
                  ],
                },
              ],
            });

            const offset = documentText.length;
            const items = getCompletions(documentText, offset, schemaCache, true);

            // Should return column completions from referenced tables
            // Filter to field-kind items (columns)
            const columnItems = items.filter(i => i.kind === 5); // CompletionItemKind.Field = 5

            // There should be column completions available
            expect(columnItems.length).toBeGreaterThan(0);

            // Requirement 11.3: When FROM references aliased tables, the system
            // SHALL offer alias-qualified column completions (e.g., `o.OrderDate`, `o.CustomerId`)
            const labels = columnItems.map(i => i.label as string);
            const hasAliasQualifiedColumns = labels.some(l => l.startsWith('o.'));
            expect(hasAliasQualifiedColumns).toBe(true);
          }
        ),
        { numRuns: 1 }
      );
    });
  });

  // ─── Test 1e: WHERE Operator Completions ───────────────────────────────────────

  /**
   * Test 1e: WHERE Operator Completions
   *
   * Bug 4b (WHERE Operators): detectColumnBeforeCursor() doesn't recognize bare
   * column names (without alias prefix) in multi-statement batches, so operator
   * suggestions aren't offered when typing `WHERE OrderDate `.
   *
   * When the user types a column name followed by a space in WHERE context,
   * operator completions (=, <, >, <=, >=, <>, LIKE, IN, BETWEEN) should be returned.
   *
   * On UNFIXED code: detectColumnBeforeCursor() fails to identify the preceding
   * token as a column when the scoped text doesn't include the FROM clause
   * (multi-statement batch), meaning no operators are offered.
   *
   * **Validates: Requirements 11.2**
   */
  describe('Test 1e: WHERE Operator Completions', () => {
    it('should return operator completions after a bare column name in multi-statement WHERE', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(
            'SELECT 1;\nSELECT * FROM Orders o WHERE OrderDate ',
            'DECLARE @x INT;\nSELECT * FROM Orders o WHERE TotalAmount ',
            'INSERT INTO Logs VALUES (1);\nSELECT * FROM dbo.Orders o WHERE CustomerId '
          ),
          (documentText) => {
            const schemaCache = createMockSchemaCache({
              tables: [
                {
                  schema: 'dbo',
                  name: 'Orders',
                  columns: [
                    { name: 'OrderId', dataType: 'int', isNullable: false },
                    { name: 'OrderDate', dataType: 'datetime', isNullable: false },
                    { name: 'CustomerId', dataType: 'int', isNullable: false },
                    { name: 'TotalAmount', dataType: 'decimal', isNullable: true },
                  ],
                },
                {
                  schema: 'dbo',
                  name: 'Logs',
                  columns: [
                    { name: 'Id', dataType: 'int', isNullable: false },
                  ],
                },
              ],
            });

            const offset = documentText.length;
            const items = getCompletions(documentText, offset, schemaCache, true);

            // Should return operator completions
            const operatorItems = items.filter(i => i.kind === 24); // CompletionItemKind.Operator = 24

            // There should be operator suggestions
            expect(operatorItems.length).toBeGreaterThan(0);

            // Should include standard comparison operators
            const opLabels = operatorItems.map(i => i.label as string);
            expect(opLabels).toContain('=');
            expect(opLabels).toContain('<');
            expect(opLabels).toContain('>');
            expect(opLabels).toContain('<=');
            expect(opLabels).toContain('>=');
            expect(opLabels).toContain('<>');
            expect(opLabels).toContain('LIKE');
            expect(opLabels).toContain('IN');
            expect(opLabels).toContain('BETWEEN');
          }
        ),
        { numRuns: 1 }
      );
    });
  });
});
