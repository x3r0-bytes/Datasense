import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { filterRows, sortRows } from '../../src/resultPanelUtils';

/**
 * Property-based tests for result panel provider pure functions
 * Feature: ui-overhaul-v2
 *
 * Property 8: ResultSet Rendering Completeness (Validates: Requirements 9.1, 9.2)
 * Property 10: Column Filtering Correctness (Validates: Requirements 9.5)
 */

// --- Mock vscode for ResultPanelProvider import ---
vi.mock('vscode', () => ({
  Uri: {
    file: vi.fn((path: string) => ({ fsPath: path, scheme: 'file' })),
    joinPath: vi.fn((...args: any[]) => ({ fsPath: args.join('/'), scheme: 'file' })),
  },
  window: {
    registerWebviewViewProvider: vi.fn(),
  },
}));

import { ResultPanelProvider } from '../../src/resultPanelProvider';
import { QueryResult, ResultSet, ColumnMetadata } from '../../src/types';

// --- Helpers for Property 8 ---

/** Track posted messages for Property 8 tests */
let postedMessages: any[] = [];

/**
 * Creates a ResultPanelProvider with a resolved mock webview so postMessage works.
 */
function setupProvider(): ResultPanelProvider {
  postedMessages = [];

  const provider = new ResultPanelProvider({ fsPath: '/test', scheme: 'file' } as any);

  const mockWebviewView = {
    webview: {
      options: {},
      html: '',
      postMessage: vi.fn((msg: any) => {
        postedMessages.push(msg);
        return Promise.resolve(true);
      }),
      onDidReceiveMessage: vi.fn(),
    },
    show: vi.fn(),
    onDidDispose: vi.fn(),
  };

  // Resolve the webview view so postMessage is available
  provider.resolveWebviewView(
    mockWebviewView as any,
    {} as any,
    { isCancellationRequested: false, onCancellationRequested: vi.fn() } as any
  );

  // Clear any messages from initial setup
  postedMessages = [];

  return provider;
}

// --- Generators ---

/** Generator: arbitrary column name (non-empty string) */
const arbitraryColumnName: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 64 });

/** Generator: arbitrary data type string */
const arbitraryDataType: fc.Arbitrary<string> = fc.constantFrom(
  'int', 'varchar', 'nvarchar', 'datetime', 'bit', 'decimal', 'float', 'bigint', 'text', 'uniqueidentifier'
);

/** Generator: arbitrary column metadata */
const arbitraryColumnMetadata: fc.Arbitrary<ColumnMetadata> = fc.record({
  name: arbitraryColumnName,
  dataType: arbitraryDataType,
});

/** Generator: arbitrary cell value (string, number, null, or boolean) */
const arbitraryCellValue: fc.Arbitrary<any> = fc.oneof(
  fc.constant(null),
  fc.integer({ min: -1000000, max: 1000000 }),
  fc.string({ minLength: 0, maxLength: 50 }),
  fc.boolean(),
  fc.double({ min: -1000, max: 1000, noNaN: true })
);

/** Generator: arbitrary result set with at least 1 column and 0+ rows */
function arbitraryResultSet(minRows = 0, maxRows = 20): fc.Arbitrary<ResultSet> {
  return fc.integer({ min: 1, max: 8 }).chain((numCols) =>
    fc.tuple(
      fc.array(arbitraryColumnMetadata, { minLength: numCols, maxLength: numCols }),
      fc.array(
        fc.array(arbitraryCellValue, { minLength: numCols, maxLength: numCols }),
        { minLength: minRows, maxLength: maxRows }
      )
    ).map(([columns, rows]) => ({
      columns,
      rows,
      rowCount: rows.length,
    }))
  );
}

/** Generator: arbitrary QueryResult with N result sets */
function arbitraryQueryResult(minSets = 1, maxSets = 5): fc.Arbitrary<QueryResult> {
  return fc.integer({ min: minSets, max: maxSets }).chain((numSets) =>
    fc.tuple(
      fc.array(arbitraryResultSet(0, 15), { minLength: numSets, maxLength: numSets }),
      fc.nat({ max: 5000 }),
      fc.nat({ max: 100000 })
    ).map(([resultSets, rowsAffected, executionTimeMs]) => ({
      resultSets,
      rowsAffected,
      executionTimeMs,
    }))
  );
}

/** Generator: arbitrary row with a given number of columns (for Property 10) */
function arbitraryRow(numColumns: number): fc.Arbitrary<any[]> {
  return fc.tuple(...Array.from({ length: numColumns }, () => arbitraryCellValue));
}

/** Generator: arbitrary rows array with consistent column count (for Property 10) */
function arbitraryRows(minRows: number, maxRows: number, numColumns: number): fc.Arbitrary<any[][]> {
  return fc.array(arbitraryRow(numColumns), { minLength: minRows, maxLength: maxRows });
}

/** Generator: arbitrary non-empty filter string (for Property 10) */
const arbitraryFilterText: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 20 });

/** Generator: sort direction (for Property 9) */
const arbitraryDirection: fc.Arbitrary<'asc' | 'desc'> = fc.constantFrom('asc', 'desc');

// --- Tests ---

describe('Result Panel Provider Property Tests', () => {
  /**
   * Feature: ui-overhaul-v2, Property 8: ResultSet Rendering Completeness
   *
   * Validates: Requirements 9.1, 9.2
   *
   * For any QueryResult containing N result sets (N >= 1) where each result set
   * has columns and rows, the data message sent via postMessage SHALL contain
   * every column name and every non-null cell value. When N > 1, the message
   * SHALL contain exactly N entries in the resultSets array.
   */
  describe('Property 8: ResultSet Rendering Completeness', () => {
    it('posted message contains all column names from every result set', () => {
      fc.assert(
        fc.property(arbitraryQueryResult(1, 4), (queryResult) => {
          const provider = setupProvider();
          provider.show(queryResult);

          // Verify a message was posted
          expect(postedMessages.length).toBe(1);
          const message = postedMessages[0];
          expect(message.type).toBe('data');
          expect(message.result).toBeDefined();

          // Every column name from every result set must be present in the message
          for (let rsIdx = 0; rsIdx < queryResult.resultSets.length; rsIdx++) {
            const inputRs = queryResult.resultSets[rsIdx];
            const msgRs = message.result.resultSets[rsIdx];

            for (let c = 0; c < inputRs.columns.length; c++) {
              expect(msgRs.columns[c].name).toBe(inputRs.columns[c].name);
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    it('posted message contains all non-null cell values from every result set', () => {
      fc.assert(
        fc.property(arbitraryQueryResult(1, 3), (queryResult) => {
          const provider = setupProvider();
          provider.show(queryResult);

          expect(postedMessages.length).toBe(1);
          const message = postedMessages[0];
          expect(message.type).toBe('data');

          // Every non-null cell value must be present at the corresponding position
          for (let rsIdx = 0; rsIdx < queryResult.resultSets.length; rsIdx++) {
            const rs = queryResult.resultSets[rsIdx];
            const msgRs = message.result.resultSets[rsIdx];

            for (let rowIdx = 0; rowIdx < rs.rows.length; rowIdx++) {
              for (let colIdx = 0; colIdx < rs.rows[rowIdx].length; colIdx++) {
                const cellValue = rs.rows[rowIdx][colIdx];
                if (cellValue !== null && cellValue !== undefined) {
                  expect(msgRs.rows[rowIdx][colIdx]).toEqual(cellValue);
                }
              }
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    it('for N > 1 result sets, message contains exactly N entries in resultSets array', () => {
      fc.assert(
        fc.property(arbitraryQueryResult(2, 5), (queryResult) => {
          const provider = setupProvider();
          provider.show(queryResult);

          expect(postedMessages.length).toBe(1);
          const message = postedMessages[0];
          expect(message.type).toBe('data');

          // The number of result sets in the message must match the input
          const expectedN = queryResult.resultSets.length;
          expect(message.result.resultSets.length).toBe(expectedN);
        }),
        { numRuns: 100 }
      );
    });

    it('message preserves the exact structure: columns array and rows array for each result set', () => {
      fc.assert(
        fc.property(arbitraryQueryResult(1, 4), (queryResult) => {
          const provider = setupProvider();
          provider.show(queryResult);

          expect(postedMessages.length).toBe(1);
          const message = postedMessages[0];

          for (let i = 0; i < queryResult.resultSets.length; i++) {
            const inputRs = queryResult.resultSets[i];
            const msgRs = message.result.resultSets[i];

            // Column count matches
            expect(msgRs.columns.length).toBe(inputRs.columns.length);

            // Row count matches
            expect(msgRs.rows.length).toBe(inputRs.rows.length);
            expect(msgRs.rowCount).toBe(inputRs.rowCount);

            // Each column name and dataType is preserved
            for (let c = 0; c < inputRs.columns.length; c++) {
              expect(msgRs.columns[c].name).toBe(inputRs.columns[c].name);
              expect(msgRs.columns[c].dataType).toBe(inputRs.columns[c].dataType);
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    it('single result set (N=1) sends exactly 1 entry in resultSets with complete data', () => {
      fc.assert(
        fc.property(arbitraryQueryResult(1, 1), (queryResult) => {
          const provider = setupProvider();
          provider.show(queryResult);

          expect(postedMessages.length).toBe(1);
          const message = postedMessages[0];

          // Exactly 1 result set in the message
          expect(message.result.resultSets.length).toBe(1);

          // All data is present
          const inputRs = queryResult.resultSets[0];
          const msgRs = message.result.resultSets[0];
          expect(msgRs.columns).toEqual(inputRs.columns);
          expect(msgRs.rows).toEqual(inputRs.rows);
        }),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Feature: ui-overhaul-v2, Property 9: Sorting Correctness with Row Threshold
   *
   * Validates: Requirements 9.3, 9.4
   *
   * For any ResultSet, if the row count is ≤ 1000, then sorting by any column
   * index SHALL produce rows ordered by that column's values (ascending or
   * descending). Nulls are pushed to the end regardless of direction.
   * The sorted array contains exactly the same elements as the input (permutation).
   * The input array is not mutated.
   */
  describe('Property 9: Sorting Correctness with Row Threshold', () => {
    const NUM_COLUMNS = 3;

    it('sorted output is a permutation of the input (same elements, same length)', () => {
      fc.assert(
        fc.property(
          arbitraryRows(0, 50, NUM_COLUMNS),
          fc.integer({ min: 0, max: NUM_COLUMNS - 1 }),
          arbitraryDirection,
          (rows, columnIndex, direction) => {
            const result = sortRows(rows, columnIndex, direction);

            // Same length
            expect(result.length).toBe(rows.length);

            // Same elements (permutation check): sort both by JSON representation and compare
            const originalSerialized = rows.map((r) => JSON.stringify(r)).sort();
            const resultSerialized = result.map((r) => JSON.stringify(r)).sort();
            expect(resultSerialized).toEqual(originalSerialized);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('does not mutate the input array', () => {
      fc.assert(
        fc.property(
          arbitraryRows(0, 50, NUM_COLUMNS),
          fc.integer({ min: 0, max: NUM_COLUMNS - 1 }),
          arbitraryDirection,
          (rows, columnIndex, direction) => {
            // Deep copy to compare after sort
            const originalCopy = rows.map((r) => [...r]);

            sortRows(rows, columnIndex, direction);

            // Input should be unchanged
            expect(rows).toEqual(originalCopy);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('ascending sort produces non-decreasing order for non-null values (nulls at end)', () => {
      fc.assert(
        fc.property(
          arbitraryRows(0, 50, NUM_COLUMNS),
          fc.integer({ min: 0, max: NUM_COLUMNS - 1 }),
          (rows, columnIndex) => {
            const result = sortRows(rows, columnIndex, 'asc');

            // Find the boundary where nulls start
            const firstNullIndex = result.findIndex((r) => r[columnIndex] == null);
            const nonNullEnd = firstNullIndex === -1 ? result.length : firstNullIndex;

            // All elements after firstNullIndex should be null
            for (let i = nonNullEnd; i < result.length; i++) {
              expect(result[i][columnIndex]).toBeNull();
            }

            // Non-null portion should be in ascending order
            for (let i = 0; i < nonNullEnd - 1; i++) {
              const valA = result[i][columnIndex];
              const valB = result[i + 1][columnIndex];

              if (typeof valA === 'number' && typeof valB === 'number') {
                expect(valA).toBeLessThanOrEqual(valB);
              } else {
                // String comparison (case-insensitive)
                const strA = String(valA).toLowerCase();
                const strB = String(valB).toLowerCase();
                expect(strA <= strB).toBe(true);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('descending sort produces non-increasing order for non-null values (nulls at end)', () => {
      fc.assert(
        fc.property(
          arbitraryRows(0, 50, NUM_COLUMNS),
          fc.integer({ min: 0, max: NUM_COLUMNS - 1 }),
          (rows, columnIndex) => {
            const result = sortRows(rows, columnIndex, 'desc');

            // Find the boundary where nulls start
            const firstNullIndex = result.findIndex((r) => r[columnIndex] == null);
            const nonNullEnd = firstNullIndex === -1 ? result.length : firstNullIndex;

            // All elements after firstNullIndex should be null
            for (let i = nonNullEnd; i < result.length; i++) {
              expect(result[i][columnIndex]).toBeNull();
            }

            // Non-null portion should be in descending order
            for (let i = 0; i < nonNullEnd - 1; i++) {
              const valA = result[i][columnIndex];
              const valB = result[i + 1][columnIndex];

              if (typeof valA === 'number' && typeof valB === 'number') {
                expect(valA).toBeGreaterThanOrEqual(valB);
              } else {
                // String comparison (case-insensitive)
                const strA = String(valA).toLowerCase();
                const strB = String(valB).toLowerCase();
                expect(strA >= strB).toBe(true);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('sorting an empty array returns an empty array', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: NUM_COLUMNS - 1 }),
          arbitraryDirection,
          (columnIndex, direction) => {
            const result = sortRows([], columnIndex, direction);
            expect(result).toEqual([]);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('sorting a single-row array returns a single-element array with the same row', () => {
      fc.assert(
        fc.property(
          arbitraryRow(NUM_COLUMNS),
          fc.integer({ min: 0, max: NUM_COLUMNS - 1 }),
          arbitraryDirection,
          (row, columnIndex, direction) => {
            const result = sortRows([row], columnIndex, direction);
            expect(result.length).toBe(1);
            expect(result[0]).toEqual(row);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('sorting is stable for equal values (relative order preserved)', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 20 }),
          arbitraryDirection,
          (numRows, direction) => {
            // Create rows where column 0 has the same value but column 1 differs
            const sharedValue = 42;
            const rows = Array.from({ length: numRows }, (_, i) => [sharedValue, i, `row${i}`]);

            const result = sortRows(rows, 0, direction);

            // All rows should still be present
            expect(result.length).toBe(numRows);

            // Since all values in column 0 are equal, relative order should be preserved
            for (let i = 0; i < result.length; i++) {
              expect(result[i][1]).toBe(i);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Feature: ui-overhaul-v2, Property 10: Column Filtering Correctness
   *
   * Validates: Requirements 9.5
   *
   * For any ResultSet and any filter string applied to column index `i`,
   * the filtered result SHALL contain exactly those rows where the string
   * representation of the value at column `i` contains the filter string
   * (case-insensitive match), and no other rows.
   */
  describe('Property 10: Column Filtering Correctness', () => {
    const NUM_COLUMNS = 4;

    it('every row in the filtered result has a cell at columnIndex that contains filterText (case-insensitive)', () => {
      fc.assert(
        fc.property(
          arbitraryRows(0, 50, NUM_COLUMNS),
          fc.integer({ min: 0, max: NUM_COLUMNS - 1 }),
          arbitraryFilterText,
          (rows, columnIndex, filterText) => {
            const result = filterRows(rows, columnIndex, filterText);
            const lowerFilter = filterText.toLowerCase();

            for (const row of result) {
              const cell = row[columnIndex];
              const cellStr = cell == null ? 'null' : String(cell).toLowerCase();
              expect(cellStr).toContain(lowerFilter);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('every row NOT in the filtered result does NOT have a cell at columnIndex containing filterText', () => {
      fc.assert(
        fc.property(
          arbitraryRows(0, 50, NUM_COLUMNS),
          fc.integer({ min: 0, max: NUM_COLUMNS - 1 }),
          arbitraryFilterText,
          (rows, columnIndex, filterText) => {
            const result = filterRows(rows, columnIndex, filterText);
            const lowerFilter = filterText.toLowerCase();

            // Find rows that were excluded
            const excludedRows = rows.filter((row) => !result.includes(row));

            for (const row of excludedRows) {
              const cell = row[columnIndex];
              const cellStr = cell == null ? 'null' : String(cell).toLowerCase();
              expect(cellStr).not.toContain(lowerFilter);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('empty filter returns all rows', () => {
      fc.assert(
        fc.property(
          arbitraryRows(0, 50, NUM_COLUMNS),
          fc.integer({ min: 0, max: NUM_COLUMNS - 1 }),
          (rows, columnIndex) => {
            const result = filterRows(rows, columnIndex, '');
            expect(result).toHaveLength(rows.length);
            // Verify all original rows are present
            for (let i = 0; i < rows.length; i++) {
              expect(result[i]).toEqual(rows[i]);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('the filtered result is a subset of the input (no new rows created)', () => {
      fc.assert(
        fc.property(
          arbitraryRows(0, 50, NUM_COLUMNS),
          fc.integer({ min: 0, max: NUM_COLUMNS - 1 }),
          arbitraryFilterText,
          (rows, columnIndex, filterText) => {
            const result = filterRows(rows, columnIndex, filterText);

            // Result length must be <= input length
            expect(result.length).toBeLessThanOrEqual(rows.length);

            // Every row in result must be a reference to a row in the input
            for (const row of result) {
              expect(rows).toContain(row);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('null cells match against the string "null" (case-insensitive)', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 20 }),
          fc.integer({ min: 0, max: NUM_COLUMNS - 1 }),
          (numRows, columnIndex) => {
            // Create rows where the target column is always null
            const rows: any[][] = Array.from({ length: numRows }, () => {
              const row = Array.from({ length: NUM_COLUMNS }, () => 'somevalue');
              row[columnIndex] = null;
              return row;
            });

            // Filtering with "null" should include all rows (since all cells are null)
            const result = filterRows(rows, columnIndex, 'null');
            expect(result).toHaveLength(numRows);

            // Filtering with "NUL" (case-insensitive substring) should also include all
            const resultPartial = filterRows(rows, columnIndex, 'NUL');
            expect(resultPartial).toHaveLength(numRows);

            // Filtering with something not in "null" should exclude all
            const resultExclude = filterRows(rows, columnIndex, 'xyz');
            expect(resultExclude).toHaveLength(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('filtering is case-insensitive: same results regardless of filter case', () => {
      fc.assert(
        fc.property(
          arbitraryRows(0, 50, NUM_COLUMNS),
          fc.integer({ min: 0, max: NUM_COLUMNS - 1 }),
          arbitraryFilterText,
          (rows, columnIndex, filterText) => {
            const resultLower = filterRows(rows, columnIndex, filterText.toLowerCase());
            const resultUpper = filterRows(rows, columnIndex, filterText.toUpperCase());
            const resultOriginal = filterRows(rows, columnIndex, filterText);

            expect(resultLower).toHaveLength(resultOriginal.length);
            expect(resultUpper).toHaveLength(resultOriginal.length);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
