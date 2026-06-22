import { describe, it, expect } from 'vitest';
import { applyContextFilter, ContextFilterOptions } from '../../server/src/completionProvider';
import { CompletionItem, CompletionItemKind } from 'vscode-languageserver/node';

// --- Test Helpers ---

function makeColumn(name: string): CompletionItem {
  return { label: name, kind: CompletionItemKind.Field, detail: 'int (not null)' };
}

function makeFunction(name: string): CompletionItem {
  return { label: name, kind: CompletionItemKind.Function, detail: 'Built-in Function' };
}

function makeTable(name: string): CompletionItem {
  return { label: name, kind: CompletionItemKind.Module, detail: 'Table' };
}

function makeView(name: string): CompletionItem {
  return { label: name, kind: CompletionItemKind.Module, detail: 'View' };
}

function makeCTE(name: string): CompletionItem {
  return { label: name, kind: CompletionItemKind.Module, detail: 'CTE' };
}

function makeKeyword(name: string): CompletionItem {
  return { label: name, kind: CompletionItemKind.Keyword, detail: 'Keyword' };
}

function labels(items: CompletionItem[]): string[] {
  return items.map(i => i.label as string);
}

// --- Mixed item set used across tests ---
function mixedItems(): CompletionItem[] {
  return [
    makeColumn('OrderId'),
    makeColumn('CustomerName'),
    makeFunction('COUNT'),
    makeFunction('GETDATE'),
    makeTable('dbo.Orders'),
    makeView('dbo.ActiveCustomers'),
    makeCTE('RecentOrders'),
    makeKeyword('WHERE'),
    makeKeyword('GROUP BY'),
    makeKeyword('ON'),
  ];
}

// --- Tests ---

describe('applyContextFilter', () => {
  describe('FROM/JOIN context', () => {
    it('includes tables, views, CTE names, and keywords in FROM context', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'FROM');
      const resultLabels = labels(result);

      expect(resultLabels).toContain('dbo.Orders');
      expect(resultLabels).toContain('dbo.ActiveCustomers');
      expect(resultLabels).toContain('RecentOrders');
      expect(resultLabels).toContain('WHERE');
      expect(resultLabels).toContain('GROUP BY');
    });

    it('excludes columns and functions in FROM context', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'FROM');
      const resultLabels = labels(result);

      expect(resultLabels).not.toContain('OrderId');
      expect(resultLabels).not.toContain('CustomerName');
      expect(resultLabels).not.toContain('COUNT');
      expect(resultLabels).not.toContain('GETDATE');
    });

    it('includes columns and functions in FROM context when alias-dot qualified', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'FROM', { isAliasDotQualified: true });
      const resultLabels = labels(result);

      expect(resultLabels).toContain('OrderId');
      expect(resultLabels).toContain('COUNT');
    });
  });

  describe('Immediately after JOIN keyword (no table ref typed)', () => {
    it('includes only tables, views, and CTE names', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'JOIN', {
        isJoinWithTableRef: false,
      });
      const resultLabels = labels(result);

      expect(resultLabels).toContain('dbo.Orders');
      expect(resultLabels).toContain('dbo.ActiveCustomers');
      expect(resultLabels).toContain('RecentOrders');
    });

    it('suppresses successor keywords immediately after JOIN', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'JOIN', {
        isJoinWithTableRef: false,
      });
      const resultLabels = labels(result);

      expect(resultLabels).not.toContain('WHERE');
      expect(resultLabels).not.toContain('GROUP BY');
      expect(resultLabels).not.toContain('ON');
    });

    it('suppresses columns and functions immediately after JOIN', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'JOIN', {
        isJoinWithTableRef: false,
      });
      const resultLabels = labels(result);

      expect(resultLabels).not.toContain('OrderId');
      expect(resultLabels).not.toContain('COUNT');
    });
  });

  describe('After JOIN + table reference + whitespace', () => {
    it('includes ON and successor keywords', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'JOIN', {
        isJoinWithTableRef: true,
      });
      const resultLabels = labels(result);

      expect(resultLabels).toContain('ON');
      expect(resultLabels).toContain('WHERE');
      expect(resultLabels).toContain('GROUP BY');
    });

    it('excludes tables and views after JOIN table ref', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'JOIN', {
        isJoinWithTableRef: true,
      });
      const resultLabels = labels(result);

      expect(resultLabels).not.toContain('dbo.Orders');
      expect(resultLabels).not.toContain('dbo.ActiveCustomers');
      expect(resultLabels).not.toContain('RecentOrders');
    });

    it('excludes columns and functions after JOIN table ref', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'JOIN', {
        isJoinWithTableRef: true,
      });
      const resultLabels = labels(result);

      expect(resultLabels).not.toContain('OrderId');
      expect(resultLabels).not.toContain('COUNT');
    });
  });

  describe('CROSS JOIN context', () => {
    it('never suggests ON for CROSS JOIN', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'JOIN', {
        isJoinWithTableRef: true,
        isCrossJoin: true,
      });
      const resultLabels = labels(result);

      expect(resultLabels).not.toContain('ON');
      // Other keywords are still included
      expect(resultLabels).toContain('WHERE');
      expect(resultLabels).toContain('GROUP BY');
    });
  });

  describe('SELECT/WHERE/GROUP_BY/ORDER_BY context', () => {
    it('includes columns, functions, and keywords in SELECT context', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'SELECT');
      const resultLabels = labels(result);

      expect(resultLabels).toContain('OrderId');
      expect(resultLabels).toContain('CustomerName');
      expect(resultLabels).toContain('COUNT');
      expect(resultLabels).toContain('GETDATE');
      expect(resultLabels).toContain('WHERE');
    });

    it('excludes standalone table/view names in SELECT context', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'SELECT');
      const resultLabels = labels(result);

      expect(resultLabels).not.toContain('dbo.Orders');
      expect(resultLabels).not.toContain('dbo.ActiveCustomers');
    });

    it('includes table/view names in SELECT context when schema-dot qualified', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'SELECT', { isSchemaDotQualified: true });
      const resultLabels = labels(result);

      expect(resultLabels).toContain('dbo.Orders');
      expect(resultLabels).toContain('dbo.ActiveCustomers');
    });

    it('includes CTE names in SELECT context (usable as aliases)', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'SELECT');
      const resultLabels = labels(result);

      expect(resultLabels).toContain('RecentOrders');
    });

    it('excludes standalone table/view names in WHERE context', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'WHERE');
      const resultLabels = labels(result);

      expect(resultLabels).not.toContain('dbo.Orders');
      expect(resultLabels).not.toContain('dbo.ActiveCustomers');
      expect(resultLabels).toContain('OrderId');
      expect(resultLabels).toContain('COUNT');
    });

    it('excludes standalone table/view names in GROUP_BY context', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'GROUP_BY');
      const resultLabels = labels(result);

      expect(resultLabels).not.toContain('dbo.Orders');
      expect(resultLabels).toContain('OrderId');
    });

    it('excludes standalone table/view names in ORDER_BY context', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'ORDER_BY');
      const resultLabels = labels(result);

      expect(resultLabels).not.toContain('dbo.Orders');
      expect(resultLabels).toContain('OrderId');
    });
  });

  describe('NONE context', () => {
    it('includes all keywords and functions', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'NONE');
      const resultLabels = labels(result);

      expect(resultLabels).toContain('WHERE');
      expect(resultLabels).toContain('GROUP BY');
      expect(resultLabels).toContain('COUNT');
      expect(resultLabels).toContain('GETDATE');
    });

    it('omits tier 0 (required) keywords in NONE context', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'NONE', {
        requiredKeywords: ['FROM', 'ON'],
      });
      const resultLabels = labels(result);

      // ON is a required keyword and should be omitted in NONE context
      expect(resultLabels).not.toContain('ON');
      // Non-required keywords are still included
      expect(resultLabels).toContain('WHERE');
      expect(resultLabels).toContain('GROUP BY');
    });

    it('includes tables, views, columns, and CTEs in NONE context', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'NONE');
      const resultLabels = labels(result);

      expect(resultLabels).toContain('dbo.Orders');
      expect(resultLabels).toContain('dbo.ActiveCustomers');
      expect(resultLabels).toContain('OrderId');
      expect(resultLabels).toContain('RecentOrders');
    });
  });

  describe('Prefix override', () => {
    it('includes a keyword matching the typed prefix even when context would suppress it', () => {
      const items = [
        makeTable('dbo.Orders'),
        makeCTE('RecentOrders'),
        makeKeyword('WHERE'),
        makeKeyword('ORDER BY'),
      ];
      // In JOIN context without table ref, keywords are normally suppressed
      const result = applyContextFilter(items, 'JOIN', {
        isJoinWithTableRef: false,
        typedPrefix: 'WH',
      });
      const resultLabels = labels(result);

      // WHERE matches the prefix "WH" so it should be included
      expect(resultLabels).toContain('WHERE');
      // ORDER BY does not match "WH" so it stays suppressed
      expect(resultLabels).not.toContain('ORDER BY');
      // Tables and CTEs are still included (normal JOIN behavior)
      expect(resultLabels).toContain('dbo.Orders');
      expect(resultLabels).toContain('RecentOrders');
    });

    it('prefix override is case-insensitive', () => {
      const items = [makeKeyword('WHERE'), makeKeyword('GROUP BY')];
      const result = applyContextFilter(items, 'JOIN', {
        isJoinWithTableRef: false,
        typedPrefix: 'wh',
      });
      const resultLabels = labels(result);

      expect(resultLabels).toContain('WHERE');
      expect(resultLabels).not.toContain('GROUP BY');
    });

    it('prefix override does not apply to non-keyword items', () => {
      const items = [makeColumn('WHERE_CLAUSE'), makeKeyword('WHERE')];
      // In JOIN context without table ref, columns are suppressed
      const result = applyContextFilter(items, 'JOIN', {
        isJoinWithTableRef: false,
        typedPrefix: 'WH',
      });
      const resultLabels = labels(result);

      // Keyword WHERE is included via prefix override
      expect(resultLabels).toContain('WHERE');
      // Column WHERE_CLAUSE is NOT included (prefix override only applies to keywords)
      expect(resultLabels).not.toContain('WHERE_CLAUSE');
    });

    it('empty prefix does not trigger override', () => {
      const items = [makeKeyword('WHERE')];
      const result = applyContextFilter(items, 'JOIN', {
        isJoinWithTableRef: false,
        typedPrefix: '',
      });
      const resultLabels = labels(result);

      // No prefix override, keyword is suppressed in JOIN context
      expect(resultLabels).not.toContain('WHERE');
    });
  });

  describe('Other contexts (passthrough)', () => {
    it('passes through all items for EXEC context', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'EXEC');

      expect(result.length).toBe(items.length);
    });

    it('passes through all items for CTE context', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'CTE');

      expect(result.length).toBe(items.length);
    });

    it('passes through all items for UPDATE context', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'UPDATE');

      expect(result.length).toBe(items.length);
    });

    it('passes through all items for DECLARE context', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'DECLARE');

      expect(result.length).toBe(items.length);
    });
  });

  describe('Pure function behavior', () => {
    it('does not mutate the input array', () => {
      const items = mixedItems();
      const originalLength = items.length;
      applyContextFilter(items, 'FROM');

      expect(items.length).toBe(originalLength);
    });

    it('returns a new array', () => {
      const items = mixedItems();
      const result = applyContextFilter(items, 'NONE');

      // Even if all items pass, it should be a new array (from filter)
      expect(result).not.toBe(items);
    });

    it('returns empty array when all items are filtered out', () => {
      const items = [makeColumn('OrderId'), makeFunction('COUNT')];
      const result = applyContextFilter(items, 'FROM');

      expect(result).toEqual([]);
    });

    it('handles empty input array', () => {
      const result = applyContextFilter([], 'SELECT');

      expect(result).toEqual([]);
    });

    it('uses default options when none provided', () => {
      const items = mixedItems();
      // Should not throw
      const result = applyContextFilter(items, 'FROM');
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
