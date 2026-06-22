import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SchemaCache } from '../../server/src/schemaCache';

// Helper to create a mock mssql.ConnectionPool
function createMockPool(queryResults: Record<string, any[]>) {
  return {
    request: () => ({
      query: vi.fn(async (sql: string) => {
        // Determine which query is being run based on content
        if (sql.includes('INFORMATION_SCHEMA.VIEWS')) {
          return { recordset: queryResults.views || [] };
        } else if (sql.includes('INFORMATION_SCHEMA.ROUTINES')) {
          return { recordset: queryResults.procedures || [] };
        } else if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
          return { recordset: queryResults.tables || [] };
        }
        return { recordset: [] };
      }),
    }),
  } as any;
}

describe('SchemaCache', () => {
  let cache: SchemaCache;

  beforeEach(() => {
    cache = new SchemaCache();
  });

  it('should start with empty collections', () => {
    expect(cache.tables).toEqual([]);
    expect(cache.views).toEqual([]);
    expect(cache.procedures).toEqual([]);
    expect(cache.isPopulating).toBe(false);
    expect(cache.lastRefreshed).toBeNull();
  });

  it('should populate tables from INFORMATION_SCHEMA query results', async () => {
    const pool = createMockPool({
      tables: [
        { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Users', COLUMN_NAME: 'Id', DATA_TYPE: 'int', IS_NULLABLE: 'NO' },
        { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Users', COLUMN_NAME: 'Name', DATA_TYPE: 'nvarchar', IS_NULLABLE: 'YES' },
        { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Orders', COLUMN_NAME: 'OrderId', DATA_TYPE: 'int', IS_NULLABLE: 'NO' },
      ],
      views: [],
      procedures: [],
    });

    await cache.refresh(pool);

    expect(cache.tables).toHaveLength(2);

    const usersTable = cache.tables.find(t => t.name === 'Users');
    expect(usersTable).toBeDefined();
    expect(usersTable!.schema).toBe('dbo');
    expect(usersTable!.columns).toHaveLength(2);
    expect(usersTable!.columns[0]).toEqual({ name: 'Id', dataType: 'int', isNullable: false });
    expect(usersTable!.columns[1]).toEqual({ name: 'Name', dataType: 'nvarchar', isNullable: true });

    const ordersTable = cache.tables.find(t => t.name === 'Orders');
    expect(ordersTable).toBeDefined();
    expect(ordersTable!.columns).toHaveLength(1);
  });

  it('should populate views from INFORMATION_SCHEMA query results', async () => {
    const pool = createMockPool({
      tables: [],
      views: [
        { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'ActiveUsers', COLUMN_NAME: 'Id', DATA_TYPE: 'int', IS_NULLABLE: 'NO' },
        { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'ActiveUsers', COLUMN_NAME: 'Email', DATA_TYPE: 'varchar', IS_NULLABLE: 'YES' },
      ],
      procedures: [],
    });

    await cache.refresh(pool);

    expect(cache.views).toHaveLength(1);
    const view = cache.views[0];
    expect(view.schema).toBe('dbo');
    expect(view.name).toBe('ActiveUsers');
    expect(view.columns).toHaveLength(2);
    expect(view.columns[0]).toEqual({ name: 'Id', dataType: 'int', isNullable: false });
    expect(view.columns[1]).toEqual({ name: 'Email', dataType: 'varchar', isNullable: true });
  });

  it('should populate procedures from INFORMATION_SCHEMA query results', async () => {
    const pool = createMockPool({
      tables: [],
      views: [],
      procedures: [
        { ROUTINE_SCHEMA: 'dbo', ROUTINE_NAME: 'GetUsers' },
        { ROUTINE_SCHEMA: 'admin', ROUTINE_NAME: 'CleanupLogs' },
      ],
    });

    await cache.refresh(pool);

    expect(cache.procedures).toHaveLength(2);
    expect(cache.procedures).toContainEqual({ schema: 'dbo', name: 'GetUsers' });
    expect(cache.procedures).toContainEqual({ schema: 'admin', name: 'CleanupLogs' });
  });

  it('should key tables by schema.name', async () => {
    const pool = createMockPool({
      tables: [
        { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Users', COLUMN_NAME: 'Id', DATA_TYPE: 'int', IS_NULLABLE: 'NO' },
        { TABLE_SCHEMA: 'hr', TABLE_NAME: 'Users', COLUMN_NAME: 'EmployeeId', DATA_TYPE: 'int', IS_NULLABLE: 'NO' },
      ],
      views: [],
      procedures: [],
    });

    await cache.refresh(pool);

    // Two different tables with same name but different schemas
    expect(cache.tables).toHaveLength(2);
    const dboUsers = cache.tables.find(t => t.schema === 'dbo' && t.name === 'Users');
    const hrUsers = cache.tables.find(t => t.schema === 'hr' && t.name === 'Users');
    expect(dboUsers).toBeDefined();
    expect(hrUsers).toBeDefined();
    expect(dboUsers!.columns[0].name).toBe('Id');
    expect(hrUsers!.columns[0].name).toBe('EmployeeId');
  });

  it('should set isPopulating during refresh and reset after', async () => {
    let resolveQuery: () => void;
    const queryPromise = new Promise<void>(resolve => { resolveQuery = resolve; });

    const pool = {
      request: () => ({
        query: vi.fn(async () => {
          await queryPromise;
          return { recordset: [] };
        }),
      }),
    } as any;

    const refreshPromise = cache.refresh(pool);
    expect(cache.isPopulating).toBe(true);

    resolveQuery!();
    await refreshPromise;
    expect(cache.isPopulating).toBe(false);
  });

  it('should not start a second refresh while one is in progress', async () => {
    let resolveQuery: () => void;
    const queryPromise = new Promise<void>(resolve => { resolveQuery = resolve; });

    let queryCallCount = 0;
    const pool = {
      request: () => ({
        query: vi.fn(async () => {
          queryCallCount++;
          await queryPromise;
          return { recordset: [] };
        }),
      }),
    } as any;

    const firstRefresh = cache.refresh(pool);
    const secondRefresh = cache.refresh(pool); // Should be a no-op

    resolveQuery!();
    await firstRefresh;
    await secondRefresh;

    // Only 5 queries from the first refresh (tables, views, procedures, foreign keys, primary keys)
    expect(queryCallCount).toBe(5);
  });

  it('should update lastRefreshed after successful refresh', async () => {
    const pool = createMockPool({ tables: [], views: [], procedures: [] });

    expect(cache.lastRefreshed).toBeNull();
    await cache.refresh(pool);
    expect(cache.lastRefreshed).toBeInstanceOf(Date);
  });

  it('should reset isPopulating even if refresh throws', async () => {
    const pool = {
      request: () => ({
        query: vi.fn(async () => { throw new Error('Connection lost'); }),
      }),
    } as any;

    await expect(cache.refresh(pool)).rejects.toThrow('Connection lost');
    expect(cache.isPopulating).toBe(false);
  });

  it('should correctly map IS_NULLABLE YES/NO to boolean', async () => {
    const pool = createMockPool({
      tables: [
        { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Test', COLUMN_NAME: 'Required', DATA_TYPE: 'int', IS_NULLABLE: 'NO' },
        { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Test', COLUMN_NAME: 'Optional', DATA_TYPE: 'varchar', IS_NULLABLE: 'YES' },
      ],
      views: [],
      procedures: [],
    });

    await cache.refresh(pool);

    const table = cache.tables[0];
    expect(table.columns[0].isNullable).toBe(false);
    expect(table.columns[1].isNullable).toBe(true);
  });
});

// --- Helper for full mock pool (tables + views + procedures + FKs + PKs) ---
function createFullMockPool(data: {
  tables?: any[];
  views?: any[];
  procedures?: any[];
  foreignKeys?: any[];
  primaryKeys?: any[];
}) {
  return {
    request: () => ({
      query: vi.fn(async (sql: string) => {
        if (sql.includes('INFORMATION_SCHEMA.VIEWS')) {
          return { recordset: data.views || [] };
        } else if (sql.includes('INFORMATION_SCHEMA.ROUTINES')) {
          return { recordset: data.procedures || [] };
        } else if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
          return { recordset: data.tables || [] };
        } else if (sql.includes('sys.foreign_keys')) {
          return { recordset: data.foreignKeys || [] };
        } else if (sql.includes('sys.indexes')) {
          return { recordset: data.primaryKeys || [] };
        }
        return { recordset: [] };
      }),
    }),
  } as any;
}

describe('SchemaCache — Refresh Resilience (Requirements 4.4, 4.6, 4.7)', () => {
  let cache: SchemaCache;

  beforeEach(() => {
    cache = new SchemaCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should abort refresh after 30-second timeout and retain previous snapshot', async () => {
    vi.useFakeTimers();

    // First: populate cache with known data
    const initialPool = createFullMockPool({
      tables: [
        { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Existing', COLUMN_NAME: 'Id', DATA_TYPE: 'int', IS_NULLABLE: 'NO' },
      ],
    });
    await cache.refresh(initialPool);
    expect(cache.tables).toHaveLength(1);
    expect(cache.tables[0].name).toBe('Existing');

    // Now: create a pool whose queries hang forever (simulates slow query)
    const pendingQueries: Array<{ resolve: (v: any) => void; reject: (e: any) => void }> = [];
    const slowPool = {
      request: () => ({
        query: vi.fn(() => new Promise((resolve, reject) => {
          pendingQueries.push({ resolve, reject });
        })),
      }),
    } as any;

    // Start refresh and immediately set up .catch to prevent unhandled rejection
    let caughtError: Error | null = null;
    const refreshPromise = cache.refresh(slowPool).catch((err: Error) => {
      caughtError = err;
    });

    // Advance time past the 30-second timeout
    await vi.advanceTimersByTimeAsync(30001);

    // Wait for the promise to settle
    await refreshPromise;

    // Resolve pending queries to prevent lingering promises
    for (const pq of pendingQueries) {
      pq.resolve({ recordset: [] });
    }

    // Verify the timeout error was thrown
    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toBe('Schema refresh timed out after 30 seconds');

    // Previous snapshot should be retained
    expect(cache.tables).toHaveLength(1);
    expect(cache.tables[0].name).toBe('Existing');
    expect(cache.isPopulating).toBe(false);
  });

  it('should discard concurrent refresh request (isPopulating guard)', async () => {
    // First: populate cache with initial data
    const initialPool = createFullMockPool({
      tables: [
        { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Original', COLUMN_NAME: 'Id', DATA_TYPE: 'int', IS_NULLABLE: 'NO' },
      ],
    });
    await cache.refresh(initialPool);
    expect(cache.tables[0].name).toBe('Original');

    // Now: create a slow pool so the first refresh is in-progress
    let resolveFirstRefresh!: () => void;
    const slowQueryPromise = new Promise<void>(resolve => { resolveFirstRefresh = resolve; });

    let queryCount = 0;
    const slowPool = {
      request: () => ({
        query: vi.fn(async (sql: string) => {
          queryCount++;
          await slowQueryPromise;
          if (sql.includes('INFORMATION_SCHEMA.VIEWS')) {
            return { recordset: [] };
          } else if (sql.includes('INFORMATION_SCHEMA.ROUTINES')) {
            return { recordset: [] };
          } else if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
            return { recordset: [{ TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Updated', COLUMN_NAME: 'Id', DATA_TYPE: 'int', IS_NULLABLE: 'NO' }] };
          } else if (sql.includes('sys.foreign_keys')) {
            return { recordset: [] };
          } else if (sql.includes('sys.indexes')) {
            return { recordset: [] };
          }
          return { recordset: [] };
        }),
      }),
    } as any;

    // Start first refresh (will hang until we resolve)
    const firstRefresh = cache.refresh(slowPool);
    expect(cache.isPopulating).toBe(true);

    // Second refresh should be discarded immediately
    const secondRefresh = cache.refresh(slowPool);
    await secondRefresh; // Should resolve immediately (no-op)

    // Data should still be the original (first refresh hasn't completed yet)
    expect(cache.tables[0].name).toBe('Original');

    // Complete first refresh
    resolveFirstRefresh();
    await firstRefresh;

    // Now first refresh data should be applied
    expect(cache.tables[0].name).toBe('Updated');

    // Only 5 queries were issued (from the first refresh only)
    expect(queryCount).toBe(5);
  });

  it('should swap snapshot atomically on successful refresh (new data accessible)', async () => {
    // First: populate with initial data
    const initialPool = createFullMockPool({
      tables: [
        { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'OldTable', COLUMN_NAME: 'Id', DATA_TYPE: 'int', IS_NULLABLE: 'NO' },
      ],
      views: [
        { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'OldView', COLUMN_NAME: 'X', DATA_TYPE: 'bit', IS_NULLABLE: 'NO' },
      ],
      procedures: [
        { ROUTINE_SCHEMA: 'dbo', ROUTINE_NAME: 'OldProc' },
      ],
      foreignKeys: [
        { constraint_name: 'FK_Old', referencing_schema: 'dbo', referencing_table: 'OldTable', referencing_column: 'Id', referenced_schema: 'dbo', referenced_table: 'Other', referenced_column: 'Id', ordinal_position: 1 },
      ],
      primaryKeys: [
        { schema_name: 'dbo', table_name: 'OldTable', column_name: 'Id' },
      ],
    });
    await cache.refresh(initialPool);

    expect(cache.tables[0].name).toBe('OldTable');
    expect(cache.views[0].name).toBe('OldView');
    expect(cache.procedures[0].name).toBe('OldProc');
    expect(cache.foreignKeys[0].constraintName).toBe('FK_Old');
    expect(cache.getPrimaryKeyColumns('dbo', 'OldTable')).toEqual(['Id']);

    // Second: refresh with completely new data
    const newPool = createFullMockPool({
      tables: [
        { TABLE_SCHEMA: 'hr', TABLE_NAME: 'NewTable', COLUMN_NAME: 'EmpId', DATA_TYPE: 'bigint', IS_NULLABLE: 'NO' },
      ],
      views: [
        { TABLE_SCHEMA: 'hr', TABLE_NAME: 'NewView', COLUMN_NAME: 'Y', DATA_TYPE: 'varchar', IS_NULLABLE: 'YES' },
      ],
      procedures: [
        { ROUTINE_SCHEMA: 'hr', ROUTINE_NAME: 'NewProc' },
      ],
      foreignKeys: [
        { constraint_name: 'FK_New', referencing_schema: 'hr', referencing_table: 'NewTable', referencing_column: 'EmpId', referenced_schema: 'hr', referenced_table: 'Dept', referenced_column: 'DeptId', ordinal_position: 1 },
      ],
      primaryKeys: [
        { schema_name: 'hr', table_name: 'NewTable', column_name: 'EmpId' },
      ],
    });
    await cache.refresh(newPool);

    // All data should now reflect the new snapshot atomically
    expect(cache.tables).toHaveLength(1);
    expect(cache.tables[0].name).toBe('NewTable');
    expect(cache.tables[0].schema).toBe('hr');
    expect(cache.tables[0].columns[0].name).toBe('EmpId');

    expect(cache.views).toHaveLength(1);
    expect(cache.views[0].name).toBe('NewView');

    expect(cache.procedures).toHaveLength(1);
    expect(cache.procedures[0].name).toBe('NewProc');

    expect(cache.foreignKeys).toHaveLength(1);
    expect(cache.foreignKeys[0].constraintName).toBe('FK_New');

    expect(cache.getPrimaryKeyColumns('hr', 'NewTable')).toEqual(['EmpId']);
    // Old PK data no longer accessible
    expect(cache.getPrimaryKeyColumns('dbo', 'OldTable')).toEqual([]);

    expect(cache.lastRefreshed).toBeInstanceOf(Date);
  });

  it('should retain previous snapshot when query fails', async () => {
    // First: populate with known data
    const initialPool = createFullMockPool({
      tables: [
        { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Preserved', COLUMN_NAME: 'Col1', DATA_TYPE: 'nvarchar', IS_NULLABLE: 'YES' },
      ],
      views: [
        { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'PreservedView', COLUMN_NAME: 'V1', DATA_TYPE: 'int', IS_NULLABLE: 'NO' },
      ],
      procedures: [
        { ROUTINE_SCHEMA: 'dbo', ROUTINE_NAME: 'PreservedProc' },
      ],
    });
    await cache.refresh(initialPool);

    const lastRefreshedBefore = cache.lastRefreshed;
    expect(cache.tables[0].name).toBe('Preserved');
    expect(cache.views[0].name).toBe('PreservedView');
    expect(cache.procedures[0].name).toBe('PreservedProc');

    // Now: attempt a refresh that throws
    const failingPool = {
      request: () => ({
        query: vi.fn(async () => { throw new Error('Connection pool closed'); }),
      }),
    } as any;

    await expect(cache.refresh(failingPool)).rejects.toThrow('Connection pool closed');

    // Previous snapshot should be unchanged
    expect(cache.tables).toHaveLength(1);
    expect(cache.tables[0].name).toBe('Preserved');
    expect(cache.views).toHaveLength(1);
    expect(cache.views[0].name).toBe('PreservedView');
    expect(cache.procedures).toHaveLength(1);
    expect(cache.procedures[0].name).toBe('PreservedProc');
    expect(cache.lastRefreshed).toBe(lastRefreshedBefore);
    expect(cache.isPopulating).toBe(false);
  });
});
