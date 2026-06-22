import { describe, it, expect } from 'vitest';
import { CompletionItemKind, InsertTextFormat } from 'vscode-languageserver/node';
import {
  detectContext,
  getCompletions,
  getAggregateFunctionSnippets,
  RANK_TIERS,
} from '../../server/src/completionProvider';
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

describe('HAVING clause awareness (Requirements 7.1, 7.2, 7.3)', () => {
  describe('HAVING context detection', () => {
    it('detects HAVING context: SELECT ... GROUP BY col1 HAVING |', () => {
      const text = 'SELECT col1, COUNT(*) FROM t GROUP BY col1 HAVING ';
      expect(detectContext(text)).toBe('HAVING');
    });

    it('detects HAVING context (case-insensitive)', () => {
      const text = 'SELECT col1, COUNT(*) FROM t GROUP BY col1 having ';
      expect(detectContext(text)).toBe('HAVING');
    });

    it('detects HAVING context with content after HAVING keyword', () => {
      const text = 'SELECT col1, COUNT(*) FROM t GROUP BY col1 HAVING COUNT(*) > ';
      expect(detectContext(text)).toBe('HAVING');
    });

    it('detects HAVING as the most recent context even after GROUP BY', () => {
      const text = 'SELECT col1, COUNT(*) FROM t GROUP BY col1 HAVING ';
      // HAVING comes after GROUP BY, so it should be the detected context
      expect(detectContext(text)).toBe('HAVING');
    });

    it('detects HAVING context with multiple columns in GROUP BY', () => {
      const text = 'SELECT col1, col2, SUM(col3) FROM t GROUP BY col1, col2 HAVING ';
      expect(detectContext(text)).toBe('HAVING');
    });

    it('does not detect HAVING when cursor is still in GROUP BY', () => {
      const text = 'SELECT col1, COUNT(*) FROM t GROUP BY ';
      expect(detectContext(text)).toBe('GROUP_BY');
    });
  });

  describe('Aggregate priority in HAVING (Requirement 7.1)', () => {
    it('includes aggregate function snippets in HAVING context completions', () => {
      const schemaCache = createMockSchemaCache({
        tables: [{
          schema: 'dbo',
          name: 'Orders',
          columns: [
            { name: 'CustomerID', dataType: 'int', isNullable: false },
            { name: 'Amount', dataType: 'decimal', isNullable: false },
          ],
        }],
      });

      const sql = 'SELECT o.CustomerID, SUM(o.Amount) FROM Orders o GROUP BY o.CustomerID HAVING ';
      const completions = getCompletions(sql, sql.length, schemaCache, true);

      // Should include aggregate function snippets (COUNT, SUM, AVG, etc.)
      const aggregateFunctions = completions.filter(
        item => item.kind === CompletionItemKind.Function &&
                item.detail === 'Aggregate Function'
      );
      expect(aggregateFunctions.length).toBeGreaterThan(0);

      // Verify specific aggregate functions are present
      const labels = aggregateFunctions.map(item => item.label);
      expect(labels).toContain('COUNT');
      expect(labels).toContain('SUM');
      expect(labels).toContain('AVG');
      expect(labels).toContain('MIN');
      expect(labels).toContain('MAX');
    });

    it('aggregate function snippets have correct structure in HAVING', () => {
      const schemaCache = createMockSchemaCache({
        tables: [{
          schema: 'dbo',
          name: 'Orders',
          columns: [
            { name: 'CustomerID', dataType: 'int', isNullable: false },
            { name: 'Amount', dataType: 'decimal', isNullable: false },
          ],
        }],
      });

      const sql = 'SELECT o.CustomerID, SUM(o.Amount) FROM Orders o GROUP BY o.CustomerID HAVING ';
      const completions = getCompletions(sql, sql.length, schemaCache, true);

      const sumItem = completions.find(
        item => item.label === 'SUM' && item.kind === CompletionItemKind.Function
      );
      expect(sumItem).toBeDefined();
      expect(sumItem!.insertText).toBe('SUM($1)');
      expect(sumItem!.insertTextFormat).toBe(InsertTextFormat.Snippet);
      expect(sumItem!.command).toBeDefined();
      expect(sumItem!.command!.command).toBe('editor.action.triggerSuggest');
    });
  });

  describe('Column suggestions in HAVING outside aggregate (Requirement 7.3)', () => {
    it('suggests only GROUP BY columns when outside aggregate in HAVING', () => {
      const schemaCache = createMockSchemaCache({
        tables: [{
          schema: 'dbo',
          name: 'Orders',
          columns: [
            { name: 'CustomerID', dataType: 'int', isNullable: false },
            { name: 'Amount', dataType: 'decimal', isNullable: false },
            { name: 'OrderDate', dataType: 'datetime', isNullable: false },
          ],
        }],
      });

      const sql = 'SELECT o.CustomerID, SUM(o.Amount) FROM Orders o GROUP BY o.CustomerID HAVING ';
      const completions = getCompletions(sql, sql.length, schemaCache, true);

      // Should include GROUP BY columns as field completions
      const fieldItems = completions.filter(
        item => item.kind === CompletionItemKind.Field && item.detail === 'GROUP BY column'
      );
      expect(fieldItems.length).toBeGreaterThan(0);

      // Should include o.CustomerID (the GROUP BY column)
      const customerIdItem = fieldItems.find(item => item.label === 'o.CustomerID');
      expect(customerIdItem).toBeDefined();

      // Should NOT include columns not in GROUP BY (Amount, OrderDate) as GROUP BY column items
      const amountItem = fieldItems.find(item => item.label === 'o.Amount');
      expect(amountItem).toBeUndefined();
      const orderDateItem = fieldItems.find(item => item.label === 'o.OrderDate');
      expect(orderDateItem).toBeUndefined();
    });

    it('suggests multiple GROUP BY columns when multiple are present', () => {
      const schemaCache = createMockSchemaCache({
        tables: [{
          schema: 'dbo',
          name: 'Orders',
          columns: [
            { name: 'CustomerID', dataType: 'int', isNullable: false },
            { name: 'OrderDate', dataType: 'datetime', isNullable: false },
            { name: 'Amount', dataType: 'decimal', isNullable: false },
          ],
        }],
      });

      const sql = 'SELECT o.CustomerID, o.OrderDate, SUM(o.Amount) FROM Orders o GROUP BY o.CustomerID, o.OrderDate HAVING ';
      const completions = getCompletions(sql, sql.length, schemaCache, true);

      const fieldItems = completions.filter(
        item => item.kind === CompletionItemKind.Field && item.detail === 'GROUP BY column'
      );

      const labels = fieldItems.map(item => item.label);
      expect(labels).toContain('o.CustomerID');
      expect(labels).toContain('o.OrderDate');
    });
  });

  describe('Column suggestions inside aggregate in HAVING (Requirement 7.2)', () => {
    it('suggests all columns when inside aggregate function in HAVING', () => {
      const schemaCache = createMockSchemaCache({
        tables: [{
          schema: 'dbo',
          name: 'Orders',
          columns: [
            { name: 'CustomerID', dataType: 'int', isNullable: false },
            { name: 'Amount', dataType: 'decimal', isNullable: false },
            { name: 'OrderDate', dataType: 'datetime', isNullable: false },
          ],
        }],
      });

      // Cursor is inside SUM() in HAVING clause — aggregation context detection kicks in
      const sql = 'SELECT o.CustomerID, SUM(o.Amount) FROM Orders o GROUP BY o.CustomerID HAVING SUM(';
      const completions = getCompletions(sql, sql.length, schemaCache, true);

      // Inside an aggregate in HAVING, all columns from referenced tables should be available
      const fieldItems = completions.filter(item => item.kind === CompletionItemKind.Field);
      expect(fieldItems.length).toBeGreaterThan(0);

      // All columns should be available (not just GROUP BY columns)
      const labels = fieldItems.map(item => item.label as string);
      // Should include columns from the Orders table
      expect(labels.some(l => l.includes('CustomerID'))).toBe(true);
      expect(labels.some(l => l.includes('Amount'))).toBe(true);
      expect(labels.some(l => l.includes('OrderDate'))).toBe(true);
    });

    it('suggests all columns inside COUNT() in HAVING including star', () => {
      const schemaCache = createMockSchemaCache({
        tables: [{
          schema: 'dbo',
          name: 'Orders',
          columns: [
            { name: 'CustomerID', dataType: 'int', isNullable: false },
            { name: 'Amount', dataType: 'decimal', isNullable: false },
          ],
        }],
      });

      const sql = 'SELECT o.CustomerID, COUNT(*) FROM Orders o GROUP BY o.CustomerID HAVING COUNT(';
      const completions = getCompletions(sql, sql.length, schemaCache, true);

      // COUNT supports *, so * should be in the list
      const starItem = completions.find(item => item.label === '*');
      expect(starItem).toBeDefined();

      // All columns should also be available
      const fieldItems = completions.filter(item => item.kind === CompletionItemKind.Field);
      expect(fieldItems.length).toBeGreaterThan(0);
    });

    it('ranks numeric columns higher inside SUM() in HAVING', () => {
      const schemaCache = createMockSchemaCache({
        tables: [{
          schema: 'dbo',
          name: 'Orders',
          columns: [
            { name: 'CustomerID', dataType: 'int', isNullable: false },
            { name: 'Amount', dataType: 'decimal', isNullable: false },
            { name: 'Status', dataType: 'varchar', isNullable: false },
          ],
        }],
      });

      const sql = 'SELECT o.CustomerID, SUM(o.Amount) FROM Orders o GROUP BY o.CustomerID HAVING SUM(';
      const completions = getCompletions(sql, sql.length, schemaCache, true);

      // Numeric columns should have lower sortText (higher priority)
      const numericItems = completions.filter(
        item => item.kind === CompletionItemKind.Field &&
                (item.label as string).includes('Amount') || (item.label as string).includes('CustomerID')
      );
      const nonNumericItems = completions.filter(
        item => item.kind === CompletionItemKind.Field &&
                (item.label as string).includes('Status')
      );

      // Numeric columns should exist
      expect(numericItems.length).toBeGreaterThan(0);
      // Non-numeric columns should also exist (but ranked lower)
      expect(nonNumericItems.length).toBeGreaterThan(0);

      // Verify numeric columns have lower sortText than non-numeric
      for (const numItem of numericItems) {
        for (const nonNumItem of nonNumericItems) {
          if (numItem.sortText && nonNumItem.sortText) {
            expect(numItem.sortText < nonNumItem.sortText).toBe(true);
          }
        }
      }
    });
  });
});
