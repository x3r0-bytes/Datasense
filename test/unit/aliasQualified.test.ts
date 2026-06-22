import { describe, it, expect } from 'vitest';
import { handleAliasDotPrefix, getCompletions } from '../../server/src/completionProvider';
import { ISchemaCache, TableInfo } from '../../server/src/schemaCache';
import * as mssql from 'mssql';

/**
 * Unit tests for alias-qualified column edge cases.
 * Validates: Requirements 6.4, 6.5
 */

// --- Helpers ---

function createMockSchemaCache(tables: TableInfo[]): ISchemaCache {
  return {
    tables,
    views: [],
    procedures: [],
    foreignKeys: [],
    isPopulating: false,
    refresh: async (_pool: mssql.ConnectionPool) => {},
    getForeignKeysForTable: (_schema: string, _tableName: string) => [],
  };
}

describe('handleAliasDotPrefix — alias-qualified edge cases', () => {
  const ordersTable: TableInfo = {
    schema: 'dbo',
    name: 'Orders',
    columns: [
      { name: 'OrderId', dataType: 'int', isNullable: false },
      { name: 'OrderDate', dataType: 'datetime', isNullable: false },
      { name: 'CustomerId', dataType: 'int', isNullable: true },
    ],
  };

  const customersTable: TableInfo = {
    schema: 'dbo',
    name: 'Customers',
    columns: [
      { name: 'CustomerId', dataType: 'int', isNullable: false },
      { name: 'Name', dataType: 'nvarchar', isNullable: false },
      { name: 'Email', dataType: 'nvarchar', isNullable: true },
    ],
  };

  const schemaCache = createMockSchemaCache([ordersTable, customersTable]);

  it('unknown alias prefix returns empty column list', () => {
    const batchText = 'SELECT * FROM dbo.Orders o WHERE ';
    const textBeforeCursor = 'SELECT * FROM dbo.Orders o WHERE x.';

    const result = handleAliasDotPrefix(textBeforeCursor, batchText, schemaCache);

    expect(result).not.toBeNull();
    expect(result).toEqual([]);
  });

  it('single table with alias still qualifies columns', () => {
    const batchText = 'SELECT * FROM dbo.Orders o WHERE ';
    const textBeforeCursor = 'SELECT * FROM dbo.Orders o WHERE o.';

    const result = handleAliasDotPrefix(textBeforeCursor, batchText, schemaCache);

    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);

    const labels = result!.map(item => item.label as string);
    expect(labels).toContain('OrderId');
    expect(labels).toContain('OrderDate');
    expect(labels).toContain('CustomerId');

    // insertText should be just the column name (alias.dot already typed)
    for (const item of result!) {
      expect(item.insertText).toBe(item.label);
    }
  });

  it('multiple tables, one aliased and one not — correct qualification', () => {
    const batchText = 'SELECT * FROM dbo.Orders o JOIN dbo.Customers ON o.CustomerId = Customers.CustomerId WHERE ';
    const textBeforeCursor = 'SELECT * FROM dbo.Orders o JOIN dbo.Customers ON o.CustomerId = Customers.CustomerId WHERE o.';

    const result = handleAliasDotPrefix(textBeforeCursor, batchText, schemaCache);

    expect(result).not.toBeNull();
    // Should return only Orders columns (alias "o" matches Orders)
    const labels = result!.map(item => item.label as string);
    expect(labels).toContain('OrderId');
    expect(labels).toContain('OrderDate');
    expect(labels).toContain('CustomerId');
    expect(labels).not.toContain('Name');
    expect(labels).not.toContain('Email');
  });

  it('alias matching is case-insensitive', () => {
    const batchText = 'SELECT * FROM dbo.Orders o WHERE ';

    // User typed uppercase alias "O." but alias is defined as lowercase "o"
    const textBeforeCursorUpper = 'SELECT * FROM dbo.Orders o WHERE O.';
    const resultUpper = handleAliasDotPrefix(textBeforeCursorUpper, batchText, schemaCache);

    expect(resultUpper).not.toBeNull();
    expect(resultUpper!.length).toBe(3);

    const labelsUpper = resultUpper!.map(item => item.label as string);
    expect(labelsUpper).toContain('OrderId');
    expect(labelsUpper).toContain('OrderDate');
    expect(labelsUpper).toContain('CustomerId');

    // Also test with mixed case alias definition
    const batchTextMixed = 'SELECT * FROM dbo.Orders Ord WHERE ';
    const textBeforeCursorMixed = 'SELECT * FROM dbo.Orders Ord WHERE ord.';
    const resultMixed = handleAliasDotPrefix(textBeforeCursorMixed, batchTextMixed, schemaCache);

    expect(resultMixed).not.toBeNull();
    expect(resultMixed!.length).toBe(3);
  });

  it('schema prefix (e.g., "dbo.") returns null to let normal completion handle it', () => {
    const batchText = 'SELECT * FROM dbo.Orders o WHERE ';
    const textBeforeCursor = 'SELECT * FROM dbo.';

    const result = handleAliasDotPrefix(textBeforeCursor, batchText, schemaCache);

    // Should return null because "dbo" is a schema name, not an alias
    expect(result).toBeNull();
  });

  it('alias with partial column prefix filters results', () => {
    const batchText = 'SELECT * FROM dbo.Orders o WHERE ';
    const textBeforeCursor = 'SELECT * FROM dbo.Orders o WHERE o.Order';

    const result = handleAliasDotPrefix(textBeforeCursor, batchText, schemaCache);

    expect(result).not.toBeNull();
    // Should only return columns starting with "Order"
    const labels = result!.map(item => item.label as string);
    expect(labels).toContain('OrderId');
    expect(labels).toContain('OrderDate');
    expect(labels).not.toContain('CustomerId');
  });
});
