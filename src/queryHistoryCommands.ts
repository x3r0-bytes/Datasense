import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { HistoryRecord, IQueryHistoryStore } from './queryHistoryStore';
import { IQueryHistoryProvider } from './queryHistoryProvider';

/**
 * Creates command handlers for query history actions.
 * Returns disposables for the registered commands.
 */
export function registerQueryHistoryCommands(
  store: IQueryHistoryStore,
  provider: IQueryHistoryProvider,
  connectionsFilePath: string
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // ─── Re-run Command ───────────────────────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand('sqlServer.queryHistoryRerun', async (record: HistoryRecord) => {
      if (!record || !record.sql) {
        vscode.window.showErrorMessage('No history record selected.');
        return;
      }

      // Read .sql-connections.json to verify the connection still exists
      let connections: any[] = [];
      try {
        const content = fs.readFileSync(connectionsFilePath, 'utf-8');
        const parsed = JSON.parse(content);
        if (parsed && Array.isArray(parsed.connections)) {
          connections = parsed.connections;
        }
      } catch {
        vscode.window.showErrorMessage(
          `Cannot read connections file. Unable to verify connection "${record.connectionName}".`
        );
        return;
      }

      const matchingConnection = connections.find(
        (c: any) => c.name === record.connectionName
      );

      if (!matchingConnection) {
        vscode.window.showErrorMessage(
          `Connection "${record.connectionName}" not found in .sql-connections.json. Cannot re-run query.`
        );
        return;
      }

      // Open the SQL in a new untitled editor so the user can run it
      const doc = await vscode.workspace.openTextDocument({
        content: record.sql,
        language: 'sql',
      });
      await vscode.window.showTextDocument(doc, { preview: false });

      vscode.window.showInformationMessage(
        `Query loaded from history. Use connection "${record.connectionName}" (${record.databaseName}) to execute.`
      );
    })
  );

  // ─── Clear Command ────────────────────────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand('sqlServer.queryHistoryClear', async () => {
      store.clear();
      await store.save();
      provider.refresh();
    })
  );

  // ─── Search Command ───────────────────────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand('sqlServer.queryHistorySearch', async () => {
      const input = await vscode.window.showInputBox({
        prompt: 'Search query history',
        placeHolder: 'Filter by SQL text, connection name, or database name',
      });

      if (input === undefined) {
        // User dismissed the input box — clear filter
        provider.setFilter('');
      } else {
        provider.setFilter(input);
      }
    })
  );

  // ─── Open Command ─────────────────────────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand('sqlServer.queryHistoryOpen', async (record: HistoryRecord) => {
      if (!record || !record.sql) {
        return;
      }

      // Open full SQL text in a read-only preview editor with SQL language mode
      const doc = await vscode.workspace.openTextDocument({
        content: record.sql,
        language: 'sql',
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    })
  );

  return disposables;
}
