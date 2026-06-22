import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode module
vi.mock('vscode', () => ({
  window: {
    showWarningMessage: vi.fn(),
  },
}));

import * as vscode from 'vscode';
import { formatStatementForDialog, getDialogMessage, checkBeforeExecution } from '../../src/destructiveQueryGuard';
import { DestructiveStatement } from '../../src/destructiveStatementAnalyzer';

describe('formatStatementForDialog', () => {
  it('returns "Line N: <full text>" for short statement (< 200 chars)', () => {
    const stmt: DestructiveStatement = {
      text: 'DELETE FROM Users',
      lineNumber: 1,
      reason: 'DELETE_WITHOUT_WHERE',
    };
    expect(formatStatementForDialog(stmt)).toBe('Line 1: DELETE FROM Users');
  });

  it('returns "Line N: <full text>" for statement exactly 200 chars (no truncation)', () => {
    const text = 'A'.repeat(200);
    const stmt: DestructiveStatement = {
      text,
      lineNumber: 5,
      reason: 'UPDATE_WITHOUT_WHERE',
    };
    expect(formatStatementForDialog(stmt)).toBe(`Line 5: ${text}`);
  });

  it('truncates statement > 200 chars with "..." suffix', () => {
    const text = 'B'.repeat(250);
    const stmt: DestructiveStatement = {
      text,
      lineNumber: 3,
      reason: 'DELETE_WITHOUT_WHERE',
    };
    const result = formatStatementForDialog(stmt);
    expect(result).toBe(`Line 3: ${'B'.repeat(200)}...`);
  });

  it('formats line number correctly for various line numbers', () => {
    const stmt: DestructiveStatement = {
      text: 'DROP TABLE Users',
      lineNumber: 42,
      reason: 'DROP_TABLE',
    };
    expect(formatStatementForDialog(stmt)).toBe('Line 42: DROP TABLE Users');
  });

  it('trims statement text before formatting', () => {
    const stmt: DestructiveStatement = {
      text: '   DELETE FROM Orders   ',
      lineNumber: 7,
      reason: 'DELETE_WITHOUT_WHERE',
    };
    expect(formatStatementForDialog(stmt)).toBe('Line 7: DELETE FROM Orders');
  });

  it('trims then checks length for truncation (trimmed > 200 chars)', () => {
    const text = '   ' + 'C'.repeat(210) + '   ';
    const stmt: DestructiveStatement = {
      text,
      lineNumber: 2,
      reason: 'UPDATE_WITHOUT_WHERE',
    };
    const result = formatStatementForDialog(stmt);
    expect(result).toBe(`Line 2: ${'C'.repeat(200)}...`);
  });
});

describe('getDialogMessage', () => {
  it('returns "affects all rows" message for UPDATE_WITHOUT_WHERE only', () => {
    const statements: DestructiveStatement[] = [
      { text: 'UPDATE Users SET name = x', lineNumber: 1, reason: 'UPDATE_WITHOUT_WHERE' },
    ];
    expect(getDialogMessage(statements)).toBe('This statement affects all rows. Continue?');
  });

  it('returns "affects all rows" message for DELETE_WITHOUT_WHERE only', () => {
    const statements: DestructiveStatement[] = [
      { text: 'DELETE FROM Users', lineNumber: 1, reason: 'DELETE_WITHOUT_WHERE' },
    ];
    expect(getDialogMessage(statements)).toBe('This statement affects all rows. Continue?');
  });

  it('returns "destructive operation" message for TRUNCATE_TABLE only', () => {
    const statements: DestructiveStatement[] = [
      { text: 'TRUNCATE TABLE Users', lineNumber: 1, reason: 'TRUNCATE_TABLE' },
    ];
    expect(getDialogMessage(statements)).toBe('This is a destructive operation. Continue?');
  });

  it('returns "destructive operation" message for DROP_TABLE only', () => {
    const statements: DestructiveStatement[] = [
      { text: 'DROP TABLE Users', lineNumber: 1, reason: 'DROP_TABLE' },
    ];
    expect(getDialogMessage(statements)).toBe('This is a destructive operation. Continue?');
  });

  it('returns "destructive operation" message for DROP_DATABASE only', () => {
    const statements: DestructiveStatement[] = [
      { text: 'DROP DATABASE TestDB', lineNumber: 1, reason: 'DROP_DATABASE' },
    ];
    expect(getDialogMessage(statements)).toBe('This is a destructive operation. Continue?');
  });

  it('returns "affects all rows" message for mixed (UPDATE + DROP) — row-level message wins', () => {
    const statements: DestructiveStatement[] = [
      { text: 'UPDATE Users SET name = x', lineNumber: 1, reason: 'UPDATE_WITHOUT_WHERE' },
      { text: 'DROP TABLE Orders', lineNumber: 3, reason: 'DROP_TABLE' },
    ];
    expect(getDialogMessage(statements)).toBe('This statement affects all rows. Continue?');
  });

  it('returns "affects all rows" message for mixed (DELETE + TRUNCATE)', () => {
    const statements: DestructiveStatement[] = [
      { text: 'TRUNCATE TABLE Logs', lineNumber: 1, reason: 'TRUNCATE_TABLE' },
      { text: 'DELETE FROM Users', lineNumber: 5, reason: 'DELETE_WITHOUT_WHERE' },
    ];
    expect(getDialogMessage(statements)).toBe('This statement affects all rows. Continue?');
  });
});

describe('checkBeforeExecution', () => {
  beforeEach(() => {
    vi.mocked(vscode.window.showWarningMessage).mockReset();
  });

  it('returns proceed: true without showing dialog for safe SQL', async () => {
    const result = await checkBeforeExecution('SELECT * FROM Users WHERE id = 1');
    expect(result.proceed).toBe(true);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('returns proceed: true when user clicks "Yes"', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Yes' as any);
    const result = await checkBeforeExecution('DELETE FROM Users');
    expect(result.proceed).toBe(true);
  });

  it('returns proceed: false when user clicks "No"', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('No' as any);
    const result = await checkBeforeExecution('DELETE FROM Users');
    expect(result.proceed).toBe(false);
  });

  it('returns proceed: false when user presses Escape (undefined)', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as any);
    const result = await checkBeforeExecution('DELETE FROM Users');
    expect(result.proceed).toBe(false);
  });

  it('passes modal: true and detail to showWarningMessage', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Yes' as any);
    await checkBeforeExecution('DELETE FROM Users');

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'This statement affects all rows. Continue?',
      expect.objectContaining({ modal: true }),
      'Yes',
      'No'
    );

    const callArgs = vi.mocked(vscode.window.showWarningMessage).mock.calls[0];
    const options = callArgs[1] as { modal: boolean; detail: string };
    expect(options.detail).toContain('Line 1:');
    expect(options.detail).toContain('DELETE FROM Users');
  });

  it('passes "Yes" and "No" as button options', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('No' as any);
    await checkBeforeExecution('UPDATE Users SET name = x');

    const callArgs = vi.mocked(vscode.window.showWarningMessage).mock.calls[0];
    expect(callArgs[2]).toBe('Yes');
    expect(callArgs[3]).toBe('No');
  });

  it('lists multiple destructive statements in order by line number', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Yes' as any);
    const sql = `DELETE FROM Users;\nSELECT 1;\nDROP TABLE Orders`;
    await checkBeforeExecution(sql);

    const callArgs = vi.mocked(vscode.window.showWarningMessage).mock.calls[0];
    const options = callArgs[1] as { modal: boolean; detail: string };
    const detailLines = options.detail.split('\n');

    // Should have two destructive entries, in order by line number
    expect(detailLines.length).toBe(2);
    expect(detailLines[0]).toContain('Line 1:');
    expect(detailLines[0]).toContain('DELETE FROM Users');
    expect(detailLines[1]).toContain('Line 3:');
    expect(detailLines[1]).toContain('DROP TABLE Orders');
  });

  it('returns proceed: true without dialog for non-destructive multi-statement SQL', async () => {
    const sql = `SELECT * FROM Users WHERE id = 1;\nINSERT INTO Logs VALUES (1)`;
    const result = await checkBeforeExecution(sql);
    expect(result.proceed).toBe(true);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });
});
