import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

/**
 * Property-based tests for Query Executor (Properties 12-13)
 * Feature: sql-server-extension, Property 12: Result set row limiting
 * Feature: sql-server-extension, Property 13: Error rendering completeness
 *
 * Validates: Requirements 3.5, 3.8
 */

// Mock vscode module
vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [
      { uri: { fsPath: '/test-workspace' } }
    ]
  },
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  EventEmitter: class {
    private listeners: Function[] = [];
    event = (listener: Function) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(data: any) {
      this.listeners.forEach(l => l(data));
    }
    dispose() {}
  }
}));

// Mock mssql module
vi.mock('mssql', () => {
  class MockRequest {
    multiple = false;
    private _pool: any;

    constructor(pool: any) {
      this._pool = pool;
    }

    async query(sql: string) {
      if (this._pool._queryFn) {
        return this._pool._queryFn(sql);
      }
      return { recordsets: [], rowsAffected: [0] };
    }

    cancel() {}
  }

  class MockConnectionPool {
    config: any;
    _queryFn: ((sql: string) => any) | null = null;

    constructor(config: any) {
      this.config = config;
    }

    request() {
      return new MockRequest(this);
    }

    async connect() { return this; }
    async close() {}
  }

  class RequestError extends Error {
    number: number;
    class: number;

    constructor(message: string, code?: string) {
      super(message);
      this.name = 'RequestError';
      this.number = 0;
      this.class = 0;
    }
  }

  return {
    ConnectionPool: MockConnectionPool,
    Request: MockRequest,
    RequestError,
  };
});

import * as mssql from 'mssql';
import { QueryExecutor } from '../../src/queryExecutor';

// --- Generators ---

/** Generator: random row count including values below, at, and above the 10,000 limit */
const arbitraryRowCount: fc.Arbitrary<number> = fc.oneof(
  // Below limit
  fc.integer({ min: 0, max: 9999 }),
  // At limit
  fc.constant(10000),
  // Above limit
  fc.integer({ min: 10001, max: 25000 })
);

/** Generator: random SQL error number */
const arbitraryErrorNumber: fc.Arbitrary<number> = fc.integer({ min: 0, max: 99999 });

/** Generator: random SQL error severity */
const arbitraryErrorSeverity: fc.Arbitrary<number> = fc.integer({ min: 0, max: 25 });

/** Generator: random SQL error message */
const arbitraryErrorMessage: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 200 });

/** Generator: a complete SqlError object */
const arbitrarySqlError: fc.Arbitrary<{ number: number; severity: number; message: string }> =
  fc.record({
    number: arbitraryErrorNumber,
    severity: arbitraryErrorSeverity,
    message: arbitraryErrorMessage,
  });

// --- Helper Functions ---

/**
 * Creates a mock mssql ConnectionPool that returns a configurable number of rows.
 * Each row has a sequential ID in the first column to verify ordering.
 */
function createMockPoolWithRows(rowCount: number, numCols: number = 3): mssql.ConnectionPool {
  const pool = new (mssql as any).ConnectionPool({});

  const columnNames = Array.from({ length: numCols }, (_, i) => `col${i}`);

  // Generate rows with sequential IDs so we can verify order
  const rows: any[] = [];
  for (let i = 0; i < rowCount; i++) {
    const row: Record<string, any> = {};
    columnNames.forEach((colName, colIdx) => {
      row[colName] = colIdx === 0 ? i : `value_${i}_${colIdx}`;
    });
    rows.push(row);
  }

  // Create a recordset that mimics mssql's IRecordSet (array-like with columns property)
  const recordset: any = [...rows];
  recordset.columns = {};
  columnNames.forEach((name) => {
    recordset.columns[name] = { type: { declaration: 'varchar' } };
  });

  pool._queryFn = (_sql: string) => ({
    recordsets: [recordset],
    rowsAffected: [rowCount],
  });

  return pool as unknown as mssql.ConnectionPool;
}

/**
 * Creates a mock mssql ConnectionPool that throws a RequestError with specific error details.
 */
function createMockPoolWithError(errorNumber: number, errorSeverity: number, errorMessage: string): mssql.ConnectionPool {
  const pool = new (mssql as any).ConnectionPool({});

  pool._queryFn = (_sql: string) => {
    const err = new (mssql as any).RequestError(errorMessage);
    err.number = errorNumber;
    err.class = errorSeverity;
    throw err;
  };

  return pool as unknown as mssql.ConnectionPool;
}

// --- Tests ---

describe('QueryExecutor Property Tests', () => {
  let executor: QueryExecutor;

  beforeEach(() => {
    executor = new QueryExecutor();
  });

  describe('Property 12: Result set row limiting', () => {
    /**
     * Validates: Requirements 3.5
     *
     * For any query result set containing R rows, the displayed result SHALL contain
     * exactly min(R, 10000) rows, preserving the first 10,000 rows in their original order.
     */

    it('result sets contain exactly min(R, 10000) rows', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryRowCount, async (rowCount) => {
          const pool = createMockPoolWithRows(rowCount);
          const expectedRows = Math.min(rowCount, 10000);

          const result = await executor.execute('SELECT 1', pool);

          expect(result.resultSets).toHaveLength(1);
          expect(result.resultSets[0].rows.length).toBe(expectedRows);
          expect(result.resultSets[0].rowCount).toBe(expectedRows);
        }),
        { numRuns: 100 }
      );
    });

    it('the first 10,000 rows are preserved in their original order', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryRowCount, async (rowCount) => {
          const pool = createMockPoolWithRows(rowCount);

          const result = await executor.execute('SELECT 1', pool);

          const rows = result.resultSets[0].rows;
          const expectedLength = Math.min(rowCount, 10000);

          expect(rows.length).toBe(expectedLength);

          // Verify order: first column contains sequential IDs starting from 0
          for (let i = 0; i < rows.length; i++) {
            expect(rows[i][0]).toBe(i);
          }
        }),
        { numRuns: 100 }
      );
    }, 60000);

    it('when rows <= 10000, all rows are returned without loss', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 10000 }),
          async (rowCount) => {
            const pool = createMockPoolWithRows(rowCount);

            const result = await executor.execute('SELECT 1', pool);

            expect(result.resultSets[0].rows.length).toBe(rowCount);
            expect(result.resultSets[0].rowCount).toBe(rowCount);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 13: Error rendering completeness', () => {
    /**
     * Validates: Requirements 3.8
     *
     * For any SqlError object with a number, severity, and message, the rendered error
     * output SHALL contain all three values as readable text.
     */

    it('error result contains the error number, severity, and message', async () => {
      await fc.assert(
        fc.asyncProperty(arbitrarySqlError, async (sqlError) => {
          const pool = createMockPoolWithError(
            sqlError.number,
            sqlError.severity,
            sqlError.message
          );

          const result = await executor.execute('SELECT 1', pool);

          // The QueryResult should have an error field
          expect(result.error).toBeDefined();
          expect(result.error!.number).toBe(sqlError.number);
          expect(result.error!.severity).toBe(sqlError.severity);
          expect(result.error!.message).toBe(sqlError.message);
        }),
        { numRuns: 100 }
      );
    });

    it('all three error fields are present as readable values (non-undefined, non-null)', async () => {
      await fc.assert(
        fc.asyncProperty(arbitrarySqlError, async (sqlError) => {
          const pool = createMockPoolWithError(
            sqlError.number,
            sqlError.severity,
            sqlError.message
          );

          const result = await executor.execute('SELECT 1', pool);

          expect(result.error).toBeDefined();

          // Number is a readable numeric value
          expect(typeof result.error!.number).toBe('number');
          expect(result.error!.number).not.toBeNaN();

          // Severity is a readable numeric value
          expect(typeof result.error!.severity).toBe('number');
          expect(result.error!.severity).not.toBeNaN();

          // Message is a readable string value
          expect(typeof result.error!.message).toBe('string');
          expect(result.error!.message.length).toBeGreaterThan(0);
        }),
        { numRuns: 100 }
      );
    });

    it('error object preserves all three fields with their exact values', async () => {
      await fc.assert(
        fc.asyncProperty(arbitrarySqlError, async (sqlError) => {
          const pool = createMockPoolWithError(
            sqlError.number,
            sqlError.severity,
            sqlError.message
          );

          const result = await executor.execute('SELECT 1', pool);

          expect(result.error).toBeDefined();

          // All three fields are present and match exactly
          expect(result.error).toEqual({
            number: sqlError.number,
            severity: sqlError.severity,
            message: sqlError.message,
          });
        }),
        { numRuns: 100 }
      );
    });
  });
});
