import * as vscode from 'vscode';
import { ConnectionConfig } from './types';
import { formatColorTooltip } from './connectionColorIndicator';

/**
 * Interface for the editor connection indicator.
 */
export interface IEditorConnectionIndicator {
  update(config: ConnectionConfig | null): void;
  show(): void;
  hide(): void;
  dispose(): void;
}

/**
 * Formats the server status bar item text from a connection config.
 * Returns placeholder text when no connection is active.
 */
export function formatServerText(config: ConnectionConfig | null): string {
  if (!config) {
    return '$(server) No Connection';
  }
  return `$(server) ${config.name}`;
}

/**
 * Formats the database status bar item text from a connection config.
 * Returns empty string when no connection is active (item will be hidden).
 */
export function formatDatabaseText(config: ConnectionConfig | null): string {
  if (!config) {
    return '';
  }
  const db = config.database || 'master';
  return `$(database) ${db}`;
}

/**
 * Determines whether the connection indicator should be visible
 * based on the active editor's language ID.
 * Returns true only when the language ID is 'sql'.
 */
export function shouldShowIndicator(languageId: string): boolean {
  return languageId === 'sql';
}

/**
 * Editor connection indicator that shows the active server and database
 * in the status bar when a .sql file is the active editor.
 */
export class EditorConnectionIndicator implements IEditorConnectionIndicator {
  private serverItem: vscode.StatusBarItem;
  private databaseItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private currentConfig: ConnectionConfig | null = null;

  constructor(onConnectionChanged: vscode.Event<ConnectionConfig | null>) {
    // Create server status bar item (Left alignment, low priority so it appears after file info)
    this.serverItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      -100
    );
    this.serverItem.command = 'sqlServer.switchServer';

    // Create database status bar item (Left alignment, slightly lower priority so it appears after server)
    this.databaseItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      -101
    );
    this.databaseItem.command = 'sqlServer.switchDatabase';

    // Set initial placeholder state
    this.update(null);

    // Listen to active editor changes for visibility
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.handleEditorChange(editor);
      })
    );

    // Subscribe to connection changes for reactive updates
    this.disposables.push(
      onConnectionChanged((config) => {
        this.update(config);
      })
    );

    // Check the current active editor on construction
    this.handleEditorChange(vscode.window.activeTextEditor);
  }

  /**
   * Updates the indicator text based on the current connection config.
   * When the connection has a color assigned, includes the color name/hex
   * in the tooltip for accessibility and sets a ThemeColor background.
   */
  update(config: ConnectionConfig | null): void {
    this.currentConfig = config;
    this.serverItem.text = formatServerText(config);

    if (config) {
      // Build tooltip with optional color info for accessibility
      let tooltip = `Connected to ${config.name} (${config.host}:${config.port ?? 1433}). Click to switch server.`;
      if (config.color) {
        tooltip += ` \u2022 ${formatColorTooltip(config.color)}`;
      }
      this.serverItem.tooltip = tooltip;

      // Set backgroundColor based on connection color
      if (config.color) {
        // VS Code only supports ThemeColor for statusBarItem.backgroundColor.
        // Map red-ish colors to errorBackground, all others to warningBackground.
        const colorUpper = config.color.toUpperCase();
        const isRedish = colorUpper === '#FF0000';
        this.serverItem.backgroundColor = new vscode.ThemeColor(
          isRedish ? 'statusBarItem.errorBackground' : 'statusBarItem.warningBackground'
        );
      } else {
        this.serverItem.backgroundColor = undefined;
      }

      const db = config.database || 'master';
      this.databaseItem.text = formatDatabaseText(config);
      this.databaseItem.tooltip = `Database: ${db}. Click to switch database.`;
    } else {
      this.serverItem.tooltip = 'No active connection. Click to connect.';
      this.serverItem.backgroundColor = undefined;
      this.databaseItem.text = '';
      this.databaseItem.tooltip = '';
    }
  }

  /**
   * Shows both status bar items.
   */
  show(): void {
    this.serverItem.show();
    if (this.currentConfig) {
      this.databaseItem.show();
    }
  }

  /**
   * Hides both status bar items.
   */
  hide(): void {
    this.serverItem.hide();
    this.databaseItem.hide();
  }

  /**
   * Disposes of all resources.
   */
  dispose(): void {
    this.serverItem.dispose();
    this.databaseItem.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }

  /**
   * Handles active editor changes — shows indicator only for SQL files.
   */
  private handleEditorChange(editor: vscode.TextEditor | undefined): void {
    if (editor && shouldShowIndicator(editor.document.languageId)) {
      this.show();
    } else {
      this.hide();
    }
  }
}
