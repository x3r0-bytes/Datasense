import { describe, it, expect } from 'vitest';
import { CompletionItemKind } from 'vscode-languageserver/node';
import {
  getAggregateColumnCompletions,
  getGroupByCompletion,
  CompletionContext,
  NUMERIC_DATA_TYPES,
} from '../../server/src/completionProvider';
import { analyzeSelectList } from '../../server/src/groupByAnalyzer';
import { ColumnInfo } from '../../server/src/schemaCache';
import { NUMERIC_AGGREGATE_FUNCTIONS } from '../../server/src/aggregationContextDetector';

// Helper to create a column with optional tableAlias
function col(
  name: string,
  dataType: string,
  isNullable = false,
  tableAlias?: string
): ColumnInfo & { tableAlias?: string } {
  return { name, dataType, isNullable, tableAlias };
}

describe('Multi-Table Aggregation (Requirements 8.1, 8.2, 8.3, 8.4)', () => {
  describe('JOIN with multiple tables: all columns from all tables appear in aggregate completions (Req 8.1)', () => {
    const columns = [
      col('CustomerID', 'int', false, 'o'),
      col('OrderDate', 'datetime', false, 'o'),
      col('Amount', 'decimal', false, 'o'),
      col('ProductID', 'int', false, 'p'),
      col('Name', 'varchar', false, 'p'),
      col('Price', 'decimal', false, 'p'),
    ];

    it('SUM completions include columns from both Orders (o) and Products (p) tables', () => {
      const items = getAggregateColumnCompletions(columns, 'SUM');
      const labels = items.map(i => i.label);

      // All columns from Orders table (alias o)
      expect(labels).toContain('o.CustomerID');
      expect(labels).toContain('o.OrderDate');
      expect(labels).toContain('o.Amount');

      // All columns from Products table (alias p)
      expect(labels).toContain('p.ProductID');
      expect(labels).toContain('p.Name');
      expect(labels).toContain('p.Price');
    });

    it('COUNT completions include columns from all tables plus *', () => {
      const items = getAggregateColumnCompletions(columns, 'COUNT');
      const labels = items.map(i => i.label);

      expect(labels).toContain('*');
      expect(labels).toContain('o.CustomerID');
      expect(labels).toContain('o.OrderDate');
      expect(labels).toContain('o.Amount');
      expect(labels).toContain('p.ProductID');
      expect(labels).toContain('p.Name');
      expect(labels).toContain('p.Price');
    });

    it('AVG completions include columns from all tables', () => {
      const items = getAggregateColumnCompletions(columns, 'AVG');
      const labels = items.map(i => i.label);

      expect(labels).toContain('o.CustomerID');
      expect(labels).toContain('o.Amount');
      expect(labels).toContain('p.ProductID');
      expect(labels).toContain('p.Price');
      expect(labels).toContain('p.Name');
    });

    it('total column count matches input (no duplicates, no missing)', () => {
      const items = getAggregateColumnCompletions(columns, 'MIN');
      // MIN doesn't add *, so count should equal number of input columns
      expect(items).toHaveLength(columns.length);
    });
  });

  describe('Ambiguous columns: shared column names only appear qualified (Req 8.2)', () => {
    it('columns with same name from different tables appear only as qualified', () => {
      const columns = [
        col('ID', 'int', false, 'o'),
        col('ID', 'int', false, 'c'),
        col('Name', 'varchar', false, 'o'),
        col('Name', 'varchar', false, 'c'),
        col('Amount', 'decimal', false, 'o'),
      ];

      const items = getAggregateColumnCompletions(columns, 'SUM');
      const labels = items.map(i => i.label);

      // Both ID columns appear qualified
      expect(labels).toContain('o.ID');
      expect(labels).toContain('c.ID');
      // Both Name columns appear qualified
      expect(labels).toContain('o.Name');
      expect(labels).toContain('c.Name');
      // Amount appears qualified (since tableAlias is set)
      expect(labels).toContain('o.Amount');

      // Unqualified versions should NOT appear
      expect(labels).not.toContain('ID');
      expect(labels).not.toContain('Name');
    });

    it('three tables with shared column name all appear qualified', () => {
      const columns = [
        col('Status', 'varchar', false, 'orders'),
        col('Status', 'varchar', false, 'customers'),
        col('Status', 'varchar', false, 'products'),
      ];

      const items = getAggregateColumnCompletions(columns, 'COUNT');
      const labels = items.map(i => i.label);

      expect(labels).toContain('orders.Status');
      expect(labels).toContain('customers.Status');
      expect(labels).toContain('products.Status');
      expect(labels).not.toContain('Status');
    });

    it('unique columns with tableAlias still appear qualified', () => {
      const columns = [
        col('OrderID', 'int', false, 'o'),
        col('CustomerName', 'varchar', false, 'c'),
      ];

      const items = getAggregateColumnCompletions(columns, 'MIN');
      const labels = items.map(i => i.label);

      // When tableAlias is set, columns always appear qualified
      expect(labels).toContain('o.OrderID');
      expect(labels).toContain('c.CustomerName');
      expect(labels).not.toContain('OrderID');
      expect(labels).not.toContain('CustomerName');
    });
  });

  describe('GROUP BY generation with aliases: o.CustomerID, p.Name (Req 8.3)', () => {
    it('generates GROUP BY with alias-qualified columns from multiple tables', () => {
      const sql = 'SELECT o.CustomerID, p.Name, SUM(o.Amount) FROM Orders o JOIN Products p ON o.ProductID = p.ID';
      const context: CompletionContext = 'FROM';
      const result = getGroupByCompletion(sql, context);

      expect(result).not.toBeNull();
      expect(result!.insertText).toBe('GROUP BY o.CustomerID, p.Name');
      expect(result!.label).toBe('GROUP BY o.CustomerID, p.Name');
    });

    it('preserves alias qualification order from SELECT list', () => {
      const sql = 'SELECT p.Category, o.Region, COUNT(*) FROM Orders o JOIN Products p ON o.ProductID = p.ID';
      const context: CompletionContext = 'FROM';
      const result = getGroupByCompletion(sql, context);

      expect(result).not.toBeNull();
      expect(result!.insertText).toBe('GROUP BY p.Category, o.Region');
    });

    it('handles three tables with aliases in GROUP BY', () => {
      const sql = 'SELECT o.CustomerID, p.Name, c.City, SUM(o.Amount) FROM Orders o JOIN Products p ON o.ProductID = p.ID JOIN Customers c ON o.CustomerID = c.ID';
      const context: CompletionContext = 'FROM';
      const result = getGroupByCompletion(sql, context);

      expect(result).not.toBeNull();
      expect(result!.insertText).toBe('GROUP BY o.CustomerID, p.Name, c.City');
    });

    it('analyzeSelectList identifies non-aggregated columns from multiple tables', () => {
      const sql = 'SELECT o.CustomerID, p.Name, SUM(o.Amount) FROM Orders o JOIN Products p ON o.ProductID = p.ID';
      const analysis = analyzeSelectList(sql);

      expect(analysis.hasAggregates).toBe(true);
      expect(analysis.needsGroupBy).toBe(true);
      expect(analysis.nonAggregatedExpressions).toContain('o.CustomerID');
      expect(analysis.nonAggregatedExpressions).toContain('p.Name');
      expect(analysis.nonAggregatedExpressions).toHaveLength(2);
    });

    it('analyzeSelectList preserves alias qualification in expressions', () => {
      const sql = 'SELECT c.LastName, o.OrderDate, AVG(o.Total) FROM Customers c JOIN Orders o ON c.ID = o.CustomerID';
      const analysis = analyzeSelectList(sql);

      expect(analysis.needsGroupBy).toBe(true);
      expect(analysis.nonAggregatedExpressions).toEqual(['c.LastName', 'o.OrderDate']);
    });
  });

  describe('Alias resolution for type ranking: o.Amount resolved to numeric type (Req 8.4)', () => {
    it('numeric columns with alias get 0_ sortText prefix in SUM', () => {
      const columns = [
        col('Amount', 'decimal', false, 'o'),
        col('Quantity', 'int', false, 'o'),
        col('Name', 'varchar', false, 'c'),
      ];

      const items = getAggregateColumnCompletions(columns, 'SUM');

      const amountItem = items.find(i => i.label === 'o.Amount');
      const quantityItem = items.find(i => i.label === 'o.Quantity');
      const nameItem = items.find(i => i.label === 'c.Name');

      expect(amountItem).toBeDefined();
      expect(quantityItem).toBeDefined();
      expect(nameItem).toBeDefined();

      // Numeric columns ranked higher (0_ prefix)
      expect(amountItem!.sortText).toMatch(/^0_/);
      expect(quantityItem!.sortText).toMatch(/^0_/);
      // Non-numeric column ranked lower (2_ prefix)
      expect(nameItem!.sortText).toMatch(/^2_/);
    });

    it('alias-qualified numeric columns ranked higher in AVG', () => {
      const columns = [
        col('Price', 'money', false, 'p'),
        col('Description', 'nvarchar', false, 'p'),
        col('Total', 'float', false, 'o'),
        col('OrderDate', 'datetime', false, 'o'),
      ];

      const items = getAggregateColumnCompletions(columns, 'AVG');

      const priceItem = items.find(i => i.label === 'p.Price');
      const descItem = items.find(i => i.label === 'p.Description');
      const totalItem = items.find(i => i.label === 'o.Total');
      const dateItem = items.find(i => i.label === 'o.OrderDate');

      // Numeric types (money, float) get 0_ prefix
      expect(priceItem!.sortText).toMatch(/^0_/);
      expect(totalItem!.sortText).toMatch(/^0_/);
      // Non-numeric types (nvarchar, datetime) get 2_ prefix
      expect(descItem!.sortText).toMatch(/^2_/);
      expect(dateItem!.sortText).toMatch(/^2_/);
    });

    it('all numeric aggregate functions apply type ranking to alias-qualified columns', () => {
      const columns = [
        col('Revenue', 'decimal', false, 'o'),
        col('CustomerName', 'varchar', false, 'c'),
      ];

      for (const fn of NUMERIC_AGGREGATE_FUNCTIONS) {
        const items = getAggregateColumnCompletions(columns, fn);

        const revenueItem = items.find(i => i.label === 'o.Revenue');
        const nameItem = items.find(i => i.label === 'c.CustomerName');

        expect(revenueItem!.sortText).toMatch(/^0_/);
        expect(nameItem!.sortText).toMatch(/^2_/);
      }
    });

    it('MIN/MAX give equal ranking to alias-qualified columns regardless of type', () => {
      const columns = [
        col('Amount', 'decimal', false, 'o'),
        col('Name', 'varchar', false, 'c'),
      ];

      const items = getAggregateColumnCompletions(columns, 'MIN');

      const amountItem = items.find(i => i.label === 'o.Amount');
      const nameItem = items.find(i => i.label === 'c.Name');

      // Both get equal ranking (1_ prefix) for MIN/MAX
      expect(amountItem!.sortText).toMatch(/^1_/);
      expect(nameItem!.sortText).toMatch(/^1_/);
    });

    it('COUNT gives equal ranking to alias-qualified columns regardless of type', () => {
      const columns = [
        col('Amount', 'decimal', false, 'o'),
        col('Name', 'varchar', false, 'c'),
      ];

      const items = getAggregateColumnCompletions(columns, 'COUNT');

      const amountItem = items.find(i => i.label === 'o.Amount');
      const nameItem = items.find(i => i.label === 'c.Name');

      // Both get equal ranking (1_ prefix) for COUNT
      expect(amountItem!.sortText).toMatch(/^1_/);
      expect(nameItem!.sortText).toMatch(/^1_/);
    });
  });
});
