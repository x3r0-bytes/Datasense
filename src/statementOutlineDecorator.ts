import * as vscode from 'vscode';
import { StatementBoundary } from './types';
import { findStatementAtCursor } from './statementParser';

/**
 * Interface for the statement outline decorator that highlights
 * the statement containing the cursor.
 */
export interface IStatementOutlineDecorator {
  updateBoundaries(editor: vscode.TextEditor, boundaries: StatementBoundary[]): void;
  updateCursorPosition(editor: vscode.TextEditor, cursorLine: number): void;
  dispose(): void;
}

/**
 * Decorates the active statement (the one containing the cursor) with a
 * full box border using a theme-aware color. Uses four decoration types
 * to form a complete outline: top, middle, bottom, and single-line.
 * Respects the `sqlServer.editor.showStatementOutline` setting — when
 * disabled, no decoration is applied.
 */
export class StatementOutlineDecorator implements IStatementOutlineDecorator {
  private readonly topDecoration: vscode.TextEditorDecorationType;
  private readonly middleDecoration: vscode.TextEditorDecorationType;
  private readonly bottomDecoration: vscode.TextEditorDecorationType;
  private readonly singleLineDecoration: vscode.TextEditorDecorationType;
  private boundariesMap: Map<string, StatementBoundary[]> = new Map();

  constructor() {
    const borderColor = new vscode.ThemeColor('sqlServer.statementOutlineBorder');

    this.topDecoration = vscode.window.createTextEditorDecorationType({
      borderWidth: '2px 2px 0 2px',
      borderStyle: 'solid',
      borderColor: borderColor,
      isWholeLine: true,
    });

    this.middleDecoration = vscode.window.createTextEditorDecorationType({
      borderWidth: '0 2px 0 2px',
      borderStyle: 'solid',
      borderColor: borderColor,
      isWholeLine: true,
    });

    this.bottomDecoration = vscode.window.createTextEditorDecorationType({
      borderWidth: '0 2px 2px 2px',
      borderStyle: 'solid',
      borderColor: borderColor,
      isWholeLine: true,
    });

    this.singleLineDecoration = vscode.window.createTextEditorDecorationType({
      borderWidth: '2px',
      borderStyle: 'solid',
      borderColor: borderColor,
      isWholeLine: true,
    });
  }

  /**
   * Stores the statement boundaries for the given editor's document.
   */
  updateBoundaries(editor: vscode.TextEditor, boundaries: StatementBoundary[]): void {
    const uri = editor.document.uri.toString();
    this.boundariesMap.set(uri, boundaries);
  }

  /**
   * Updates the decoration based on the cursor position.
   * Highlights all lines of the statement containing the cursor.
   * Clears decorations if:
   * - The setting is disabled
   * - The cursor is on a gap line (not inside any statement)
   */
  updateCursorPosition(editor: vscode.TextEditor, cursorLine: number): void {
    const enabled = vscode.workspace
      .getConfiguration('sqlServer.editor')
      .get<boolean>('showStatementOutline', true);

    if (!enabled) {
      this.clearAllDecorations(editor);
      return;
    }

    const uri = editor.document.uri.toString();
    const boundaries = this.boundariesMap.get(uri);

    if (!boundaries || boundaries.length === 0) {
      this.clearAllDecorations(editor);
      return;
    }

    const statement = findStatementAtCursor(boundaries, cursorLine);

    if (!statement) {
      // Cursor is on a blank/comment-only line between statements
      this.clearAllDecorations(editor);
      return;
    }

    // Single-line statement
    if (statement.startLine === statement.endLine) {
      const range = new vscode.Range(
        new vscode.Position(statement.startLine, 0),
        new vscode.Position(statement.endLine, editor.document.lineAt(statement.endLine).text.length)
      );
      editor.setDecorations(this.topDecoration, []);
      editor.setDecorations(this.middleDecoration, []);
      editor.setDecorations(this.bottomDecoration, []);
      editor.setDecorations(this.singleLineDecoration, [range]);
      return;
    }

    // Multi-line statement
    const topRange = new vscode.Range(
      new vscode.Position(statement.startLine, 0),
      new vscode.Position(statement.startLine, editor.document.lineAt(statement.startLine).text.length)
    );

    const bottomRange = new vscode.Range(
      new vscode.Position(statement.endLine, 0),
      new vscode.Position(statement.endLine, editor.document.lineAt(statement.endLine).text.length)
    );

    const middleRanges: vscode.Range[] = [];
    for (let line = statement.startLine + 1; line < statement.endLine; line++) {
      middleRanges.push(new vscode.Range(
        new vscode.Position(line, 0),
        new vscode.Position(line, editor.document.lineAt(line).text.length)
      ));
    }

    editor.setDecorations(this.topDecoration, [topRange]);
    editor.setDecorations(this.middleDecoration, middleRanges);
    editor.setDecorations(this.bottomDecoration, [bottomRange]);
    editor.setDecorations(this.singleLineDecoration, []);
  }

  /**
   * Clears all decoration types from the editor.
   */
  private clearAllDecorations(editor: vscode.TextEditor): void {
    editor.setDecorations(this.topDecoration, []);
    editor.setDecorations(this.middleDecoration, []);
    editor.setDecorations(this.bottomDecoration, []);
    editor.setDecorations(this.singleLineDecoration, []);
  }

  /**
   * Disposes all decoration types and clears stored boundaries.
   */
  dispose(): void {
    this.topDecoration.dispose();
    this.middleDecoration.dispose();
    this.bottomDecoration.dispose();
    this.singleLineDecoration.dispose();
    this.boundariesMap.clear();
  }
}
