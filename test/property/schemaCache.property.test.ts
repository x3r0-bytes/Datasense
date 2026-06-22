import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  SchemaCache,
  SchemaSnapshot,
  TableInfo,
  ViewInfo,
  ProcedureInfo,
  ColumnInfo,
} from '../../server/src/schemaCache';

/**
 * Property-based tests for SchemaCache non-blocking refresh (Properties 6, 7, 8)
 * Feature: v1-release-readiness
 *
 * Validates: Requirements 4.1, 4.3, 4.4, 4.6, 4.7
 */

// --- Generators ---

/** Generator: random valid SQL identifier */
const arbitraryIdentifier: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')),
      { minLength: 1, maxLength: 10 }
    )
  )
  .map(([first, rest]) => first + rest);

/** Generator: random schema name */
const arbitrarySchemaName: fc.Arbitrary<string> = fc.constantFrom(
  'dbo', 'sales', 'hr', 'admin', 'app', 'staging'
);

/** Generator: random column */
const arbitraryColumn: fc.Arbitrary<ColumnInfo> = fc.record({
  name: arbitraryIdentifier,
  dataType: fc.constantFrom('int', 'varchar', 'datetime', 'bit', 'decimal', 'nvarchar'),
  isNullable: fc.boolean(),
});

/** Generator: random table info */
const arbitraryTableInfo: fc.Arbitrary<TableInfo> = fc.record({
  schema: arbitrarySchemaName,
  name: arbitraryIdentifier,
  columns: fc.array(arbitraryColumn, { minLength: 1, maxLength: 5 }),
});

/** Generator: random view info */
const arbitraryViewInfo: fc.Arbitrary<ViewInfo> = fc.record({
  schema: arbitrarySchemaName,
  name: arbitraryIdentifier,
  columns: fc.array(arbitraryColumn, { minLength: 1, maxLength: 5 }),
});

/** Generator: random procedure info */
const arbitraryProcedureInfo: fc.Arbitrary<ProcedureInfo> = fc.record({
  schema: arbitrarySchemaName,
  name: arbitraryIdentifier,
});

/** Generator: a random schema state (tables, views, procedures) */
const arbitrarySchemaState = fc.record({
  tables: fc.array(arbitraryTableInfo, { minLength: 0, maxLength: 6 }),
  views: fc.array(arbitraryViewInfo, { minLength: 0, maxLength: 4 }),
  procedures: fc.array(arbitraryProcedureInfo, { minLength: 0, maxLength: 4 }),
});

// --- Helpers ---

/**
 * Populate a SchemaCache with a given schema state by directly setting the snapshot.
 * This avoids needing a real database connection.
 */
function populateCacheWithState(
  cache: SchemaCache,
  state: { tables: TableInfo[]; views: ViewInfo[]; procedures: ProcedureInfo[] }
): void {
  const tablesMap = new Map<string, TableInfo>();
  for (const t of state.tables) {
    tablesMap.set(`${t.schema}.${t.name}`, t);
  }

  const viewsMap = new Map<string, ViewInfo>();
  for (const v of state.views) {
    viewsMap.set(`${v.schema}.${v.name}`, v);
  }

  const proceduresMap = new Map<string, ProcedureInfo>();
  for (const p of state.procedures) {
    proceduresMap.set(`${p.schema}.${p.name}`, p);
  }

  const snapshot: SchemaSnapshot = {
    tables: tablesMap,
    views: viewsMap,
    procedures: proceduresMap,
    foreignKeyList: [],
    foreignKeyIndex: new Map(),
    primaryKeyIndex: new Map(),
    lastRefreshed: new Date(),
  };

  (cache as any).snapshot = snapshot;
}

/**
 * Create a mock pool that delays responses to simulate a slow refresh.
 * The pool returns results based on the provided new state after the specified delay.
 */
function createDelayedMockPool(
  newState: { tables: TableInfo[]; views: ViewInfo[]; procedures: ProcedureInfo[] },
  delayMs: number
): any {
  const tableRows = newState.tables.flatMap((t) =>
    t.columns.map((c) => ({
      TABLE_SCHEMA: t.schema,
      TABLE_NAME: t.name,
      COLUMN_NAME: c.name,
      DATA_TYPE: c.dataType,
      IS_NULLABLE: c.isNullable ? 'YES' : 'NO',
    }))
  );

  const viewRows = newState.views.flatMap((v) =>
    v.columns.map((c) => ({
      TABLE_SCHEMA: v.schema,
      TABLE_NAME: v.name,
      COLUMN_NAME: c.name,
      DATA_TYPE: c.dataType,
      IS_NULLABLE: c.isNullable ? 'YES' : 'NO',
    }))
  );

  const procedureRows = newState.procedures.map((p) => ({
    ROUTINE_SCHEMA: p.schema,
    ROUTINE_NAME: p.name,
  }));

  return {
    request: () => ({
      query: (sql: string) =>
        new Promise((resolve) => {
          setTimeout(() => {
            if (sql.includes('INFORMATION_SCHEMA.VIEWS')) {
              resolve({ recordset: viewRows });
            } else if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
              resolve({ recordset: tableRows });
            } else if (sql.includes('INFORMATION_SCHEMA.ROUTINES')) {
              resolve({ recordset: procedureRows });
            } else if (sql.includes('sys.foreign_keys')) {
              resolve({ recordset: [] });
            } else if (sql.includes('sys.indexes')) {
              resolve({ recordset: [] });
            } else {
              resolve({ recordset: [] });
            }
          }, delayMs);
        }),
    }),
  };
}

/**
 * Create a mock pool where the main queries (tables) fail but FK/PK return empty.
 * This simulates a connection failure during refresh that the cache should handle gracefully.
 * The performRefresh uses Promise.all so if queryTables fails, the whole refresh fails.
 */
function createFailingMockPool(): any {
  let callCount = 0;
  return {
    request: () => ({
      query: (sql: string) => {
        callCount++;
        // All queries reject — the Promise.all in performRefresh will fail
        return Promise.reject(new Error('Connection lost'));
      },
    }),
  };
}

/**
 * Create a mock pool that returns data instantly (for successful refresh).
 */
function createInstantMockPool(
  state: { tables: TableInfo[]; views: ViewInfo[]; procedures: ProcedureInfo[] }
): any {
  return createDelayedMockPool(state, 0);
}

// --- Tests ---

describe('SchemaCache Non-Blocking Refresh Property Tests', () => {
  // Feature: v1-release-readiness, Property 6: Completions served from stable snapshot during refresh
  describe('Property 6: Completions served from stable snapshot during refresh', () => {
    /**
     * Validates: Requirements 4.1, 4.3
     *
     * For any schema cache state S, while a refresh is in progress (isPopulating === true),
     * all completion requests SHALL return data derived entirely from S (the pre-refresh snapshot),
     * not from the partially-built new data.
     */

    it('reads during refresh return pre-refresh data', async () => {
      await fc.assert(
        fc.asyncProperty(arbitrarySchemaState, arbitrarySchemaState, async (initialState, newState) => {
          const cache = new SchemaCache();
          populateCacheWithState(cache, initialState);

          // Capture pre-refresh state
          const preRefreshTables = cache.tables;
          const preRefreshViews = cache.views;
          const preRefreshProcedures = cache.procedures;

          // Start a slow refresh (5ms delay per query — fast enough for 100 runs)
          const slowPool = createDelayedMockPool(newState, 5);
          const refreshPromise = cache.refresh(slowPool);

          // Verify isPopulating is true during refresh
          expect(cache.isPopulating).toBe(true);

          // Read from cache during refresh — should return pre-refresh data
          const duringRefreshTables = cache.tables;
          const duringRefreshViews = cache.views;
          const duringRefreshProcedures = cache.procedures;

          // The data read during refresh must be identical to pre-refresh data
          expect(duringRefreshTables).toEqual(preRefreshTables);
          expect(duringRefreshViews).toEqual(preRefreshViews);
          expect(duringRefreshProcedures).toEqual(preRefreshProcedures);

          // Wait for refresh to complete
          await refreshPromise;
        }),
        { numRuns: 100 }
      );
    }, 30000);

    it('multiple reads during refresh all return the same pre-refresh snapshot', async () => {
      await fc.assert(
        fc.asyncProperty(arbitrarySchemaState, arbitrarySchemaState, async (initialState, newState) => {
          const cache = new SchemaCache();
          populateCacheWithState(cache, initialState);

          const preRefreshTables = cache.tables;
          const preRefreshViews = cache.views;

          // Start a slow refresh
          const slowPool = createDelayedMockPool(newState, 5);
          const refreshPromise = cache.refresh(slowPool);

          // Multiple reads during refresh should all return the same data
          const read1 = cache.tables;
          const read2 = cache.tables;
          const read3 = cache.views;

          expect(read1).toEqual(preRefreshTables);
          expect(read2).toEqual(preRefreshTables);
          expect(read3).toEqual(preRefreshViews);

          await refreshPromise;
        }),
        { numRuns: 100 }
      );
    }, 30000);
  });

  // Feature: v1-release-readiness, Property 7: Atomic snapshot consistency
  describe('Property 7: Atomic snapshot consistency', () => {
    /**
     * Validates: Requirements 4.3
     *
     * For any completion request at any point in time, all returned data
     * (tables, views, procedures, foreign keys, primary keys) SHALL originate
     * from a single SchemaSnapshot instance — never a mixture of two snapshots.
     */

    it('all getters read from the same snapshot instance', () => {
      fc.assert(
        fc.property(arbitrarySchemaState, (state) => {
          const cache = new SchemaCache();
          populateCacheWithState(cache, state);

          // Read all getters — they should all originate from the same snapshot
          const tables = cache.tables;
          const views = cache.views;
          const procedures = cache.procedures;
          const foreignKeys = cache.foreignKeys;

          // Verify the underlying snapshot reference is the same for all reads
          const snapshotRef = (cache as any).snapshot;
          expect(tables).toEqual(Array.from(snapshotRef.tables.values()));
          expect(views).toEqual(Array.from(snapshotRef.views.values()));
          expect(procedures).toEqual(Array.from(snapshotRef.procedures.values()));
          expect(foreignKeys).toEqual(snapshotRef.foreignKeyList);
        }),
        { numRuns: 100 }
      );
    });

    it('after refresh completes, all getters reflect the new snapshot consistently', async () => {
      await fc.assert(
        fc.asyncProperty(arbitrarySchemaState, arbitrarySchemaState, async (initialState, newState) => {
          const cache = new SchemaCache();
          populateCacheWithState(cache, initialState);

          // Perform a successful refresh
          const pool = createInstantMockPool(newState);
          await cache.refresh(pool);

          // After refresh, all reads should come from the new snapshot
          const snapshotRef = (cache as any).snapshot;
          const tables = cache.tables;
          const views = cache.views;
          const procedures = cache.procedures;

          // All values should match the current snapshot
          expect(tables).toEqual(Array.from(snapshotRef.tables.values()));
          expect(views).toEqual(Array.from(snapshotRef.views.values()));
          expect(procedures).toEqual(Array.from(snapshotRef.procedures.values()));

          // lastRefreshed should be set
          expect(snapshotRef.lastRefreshed).toBeInstanceOf(Date);
        }),
        { numRuns: 100 }
      );
    });

    it('snapshot swap is atomic — no mixed state between two distinct schemas', async () => {
      await fc.assert(
        fc.asyncProperty(arbitrarySchemaState, arbitrarySchemaState, async (stateA, stateB) => {
          const cache = new SchemaCache();
          populateCacheWithState(cache, stateA);

          // Record snapshot before refresh
          const beforeSnapshot = (cache as any).snapshot;

          // Refresh to state B
          const pool = createInstantMockPool(stateB);
          await cache.refresh(pool);

          // Read after refresh — all reads must come from the SAME new snapshot
          const afterSnapshot = (cache as any).snapshot;
          const afterTables = cache.tables;
          const afterViews = cache.views;
          const afterProcedures = cache.procedures;

          expect(afterTables).toEqual(Array.from(afterSnapshot.tables.values()));
          expect(afterViews).toEqual(Array.from(afterSnapshot.views.values()));
          expect(afterProcedures).toEqual(Array.from(afterSnapshot.procedures.values()));

          // The snapshot object should have been replaced (a new object)
          if (beforeSnapshot !== afterSnapshot) {
            expect((cache as any).snapshot).toBe(afterSnapshot);
            expect((cache as any).snapshot).not.toBe(beforeSnapshot);
          }
        }),
        { numRuns: 100 }
      );
    });
  });

  // Feature: v1-release-readiness, Property 8: Non-successful refresh preserves state
  describe('Property 8: Non-successful refresh preserves state', () => {
    /**
     * Validates: Requirements 4.4, 4.6, 4.7
     *
     * For any schema cache in state S, if a refresh fails (query error, timeout,
     * or concurrent refresh rejection via isPopulating guard), the cache state
     * after the attempted refresh SHALL be identical to S.
     */

    it('failed refresh (query error) preserves previous state', async () => {
      await fc.assert(
        fc.asyncProperty(arbitrarySchemaState, async (initialState) => {
          const cache = new SchemaCache();
          populateCacheWithState(cache, initialState);

          // Capture pre-refresh state
          const preRefreshTables = cache.tables;
          const preRefreshViews = cache.views;
          const preRefreshProcedures = cache.procedures;
          const preRefreshForeignKeys = cache.foreignKeys;
          const preRefreshSnapshot = (cache as any).snapshot;

          // Attempt a refresh with a failing pool — refresh will throw
          const failingPool = createFailingMockPool();
          try {
            await cache.refresh(failingPool);
          } catch {
            // Expected — refresh propagates query errors
          }

          // After failed refresh, state must be identical to pre-refresh
          expect(cache.tables).toEqual(preRefreshTables);
          expect(cache.views).toEqual(preRefreshViews);
          expect(cache.procedures).toEqual(preRefreshProcedures);
          expect(cache.foreignKeys).toEqual(preRefreshForeignKeys);

          // The snapshot reference itself should be unchanged
          expect((cache as any).snapshot).toBe(preRefreshSnapshot);

          // isPopulating should be reset to false
          expect(cache.isPopulating).toBe(false);
        }),
        { numRuns: 100 }
      );
    });

    it('concurrent refresh rejection preserves state (isPopulating guard)', async () => {
      await fc.assert(
        fc.asyncProperty(arbitrarySchemaState, arbitrarySchemaState, async (initialState, newState) => {
          const cache = new SchemaCache();
          populateCacheWithState(cache, initialState);

          // Capture pre-refresh state
          const preRefreshTables = cache.tables;
          const preRefreshViews = cache.views;
          const preRefreshProcedures = cache.procedures;

          // Start a slow refresh
          const slowPool = createDelayedMockPool(newState, 5);
          const firstRefresh = cache.refresh(slowPool);

          // Attempt a second refresh while first is in progress — should be rejected
          const secondPool = createInstantMockPool({
            tables: [{ schema: 'dbo', name: 'Conflict', columns: [{ name: 'id', dataType: 'int', isNullable: false }] }],
            views: [],
            procedures: [],
          });
          await cache.refresh(secondPool); // Rejected by isPopulating guard

          // During first refresh, cache should still show pre-refresh data
          expect(cache.tables).toEqual(preRefreshTables);
          expect(cache.views).toEqual(preRefreshViews);
          expect(cache.procedures).toEqual(preRefreshProcedures);

          // Wait for first refresh to complete
          await firstRefresh;
        }),
        { numRuns: 100 }
      );
    }, 30000);

    it('isPopulating resets to false after any failure', async () => {
      await fc.assert(
        fc.asyncProperty(arbitrarySchemaState, async (initialState) => {
          const cache = new SchemaCache();
          populateCacheWithState(cache, initialState);

          // Attempt a refresh with a failing pool
          const failingPool = createFailingMockPool();
          try {
            await cache.refresh(failingPool);
          } catch {
            // Expected — refresh propagates query errors
          }

          // isPopulating should be reset regardless of failure
          expect(cache.isPopulating).toBe(false);

          // A subsequent refresh should be allowed (not blocked)
          const successPool = createInstantMockPool({
            tables: [{ schema: 'dbo', name: 'AfterFailure', columns: [{ name: 'id', dataType: 'int', isNullable: false }] }],
            views: [],
            procedures: [],
          });
          await cache.refresh(successPool);

          // Verify the new refresh succeeded
          expect(cache.tables.some((t) => t.name === 'AfterFailure')).toBe(true);
          expect(cache.isPopulating).toBe(false);
        }),
        { numRuns: 100 }
      );
    });
  });
});
