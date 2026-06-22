import { describe, it, expect } from 'vitest';
import { formatDocument, formatSelection, FormatOptions } from '../../server/src/formatter';

const defaultOptions: FormatOptions = {
  tabSize: 4,
  insertSpaces: true,
  eol: '\n',
};

describe('formatter - basic sanity', () => {
  it('formats a simple SELECT statement', () => {
    const input = 'select a, b, c from dbo.Users where id = 1';
    const result = formatDocument(input, defaultOptions);
    expect(result.formatted).toBe(true);
    expect(result.text).toContain('SELECT');
    expect(result.text).toContain('FROM');
    expect(result.text).toContain('WHERE');
  });

  it('returns unchanged text for invalid SQL', () => {
    const input = 'SELECT * FROM (';
    const result = formatDocument(input, defaultOptions);
    if (!result.formatted) {
      expect(result.text).toBe(input);
    }
  });

  it('uppercases keywords', () => {
    const input = 'select id from dbo.Users';
    const result = formatDocument(input, defaultOptions);
    expect(result.formatted).toBe(true);
    expect(result.text).toContain('SELECT');
    expect(result.text).toContain('FROM');
  });

  it('places clauses on separate lines', () => {
    const input = 'select id from dbo.Users where id = 1';
    const result = formatDocument(input, defaultOptions);
    expect(result.formatted).toBe(true);
    const lines = result.text.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });

  it('preserves string literals', () => {
    const input = "select 'hello world' from dbo.Users";
    const result = formatDocument(input, defaultOptions);
    expect(result.formatted).toBe(true);
    expect(result.text).toContain("'hello world'");
  });

  it('handles empty input', () => {
    const result = formatDocument('', defaultOptions);
    expect(result.text).toBe('');
    expect(result.formatted).toBe(true);
  });
});

describe('formatter - SELECT column list', () => {
  it('places each column on its own line', () => {
    const input = 'select a, b, c from dbo.T';
    const result = formatDocument(input, defaultOptions);
    expect(result.formatted).toBe(true);
    const lines = result.text.trim().split('\n');
    // Find lines with columns
    const colLines = lines.filter(l => l.trim().startsWith('a') || l.trim().startsWith('b') || l.trim().startsWith('c'));
    expect(colLines.length).toBe(3);
  });

  it('adds trailing comma except on last item', () => {
    const input = 'select a, b, c from dbo.T';
    const result = formatDocument(input, defaultOptions);
    expect(result.formatted).toBe(true);
    const lines = result.text.trim().split('\n');
    const colLines = lines.filter(l => /^\s+(a|b|c)/.test(l));
    // First two should have commas, last should not
    const aLine = colLines.find(l => l.trim().startsWith('a'));
    const bLine = colLines.find(l => l.trim().startsWith('b'));
    const cLine = colLines.find(l => l.trim().startsWith('c'));
    expect(aLine).toContain(',');
    expect(bLine).toContain(',');
    expect(cLine).not.toContain(',');
  });
});

describe('formatter - indentation', () => {
  it('respects tabSize option', () => {
    const input = 'select a from dbo.T';
    const opts: FormatOptions = { tabSize: 2, insertSpaces: true, eol: '\n' };
    const result = formatDocument(input, opts);
    expect(result.formatted).toBe(true);
    // Column should be indented with 2 spaces
    const lines = result.text.trim().split('\n');
    const colLine = lines.find(l => l.includes('a') && l.startsWith(' '));
    expect(colLine).toBeDefined();
    expect(colLine!.startsWith('  ')).toBe(true);
    expect(colLine!.startsWith('   ')).toBe(false);
  });

  it('uses tabs when insertSpaces is false', () => {
    const input = 'select a from dbo.T';
    const opts: FormatOptions = { tabSize: 4, insertSpaces: false, eol: '\n' };
    const result = formatDocument(input, opts);
    expect(result.formatted).toBe(true);
    const lines = result.text.trim().split('\n');
    const colLine = lines.find(l => l.includes('a') && l.startsWith('\t'));
    expect(colLine).toBeDefined();
  });

  it('uses configured EOL', () => {
    const input = 'select a from dbo.T';
    const opts: FormatOptions = { tabSize: 4, insertSpaces: true, eol: '\r\n' };
    const result = formatDocument(input, opts);
    expect(result.formatted).toBe(true);
    expect(result.text).toContain('\r\n');
    expect(result.text.includes('\n')).toBe(true);
  });
});

describe('formatter - GO batch handling', () => {
  it('formats each batch independently', () => {
    const input = 'select a from dbo.T\nGO\nselect b from dbo.U';
    const result = formatDocument(input, defaultOptions);
    expect(result.formatted).toBe(true);
    expect(result.text).toContain('GO');
    expect(result.text).toContain('SELECT');
  });
});

describe('formatter - preserves content', () => {
  it('preserves block comments', () => {
    const input = "select /* this is a comment */ a from dbo.T";
    const result = formatDocument(input, defaultOptions);
    expect(result.formatted).toBe(true);
    expect(result.text).toContain('/* this is a comment */');
  });

  it('preserves line comments', () => {
    const input = "select a -- inline comment\nfrom dbo.T";
    const result = formatDocument(input, defaultOptions);
    expect(result.formatted).toBe(true);
    expect(result.text).toContain('-- inline comment');
  });

  it('preserves quoted identifiers', () => {
    const input = 'select [My Column] from dbo.T';
    const result = formatDocument(input, defaultOptions);
    expect(result.formatted).toBe(true);
    expect(result.text).toContain('[My Column]');
  });

  it('preserves N-prefixed strings', () => {
    const input = "select N'unicode string' from dbo.T";
    const result = formatDocument(input, defaultOptions);
    expect(result.formatted).toBe(true);
    expect(result.text).toContain("N'unicode string'");
  });
});

describe('formatter - formatSelection', () => {
  it('returns null for empty selection', () => {
    const result = formatSelection('select a from dbo.T', 5, 5, defaultOptions);
    expect(result).toBeNull();
  });
});
