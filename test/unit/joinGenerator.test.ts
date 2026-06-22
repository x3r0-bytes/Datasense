import { describe, it, expect } from 'vitest';
import { getJoinCompletions, JoinCompletionContext } from '../../server/src/joinGenerator';
import { ISchemaCache, TableInfo, ViewInfo, ForeignKeyInfo } from '../../server/src/schemaCache';
import { TableReference } from '../../server/src/completionProvider';
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

  // Build FK index: map each table key to its FK records
  const fkIndex = new Map<string, ForeignKeyInfo[]>();
  for (const fk of foreignKeys) {
    const referencingKey = `${fk.referencingSchema}.${fk.referencingTable}`.toLowerCase();
    const referencedKey = `${fk.referencedSchema}.${fk.referencedTable}`.toLowerCase();

    if (!fkIndex.has(referencingKey)) {
      fkIndex.set(referencingKey, []);
    }
    fkIndex.get(referencingKey)!.push(fk);

    if (!fkIndex.has(referencedKey)) {
      fkIndex.set(referencedKey, []);
    }
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

describe('JoinGenerator', () => {
  describe('Self-referencing FK completion item (Requirement 3.7)', () => {
    it('includes the source table as a target with self-referencing indication in detail', () => {
      const selfRefFK: ForeignKeyInfo = {
        constraintName: 'FK_Employee_Manager',
        referencingSchema: 'dbo',
        referencingTable: 'Employee',
        referencedSchema: 'dbo',
        referencedTable: 'Employee',
        columnPairs: [
          { referencingColumn: 'ManagerId', referencedColumn: 'Id', ordinalPosition: 1 },
        ],
      };

      const schemaCache = createMockSchemaCache({
        tables: [
          { schema: 'dbo', name: 'Employee', columns: [] },
        ],
        foreignKeys: [selfRefFK],
      });

      const context: JoinCompletionContext = {
        sourceTableRefs: [{ schema: 'dbo', name: 'Employee', alias: 'e' }],
        existingAliases: ['e'],
        prefix: '',
      };

      const result = getJoinCompletions(context, schemaCache);

      // Should have at least one FK-related item for the self-referencing FK
      const fkItems = result.items.filter(item => item.detail?.startsWith('FK'));
      expect(fkItems.length).toBeGreaterThanOrEqual(1);

      // The FK item should reference Employee as the target
      const selfRefItem = fkItems.find(item =>
        (item.label as string).toLowerCase().includes('employee')
      );
      expect(selfRefItem).toBeDefined();

      // Detail should indicate the relationship direction and column names
      expect(selfRefItem!.detail).toContain('ManagerId');
      expect(selfRefItem!.detail).toContain('Id');
    });
  });

  describe('Non-FK completion format (Requirement 4.7)', () => {
    it('inserts table + alias without ON clause with $0 after alias', () => {
      const schemaCache = createMockSchemaCache({
        tables: [
          { schema: 'dbo', name: 'Orders', columns: [] },
          { schema: 'dbo', name: 'Products', columns: [] },
        ],
        foreignKeys: [], // No FK relationships
      });

      const context: JoinCompletionContext = {
        sourceTableRefs: [{ schema: 'dbo', name: 'Orders', alias: 'o' }],
        existingAliases: ['o'],
        prefix: '',
      };

      const result = getJoinCompletions(context, schemaCache);

      // Should return all tables without ON clause (fallback behavior)
      expect(result.items.length).toBeGreaterThan(0);

      // Each item should have insertText format: TableName ${1:alias}$0
      for (const item of result.items) {
        const insertText = item.insertText as string;
        // Should contain ${1:...} for alias tab stop
        expect(insertText).toMatch(/\$\{1:[a-z0-9]+\}/);
        // Should end with $0 (final cursor position after alias)
        expect(insertText).toMatch(/\$\{1:[a-z0-9]+\}\$0$/);
        // Should NOT contain ON clause
        expect(insertText).not.toContain(' ON ');
      }
    });
  });

  describe('Multiple source tables with overlapping FK targets (Requirement 3.3)', () => {
    it('consolidates FK items targeting the same table into a single completion item with AND conditions', () => {
      // Both Orders and Invoices have FK to Customers
      const fk1: ForeignKeyInfo = {
        constraintName: 'FK_Orders_Customers',
        referencingSchema: 'dbo',
        referencingTable: 'Orders',
        referencedSchema: 'dbo',
        referencedTable: 'Customers',
        columnPairs: [
          { referencingColumn: 'CustomerId', referencedColumn: 'Id', ordinalPosition: 1 },
        ],
      };

      const fk2: ForeignKeyInfo = {
        constraintName: 'FK_Invoices_Customers',
        referencingSchema: 'dbo',
        referencingTable: 'Invoices',
        referencedSchema: 'dbo',
        referencedTable: 'Customers',
        columnPairs: [
          { referencingColumn: 'CustomerId', referencedColumn: 'Id', ordinalPosition: 1 },
        ],
      };

      const schemaCache = createMockSchemaCache({
        tables: [
          { schema: 'dbo', name: 'Orders', columns: [] },
          { schema: 'dbo', name: 'Invoices', columns: [] },
          { schema: 'dbo', name: 'Customers', columns: [] },
        ],
        foreignKeys: [fk1, fk2],
      });

      const context: JoinCompletionContext = {
        sourceTableRefs: [
          { schema: 'dbo', name: 'Orders', alias: 'o' },
          { schema: 'dbo', name: 'Invoices', alias: 'i' },
        ],
        existingAliases: ['o', 'i'],
        prefix: '',
      };

      const result = getJoinCompletions(context, schemaCache);

      // Count FK-related items targeting Customers
      const customerFKItems = result.items.filter(item =>
        item.detail?.startsWith('FK') &&
        (item.label as string).toLowerCase().includes('customers')
      );

      // Should have exactly 1 consolidated item (Requirements 8.1, 8.2)
      // Both FK_Orders_Customers and FK_Invoices_Customers are merged into one item
      expect(customerFKItems.length).toBe(1);

      // The consolidated item should reference both source aliases in the ON clause
      const insertText = customerFKItems[0].insertText as string;
      expect(insertText).toContain('o.CustomerId');
      expect(insertText).toContain('i.CustomerId');

      // ON clause uses AND to join conditions, never commas
      const onIndex = insertText.indexOf(' ON ');
      expect(onIndex).toBeGreaterThan(-1);
      const onClause = insertText.substring(onIndex + 4);
      expect(onClause).toContain(' AND ');
      expect(onClause).not.toContain(',');

      // Detail should reference both FK relationships
      expect(customerFKItems[0].detail).toContain('CustomerId');
    });

    it('does not produce duplicate items for the same FK constraint seen from multiple source tables', () => {
      // Single FK: Orders → Customers. Both Orders and Customers are source tables.
      // The FK should only produce ONE completion item, not two.
      const fk: ForeignKeyInfo = {
        constraintName: 'FK_Orders_Customers',
        referencingSchema: 'dbo',
        referencingTable: 'Orders',
        referencedSchema: 'dbo',
        referencedTable: 'Customers',
        columnPairs: [
          { referencingColumn: 'CustomerId', referencedColumn: 'Id', ordinalPosition: 1 },
        ],
      };

      const schemaCache = createMockSchemaCache({
        tables: [
          { schema: 'dbo', name: 'Orders', columns: [] },
          { schema: 'dbo', name: 'Customers', columns: [] },
          { schema: 'dbo', name: 'Products', columns: [] },
        ],
        foreignKeys: [fk],
      });

      const context: JoinCompletionContext = {
        sourceTableRefs: [
          { schema: 'dbo', name: 'Orders', alias: 'o' },
          { schema: 'dbo', name: 'Customers', alias: 'c' },
        ],
        existingAliases: ['o', 'c'],
        prefix: '',
      };

      const result = getJoinCompletions(context, schemaCache);

      // The FK_Orders_Customers constraint should appear only once
      const fkItems = result.items.filter(item =>
        item.detail?.startsWith('FK')
      );

      // Should be exactly 1 item for this single FK constraint
      expect(fkItems.length).toBe(1);
    });
  });

  describe('Schema cache populating (Requirements 2.6, 8.3)', () => {
    it('returns empty items when schema cache is populating', () => {
      const schemaCache = createMockSchemaCache({
        tables: [
          { schema: 'dbo', name: 'Orders', columns: [] },
          { schema: 'dbo', name: 'Customers', columns: [] },
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
        isPopulating: true,
      });

      const context: JoinCompletionContext = {
        sourceTableRefs: [{ schema: 'dbo', name: 'Orders', alias: 'o' }],
        existingAliases: ['o'],
        prefix: '',
      };

      const result = getJoinCompletions(context, schemaCache);

      // When populating, JoinGenerator returns empty items
      // The caller (CompletionProvider) handles returning keyword-only completions
      expect(result.items).toEqual([]);
    });
  });

  describe('No source tables / no FROM clause (Requirement 2.5, 8.1)', () => {
    it('returns all tables and views without ON clause when sourceTableRefs is empty', () => {
      const schemaCache = createMockSchemaCache({
        tables: [
          { schema: 'dbo', name: 'Orders', columns: [] },
          { schema: 'dbo', name: 'Customers', columns: [] },
          { schema: 'sales', name: 'Invoices', columns: [] },
        ],
        views: [
          { schema: 'dbo', name: 'ActiveOrders', columns: [] },
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

      const context: JoinCompletionContext = {
        sourceTableRefs: [], // No FROM clause
        existingAliases: [],
        prefix: '',
      };

      const result = getJoinCompletions(context, schemaCache);

      // Should return all tables + views (3 tables + 1 view = 4 items)
      expect(result.items.length).toBe(4);

      // None should have ON clause
      for (const item of result.items) {
        const insertText = item.insertText as string;
        expect(insertText).not.toContain(' ON ');
        // Should have format: TableName ${1:alias}$0
        expect(insertText).toMatch(/\$\{1:[a-z0-9]+\}\$0$/);
      }

      // Verify schema qualification: sales.Invoices should have schema prefix
      const invoicesItem = result.items.find(item =>
        (item.label as string).toLowerCase() === 'sales.invoices'
      );
      expect(invoicesItem).toBeDefined();
      expect((invoicesItem!.insertText as string)).toContain('sales.Invoices');

      // dbo tables should NOT have schema prefix in insertText
      const ordersItem = result.items.find(item =>
        (item.label as string).toLowerCase() === 'dbo.orders'
      );
      expect(ordersItem).toBeDefined();
      expect((ordersItem!.insertText as string)).toMatch(/^Orders /);
    });
  });
});
