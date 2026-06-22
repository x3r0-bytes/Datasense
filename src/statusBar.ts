import * as vscode from 'vscode';
import { ConnectionConfig, IStatusBar } from './types';

export class StatusBar implements IStatusBar {
  private statusBarItem: vscode.StatusBarItem;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      10
    );
    this.statusBarItem.command = 'sqlServer.switchConnection';
    this.update(null);
    this.statusBarItem.show();
  }

  update(config: ConnectionConfig | null): void {
    if (config) {
      const db = config.database || 'master';
      this.statusBarItem.text = `$(database) ${config.name} (${db})`;
      this.statusBarItem.tooltip = `Connected to ${config.name} - ${config.host}:${config.port ?? 1433}/${db}`;
      this.statusBarItem.backgroundColor = undefined;
    } else {
      this.statusBarItem.text = '$(database) No SQL Connection';
      this.statusBarItem.tooltip = 'Click to select a SQL Server connection';
      this.statusBarItem.backgroundColor = undefined;
    }
  }

  showWarning(message: string): void {
    this.statusBarItem.text = `$(warning) ${this.statusBarItem.text.replace(/^\$\(warning\)\s*/, '')}`;
    this.statusBarItem.tooltip = message;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.warningBackground'
    );
  }

  dispose(): void {
    this.statusBarItem.dispose();
  }
}
