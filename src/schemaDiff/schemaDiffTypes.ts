/**
 * Schema Diff Type Definitions
 *
 * Interfaces for schema snapshot capture, difference detection, and comparison results.
 * Used by the Schema Diff Engine, Diff Panel, and ALTER Script Generator.
 */

// ─── Snapshot Types ─────────────────────────────────────────────────────────────

/**
 * A complete structural snapshot of a schema within a database at a point in time.
 * Captured from INFORMATION_SCHEMA views and sys catalog views, filtered to a specific schema.
 */
export interface SchemaSnapshot {
  database: string;
  schemaName: string;
  connectionName: string;
  tables: TableSnapshot[];
  capturedAt: Date;
}

/**
 * Full structural definition of a single table, including columns, indexes, and constraints.
 */
export interface TableSnapshot {
  schema: string;
  name: string;
  columns: ColumnSnapshot[];
  indexes: IndexSnapshot[];
  constraints: ConstraintSnapshot[];
}

/**
 * Extended column information beyond basic name/type — includes identity, defaults, and nullability.
 */
export interface ColumnSnapshot {
  name: string;
  dataType: string;             // e.g., "nvarchar(100)", "int", "decimal(18,2)"
  isNullable: boolean;
  defaultValue: string | null;  // e.g., "((0))", "(getdate())"
  isIdentity: boolean;
  identitySeed?: number;
  identityIncrement?: number;
}

/**
 * Full index definition including type, key columns, included columns, and uniqueness.
 */
export interface IndexSnapshot {
  name: string;
  type: 'CLUSTERED' | 'NONCLUSTERED' | 'UNIQUE CLUSTERED' | 'UNIQUE NONCLUSTERED';
  columns: string[];            // key columns in order
  includedColumns: string[];    // INCLUDE columns
  isUnique: boolean;
}

/**
 * Full constraint definition — covers PRIMARY KEY, FOREIGN KEY, UNIQUE, CHECK, and DEFAULT.
 */
export interface ConstraintSnapshot {
  name: string;
  type: 'PRIMARY KEY' | 'FOREIGN KEY' | 'UNIQUE' | 'CHECK' | 'DEFAULT';
  columns: string[];
  definition?: string;          // CHECK expression or FK referenced table
}

// ─── Diff Result Types ──────────────────────────────────────────────────────────

/**
 * The complete result of comparing two schema snapshots.
 * Categorizes tables into: only in source, only in target, or modified (present in both with differences).
 */
export interface SchemaDiff {
  source: { database: string; schemaName: string; connectionName: string };
  target: { database: string; schemaName: string; connectionName: string };
  tablesOnlyInSource: TableSnapshot[];
  tablesOnlyInTarget: TableSnapshot[];
  modifiedTables: TableDiff[];
  summary: DiffSummary;
}

/**
 * Per-table differences when a table exists in both source and target schemas.
 */
export interface TableDiff {
  schema: string;
  name: string;
  columnDiffs: ColumnDiff[];
  indexDiffs: IndexDiff[];
  constraintDiffs: ConstraintDiff[];
}

/**
 * A single column difference: added (in source, not target), removed (in target, not source),
 * or modified (present in both but with differing properties).
 */
export interface ColumnDiff {
  type: 'added' | 'removed' | 'modified';
  columnName: string;
  source?: ColumnSnapshot;      // present for 'removed' and 'modified'
  target?: ColumnSnapshot;      // present for 'added' and 'modified'
}

/**
 * A single index difference: added, removed, or modified.
 */
export interface IndexDiff {
  type: 'added' | 'removed' | 'modified';
  indexName: string;
  source?: IndexSnapshot;
  target?: IndexSnapshot;
}

/**
 * A single constraint difference: added, removed, or modified.
 */
export interface ConstraintDiff {
  type: 'added' | 'removed' | 'modified';
  constraintName: string;
  constraintType: ConstraintSnapshot['type'];
  source?: ConstraintSnapshot;
  target?: ConstraintSnapshot;
}

/**
 * High-level summary counts for the diff result, displayed in the Diff Panel header.
 */
export interface DiffSummary {
  tablesToCreate: number;
  tablesOnlyInTarget: number;
  tablesModified: number;
  totalDifferences: number;
}
