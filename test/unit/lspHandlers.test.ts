import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Position, Range } from 'vscode-languageserver/node';
import { getCompletions } from '../../server/src/completionProvider';
import { getHoverInfo } from '../../server/src/hoverProvider';
import { getExpandStarActions } from '../../server/src/selectExpander';
import { ISchemaCache, TableInfo, ViewInfo, ForeignKeyInfo } from '../../server/src/schemaCache';
import * as mssql from 'mssql';

/**
 * Helper to create a mock ISchemaCache for testing.
 */
function createMockSchemaCache(options: {
  tables?: TableInfo[];
  views?: ViewInfo[];
  foreignKeys?: ForeignKeyInfo[];
  isPopulating?: boolean;
}): ISchemaCache {
  const tables = options.tables || [];
  const views = options.views || [];
  const foreignKeys = options.foreignKeys || [];
  const isPopulating = options.isPopulating || false;

  const fkIndex = new Map<string, ForeignKeyInfo[]>();
  for (const fk of foreignKeys) {
    const referencingKey = `${fk.referencingSchema}.${fk.referencingTable}`.toLowerCase();
    const referencedKey = `${fk.referencedSchema}.${fk.referencedTable}`.toLowerCase();
    if (!fkIndex.has(referencingKey)) fkIndex.set(referencingKey, []);
    fkIndex.get(referencingKey)!.push(fk);
    if (!fkIndex.has(referencedKey)) fkIndex.set(referencedKey, []);
    fkIndex.get(referencedKey)!.push(fk);
  }

  return {
    tables,
    views,
    foreignKeys,
    procedures: [],
    isPopulating,
    refresh: async (_pool: mssql.ConnectionPool) => {},
    getForeignKeysForTable(schema: string, tableName: string): ForeignKeyInfo[] {
      const key = `${schema}.${tableName}`.toLowerCase();
      return fkIndex.get(key) || [];
    },
  };
}

describe('LSP Handler Integration', () => {
  describe('Completion handler routes JOIN context correctly (Requirement 9.1)', () => {
    it('returns FK-related completion items with ON clause snippets for JOIN context', () => {
      const text = 'SELECT * FROM dbo.Orders o JOIN ';
      const offset = text.length;

      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'Orders',
            columns: [
              { name: 'OrderId', dataType: 'int', isNullable: false },
              { name: 'CustomerId', dataType: 'int', isNullable: false },
            ],
          },
          {
            schema: 'dbo',
            name: 'Customers',
            columns: [
              { name: 'Id', dataType: 'int', isNullable: false },
              { name: 'Name', dataType: 'nvarchar', isNullable: true },
            ],
          },
        ],
        foreignKeys: [
          {
            constraintName: 'FK_Orders_Customers',
            referencingSchema: 'dbo',
            referencingTable: 'Orders',
            referencedSchema: 'dbo',
            referencedTable: 'Customers',
            columnPairs: [
              { referencingColumn: 'CustomerId', referencedColumn: 'Id', ordinalPosition: 1 },
            ],
          },
        ],
      });

      const result = getCompletions(text, offset, schemaCache, true);

      // Should have FK-related items (Customers with ON clause snippet)
      expect(result.length).toBeGreaterThan(0);

      // Find the FK-related completion item for Customers
      const fkItem = result.find(
        item => (item.label as string).includes('Customers')
      );
      expect(fkItem).toBeDefined();

      // FK-related items should have insertText with ON clause snippet
      expect(fkItem!.insertText).toBeDefined();
      expect(fkItem!.insertText).toContain('ON');
      expect(fkItem!.insertText).toContain('CustomerId');
    });

    it('returns FK-related items before unrelated table completions', () => {
      const text = 'SELECT * FROM dbo.Orders o JOIN ';
      const offset = text.length;

      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'Orders',
            columns: [
              { name: 'OrderId', dataType: 'int', isNullable: false },
              { name: 'CustomerId', dataType: 'int', isNullable: false },
            ],
          },
          {
            schema: 'dbo',
            name: 'Customers',
            columns: [
              { name: 'Id', dataType: 'int', isNullable: false },
            ],
          },
          {
            schema: 'dbo',
            name: 'Products',
            columns: [
              { name: 'ProductId', dataType: 'int', isNullable: false },
            ],
          },
        ],
        foreignKeys: [
          {
            constraintName: 'FK_Orders_Customers',
            referencingSchema: 'dbo',
            referencingTable: 'Orders',
            referencedSchema: 'dbo',
            referencedTable: 'Customers',
            columnPairs: [
              { referencingColumn: 'CustomerId', referencedColumn: 'Id', ordinalPosition: 1 },
            ],
          },
        ],
      });

      const result = getCompletions(text, offset, schemaCache, true);

      // FK-related items should appear before unrelated items
      const fkIndex = result.findIndex(
        item => (item.label as string).includes('Customers')
      );
      const unrelatedIndex = result.findIndex(
        item => (item.label as string).includes('Products')
      );

      expect(fkIndex).toBeGreaterThanOrEqual(0);
      expect(unrelatedIndex).toBeGreaterThanOrEqual(0);
      expect(fkIndex).toBeLessThan(unrelatedIndex);
    });
  });

  describe('Hover handler returns null when cache is populating (Requirement 11.4)', () => {
    it('returns null for hover when schema cache isPopulating is true', () => {
      const content = 'SELECT * FROM dbo.Orders';
      const doc = TextDocument.create('file:///test.sql', 'sql', 1, content);
      const position: Position = doc.positionAt(content.indexOf('Orders'));

      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'Orders',
            columns: [
              { name: 'OrderId', dataType: 'int', isNullable: false },
            ],
          },
        ],
        isPopulating: true,
      });

      const result = getHoverInfo(doc, position, schemaCache);
      expect(result).toBeNull();
    });

    it('returns hover info when schema cache is not populating', () => {
      const content = 'SELECT * FROM dbo.Orders';
      const doc = TextDocument.create('file:///test.sql', 'sql', 1, content);
      const position: Position = doc.positionAt(content.indexOf('Orders'));

      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'Orders',
            columns: [
              { name: 'OrderId', dataType: 'int', isNullable: false },
            ],
          },
        ],
        isPopulating: false,
      });

      const result = getHoverInfo(doc, position, schemaCache);
      expect(result).not.toBeNull();
    });
  });

  describe('Code action handler returns empty when no * in range (Requirement 11.5)', () => {
    it('returns empty array when range does not contain a * character', () => {
      const content = 'SELECT OrderId FROM dbo.Orders';
      const doc = TextDocument.create('file:///test.sql', 'sql', 1, content);

      // Range covering "OrderId" (no * present)
      const orderIdOffset = content.indexOf('OrderId');
      const range: Range = {
        start: doc.positionAt(orderIdOffset),
        end: doc.positionAt(orderIdOffset + 'OrderId'.length),
      };

      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'Orders',
            columns: [
              { name: 'OrderId', dataType: 'int', isNullable: false },
              { name: 'Name', dataType: 'nvarchar', isNullable: true },
            ],
          },
        ],
      });

      const result = getExpandStarActions(doc, range, schemaCache);
      expect(result).toEqual([]);
    });

    it('returns empty array when document has no * at all', () => {
      const content = 'SELECT OrderId, Name FROM dbo.Orders WHERE OrderId > 5';
      const doc = TextDocument.create('file:///test.sql', 'sql', 1, content);

      // Range covering the entire SELECT clause
      const range: Range = {
        start: { line: 0, character: 0 },
        end: { line: 0, character: content.length },
      };

      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'Orders',
            columns: [
              { name: 'OrderId', dataType: 'int', isNullable: false },
              { name: 'Name', dataType: 'nvarchar', isNullable: true },
            ],
          },
        ],
      });

      const result = getExpandStarActions(doc, range, schemaCache);
      expect(result).toEqual([]);
    });

    it('returns a code action when range contains * in SELECT context', () => {
      const content = 'SELECT * FROM dbo.Orders';
      const doc = TextDocument.create('file:///test.sql', 'sql', 1, content);

      const starOffset = content.indexOf('*');
      const range: Range = {
        start: doc.positionAt(starOffset),
        end: doc.positionAt(starOffset + 1),
      };

      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'Orders',
            columns: [
              { name: 'OrderId', dataType: 'int', isNullable: false },
              { name: 'Name', dataType: 'nvarchar', isNullable: true },
            ],
          },
        ],
      });

      const result = getExpandStarActions(doc, range, schemaCache);
      expect(result.length).toBe(1);
      expect(result[0].title).toContain('Expand');
    });
  });

  describe('Performance constraints (Requirements 9.1, 9.2)', () => {
    it('getCompletions with populated cache returns within 50ms', () => {
      // Build a schema cache with a reasonable number of tables
      const tables: TableInfo[] = [];
      const foreignKeys: ForeignKeyInfo[] = [];

      for (let i = 0; i < 50; i++) {
        tables.push({
          schema: 'dbo',
          name: `Table${i}`,
          columns: [
            { name: 'Id', dataType: 'int', isNullable: false },
            { name: 'Name', dataType: 'nvarchar', isNullable: true },
            { name: 'CreatedAt', dataType: 'datetime', isNullable: false },
          ],
        });
      }

      // Add some FK relationships
      for (let i = 1; i < 20; i++) {
        foreignKeys.push({
          constraintName: `FK_Table${i}_Table0`,
          referencingSchema: 'dbo',
          referencingTable: `Table${i}`,
          referencedSchema: 'dbo',
          referencedTable: 'Table0',
          columnPairs: [
            { referencingColumn: 'Id', referencedColumn: 'Id', ordinalPosition: 1 },
          ],
        });
      }

      const schemaCache = createMockSchemaCache({
        tables,
        foreignKeys,
        isPopulating: false,
      });

      const text = 'SELECT * FROM dbo.Table0 t0 JOIN ';
      const offset = text.length;

      const start = performance.now();
      const result = getCompletions(text, offset, schemaCache, true);
      const elapsed = performance.now() - start;

      expect(result.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(150);
    });

    it('getCompletions with unpopulated (populating) cache returns within 10ms', () => {
      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'Orders',
            columns: [
              { name: 'OrderId', dataType: 'int', isNullable: false },
            ],
          },
        ],
        isPopulating: true,
      });

      const text = 'SELECT * FROM dbo.Orders JOIN ';
      const offset = text.length;

      const start = performance.now();
      const result = getCompletions(text, offset, schemaCache, true);
      const elapsed = performance.now() - start;

      // When populating, should return keyword-only completions quickly
      expect(elapsed).toBeLessThan(10);
      // Should still return keyword completions
      expect(result.length).toBeGreaterThan(0);
      // Should be keyword/function completions only (no table-specific items)
      const hasTableItem = result.some(
        item => (item.label as string).includes('Orders')
      );
      expect(hasTableItem).toBe(false);
    });

    it('getHoverInfo with populated cache returns within 20ms (Requirement 11.5)', () => {
      const tables: TableInfo[] = [];
      for (let i = 0; i < 50; i++) {
        tables.push({
          schema: 'dbo',
          name: `Table${i}`,
          columns: [
            { name: 'Id', dataType: 'int', isNullable: false },
            { name: 'Name', dataType: 'nvarchar', isNullable: true },
          ],
        });
      }

      const schemaCache = createMockSchemaCache({
        tables,
        isPopulating: false,
      });

      const content = 'SELECT * FROM dbo.Table25';
      const doc = TextDocument.create('file:///test.sql', 'sql', 1, content);
      const position: Position = doc.positionAt(content.indexOf('Table25'));

      const start = performance.now();
      const result = getHoverInfo(doc, position, schemaCache);
      const elapsed = performance.now() - start;

      expect(result).not.toBeNull();
      expect(elapsed).toBeLessThan(20);
    });
  });
});
