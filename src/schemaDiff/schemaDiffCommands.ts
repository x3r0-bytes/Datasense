/**
 * Schema Diff Commands
 *
 * Registers and implements the `sqlServer.schemaDiff` (command palette) and
 * `sqlServer.schemaDiffFromNode` (table node context menu) commands.
 *
 * Flow:
 * 1. Multi-step quick pick: source connection+database+schema → target connection+database+schema
 * 2. Validation: same source/target warning
 * 3. Snapshot capture with progress notification (schema-scoped)
 * 4. Comparison and DiffPanel display
 *
 * Requirements: 5.1, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10
 */

import * as vscode from 'vscode';
import * as mssql from 'mssql';
import { ObjectExplorerConnectionManager } from '../objectExplorer/objectExplorerConnectionManager';
import { SchemaDiffEngine } from './schemaDiffEngine';
import { SchemaDiff } from './schemaDiffTypes';
import { DiffPanel } from './diffPanel';

/** System databases excluded from the database list */
const SYSTEM_DATABASES = ['master', 'model', 'msdb', 'tempdb'];

/** System/internal schemas excluded from the schema list */
const EXCLUDED_SCHEMAS = ['sys', 'INFORMATION_SCHEMA', 'guest'];

/** Timeout for snapshot queries (60 seconds) */
const SNAPSHOT_TIMEOUT_MS = 60000;

/**
 * Represents a selected schema for schema diff comparison.
 */
export interface SchemaDiffSelection {
  connectionName: string;
  database: string;
  schemaName: string;
}

/**
 * Holds the most recent schema diff result for later consumption by the DiffPanel.
 */
let lastDiffResult: SchemaDiff | undefined;

/**
 * DiffPanel instance for displaying schema comparison results.
 */
let diffPanel: DiffPanel | undefined;

/**
 * Returns the most recent schema diff result (used by DiffPanel).
 */
export function getLastDiffResult(): SchemaDiff | undefined {
  return lastDiffResult;
}

/**
 * Registers the schema diff commands and returns disposables.
 */
export function registerSchemaDiffCommands(
  connectionManager: ObjectExplorerConnectionManager
): vscode.Disposable[] {
  const engine = new SchemaDiffEngine();

  // Command palette: prompt for both source and target (connection + database + schema)
  const schemaDiffCmd = vscode.commands.registerCommand('sqlServer.schemaDiff', async () => {
    // Step 1: Select source connection + database + schema
    const source = await pickConnectionDatabaseAndSchema(connectionManager, 'Select Source');
    if (!source) {
      return; // User dismissed — cancel silently (Requirement 5.7)
    }

    // Step 2: Select target connection + database + schema
    const target = await pickConnectionDatabaseAndSchema(connectionManager, 'Select Target');
    if (!target) {
      return; // User dismissed — cancel silently (Requirement 5.7)
    }

    // Execute comparison
    await executeSchemaDiff(connectionManager, engine, source, target);
  });

  // Context menu on table node: pre-selects source from the table's schema
  const schemaDiffFromNodeCmd = vscode.commands.registerCommand('sqlServer.schemaDiffFromNode', async (node?: any) => {
    if (!node || node.kind !== 'table') {
      vscode.window.showWarningMessage('Right-click a table in the Object Explorer to compare schemas.');
      return;
    }

    // Pre-select source from the clicked table node's schema (Requirement 5.5)
    const source: SchemaDiffSelection = {
      connectionName: node.connectionName,
      database: node.database,
      schemaName: node.schema,
    };

    // Prompt only for target connection + database + schema
    const target = await pickConnectionDatabaseAndSchema(connectionManager, 'Select Target');
    if (!target) {
      return; // User dismissed — cancel silently (Requirement 5.7)
    }

    // Execute comparison
    await executeSchemaDiff(connectionManager, engine, source, target);
  });

  return [schemaDiffCmd, schemaDiffFromNodeCmd];
}

/**
 * Multi-step quick pick flow: pick connection → pick database → pick schema.
 * Returns the selection or undefined if the user dismissed at any step.
 */
async function pickConnectionDatabaseAndSchema(
  connectionManager: ObjectExplorerConnectionManager,
  title: string
): Promise<SchemaDiffSelection | undefined> {
  // Get all registered connections
  const connections = connectionManager.getConnections();
  if (connections.length === 0) {
    vscode.window.showWarningMessage('No connections registered in Object Explorer. Add a connection first.');
    return undefined;
  }

  // Step 1: Pick connection
  const connectionItems: vscode.QuickPickItem[] = connections.map(c => ({
    label: c.name,
    description: c.host + (c.port && c.port !== 1433 ? `:${c.port}` : ''),
  }));

  const selectedConnection = await vscode.window.showQuickPick(connectionItems, {
    title: `${title} — Connection`,
    placeHolder: 'Choose a server connection',
    ignoreFocusOut: true,
  });

  if (!selectedConnection) {
    return undefined; // User dismissed (Requirement 5.7)
  }

  const connectionName = selectedConnection.label;

  // Step 2: Query databases on the selected connection, excluding system databases
  let databases: string[];
  try {
    const pool = await connectionManager.getPool(connectionName);
    databases = await queryUserDatabases(pool);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to connect to ${connectionName} — ${reason}`);
    return undefined;
  }

  if (databases.length === 0) {
    vscode.window.showInformationMessage(`No user databases found on "${connectionName}".`);
    return undefined;
  }

  // Step 2b: Pick database
  const databaseItems: vscode.QuickPickItem[] = databases.map(db => ({
    label: db,
  }));

  const selectedDatabase = await vscode.window.showQuickPick(databaseItems, {
    title: `${title} — Database`,
    placeHolder: `Choose a database on "${connectionName}"`,
    ignoreFocusOut: true,
  });

  if (!selectedDatabase) {
    return undefined; // User dismissed (Requirement 5.7)
  }

  const database = selectedDatabase.label;

  // Step 3: Query schemas in the selected database (only those with user tables)
  let schemas: string[];
  try {
    const dbPool = await connectionManager.getPoolForDatabase(connectionName, database);
    schemas = await queryUserSchemas(dbPool);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to query schemas on ${connectionName}/${database} — ${reason}`);
    return undefined;
  }

  if (schemas.length === 0) {
    vscode.window.showInformationMessage(`No schemas with user tables found in "${database}".`);
    return undefined;
  }

  // Step 3b: Pick schema
  const schemaItems: vscode.QuickPickItem[] = schemas.map(s => ({
    label: s,
  }));

  const selectedSchema = await vscode.window.showQuickPick(schemaItems, {
    title: `${title} — Schema`,
    placeHolder: `Choose a schema in "${database}"`,
    ignoreFocusOut: true,
  });

  if (!selectedSchema) {
    return undefined; // User dismissed (Requirement 5.7)
  }

  return {
    connectionName,
    database,
    schemaName: selectedSchema.label,
  };
}

/**
 * Queries sys.databases excluding system databases (master, model, msdb, tempdb).
 * Returns a sorted list of user database names.
 */
async function queryUserDatabases(pool: mssql.ConnectionPool): Promise<string[]> {
  const result = await pool.request().query<{ name: string }>(
    `SELECT name FROM sys.databases
     WHERE name NOT IN ('master', 'model', 'msdb', 'tempdb')
       AND state_desc = 'ONLINE'
     ORDER BY name`
  );

  return result.recordset.map(row => row.name);
}

/**
 * Queries sys.schemas on the connected database, returning only schemas that
 * contain at least one user table. Excludes system schemas (sys, INFORMATION_SCHEMA, guest).
 * Requirement 5.10.
 */
async function queryUserSchemas(pool: mssql.ConnectionPool): Promise<string[]> {
  const result = await pool.request().query<{ schema_name: string }>(
    `SELECT DISTINCT s.name AS schema_name
     FROM sys.schemas s
     INNER JOIN sys.tables t ON t.schema_id = s.schema_id
     WHERE s.name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest')
       AND t.type = 'U'
     ORDER BY s.name`
  );

  return result.recordset.map(row => row.schema_name);
}

/**
 * Executes the full schema diff flow: validates selection, captures snapshots, compares.
 */
async function executeSchemaDiff(
  connectionManager: ObjectExplorerConnectionManager,
  engine: SchemaDiffEngine,
  source: SchemaDiffSelection,
  target: SchemaDiffSelection
): Promise<void> {
  // Requirement 5.9: Check if same source and target (connection + database + schema)
  if (
    source.connectionName === target.connectionName &&
    source.database.toLowerCase() === target.database.toLowerCase() &&
    source.schemaName.toLowerCase() === target.schemaName.toLowerCase()
  ) {
    vscode.window.showWarningMessage('Source and target are the same schema. Choose a different target.');
    return;
  }

  // Capture snapshots with progress (Requirements 5.3, 5.6, 5.8)
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Schema Diff',
      cancellable: false,
    },
    async (progress) => {
      // Capture source snapshot
      progress.report({
        message: `Capturing source: ${source.connectionName} / ${source.database} / ${source.schemaName}...`,
      });

      let sourcePool: mssql.ConnectionPool;
      try {
        sourcePool = await connectionManager.getPoolForDatabase(source.connectionName, source.database);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to connect to source: ${source.connectionName} — ${reason}`);
        return;
      }

      let sourceSnapshot;
      try {
        sourceSnapshot = await withTimeout(
          engine.captureSnapshot(sourcePool, source.database, source.schemaName, source.connectionName),
          SNAPSHOT_TIMEOUT_MS,
          `Source snapshot timed out after 60 seconds (${source.database}.${source.schemaName})`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(message);
        return;
      }

      // Capture target snapshot
      progress.report({
        message: `Capturing target: ${target.connectionName} / ${target.database} / ${target.schemaName}...`,
      });

      let targetPool: mssql.ConnectionPool;
      try {
        targetPool = await connectionManager.getPoolForDatabase(target.connectionName, target.database);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to connect to target: ${target.connectionName} — ${reason}`);
        return;
      }

      let targetSnapshot;
      try {
        targetSnapshot = await withTimeout(
          engine.captureSnapshot(targetPool, target.database, target.schemaName, target.connectionName),
          SNAPSHOT_TIMEOUT_MS,
          `Target snapshot timed out after 60 seconds (${target.database}.${target.schemaName})`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(message);
        return;
      }

      // Compare snapshots
      progress.report({ message: 'Comparing schemas...' });
      const diff = engine.compareSnapshots(sourceSnapshot, targetSnapshot);

      // Store the result
      lastDiffResult = diff;

      // Show results in DiffPanel webview (Requirement 6.2)
      if (!diffPanel) {
        diffPanel = new DiffPanel();
      }
      diffPanel.show(diff);
    }
  );
}

/**
 * Wraps a promise with a timeout. Rejects with the provided message if the timeout expires.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
