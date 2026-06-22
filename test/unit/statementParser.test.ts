import { describe, it, expect } from 'vitest';
import { parseStatements, findStatementAtCursor } from '../../src/statementParser';

describe('parseStatements', () => {
  it('returns empty array for empty input', () => {
    expect(parseStatements('')).toEqual([]);
    expect(parseStatements('   ')).toEqual([]);
    expect(parseStatements('\n\n')).toEqual([]);
  });

  it('parses a single statement without semicolon', () => {
    const result = parseStatements('SELECT 1');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      startLine: 0,
      endLine: 0,
      text: 'SELECT 1',
      batchIndex: 1,
      statementIndex: 1,
    });
  });

  it('parses a single statement with semicolon', () => {
    const result = parseStatements('SELECT 1;');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      startLine: 0,
      endLine: 0,
      text: 'SELECT 1',
      batchIndex: 1,
      statementIndex: 1,
    });
  });

  it('parses multiple statements separated by semicolons', () => {
    const sql = 'SELECT 1;\nSELECT 2;\nSELECT 3';
    const result = parseStatements(sql);
    expect(result).toHaveLength(3);
    expect(result[0].text).toBe('SELECT 1');
    expect(result[0].startLine).toBe(0);
    expect(result[0].endLine).toBe(0);
    expect(result[0].statementIndex).toBe(1);

    expect(result[1].text).toBe('SELECT 2');
    expect(result[1].startLine).toBe(1);
    expect(result[1].endLine).toBe(1);
    expect(result[1].statementIndex).toBe(2);

    expect(result[2].text).toBe('SELECT 3');
    expect(result[2].startLine).toBe(2);
    expect(result[2].endLine).toBe(2);
    expect(result[2].statementIndex).toBe(3);
  });

  it('parses multi-line statements', () => {
    const sql = 'SELECT\n  col1,\n  col2\nFROM table1;\nSELECT 1';
    const result = parseStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0].startLine).toBe(0);
    expect(result[0].endLine).toBe(3);
    expect(result[0].text).toBe('SELECT\n  col1,\n  col2\nFROM table1');
    expect(result[0].batchIndex).toBe(1);
    expect(result[0].statementIndex).toBe(1);

    expect(result[1].startLine).toBe(4);
    expect(result[1].endLine).toBe(4);
    expect(result[1].text).toBe('SELECT 1');
    expect(result[1].statementIndex).toBe(2);
  });

  it('splits on GO separator into separate batches', () => {
    const sql = 'SELECT 1\nGO\nSELECT 2';
    const result = parseStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0].batchIndex).toBe(1);
    expect(result[0].statementIndex).toBe(1);
    expect(result[0].text).toBe('SELECT 1');
    expect(result[0].startLine).toBe(0);

    expect(result[1].batchIndex).toBe(2);
    expect(result[1].statementIndex).toBe(1);
    expect(result[1].text).toBe('SELECT 2');
    expect(result[1].startLine).toBe(2);
  });

  it('handles GO with surrounding whitespace', () => {
    const sql = 'SELECT 1\n  GO  \nSELECT 2';
    const result = parseStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0].batchIndex).toBe(1);
    expect(result[1].batchIndex).toBe(2);
  });

  it('does not split on GO inside a string literal', () => {
    const sql = "SELECT 'GO'\nSELECT 2";
    const result = parseStatements(sql);
    // "GO" is inside a string, so no batch split.
    // But SELECT on line 2 implicitly starts a new statement.
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("SELECT 'GO'");
    expect(result[1].text).toBe("SELECT 2");
  });

  it('does not split on GO inside a block comment', () => {
    const sql = '/* \nGO\n*/\nSELECT 1';
    const result = parseStatements(sql);
    expect(result).toHaveLength(1);
    expect(result[0].batchIndex).toBe(1);
  });

  it('does not split on semicolons inside string literals', () => {
    const sql = "SELECT 'hello;world';\nSELECT 2";
    const result = parseStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("SELECT 'hello;world'");
    expect(result[1].text).toBe('SELECT 2');
  });

  it('handles escaped quotes in strings', () => {
    const sql = "SELECT 'it''s;here';\nSELECT 2";
    const result = parseStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("SELECT 'it''s;here'");
  });

  it('does not split on semicolons inside block comments', () => {
    const sql = '/* comment; with semicolon */\nSELECT 1;\nSELECT 2';
    const result = parseStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('/* comment; with semicolon */\nSELECT 1');
    expect(result[1].text).toBe('SELECT 2');
  });

  it('does not split on semicolons inside single-line comments', () => {
    const sql = 'SELECT 1 -- comment; here\nSELECT 2';
    const result = parseStatements(sql);
    // No semicolons outside comments, but SELECT on line 2 implicitly starts a new statement
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('SELECT 1 -- comment; here');
    expect(result[1].text).toBe('SELECT 2');
  });

  it('handles multiple batches with multiple statements each', () => {
    const sql = 'SELECT 1;\nSELECT 2\nGO\nSELECT 3;\nSELECT 4';
    const result = parseStatements(sql);
    expect(result).toHaveLength(4);

    expect(result[0].batchIndex).toBe(1);
    expect(result[0].statementIndex).toBe(1);
    expect(result[1].batchIndex).toBe(1);
    expect(result[1].statementIndex).toBe(2);
    expect(result[2].batchIndex).toBe(2);
    expect(result[2].statementIndex).toBe(1);
    expect(result[3].batchIndex).toBe(2);
    expect(result[3].statementIndex).toBe(2);
  });

  it('skips whitespace-only segments between semicolons', () => {
    const sql = 'SELECT 1;\n\n;\nSELECT 2';
    const result = parseStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('SELECT 1');
    expect(result[1].text).toBe('SELECT 2');
  });

  it('handles block comment spanning multiple lines', () => {
    const sql = 'SELECT 1;\n/*\nSELECT hidden;\n*/\nSELECT 2';
    const result = parseStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('SELECT 1');
    expect(result[1].text).toContain('/*');
    expect(result[1].text).toContain('SELECT 2');
  });

  it('assigns correct line numbers with leading blank lines', () => {
    const sql = '\n\nSELECT 1;\nSELECT 2';
    const result = parseStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0].startLine).toBe(2);
    expect(result[0].endLine).toBe(2);
    expect(result[1].startLine).toBe(3);
    expect(result[1].endLine).toBe(3);
  });

  it('handles case-insensitive GO', () => {
    const sql = 'SELECT 1\ngo\nSELECT 2';
    const result = parseStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0].batchIndex).toBe(1);
    expect(result[1].batchIndex).toBe(2);
  });

  it('does not treat GO as separator when part of a word', () => {
    const sql = 'SELECT GOAWAY\nFROM table1';
    const result = parseStatements(sql);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('SELECT GOAWAY\nFROM table1');
  });
});

describe('findStatementAtCursor', () => {
  const boundaries = [
    { startLine: 0, endLine: 2, text: 'SELECT\n  col1\nFROM t1', batchIndex: 1, statementIndex: 1 },
    { startLine: 4, endLine: 4, text: 'SELECT 2', batchIndex: 1, statementIndex: 2 },
    { startLine: 7, endLine: 9, text: 'SELECT\n  col2\nFROM t2', batchIndex: 2, statementIndex: 1 },
  ];

  it('returns the boundary containing the cursor line', () => {
    expect(findStatementAtCursor(boundaries, 0)).toBe(boundaries[0]);
    expect(findStatementAtCursor(boundaries, 1)).toBe(boundaries[0]);
    expect(findStatementAtCursor(boundaries, 2)).toBe(boundaries[0]);
    expect(findStatementAtCursor(boundaries, 4)).toBe(boundaries[1]);
    expect(findStatementAtCursor(boundaries, 7)).toBe(boundaries[2]);
    expect(findStatementAtCursor(boundaries, 8)).toBe(boundaries[2]);
    expect(findStatementAtCursor(boundaries, 9)).toBe(boundaries[2]);
  });

  it('returns null for lines between statements', () => {
    expect(findStatementAtCursor(boundaries, 3)).toBeNull();
    expect(findStatementAtCursor(boundaries, 5)).toBeNull();
    expect(findStatementAtCursor(boundaries, 6)).toBeNull();
  });

  it('returns null for lines after all statements', () => {
    expect(findStatementAtCursor(boundaries, 10)).toBeNull();
    expect(findStatementAtCursor(boundaries, 100)).toBeNull();
  });

  it('returns null for empty boundaries array', () => {
    expect(findStatementAtCursor([], 0)).toBeNull();
  });

  it('returns null for negative cursor line', () => {
    expect(findStatementAtCursor(boundaries, -1)).toBeNull();
  });
});
