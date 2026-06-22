/**
 * Schema Diff Engine
 *
 * Captures schema snapshots from SQL Server databases and compares them
 * to produce categorized structural differences. Uses SnapshotQueryService
 * for database queries and performs case-insensitive comparison of all
 * tables, columns, indexes, and constraints.
 */

import * as mssql from 'mssql';
import {
  SchemaSnapshot,
  TableSnapshot,
  ColumnSnapshot,
  IndexSnapshot,
  ConstraintSnapshot,
  SchemaDiff,
  TableDiff,
  ColumnDiff,
  IndexDiff,
  ConstraintDiff,
  DiffSummary,
} from './schemaDiffTypes';
import { SnapshotQueryService } from './snapshotQueryService';

/**
 * Engine for capturing database schema snapshots and comparing them to detect
 * structural differences. All name comparisons are case-insensitive.
 * Comparisons match tables by name only (ignoring schema qualifier) to support
 * cross-schema comparisons (e.g., dbo vs staging).
 */
export class SchemaDiffEngine {
  private queryService: SnapshotQueryService;

  constructor() {
    this.queryService = new SnapshotQueryService();
  }

  /**
   * Capture a schema snapshot for a specific schema within a database.
   * Queries INFORMATION_SCHEMA + sys catalog views via SnapshotQueryService,
   * filtered to tables in the specified schema only.
   *
   * @param pool - Connected mssql connection pool for the target database
   * @param database - Database name being captured
   * @param schemaName - Schema name to filter (e.g., "dbo", "staging")
   * @param connectionName - Display name for the connection
   * @returns Complete SchemaSnapshot with all tables in the specified schema
   */
  async captureSnapshot(
    pool: mssql.ConnectionPool,
    database: string,
    schemaName: string,
    connectionName: string
  ): Promise<SchemaSnapshot> {
    // Step 1: Query all user tables in the specified schema
    const tablePairs = await this.queryService.queryTables(pool, schemaName);

    // Step 2: Query all columns, indexes, and constraints in parallel (filtered to schema)
    const [columnsMap, indexesMap, constraintsMap] = await Promise.all([
      this.queryService.queryColumns(pool, schemaName),
      this.queryService.queryIndexes(pool, schemaName),
      this.queryService.queryConstraints(pool, schemaName),
    ]);

    // Step 3: Assemble TableSnapshot for each table
    const tables: TableSnapshot[] = tablePairs.map(({ schema, name }) => {
      const key = `${schema}.${name}`;
      return {
        schema,
        name,
        columns: columnsMap.get(key) ?? [],
        indexes: indexesMap.get(key) ?? [],
        constraints: constraintsMap.get(key) ?? [],
      };
    });

    // Step 4: Return the complete snapshot
    return {
      database,
      schemaName,
      connectionName,
      tables,
      capturedAt: new Date(),
    };
  }

  /**
   * Compare two schema snapshots and produce a categorized diff.
   * Tables are matched by name only (case-insensitive), regardless of the
   * schema names in each snapshot. This allows comparing e.g. "dbo" schema
   * in one database against "staging" schema in another.
   *
   * @param source - The source schema snapshot (desired state)
   * @param target - The target schema snapshot (current state to be transformed)
   * @returns SchemaDiff with categorized tables and summary counts
   */
  compareSnapshots(source: SchemaSnapshot, target: SchemaSnapshot): SchemaDiff {
    // Build lookup maps using table name only (case-insensitive)
    const sourceMap = new Map<string, TableSnapshot>();
    for (const table of source.tables) {
      sourceMap.set(table.name.toLowerCase(), table);
    }

    const targetMap = new Map<string, TableSnapshot>();
    for (const table of target.tables) {
      targetMap.set(table.name.toLowerCase(), table);
    }

    // Categorize tables
    const tablesOnlyInSource: TableSnapshot[] = [];
    const tablesOnlyInTarget: TableSnapshot[] = [];
    const modifiedTables: TableDiff[] = [];

    // Find tables only in source and tables in both
    for (const [key, sourceTable] of sourceMap.entries()) {
      if (!targetMap.has(key)) {
        tablesOnlyInSource.push(sourceTable);
      } else {
        const targetTable = targetMap.get(key)!;
        const tableDiff = this.compareTable(sourceTable, targetTable);
        if (tableDiff) {
          modifiedTables.push(tableDiff);
        }
      }
    }

    // Find tables only in target
    for (const [key, targetTable] of targetMap.entries()) {
      if (!sourceMap.has(key)) {
        tablesOnlyInTarget.push(targetTable);
      }
    }

    // Compute summary
    const totalDifferences =
      tablesOnlyInSource.length +
      tablesOnlyInTarget.length +
      modifiedTables.reduce(
        (sum, t) => sum + t.columnDiffs.length + t.indexDiffs.length + t.constraintDiffs.length,
        0
      );

    const summary: DiffSummary = {
      tablesToCreate: tablesOnlyInSource.length,
      tablesOnlyInTarget: tablesOnlyInTarget.length,
      tablesModified: modifiedTables.length,
      totalDifferences,
    };

    return {
      source: { database: source.database, schemaName: source.schemaName, connectionName: source.connectionName },
      target: { database: target.database, schemaName: target.schemaName, connectionName: target.connectionName },
      tablesOnlyInSource,
      tablesOnlyInTarget,
      modifiedTables,
      summary,
    };
  }

  /**
   * Compare two tables that exist in both source and target.
   * Returns a TableDiff if any differences are found, or null if identical.
   */
  private compareTable(sourceTable: TableSnapshot, targetTable: TableSnapshot): TableDiff | null {
    const columnDiffs = this.compareColumns(sourceTable.columns, targetTable.columns);
    const indexDiffs = this.compareIndexes(sourceTable.indexes, targetTable.indexes);
    const constraintDiffs = this.compareConstraints(sourceTable.constraints, targetTable.constraints);

    if (columnDiffs.length === 0 && indexDiffs.length === 0 && constraintDiffs.length === 0) {
      return null;
    }

    return {
      schema: sourceTable.schema,
      name: sourceTable.name,
      columnDiffs,
      indexDiffs,
      constraintDiffs,
    };
  }

  /**
   * Compare columns between source and target tables.
   * Uses case-insensitive name matching.
   */
  private compareColumns(sourceColumns: ColumnSnapshot[], targetColumns: ColumnSnapshot[]): ColumnDiff[] {
    const diffs: ColumnDiff[] = [];

    const sourceMap = new Map<string, ColumnSnapshot>();
    for (const col of sourceColumns) {
      sourceMap.set(col.name.toLowerCase(), col);
    }

    const targetMap = new Map<string, ColumnSnapshot>();
    for (const col of targetColumns) {
      targetMap.set(col.name.toLowerCase(), col);
    }

    // Columns in source but not in target → added (need to be created in target)
    for (const [key, sourceCol] of sourceMap.entries()) {
      if (!targetMap.has(key)) {
        diffs.push({
          type: 'added',
          columnName: sourceCol.name,
          source: sourceCol,
        });
      } else {
        // Column exists in both — check for modifications
        const targetCol = targetMap.get(key)!;
        if (this.isColumnModified(sourceCol, targetCol)) {
          diffs.push({
            type: 'modified',
            columnName: sourceCol.name,
            source: sourceCol,
            target: targetCol,
          });
        }
      }
    }

    // Columns in target but not in source → removed (exist in target but not source)
    for (const [key, targetCol] of targetMap.entries()) {
      if (!sourceMap.has(key)) {
        diffs.push({
          type: 'removed',
          columnName: targetCol.name,
          target: targetCol,
        });
      }
    }

    return diffs;
  }

  /**
   * Compare a single column's properties between source and target.
   * Compares dataType (case-insensitive), isNullable, defaultValue, and isIdentity.
   */
  private isColumnModified(source: ColumnSnapshot, target: ColumnSnapshot): boolean {
    if (source.dataType.toLowerCase() !== target.dataType.toLowerCase()) {
      return true;
    }
    if (source.isNullable !== target.isNullable) {
      return true;
    }
    if ((source.defaultValue ?? null) !== (target.defaultValue ?? null)) {
      return true;
    }
    if (source.isIdentity !== target.isIdentity) {
      return true;
    }
    return false;
  }

  /**
   * Compare indexes between source and target tables.
   * Uses case-insensitive name matching.
   */
  private compareIndexes(sourceIndexes: IndexSnapshot[], targetIndexes: IndexSnapshot[]): IndexDiff[] {
    const diffs: IndexDiff[] = [];

    const sourceMap = new Map<string, IndexSnapshot>();
    for (const idx of sourceIndexes) {
      sourceMap.set(idx.name.toLowerCase(), idx);
    }

    const targetMap = new Map<string, IndexSnapshot>();
    for (const idx of targetIndexes) {
      targetMap.set(idx.name.toLowerCase(), idx);
    }

    // Indexes in source but not in target → added
    for (const [key, sourceIdx] of sourceMap.entries()) {
      if (!targetMap.has(key)) {
        diffs.push({
          type: 'added',
          indexName: sourceIdx.name,
          source: sourceIdx,
        });
      } else {
        const targetIdx = targetMap.get(key)!;
        if (this.isIndexModified(sourceIdx, targetIdx)) {
          diffs.push({
            type: 'modified',
            indexName: sourceIdx.name,
            source: sourceIdx,
            target: targetIdx,
          });
        }
      }
    }

    // Indexes in target but not in source → removed
    for (const [key, targetIdx] of targetMap.entries()) {
      if (!sourceMap.has(key)) {
        diffs.push({
          type: 'removed',
          indexName: targetIdx.name,
          target: targetIdx,
        });
      }
    }

    return diffs;
  }

  /**
   * Compare a single index's properties between source and target.
   * Compares type, columns (order-sensitive, case-insensitive), includedColumns, and isUnique.
   */
  private isIndexModified(source: IndexSnapshot, target: IndexSnapshot): boolean {
    if (source.type !== target.type) {
      return true;
    }
    if (source.isUnique !== target.isUnique) {
      return true;
    }
    if (!this.arraysEqualCaseInsensitive(source.columns, target.columns)) {
      return true;
    }
    if (!this.arraysEqualCaseInsensitive(source.includedColumns, target.includedColumns)) {
      return true;
    }
    return false;
  }

  /**
   * Compare constraints between source and target tables.
   * Uses case-insensitive name matching.
   */
  private compareConstraints(
    sourceConstraints: ConstraintSnapshot[],
    targetConstraints: ConstraintSnapshot[]
  ): ConstraintDiff[] {
    const diffs: ConstraintDiff[] = [];

    const sourceMap = new Map<string, ConstraintSnapshot>();
    for (const con of sourceConstraints) {
      sourceMap.set(con.name.toLowerCase(), con);
    }

    const targetMap = new Map<string, ConstraintSnapshot>();
    for (const con of targetConstraints) {
      targetMap.set(con.name.toLowerCase(), con);
    }

    // Constraints in source but not in target → added
    for (const [key, sourceCon] of sourceMap.entries()) {
      if (!targetMap.has(key)) {
        diffs.push({
          type: 'added',
          constraintName: sourceCon.name,
          constraintType: sourceCon.type,
          source: sourceCon,
        });
      } else {
        const targetCon = targetMap.get(key)!;
        if (this.isConstraintModified(sourceCon, targetCon)) {
          diffs.push({
            type: 'modified',
            constraintName: sourceCon.name,
            constraintType: sourceCon.type,
            source: sourceCon,
            target: targetCon,
          });
        }
      }
    }

    // Constraints in target but not in source → removed
    for (const [key, targetCon] of targetMap.entries()) {
      if (!sourceMap.has(key)) {
        diffs.push({
          type: 'removed',
          constraintName: targetCon.name,
          constraintType: targetCon.type,
          target: targetCon,
        });
      }
    }

    return diffs;
  }

  /**
   * Compare a single constraint's properties between source and target.
   * Compares type, columns (order-sensitive, case-insensitive), and definition.
   */
  private isConstraintModified(source: ConstraintSnapshot, target: ConstraintSnapshot): boolean {
    if (source.type !== target.type) {
      return true;
    }
    if (!this.arraysEqualCaseInsensitive(source.columns, target.columns)) {
      return true;
    }
    if ((source.definition ?? null) !== (target.definition ?? null)) {
      return true;
    }
    return false;
  }

  /**
   * Compare two string arrays for equality (order-sensitive, case-insensitive).
   */
  private arraysEqualCaseInsensitive(a: string[], b: string[]): boolean {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i].toLowerCase() !== b[i].toLowerCase()) {
        return false;
      }
    }
    return true;
  }
}
