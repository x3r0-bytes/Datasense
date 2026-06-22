import * as vscode from 'vscode';
import { analyze, DestructiveStatement } from './destructiveStatementAnalyzer';

export interface GuardResult {
  proceed: boolean;
}

/**
 * Formats a destructive statement for display in the dialog.
 * Truncates to 200 characters with "..." suffix if needed.
 * Prepends "Line N: " where N is the 1-based line number.
 */
export function formatStatementForDialog(stmt: DestructiveStatement): string {
  const prefix = `Line ${stmt.lineNumber}: `;
  const text = stmt.text.trim();
  const truncated = text.length > 200 ? text.substring(0, 200) + '...' : text;
  return prefix + truncated;
}

/**
 * Determines the dialog message based on the types of destructive statements found.
 *
 * - If any are UPDATE_WITHOUT_WHERE or DELETE_WITHOUT_WHERE:
 *   "This statement affects all rows. Continue?"
 * - If only TRUNCATE_TABLE, DROP_TABLE, or DROP_DATABASE:
 *   "This is a destructive operation. Continue?"
 */
export function getDialogMessage(statements: DestructiveStatement[]): string {
  const hasRowLevelDestructive = statements.some(
    s => s.reason === 'UPDATE_WITHOUT_WHERE' || s.reason === 'DELETE_WITHOUT_WHERE'
  );

  if (hasRowLevelDestructive) {
    return 'This statement affects all rows. Continue?';
  }
  return 'This is a destructive operation. Continue?';
}

/**
 * Checks SQL text for destructive statements and prompts the user if any
 * are found. Returns whether execution should proceed.
 *
 * Fail-safe: if anything throws, defaults to blocking execution.
 */
export async function checkBeforeExecution(
  sqlText: string,
  documentStartLine?: number
): Promise<GuardResult> {
  try {
    const result = analyze(sqlText, documentStartLine);

    if (result.statements.length === 0) {
      return { proceed: true };
    }

    const message = getDialogMessage(result.statements);
    const detail = result.statements
      .map(s => formatStatementForDialog(s))
      .join('\n');

    const choice = await vscode.window.showWarningMessage(
      message,
      { modal: true, detail },
      'Yes',
      'No'
    );

    if (choice === 'Yes') {
      return { proceed: true };
    }

    // "No" or undefined (Escape/dismissal) → cancel
    return { proceed: false };
  } catch {
    // Fail-safe: if anything throws, block execution
    return { proceed: false };
  }
}
