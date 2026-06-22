import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Range } from 'vscode-languageserver/node';
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

/**
 * Helper to create a TextDocument and Range on the `*` character.
 */
function createDocAndStarRange(content: string): { doc: TextDocument; range: Range } {
  const doc = TextDocument.create('file:///test.sql', 'sql', 1, content);
  const starPos = content.indexOf('*');
  const position = doc.positionAt(starPos);
  const range: Range = {
    start: position,
    end: { line: position.line, character: position.character + 1 },
  };
  return { doc, range };
}

describe('SelectExpander', () => {
  describe('No tables resolved → no code action offered (Requirement 10.6)', () => {
    it('returns empty array when the referenced table is not in the schema cache', () => {
      const content = 'SELECT * FROM dbo.UnknownTable';
      const { doc, range } = createDocAndStarRange(content);

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

      const actions = getExpandStarActions(doc, range, schemaCache);
      expect(actions).toHaveLength(0);
    });

    it('returns empty array when schema cache has no tables at all', () => {
      const content = 'SELECT * FROM dbo.Orders';
      const { doc, range } = createDocAndStarRange(content);

      const schemaCache = createMockSchemaCache({ tables: [], views: [] });

      const actions = getExpandStarActions(doc, range, schemaCache);
      expect(actions).toHaveLength(0);
    });
  });

  describe('Single table expansion without prefix (Requirement 10.4)', () => {
    it('expands * to column names without table prefix for a single table', () => {
      const content = 'SELECT * FROM dbo.Orders';
      const { doc, range } = createDocAndStarRange(content);

      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'Orders',
            columns: [
              { name: 'OrderId', dataType: 'int', isNullable: false },
              { name: 'Name', dataType: 'nvarchar', isNullable: true },
              { name: 'Date', dataType: 'datetime', isNullable: true },
            ],
          },
        ],
      });

      const actions = getExpandStarActions(doc, range, schemaCache);
      expect(actions).toHaveLength(1);
      expect(actions[0].title).toBe('Expand SELECT * to column list');

      const edit = actions[0].edit!;
      const changes = edit.changes!['file:///test.sql'];
      expect(changes).toHaveLength(1);

      const newText = changes[0].newText;
      // Single table: no prefix on columns
      expect(newText).toContain('OrderId');
      expect(newText).toContain('Name');
      expect(newText).toContain('Date');
      // Should NOT have table prefix
      expect(newText).not.toContain('Orders.');
      expect(newText).not.toContain('dbo.');
    });
  });

  describe('Multi-table expansion with alias prefixes (Requirement 10.3)', () => {
    it('expands * to columns prefixed with aliases when multiple tables are referenced', () => {
      const content = 'SELECT * FROM dbo.Orders o JOIN dbo.Customers c ON o.CustomerId = c.Id';
      const { doc, range } = createDocAndStarRange(content);

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
      });

      const actions = getExpandStarActions(doc, range, schemaCache);
      expect(actions).toHaveLength(1);

      const edit = actions[0].edit!;
      const changes = edit.changes!['file:///test.sql'];
      const newText = changes[0].newText;

      // Multiple tables: columns should be prefixed with aliases
      expect(newText).toContain('o.OrderId');
      expect(newText).toContain('o.CustomerId');
      expect(newText).toContain('c.Id');
      expect(newText).toContain('c.Name');
    });

    it('uses table name as prefix when no alias is defined', () => {
      const content = 'SELECT * FROM dbo.Orders JOIN dbo.Customers ON Orders.CustomerId = Customers.Id';
      const { doc, range } = createDocAndStarRange(content);

      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'Orders',
            columns: [
              { name: 'OrderId', dataType: 'int', isNullable: false },
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
      });

      const actions = getExpandStarActions(doc, range, schemaCache);
      expect(actions).toHaveLength(1);

      const edit = actions[0].edit!;
      const changes = edit.changes!['file:///test.sql'];
      const newText = changes[0].newText;

      // Should use table name as prefix when no alias
      expect(newText).toContain('Orders.OrderId');
      expect(newText).toContain('Customers.Id');
    });
  });

  describe('Partial resolution skips unresolved tables (Requirement 10.5)', () => {
    it('expands only resolved table columns and skips unresolved tables', () => {
      const content = 'SELECT * FROM dbo.Orders o JOIN UnknownTable u ON o.Id = u.OrderId';
      const { doc, range } = createDocAndStarRange(content);

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

      const actions = getExpandStarActions(doc, range, schemaCache);
      expect(actions).toHaveLength(1);

      const edit = actions[0].edit!;
      const changes = edit.changes!['file:///test.sql'];
      const newText = changes[0].newText;

      // Only Orders columns should appear (it's the only resolved table)
      expect(newText).toContain('OrderId');
      expect(newText).toContain('Name');
      // UnknownTable columns should not appear
      expect(newText).not.toContain('u.');
    });
  });

  describe('Indentation matches SELECT keyword line (Requirement 10.2)', () => {
    it('indents expanded columns to match the SELECT keyword line indentation', () => {
      const content = '    SELECT * FROM dbo.Orders';
      const { doc, range } = createDocAndStarRange(content);

      const schemaCache = createMockSchemaCache({
        tables: [
          {
            schema: 'dbo',
            name: 'Orders',
            columns: [
              { name: 'OrderId', dataType: 'int', isNullable: false },
              { name: 'Name', dataType: 'nvarchar', isNullable: true },
              { name: 'Date', dataType: 'datetime', isNullable: true },
            ],
          },
        ],
      });

      const actions = getExpandStarActions(doc, range, schemaCache);
      expect(actions).toHaveLength(1);

      const edit = actions[0].edit!;
      const changes = edit.changes!['file:///test.sql'];
      const newText = changes[0].newText;

      // The expanded columns should have indentation matching the SELECT keyword line
      // SELECT is indented with 4 spaces, so continuation lines should have
      // 4 spaces (SELECT indent) + 7 spaces ("SELECT " width) = 11 spaces
      const lines = newText.split('\n');
      // First column is on the same line as SELECT (replaces *), subsequent lines are indented
      if (lines.length > 1) {
        for (let i = 1; i < lines.length; i++) {
          // Each continuation line should start with the indentation
          expect(lines[i]).toMatch(/^\s+/);
          // The indentation should include the 4 spaces from SELECT line + 7 for "SELECT "
          expect(lines[i].startsWith('           ')).toBe(true); // 4 + 7 = 11 spaces
        }
      }
    });

    it('handles zero indentation correctly', () => {
      const content = 'SELECT * FROM dbo.Orders';
      const { doc, range } = createDocAndStarRange(content);

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

      const actions = getExpandStarActions(doc, range, schemaCache);
      expect(actions).toHaveLength(1);

      const edit = actions[0].edit!;
      const changes = edit.changes!['file:///test.sql'];
      const newText = changes[0].newText;

      // With no indentation on SELECT, continuation lines should have 7 spaces ("SELECT ")
      const lines = newText.split('\n');
      if (lines.length > 1) {
        for (let i = 1; i < lines.length; i++) {
          expect(lines[i].startsWith('       ')).toBe(true); // 7 spaces for "SELECT "
        }
      }
    });
  });
});
