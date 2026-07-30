// Object Explorer Panel - Types and Interfaces

// ============================================================================
// TreeNode Discriminated Union
// ============================================================================

/**
 * All possible node kinds in the Object Explorer tree.
 */
export type TreeNodeKind =
  | 'server'
  | 'folder'
  | 'database'
  | 'table'
  | 'view'
  | 'column'
  | 'constraint'
  | 'trigger'
  | 'index'
  | 'statistic'
  | 'error'
  | 'loading'
  | 'connectionGroup';

/**
 * Base interface shared by all tree node types.
 */
export interface BaseTreeNode {
  kind: TreeNodeKind;
  label: string;
  connectionName: string;
}

/**
 * Represents a connected SQL Server instance at the top level of the tree.
 */
export interface ServerNode extends BaseTreeNode {
  kind: 'server';
  /** Optional connection color for visual identification in the tree */
  color?: string;
  /** Optional group name this connection belongs to */
  group?: string;
}

/**
 * Represents a connection group folder at the top level of the tree.
 */
export interface ConnectionGroupNode extends BaseTreeNode {
  kind: 'connectionGroup';
  /** The group color (6-digit hex, e.g. "#FF0000") */
  color: string;
  /** The group name */
  groupName: string;
}

/**
 * Represents a logical grouping folder (e.g., Databases, Tables, Columns).
 */
export interface FolderNode extends BaseTreeNode {
  kind: 'folder';
  folderType: FolderType;
  database?: string;
  schema?: string;
  objectName?: string;
}

/**
 * Represents an individual database in the tree.
 */
export interface DatabaseNode extends BaseTreeNode {
  kind: 'database';
  databaseName: string;
  isSystem: boolean;
  isOffline: boolean;
}

/**
 * Represents an individual table in the tree.
 */
export interface TableNode extends BaseTreeNode {
  kind: 'table';
  database: string;
  schema: string;
  tableName: string;
  isExternal: boolean;
}

/**
 * Represents an individual view in the tree.
 */
export interface ViewNode extends BaseTreeNode {
  kind: 'view';
  database: string;
  schema: string;
  viewName: string;
  isSystem: boolean;
}

/**
 * Represents an individual column leaf node in the tree.
 */
export interface ColumnNode extends BaseTreeNode {
  kind: 'column';
  database: string;
  columnName: string;
  dataType: string;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  /** The parent table or view name this column belongs to (for Find References) */
  parentObjectName?: string;
}

/**
 * Represents an individual trigger leaf node under a Triggers folder.
 */
export interface TriggerNode extends BaseTreeNode {
  kind: 'trigger';
  database: string;
  schema: string;
  tableName: string;
  triggerName: string;
}

/**
 * Represents an individual index leaf node under an Indexes folder.
 */
export interface IndexNode extends BaseTreeNode {
  kind: 'index';
  database: string;
  schema: string;
  tableName: string;
  indexName: string;
}

/**
 * Represents an individual statistic leaf node under a Statistics folder.
 */
export interface StatisticNode extends BaseTreeNode {
  kind: 'statistic';
  database: string;
  schema: string;
  tableName: string;
  statisticName: string;
}

/**
 * Represents an individual constraint leaf node under a Constraints folder.
 */
export interface ConstraintNode extends BaseTreeNode {
  kind: 'constraint';
  database: string;
  schema: string;
  tableName: string;
  constraintName: string;
  constraintType: 'PRIMARY KEY' | 'FOREIGN KEY' | 'UNIQUE' | 'CHECK' | 'DEFAULT';
}

/**
 * Represents an error state displayed inline in the tree.
 */
export interface ErrorNode extends BaseTreeNode {
  kind: 'error';
  message: string;
  retryAction?: () => Promise<void>;
}

/**
 * Discriminated union of all tree node types.
 */
export type TreeNode =
  | ServerNode
  | ConnectionGroupNode
  | FolderNode
  | DatabaseNode
  | TableNode
  | ViewNode
  | ColumnNode
  | ConstraintNode
  | TriggerNode
  | IndexNode
  | StatisticNode
  | ErrorNode;

// ============================================================================
// Node Identity (for cycle detection)
// ============================================================================

/**
 * Identifies a node in the Object Explorer tree by its structural position.
 * Used for ancestor-path cycle detection during tree expansion.
 */
export interface NodeIdentity {
  connectionName: string;
  database?: string;
  schema?: string;
  objectName?: string;
  folderType?: FolderType;
}

// ============================================================================
// FolderType
// ============================================================================

/**
 * All possible folder categories in the Object Explorer hierarchy.
 */
export type FolderType =
  | 'databases'
  | 'systemDatabases'
  | 'security'
  | 'serverObjects'
  | 'tables'
  | 'tablesUser'
  | 'tablesExternal'
  | 'views'
  | 'viewsUser'
  | 'viewsSystem'
  | 'synonyms'
  | 'programmability'
  | 'externalResources'
  | 'serviceBroker'
  | 'storage'
  | 'dbSecurity'
  | 'columns'
  | 'constraints'
  | 'triggers'
  | 'indexes'
  | 'statistics';

// ============================================================================
// Connection Configuration
// ============================================================================

/**
 * Server connection configuration supporting optional database.
 * Extended from the existing ConnectionConfig to allow server-level connections.
 */
export interface ServerConnectionConfig {
  name: string;                    // Display name (unique, max 128 chars)
  host: string;                    // Server hostname (max 255 chars)
  port?: number;                   // Port (1-65535, defaults to 1433)
  database?: string;               // Optional — omit to connect at server level
  authType: 'sql' | 'windows';
  user?: string;                   // Required for SQL auth
  password?: string;               // Required for SQL auth (NOT persisted)
  encrypt?: 'Optional' | 'Mandatory' | 'Strict';
  trustServerCertificate?: boolean;
  /** Optional 6-digit hex color for connection identification, e.g. "#FF0000" */
  color?: string;
  /** Optional group name this connection belongs to */
  group?: string;
}

/**
 * A named connection group with a color for visual organization.
 * Groups appear as top-level folders in the Object Explorer tree.
 */
export interface ConnectionGroup {
  name: string;           // Unique group name (e.g., "Prod", "Dev", "Staging")
  color: string;          // 6-digit hex color, e.g. "#FF0000"
}

/**
 * Raw input from the connection form before validation.
 */
export interface ConnectionFormInput {
  authType: 'sql' | 'windows';
  serverName: string;
  displayName: string;
  port?: string;
  encrypt: 'Optional' | 'Mandatory' | 'Strict';
  trustServerCertificate: boolean;
  username?: string;
  password?: string;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Result of validating a connection form input.
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * A single validation error identifying the problematic field.
 */
export interface ValidationError {
  field: string;
  message: string;
}

// ============================================================================
// Metadata Query Results
// ============================================================================

/**
 * Information about a database on the server.
 */
export interface DatabaseInfo {
  name: string;
  isSystem: boolean;
  state: 'online' | 'offline' | 'restoring' | 'recovering' | 'suspect';
}

/**
 * Metadata for a table (user or external).
 */
export interface TableMetadata {
  schema: string;
  name: string;
  isExternal: boolean;
}

/**
 * Metadata for a view (user or system).
 */
export interface ViewMetadata {
  schema: string;
  name: string;
  isSystem: boolean;
}

/**
 * Metadata for a column within a table or view.
 */
export interface ColumnMetadata {
  name: string;
  dataType: string;         // Includes qualifiers: "nvarchar(100)", "decimal(18,2)"
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  ordinalPosition: number;
}

/**
 * Metadata for a constraint on a table.
 */
export interface ConstraintMetadata {
  name: string;
  type: 'PRIMARY KEY' | 'FOREIGN KEY' | 'UNIQUE' | 'CHECK' | 'DEFAULT';
}

/**
 * Metadata for a trigger on a table or view.
 */
export interface TriggerMetadata {
  name: string;
  type: 'AFTER' | 'INSTEAD OF';
  events: string[];         // e.g., ['INSERT', 'UPDATE']
}

/**
 * Metadata for an index on a table or view.
 */
export interface IndexMetadata {
  name: string;
  type: 'CLUSTERED' | 'NONCLUSTERED' | 'UNIQUE' | 'COLUMNSTORE';
  columns: string[];
}

/**
 * Metadata for a statistic on a table.
 */
export interface StatisticMetadata {
  name: string;
  columns: string[];
  lastUpdated: Date | null;
}
