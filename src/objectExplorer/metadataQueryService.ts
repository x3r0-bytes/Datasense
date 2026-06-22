import * as mssql from 'mssql';
import {
  DatabaseInfo,
  TableMetadata,
  ViewMetadata,
  ColumnMetadata,
  ConstraintMetadata,
  TriggerMetadata,
  IndexMetadata,
  StatisticMetadata,
} from './types';

/**
 * System databases that are always classified as system regardless of query results.
 */
const SYSTEM_DATABASES = ['master', 'model', 'msdb', 'tempdb'];

/**
 * Maps sys.databases state codes to human-readable state strings.
 */
function mapDatabaseState(stateCode: number): DatabaseInfo['state'] {
  switch (stateCode) {
    case 0:
      return 'online';
    case 1:
      return 'restoring';
    case 2:
      return 'recovering';
    case 3:
      return 'recovering'; // RECOVERY_PENDING mapped to recovering
    case 4:
      return 'suspect';
    case 6:
      return 'offline';
    default:
      return 'offline';
  }
}

/**
 * Formats a SQL Server data type with its length/precision/scale qualifiers.
 */
function formatDataType(
  typeName: string,
  maxLength: number | null,
  precision: number | null,
  scale: number | null
): string {
  const lower = typeName.toLowerCase();

  // Types that use (max) or character length
  if (['varchar', 'nvarchar', 'char', 'nchar', 'varbinary', 'binary'].includes(lower)) {
    if (maxLength === -1) {
      return `${lower}(max)`;
    }
    // nvarchar/nchar store 2 bytes per character
    const charLength = ['nvarchar', 'nchar'].includes(lower) && maxLength !== null
      ? maxLength / 2
      : maxLength;
    return charLength !== null ? `${lower}(${charLength})` : lower;
  }

  // Types that use precision and scale
  if (['decimal', 'numeric'].includes(lower)) {
    if (precision !== null && scale !== null) {
      return `${lower}(${precision},${scale})`;
    }
    if (precision !== null) {
      return `${lower}(${precision})`;
    }
    return lower;
  }

  // Types that use only precision (e.g., float)
  if (lower === 'float' && precision !== null && precision !== 53) {
    return `${lower}(${precision})`;
  }

  // datetime2, datetimeoffset, time use scale
  if (['datetime2', 'datetimeoffset', 'time'].includes(lower)) {
    if (scale !== null && scale !== 7) {
      return `${lower}(${scale})`;
    }
    return lower;
  }

  // All other types (int, bigint, bit, date, datetime, etc.) have no qualifiers
  return lower;
}

/**
 * Encapsulates all SQL queries against system catalog views for the Object Explorer.
 * Returns typed results for each level of the server object hierarchy.
 */
export class MetadataQueryService {
  /**
   * Queries sys.databases and returns database info with system/state classification.
   */
  async getDatabases(pool: mssql.ConnectionPool): Promise<DatabaseInfo[]> {
    const request = pool.request();
    const result = await request.query(`
      SELECT name, state, database_id
      FROM sys.databases
      ORDER BY name
    `);

    return result.recordset.map((row: any) => ({
      name: row.name,
      isSystem: SYSTEM_DATABASES.includes(row.name.toLowerCase()),
      state: mapDatabaseState(row.state),
    }));
  }

  /**
   * Queries user tables in the specified database.
   */
  async getTables(pool: mssql.ConnectionPool, database: string): Promise<TableMetadata[]> {
    const request = pool.request();
    const safeName = this.bracketIdentifier(database);
    const result = await request.query(`
      USE ${safeName};
      SELECT s.name AS schema_name, t.name AS table_name
      FROM sys.tables t
      INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE t.is_external = 0 OR t.is_external IS NULL
      ORDER BY s.name, t.name
    `);

    return result.recordset.map((row: any) => ({
      schema: row.schema_name,
      name: row.table_name,
      isExternal: false,
    }));
  }

  /**
   * Queries external tables in the specified database.
   */
  async getExternalTables(pool: mssql.ConnectionPool, database: string): Promise<TableMetadata[]> {
    const request = pool.request();
    const safeName = this.bracketIdentifier(database);
    const result = await request.query(`
      USE ${safeName};
      SELECT s.name AS schema_name, t.name AS table_name
      FROM sys.external_tables t
      INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
      ORDER BY s.name, t.name
    `);

    return result.recordset.map((row: any) => ({
      schema: row.schema_name,
      name: row.table_name,
      isExternal: true,
    }));
  }

  /**
   * Queries user views (non-system schema) in the specified database.
   */
  async getViews(pool: mssql.ConnectionPool, database: string): Promise<ViewMetadata[]> {
    const request = pool.request();
    const safeName = this.bracketIdentifier(database);
    const result = await request.query(`
      USE ${safeName};
      SELECT s.name AS schema_name, v.name AS view_name
      FROM sys.views v
      INNER JOIN sys.schemas s ON v.schema_id = s.schema_id
      WHERE s.name NOT IN ('sys', 'INFORMATION_SCHEMA')
      ORDER BY s.name, v.name
    `);

    return result.recordset.map((row: any) => ({
      schema: row.schema_name,
      name: row.view_name,
      isSystem: false,
    }));
  }

  /**
   * Queries system views (sys schema) in the specified database.
   */
  async getSystemViews(pool: mssql.ConnectionPool, database: string): Promise<ViewMetadata[]> {
    const request = pool.request();
    const safeName = this.bracketIdentifier(database);
    const result = await request.query(`
      USE ${safeName};
      SELECT s.name AS schema_name, v.name AS view_name
      FROM sys.views v
      INNER JOIN sys.schemas s ON v.schema_id = s.schema_id
      WHERE s.name IN ('sys', 'INFORMATION_SCHEMA')
      ORDER BY s.name, v.name
    `);

    return result.recordset.map((row: any) => ({
      schema: row.schema_name,
      name: row.view_name,
      isSystem: true,
    }));
  }

  /**
   * Queries columns for a table or view with PK/FK detection.
   */
  async getColumns(
    pool: mssql.ConnectionPool,
    database: string,
    schema: string,
    objectName: string
  ): Promise<ColumnMetadata[]> {
    const request = pool.request();
    const safeName = this.bracketIdentifier(database);

    request.input('schemaName', mssql.NVarChar, schema);
    request.input('objectName', mssql.NVarChar, objectName);

    const result = await request.query(`
      USE ${safeName};

      SELECT
        c.name AS column_name,
        tp.name AS type_name,
        c.max_length,
        c.precision,
        c.scale,
        c.column_id,
        CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS is_primary_key,
        CASE WHEN fk.parent_column_id IS NOT NULL THEN 1 ELSE 0 END AS is_foreign_key
      FROM sys.columns c
      INNER JOIN sys.objects o ON c.object_id = o.object_id
      INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
      INNER JOIN sys.types tp ON c.user_type_id = tp.user_type_id
      LEFT JOIN (
        SELECT ic.object_id, ic.column_id
        FROM sys.index_columns ic
        INNER JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        WHERE i.is_primary_key = 1
      ) pk ON pk.object_id = o.object_id AND pk.column_id = c.column_id
      LEFT JOIN (
        SELECT DISTINCT parent_object_id, parent_column_id
        FROM sys.foreign_key_columns
      ) fk ON fk.parent_object_id = o.object_id AND fk.parent_column_id = c.column_id
      WHERE s.name = @schemaName AND o.name = @objectName
      ORDER BY c.column_id
    `);

    return result.recordset.map((row: any) => ({
      name: row.column_name,
      dataType: formatDataType(row.type_name, row.max_length, row.precision, row.scale),
      isPrimaryKey: row.is_primary_key === 1,
      isForeignKey: row.is_foreign_key === 1,
      ordinalPosition: row.column_id,
    }));
  }

  /**
   * Queries constraints for a table.
   */
  async getConstraints(
    pool: mssql.ConnectionPool,
    database: string,
    schema: string,
    tableName: string
  ): Promise<ConstraintMetadata[]> {
    const request = pool.request();
    const safeName = this.bracketIdentifier(database);

    request.input('schemaName', mssql.NVarChar, schema);
    request.input('tableName', mssql.NVarChar, tableName);

    const result = await request.query(`
      USE ${safeName};

      SELECT kc.name, kc.type_desc AS constraint_type
      FROM sys.key_constraints kc
      INNER JOIN sys.objects o ON kc.parent_object_id = o.object_id
      INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
      WHERE s.name = @schemaName AND o.name = @tableName

      UNION ALL

      SELECT fk.name, 'FOREIGN_KEY_CONSTRAINT' AS constraint_type
      FROM sys.foreign_keys fk
      INNER JOIN sys.objects o ON fk.parent_object_id = o.object_id
      INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
      WHERE s.name = @schemaName AND o.name = @tableName

      UNION ALL

      SELECT cc.name, 'CHECK_CONSTRAINT' AS constraint_type
      FROM sys.check_constraints cc
      INNER JOIN sys.objects o ON cc.parent_object_id = o.object_id
      INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
      WHERE s.name = @schemaName AND o.name = @tableName

      UNION ALL

      SELECT dc.name, 'DEFAULT_CONSTRAINT' AS constraint_type
      FROM sys.default_constraints dc
      INNER JOIN sys.objects o ON dc.parent_object_id = o.object_id
      INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
      WHERE s.name = @schemaName AND o.name = @tableName

      ORDER BY name
    `);

    return result.recordset.map((row: any) => ({
      name: row.name,
      type: this.mapConstraintType(row.constraint_type),
    }));
  }

  /**
   * Queries triggers for a table.
   */
  async getTriggers(
    pool: mssql.ConnectionPool,
    database: string,
    schema: string,
    tableName: string
  ): Promise<TriggerMetadata[]> {
    const request = pool.request();
    const safeName = this.bracketIdentifier(database);

    request.input('schemaName', mssql.NVarChar, schema);
    request.input('tableName', mssql.NVarChar, tableName);

    const result = await request.query(`
      USE ${safeName};

      SELECT
        tr.name,
        CASE WHEN tr.is_instead_of_trigger = 1 THEN 'INSTEAD OF' ELSE 'AFTER' END AS trigger_type,
        te.type_desc AS event_type
      FROM sys.triggers tr
      INNER JOIN sys.objects o ON tr.parent_id = o.object_id
      INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
      INNER JOIN sys.trigger_events te ON tr.object_id = te.object_id
      WHERE s.name = @schemaName AND o.name = @tableName
      ORDER BY tr.name, te.type_desc
    `);

    // Group events by trigger name
    const triggerMap = new Map<string, TriggerMetadata>();
    for (const row of result.recordset) {
      const existing = triggerMap.get(row.name);
      if (existing) {
        existing.events.push(row.event_type);
      } else {
        triggerMap.set(row.name, {
          name: row.name,
          type: row.trigger_type as 'AFTER' | 'INSTEAD OF',
          events: [row.event_type],
        });
      }
    }

    return Array.from(triggerMap.values());
  }

  /**
   * Queries indexes for a table.
   */
  async getIndexes(
    pool: mssql.ConnectionPool,
    database: string,
    schema: string,
    tableName: string
  ): Promise<IndexMetadata[]> {
    const request = pool.request();
    const safeName = this.bracketIdentifier(database);

    request.input('schemaName', mssql.NVarChar, schema);
    request.input('tableName', mssql.NVarChar, tableName);

    const result = await request.query(`
      USE ${safeName};

      SELECT
        i.name,
        i.type_desc AS index_type,
        i.is_unique,
        c.name AS column_name,
        ic.key_ordinal
      FROM sys.indexes i
      INNER JOIN sys.objects o ON i.object_id = o.object_id
      INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
      INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
      INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
      WHERE s.name = @schemaName AND o.name = @tableName
        AND i.name IS NOT NULL
        AND i.type > 0
      ORDER BY i.name, ic.key_ordinal
    `);

    // Group columns by index name
    const indexMap = new Map<string, IndexMetadata>();
    for (const row of result.recordset) {
      const existing = indexMap.get(row.name);
      if (existing) {
        existing.columns.push(row.column_name);
      } else {
        indexMap.set(row.name, {
          name: row.name,
          type: this.mapIndexType(row.index_type, row.is_unique),
          columns: [row.column_name],
        });
      }
    }

    return Array.from(indexMap.values());
  }

  /**
   * Queries statistics for a table.
   */
  async getStatistics(
    pool: mssql.ConnectionPool,
    database: string,
    schema: string,
    tableName: string
  ): Promise<StatisticMetadata[]> {
    const request = pool.request();
    const safeName = this.bracketIdentifier(database);

    request.input('schemaName', mssql.NVarChar, schema);
    request.input('tableName', mssql.NVarChar, tableName);

    const result = await request.query(`
      USE ${safeName};

      SELECT
        st.name,
        c.name AS column_name,
        sc.stats_column_id,
        STATS_DATE(st.object_id, st.stats_id) AS last_updated
      FROM sys.stats st
      INNER JOIN sys.objects o ON st.object_id = o.object_id
      INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
      INNER JOIN sys.stats_columns sc ON st.object_id = sc.object_id AND st.stats_id = sc.stats_id
      INNER JOIN sys.columns c ON sc.object_id = c.object_id AND sc.column_id = c.column_id
      WHERE s.name = @schemaName AND o.name = @tableName
      ORDER BY st.name, sc.stats_column_id
    `);

    // Group columns by statistic name
    const statsMap = new Map<string, StatisticMetadata>();
    for (const row of result.recordset) {
      const existing = statsMap.get(row.name);
      if (existing) {
        existing.columns.push(row.column_name);
      } else {
        statsMap.set(row.name, {
          name: row.name,
          columns: [row.column_name],
          lastUpdated: row.last_updated ? new Date(row.last_updated) : null,
        });
      }
    }

    return Array.from(statsMap.values());
  }

  /**
   * Escapes a database identifier using bracket notation to prevent SQL injection.
   * Brackets inside the name are doubled per SQL Server escaping rules.
   */
  private bracketIdentifier(name: string): string {
    return `[${name.replace(/\]/g, ']]')}]`;
  }

  /**
   * Maps constraint type_desc values to the ConstraintMetadata type union.
   */
  private mapConstraintType(typeDesc: string): ConstraintMetadata['type'] {
    switch (typeDesc) {
      case 'PRIMARY_KEY_CONSTRAINT':
        return 'PRIMARY KEY';
      case 'UNIQUE_CONSTRAINT':
        return 'UNIQUE';
      case 'FOREIGN_KEY_CONSTRAINT':
        return 'FOREIGN KEY';
      case 'CHECK_CONSTRAINT':
        return 'CHECK';
      case 'DEFAULT_CONSTRAINT':
        return 'DEFAULT';
      default:
        return 'CHECK'; // fallback
    }
  }

  /**
   * Maps index type_desc and is_unique to the IndexMetadata type union.
   */
  private mapIndexType(typeDesc: string, isUnique: boolean): IndexMetadata['type'] {
    const upper = typeDesc.toUpperCase();
    if (upper.includes('COLUMNSTORE')) {
      return 'COLUMNSTORE';
    }
    if (isUnique) {
      return 'UNIQUE';
    }
    if (upper === 'CLUSTERED') {
      return 'CLUSTERED';
    }
    return 'NONCLUSTERED';
  }
}
