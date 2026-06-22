import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';

/**
 * Provides CodeLens annotations at the top of SQL files showing the active connection.
 * When connected: displays server name and database name as clickable lenses.
 * When disconnected: displays a single "Connect" lens.
 * Mirrors the behavior of the mssql extension's CodeLens provider.
 */
export class SqlCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private _disposables: vscode.Disposable[] = [];
  private _codeLensChangedEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._codeLensChangedEmitter.event;
  private _enabled: boolean;

  constructor(private connectionManager: ConnectionManager) {
    this._enabled = vscode.workspace
      .getConfiguration()
      .get<boolean>('sqlServer.showConnectionCodeLens', true);

    // Subscribe to connection changes to refresh CodeLens
    this._disposables.push(
      connectionManager.onConnectionChanged(() => {
        this._codeLensChangedEmitter.fire();
      })
    );

    // Respond to configuration changes at runtime
    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('sqlServer.showConnectionCodeLens')) {
          this._enabled = vscode.workspace
            .getConfiguration()
            .get<boolean>('sqlServer.showConnectionCodeLens', true);
          this._codeLensChangedEmitter.fire();
        }
      })
    );
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    // Only for SQL files
    if (document.languageId !== 'sql') {
      return [];
    }

    // Check cached enabled state
    if (!this._enabled) {
      return [];
    }

    const range = new vscode.Range(0, 0, 0, 0);
    const activeConfig = this.connectionManager.getActiveConfig();

    if (!activeConfig) {
      // No connection — show "Connect" lens
      return [
        new vscode.CodeLens(range, {
          title: '$(plug) Connect',
          command: 'sqlServer.switchConnection',
          tooltip: 'Connect to a SQL Server',
        }),
      ];
    }

    // Connected — show server name + database name
    return [
      new vscode.CodeLens(range, {
        title: `$(server) ${activeConfig.name}`,
        command: 'sqlServer.switchServer',
        tooltip: 'Switch server connection',
      }),
      new vscode.CodeLens(range, {
        title: `$(database) ${activeConfig.database || 'master'}`,
        command: 'sqlServer.switchDatabase',
        tooltip: 'Switch database',
      }),
    ];
  }

  dispose(): void {
    this._codeLensChangedEmitter.dispose();
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
  }
}
