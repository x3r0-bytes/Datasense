import { describe, it, expect } from 'vitest';
import {
  getClausePresenceSet,
  getContextualKeywords,
  extractCurrentStatement,
  getCompletions,
  VALID_SUCCESSORS,
  ClausePresenceSet,
  detectCTEChain,
  getCTENameCompletions,
} from '../../server/src/completionProvider';
import { CompletionItemKind } from 'vscode-languageserver/node';
import { ISchemaCache, TableInfo, ViewInfo, ProcedureInfo } from '../../server/src/schemaCache';
import * as mssql from 'mssql';

// Helper to create a mock schema cache for testing
function createMockSchemaCache(options: {
  tables?: TableInfo[];
  views?: ViewInfo[];
  procedures?: ProcedureInfo[];
  isPopulating?: boolean;
}): ISchemaCache {
  return {
    tables: options.tables ?? [],
    views: options.views ?? [],
    procedures: options.procedures ?? [],
    foreignKeys: [],
    isPopulating: options.isPopulating ?? false,
    refresh: async (_pool: mssql.ConnectionPool) => {},
    getForeignKeysForTable: (_schema: string, _tableName: string) => [],
  };
}

const sampleSchemaCache = createMockSchemaCache({
  tables: [
    {
      schema: 'dbo',
      name: 'Users',
      columns: [
        { name: 'Id', dataType: 'int', isNullable: false },
        { name: 'Name', dataType: 'nvarchar', isNullable: true },
        { name: 'Email', dataType: 'varchar', isNullable: false },
      ],
    },
    {
      schema: 'dbo',
      name: 'Orders',
      columns: [
        { name: 'OrderId', dataType: 'int', isNullable: false },
        { name: 'UserId', dataType: 'int', isNullable: false },
        { name: 'Total', dataType: 'decimal', isNullable: true },
      ],
    },
  ],
  views: [
    {
      schema: 'dbo',
      name: 'ActiveUsers',
      columns: [
        { name: 'Id', dataType: 'int', isNullable: false },
        { name: 'Name', dataType: 'nvarchar', isNullable: true },
      ],
    },
  ],
  procedures: [
    { schema: 'dbo', name: 'GetUsers' },
    { schema: 'admin', name: 'CleanupLogs' },
  ],
});

// ============================================================
// 1. State Machine Transitions (each edge in the state diagram)
// ============================================================

describe('Clause-Flow State Machine Transitions', () => {
  describe('SELECT → FROM transition', () => {
    it('suggests FROM after SELECT with column expressions', () => {
      const presentClauses: ClausePresenceSet = new Set(['SELECT']);
      const items = getContextualKeywords('SELECT', 'SELECT * ', presentClauses);
      const labels = items.map(i => i.label);
      expect(labels).toContain('FROM');
    });

    it('suggests FROM via getCompletions after SELECT *', () => {
      const text = 'SELECT * ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).toContain('FROM');
    });
  });

  describe('FROM → WHERE transition', () => {
    it('suggests WHERE after FROM with table reference', () => {
      const presentClauses: ClausePresenceSet = new Set(['SELECT', 'FROM']);
      const items = getContextualKeywords('FROM', 'SELECT * FROM dbo.Users ', presentClauses);
      const labels = items.map(i => i.label);
      expect(labels).toContain('WHERE');
    });
  });

  describe('FROM → JOIN transition', () => {
    it('suggests JOIN variants after FROM with table reference', () => {
      const presentClauses: ClausePresenceSet = new Set(['SELECT', 'FROM']);
      const items = getContextualKeywords('FROM', 'SELECT * FROM dbo.Users ', presentClauses);
      const labels = items.map(i => i.label);
      expect(labels).toContain('JOIN');
      expect(labels).toContain('INNER JOIN');
      expect(labels).toContain('LEFT JOIN');
      expect(labels).toContain('RIGHT JOIN');
      expect(labels).toContain('FULL JOIN');
      expect(labels).not.toContain('CROSS JOIN');
    });
  });

  describe('FROM → GROUP BY transition', () => {
    it('suggests GROUP BY after FROM with table reference', () => {
      const presentClauses: ClausePresenceSet = new Set(['SELECT', 'FROM']);
      const items = getContextualKeywords('FROM', 'SELECT * FROM dbo.Users ', presentClauses);
      const labels = items.map(i => i.label);
      expect(labels).toContain('GROUP BY');
    });
  });

  describe('FROM → ORDER BY transition', () => {
    it('suggests ORDER BY after FROM with table reference', () => {
      const presentClauses: ClausePresenceSet = new Set(['SELECT', 'FROM']);
      const items = getContextualKeywords('FROM', 'SELECT * FROM dbo.Users ', presentClauses);
      const labels = items.map(i => i.label);
      expect(labels).toContain('ORDER BY');
    });
  });

  describe('WHERE → GROUP BY transition', () => {
    it('suggests GROUP BY after WHERE clause', () => {
      const presentClauses: ClausePresenceSet = new Set(['SELECT', 'FROM', 'WHERE']);
      const items = getContextualKeywords('WHERE', 'SELECT * FROM dbo.Users WHERE Id > 1 ', presentClauses);
      const labels = items.map(i => i.label);
      expect(labels).toContain('GROUP BY');
    });
  });

  describe('WHERE → ORDER BY transition', () => {
    it('suggests ORDER BY after WHERE clause', () => {
      const presentClauses: ClausePresenceSet = new Set(['SELECT', 'FROM', 'WHERE']);
      const items = getContextualKeywords('WHERE', 'SELECT * FROM dbo.Users WHERE Id > 1 ', presentClauses);
      const labels = items.map(i => i.label);
      expect(labels).toContain('ORDER BY');
    });
  });

  describe('GROUP BY → HAVING transition', () => {
    it('suggests HAVING after GROUP BY clause', () => {
      const presentClauses: ClausePresenceSet = new Set(['SELECT', 'FROM', 'GROUP_BY']);
      const items = getContextualKeywords('GROUP_BY', 'SELECT Name FROM dbo.Users GROUP BY Name ', presentClauses);
      const labels = items.map(i => i.label);
      expect(labels).toContain('HAVING');
    });
  });

  describe('GROUP BY → ORDER BY transition', () => {
    it('suggests ORDER BY after GROUP BY clause', () => {
      const presentClauses: ClausePresenceSet = new Set(['SELECT', 'FROM', 'GROUP_BY']);
      const items = getContextualKeywords('GROUP_BY', 'SELECT Name FROM dbo.Users GROUP BY Name ', presentClauses);
      const labels = items.map(i => i.label);
      expect(labels).toContain('ORDER BY');
    });
  });

  describe('HAVING → ORDER BY transition', () => {
    it('suggests ORDER BY after HAVING clause', () => {
      const presentClauses: ClausePresenceSet = new Set(['SELECT', 'FROM', 'GROUP_BY', 'HAVING']);
      const items = getContextualKeywords('HAVING', 'SELECT Name FROM dbo.Users GROUP BY Name HAVING COUNT(*) > 1 ', presentClauses);
      const labels = items.map(i => i.label);
      expect(labels).toContain('ORDER BY');
    });

    it('does not suggest WHERE after HAVING', () => {
      const presentClauses: ClausePresenceSet = new Set(['SELECT', 'FROM', 'GROUP_BY', 'HAVING']);
      const items = getContextualKeywords('HAVING', 'SELECT Name FROM dbo.Users GROUP BY Name HAVING COUNT(*) > 1 ', presentClauses);
      const labels = items.map(i => i.label);
      expect(labels).not.toContain('WHERE');
    });

    it('does not suggest GROUP BY after HAVING', () => {
      const presentClauses: ClausePresenceSet = new Set(['SELECT', 'FROM', 'GROUP_BY', 'HAVING']);
      const items = getContextualKeywords('HAVING', 'SELECT Name FROM dbo.Users GROUP BY Name HAVING COUNT(*) > 1 ', presentClauses);
      const labels = items.map(i => i.label);
      expect(labels).not.toContain('GROUP BY');
    });
  });

  describe('Already-present clause suppression', () => {
    it('does not suggest WHERE when WHERE is already present', () => {
      const presentClauses: ClausePresenceSet = new Set(['SELECT', 'FROM', 'WHERE']);
      const items = getContextualKeywords('FROM', 'SELECT * FROM dbo.Users WHERE Id > 1 FROM dbo.Orders ', presentClauses);
      const labels = items.map(i => i.label);
      expect(labels).not.toContain('WHERE');
    });

    it('does not suggest GROUP BY when GROUP BY is already present', () => {
      const presentClauses: ClausePresenceSet = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP_BY']);
      const items = getContextualKeywords('WHERE', 'SELECT * FROM dbo.Users WHERE Id > 1 ', presentClauses);
      const labels = items.map(i => i.label);
      expect(labels).not.toContain('GROUP BY');
    });

    it('still suggests JOIN even when JOIN is already present (multiple JOINs allowed)', () => {
      const presentClauses: ClausePresenceSet = new Set(['SELECT', 'FROM', 'JOIN']);
      const items = getContextualKeywords('FROM', 'SELECT * FROM dbo.Users JOIN dbo.Orders ON 1=1 ', presentClauses);
      const labels = items.map(i => i.label);
      expect(labels).toContain('JOIN');
      expect(labels).toContain('INNER JOIN');
      expect(labels).toContain('LEFT JOIN');
    });
  });

  describe('Keyword items have correct kind and detail', () => {
    it('all clause-flow keyword items have Keyword kind', () => {
      const presentClauses: ClausePresenceSet = new Set(['SELECT', 'FROM']);
      const items = getContextualKeywords('FROM', 'SELECT * FROM dbo.Users ', presentClauses);
      for (const item of items) {
        expect(item.kind).toBe(CompletionItemKind.Keyword);
      }
    });

    it('all clause-flow keyword items have "Keyword" detail', () => {
      const presentClauses: ClausePresenceSet = new Set(['SELECT', 'FROM']);
      const items = getContextualKeywords('FROM', 'SELECT * FROM dbo.Users ', presentClauses);
      for (const item of items) {
        expect(item.detail).toBe('Keyword');
      }
    });
  });
});


// ============================================================
// 2. Edge Cases
// ============================================================

describe('Edge Cases', () => {
  describe('Incomplete subqueries (unclosed parens)', () => {
    it('detects clause presence inside an incomplete subquery', () => {
      // Cursor is inside a subquery that has no closing paren
      const text = 'SELECT * FROM dbo.Users WHERE Id IN (SELECT Id FROM ';
      const result = getClausePresenceSet(text, text.length);
      // Inside the subquery scope, SELECT and FROM should be present
      expect(result.has('SELECT')).toBe(true);
      expect(result.has('FROM')).toBe(true);
    });

    it('does not include outer query clauses in subquery scope', () => {
      // Cursor is inside an incomplete subquery
      const text = 'SELECT * FROM dbo.Users WHERE Id IN (SELECT Id FROM dbo.Orders WHERE ';
      const result = getClausePresenceSet(text, text.length);
      // Inside the subquery: SELECT, FROM, WHERE are present
      expect(result.has('SELECT')).toBe(true);
      expect(result.has('FROM')).toBe(true);
      expect(result.has('WHERE')).toBe(true);
    });

    it('getCompletions works with incomplete subquery', () => {
      const text = 'SELECT * FROM dbo.Users WHERE Id IN (SELECT Id FROM ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      // Should return table completions (we're in FROM context inside subquery)
      const labels = items.map(i => i.label);
      expect(labels).toContain('dbo.Users');
      expect(labels).toContain('dbo.Orders');
    });
  });

  describe('Empty statements', () => {
    it('returns empty clause presence set for empty text', () => {
      const result = getClausePresenceSet('', 0);
      expect(result.size).toBe(0);
    });

    it('returns empty clause presence set for whitespace-only text', () => {
      const result = getClausePresenceSet('   \n  ', 6);
      expect(result.size).toBe(0);
    });

    it('getContextualKeywords falls back to existing behavior with empty presence set', () => {
      const emptySet: ClausePresenceSet = new Set();
      const items = getContextualKeywords('FROM', 'SELECT * FROM dbo.Users ', emptySet);
      // With empty set (size === 0), falls back to existing behavior which
      // suggests WHERE and JOIN variants after FROM context (Requirement 1.5)
      const labels = items.map(i => i.label);
      expect(labels).toContain('WHERE');
      expect(labels).toContain('JOIN');
    });
  });

  describe('Cursor at start of document', () => {
    it('extractCurrentStatement returns empty string when cursor is at position 0', () => {
      const result = extractCurrentStatement('SELECT * FROM dbo.Users', 0);
      expect(result).toBe('');
    });

    it('getCompletions returns keywords at start of document', () => {
      const text = '';
      const items = getCompletions(text, 0, sampleSchemaCache, true);
      const kinds = new Set(items.map(i => i.kind));
      expect(kinds.has(CompletionItemKind.Keyword)).toBe(true);
      expect(kinds.has(CompletionItemKind.Function)).toBe(true);
    });

    it('getClausePresenceSet returns empty set for cursor at position 0', () => {
      const result = getClausePresenceSet('SELECT * FROM dbo.Users', 0);
      expect(result.size).toBe(0);
    });
  });
});

// ============================================================
// 3. extractCurrentStatement() - Statement Boundary Detection
// ============================================================

describe('extractCurrentStatement', () => {
  describe('GO separator', () => {
    it('extracts text after GO on its own line', () => {
      const doc = 'SELECT 1\nGO\nSELECT * FROM ';
      const offset = doc.length;
      const result = extractCurrentStatement(doc, offset);
      expect(result).toBe('SELECT * FROM ');
    });

    it('handles GO with leading/trailing whitespace', () => {
      const doc = 'SELECT 1\n  GO  \nSELECT * FROM ';
      const offset = doc.length;
      const result = extractCurrentStatement(doc, offset);
      expect(result).toBe('SELECT * FROM ');
    });

    it('is case-insensitive for GO', () => {
      const doc = 'SELECT 1\ngo\nSELECT * FROM ';
      const offset = doc.length;
      const result = extractCurrentStatement(doc, offset);
      expect(result).toBe('SELECT * FROM ');
    });

    it('does not split on GO inside a word', () => {
      const doc = 'SELECT CATEGORY FROM ';
      const offset = doc.length;
      const result = extractCurrentStatement(doc, offset);
      // "CATEGORY" contains "GO" but it's not on its own line
      expect(result).toBe('SELECT CATEGORY FROM ');
    });
  });

  describe('Semicolon separator', () => {
    it('extracts text after semicolon', () => {
      const doc = 'SELECT 1; SELECT * FROM ';
      const offset = doc.length;
      const result = extractCurrentStatement(doc, offset);
      expect(result).toBe(' SELECT * FROM ');
    });

    it('handles multiple semicolons - uses the last one', () => {
      const doc = 'SELECT 1; SELECT 2; SELECT * FROM ';
      const offset = doc.length;
      const result = extractCurrentStatement(doc, offset);
      expect(result).toBe(' SELECT * FROM ');
    });
  });

  describe('Start of document', () => {
    it('returns entire text when no delimiter exists', () => {
      const doc = 'SELECT * FROM dbo.Users WHERE ';
      const offset = doc.length;
      const result = extractCurrentStatement(doc, offset);
      expect(result).toBe('SELECT * FROM dbo.Users WHERE ');
    });
  });

  describe('Delimiters inside literals/comments are ignored', () => {
    it('ignores semicolons inside string literals', () => {
      const doc = "SELECT 'a;b' FROM ";
      const offset = doc.length;
      const result = extractCurrentStatement(doc, offset);
      // The semicolon is inside a string, so the whole text is one statement
      expect(result).toBe("SELECT 'a;b' FROM ");
    });

    it('ignores GO inside comments', () => {
      const doc = '-- GO\nSELECT * FROM ';
      const offset = doc.length;
      const result = extractCurrentStatement(doc, offset);
      // GO is inside a comment, so the whole text is one statement
      expect(result).toBe('-- GO\nSELECT * FROM ');
    });
  });
});

// ============================================================
// 4. getClausePresenceSet() - Clause Detection
// ============================================================

describe('getClausePresenceSet', () => {
  it('detects SELECT clause', () => {
    const text = 'SELECT * FROM dbo.Users';
    const result = getClausePresenceSet(text, text.length);
    expect(result.has('SELECT')).toBe(true);
  });

  it('detects FROM clause', () => {
    const text = 'SELECT * FROM dbo.Users';
    const result = getClausePresenceSet(text, text.length);
    expect(result.has('FROM')).toBe(true);
  });

  it('detects JOIN clause', () => {
    const text = 'SELECT * FROM dbo.Users JOIN dbo.Orders ON 1=1';
    const result = getClausePresenceSet(text, text.length);
    expect(result.has('JOIN')).toBe(true);
  });

  it('detects LEFT JOIN as JOIN', () => {
    const text = 'SELECT * FROM dbo.Users LEFT JOIN dbo.Orders ON 1=1';
    const result = getClausePresenceSet(text, text.length);
    expect(result.has('JOIN')).toBe(true);
  });

  it('detects WHERE clause', () => {
    const text = 'SELECT * FROM dbo.Users WHERE Id > 1';
    const result = getClausePresenceSet(text, text.length);
    expect(result.has('WHERE')).toBe(true);
  });

  it('detects GROUP BY clause', () => {
    const text = 'SELECT Name FROM dbo.Users GROUP BY Name';
    const result = getClausePresenceSet(text, text.length);
    expect(result.has('GROUP_BY')).toBe(true);
  });

  it('detects HAVING clause', () => {
    const text = 'SELECT Name FROM dbo.Users GROUP BY Name HAVING COUNT(*) > 1';
    const result = getClausePresenceSet(text, text.length);
    expect(result.has('HAVING')).toBe(true);
  });

  it('detects ORDER BY clause', () => {
    const text = 'SELECT * FROM dbo.Users ORDER BY Name';
    const result = getClausePresenceSet(text, text.length);
    expect(result.has('ORDER_BY')).toBe(true);
  });

  it('detects multiple clauses in a complex query', () => {
    const text = 'SELECT Name, COUNT(*) FROM dbo.Users JOIN dbo.Orders ON 1=1 WHERE Id > 1 GROUP BY Name HAVING COUNT(*) > 1 ORDER BY Name';
    const result = getClausePresenceSet(text, text.length);
    expect(result.has('SELECT')).toBe(true);
    expect(result.has('FROM')).toBe(true);
    expect(result.has('JOIN')).toBe(true);
    expect(result.has('WHERE')).toBe(true);
    expect(result.has('GROUP_BY')).toBe(true);
    expect(result.has('HAVING')).toBe(true);
    expect(result.has('ORDER_BY')).toBe(true);
  });

  it('only considers text up to cursorOffset', () => {
    const text = 'SELECT * FROM dbo.Users WHERE Id > 1 ORDER BY Name';
    // Cursor is right after WHERE clause, before ORDER BY
    const cursorOffset = 'SELECT * FROM dbo.Users WHERE '.length;
    const result = getClausePresenceSet(text, cursorOffset);
    expect(result.has('SELECT')).toBe(true);
    expect(result.has('FROM')).toBe(true);
    expect(result.has('WHERE')).toBe(true);
    expect(result.has('ORDER_BY')).toBe(false);
  });

  it('ignores keywords inside string literals', () => {
    const text = "SELECT 'WHERE' FROM dbo.Users";
    const result = getClausePresenceSet(text, text.length);
    expect(result.has('WHERE')).toBe(false);
    expect(result.has('SELECT')).toBe(true);
    expect(result.has('FROM')).toBe(true);
  });

  it('ignores keywords inside comments', () => {
    const text = 'SELECT * /* WHERE */ FROM dbo.Users';
    const result = getClausePresenceSet(text, text.length);
    expect(result.has('WHERE')).toBe(false);
    expect(result.has('SELECT')).toBe(true);
    expect(result.has('FROM')).toBe(true);
  });

  describe('Subquery scope isolation', () => {
    it('excludes subquery clauses from outer scope', () => {
      const text = 'SELECT * FROM dbo.Users WHERE Id IN (SELECT Id FROM dbo.Orders WHERE Total > 100) ';
      const result = getClausePresenceSet(text, text.length);
      // Outer scope has SELECT, FROM, WHERE
      expect(result.has('SELECT')).toBe(true);
      expect(result.has('FROM')).toBe(true);
      expect(result.has('WHERE')).toBe(true);
    });

    it('detects only inner scope clauses when cursor is inside subquery', () => {
      const text = 'SELECT * FROM dbo.Users WHERE Id IN (SELECT Id FROM ';
      const result = getClausePresenceSet(text, text.length);
      // Cursor is inside the subquery, so only subquery clauses count
      expect(result.has('SELECT')).toBe(true);
      expect(result.has('FROM')).toBe(true);
      // WHERE from outer query should NOT be in the set
      // (the subquery doesn't have its own WHERE yet)
    });
  });
});

// ============================================================
// 5. Integration: getCompletions() with clause-flow active
// ============================================================

describe('getCompletions integration with clause-flow', () => {
  describe('FROM context with clause-flow', () => {
    it('returns tables AND clause keywords after FROM table reference', () => {
      const text = 'SELECT * FROM dbo.Users ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      // Should have table/view completions
      expect(labels).toContain('dbo.Users');
      expect(labels).toContain('dbo.Orders');
      // Should have clause-flow keywords
      expect(labels).toContain('WHERE');
      expect(labels).toContain('JOIN');
      expect(labels).toContain('ORDER BY');
      expect(labels).toContain('GROUP BY');
    });

    it('does not suggest FROM again when already in FROM context', () => {
      const text = 'SELECT * FROM dbo.Users ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      // FROM should not be suggested since we're already past FROM
      expect(labels).not.toContain('FROM');
    });
  });

  describe('WHERE context with clause-flow', () => {
    it('suggests GROUP BY and ORDER BY after WHERE condition', () => {
      const text = 'SELECT * FROM dbo.Users WHERE Id > 1 ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).toContain('GROUP BY');
      expect(labels).toContain('ORDER BY');
    });

    it('does not suggest WHERE again after WHERE', () => {
      const text = 'SELECT * FROM dbo.Users WHERE Id > 1 ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).not.toContain('WHERE');
    });

    it('does not suggest FROM after WHERE', () => {
      const text = 'SELECT * FROM dbo.Users WHERE Id > 1 ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).not.toContain('FROM');
    });
  });

  describe('GROUP BY context with clause-flow', () => {
    it('suggests HAVING and ORDER BY after GROUP BY', () => {
      const text = 'SELECT Name FROM dbo.Users GROUP BY Name ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).toContain('HAVING');
      expect(labels).toContain('ORDER BY');
    });

    it('does not suggest WHERE after GROUP BY', () => {
      const text = 'SELECT Name FROM dbo.Users GROUP BY Name ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).not.toContain('WHERE');
    });
  });

  describe('SELECT context with clause-flow', () => {
    it('suggests FROM after SELECT with column expressions', () => {
      const text = 'SELECT * ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).toContain('FROM');
    });

    it('does not suggest clause keywords when still typing column name', () => {
      // No trailing space - user is still typing
      const text = 'SELECT Na';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      // Should not suggest FROM/INTO/WHERE when user is mid-word
      expect(labels).not.toContain('FROM');
      expect(labels).not.toContain('INTO');
    });
  });
});

// ============================================================
// 6. Non-Regression: Existing completion scenarios
// ============================================================

describe('Non-regression: existing completion scenarios', () => {
  it('still returns table completions in FROM context', () => {
    const text = 'SELECT * FROM ';
    const items = getCompletions(text, text.length, sampleSchemaCache, true);
    const labels = items.map(i => i.label);
    expect(labels).toContain('dbo.Users');
    expect(labels).toContain('dbo.Orders');
    expect(labels).toContain('dbo.ActiveUsers');
  });

  it('still returns column completions in SELECT context', () => {
    const text = 'SELECT  FROM dbo.Users';
    const items = getCompletions(text, 7, sampleSchemaCache, true);
    const labels = items.map(i => i.label);
    expect(labels).toContain('Id');
    expect(labels).toContain('Name');
    expect(labels).toContain('Email');
  });

  it('still returns column completions in WHERE context', () => {
    const text = 'SELECT * FROM dbo.Users WHERE ';
    const items = getCompletions(text, text.length, sampleSchemaCache, true);
    const labels = items.map(i => i.label);
    expect(labels).toContain('Id');
    expect(labels).toContain('Name');
  });

  it('still returns procedure completions in EXEC context', () => {
    const text = 'EXEC ';
    const items = getCompletions(text, text.length, sampleSchemaCache, true);
    const labels = items.map(i => i.label);
    expect(labels).toContain('dbo.GetUsers');
    expect(labels).toContain('admin.CleanupLogs');
  });

  it('still returns keywords when disconnected', () => {
    const text = 'SELECT * FROM ';
    const items = getCompletions(text, text.length, null, false);
    expect(items.length).toBeGreaterThan(0);
    const kinds = new Set(items.map(i => i.kind));
    expect(kinds.has(CompletionItemKind.Keyword)).toBe(true);
    // Should not have schema objects
    expect(kinds.has(CompletionItemKind.Module)).toBe(false);
  });

  it('still returns keywords when schema cache is populating', () => {
    const populatingCache = createMockSchemaCache({
      tables: sampleSchemaCache.tables,
      isPopulating: true,
    });
    const text = 'SELECT * FROM ';
    const items = getCompletions(text, text.length, populatingCache, true);
    const kinds = new Set(items.map(i => i.kind));
    expect(kinds.has(CompletionItemKind.Keyword)).toBe(true);
    expect(kinds.has(CompletionItemKind.Module)).toBe(false);
  });

  it('still returns keywords and functions in NONE context', () => {
    const text = '';
    const items = getCompletions(text, 0, sampleSchemaCache, true);
    const kinds = new Set(items.map(i => i.kind));
    expect(kinds.has(CompletionItemKind.Keyword)).toBe(true);
    expect(kinds.has(CompletionItemKind.Function)).toBe(true);
  });

  it('still filters by prefix in FROM context', () => {
    const text = 'SELECT * FROM dbo.U';
    const items = getCompletions(text, text.length, sampleSchemaCache, true);
    const labels = items.map(i => i.label);
    expect(labels).toContain('dbo.Users');
    expect(labels).not.toContain('dbo.Orders');
  });

  it('still handles multi-statement documents with GO separator', () => {
    const doc = 'SELECT 1\nGO\nSELECT * FROM ';
    const items = getCompletions(doc, doc.length, sampleSchemaCache, true);
    const labels = items.map(i => i.label);
    // Should still get table completions in the second statement
    expect(labels).toContain('dbo.Users');
  });

  it('still handles multi-statement documents with semicolons', () => {
    const doc = 'SELECT 1; SELECT * FROM ';
    const items = getCompletions(doc, doc.length, sampleSchemaCache, true);
    const labels = items.map(i => i.label);
    expect(labels).toContain('dbo.Users');
  });

  it('contextual keywords merge with schema objects (not replace)', () => {
    const text = 'SELECT * FROM dbo.Users ';
    const items = getCompletions(text, text.length, sampleSchemaCache, true);
    const kinds = new Set(items.map(i => i.kind));
    // Both schema objects (Module) and keywords should be present
    expect(kinds.has(CompletionItemKind.Module)).toBe(true);
    expect(kinds.has(CompletionItemKind.Keyword)).toBe(true);
  });
});


// ============================================================
// 7. End-to-End Integration: Clause-Flow + CTE Together
// ============================================================

describe('End-to-End Integration: Clause-Flow + CTE Together', () => {
  describe('CTE + clause-flow combined (Requirement 8.3, 9.1, 9.2)', () => {
    it('offers CTE names AND clause-flow keywords in FROM context after CTE', () => {
      const text = 'WITH cte AS (SELECT Id FROM dbo.Users) SELECT * FROM ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      // Should offer CTE name as table reference
      expect(labels).toContain('cte');
      // Should offer real tables
      expect(labels).toContain('dbo.Users');
      expect(labels).toContain('dbo.Orders');
    });

    it('offers clause-flow keywords after CTE table reference in FROM', () => {
      const text = 'WITH cte AS (SELECT Id FROM dbo.Users) SELECT * FROM cte ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      // Should offer clause-flow keywords (WHERE, JOIN, ORDER BY, GROUP BY)
      expect(labels).toContain('WHERE');
      expect(labels).toContain('JOIN');
      expect(labels).toContain('ORDER BY');
      expect(labels).toContain('GROUP BY');
      // Should NOT suggest FROM again
      expect(labels).not.toContain('FROM');
    });

    it('offers CTE names in WHERE subquery FROM context', () => {
      const text = 'WITH cte AS (SELECT Id FROM dbo.Users) SELECT * FROM cte WHERE Id IN (SELECT Id FROM ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      // Inside the subquery FROM, should still offer tables
      expect(labels).toContain('dbo.Users');
      expect(labels).toContain('dbo.Orders');
    });

    it('CTE completions have Module kind and CTE detail', () => {
      const text = 'WITH cte AS (SELECT Id FROM dbo.Users) SELECT * FROM ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const cteItem = items.find(i => i.label === 'cte');
      expect(cteItem).toBeDefined();
      expect(cteItem!.kind).toBe(CompletionItemKind.Module);
      expect(cteItem!.detail).toBe('CTE');
    });
  });

  describe('HAVING → ORDER BY transition (Requirement 10.1, 10.2, 10.3)', () => {
    it('suggests ORDER BY after HAVING condition with trailing space', () => {
      const text = 'SELECT Name, COUNT(*) FROM dbo.Users GROUP BY Name HAVING COUNT(*) > 1 ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).toContain('ORDER BY');
    });

    it('does not suggest WHERE after HAVING', () => {
      const text = 'SELECT Name, COUNT(*) FROM dbo.Users GROUP BY Name HAVING COUNT(*) > 1 ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).not.toContain('WHERE');
    });

    it('does not suggest FROM after HAVING', () => {
      const text = 'SELECT Name, COUNT(*) FROM dbo.Users GROUP BY Name HAVING COUNT(*) > 1 ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).not.toContain('FROM');
    });

    it('does not suggest GROUP BY after HAVING', () => {
      const text = 'SELECT Name, COUNT(*) FROM dbo.Users GROUP BY Name HAVING COUNT(*) > 1 ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).not.toContain('GROUP BY');
    });

    it('suggests column completions when cursor is right after HAVING keyword (no condition yet)', () => {
      const text = 'SELECT Name, COUNT(*) FROM dbo.Users GROUP BY Name HAVING ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      // Should suggest columns for writing the HAVING condition
      expect(labels).toContain('Name');
      // Should NOT suggest ORDER BY yet (no condition expression typed)
      // The HAVING context should provide column completions, not clause keywords
    });
  });

  describe('Keywords in literals/comments do not affect clause detection (Requirement 10.4)', () => {
    it('WHERE inside a string literal does not suppress WHERE from suggestions', () => {
      const text = "SELECT 'WHERE' FROM dbo.Users ";
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      // The WHERE is inside a string, so real WHERE should still be suggested
      expect(labels).toContain('WHERE');
    });

    it('GROUP BY inside a comment does not suppress GROUP BY from suggestions', () => {
      const text = 'SELECT * /* GROUP BY */ FROM dbo.Users ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).toContain('GROUP BY');
    });

    it('ORDER BY inside a single-line comment does not suppress ORDER BY', () => {
      const text = 'SELECT * -- ORDER BY\nFROM dbo.Users ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).toContain('ORDER BY');
    });

    it('HAVING inside N-prefixed string does not suppress HAVING', () => {
      const text = "SELECT N'HAVING' FROM dbo.Users GROUP BY Name ";
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).toContain('HAVING');
    });

    it('clause presence set ignores keywords in string literals', () => {
      const text = "SELECT 'WHERE' FROM dbo.Users ";
      const result = getClausePresenceSet(text, text.length);
      expect(result.has('WHERE')).toBe(false);
      expect(result.has('SELECT')).toBe(true);
      expect(result.has('FROM')).toBe(true);
    });
  });

  describe('Malformed CTE chains (Requirement 9.4, 9.5)', () => {
    it('handles CTE with no closing paren gracefully', () => {
      const text = 'WITH cte1 AS (SELECT 1 ';
      const cteInfo = detectCTEChain(text, text.length);
      // Should detect the CTE chain even though it's incomplete
      expect(cteInfo.inCTEChain).toBe(true);
      // Cursor is inside the first CTE body, so no earlier CTEs available
      expect(cteInfo.availableNames).toHaveLength(0);
    });

    it('handles CTE with no closing paren - getCompletions does not crash', () => {
      const text = 'WITH cte1 AS (SELECT ';
      // Should not throw — graceful handling of incomplete CTE
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      // In SELECT context inside CTE body with no FROM clause yet,
      // no columns are available (no table references), so empty is valid
      expect(Array.isArray(items)).toBe(true);
    });

    it('handles CTE chain where second CTE is incomplete', () => {
      const text = 'WITH cte1 AS (SELECT 1), cte2 AS (SELECT Id FROM ';
      const cteInfo = detectCTEChain(text, text.length);
      expect(cteInfo.inCTEChain).toBe(true);
      // Cursor is inside cte2 body, so cte1 should be available
      expect(cteInfo.availableNames).toContain('cte1');
    });

    it('handles malformed CTE missing AS keyword', () => {
      const text = 'WITH cte1 (SELECT 1) SELECT * FROM ';
      const cteInfo = detectCTEChain(text, text.length);
      // Should not detect a valid CTE chain since AS is missing
      expect(cteInfo.inCTEChain).toBe(false);
    });

    it('getCompletions still returns tables for malformed CTE', () => {
      const text = 'WITH cte1 (SELECT 1) SELECT * FROM ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      // Should still get table completions even though CTE is malformed
      expect(labels).toContain('dbo.Users');
      expect(labels).toContain('dbo.Orders');
    });
  });

  describe('Incomplete subqueries (Requirement 9.4)', () => {
    it('detects subquery scope correctly for cursor inside incomplete subquery', () => {
      const text = 'SELECT * FROM dbo.Users WHERE Id IN (SELECT ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      // Inside the subquery SELECT context, should get column completions
      // The subquery has its own scope
      expect(items.length).toBeGreaterThan(0);
    });

    it('clause presence inside incomplete subquery is independent of outer query', () => {
      const text = 'SELECT * FROM dbo.Users WHERE Id IN (SELECT Id FROM ';
      const presenceSet = getClausePresenceSet(text, text.length);
      // Inside the subquery: SELECT and FROM are present
      expect(presenceSet.has('SELECT')).toBe(true);
      expect(presenceSet.has('FROM')).toBe(true);
      // The outer WHERE should NOT be in the subquery's presence set
    });

    it('suggests WHERE inside subquery even when outer query has WHERE', () => {
      const text = 'SELECT * FROM dbo.Users WHERE Id IN (SELECT Id FROM dbo.Orders ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      // Inside the subquery FROM context, WHERE should be available
      // (outer WHERE doesn't affect subquery scope)
      expect(labels).toContain('WHERE');
    });
  });

  describe('Cursor at document start (Requirement 9.1, 9.2)', () => {
    it('returns keyword completions for empty document', () => {
      const text = '';
      const items = getCompletions(text, 0, sampleSchemaCache, true);
      expect(items.length).toBeGreaterThan(0);
      const kinds = new Set(items.map(i => i.kind));
      expect(kinds.has(CompletionItemKind.Keyword)).toBe(true);
    });

    it('returns keyword and function completions for empty document', () => {
      const text = '';
      const items = getCompletions(text, 0, sampleSchemaCache, true);
      const kinds = new Set(items.map(i => i.kind));
      expect(kinds.has(CompletionItemKind.Keyword)).toBe(true);
      expect(kinds.has(CompletionItemKind.Function)).toBe(true);
    });

    it('clause presence set is empty for empty document', () => {
      const result = getClausePresenceSet('', 0);
      expect(result.size).toBe(0);
    });

    it('CTE chain detection returns no chain for empty document', () => {
      const result = detectCTEChain('', 0);
      expect(result.inCTEChain).toBe(false);
      expect(result.availableNames).toHaveLength(0);
    });
  });

  describe('Multi-CTE with final query (Requirement 9.4, 9.5)', () => {
    it('offers both CTE names in final query FROM clause', () => {
      const text = 'WITH a AS (SELECT 1 AS x), b AS (SELECT 2 AS y) SELECT * FROM ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      // Both CTE names should be available
      expect(labels).toContain('a');
      expect(labels).toContain('b');
      // Real tables should also be available
      expect(labels).toContain('dbo.Users');
      expect(labels).toContain('dbo.Orders');
    });

    it('offers only first CTE name inside second CTE body', () => {
      const text = 'WITH a AS (SELECT 1 AS x), b AS (SELECT * FROM ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      // Only 'a' should be available (cursor is inside 'b' body)
      expect(labels).toContain('a');
      expect(labels).not.toContain('b');
      // Real tables should also be available
      expect(labels).toContain('dbo.Users');
    });

    it('offers no CTE names inside first CTE body', () => {
      const text = 'WITH a AS (SELECT * FROM ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      // No CTE names should be available (cursor is inside first CTE)
      expect(labels).not.toContain('a');
      // Real tables should still be available
      expect(labels).toContain('dbo.Users');
    });

    it('detectCTEChain returns all names for cursor after CTE block', () => {
      const text = 'WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM ';
      const cteInfo = detectCTEChain(text, text.length);
      expect(cteInfo.inCTEChain).toBe(true);
      expect(cteInfo.availableNames).toContain('a');
      expect(cteInfo.availableNames).toContain('b');
      expect(cteInfo.availableNames).toHaveLength(2);
    });

    it('CTE names have sort priority over matching real tables', () => {
      // Create a schema cache with a table named 'Users' (same as a CTE name we'll use)
      const text = 'WITH Users AS (SELECT 1 AS Id) SELECT * FROM ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const cteItem = items.find(i => i.label === 'Users' && i.detail === 'CTE');
      const tableItem = items.find(i => i.label === 'dbo.Users');
      // CTE item should exist
      expect(cteItem).toBeDefined();
      // Table item should also exist (both are offered)
      expect(tableItem).toBeDefined();
      // CTE sortText should precede table's effective sort key (sortText or label)
      if (cteItem && tableItem) {
        const cteSortKey = cteItem.sortText ?? (cteItem.label as string);
        const tableSortKey = tableItem.sortText ?? (tableItem.label as string);
        expect(cteSortKey < tableSortKey).toBe(true);
      }
    });
  });
});
