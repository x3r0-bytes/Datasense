/**
 * Snapshot Query Service
 *
 * Encapsulates SQL queries against INFORMATION_SCHEMA and sys catalog views
 * for capturing full schema snapshots used in Schema Diff comparison.
 * All queries use a 60-second timeout and filter to user tables only.
 */

import type * as mssql from 'mssql';
import { ColumnSnapshot, IndexSnapshot, ConstraintSnapshot } from './schemaDiffTypes';

/** Query timeout for all snapshot queries: 60 seconds */
const QUERY_TIMEOUT_MS = 60000;

/**
 * Creates an mssql Request with a per-request timeout override.
 * Uses pool.request() which delegates to the pool's internal driver.
 * Sets the request-level timeout override after creation.
 */
function createTimedRequest(pool: mssql.ConnectionPool): mssql.Request {
  const request = pool.request();
  // Both Tedious and msnodesqlv8 Request classes read overrides.requestTimeout
  // during query execution to determine per-request timeout
  (request as any).overrides = { requestTimeout: QUERY_TIMEOUT_MS };
  return request;
}

/**
 * Builds a table key from schema and table name for map grouping.
 */
function tableKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}

/**
 * Service for querying database metadata to build schema snapshots.
 * Queries INFORMATION_SCHEMA views and sys catalog views with 60-second timeout.
 * Filters to user tables only (excludes sys and INFORMATION_SCHEMA schemas).
 */
export class SnapshotQueryService {
  /**
   * Query all user tables in the specified schema.
   * Returns table schema and name pairs.
   */
  async queryTables(pool: mssql.ConnectionPool, schemaName: string): Promise<{ schema: string; name: string }[]> {
    const request = createTimedRequest(pool);
    request.input('schemaName', schemaName);

    const result = await request.query(`
      SELECT TABLE_SCHEMA, TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
        AND TABLE_SCHEMA = @schemaName
      ORDER BY TABLE_SCHEMA, TABLE_NAME
    `);

    return result.recordset.map((row: any) => ({
      schema: row.TABLE_SCHEMA,
      name: row.TABLE_NAME,
    }));
  }

  /**
   * Query columns for all tables in the specified schema.
   * Returns a map keyed by "schema.table" with ColumnSnapshot arrays.
   * Includes identity seed/increment from sys.identity_columns and
   * default constraint values from sys.default_constraints.
   */
  async queryColumns(pool: mssql.ConnectionPool, schemaName: string): Promise<Map<string, ColumnSnapshot[]>> {
    const request = createTimedRequest(pool);
    request.input('schemaName', schemaName);

    const result = await request.query(`
      SELECT
        c.TABLE_SCHEMA,
        c.TABLE_NAME,
        c.COLUMN_NAME,
        c.DATA_TYPE,
        c.CHARACTER_MAXIMUM_LENGTH,
        c.NUMERIC_PRECISION,
        c.NUMERIC_SCALE,
        c.DATETIME_PRECISION,
        c.IS_NULLABLE,
        sc.is_identity,
        ic.seed_value,
        ic.increment_value,
        dc.definition AS default_definition
      FROM INFORMATION_SCHEMA.COLUMNS c
      INNER JOIN INFORMATION_SCHEMA.TABLES t
        ON c.TABLE_SCHEMA = t.TABLE_SCHEMA
        AND c.TABLE_NAME = t.TABLE_NAME
      INNER JOIN sys.columns sc
        ON sc.object_id = OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME))
        AND sc.name = c.COLUMN_NAME
      LEFT JOIN sys.identity_columns ic
        ON ic.object_id = sc.object_id
        AND ic.column_id = sc.column_id
      LEFT JOIN sys.default_constraints dc
        ON dc.parent_object_id = sc.object_id
        AND dc.parent_column_id = sc.column_id
      WHERE t.TABLE_TYPE = 'BASE TABLE'
        AND c.TABLE_SCHEMA = @schemaName
      ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION
    `);

    const columnsMap = new Map<string, ColumnSnapshot[]>();

    for (const row of result.recordset) {
      const key = tableKey(row.TABLE_SCHEMA, row.TABLE_NAME);
      const dataType = this.formatColumnDataType(
        row.DATA_TYPE,
        row.CHARACTER_MAXIMUM_LENGTH,
        row.NUMERIC_PRECISION,
        row.NUMERIC_SCALE,
        row.DATETIME_PRECISION
      );

      const column: ColumnSnapshot = {
        name: row.COLUMN_NAME,
        dataType,
        isNullable: row.IS_NULLABLE === 'YES',
        defaultValue: row.default_definition ?? null,
        isIdentity: row.is_identity === true || row.is_identity === 1,
      };

      if (column.isIdentity) {
        column.identitySeed = row.seed_value != null ? Number(row.seed_value) : undefined;
        column.identityIncrement = row.increment_value != null ? Number(row.increment_value) : undefined;
      }

      if (!columnsMap.has(key)) {
        columnsMap.set(key, []);
      }
      columnsMap.get(key)!.push(column);
    }

    return columnsMap;
  }

  /**
   * Query indexes for all tables in the specified schema.
   * Returns a map keyed by "schema.table" with IndexSnapshot arrays.
   * Includes key columns and included columns, with proper type mapping.
   */
  async queryIndexes(pool: mssql.ConnectionPool, schemaName: string): Promise<Map<string, IndexSnapshot[]>> {
    const request = createTimedRequest(pool);
    request.input('schemaName', schemaName);

    const result = await request.query(`
      SELECT
        s.name AS schema_name,
        o.name AS table_name,
        i.name AS index_name,
        i.type_desc AS index_type,
        i.is_unique,
        c.name AS column_name,
        ic.is_included_column,
        ic.key_ordinal,
        ic.index_column_id
      FROM sys.indexes i
      INNER JOIN sys.objects o ON i.object_id = o.object_id
      INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
      INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
      INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
      WHERE o.type = 'U'
        AND s.name = @schemaName
        AND i.name IS NOT NULL
        AND i.type > 0
        AND i.is_primary_key = 0
        AND i.is_unique_constraint = 0
      ORDER BY s.name, o.name, i.name, ic.key_ordinal, ic.index_column_id
    `);

    // Group by schema.table, then by index name
    const indexMap = new Map<string, Map<string, { type: string; isUnique: boolean; columns: string[]; includedColumns: string[] }>>();

    for (const row of result.recordset) {
      const key = tableKey(row.schema_name, row.table_name);

      if (!indexMap.has(key)) {
        indexMap.set(key, new Map());
      }
      const tableIndexes = indexMap.get(key)!;

      if (!tableIndexes.has(row.index_name)) {
        tableIndexes.set(row.index_name, {
          type: row.index_type,
          isUnique: row.is_unique === true || row.is_unique === 1,
          columns: [],
          includedColumns: [],
        });
      }

      const idx = tableIndexes.get(row.index_name)!;
      if (row.is_included_column === true || row.is_included_column === 1) {
        idx.includedColumns.push(row.column_name);
      } else {
        idx.columns.push(row.column_name);
      }
    }

    // Convert to IndexSnapshot map
    const resultMap = new Map<string, IndexSnapshot[]>();
    for (const [key, tableIndexes] of indexMap.entries()) {
      const snapshots: IndexSnapshot[] = [];
      for (const [name, idx] of tableIndexes.entries()) {
        snapshots.push({
          name,
          type: this.mapIndexType(idx.type, idx.isUnique),
          columns: idx.columns,
          includedColumns: idx.includedColumns,
          isUnique: idx.isUnique,
        });
      }
      resultMap.set(key, snapshots);
    }

    return resultMap;
  }

  /**
   * Query constraints (PK, FK, UNIQUE, CHECK, DEFAULT) for all tables in the specified schema.
   * Returns a map keyed by "schema.table" with ConstraintSnapshot arrays.
   */
  async queryConstraints(pool: mssql.ConnectionPool, schemaName: string): Promise<Map<string, ConstraintSnapshot[]>> {
    // Query PRIMARY KEY and UNIQUE constraints with their columns
    const pkUniqueResult = await this.queryKeyConstraints(pool, schemaName);
    // Query FOREIGN KEY constraints
    const fkResult = await this.queryForeignKeyConstraints(pool, schemaName);
    // Query CHECK constraints
    const checkResult = await this.queryCheckConstraints(pool, schemaName);
    // Query DEFAULT constraints
    const defaultResult = await this.queryDefaultConstraints(pool, schemaName);

    // Merge all constraint maps
    const merged = new Map<string, ConstraintSnapshot[]>();

    for (const map of [pkUniqueResult, fkResult, checkResult, defaultResult]) {
      for (const [key, constraints] of map.entries()) {
        if (!merged.has(key)) {
          merged.set(key, []);
        }
        merged.get(key)!.push(...constraints);
      }
    }

    return merged;
  }

  /**
   * Query PRIMARY KEY and UNIQUE key constraints with their columns.
   */
  private async queryKeyConstraints(pool: mssql.ConnectionPool, schemaName: string): Promise<Map<string, ConstraintSnapshot[]>> {
    const request = createTimedRequest(pool);
    request.input('schemaName', schemaName);

    const result = await request.query(`
      SELECT
        s.name AS schema_name,
        o.name AS table_name,
        kc.name AS constraint_name,
        kc.type_desc AS constraint_type,
        c.name AS column_name,
        ic.key_ordinal
      FROM sys.key_constraints kc
      INNER JOIN sys.objects o ON kc.parent_object_id = o.object_id
      INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
      INNER JOIN sys.indexes i ON kc.parent_object_id = i.object_id AND kc.unique_index_id = i.index_id
      INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
      INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
      WHERE o.type = 'U'
        AND s.name = @schemaName
      ORDER BY s.name, o.name, kc.name, ic.key_ordinal
    `);

    const constraintMap = new Map<string, Map<string, { type: string; columns: string[] }>>();

    for (const row of result.recordset) {
      const key = tableKey(row.schema_name, row.table_name);

      if (!constraintMap.has(key)) {
        constraintMap.set(key, new Map());
      }
      const tableConstraints = constraintMap.get(key)!;

      if (!tableConstraints.has(row.constraint_name)) {
        tableConstraints.set(row.constraint_name, {
          type: row.constraint_type,
          columns: [],
        });
      }
      tableConstraints.get(row.constraint_name)!.columns.push(row.column_name);
    }

    const resultMap = new Map<string, ConstraintSnapshot[]>();
    for (const [key, constraints] of constraintMap.entries()) {
      const snapshots: ConstraintSnapshot[] = [];
      for (const [name, info] of constraints.entries()) {
        snapshots.push({
          name,
          type: info.type === 'PRIMARY_KEY_CONSTRAINT' ? 'PRIMARY KEY' : 'UNIQUE',
          columns: info.columns,
        });
      }
      resultMap.set(key, snapshots);
    }

    return resultMap;
  }

  /**
   * Query FOREIGN KEY constraints with their columns and referenced table.
   */
  private async queryForeignKeyConstraints(pool: mssql.ConnectionPool, schemaName: string): Promise<Map<string, ConstraintSnapshot[]>> {
    const request = createTimedRequest(pool);
    request.input('schemaName', schemaName);

    const result = await request.query(`
      SELECT
        s.name AS schema_name,
        o.name AS table_name,
        fk.name AS constraint_name,
        c.name AS column_name,
        rs.name AS referenced_schema,
        ro.name AS referenced_table,
        fkc.constraint_column_id
      FROM sys.foreign_keys fk
      INNER JOIN sys.objects o ON fk.parent_object_id = o.object_id
      INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
      INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
      INNER JOIN sys.columns c ON fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id
      INNER JOIN sys.objects ro ON fk.referenced_object_id = ro.object_id
      INNER JOIN sys.schemas rs ON ro.schema_id = rs.schema_id
      WHERE o.type = 'U'
        AND s.name = @schemaName
      ORDER BY s.name, o.name, fk.name, fkc.constraint_column_id
    `);

    const constraintMap = new Map<string, Map<string, { columns: string[]; definition: string }>>();

    for (const row of result.recordset) {
      const key = tableKey(row.schema_name, row.table_name);

      if (!constraintMap.has(key)) {
        constraintMap.set(key, new Map());
      }
      const tableConstraints = constraintMap.get(key)!;

      if (!tableConstraints.has(row.constraint_name)) {
        tableConstraints.set(row.constraint_name, {
          columns: [],
          definition: `${row.referenced_schema}.${row.referenced_table}`,
        });
      }
      tableConstraints.get(row.constraint_name)!.columns.push(row.column_name);
    }

    const resultMap = new Map<string, ConstraintSnapshot[]>();
    for (const [key, constraints] of constraintMap.entries()) {
      const snapshots: ConstraintSnapshot[] = [];
      for (const [name, info] of constraints.entries()) {
        snapshots.push({
          name,
          type: 'FOREIGN KEY',
          columns: info.columns,
          definition: info.definition,
        });
      }
      resultMap.set(key, snapshots);
    }

    return resultMap;
  }

  /**
   * Query CHECK constraints with their definition text.
   */
  private async queryCheckConstraints(pool: mssql.ConnectionPool, schemaName: string): Promise<Map<string, ConstraintSnapshot[]>> {
    const request = createTimedRequest(pool);
    request.input('schemaName', schemaName);

    const result = await request.query(`
      SELECT
        s.name AS schema_name,
        o.name AS table_name,
        cc.name AS constraint_name,
        cc.definition AS constraint_definition,
        c.name AS column_name
      FROM sys.check_constraints cc
      INNER JOIN sys.objects o ON cc.parent_object_id = o.object_id
      INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
      LEFT JOIN sys.columns c ON cc.parent_object_id = c.object_id AND cc.parent_column_id = c.column_id
      WHERE o.type = 'U'
        AND s.name = @schemaName
      ORDER BY s.name, o.name, cc.name
    `);

    const resultMap = new Map<string, ConstraintSnapshot[]>();

    for (const row of result.recordset) {
      const key = tableKey(row.schema_name, row.table_name);

      if (!resultMap.has(key)) {
        resultMap.set(key, []);
      }

      resultMap.get(key)!.push({
        name: row.constraint_name,
        type: 'CHECK',
        columns: row.column_name ? [row.column_name] : [],
        definition: row.constraint_definition ?? undefined,
      });
    }

    return resultMap;
  }

  /**
   * Query DEFAULT constraints with their definition text.
   */
  private async queryDefaultConstraints(pool: mssql.ConnectionPool, schemaName: string): Promise<Map<string, ConstraintSnapshot[]>> {
    const request = createTimedRequest(pool);
    request.input('schemaName', schemaName);

    const result = await request.query(`
      SELECT
        s.name AS schema_name,
        o.name AS table_name,
        dc.name AS constraint_name,
        dc.definition AS constraint_definition,
        c.name AS column_name
      FROM sys.default_constraints dc
      INNER JOIN sys.objects o ON dc.parent_object_id = o.object_id
      INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
      INNER JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
      WHERE o.type = 'U'
        AND s.name = @schemaName
      ORDER BY s.name, o.name, dc.name
    `);

    const resultMap = new Map<string, ConstraintSnapshot[]>();

    for (const row of result.recordset) {
      const key = tableKey(row.schema_name, row.table_name);

      if (!resultMap.has(key)) {
        resultMap.set(key, []);
      }

      resultMap.get(key)!.push({
        name: row.constraint_name,
        type: 'DEFAULT',
        columns: row.column_name ? [row.column_name] : [],
        definition: row.constraint_definition ?? undefined,
      });
    }

    return resultMap;
  }

  /**
   * Formats a column data type string from INFORMATION_SCHEMA metadata.
   * Handles character types, numeric types, and datetime types.
   */
  private formatColumnDataType(
    dataType: string,
    charMaxLength: number | null,
    numericPrecision: number | null,
    numericScale: number | null,
    datetimePrecision: number | null
  ): string {
    const lower = dataType.toLowerCase();

    // Character/binary types — use CHARACTER_MAXIMUM_LENGTH
    if (['varchar', 'nvarchar', 'char', 'nchar', 'varbinary', 'binary'].includes(lower)) {
      if (charMaxLength === -1) {
        return `${lower}(max)`;
      }
      return charMaxLength !== null ? `${lower}(${charMaxLength})` : lower;
    }

    // Numeric types — use NUMERIC_PRECISION and NUMERIC_SCALE
    if (['decimal', 'numeric'].includes(lower)) {
      if (numericPrecision !== null && numericScale !== null) {
        return `${lower}(${numericPrecision},${numericScale})`;
      }
      if (numericPrecision !== null) {
        return `${lower}(${numericPrecision})`;
      }
      return lower;
    }

    // Float — uses precision
    if (lower === 'float' && numericPrecision !== null && numericPrecision !== 53) {
      return `${lower}(${numericPrecision})`;
    }

    // datetime2, datetimeoffset, time — use DATETIME_PRECISION
    if (['datetime2', 'datetimeoffset', 'time'].includes(lower)) {
      if (datetimePrecision !== null && datetimePrecision !== 7) {
        return `${lower}(${datetimePrecision})`;
      }
      return lower;
    }

    // All other types have no qualifiers
    return lower;
  }

  /**
   * Maps sys.indexes type_desc and is_unique flag to IndexSnapshot type.
   */
  private mapIndexType(typeDesc: string, isUnique: boolean): IndexSnapshot['type'] {
    const upper = typeDesc.toUpperCase();
    if (isUnique && upper === 'CLUSTERED') {
      return 'UNIQUE CLUSTERED';
    }
    if (isUnique && upper === 'NONCLUSTERED') {
      return 'UNIQUE NONCLUSTERED';
    }
    if (upper === 'CLUSTERED') {
      return 'CLUSTERED';
    }
    return 'NONCLUSTERED';
  }
}
