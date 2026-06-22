import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { ConnectionConfig } from './types';
import { ErrorCategoryHandler } from './errorCategoryHandler';

/**
 * Implements the `sqlServer.switchServer` command.
 * Opens a QuickPick listing all configured server connections and switches
 * the active connection on selection. On connection failure, uses categorized
 * error handling to show appropriate dialogs.
 */
export async function switchServer(connectionManager: ConnectionManager, errorHandler?: ErrorCategoryHandler): Promise<void> {
  const connections = connectionManager.loadConnections();

  if (connections.length === 0) {
    vscode.window.showWarningMessage(
      'No SQL Server connections configured. Add connections to .sql-connections.json in your workspace root.'
    );
    return;
  }

  const activeConfig = connectionManager.getActiveConfig();

  const items: vscode.QuickPickItem[] = connections.map(conn => ({
    label: conn.name,
    description: `${conn.host}:${conn.port ?? 1433}`,
    detail: activeConfig && activeConfig.name === conn.name ? '$(check) Currently connected' : undefined,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a server connection',
    title: 'Switch Server',
  });

  if (!selected) {
    return;
  }

  try {
    await connectionManager.switchConnection(selected.label);
  } catch (err) {
    const config = connections.find(c => c.name === selected.label);
    if (errorHandler && config) {
      const error = err instanceof Error ? err : new Error(String(err));
      await errorHandler.handleConnectionError(error, config);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to connect to "${selected.label}": ${message}`);
    }
  }
}

/**
 * Implements the `sqlServer.switchDatabase` command.
 * Opens a QuickPick listing all databases on the current server and switches
 * the active database on selection. If no active server connection exists,
 * shows an info message prompting the user to connect first.
 * On failure, uses categorized error handling to show appropriate dialogs.
 */
export async function switchDatabase(connectionManager: ConnectionManager, errorHandler?: ErrorCategoryHandler): Promise<void> {
  const activePool = connectionManager.getActiveConnection();
  const activeConfig = connectionManager.getActiveConfig();

  if (!activePool || !activeConfig) {
    vscode.window.showInformationMessage('Connect to a server first');
    return;
  }

  // Query the current server for available databases
  let databases: string[];
  try {
    const result = await activePool.request().query('SELECT name FROM sys.databases ORDER BY name');
    databases = result.recordset.map((row: { name: string }) => row.name);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to retrieve database list: ${message}`);
    return;
  }

  if (databases.length === 0) {
    vscode.window.showInformationMessage('No databases found on the current server.');
    return;
  }

  const currentDatabase = activeConfig.database || 'master';

  const items: vscode.QuickPickItem[] = databases.map(db => ({
    label: db,
    detail: db === currentDatabase ? '$(check) Currently selected' : undefined,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a database',
    title: 'Switch Database',
  });

  if (!selected) {
    return;
  }

  // Switch to the selected database by disconnecting and reconnecting with the new database.
  // On failure, restore the previous connection state.
  const previousPool = connectionManager.getActiveConnection();
  const previousConfig = connectionManager.getActiveConfig();

  const newConfig: ConnectionConfig = {
    ...activeConfig,
    database: selected.label,
  };

  try {
    await connectionManager.disconnect();
    await connectionManager.connect(newConfig);
    // Notify listeners that the connection changed (new database)
    connectionManager.fireConnectionChanged();
  } catch (err) {
    // Restore previous connection on failure
    try {
      if (previousConfig) {
        await connectionManager.connect(previousConfig);
      }
    } catch {
      // If restoration also fails, we're left disconnected — nothing more we can do
    }

    if (errorHandler) {
      const error = err instanceof Error ? err : new Error(String(err));
      await errorHandler.handleConnectionError(error, newConfig);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to switch to database "${selected.label}": ${message}`);
    }
  }
}
