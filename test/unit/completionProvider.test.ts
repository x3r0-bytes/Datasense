import { describe, it, expect } from 'vitest';
import { detectContext, detectJoinContext, extractTableReferences, getCompletions } from '../../server/src/completionProvider';
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

describe('detectContext', () => {
  it('returns NONE for empty text', () => {
    expect(detectContext('')).toBe('NONE');
  });

  it('returns SELECT when cursor is after SELECT keyword', () => {
    expect(detectContext('SELECT ')).toBe('SELECT');
  });

  it('returns FROM when cursor is after FROM keyword', () => {
    expect(detectContext('SELECT col1 FROM ')).toBe('FROM');
  });

  it('returns JOIN when cursor is after JOIN keyword', () => {
    expect(detectContext('SELECT col1 FROM dbo.Users u JOIN ')).toBe('JOIN');
  });

  it('returns JOIN for LEFT JOIN', () => {
    expect(detectContext('SELECT col1 FROM dbo.Users u LEFT JOIN ')).toBe('JOIN');
  });

  it('returns JOIN for LEFT OUTER JOIN', () => {
    expect(detectContext('SELECT col1 FROM dbo.Users u LEFT OUTER JOIN ')).toBe('JOIN');
  });

  it('returns WHERE when cursor is after WHERE keyword', () => {
    expect(detectContext('SELECT col1 FROM dbo.Users WHERE ')).toBe('WHERE');
  });

  it('returns ORDER_BY when cursor is after ORDER BY', () => {
    expect(detectContext('SELECT col1 FROM dbo.Users ORDER BY ')).toBe('ORDER_BY');
  });

  it('returns GROUP_BY when cursor is after GROUP BY', () => {
    expect(detectContext('SELECT col1 FROM dbo.Users GROUP BY ')).toBe('GROUP_BY');
  });

  it('returns EXEC when cursor is after EXEC keyword', () => {
    expect(detectContext('EXEC ')).toBe('EXEC');
  });

  it('returns EXEC when cursor is after EXECUTE keyword', () => {
    expect(detectContext('EXECUTE ')).toBe('EXEC');
  });

  it('is case-insensitive', () => {
    expect(detectContext('select col from ')).toBe('FROM');
    expect(detectContext('SELECT col FROM dbo.T where ')).toBe('WHERE');
    expect(detectContext('Order By ')).toBe('ORDER_BY');
  });

  it('returns the most recent context', () => {
    // After FROM, then WHERE - should be WHERE
    expect(detectContext('SELECT col FROM dbo.Users WHERE col1 = 1 ORDER BY ')).toBe('ORDER_BY');
  });

  it('ignores keywords inside string literals', () => {
    expect(detectContext("SELECT 'FROM' FROM ")).toBe('FROM');
  });

  it('ignores keywords inside single-line comments', () => {
    expect(detectContext('SELECT col -- FROM comment\nFROM ')).toBe('FROM');
  });

  it('ignores keywords inside multi-line comments', () => {
    expect(detectContext('SELECT col /* WHERE */ FROM ')).toBe('FROM');
  });

  it('handles CROSS JOIN', () => {
    expect(detectContext('SELECT * FROM dbo.A CROSS JOIN ')).toBe('JOIN');
  });

  it('handles INNER JOIN', () => {
    expect(detectContext('SELECT * FROM dbo.A INNER JOIN ')).toBe('JOIN');
  });

  it('returns NONE for non-SQL text', () => {
    expect(detectContext('hello world')).toBe('NONE');
  });
});

describe('extractTableReferences', () => {
  it('returns empty array for text with no FROM/JOIN', () => {
    expect(extractTableReferences('SELECT 1')).toEqual([]);
  });

  it('extracts a simple table name from FROM', () => {
    const refs = extractTableReferences('SELECT * FROM Users');
    expect(refs).toEqual([{ name: 'Users', alias: undefined, schema: undefined }]);
  });

  it('extracts schema.table from FROM', () => {
    const refs = extractTableReferences('SELECT * FROM dbo.Users');
    expect(refs).toEqual([{ schema: 'dbo', name: 'Users', alias: undefined }]);
  });

  it('extracts table with alias', () => {
    const refs = extractTableReferences('SELECT * FROM dbo.Users u');
    expect(refs).toEqual([{ schema: 'dbo', name: 'Users', alias: 'u' }]);
  });

  it('extracts table with AS alias', () => {
    const refs = extractTableReferences('SELECT * FROM dbo.Users AS u');
    expect(refs).toEqual([{ schema: 'dbo', name: 'Users', alias: 'u' }]);
  });

  it('extracts multiple tables from FROM with commas', () => {
    const refs = extractTableReferences('SELECT * FROM dbo.Users u, dbo.Orders o');
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({ schema: 'dbo', name: 'Users', alias: 'u' });
    expect(refs[1]).toEqual({ schema: 'dbo', name: 'Orders', alias: 'o' });
  });

  it('extracts table from JOIN clause', () => {
    const refs = extractTableReferences('SELECT * FROM dbo.Users u JOIN dbo.Orders o ON u.id = o.userId');
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({ schema: 'dbo', name: 'Users', alias: 'u' });
    expect(refs[1]).toEqual({ schema: 'dbo', name: 'Orders', alias: 'o' });
  });

  it('extracts table from LEFT JOIN clause', () => {
    const refs = extractTableReferences('SELECT * FROM dbo.Users u LEFT JOIN dbo.Orders o ON u.id = o.userId');
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({ schema: 'dbo', name: 'Users', alias: 'u' });
    expect(refs[1]).toEqual({ schema: 'dbo', name: 'Orders', alias: 'o' });
  });

  it('handles bracketed identifiers', () => {
    const refs = extractTableReferences('SELECT * FROM [dbo].[User Table]');
    expect(refs).toEqual([{ schema: 'dbo', name: 'User Table', alias: undefined }]);
  });

  it('handles temp tables', () => {
    const refs = extractTableReferences('SELECT * FROM #TempUsers');
    expect(refs).toEqual([{ name: '#TempUsers', alias: undefined, schema: undefined }]);
  });

  it('ignores table names inside string literals', () => {
    const refs = extractTableReferences("SELECT 'FROM dbo.Fake' FROM dbo.Real");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({ schema: 'dbo', name: 'Real', alias: undefined });
  });

  it('stops at WHERE keyword', () => {
    const refs = extractTableReferences('SELECT * FROM dbo.Users WHERE id = 1');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({ schema: 'dbo', name: 'Users', alias: undefined });
  });
});


describe('getCompletions', () => {
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

  describe('disconnected state', () => {
    it('returns keywords and built-in functions when disconnected', () => {
      const items = getCompletions('SELECT ', 7, null, false);
      expect(items.length).toBeGreaterThan(0);
      const kinds = new Set(items.map(i => i.kind));
      expect(kinds.has(CompletionItemKind.Keyword)).toBe(true);
      expect(kinds.has(CompletionItemKind.Function)).toBe(true);
      // Should not have table/column/procedure items
      expect(kinds.has(CompletionItemKind.Module)).toBe(false);
      expect(kinds.has(CompletionItemKind.Field)).toBe(false);
      expect(kinds.has(CompletionItemKind.Method)).toBe(false);
    });

    it('returns keywords when schema cache is null', () => {
      const items = getCompletions('SELECT ', 7, null, true);
      expect(items.length).toBeGreaterThan(0);
      expect(items.some(i => i.kind === CompletionItemKind.Keyword)).toBe(true);
    });
  });

  describe('schema cache populating', () => {
    it('returns keyword-only completions while schema cache is populating', () => {
      const populatingCache = createMockSchemaCache({
        tables: sampleSchemaCache.tables,
        isPopulating: true,
      });
      const items = getCompletions('SELECT * FROM ', 14, populatingCache, true);
      expect(items.length).toBeGreaterThan(0);
      const kinds = new Set(items.map(i => i.kind));
      expect(kinds.has(CompletionItemKind.Keyword)).toBe(true);
      expect(kinds.has(CompletionItemKind.Function)).toBe(true);
      // Should not have table items even though we're in FROM context
      expect(kinds.has(CompletionItemKind.Module)).toBe(false);
    });
  });

  describe('FROM/JOIN context', () => {
    it('returns table names with schema prefixes in FROM context', () => {
      const text = 'SELECT * FROM ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).toContain('dbo.Users');
      expect(labels).toContain('dbo.Orders');
    });

    it('returns view names with schema prefixes in FROM context', () => {
      const text = 'SELECT * FROM ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).toContain('dbo.ActiveUsers');
    });

    it('uses Module kind for tables and views', () => {
      const text = 'SELECT * FROM ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const tableAndViewItems = items.filter(item => item.kind === CompletionItemKind.Module);
      expect(tableAndViewItems.length).toBeGreaterThan(0);
      // Keyword items (from contextual keyword injection) use Keyword kind
      const keywordItems = items.filter(item => item.kind === CompletionItemKind.Keyword);
      for (const item of tableAndViewItems) {
        expect(item.kind).toBe(CompletionItemKind.Module);
      }
      // All items should be either Module (tables/views), Keyword (contextual keywords), or Snippet
      for (const item of items) {
        expect([CompletionItemKind.Module, CompletionItemKind.Keyword, CompletionItemKind.Snippet]).toContain(item.kind);
      }
    });

    it('returns tables and views in JOIN context', () => {
      const text = 'SELECT * FROM dbo.Users u JOIN ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).toContain('dbo.Users');
      expect(labels).toContain('dbo.Orders');
      expect(labels).toContain('dbo.ActiveUsers');
    });

    it('filters by prefix (case-insensitive)', () => {
      const text = 'SELECT * FROM dbo.u';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      // dbo.Users starts with "dbo.u" (case-insensitive)
      expect(labels).toContain('dbo.Users');
      // dbo.Orders does not start with "dbo.u"
      expect(labels).not.toContain('dbo.Orders');
    });
  });

  describe('SELECT/WHERE/ORDER BY/GROUP BY context', () => {
    it('returns columns from referenced tables in SELECT context', () => {
      const text = 'SELECT  FROM dbo.Users';
      // Cursor is at position 7 (after "SELECT ")
      const items = getCompletions(text, 7, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).toContain('Id');
      expect(labels).toContain('Name');
      expect(labels).toContain('Email');
    });

    it('returns columns from multiple referenced tables', () => {
      const text = 'SELECT  FROM dbo.Users u JOIN dbo.Orders o ON u.Id = o.UserId';
      const items = getCompletions(text, 7, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).toContain('Id');
      expect(labels).toContain('Name');
      expect(labels).toContain('OrderId');
      expect(labels).toContain('Total');
    });

    it('uses Field kind for columns', () => {
      const text = 'SELECT  FROM dbo.Users';
      const items = getCompletions(text, 7, sampleSchemaCache, true);
      const columnItems = items.filter(i => i.kind === CompletionItemKind.Field);
      expect(columnItems.length).toBeGreaterThan(0);
      // Aggregate function snippets (kind=Function) are also returned in SELECT context
      const functionItems = items.filter(i => i.kind === CompletionItemKind.Function);
      expect(functionItems.length).toBeGreaterThan(0);
    });

    it('includes data type and nullability in detail', () => {
      const text = 'SELECT  FROM dbo.Users';
      const items = getCompletions(text, 7, sampleSchemaCache, true);
      const idItem = items.find(i => i.label === 'Id');
      expect(idItem).toBeDefined();
      expect(idItem!.detail).toBe('int (not null)');

      const nameItem = items.find(i => i.label === 'Name');
      expect(nameItem).toBeDefined();
      expect(nameItem!.detail).toBe('nvarchar (nullable)');
    });

    it('returns columns in WHERE context', () => {
      const text = 'SELECT * FROM dbo.Users WHERE ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).toContain('Id');
      expect(labels).toContain('Name');
    });

    it('returns columns in ORDER BY context', () => {
      const text = 'SELECT * FROM dbo.Users ORDER BY ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).toContain('Id');
      expect(labels).toContain('Name');
    });

    it('returns columns in GROUP BY context', () => {
      const text = 'SELECT * FROM dbo.Users GROUP BY ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).toContain('Id');
      expect(labels).toContain('Name');
    });

    it('filters columns by prefix', () => {
      const text = 'SELECT N FROM dbo.Users';
      // Cursor at position 8 (after "SELECT N")
      const items = getCompletions(text, 8, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).toContain('Name');
      expect(labels).not.toContain('Id');
      expect(labels).not.toContain('Email');
    });
  });

  describe('EXEC context', () => {
    it('returns stored procedure names in EXEC context', () => {
      const text = 'EXEC ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).toContain('dbo.GetUsers');
      expect(labels).toContain('admin.CleanupLogs');
    });

    it('returns stored procedure names in EXECUTE context', () => {
      const text = 'EXECUTE ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).toContain('dbo.GetUsers');
      expect(labels).toContain('admin.CleanupLogs');
    });

    it('uses Method kind for procedures', () => {
      const text = 'EXEC ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      // Snippet items are also present in all contexts
      for (const item of items) {
        if (item.kind === CompletionItemKind.Snippet) continue;
        expect(item.kind).toBe(CompletionItemKind.Method);
      }
    });

    it('filters procedures by prefix', () => {
      const text = 'EXEC dbo.G';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).toContain('dbo.GetUsers');
      expect(labels).not.toContain('admin.CleanupLogs');
    });
  });

  describe('NONE context', () => {
    it('returns keywords and functions in NONE context', () => {
      const text = '';
      const items = getCompletions(text, 0, sampleSchemaCache, true);
      const kinds = new Set(items.map(i => i.kind));
      expect(kinds.has(CompletionItemKind.Keyword)).toBe(true);
      expect(kinds.has(CompletionItemKind.Function)).toBe(true);
    });

    it('uses Keyword kind for keywords', () => {
      const text = '';
      const items = getCompletions(text, 0, sampleSchemaCache, true);
      const selectItem = items.find(i => i.label === 'SELECT');
      expect(selectItem).toBeDefined();
      expect(selectItem!.kind).toBe(CompletionItemKind.Keyword);
    });

    it('uses Function kind for built-in functions', () => {
      const text = '';
      const items = getCompletions(text, 0, sampleSchemaCache, true);
      const isnullItem = items.find(i => i.label === 'ISNULL');
      expect(isnullItem).toBeDefined();
      expect(isnullItem!.kind).toBe(CompletionItemKind.Function);
    });

    it('filters keywords by prefix', () => {
      const text = 'SEL';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).toContain('SELECT');
      expect(labels).not.toContain('FROM');
      expect(labels).not.toContain('WHERE');
    });
  });

  describe('prefix filtering', () => {
    it('is case-insensitive', () => {
      const text = 'sel';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      const labels = items.map(i => i.label);
      expect(labels).toContain('SELECT');
    });

    it('returns all items when prefix is empty', () => {
      const text = 'EXEC ';
      const items = getCompletions(text, text.length, sampleSchemaCache, true);
      // 2 procedures + 5 snippets (all snippet prefixes match empty prefix)
      const procItems = items.filter(i => i.detail === 'Stored Procedure');
      expect(procItems.length).toBe(2); // Both procedures
    });
  });
});


describe('detectJoinContext', () => {
  describe('detects all JOIN keyword variants', () => {
    it('detects plain JOIN', () => {
      const result = detectJoinContext('SELECT * FROM Orders o JOIN ');
      expect(result).toEqual({ type: 'join', joinType: 'JOIN' });
    });

    it('detects INNER JOIN', () => {
      const result = detectJoinContext('SELECT * FROM Orders o INNER JOIN ');
      expect(result).toEqual({ type: 'join', joinType: 'INNER JOIN' });
    });

    it('detects LEFT JOIN', () => {
      const result = detectJoinContext('SELECT * FROM Orders o LEFT JOIN ');
      expect(result).toEqual({ type: 'join', joinType: 'LEFT JOIN' });
    });

    it('detects LEFT OUTER JOIN', () => {
      const result = detectJoinContext('SELECT * FROM Orders o LEFT OUTER JOIN ');
      expect(result).toEqual({ type: 'join', joinType: 'LEFT OUTER JOIN' });
    });

    it('detects RIGHT JOIN', () => {
      const result = detectJoinContext('SELECT * FROM Orders o RIGHT JOIN ');
      expect(result).toEqual({ type: 'join', joinType: 'RIGHT JOIN' });
    });

    it('detects RIGHT OUTER JOIN', () => {
      const result = detectJoinContext('SELECT * FROM Orders o RIGHT OUTER JOIN ');
      expect(result).toEqual({ type: 'join', joinType: 'RIGHT OUTER JOIN' });
    });

    it('detects FULL JOIN', () => {
      const result = detectJoinContext('SELECT * FROM Orders o FULL JOIN ');
      expect(result).toEqual({ type: 'join', joinType: 'FULL JOIN' });
    });

    it('detects FULL OUTER JOIN', () => {
      const result = detectJoinContext('SELECT * FROM Orders o FULL OUTER JOIN ');
      expect(result).toEqual({ type: 'join', joinType: 'FULL OUTER JOIN' });
    });

    it('detects CROSS JOIN', () => {
      const result = detectJoinContext('SELECT * FROM Orders o CROSS JOIN ');
      expect(result).toEqual({ type: 'join', joinType: 'CROSS JOIN' });
    });
  });

  describe('case insensitivity', () => {
    it('detects lowercase join keywords', () => {
      const result = detectJoinContext('SELECT * FROM Orders o left outer join ');
      expect(result).toEqual({ type: 'join', joinType: 'LEFT OUTER JOIN' });
    });

    it('detects mixed case join keywords', () => {
      const result = detectJoinContext('SELECT * FROM Orders o Inner Join ');
      expect(result).toEqual({ type: 'join', joinType: 'INNER JOIN' });
    });
  });

  describe('whitespace handling', () => {
    it('detects JOIN with trailing whitespace', () => {
      const result = detectJoinContext('SELECT * FROM Orders o JOIN   ');
      expect(result).toEqual({ type: 'join', joinType: 'JOIN' });
    });

    it('detects JOIN with extra whitespace between keywords', () => {
      const result = detectJoinContext('SELECT * FROM Orders o LEFT   OUTER   JOIN ');
      expect(result).toEqual({ type: 'join', joinType: 'LEFT OUTER JOIN' });
    });

    it('detects JOIN without trailing whitespace', () => {
      const result = detectJoinContext('SELECT * FROM Orders o JOIN');
      expect(result).toEqual({ type: 'join', joinType: 'JOIN' });
    });
  });

  describe('returns default when not in JOIN context', () => {
    it('returns default for empty text', () => {
      const result = detectJoinContext('');
      expect(result).toEqual({ type: 'default' });
    });

    it('returns default for FROM context', () => {
      const result = detectJoinContext('SELECT * FROM ');
      expect(result).toEqual({ type: 'default' });
    });

    it('returns default for WHERE context', () => {
      const result = detectJoinContext('SELECT * FROM Orders o WHERE ');
      expect(result).toEqual({ type: 'default' });
    });

    it('returns default when JOIN is followed by a table name', () => {
      const result = detectJoinContext('SELECT * FROM Orders o JOIN Customers c ON ');
      expect(result).toEqual({ type: 'default' });
    });

    it('returns default for SELECT context', () => {
      const result = detectJoinContext('SELECT ');
      expect(result).toEqual({ type: 'default' });
    });
  });

  describe('ignores keywords in comments and strings', () => {
    it('ignores JOIN inside a string literal', () => {
      const result = detectJoinContext("SELECT 'INNER JOIN' FROM Orders o ");
      expect(result).toEqual({ type: 'default' });
    });

    it('ignores JOIN inside a single-line comment', () => {
      const result = detectJoinContext('SELECT * -- INNER JOIN\nFROM Orders o ');
      expect(result).toEqual({ type: 'default' });
    });

    it('ignores JOIN inside a multi-line comment', () => {
      const result = detectJoinContext('SELECT * /* LEFT JOIN */ FROM Orders o ');
      expect(result).toEqual({ type: 'default' });
    });
  });
});


// --- Task 7.5: Extended unit tests for completion provider ---
// Tests for clause state engine integration, context filtering, and ranking

import { applyTieredRanking, applyContextFilter, RANK_TIERS, contextToClauseState, CompletionContext } from '../../server/src/completionProvider';
import { getClausePresenceSet, getValidSuccessors, TRANSITION_TABLE } from '../../server/src/clauseStateEngine';
import { resolveAlias } from '../../server/src/aliasResolver';

// --- Helpers for Task 7.5 tests ---

function makeCompletionItem(label: string, kind: typeof CompletionItemKind[keyof typeof CompletionItemKind], detail?: string): CompletionItem {
  return { label, kind, detail };
}

function makeKeywordItem(label: string): CompletionItem {
  return makeCompletionItem(label, CompletionItemKind.Keyword, 'Keyword');
}

function makeColumnItem(label: string): CompletionItem {
  return makeCompletionItem(label, CompletionItemKind.Field, 'int (not null)');
}

function makeTableItem(label: string): CompletionItem {
  return makeCompletionItem(label, CompletionItemKind.Module, 'Table');
}

function makeViewItem(label: string): CompletionItem {
  return makeCompletionItem(label, CompletionItemKind.Module, 'View');
}

function makeCTEItem(label: string): CompletionItem {
  return makeCompletionItem(label, CompletionItemKind.Module, 'CTE');
}

function makeFunctionItem(label: string): CompletionItem {
  return makeCompletionItem(label, CompletionItemKind.Function, 'Built-in Function');
}

describe('FROM injection after SELECT column list', () => {
  it('getValidSuccessors includes FROM when presence set has only SELECT', () => {
    const presenceSet = new Set(['SELECT'] as const) as Set<any>;
    const successors = getValidSuccessors('SELECT', presenceSet);
    expect(successors).toContain('FROM');
  });

  it('getValidSuccessors does NOT include FROM when FROM is already present', () => {
    const presenceSet = new Set(['SELECT', 'FROM'] as const) as Set<any>;
    const successors = getValidSuccessors('FROM', presenceSet);
    expect(successors).not.toContain('FROM');
  });

  it('applyTieredRanking assigns tier 0 to FROM when it is a required keyword', () => {
    const items: CompletionItem[] = [
      makeKeywordItem('FROM'),
      makeTableItem('dbo.Users'),
      makeColumnItem('Id'),
    ];
    const requiredKeywords = ['FROM'];
    applyTieredRanking(items, requiredKeywords);

    const fromItem = items.find(i => i.label === 'FROM');
    expect(fromItem!.sortText).toMatch(/^0_/);
  });

  it('FROM ranks above schema objects (tier 3) but columns (tier 1) rank above FROM (tier 0)', () => {
    const items: CompletionItem[] = [
      makeKeywordItem('FROM'),
      makeTableItem('dbo.Users'),
      makeColumnItem('Id'),
    ];
    const requiredKeywords = ['FROM'];
    applyTieredRanking(items, requiredKeywords);

    const fromItem = items.find(i => i.label === 'FROM');
    const tableItem = items.find(i => i.label === 'dbo.Users');
    const columnItem = items.find(i => i.label === 'Id');

    // Tier 0 (FROM) < Tier 3 (table) lexicographically
    expect(fromItem!.sortText! < tableItem!.sortText!).toBe(true);
    // Tier 1 (column) > Tier 0 (FROM) lexicographically
    expect(columnItem!.sortText! > fromItem!.sortText!).toBe(true);
  });

  it('getClausePresenceSet detects SELECT in "SELECT a, b "', () => {
    const text = 'SELECT a, b ';
    const presenceSet = getClausePresenceSet(text, text.length);
    expect(presenceSet.has('SELECT')).toBe(true);
    expect(presenceSet.has('FROM')).toBe(false);
  });
});

describe('ON injection after JOIN table reference', () => {
  it('TRANSITION_TABLE for JOIN state includes ON as a valid successor', () => {
    // ON is defined in the transition table as a valid successor of JOIN
    expect(TRANSITION_TABLE['JOIN']).toContain('ON');
  });

  it('getValidSuccessors includes ON when JOIN is NOT in presence set', () => {
    // When JOIN is not yet in the presence set, ON should be available
    const presenceSet = new Set(['SELECT', 'FROM'] as const) as Set<any>;
    const successors = getValidSuccessors('JOIN', presenceSet);
    expect(successors).toContain('ON');
  });

  it('applyTieredRanking assigns tier 0 to ON when it is a required keyword', () => {
    const items: CompletionItem[] = [
      makeKeywordItem('ON'),
      makeKeywordItem('WHERE'),
      makeTableItem('dbo.Orders'),
    ];
    const requiredKeywords = ['ON'];
    applyTieredRanking(items, requiredKeywords);

    const onItem = items.find(i => i.label === 'ON');
    expect(onItem!.sortText).toMatch(/^0_/);
  });

  it('ON ranks above non-required keywords', () => {
    const items: CompletionItem[] = [
      makeKeywordItem('ON'),
      makeKeywordItem('WHERE'),
      makeTableItem('dbo.Orders'),
    ];
    const requiredKeywords = ['ON'];
    applyTieredRanking(items, requiredKeywords);

    const onItem = items.find(i => i.label === 'ON');
    const whereItem = items.find(i => i.label === 'WHERE');
    const tableItem = items.find(i => i.label === 'dbo.Orders');

    // ON (tier 0) < WHERE (tier 3, non-required keyword) and table (tier 3)
    expect(onItem!.sortText! < whereItem!.sortText!).toBe(true);
    expect(onItem!.sortText! < tableItem!.sortText!).toBe(true);
  });

  it('getClausePresenceSet detects JOIN in "SELECT a FROM t JOIN t2 "', () => {
    const text = 'SELECT a FROM t JOIN t2 ';
    const presenceSet = getClausePresenceSet(text, text.length);
    expect(presenceSet.has('SELECT')).toBe(true);
    expect(presenceSet.has('FROM')).toBe(true);
    expect(presenceSet.has('JOIN')).toBe(true);
  });
});

describe('CROSS JOIN never suggests ON', () => {
  it('applyContextFilter excludes ON when isCrossJoin=true and isJoinWithTableRef=true', () => {
    const items: CompletionItem[] = [
      makeKeywordItem('ON'),
      makeKeywordItem('WHERE'),
      makeKeywordItem('GROUP BY'),
      makeKeywordItem('ORDER BY'),
    ];
    const result = applyContextFilter(items, 'JOIN', {
      isJoinWithTableRef: true,
      isCrossJoin: true,
    });
    const resultLabels = result.map(i => i.label);

    expect(resultLabels).not.toContain('ON');
  });

  it('other keywords (WHERE, GROUP BY) are still included for CROSS JOIN', () => {
    const items: CompletionItem[] = [
      makeKeywordItem('ON'),
      makeKeywordItem('WHERE'),
      makeKeywordItem('GROUP BY'),
      makeKeywordItem('ORDER BY'),
    ];
    const result = applyContextFilter(items, 'JOIN', {
      isJoinWithTableRef: true,
      isCrossJoin: true,
    });
    const resultLabels = result.map(i => i.label);

    expect(resultLabels).toContain('WHERE');
    expect(resultLabels).toContain('GROUP BY');
    expect(resultLabels).toContain('ORDER BY');
  });

  it('non-CROSS JOIN still includes ON', () => {
    const items: CompletionItem[] = [
      makeKeywordItem('ON'),
      makeKeywordItem('WHERE'),
    ];
    const result = applyContextFilter(items, 'JOIN', {
      isJoinWithTableRef: true,
      isCrossJoin: false,
    });
    const resultLabels = result.map(i => i.label);

    expect(resultLabels).toContain('ON');
    expect(resultLabels).toContain('WHERE');
  });
});

describe('Successor keywords suppressed immediately after JOIN keyword', () => {
  it('applyContextFilter with JOIN context and isJoinWithTableRef=false returns no keywords', () => {
    const items: CompletionItem[] = [
      makeKeywordItem('WHERE'),
      makeKeywordItem('GROUP BY'),
      makeKeywordItem('ORDER BY'),
      makeKeywordItem('ON'),
      makeTableItem('dbo.Users'),
      makeViewItem('dbo.ActiveUsers'),
      makeCTEItem('MyCTE'),
    ];
    const result = applyContextFilter(items, 'JOIN', {
      isJoinWithTableRef: false,
    });
    const resultLabels = result.map(i => i.label);

    // Keywords should be suppressed
    expect(resultLabels).not.toContain('WHERE');
    expect(resultLabels).not.toContain('GROUP BY');
    expect(resultLabels).not.toContain('ORDER BY');
    expect(resultLabels).not.toContain('ON');
  });

  it('only tables, views, and CTE names are in the result', () => {
    const items: CompletionItem[] = [
      makeKeywordItem('WHERE'),
      makeKeywordItem('ON'),
      makeTableItem('dbo.Users'),
      makeViewItem('dbo.ActiveUsers'),
      makeCTEItem('MyCTE'),
      makeColumnItem('Id'),
      makeFunctionItem('COUNT'),
    ];
    const result = applyContextFilter(items, 'JOIN', {
      isJoinWithTableRef: false,
    });
    const resultLabels = result.map(i => i.label);

    // Only tables, views, CTEs
    expect(resultLabels).toContain('dbo.Users');
    expect(resultLabels).toContain('dbo.ActiveUsers');
    expect(resultLabels).toContain('MyCTE');

    // No keywords, columns, or functions
    expect(resultLabels).not.toContain('WHERE');
    expect(resultLabels).not.toContain('ON');
    expect(resultLabels).not.toContain('Id');
    expect(resultLabels).not.toContain('COUNT');
  });
});

describe('Alias conflicts (table alias same name as CTE — table alias wins)', () => {
  it('resolveAlias returns table columns when alias matches both a table ref and a CTE name', () => {
    // Table reference: FROM dbo.Users c (alias "c" points to dbo.Users)
    // CTE: WITH c AS (SELECT Id, Name FROM dbo.Orders)
    // Table alias should take priority (Req 7.6)
    const tableReferences = [
      { schema: 'dbo', name: 'Users', alias: 'c' },
    ];
    const cteColumns = new Map<string, { name: string; dataType: string; isNullable: boolean }[]>([
      ['c', [
        { name: 'Id', dataType: 'unknown', isNullable: true },
        { name: 'OrderName', dataType: 'unknown', isNullable: true },
      ]],
    ]);
    const schemaCache = createMockSchemaCache({
      tables: [
        {
          schema: 'dbo',
          name: 'Users',
          columns: [
            { name: 'UserId', dataType: 'int', isNullable: false },
            { name: 'UserName', dataType: 'nvarchar', isNullable: true },
          ],
        },
      ],
    });

    const result = resolveAlias('c', tableReferences, cteColumns, schemaCache);

    // Table alias wins — should return Users columns, not CTE columns
    expect(result.found).toBe(true);
    const columnNames = result.columns.map(c => c.name);
    expect(columnNames).toContain('UserId');
    expect(columnNames).toContain('UserName');
    // Should NOT contain CTE columns
    expect(columnNames).not.toContain('OrderName');
  });

  it('resolveAlias falls back to CTE when alias does not match any table ref', () => {
    const tableReferences = [
      { schema: 'dbo', name: 'Users', alias: 'u' },
    ];
    const cteColumns = new Map<string, { name: string; dataType: string; isNullable: boolean }[]>([
      ['c', [
        { name: 'CteCol1', dataType: 'unknown', isNullable: true },
      ]],
    ]);
    const schemaCache = createMockSchemaCache({
      tables: [
        {
          schema: 'dbo',
          name: 'Users',
          columns: [
            { name: 'UserId', dataType: 'int', isNullable: false },
          ],
        },
      ],
    });

    const result = resolveAlias('c', tableReferences, cteColumns, schemaCache);

    // No table alias "c" exists, so CTE "c" should be used
    expect(result.found).toBe(true);
    const columnNames = result.columns.map(c => c.name);
    expect(columnNames).toContain('CteCol1');
  });
});

describe('Empty FROM clause (no table references yet)', () => {
  it('detectContext returns FROM for "SELECT a FROM "', () => {
    const context = detectContext('SELECT a FROM ');
    expect(context).toBe('FROM');
  });

  it('getCompletions in FROM context suggests tables/views/CTEs', () => {
    const schemaCache = createMockSchemaCache({
      tables: [
        {
          schema: 'dbo',
          name: 'Products',
          columns: [{ name: 'ProductId', dataType: 'int', isNullable: false }],
        },
      ],
      views: [
        {
          schema: 'dbo',
          name: 'ActiveProducts',
          columns: [{ name: 'ProductId', dataType: 'int', isNullable: false }],
        },
      ],
    });
    const text = 'SELECT a FROM ';
    const items = getCompletions(text, text.length, schemaCache, true);
    const labels = items.map(i => i.label);

    // Should suggest tables and views
    expect(labels).toContain('dbo.Products');
    expect(labels).toContain('dbo.ActiveProducts');
  });

  it('no columns are suggested in FROM context (empty FROM)', () => {
    const schemaCache = createMockSchemaCache({
      tables: [
        {
          schema: 'dbo',
          name: 'Products',
          columns: [{ name: 'ProductId', dataType: 'int', isNullable: false }],
        },
      ],
    });
    const text = 'SELECT a FROM ';
    const items = getCompletions(text, text.length, schemaCache, true);

    // No column items should be present in FROM context
    const columnItems = items.filter(i => i.kind === CompletionItemKind.Field);
    expect(columnItems).toHaveLength(0);
  });
});

describe('Keyword prefix override', () => {
  it('applyContextFilter includes WHERE when typedPrefix is "WH" even in JOIN context without table ref', () => {
    const items: CompletionItem[] = [
      makeKeywordItem('WHERE'),
      makeKeywordItem('ORDER BY'),
      makeTableItem('dbo.Users'),
      makeCTEItem('MyCTE'),
    ];
    const result = applyContextFilter(items, 'JOIN', {
      isJoinWithTableRef: false,
      typedPrefix: 'WH',
    });
    const resultLabels = result.map(i => i.label);

    // WHERE matches prefix "WH" — included via override
    expect(resultLabels).toContain('WHERE');
    // ORDER BY does not match "WH" — stays suppressed
    expect(resultLabels).not.toContain('ORDER BY');
  });

  it('applyContextFilter excludes WHERE when typedPrefix is empty in JOIN context without table ref', () => {
    const items: CompletionItem[] = [
      makeKeywordItem('WHERE'),
      makeKeywordItem('ORDER BY'),
      makeTableItem('dbo.Users'),
    ];
    const result = applyContextFilter(items, 'JOIN', {
      isJoinWithTableRef: false,
      typedPrefix: '',
    });
    const resultLabels = result.map(i => i.label);

    // No prefix override — keywords suppressed
    expect(resultLabels).not.toContain('WHERE');
    expect(resultLabels).not.toContain('ORDER BY');
    // Tables still included
    expect(resultLabels).toContain('dbo.Users');
  });

  it('prefix override is case-insensitive', () => {
    const items: CompletionItem[] = [
      makeKeywordItem('WHERE'),
      makeKeywordItem('GROUP BY'),
    ];
    const result = applyContextFilter(items, 'JOIN', {
      isJoinWithTableRef: false,
      typedPrefix: 'wh',
    });
    const resultLabels = result.map(i => i.label);

    expect(resultLabels).toContain('WHERE');
    expect(resultLabels).not.toContain('GROUP BY');
  });
});

describe('Context filtering in FROM vs SELECT contexts', () => {
  it('FROM context: tables/views/CTEs included, columns/functions excluded', () => {
    const items: CompletionItem[] = [
      makeTableItem('dbo.Users'),
      makeViewItem('dbo.ActiveUsers'),
      makeCTEItem('MyCTE'),
      makeColumnItem('Id'),
      makeColumnItem('Name'),
      makeFunctionItem('COUNT'),
      makeFunctionItem('GETDATE'),
      makeKeywordItem('WHERE'),
    ];
    const result = applyContextFilter(items, 'FROM');
    const resultLabels = result.map(i => i.label);

    // Tables, views, CTEs, keywords included
    expect(resultLabels).toContain('dbo.Users');
    expect(resultLabels).toContain('dbo.ActiveUsers');
    expect(resultLabels).toContain('MyCTE');
    expect(resultLabels).toContain('WHERE');

    // Columns and functions excluded
    expect(resultLabels).not.toContain('Id');
    expect(resultLabels).not.toContain('Name');
    expect(resultLabels).not.toContain('COUNT');
    expect(resultLabels).not.toContain('GETDATE');
  });

  it('SELECT context: columns/functions included, standalone tables excluded', () => {
    const items: CompletionItem[] = [
      makeTableItem('dbo.Users'),
      makeViewItem('dbo.ActiveUsers'),
      makeCTEItem('MyCTE'),
      makeColumnItem('Id'),
      makeColumnItem('Name'),
      makeFunctionItem('COUNT'),
      makeFunctionItem('GETDATE'),
      makeKeywordItem('FROM'),
    ];
    const result = applyContextFilter(items, 'SELECT');
    const resultLabels = result.map(i => i.label);

    // Columns, functions, keywords, CTE names included
    expect(resultLabels).toContain('Id');
    expect(resultLabels).toContain('Name');
    expect(resultLabels).toContain('COUNT');
    expect(resultLabels).toContain('GETDATE');
    expect(resultLabels).toContain('FROM');
    expect(resultLabels).toContain('MyCTE');

    // Standalone tables/views excluded
    expect(resultLabels).not.toContain('dbo.Users');
    expect(resultLabels).not.toContain('dbo.ActiveUsers');
  });

  it('SELECT context includes tables when schema-dot qualified', () => {
    const items: CompletionItem[] = [
      makeTableItem('dbo.Users'),
      makeColumnItem('Id'),
    ];
    const result = applyContextFilter(items, 'SELECT', { isSchemaDotQualified: true });
    const resultLabels = result.map(i => i.label);

    expect(resultLabels).toContain('dbo.Users');
    expect(resultLabels).toContain('Id');
  });

  it('FROM context includes columns when alias-dot qualified', () => {
    const items: CompletionItem[] = [
      makeTableItem('dbo.Users'),
      makeColumnItem('Id'),
      makeFunctionItem('COUNT'),
    ];
    const result = applyContextFilter(items, 'FROM', { isAliasDotQualified: true });
    const resultLabels = result.map(i => i.label);

    // All included when alias-dot qualified
    expect(resultLabels).toContain('dbo.Users');
    expect(resultLabels).toContain('Id');
    expect(resultLabels).toContain('COUNT');
  });
});

describe('contextToClauseState mapping', () => {
  it('maps SELECT to SELECT', () => {
    expect(contextToClauseState('SELECT')).toBe('SELECT');
  });

  it('maps FROM to FROM', () => {
    expect(contextToClauseState('FROM')).toBe('FROM');
  });

  it('maps JOIN to JOIN', () => {
    expect(contextToClauseState('JOIN')).toBe('JOIN');
  });

  it('maps WHERE to WHERE', () => {
    expect(contextToClauseState('WHERE')).toBe('WHERE');
  });

  it('maps GROUP_BY to GROUP_BY', () => {
    expect(contextToClauseState('GROUP_BY')).toBe('GROUP_BY');
  });

  it('maps ORDER_BY to ORDER_BY', () => {
    expect(contextToClauseState('ORDER_BY')).toBe('ORDER_BY');
  });

  it('returns null for EXEC', () => {
    expect(contextToClauseState('EXEC')).toBeNull();
  });

  it('returns null for CTE', () => {
    expect(contextToClauseState('CTE')).toBeNull();
  });

  it('returns null for NONE', () => {
    expect(contextToClauseState('NONE')).toBeNull();
  });
});
