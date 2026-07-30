import * as mssql from 'mssql';
import * as vscode from 'vscode';

// Connection configuration
export interface ConnectionConfig {
  name: string;           // required
  host: string;           // required
  port?: number;          // defaults to 1433
  database?: string;      // optional, defaults to "master"
  user?: string;          // optional (omit for Windows Auth)
  password?: string;      // optional
  encrypt?: 'Optional' | 'Mandatory' | 'Strict';  // optional, defaults to 'Optional' behavior
  trustServerCertificate?: boolean; // optional
  authType?: 'sql' | 'windows'; // optional, inferred from user field if absent
  /** Optional 6-digit hex color for connection identification, e.g. "#FF0000" */
  color?: string;
}

/**
 * Normalizes legacy boolean encrypt values and unknown strings to the
 * new string union type. Used during config file parsing.
 */
export function normalizeEncryptValue(
  value: boolean | string | undefined | null
): 'Optional' | 'Mandatory' | 'Strict' | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === true || value === 'Mandatory') return 'Mandatory';
  if (value === false || value === 'Optional') return 'Optional';
  if (value === 'Strict') return 'Strict';
  return undefined; // Unrecognized value → treated as unset (defaults to Optional behavior)
}

// Connection Manager
export interface IConnectionManager {
  loadConnections(): ConnectionConfig[];
  connect(config: ConnectionConfig): Promise<mssql.ConnectionPool>;
  disconnect(): Promise<void>;
  getActiveConnection(): mssql.ConnectionPool | null;
  getActiveConfig(): ConnectionConfig | null;
  switchConnection(name: string): Promise<void>;
  onConnectionChanged: vscode.Event<ConnectionConfig | null>;
}

// Schema Cache
export interface TableInfo {
  schema: string;
  name: string;
  columns: ColumnInfo[];
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  isNullable: boolean;
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

export interface ISchemaCache {
  tables: TableInfo[];
  views: ViewInfo[];
  procedures: ProcedureInfo[];
  refresh(pool: mssql.ConnectionPool): Promise<void>;
  isPopulating: boolean;
}


// Query Executor
export interface QueryResult {
  resultSets: ResultSet[];
  rowsAffected: number;
  executionTimeMs: number;
  error?: SqlError;
  cancelled?: boolean;
  cancelMessage?: string;
}

export interface ResultSet {
  columns: ColumnMetadata[];
  rows: any[][];
  rowCount: number;
  totalRowsAvailable?: number; // Total rows in full result set (for pagination)
}

export interface ColumnMetadata {
  name: string;
  dataType: string;
}

export interface SqlError {
  number: number;
  severity: number;
  message: string;
}

export interface IQueryExecutor {
  execute(sql: string, pool: mssql.ConnectionPool): Promise<QueryResult>;
  cancel(): void;
  isExecuting: boolean;
}

// Result Panel
export interface IResultPanel {
  show(result: QueryResult): void;
  showProgress(): void;
  showCancellation(): void;
  dispose(): void;
}

// Status Bar
export interface IStatusBar {
  update(config: ConnectionConfig | null): void;
  showWarning(message: string): void;
  dispose(): void;
}


// ─── Table Preview Types ────────────────────────────────────────────────────

export interface TablePreviewIdentifier {
  connectionName: string;
  database: string;
  schema: string;
  objectName: string;
}

export interface TablePreviewState {
  identifier: TablePreviewIdentifier;
  filterText: string;
  sortColumn: string | null;
  sortDirection: 'ASC' | 'DESC';
  rowLimit: number;
  lastResult: QueryResult | null;
  lastError: string | null;
}

export interface PreviewQueryParams {
  schema: string;
  objectName: string;
  rowLimit: number;
  filterText?: string;
  sortColumn?: string;
  sortDirection?: 'ASC' | 'DESC';
}

// ─── Error Handling Types ───────────────────────────────────────────────────

export type ErrorCategory = 'odbc-missing' | 'invalid-credentials' | 'unreachable' | 'timeout' | 'generic';

export interface CategorizedError {
  category: ErrorCategory;
  originalMessage: string;
  displayMessage: string;
  actions: ErrorAction[];
}

export interface ErrorAction {
  label: string;
  command: string;
  args?: any;
}

// ─── Execution State Types ──────────────────────────────────────────────────

export type ExecutionState = 'idle' | 'executing' | 'canceling';

export interface EditorExecutionEntry {
  state: ExecutionState;
  cancelFn: (() => void) | null;
  startTime: number | null;
}

// ─── Statement Parsing Types ────────────────────────────────────────────────

export interface StatementBoundary {
  startLine: number;      // 0-based inclusive
  endLine: number;        // 0-based inclusive
  text: string;           // The statement text
  batchIndex: number;     // 1-based batch number
  statementIndex: number; // 1-based within batch
}

// ─── Keyboard Shortcut Types ────────────────────────────────────────────────

export interface ShortcutEntry {
  label: string;
  keybinding: string;
  command: string;
  category: 'Query Execution' | 'Connection' | 'Navigation';
  isDefault: boolean;
}

// ─── Display Mode Types ─────────────────────────────────────────────────────

export interface BatchResultLabel {
  batchIndex: number;    // 1-based
  resultIndex: number;   // 1-based within batch
  label: string;         // "Batch N - Result M" or "Result M"
}
