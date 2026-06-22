import * as vscode from 'vscode';
import { QueryResult } from './types';

/**
 * Formats a duration in milliseconds to a human-readable string.
 *
 * Rules:
 * - 0–999ms: "{n}ms" (e.g., "12ms")
 * - 1000–59999ms: "{n.d}s" with half-up rounding (e.g., 1550ms → "1.6s")
 * - ≥60000ms: "{m}m {s}s" with truncated seconds (e.g., 61000ms → "1m 1s")
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.floor(ms)}ms`;
  }
  if (ms < 60000) {
    const seconds = ms / 1000;
    // Half-up rounding to one decimal place
    const rounded = Math.round(seconds * 10) / 10;
    return `${rounded.toFixed(1)}s`;
  }
  // ≥60000ms: minutes and truncated seconds
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Formats a row count with thousand separators and correct pluralization.
 *
 * Rules:
 * - 0: "0 rows"
 * - 1: "1 row" (singular)
 * - 2–999: "{n} rows"
 * - ≥1000: "{n,nnn} rows" (comma separators)
 * - Negative/unavailable: empty string
 */
export function formatRowCount(count: number): string {
  if (count < 0) {
    return '';
  }
  if (count === 1) {
    return '1 row';
  }
  const formatted = count >= 1000
    ? count.toLocaleString('en-US')
    : count.toString();
  return `${formatted} rows`;
}

/**
 * Formats the complete status text from a QueryResult.
 *
 * Rules:
 * - Success with result sets: "{formatRowCount(totalRows)}, {formatDuration(ms)}"
 * - Success with rows affected only (no result sets): "{count} rows affected, {formatDuration(ms)}"
 * - Error: "Error, {formatDuration(ms)}"
 */
export function formatStatusText(result: QueryResult): string {
  const duration = formatDuration(result.executionTimeMs ?? 0);

  // Error case
  if (result.error) {
    return `Error, ${duration}`;
  }

  // Success with result sets
  if (result.resultSets && result.resultSets.length > 0) {
    const totalRows = result.resultSets.reduce((sum, rs) => sum + rs.rowCount, 0);
    return `${formatRowCount(totalRows)}, ${duration}`;
  }

  // Success with rows affected only (no result sets)
  return `${result.rowsAffected} rows affected, ${duration}`;
}

/**
 * Interface for the query status indicator.
 */
export interface IQueryStatusIndicator {
  showRunning(): void;
  showResult(result: QueryResult): void;
  showCancelled(elapsedMs: number): void;
  hide(): void;
  dispose(): void;
}

/**
 * Determines whether the query status indicator should be visible
 * based on the active editor's language ID.
 * Returns true only when the language ID is 'sql'.
 */
export function shouldShowQueryStatus(languageId: string): boolean {
  return languageId === 'sql';
}

/**
 * Query status indicator that displays row count and execution duration
 * in the status bar after a query completes.
 *
 * Positioned at StatusBarAlignment.Left, priority -102
 * (after EditorConnectionIndicator's database item at -101).
 *
 * Visibility rules:
 * - Hidden on construction (no query executed yet)
 * - Shown when a query starts (showRunning())
 * - Hidden when active editor switches to a non-SQL file
 * - Shown again when switching back to a SQL file (if there's a result to display)
 */
export class QueryStatusIndicator implements IQueryStatusIndicator {
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private lastResult: QueryResult | null = null;
  private isRunning: boolean = false;
  private hasBeenShown: boolean = false;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      -102
    );

    // Listen to active editor changes for visibility
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.handleEditorChange(editor);
      })
    );
  }

  /**
   * Displays a spinner icon with "Running..." text.
   * Clears any previous result.
   */
  showRunning(): void {
    this.lastResult = null;
    this.isRunning = true;
    this.hasBeenShown = true;
    this.statusBarItem.text = '$(sync~spin) Running...';
    this.statusBarItem.show();
  }

  /**
   * Displays the formatted status text from a QueryResult.
   */
  showResult(result: QueryResult): void {
    this.isRunning = false;
    this.lastResult = result;
    this.hasBeenShown = true;
    this.statusBarItem.text = formatStatusText(result);
    this.statusBarItem.show();
  }

  /**
   * Displays "Cancelled, {duration}" text.
   */
  showCancelled(elapsedMs: number): void {
    this.isRunning = false;
    this.lastResult = null;
    this.hasBeenShown = true;
    this.statusBarItem.text = `Cancelled, ${formatDuration(elapsedMs)}`;
    this.statusBarItem.show();
  }

  /**
   * Hides the status bar item.
   */
  hide(): void {
    this.statusBarItem.hide();
  }

  /**
   * Disposes of all resources.
   */
  dispose(): void {
    this.statusBarItem.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }

  /**
   * Handles active editor changes — shows indicator only for SQL files
   * when a query has been executed.
   */
  private handleEditorChange(editor: vscode.TextEditor | undefined): void {
    if (!this.hasBeenShown) {
      return;
    }

    if (editor && shouldShowQueryStatus(editor.document.languageId)) {
      // Switching back to a SQL file — re-show if running or has a result
      if (this.isRunning || this.lastResult) {
        this.statusBarItem.show();
      }
    } else {
      this.statusBarItem.hide();
    }
  }
}
