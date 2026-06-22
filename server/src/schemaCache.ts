import * as mssql from 'mssql';

// --- Interfaces ---

export interface ColumnInfo {
  name: string;
  dataType: string;
  isNullable: boolean;
}

export interface TableInfo {
  schema: string;
  name: string;
  columns: ColumnInfo[];
}

export interface ViewInfo {
  schema: string;
  name: string;
  columns: ColumnInfo[];
}

export interface ProcedureInfo {
  schema: string;
  name: string;
}

export interface ForeignKeyColumnPair {
  referencingColumn: string;
  referencedColumn: string;
  ordinalPosition: number;
}

export interface ForeignKeyInfo {
  constraintName: string;
  referencingSchema: string;
  referencingTable: string;
  referencedSchema: string;
  referencedTable: string;
  columnPairs: ForeignKeyColumnPair[];
}

export interface ISchemaCache {
  tables: TableInfo[];
  views: ViewInfo[];
  procedures: ProcedureInfo[];
  foreignKeys: ForeignKeyInfo[];
  /**
   * Refresh the cache using the provided pool.
   * Each call uses the pool passed in — the cache does not store an internal pool reference.
   * This allows the same SchemaCache instance to be refreshed against different databases,
   * or multiple SchemaCache instances to each target a different database-specific pool.
   */
  refresh(pool: mssql.ConnectionPool): Promise<void>;
  isPopulating: boolean;
  getForeignKeysForTable(schema: string, tableName: string): ForeignKeyInfo[];
  /**
   * Returns the column names participating in the primary key for the given table.
   * Uses case-insensitive comparison for schema and tableName parameters.
   * Returns an empty array if the table has no PK or is not found.
   */
  getPrimaryKeyColumns(schema: string, tableName: string): string[];
}

// --- Schema Snapshot (atomic swap target for non-blocking refresh) ---

export interface SchemaSnapshot {
  tables: Map<string, TableInfo>;
  views: Map<string, ViewInfo>;
  procedures: Map<string, ProcedureInfo>;
  foreignKeyList: ForeignKeyInfo[];
  foreignKeyIndex: Map<string, ForeignKeyInfo[]>;
  primaryKeyIndex: Map<string, string[]>;
  lastRefreshed: Date | null;
}

// --- Internal data structure (replaced by SchemaSnapshot above) ---

// --- Schema Cache Implementation ---

/**
 * SchemaCache stores metadata (tables, views, procedures, foreign keys) for a single database.
 *
 * **Multi-database usage:** Each SchemaCache instance is fully standalone — it holds no
 * internal pool reference and maintains no shared/static state. To cache multiple databases:
 * 1. Create a new `SchemaCache()` instance per database
 * 2. Call `refresh(pool)` with a database-specific ConnectionPool
 * 3. Each instance operates independently without affecting any other cache
 *
 * The `MultiDatabaseCache` orchestrator uses this pattern to manage per-database caches
 * for cross-database IntelliSense.
 */
export class SchemaCache implements ISchemaCache {
  private snapshot: SchemaSnapshot = {
    tables: new Map(),
    views: new Map(),
    procedures: new Map(),
    foreignKeyList: [],
    foreignKeyIndex: new Map(),
    primaryKeyIndex: new Map(),
    lastRefreshed: null,
  };

  public isPopulating: boolean = false;

  /**
   * Create a new standalone SchemaCache instance.
   * No pool is stored internally — a pool must be provided to `refresh()` each time.
   * This allows multiple instances to target different databases independently.
   */
  constructor() {
    // Intentionally empty — no internal pool reference.
    // Each refresh() call uses the pool passed as a parameter.
  }

  /**
   * Create a new SchemaCache and immediately populate it from the given pool.
   * Useful for creating secondary database caches in one step.
   *
   * @param pool - A ConnectionPool connected to the target database
   * @returns A populated SchemaCache instance
   */
  static async createFromPool(pool: mssql.ConnectionPool): Promise<SchemaCache> {
    const cache = new SchemaCache();
    await cache.refresh(pool);
    return cache;
  }

  get tables(): TableInfo[] {
    return Array.from(this.snapshot.tables.values());
  }

  get views(): ViewInfo[] {
    return Array.from(this.snapshot.views.values());
  }

  get procedures(): ProcedureInfo[] {
    return Array.from(this.snapshot.procedures.values());
  }

  get foreignKeys(): ForeignKeyInfo[] {
    return this.snapshot.foreignKeyList;
  }

  get lastRefreshed(): Date | null {
    return this.snapshot.lastRefreshed;
  }

  getForeignKeysForTable(schema: string, tableName: string): ForeignKeyInfo[] {
    const key = `${schema}.${tableName}`.toLowerCase();
    return this.snapshot.foreignKeyIndex.get(key) || [];
  }

  getPrimaryKeyColumns(schema: string, tableName: string): string[] {
    const key = `${schema}.${tableName}`.toLowerCase();
    return this.snapshot.primaryKeyIndex.get(key) || [];
  }

  /**
   * Refresh the schema cache by querying INFORMATION_SCHEMA.
   * Populates tables, views, and stored procedures from the connected database.
   * Must complete within 30 seconds.
   *
   * The pool parameter is used for this refresh only — no internal pool reference is stored.
   * This makes SchemaCache safe to use as an independent per-database cache instance.
   */
  async refresh(pool: mssql.ConnectionPool): Promise<void> {
    if (this.isPopulating) {
      return;
    }

    this.isPopulating = true;

    try {
      // Enforce 30-second overall timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Schema refresh timed out after 30 seconds')), 30000);
      });

      const refreshWork = this.performRefresh(pool);

      await Promise.race([refreshWork, timeoutPromise]);
    } finally {
      this.isPopulating = false;
    }
  }

  /**
   * Query schema metadata from a database pool WITHOUT modifying this cache's state.
   * Returns a snapshot of the schema data (tables, views, procedures) from the target pool.
   *
   * Use this when you need to inspect a database's schema without affecting the primary
   * cache state — for example, to preview or validate a secondary database connection
   * before committing to a full cache refresh.
   *
   * @param pool - A ConnectionPool connected to the target database
   * @returns A snapshot containing tables, views, and procedures from the target database
   */
  async querySchemaSnapshot(pool: mssql.ConnectionPool): Promise<{
    tables: TableInfo[];
    views: ViewInfo[];
    procedures: ProcedureInfo[];
    foreignKeys: ForeignKeyInfo[];
    primaryKeys: Map<string, string[]>;
  }> {
    const [tablesResult, viewsResult, proceduresResult, fkResult, pkResult] = await Promise.all([
      this.queryTables(pool),
      this.queryViews(pool),
      this.queryProcedures(pool),
      this.queryForeignKeys(pool).catch(() => null),
      this.queryPrimaryKeys(pool).catch(() => null),
    ]);

    // Build tables
    const tablesMap = new Map<string, TableInfo>();
    for (const row of tablesResult) {
      const key = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
      if (!tablesMap.has(key)) {
        tablesMap.set(key, { schema: row.TABLE_SCHEMA, name: row.TABLE_NAME, columns: [] });
      }
      tablesMap.get(key)!.columns.push({
        name: row.COLUMN_NAME,
        dataType: row.DATA_TYPE,
        isNullable: row.IS_NULLABLE === 'YES',
      });
    }

    // Build views
    const viewsMap = new Map<string, ViewInfo>();
    for (const row of viewsResult) {
      const key = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
      if (!viewsMap.has(key)) {
        viewsMap.set(key, { schema: row.TABLE_SCHEMA, name: row.TABLE_NAME, columns: [] });
      }
      viewsMap.get(key)!.columns.push({
        name: row.COLUMN_NAME,
        dataType: row.DATA_TYPE,
        isNullable: row.IS_NULLABLE === 'YES',
      });
    }

    // Build procedures
    const procedures: ProcedureInfo[] = proceduresResult.map((row: any) => ({
      schema: row.ROUTINE_SCHEMA,
      name: row.ROUTINE_NAME,
    }));

    // Build foreign keys
    const foreignKeys = fkResult !== null ? this.parseForeignKeys(fkResult) : [];

    // Build primary keys
    const primaryKeys = pkResult !== null ? this.parsePrimaryKeys(pkResult) : new Map<string, string[]>();

    return {
      tables: Array.from(tablesMap.values()),
      views: Array.from(viewsMap.values()),
      procedures,
      foreignKeys,
      primaryKeys,
    };
  }

  private async performRefresh(pool: mssql.ConnectionPool): Promise<void> {
    // Run all five queries concurrently for performance
    const [tablesResult, viewsResult, proceduresResult, fkResult, pkResult] = await Promise.all([
      this.queryTables(pool),
      this.queryViews(pool),
      this.queryProcedures(pool),
      this.queryForeignKeys(pool).catch((err: unknown) => {
        // On FK query failure: log error, retain previous FK data (Requirement 1.5, 9.5)
        console.error('[SchemaCache] Foreign key metadata query failed:', err);
        return null;
      }),
      this.queryPrimaryKeys(pool).catch((err: unknown) => {
        console.error('[SchemaCache] Primary key metadata query failed:', err);
        return null;
      }),
    ]);

    // Populate tables map
    const tables = new Map<string, TableInfo>();
    for (const row of tablesResult) {
      const key = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
      if (!tables.has(key)) {
        tables.set(key, {
          schema: row.TABLE_SCHEMA,
          name: row.TABLE_NAME,
          columns: [],
        });
      }
      tables.get(key)!.columns.push({
        name: row.COLUMN_NAME,
        dataType: row.DATA_TYPE,
        isNullable: row.IS_NULLABLE === 'YES',
      });
    }

    // Populate views map
    const views = new Map<string, ViewInfo>();
    for (const row of viewsResult) {
      const key = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
      if (!views.has(key)) {
        views.set(key, {
          schema: row.TABLE_SCHEMA,
          name: row.TABLE_NAME,
          columns: [],
        });
      }
      views.get(key)!.columns.push({
        name: row.COLUMN_NAME,
        dataType: row.DATA_TYPE,
        isNullable: row.IS_NULLABLE === 'YES',
      });
    }

    // Populate procedures map
    const procedures = new Map<string, ProcedureInfo>();
    for (const row of proceduresResult) {
      const key = `${row.ROUTINE_SCHEMA}.${row.ROUTINE_NAME}`;
      procedures.set(key, {
        schema: row.ROUTINE_SCHEMA,
        name: row.ROUTINE_NAME,
      });
    }

    // Build FK data: use new data if query succeeded, otherwise retain previous snapshot's FK data
    const foreignKeyList = fkResult !== null
      ? this.parseForeignKeys(fkResult)
      : this.snapshot.foreignKeyList;
    const foreignKeyIndex = fkResult !== null
      ? this.buildForeignKeyIndex(foreignKeyList)
      : this.snapshot.foreignKeyIndex;

    // Build PK data: use new data if query succeeded, otherwise retain previous snapshot's PK data
    const primaryKeyIndex = pkResult !== null
      ? this.parsePrimaryKeys(pkResult)
      : this.snapshot.primaryKeyIndex;

    // Atomic swap — single assignment guarantees no partial state is observable
    const newSnapshot: SchemaSnapshot = {
      tables,
      views,
      procedures,
      foreignKeyList,
      foreignKeyIndex,
      primaryKeyIndex,
      lastRefreshed: new Date(),
    };
    this.snapshot = newSnapshot;
  }

  /**
   * Parse raw FK query results into ForeignKeyInfo[], grouping column pairs
   * by constraint name in ordinal order.
   */
  private parseForeignKeys(rows: any[]): ForeignKeyInfo[] {
    const fkMap = new Map<string, ForeignKeyInfo>();

    for (const row of rows) {
      const constraintName = row.constraint_name;

      if (!fkMap.has(constraintName)) {
        fkMap.set(constraintName, {
          constraintName,
          referencingSchema: row.referencing_schema,
          referencingTable: row.referencing_table,
          referencedSchema: row.referenced_schema,
          referencedTable: row.referenced_table,
          columnPairs: [],
        });
      }

      fkMap.get(constraintName)!.columnPairs.push({
        referencingColumn: row.referencing_column,
        referencedColumn: row.referenced_column,
        ordinalPosition: row.ordinal_position,
      });
    }

    // Ensure column pairs are in ordinal order for each FK
    for (const fk of fkMap.values()) {
      fk.columnPairs.sort((a, b) => a.ordinalPosition - b.ordinalPosition);
    }

    return Array.from(fkMap.values());
  }

  /**
   * Build the foreignKeyIndex Map: for each FK, add it to both the referencing
   * table key AND the referenced table key (lowercased "schema.tableName").
   */
  private buildForeignKeyIndex(fkList: ForeignKeyInfo[]): Map<string, ForeignKeyInfo[]> {
    const index = new Map<string, ForeignKeyInfo[]>();

    for (const fk of fkList) {
      const referencingKey = `${fk.referencingSchema}.${fk.referencingTable}`.toLowerCase();
      const referencedKey = `${fk.referencedSchema}.${fk.referencedTable}`.toLowerCase();

      if (!index.has(referencingKey)) {
        index.set(referencingKey, []);
      }
      index.get(referencingKey)!.push(fk);

      if (!index.has(referencedKey)) {
        index.set(referencedKey, []);
      }
      index.get(referencedKey)!.push(fk);
    }

    return index;
  }

  private async queryTables(pool: mssql.ConnectionPool): Promise<any[]> {
    const request = pool.request();
    const result = await request.query(`
      SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_CATALOG = DB_NAME()
      ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
    `);
    return result.recordset;
  }

  private async queryViews(pool: mssql.ConnectionPool): Promise<any[]> {
    const request = pool.request();
    const result = await request.query(`
      SELECT c.TABLE_SCHEMA, c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE
      FROM INFORMATION_SCHEMA.COLUMNS c
      JOIN INFORMATION_SCHEMA.VIEWS v ON c.TABLE_SCHEMA = v.TABLE_SCHEMA AND c.TABLE_NAME = v.TABLE_NAME
      WHERE c.TABLE_CATALOG = DB_NAME()
      ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION
    `);
    return result.recordset;
  }

  private async queryProcedures(pool: mssql.ConnectionPool): Promise<any[]> {
    const request = pool.request();
    const result = await request.query(`
      SELECT ROUTINE_SCHEMA, ROUTINE_NAME
      FROM INFORMATION_SCHEMA.ROUTINES
      WHERE ROUTINE_TYPE = 'PROCEDURE' AND ROUTINE_CATALOG = DB_NAME()
    `);
    return result.recordset;
  }

  private async queryForeignKeys(pool: mssql.ConnectionPool): Promise<any[]> {
    const request = pool.request();
    const result = await request.query(`
      SELECT
        fk.name AS constraint_name,
        SCHEMA_NAME(fk.schema_id) AS referencing_schema,
        OBJECT_NAME(fk.parent_object_id) AS referencing_table,
        COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS referencing_column,
        SCHEMA_NAME(rt.schema_id) AS referenced_schema,
        OBJECT_NAME(fk.referenced_object_id) AS referenced_table,
        COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS referenced_column,
        fkc.constraint_column_id AS ordinal_position
      FROM sys.foreign_keys fk
      JOIN sys.foreign_key_columns fkc
        ON fk.object_id = fkc.constraint_object_id
      JOIN sys.tables rt
        ON fk.referenced_object_id = rt.object_id
      WHERE fk.is_disabled = 0
      ORDER BY fk.name, fkc.constraint_column_id
    `);
    return result.recordset;
  }

  private async queryPrimaryKeys(pool: mssql.ConnectionPool): Promise<any[]> {
    const request = pool.request();
    const result = await request.query(`
      SELECT
        s.name AS schema_name,
        t.name AS table_name,
        c.name AS column_name
      FROM sys.indexes i
      JOIN sys.index_columns ic
        ON i.object_id = ic.object_id AND i.index_id = ic.index_id
      JOIN sys.columns c
        ON ic.object_id = c.object_id AND ic.column_id = c.column_id
      JOIN sys.tables t
        ON i.object_id = t.object_id
      JOIN sys.schemas s
        ON t.schema_id = s.schema_id
      WHERE i.is_primary_key = 1
      ORDER BY s.name, t.name, ic.key_ordinal
    `);
    return result.recordset;
  }

  /**
   * Parse raw PK query results into a Map of table identity → column names.
   * Key is lowercased "schema.tablename" for case-insensitive lookup.
   * Column names preserve their original casing from the catalog.
   */
  private parsePrimaryKeys(rows: any[]): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const row of rows) {
      const key = `${row.schema_name}.${row.table_name}`.toLowerCase();
      if (!index.has(key)) {
        index.set(key, []);
      }
      index.get(key)!.push(row.column_name);
    }
    return index;
  }
}
