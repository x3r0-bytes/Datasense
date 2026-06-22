import { describe, it, expect } from 'vitest';
import { CompletionItemKind, InsertTextFormat } from 'vscode-languageserver/node';
import {
  getAggregateColumnCompletions,
  getAggregateFunctionSnippets,
  NUMERIC_DATA_TYPES,
} from '../../server/src/completionProvider';
import { ColumnInfo } from '../../server/src/schemaCache';
import {
  FULL_AGGREGATE_FUNCTIONS,
  NUMERIC_AGGREGATE_FUNCTIONS,
  WILDCARD_AGGREGATE_FUNCTIONS,
} from '../../server/src/aggregationContextDetector';

// Helper to create a column with optional tableAlias
function col(
  name: string,
  dataType: string,
  isNullable = false,
  tableAlias?: string
): ColumnInfo & { tableAlias?: string } {
  return { name, dataType, isNullable, tableAlias };
}

describe('aggregateCompletions', () => {
  describe('SUM with mixed columns: numeric ranked higher (Req 1.2, 1.3)', () => {
    const columns = [
      col('Amount', 'decimal'),
      col('Name', 'varchar'),
      col('Quantity', 'int'),
      col('Description', 'nvarchar'),
    ];

    it('numeric columns get sortText starting with 0_', () => {
      const items = getAggregateColumnCompletions(columns, 'SUM');
      const numericItems = items.filter(i => i.label === 'Amount' || i.label === 'Quantity');
      for (const item of numericItems) {
        expect(item.sortText).toMatch(/^0_/);
      }
    });

    it('non-numeric columns get sortText starting with 2_', () => {
      const items = getAggregateColumnCompletions(columns, 'SUM');
      const nonNumericItems = items.filter(i => i.label === 'Name' || i.label === 'Description');
      for (const item of nonNumericItems) {
        expect(item.sortText).toMatch(/^2_/);
      }
    });

    it('all columns are present in the result', () => {
      const items = getAggregateColumnCompletions(columns, 'SUM');
      const labels = items.map(i => i.label);
      expect(labels).toContain('Amount');
      expect(labels).toContain('Name');
      expect(labels).toContain('Quantity');
      expect(labels).toContain('Description');
    });

    it('numeric ranking applies to all numeric aggregate functions', () => {
      for (const fn of NUMERIC_AGGREGATE_FUNCTIONS) {
        const items = getAggregateColumnCompletions(columns, fn);
        const amountItem = items.find(i => i.label === 'Amount');
        const nameItem = items.find(i => i.label === 'Name');
        expect(amountItem?.sortText).toMatch(/^0_/);
        expect(nameItem?.sortText).toMatch(/^2_/);
      }
    });
  });

  describe('COUNT: all columns + * present (Req 1.4, 2.2)', () => {
    const columns = [
      col('ID', 'int'),
      col('Name', 'varchar'),
      col('CreatedAt', 'datetime'),
    ];

    it('COUNT includes a * item', () => {
      const items = getAggregateColumnCompletions(columns, 'COUNT');
      const starItem = items.find(i => i.label === '*');
      expect(starItem).toBeDefined();
      expect(starItem!.kind).toBe(CompletionItemKind.Field);
    });

    it('COUNT includes all columns', () => {
      const items = getAggregateColumnCompletions(columns, 'COUNT');
      const labels = items.map(i => i.label);
      expect(labels).toContain('ID');
      expect(labels).toContain('Name');
      expect(labels).toContain('CreatedAt');
    });

    it('COUNT_BIG also includes * and all columns', () => {
      const items = getAggregateColumnCompletions(columns, 'COUNT_BIG');
      const labels = items.map(i => i.label);
      expect(labels).toContain('*');
      expect(labels).toContain('ID');
      expect(labels).toContain('Name');
      expect(labels).toContain('CreatedAt');
    });

    it('COUNT columns have equal ranking (sortText 1_)', () => {
      const items = getAggregateColumnCompletions(columns, 'COUNT');
      const columnItems = items.filter(i => i.label !== '*');
      for (const item of columnItems) {
        expect(item.sortText).toMatch(/^1_/);
      }
    });

    it('* is ranked at top (sortText 0_)', () => {
      const items = getAggregateColumnCompletions(columns, 'COUNT');
      const starItem = items.find(i => i.label === '*');
      expect(starItem!.sortText).toMatch(/^0_/);
    });
  });

  describe('MIN/MAX: all columns regardless of type (Req 1.5)', () => {
    const columns = [
      col('Price', 'decimal'),
      col('Name', 'varchar'),
      col('OrderDate', 'datetime'),
      col('IsActive', 'bit'),
    ];

    it('MIN includes all columns', () => {
      const items = getAggregateColumnCompletions(columns, 'MIN');
      const labels = items.map(i => i.label);
      expect(labels).toContain('Price');
      expect(labels).toContain('Name');
      expect(labels).toContain('OrderDate');
      expect(labels).toContain('IsActive');
    });

    it('MAX includes all columns', () => {
      const items = getAggregateColumnCompletions(columns, 'MAX');
      const labels = items.map(i => i.label);
      expect(labels).toContain('Price');
      expect(labels).toContain('Name');
      expect(labels).toContain('OrderDate');
      expect(labels).toContain('IsActive');
    });

    it('MIN/MAX columns have equal ranking (sortText 1_)', () => {
      const items = getAggregateColumnCompletions(columns, 'MIN');
      for (const item of items) {
        expect(item.sortText).toMatch(/^1_/);
      }
    });

    it('MIN/MAX do not include * item', () => {
      const minItems = getAggregateColumnCompletions(columns, 'MIN');
      const maxItems = getAggregateColumnCompletions(columns, 'MAX');
      expect(minItems.find(i => i.label === '*')).toBeUndefined();
      expect(maxItems.find(i => i.label === '*')).toBeUndefined();
    });
  });

  describe('snippet structure: insertText matches FUNCNAME($1) pattern (Req 2.1, 2.3)', () => {
    it('all aggregate function snippets have correct insertText pattern', () => {
      const snippets = getAggregateFunctionSnippets();
      for (const item of snippets) {
        const funcName = item.label as string;
        if (funcName === 'STRING_AGG') {
          expect(item.insertText).toBe('STRING_AGG($1, $2)');
        } else {
          expect(item.insertText).toBe(`${funcName}($1)`);
        }
      }
    });

    it('all aggregate function snippets have kind = Function', () => {
      const snippets = getAggregateFunctionSnippets();
      for (const item of snippets) {
        expect(item.kind).toBe(CompletionItemKind.Function);
      }
    });

    it('all aggregate function snippets have insertTextFormat = Snippet', () => {
      const snippets = getAggregateFunctionSnippets();
      for (const item of snippets) {
        expect(item.insertTextFormat).toBe(InsertTextFormat.Snippet);
      }
    });

    it('all aggregate function snippets have a command to trigger re-completion', () => {
      const snippets = getAggregateFunctionSnippets();
      for (const item of snippets) {
        expect(item.command).toBeDefined();
        expect(item.command!.command).toBe('editor.action.triggerSuggest');
      }
    });

    it('snippets cover all FULL_AGGREGATE_FUNCTIONS', () => {
      const snippets = getAggregateFunctionSnippets();
      const labels = new Set(snippets.map(i => i.label as string));
      for (const fn of FULL_AGGREGATE_FUNCTIONS) {
        expect(labels.has(fn)).toBe(true);
      }
    });
  });

  describe('multi-table: columns from all joined tables appear (Req 8.1)', () => {
    const columns = [
      col('CustomerID', 'int', false, 'o'),
      col('OrderDate', 'datetime', false, 'o'),
      col('Amount', 'decimal', false, 'o'),
      col('ProductID', 'int', false, 'p'),
      col('ProductName', 'varchar', false, 'p'),
      col('Price', 'decimal', false, 'p'),
    ];

    it('SUM includes columns from all tables', () => {
      const items = getAggregateColumnCompletions(columns, 'SUM');
      const labels = items.map(i => i.label);
      expect(labels).toContain('o.CustomerID');
      expect(labels).toContain('o.OrderDate');
      expect(labels).toContain('o.Amount');
      expect(labels).toContain('p.ProductID');
      expect(labels).toContain('p.ProductName');
      expect(labels).toContain('p.Price');
    });

    it('COUNT includes columns from all tables plus *', () => {
      const items = getAggregateColumnCompletions(columns, 'COUNT');
      const labels = items.map(i => i.label);
      expect(labels).toContain('*');
      expect(labels).toContain('o.CustomerID');
      expect(labels).toContain('p.ProductID');
      expect(labels).toContain('p.ProductName');
    });

    it('qualified columns preserve alias in label', () => {
      const items = getAggregateColumnCompletions(columns, 'MIN');
      const amountItem = items.find(i => i.label === 'o.Amount');
      expect(amountItem).toBeDefined();
      expect(amountItem!.kind).toBe(CompletionItemKind.Field);
    });
  });

  describe('ambiguous columns: shared names only appear qualified (Req 8.2)', () => {
    // Simulate the ambiguity resolution that happens in getCompletions():
    // When columns share the same name across tables, only qualified versions appear.
    // The caller (getCompletions) handles this by always passing tableAlias for multi-table.
    // Here we test that getAggregateColumnCompletions correctly uses the tableAlias.

    it('columns with tableAlias are shown as alias.column', () => {
      const columns = [
        col('ID', 'int', false, 'o'),
        col('ID', 'int', false, 'c'),
        col('Name', 'varchar', false, 'c'),
      ];
      const items = getAggregateColumnCompletions(columns, 'COUNT');
      const labels = items.map(i => i.label);
      // Both ID columns appear qualified
      expect(labels).toContain('o.ID');
      expect(labels).toContain('c.ID');
      expect(labels).toContain('c.Name');
      // Unqualified 'ID' should NOT appear
      expect(labels).not.toContain('ID');
    });

    it('ambiguous columns are distinguishable by their qualified labels', () => {
      const columns = [
        col('Status', 'varchar', false, 'orders'),
        col('Status', 'varchar', false, 'customers'),
      ];
      const items = getAggregateColumnCompletions(columns, 'MIN');
      const labels = items.map(i => i.label);
      expect(labels).toContain('orders.Status');
      expect(labels).toContain('customers.Status');
      expect(labels).not.toContain('Status');
    });

    it('single-table columns without tableAlias appear unqualified', () => {
      const columns = [
        col('ID', 'int'),
        col('Name', 'varchar'),
      ];
      const items = getAggregateColumnCompletions(columns, 'SUM');
      const labels = items.map(i => i.label);
      expect(labels).toContain('ID');
      expect(labels).toContain('Name');
    });
  });
});
