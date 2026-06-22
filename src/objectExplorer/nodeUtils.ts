// Object Explorer Panel - Node Utility Functions

import { ServerConnectionConfig, TreeNode, DatabaseInfo, NodeIdentity } from './types';

/**
 * Returns the effective database for a connection config.
 * Defaults to "master" when database is undefined, null, or empty string.
 */
export function getEffectiveDatabase(config: ServerConnectionConfig): string {
  if (!config.database || config.database.trim() === '') {
    return 'master';
  }
  return config.database;
}

/**
 * Formats a table or view label using schema-qualified name.
 * Returns "schema.name" format.
 */
export function formatTableLabel(schema: string, name: string): string {
  return `${schema}.${name}`;
}

/**
 * Formats a column label with its data type.
 * Returns "name (dataType)" format.
 */
export function formatColumnLabel(name: string, dataType: string): string {
  return `${name} (${dataType})`;
}

/**
 * Determines the appropriate icon for a column based on key status.
 * Precedence: PK > FK > default.
 * Returns 'pk' for primary key, 'fk' for foreign key, 'column' for default.
 */
export function getColumnIcon(isPrimaryKey: boolean, isForeignKey: boolean): string {
  if (isPrimaryKey) {
    return 'pk';
  }
  if (isForeignKey) {
    return 'fk';
  }
  return 'column';
}

/**
 * Sorts tree nodes in case-insensitive alphabetical order by label.
 * Uses localeCompare with sensitivity: 'base' for locale-aware comparison.
 */
export function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
  );
}

/**
 * Categorizes databases into user and system groups based on the isSystem flag.
 */
export function categorizeDatabases(databases: DatabaseInfo[]): { user: DatabaseInfo[]; system: DatabaseInfo[] } {
  const user: DatabaseInfo[] = [];
  const system: DatabaseInfo[] = [];

  for (const db of databases) {
    if (db.isSystem) {
      system.push(db);
    } else {
      user.push(db);
    }
  }

  return { user, system };
}


/**
 * Compares two NodeIdentity objects for structural equality.
 * Two identities are equal if all their defined fields match.
 * Undefined fields on both sides are treated as equal.
 */
export function identityEquals(a: NodeIdentity, b: NodeIdentity): boolean {
  return (
    a.connectionName === b.connectionName &&
    a.database === b.database &&
    a.schema === b.schema &&
    a.objectName === b.objectName &&
    a.folderType === b.folderType
  );
}

/**
 * Extracts a NodeIdentity from a TreeNode for use in cycle detection.
 * Maps each node kind to its relevant identity fields.
 */
export function getNodeIdentity(node: TreeNode): NodeIdentity {
  switch (node.kind) {
    case 'server':
      return { connectionName: node.connectionName };
    case 'connectionGroup':
      return { connectionName: node.connectionName };
    case 'database':
      return { connectionName: node.connectionName, database: node.databaseName };
    case 'folder':
      return {
        connectionName: node.connectionName,
        database: node.database,
        schema: node.schema,
        objectName: node.objectName,
        folderType: node.folderType,
      };
    case 'table':
      return {
        connectionName: node.connectionName,
        database: node.database,
        schema: node.schema,
        objectName: node.tableName,
      };
    case 'view':
      return {
        connectionName: node.connectionName,
        database: node.database,
        schema: node.schema,
        objectName: node.viewName,
      };
    case 'column':
      return {
        connectionName: node.connectionName,
        database: node.database,
        objectName: node.columnName,
      };
    case 'constraint':
      return {
        connectionName: node.connectionName,
        database: node.database,
        schema: node.schema,
        objectName: node.constraintName,
      };
    case 'trigger':
      return {
        connectionName: node.connectionName,
        database: node.database,
        schema: node.schema,
        objectName: node.triggerName,
      };
    case 'index':
      return {
        connectionName: node.connectionName,
        database: node.database,
        schema: node.schema,
        objectName: node.indexName,
      };
    case 'statistic':
      return {
        connectionName: node.connectionName,
        database: node.database,
        schema: node.schema,
        objectName: node.statisticName,
      };
    case 'error':
      return { connectionName: node.connectionName };
  }
}
