import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchemaCache } from '../../server/src/schemaCache';

/**
 * Unit tests for SchemaCache Foreign Key handling.
 * Validates: Requirements 1.4, 1.5, 9.4, 9.5
 */

// Helper to create a mock pool where each query type returns specific results.
// The FK query can be configured to throw or return specific data.
function createMockPool(options: {
  tables?: any[];
  views?: any[];
  procedures?: any[];
  foreignKeys?: any[] | Error;
}) {
  const { tables = [], views = [], procedures = [], foreignKeys = [] } = options;

  return {
    request: () => ({
      query: vi.fn(async (sql: string) => {
        if (sql.includes('sys.foreign_keys')) {
          if (foreignKeys instanceof Error) {
            throw foreignKeys;
          }
          return { recordset: foreignKeys };
        } else if (sql.includes('INFORMATION_SCHEMA.VIEWS')) {
          return { recordset: views };
        } else if (sql.includes('INFORMATION_SCHEMA.ROUTINES')) {
          return { recordset: procedures };
        } else if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
          return { recordset: tables };
        }
        return { recordset: [] };
      }),
    }),
  } as any;
}

describe('SchemaCache FK handling', () => {
  let cache: SchemaCache;

  beforeEach(() => {
    cache = new SchemaCache();
  });

  describe('FK query failure graceful degradation (Requirement 1.5, 9.5)', () => {
    it('should retain previously cached FK data when FK query fails during refresh', async () => {
      // First refresh: populate FK data successfully
      const poolWithFKs = createMockPool({
        tables: [
          { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Orders', COLUMN_NAME: 'OrderId', DATA_TYPE: 'int', IS_NULLABLE: 'NO' },
        ],
        foreignKeys: [
          {
            constraint_name: 'FK_Orders_Customers',
            referencing_schema: 'dbo',
            referencing_table: 'Orders',
            referencing_column: 'CustomerId',
            referenced_schema: 'dbo',
            referenced_table: 'Customers',
            referenced_column: 'Id',
            ordinal_position: 1,
          },
        ],
      });

      await cache.refresh(poolWithFKs);
      expect(cache.foreignKeys).toHaveLength(1);
      expect(cache.foreignKeys[0].constraintName).toBe('FK_Orders_Customers');

      // Second refresh: FK query throws, but tables/views/procedures succeed
      const poolWithFKError = createMockPool({
        tables: [
          { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Products', COLUMN_NAME: 'ProductId', DATA_TYPE: 'int', IS_NULLABLE: 'NO' },
        ],
        foreignKeys: new Error('Network timeout on FK query'),
      });

      // Suppress console.error output during test
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await cache.refresh(poolWithFKError);

      consoleSpy.mockRestore();

      // FK data should be retained from the first refresh
      expect(cache.foreignKeys).toHaveLength(1);
      expect(cache.foreignKeys[0].constraintName).toBe('FK_Orders_Customers');

      // Tables should be updated to the new data
      expect(cache.tables).toHaveLength(1);
      expect(cache.tables[0].name).toBe('Products');
    });

    it('should complete refresh with tables/views/procedures intact when FK query fails', async () => {
      const pool = createMockPool({
        tables: [
          { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Users', COLUMN_NAME: 'Id', DATA_TYPE: 'int', IS_NULLABLE: 'NO' },
        ],
        views: [
          { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'ActiveUsers', COLUMN_NAME: 'Id', DATA_TYPE: 'int', IS_NULLABLE: 'NO' },
        ],
        procedures: [
          { ROUTINE_SCHEMA: 'dbo', ROUTINE_NAME: 'GetUsers' },
        ],
        foreignKeys: new Error('Permission denied'),
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await cache.refresh(pool);

      consoleSpy.mockRestore();

      // All other metadata should be populated correctly
      expect(cache.tables).toHaveLength(1);
      expect(cache.tables[0].name).toBe('Users');
      expect(cache.views).toHaveLength(1);
      expect(cache.views[0].name).toBe('ActiveUsers');
      expect(cache.procedures).toHaveLength(1);
      expect(cache.procedures[0].name).toBe('GetUsers');

      // FK data should be empty (no previous data existed)
      expect(cache.foreignKeys).toHaveLength(0);
    });
  });

  describe('Empty FK result set', () => {
    it('should have empty foreignKeys when FK query returns empty array', async () => {
      const pool = createMockPool({
        tables: [
          { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Orders', COLUMN_NAME: 'OrderId', DATA_TYPE: 'int', IS_NULLABLE: 'NO' },
        ],
        foreignKeys: [],
      });

      await cache.refresh(pool);

      expect(cache.foreignKeys).toEqual([]);
    });

    it('should return empty array from getForeignKeysForTable when no FKs exist', async () => {
      const pool = createMockPool({
        tables: [
          { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Orders', COLUMN_NAME: 'OrderId', DATA_TYPE: 'int', IS_NULLABLE: 'NO' },
        ],
        foreignKeys: [],
      });

      await cache.refresh(pool);

      expect(cache.getForeignKeysForTable('dbo', 'Orders')).toEqual([]);
      expect(cache.getForeignKeysForTable('dbo', 'NonExistent')).toEqual([]);
    });
  });

  describe('Composite FK with multiple column pairs (Requirement 1.3)', () => {
    it('should store composite FK column pairs in ordinal order', async () => {
      // Simulate a composite FK with columns arriving out of order
      const pool = createMockPool({
        tables: [],
        foreignKeys: [
          {
            constraint_name: 'FK_OrderDetails_Orders',
            referencing_schema: 'dbo',
            referencing_table: 'OrderDetails',
            referencing_column: 'ProductId',
            referenced_schema: 'dbo',
            referenced_table: 'Orders',
            referenced_column: 'ProductId',
            ordinal_position: 2,
          },
          {
            constraint_name: 'FK_OrderDetails_Orders',
            referencing_schema: 'dbo',
            referencing_table: 'OrderDetails',
            referencing_column: 'OrderId',
            referenced_schema: 'dbo',
            referenced_table: 'Orders',
            referenced_column: 'OrderId',
            ordinal_position: 1,
          },
        ],
      });

      await cache.refresh(pool);

      expect(cache.foreignKeys).toHaveLength(1);
      const fk = cache.foreignKeys[0];
      expect(fk.constraintName).toBe('FK_OrderDetails_Orders');
      expect(fk.columnPairs).toHaveLength(2);

      // Column pairs should be sorted by ordinal position
      expect(fk.columnPairs[0].ordinalPosition).toBe(1);
      expect(fk.columnPairs[0].referencingColumn).toBe('OrderId');
      expect(fk.columnPairs[0].referencedColumn).toBe('OrderId');

      expect(fk.columnPairs[1].ordinalPosition).toBe(2);
      expect(fk.columnPairs[1].referencingColumn).toBe('ProductId');
      expect(fk.columnPairs[1].referencedColumn).toBe('ProductId');
    });

    it('should store all fields of a composite FK correctly', async () => {
      const pool = createMockPool({
        tables: [],
        foreignKeys: [
          {
            constraint_name: 'FK_Composite',
            referencing_schema: 'sales',
            referencing_table: 'LineItems',
            referencing_column: 'OrderId',
            referenced_schema: 'dbo',
            referenced_table: 'Orders',
            referenced_column: 'Id',
            ordinal_position: 1,
          },
          {
            constraint_name: 'FK_Composite',
            referencing_schema: 'sales',
            referencing_table: 'LineItems',
            referencing_column: 'ProductId',
            referenced_schema: 'dbo',
            referenced_table: 'Orders',
            referenced_column: 'ProductId',
            ordinal_position: 2,
          },
          {
            constraint_name: 'FK_Composite',
            referencing_schema: 'sales',
            referencing_table: 'LineItems',
            referencing_column: 'WarehouseId',
            referenced_schema: 'dbo',
            referenced_table: 'Orders',
            referenced_column: 'WarehouseId',
            ordinal_position: 3,
          },
        ],
      });

      await cache.refresh(pool);

      expect(cache.foreignKeys).toHaveLength(1);
      const fk = cache.foreignKeys[0];
      expect(fk.referencingSchema).toBe('sales');
      expect(fk.referencingTable).toBe('LineItems');
      expect(fk.referencedSchema).toBe('dbo');
      expect(fk.referencedTable).toBe('Orders');
      expect(fk.columnPairs).toHaveLength(3);
      expect(fk.columnPairs.map(p => p.ordinalPosition)).toEqual([1, 2, 3]);
    });
  });

  describe('Case-insensitive lookup matching (Requirement 1.4, 9.4)', () => {
    it('should return same results regardless of case in getForeignKeysForTable', async () => {
      const pool = createMockPool({
        tables: [],
        foreignKeys: [
          {
            constraint_name: 'FK_Orders_Customers',
            referencing_schema: 'dbo',
            referencing_table: 'Orders',
            referencing_column: 'CustomerId',
            referenced_schema: 'dbo',
            referenced_table: 'Customers',
            referenced_column: 'Id',
            ordinal_position: 1,
          },
        ],
      });

      await cache.refresh(pool);

      // All case variations should return the same FK
      const result1 = cache.getForeignKeysForTable('dbo', 'Orders');
      const result2 = cache.getForeignKeysForTable('DBO', 'Orders');
      const result3 = cache.getForeignKeysForTable('dbo', 'ORDERS');
      const result4 = cache.getForeignKeysForTable('DBO', 'ORDERS');
      const result5 = cache.getForeignKeysForTable('Dbo', 'orders');

      expect(result1).toHaveLength(1);
      expect(result2).toHaveLength(1);
      expect(result3).toHaveLength(1);
      expect(result4).toHaveLength(1);
      expect(result5).toHaveLength(1);

      // All should return the same FK object
      expect(result1[0].constraintName).toBe('FK_Orders_Customers');
      expect(result2[0].constraintName).toBe('FK_Orders_Customers');
      expect(result3[0].constraintName).toBe('FK_Orders_Customers');
      expect(result4[0].constraintName).toBe('FK_Orders_Customers');
      expect(result5[0].constraintName).toBe('FK_Orders_Customers');
    });

    it('should find FKs for both referencing and referenced tables via case-insensitive lookup', async () => {
      const pool = createMockPool({
        tables: [],
        foreignKeys: [
          {
            constraint_name: 'FK_Orders_Customers',
            referencing_schema: 'dbo',
            referencing_table: 'Orders',
            referencing_column: 'CustomerId',
            referenced_schema: 'Sales',
            referenced_table: 'Customers',
            referenced_column: 'Id',
            ordinal_position: 1,
          },
        ],
      });

      await cache.refresh(pool);

      // Lookup by referencing table (case-insensitive)
      const byReferencing = cache.getForeignKeysForTable('DBO', 'orders');
      expect(byReferencing).toHaveLength(1);
      expect(byReferencing[0].constraintName).toBe('FK_Orders_Customers');

      // Lookup by referenced table (case-insensitive)
      const byReferenced = cache.getForeignKeysForTable('SALES', 'customers');
      expect(byReferenced).toHaveLength(1);
      expect(byReferenced[0].constraintName).toBe('FK_Orders_Customers');
    });

    it('should return empty array for non-matching table names', async () => {
      const pool = createMockPool({
        tables: [],
        foreignKeys: [
          {
            constraint_name: 'FK_Orders_Customers',
            referencing_schema: 'dbo',
            referencing_table: 'Orders',
            referencing_column: 'CustomerId',
            referenced_schema: 'dbo',
            referenced_table: 'Customers',
            referenced_column: 'Id',
            ordinal_position: 1,
          },
        ],
      });

      await cache.refresh(pool);

      expect(cache.getForeignKeysForTable('dbo', 'Products')).toEqual([]);
      expect(cache.getForeignKeysForTable('hr', 'Orders')).toEqual([]);
    });
  });
});
