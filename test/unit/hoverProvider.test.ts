import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Position, MarkupKind } from 'vscode-languageserver/node';
import { getHoverInfo } from '../../server/src/hoverProvider';
import { ISchemaCache, TableInfo, ViewInfo, ForeignKeyInfo } from '../../server/src/schemaCache';
import * as mssql from 'mssql';

/**
 * Helper to create a mock ISchemaCache for testing.
 */
function createMockSchemaCache(options: {
  tables?: TableInfo[];
  views?: ViewInfo[];
  foreignKeys?: ForeignKeyInfo[];
  primaryKeys?: Map<string, string[]>;
  isPopulating?: boolean;
}): ISchemaCache {
  const tables = options.tables || [];
  const views = options.views || [];
  const foreignKeys = options.foreignKeys || [];
  const primaryKeys = options.primaryKeys || new Map<string, string[]>();
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
    getPrimaryKeyColumns(schema: string, tableName: string): string[] {
      const key = `${schema}.${tableName}`.toLowerCase();
      return primaryKeys.get(key) || [];
    },
  };
}

/**
 * Helper to create a TextDocument and Position on a specific identifier.
 */
function createDocAndPosition(content: string, identifier: string): { doc: TextDocument; position: Position } {
  const doc = TextDocument.create('file:///test.sql', 'sql', 1, content);
  const offset = content.indexOf(identifier);
  const position = doc.positionAt(offset);
  return { doc, position };
}

describe('HoverProvider', () => {
  describe('Unresolved table returns null (Requirement 11.3)', () => {
    it('returns null when hovering over a table name not in the schema cache', () => {
      const content = 'SELECT * FROM dbo.UnknownTable';
      const { doc, position } = createDocAndPosition(content, 'UnknownTable');

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
      });

      const result = getHoverInfo(doc, position, schemaCache);
      expect(result).toBeNull();
    });
  });

  describe('Schema cache populating returns null (Requirement 11.4)', () => {
    it('returns null when schema cache is still populating', () => {
      const content = 'SELECT * FROM dbo.Orders';
      const { doc, position } = createDocAndPosition(content, 'Orders');

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
  });

  describe('Table with zero columns returns null (Requirement 11.1)', () => {
    it('returns null when the table exists but has an empty columns array', () => {
      const content = 'SELECT * FROM dbo.EmptyTable';
      const { doc, position } = createDocAndPosition(content, 'EmptyTable');

      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'EmptyTable',
            columns: [],
          },
        ],
      });

      const result = getHoverInfo(doc, position, schemaCache);
      expect(result).toBeNull();
    });
  });

  describe('Column with Foreign Key indicator (Requirement 12.3)', () => {
    it('shows Foreign Key reference in hover when column is a FK referencing column', () => {
      const content = 'SELECT CustomerId FROM dbo.Orders';
      const { doc, position } = createDocAndPosition(content, 'CustomerId');

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

      const result = getHoverInfo(doc, position, schemaCache);
      expect(result).not.toBeNull();
      expect(result!.contents).toHaveProperty('kind', MarkupKind.Markdown);
      const value = (result!.contents as { kind: string; value: string }).value;
      expect(value).toContain('Foreign Key → dbo.Customers.Id');
    });
  });

  describe('Column with Primary Key indicator (Requirement 3.1)', () => {
    it('shows Primary Key indicator when column is part of the PK', () => {
      const content = 'SELECT OrderId FROM dbo.Orders';
      const { doc, position } = createDocAndPosition(content, 'OrderId');

      const primaryKeys = new Map<string, string[]>();
      primaryKeys.set('dbo.orders', ['OrderId']);

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
        primaryKeys,
      });

      const result = getHoverInfo(doc, position, schemaCache);
      expect(result).not.toBeNull();
      const value = (result!.contents as { kind: string; value: string }).value;
      expect(value).toContain('Primary Key');
      expect(value).toContain('**OrderId**');
      expect(value).toContain('int');
      expect(value).toContain('not null');
      expect(value).toContain('dbo.Orders');
    });

    it('does not show Primary Key indicator when column is not a PK', () => {
      const content = 'SELECT Name FROM dbo.Orders';
      const { doc, position } = createDocAndPosition(content, 'Name');

      const primaryKeys = new Map<string, string[]>();
      primaryKeys.set('dbo.orders', ['OrderId']);

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
        primaryKeys,
      });

      const result = getHoverInfo(doc, position, schemaCache);
      expect(result).not.toBeNull();
      const value = (result!.contents as { kind: string; value: string }).value;
      expect(value).not.toContain('Primary Key');
      expect(value).toContain('**Name**');
    });

    it('shows both Primary Key and Foreign Key when column is both PK and FK (Requirement 3.4)', () => {
      const content = 'SELECT CustomerId FROM dbo.OrderItems';
      const { doc, position } = createDocAndPosition(content, 'CustomerId');

      const primaryKeys = new Map<string, string[]>();
      primaryKeys.set('dbo.orderitems', ['CustomerId']);

      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'OrderItems',
            columns: [
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
        ],
        foreignKeys: [
          {
            constraintName: 'FK_OrderItems_Customers',
            referencingSchema: 'dbo',
            referencingTable: 'OrderItems',
            referencedSchema: 'dbo',
            referencedTable: 'Customers',
            columnPairs: [
              { referencingColumn: 'CustomerId', referencedColumn: 'Id', ordinalPosition: 1 },
            ],
          },
        ],
        primaryKeys,
      });

      const result = getHoverInfo(doc, position, schemaCache);
      expect(result).not.toBeNull();
      const value = (result!.contents as { kind: string; value: string }).value;
      expect(value).toContain('Primary Key');
      expect(value).toContain('Foreign Key → dbo.Customers.Id');
      // Verify ordering: Primary Key appears before Foreign Key
      const pkIndex = value.indexOf('Primary Key');
      const fkIndex = value.indexOf('Foreign Key');
      expect(pkIndex).toBeLessThan(fkIndex);
    });

    it('uses case-insensitive matching for PK column names (Requirement 4.1)', () => {
      const content = 'SELECT orderid FROM dbo.Orders';
      const { doc, position } = createDocAndPosition(content, 'orderid');

      const primaryKeys = new Map<string, string[]>();
      primaryKeys.set('dbo.orders', ['OrderId']);

      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'Orders',
            columns: [
              { name: 'orderid', dataType: 'int', isNullable: false },
            ],
          },
        ],
        primaryKeys,
      });

      const result = getHoverInfo(doc, position, schemaCache);
      expect(result).not.toBeNull();
      const value = (result!.contents as { kind: string; value: string }).value;
      expect(value).toContain('Primary Key');
    });
  });

  describe('Ambiguous column graceful degradation (Requirement 12.4)', () => {
    it('shows all matching columns grouped by table for ambiguous column', () => {
      const content = 'SELECT Name FROM dbo.Orders JOIN dbo.Customers ON Orders.CustomerId = Customers.Id';
      const { doc, position } = createDocAndPosition(content, 'Name');

      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'Orders',
            columns: [
              { name: 'OrderId', dataType: 'int', isNullable: false },
              { name: 'CustomerId', dataType: 'int', isNullable: false },
              { name: 'Name', dataType: 'nvarchar', isNullable: true },
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
      });

      const result = getHoverInfo(doc, position, schemaCache);
      expect(result).not.toBeNull();
      const value = (result!.contents as { kind: string; value: string }).value;
      expect(value).toContain('(ambiguous)');
      expect(value).toContain('dbo.Orders');
      expect(value).toContain('dbo.Customers');
    });
  });

  describe('Unresolved column returns null (Requirement 12.5)', () => {
    it('returns null when hovering over a column that does not exist in any referenced table', () => {
      const content = 'SELECT NonExistentCol FROM dbo.Orders';
      const { doc, position } = createDocAndPosition(content, 'NonExistentCol');

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

      const result = getHoverInfo(doc, position, schemaCache);
      expect(result).toBeNull();
    });
  });

  describe('Unresolved view returns null (Requirement 13.2)', () => {
    it('returns null when hovering over a view name not in the schema cache', () => {
      const content = 'SELECT * FROM dbo.UnknownView';
      const { doc, position } = createDocAndPosition(content, 'UnknownView');

      const schemaCache = createMockSchemaCache({
        tables: [],
        views: [
          {
            schema: 'dbo',
            name: 'ActiveOrders',
            columns: [
              { name: 'OrderId', dataType: 'int', isNullable: false },
            ],
          },
        ],
      });

      const result = getHoverInfo(doc, position, schemaCache);
      expect(result).toBeNull();
    });
  });
});
