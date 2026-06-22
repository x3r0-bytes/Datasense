import * as vscode from 'vscode';
import { StatementBoundary } from './types';

/**
 * Provides per-statement CodeLens actions (Run Statement / Stop) in SQL editors.
 *
 * Behavior:
 * - Generates one CodeLens per statement boundary at its startLine
 * - Shows "$(play) Run Statement" for idle statements
 * - Shows "$(debug-stop) Stop" for the currently executing statement
 * - Shows "$(play) Run Statement — No Connection" when no connection is active
 * - Respects `sqlServer.editor.showInlineRunButtons` setting
 * - Produces zero CodeLens items when statement count exceeds 500
 */
export interface IStatementCodeLensProvider extends vscode.CodeLensProvider {
  setBoundaries(boundaries: StatementBoundary[]): void;
  setExecutingStatement(editorUri: string, boundary: StatementBoundary | null): void;
  setConnectionActive(active: boolean): void;
  onDidChangeCodeLenses: vscode.Event<void>;
}

/** Maximum number of statements before CodeLens is disabled for performance. */
const STATEMENT_THRESHOLD = 500;

export class StatementCodeLensProvider implements IStatementCodeLensProvider {
  private boundaries: StatementBoundary[] = [];
  private executingEditorUri: string | null = null;
  private executingBoundary: StatementBoundary | null = null;
  private connectionActive: boolean = false;

  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

  /**
   * Updates the stored statement boundaries and fires a change event
   * so VS Code re-requests CodeLens items.
   */
  setBoundaries(boundaries: StatementBoundary[]): void {
    this.boundaries = boundaries;
    this._onDidChangeCodeLenses.fire();
  }

  /**
   * Marks which statement is currently executing for the given editor.
   * Pass null to clear the executing state.
   */
  setExecutingStatement(editorUri: string, boundary: StatementBoundary | null): void {
    this.executingEditorUri = boundary ? editorUri : null;
    this.executingBoundary = boundary;
    this._onDidChangeCodeLenses.fire();
  }

  /**
   * Updates whether a connection is currently active.
   */
  setConnectionActive(active: boolean): void {
    this.connectionActive = active;
    this._onDidChangeCodeLenses.fire();
  }

  /**
   * Provides CodeLens items for the given document.
   *
   * Returns an empty array when:
   * - `sqlServer.editor.showInlineRunButtons` is false
   * - The number of boundaries exceeds 500
   */
  provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.CodeLens[] {
    // Check if inline run buttons are disabled via settings
    const config = vscode.workspace.getConfiguration('sqlServer.editor');
    const showInlineRunButtons = config.get<boolean>('showInlineRunButtons', true);
    if (!showInlineRunButtons) {
      return [];
    }

    // Enforce 500-statement threshold
    if (this.boundaries.length > STATEMENT_THRESHOLD) {
      return [];
    }

    const documentUri = document.uri.toString();
    const codeLenses: vscode.CodeLens[] = [];

    for (const boundary of this.boundaries) {
      const range = new vscode.Range(boundary.startLine, 0, boundary.startLine, 0);

      // Determine if this boundary is the currently executing statement
      const isExecuting =
        this.executingBoundary !== null &&
        this.executingEditorUri === documentUri &&
        this.executingBoundary.startLine === boundary.startLine &&
        this.executingBoundary.endLine === boundary.endLine;

      let command: vscode.Command | undefined;

      if (isExecuting) {
        // Currently executing — show Stop action
        command = {
          title: '$(debug-stop) Stop',
          command: 'sqlServer.cancelCurrentStatement',
          tooltip: 'Cancel execution of this statement',
        };
      } else if (!this.connectionActive) {
        // No active connection — show disabled run action
        command = {
          title: '$(play) Run Statement — No Connection',
          command: '',
          tooltip: 'No active connection',
        };
      } else {
        // Idle with active connection — show Run action
        command = {
          title: '$(play) Run Statement',
          command: 'sqlServer.runCurrentStatement',
          tooltip: 'Execute this statement',
          arguments: [boundary],
        };
      }

      codeLenses.push(new vscode.CodeLens(range, command));
    }

    return codeLenses;
  }

  /**
   * Disposes the event emitter.
   */
  dispose(): void {
    this._onDidChangeCodeLenses.dispose();
  }
}
