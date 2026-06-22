import { describe, it, expect } from 'vitest';
import {
  getOperatorCompletions,
  detectColumnBeforeCursor,
  STRING_TYPES,
  NUMERIC_TYPES,
  DATETIME_TYPES,
} from '../../server/src/completionProvider';
import { ISchemaCache, TableInfo } from '../../server/src/schemaCache';
import * as mssql from 'mssql';

/**
 * Unit tests for operator suggestion edge cases.
 * Validates: Requirements 7.1, 7.5
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

describe('getOperatorCompletions — edge cases', () => {
  const ordersTable: TableInfo = {
    schema: 'dbo',
    name: 'Orders',
    columns: [
      { name: 'OrderId', dataType: 'int', isNullable: false },
      { name: 'OrderDate', dataType: 'datetime', isNullable: false },
      { name: 'Status', dataType: 'nvarchar', isNullable: false },
      { name: 'Metadata', dataType: 'xml', isNullable: true },
    ],
  };

  const customersTable: TableInfo = {
    schema: 'dbo',
    name: 'Customers',
    columns: [
      { name: 'CustomerId', dataType: 'int', isNullable: false },
      { name: 'Name', dataType: 'nvarchar', isNullable: false },
    ],
  };

  const schemaCache = createMockSchemaCache([ordersTable, customersTable]);

  it('column data type not in any known category → all operators equal priority', () => {
    // "xml" is not in STRING_TYPES, NUMERIC_TYPES, or DATETIME_TYPES
    const batchText = 'SELECT * FROM dbo.Orders WHERE Metadata ';
    const textBeforeCursor = 'SELECT * FROM dbo.Orders WHERE Metadata ';

    const result = getOperatorCompletions(textBeforeCursor, batchText, schemaCache);

    expect(result.length).toBeGreaterThan(0);

    // All operators should have the same sortText prefix (all tier "1_" since no priority ops)
    const sortTexts = result.map(item => item.sortText as string);
    const prefixes = sortTexts.map(st => st.split('_')[0]);
    // With no priority ops, all should be "1_"
    for (const prefix of prefixes) {
      expect(prefix).toBe('1');
    }
  });

  it('alias-qualified column (o.OrderDate) triggers operators', () => {
    const batchText = 'SELECT * FROM dbo.Orders o WHERE o.OrderDate ';
    const textBeforeCursor = 'SELECT * FROM dbo.Orders o WHERE o.OrderDate ';

    const result = getOperatorCompletions(textBeforeCursor, batchText, schemaCache);

    expect(result.length).toBeGreaterThan(0);

    const labels = result.map(item => item.label as string);
    expect(labels).toContain('=');
    expect(labels).toContain('<>');
    expect(labels).toContain('BETWEEN');
    expect(labels).toContain('IS NULL');
    expect(labels).toContain('IS NOT NULL');

    // OrderDate is datetime → BETWEEN, >=, <= should be priority
    const betweenItem = result.find(item => item.label === 'BETWEEN');
    const geItem = result.find(item => item.label === '>=');
    const leItem = result.find(item => item.label === '<=');
    const likeItem = result.find(item => item.label === 'LIKE');

    expect(betweenItem!.sortText).toMatch(/^0_/);
    expect(geItem!.sortText).toMatch(/^0_/);
    expect(leItem!.sortText).toMatch(/^0_/);
    expect(likeItem!.sortText).toMatch(/^1_/);
  });

  it('identifier before cursor that is NOT a known column → no operators', () => {
    const batchText = 'SELECT * FROM dbo.Orders WHERE UnknownColumn ';
    const textBeforeCursor = 'SELECT * FROM dbo.Orders WHERE UnknownColumn ';

    const result = getOperatorCompletions(textBeforeCursor, batchText, schemaCache);

    expect(result).toEqual([]);
  });

  it('cursor in WHERE but no table references → no operators', () => {
    // No FROM clause, so no table references can be extracted
    const batchText = 'SELECT 1 WHERE SomeColumn ';
    const textBeforeCursor = 'SELECT 1 WHERE SomeColumn ';

    const result = getOperatorCompletions(textBeforeCursor, batchText, schemaCache);

    expect(result).toEqual([]);
  });
});
