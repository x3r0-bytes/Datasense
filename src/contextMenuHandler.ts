// Context Menu Handler — Encapsulates context menu command logic for the Object Explorer tree.

import * as vscode from 'vscode';
import {
  TreeNode,
  ServerNode,
  DatabaseNode,
  TableNode,
  ViewNode,
} from './objectExplorer/types';
import { ObjectExplorerProvider } from './objectExplorer/objectExplorerProvider';
import { ObjectExplorerConnectionManager } from './objectExplorer/objectExplorerConnectionManager';
import { QueryExecutor } from './queryExecutor';
import { ConnectionFormPanel } from './connectionFormPanel';
import { ConnectionManager } from './connectionManager';
import { SchemaDiagramPanel, queryForeignKeyRelationships, queryTableColumns } from './schemaDiagramPanel';

// ============================================================================
// Pure Helper Functions (exported for property testing)
// ============================================================================

/**
 * Formats a qualified SQL object name in the format [schema].[objectName].
 * Both parts are wrapped in square brackets.
 */
export function formatQualifiedName(schema: string, objectName: string): string {
  return `[${schema}].[${objectName}]`;
}

/**
 * Generates a SELECT TOP 100 SQL statement for the given schema and object name.
 */
export function generateSelectTop100(schema: string, objectName: string): string {
  return `SELECT TOP 100 * FROM ${formatQualifiedName(schema, objectName)}`;
}

/**
 * Returns the text to copy for a given tree node.
 * - Tables/Views: [schema].[objectName]
 * - Columns: column name only
 * - Other nodes: node label text
 */
export function getCopyText(node: TreeNode): string {
  switch (node.kind) {
    case 'table':
      return formatQualifiedName(node.schema, node.tableName);
    case 'view':
      return formatQualifiedName(node.schema, node.viewName);
    case 'column':
      return node.columnName;
    default:
      return node.label;
  }
}

// ============================================================================
// IContextMenuHandler Interface
// ============================================================================

export interface IContextMenuHandler {
  selectTop100(node: TableNode | ViewNode): Promise<void>;
  copyObjectName(node: TreeNode): Promise<void>;
  newQuery(node: ServerNode | DatabaseNode | TableNode | ViewNode): Promise<void>;
  refreshNode(node: ServerNode | DatabaseNode | TableNode | ViewNode): Promise<void>;
  deleteConnection(node: ServerNode): Promise<void>;
}

// ============================================================================
// ContextMenuHandler Implementation
// ============================================================================

export class ContextMenuHandler implements IContextMenuHandler {
  private connectionFormPanel: ConnectionFormPanel | undefined;
  private _schemaDiagramPanel: SchemaDiagramPanel | undefined;

  constructor(
    private readonly objectExplorerProvider: ObjectExplorerProvider,
    private readonly connectionManager: ObjectExplorerConnectionManager,
    private readonly queryExecutor: QueryExecutor,
    private readonly queryConnectionManager?: ConnectionManager
  ) {}

  /**
   * Sets the ConnectionFormPanel reference used by duplicateConnection.
   * Called from extension.ts after both the handler and form panel are instantiated.
   */
  setConnectionFormPanel(panel: ConnectionFormPanel): void {
    this.connectionFormPanel = panel;
  }

  /**
   * Sets the SchemaDiagramPanel reference used by showSchemaDiagram and showTableDiagram.
   * Called from extension.ts after SchemaDiagramPanel is instantiated.
   */
  setSchemaDiagramPanel(panel: SchemaDiagramPanel): void {
    this._schemaDiagramPanel = panel;
  }

  /**
   * Opens a new .sql editor with SELECT TOP 100 * FROM [schema].[objectName],
   * associates it with the node's connection, and executes the query.
   */
  async selectTop100(node: TableNode | ViewNode): Promise<void> {
    try {
      const schema = node.schema;
      const objectName = node.kind === 'table' ? node.tableName : node.viewName;

      // Fallback to label if schema is missing
      if (!schema || !objectName) {
        vscode.window.showErrorMessage('Cannot generate SELECT statement: missing schema or object name.');
        return;
      }

      const sql = generateSelectTop100(schema, objectName);

      // Open a new untitled .sql document with the generated SQL
      const doc = await vscode.workspace.openTextDocument({
        language: 'sql',
        content: sql,
      });
      const editor = await vscode.window.showTextDocument(doc);

      // Get the connection pool for this node's database
      const pool = await this.connectionManager.getPoolForDatabase(
        node.connectionName,
        node.database
      );

      // Execute the query
      const result = await this.queryExecutor.execute(sql, pool);

      // Fire the result display via the run query result mechanism
      // The result will be shown by the ResultPanelProvider (wired in extension.ts)
      await vscode.commands.executeCommand('sqlServer.showResults', result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`SELECT TOP 100 failed: ${message}`);
    }
  }

  /**
   * Copies the appropriate name to the clipboard based on node type.
   * - Tables/Views: [schema].[objectName]
   * - Columns: column name
   * - Other nodes: node label
   */
  async copyObjectName(node: TreeNode): Promise<void> {
    try {
      const text = getCopyText(node);
      await vscode.env.clipboard.writeText(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Copy Object Name failed: ${message}`);
    }
  }

  /**
   * Opens a blank .sql file associated with the node's server/database connection.
   * For server nodes, defaults to the 'master' database.
   */
  async newQuery(node: ServerNode | DatabaseNode | TableNode | ViewNode): Promise<void> {
    try {
      // Determine the database to associate with the new query
      let database: string;
      switch (node.kind) {
        case 'server':
          database = 'master';
          break;
        case 'database':
          database = node.databaseName;
          break;
        case 'table':
        case 'view':
          database = node.database;
          break;
        default:
          database = 'master';
      }

      // Open a new untitled .sql document
      const doc = await vscode.workspace.openTextDocument({
        language: 'sql',
        content: '',
      });
      await vscode.window.showTextDocument(doc);

      // Associate the connection with this editor by connecting to the appropriate database
      // This ensures the query executor uses the correct connection when running queries
      await this.connectionManager.getPoolForDatabase(node.connectionName, database);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`New Query failed: ${message}`);
    }
  }

  /**
   * Refreshes a specific tree node and reloads its children from the server.
   */
  async refreshNode(node: ServerNode | DatabaseNode | TableNode | ViewNode): Promise<void> {
    try {
      this.objectExplorerProvider.refreshNode(node);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Refresh failed: ${message}`);
    }
  }

  /**
   * Deletes a connection after user confirmation.
   * Removes from persistence, closes pools, disconnects active query connection if affected,
   * and refreshes the Object Explorer tree.
   */
  async deleteConnection(node: ServerNode): Promise<void> {
    try {
      const name = node.connectionName;

      // Show confirmation dialog
      const answer = await vscode.window.showWarningMessage(
        `Are you sure you want to delete connection '${name}'?`,
        { modal: false },
        'Yes',
        'No'
      );

      if (answer !== 'Yes') {
        return;
      }

      // Remove connection from Object Explorer (file + pools)
      await this.connectionManager.removeConnection(name);

      // If the deleted connection is the active query connection, disconnect it
      if (this.queryConnectionManager) {
        const activeConfig = this.queryConnectionManager.getActiveConfig();
        if (activeConfig?.name === name) {
          await this.queryConnectionManager.disconnect();
          this.queryConnectionManager.fireConnectionChanged();
        }
      }

      // Refresh Object Explorer tree
      this.objectExplorerProvider.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Delete connection failed: ${message}`);
    }
  }

  /**
   * Shows a full database schema diagram for all user tables in the given database node.
   * Queries all tables and their FK relationships, then calls showDatabaseDiagram().
   * Requirements: 3.1, 3.3, 3.5, 3.6, 3.7
   */
  async showSchemaDiagram(node: DatabaseNode): Promise<void> {
    if (!this._schemaDiagramPanel) {
      vscode.window.showErrorMessage('Schema Diagram panel is not initialized.');
      return;
    }

    const database = node.databaseName;
    const connectionName = node.connectionName;

    const pool = await this.connectionManager.getPoolForDatabase(connectionName, database);
    if (!pool) {
      vscode.window.showErrorMessage(`Cannot connect to database "${database}" on "${connectionName}".`);
      return;
    }

    try {
      // Query all user tables in the database
      const safeName = `[${database.replace(/\]/g, ']]')}]`;
      const request = pool.request();
      const tablesResult = await request.query(`
        USE ${safeName};
        SELECT s.name AS schema_name, t.name AS table_name
        FROM sys.tables t
        INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
        WHERE s.name NOT IN ('sys', 'INFORMATION_SCHEMA')
        ORDER BY s.name, t.name
      `);

      const tablesToDiagram: Array<{ schema: string; name: string }> = tablesResult.recordset.map((row: any) => ({
        schema: row.schema_name,
        name: row.table_name,
      }));

      if (tablesToDiagram.length === 0) {
        vscode.window.showInformationMessage(`No user tables found in database "${database}".`);
        return;
      }

      // Show progress indicator for databases with many tables (Requirement 3.6)
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Loading schema diagram for "${database}"...`,
          cancellable: false,
        },
        async () => {
          // Query columns and relationships for all tables
          const [diagramTables, relationships] = await Promise.all([
            queryTableColumns(pool, database, tablesToDiagram),
            queryForeignKeyRelationships(pool, database, tablesToDiagram),
          ]);

          this._schemaDiagramPanel!.showDatabaseDiagram({ tables: diagramTables, relationships }, database);
        }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Display error state in the panel (Requirement 3.7)
      this._schemaDiagramPanel.showDatabaseDiagram({ tables: [], relationships: [] }, database);
      vscode.window.showErrorMessage(`Schema diagram failed: ${message}`);
    }
  }

  /**
   * Shows a table-level diagram for the selected table and its directly FK-connected neighbors.
   * For tables with no FK relationships, renders the table alone with a message (Requirement 3.8).
   * Requirements: 3.2, 3.4, 3.5, 3.8
   */
  async showTableDiagram(node: TableNode): Promise<void> {
    if (!this._schemaDiagramPanel) {
      vscode.window.showErrorMessage('Schema Diagram panel is not initialized.');
      return;
    }

    const database = node.database;
    const connectionName = node.connectionName;
    const selectedTable = { schema: node.schema, name: node.tableName };

    const pool = await this.connectionManager.getPoolForDatabase(connectionName, database);
    if (!pool) {
      vscode.window.showErrorMessage(`Cannot connect to database "${database}" on "${connectionName}".`);
      return;
    }

    try {
      // Query FK relationships for the selected table to discover neighbors
      const initialRelationships = await queryForeignKeyRelationships(pool, database, [selectedTable]);

      // Collect the selected table and all directly FK-connected tables (Requirement 3.4)
      const tableSet = new Map<string, { schema: string; name: string }>();
      tableSet.set(`${selectedTable.schema}.${selectedTable.name}`, selectedTable);

      for (const rel of initialRelationships) {
        const fromKey = `${rel.fromSchema}.${rel.fromTable}`;
        const toKey = `${rel.toSchema}.${rel.toTable}`;
        if (!tableSet.has(fromKey)) {
          tableSet.set(fromKey, { schema: rel.fromSchema, name: rel.fromTable });
        }
        if (!tableSet.has(toKey)) {
          tableSet.set(toKey, { schema: rel.toSchema, name: rel.toTable });
        }
      }

      const tablesToDiagram = Array.from(tableSet.values());

      // Query columns and relationships for the neighborhood
      const [diagramTables, relationships] = await Promise.all([
        queryTableColumns(pool, database, tablesToDiagram),
        queryForeignKeyRelationships(pool, database, tablesToDiagram),
      ]);

      this._schemaDiagramPanel.showTableDiagram(
        { tables: diagramTables, relationships },
        node.schema,
        node.tableName
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Display error state in the panel (Requirement 3.7)
      this._schemaDiagramPanel.showTableDiagram({ tables: [], relationships: [] }, node.schema, node.tableName);
      vscode.window.showErrorMessage(`Table diagram failed: ${message}`);
    }
  }

  /**
   * Shows a schema-scoped diagram for the selected table.
   * Queries all tables in the same schema as the selected table and shows
   * the diagram with their FK relationships. This provides a focused view
   * compared to the full database diagram.
   */
  async showSchemaScopedDiagram(node: TableNode): Promise<void> {
    if (!this._schemaDiagramPanel) {
      vscode.window.showErrorMessage('Schema Diagram panel is not initialized.');
      return;
    }

    const database = node.database;
    const connectionName = node.connectionName;
    const schemaName = node.schema;

    const pool = await this.connectionManager.getPoolForDatabase(connectionName, database);
    if (!pool) {
      vscode.window.showErrorMessage(`Cannot connect to database "${database}" on "${connectionName}".`);
      return;
    }

    try {
      // Query all user tables in the same schema
      const safeName = `[${database.replace(/\]/g, ']]')}]`;
      const request = pool.request();
      request.input('schemaName', schemaName);
      const tablesResult = await request.query(`
        USE ${safeName};
        SELECT s.name AS schema_name, t.name AS table_name
        FROM sys.tables t
        INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
        WHERE s.name = @schemaName
        ORDER BY t.name
      `);

      const tablesToDiagram: Array<{ schema: string; name: string }> = tablesResult.recordset.map((row: any) => ({
        schema: row.schema_name,
        name: row.table_name,
      }));

      if (tablesToDiagram.length === 0) {
        vscode.window.showInformationMessage(`No tables found in schema "${schemaName}".`);
        return;
      }

      // Show progress indicator
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Loading schema diagram for "${schemaName}"...`,
          cancellable: false,
        },
        async () => {
          // Query columns and relationships for the schema tables
          const [diagramTables, relationships] = await Promise.all([
            queryTableColumns(pool, database, tablesToDiagram),
            queryForeignKeyRelationships(pool, database, tablesToDiagram),
          ]);

          this._schemaDiagramPanel!.showDatabaseDiagram(
            { tables: diagramTables, relationships },
            `${database} — ${schemaName}`
          );
        }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._schemaDiagramPanel.showDatabaseDiagram({ tables: [], relationships: [] }, `${database} — ${schemaName}`);
      vscode.window.showErrorMessage(`Schema diagram failed: ${message}`);
    }
  }

  /**
   * Duplicates a connection by opening the Connection Form in Add mode
   * with all fields pre-populated from the selected connection.
   * The Connection Name is set to "{name} (Copy)".
   */
  async duplicateConnection(node: ServerNode): Promise<void> {
    try {
      const config = this.connectionManager.getConfigByName(node.connectionName);
      if (!config) {
        vscode.window.showErrorMessage(`Connection '${node.connectionName}' not found.`);
        return;
      }

      if (!this.connectionFormPanel) {
        vscode.window.showErrorMessage('Connection form panel is not available.');
        return;
      }

      // Open the form in Add mode with prefill data (duplicate)
      this.connectionFormPanel.open(undefined, config);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Duplicate connection failed: ${message}`);
    }
  }
}
