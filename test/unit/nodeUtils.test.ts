import { describe, it, expect } from 'vitest';
import {
  getEffectiveDatabase,
  formatTableLabel,
  formatColumnLabel,
  getColumnIcon,
  sortNodes,
  categorizeDatabases,
} from '../../src/objectExplorer/nodeUtils';
import { ServerConnectionConfig, TreeNode, DatabaseInfo } from '../../src/objectExplorer/types';

describe('nodeUtils', () => {
  describe('getEffectiveDatabase', () => {
    it('returns "master" when database is undefined', () => {
      const config: ServerConnectionConfig = {
        name: 'Test',
        host: 'localhost',
        authType: 'windows',
      };
      expect(getEffectiveDatabase(config)).toBe('master');
    });

    it('returns "master" when database is empty string', () => {
      const config: ServerConnectionConfig = {
        name: 'Test',
        host: 'localhost',
        database: '',
        authType: 'windows',
      };
      expect(getEffectiveDatabase(config)).toBe('master');
    });

    it('returns "master" when database is whitespace only', () => {
      const config: ServerConnectionConfig = {
        name: 'Test',
        host: 'localhost',
        database: '   ',
        authType: 'windows',
      };
      expect(getEffectiveDatabase(config)).toBe('master');
    });

    it('returns the specified database when provided', () => {
      const config: ServerConnectionConfig = {
        name: 'Test',
        host: 'localhost',
        database: 'MyDatabase',
        authType: 'windows',
      };
      expect(getEffectiveDatabase(config)).toBe('MyDatabase');
    });
  });

  describe('formatTableLabel', () => {
    it('formats schema and name with dot separator', () => {
      expect(formatTableLabel('dbo', 'Users')).toBe('dbo.Users');
    });

    it('handles non-dbo schemas', () => {
      expect(formatTableLabel('sales', 'Orders')).toBe('sales.Orders');
    });

    it('handles empty schema', () => {
      expect(formatTableLabel('', 'Table1')).toBe('.Table1');
    });
  });

  describe('formatColumnLabel', () => {
    it('formats column name with data type in parentheses', () => {
      expect(formatColumnLabel('OrderId', 'int')).toBe('OrderId (int)');
    });

    it('handles data types with qualifiers', () => {
      expect(formatColumnLabel('Name', 'nvarchar(100)')).toBe('Name (nvarchar(100))');
    });

    it('handles decimal types with precision and scale', () => {
      expect(formatColumnLabel('Price', 'decimal(18,2)')).toBe('Price (decimal(18,2))');
    });
  });

  describe('getColumnIcon', () => {
    it('returns "pk" when isPrimaryKey is true', () => {
      expect(getColumnIcon(true, false)).toBe('pk');
    });

    it('returns "pk" when both isPrimaryKey and isForeignKey are true (PK takes precedence)', () => {
      expect(getColumnIcon(true, true)).toBe('pk');
    });

    it('returns "fk" when only isForeignKey is true', () => {
      expect(getColumnIcon(false, true)).toBe('fk');
    });

    it('returns "column" when neither is a key', () => {
      expect(getColumnIcon(false, false)).toBe('column');
    });
  });

  describe('sortNodes', () => {
    it('sorts nodes alphabetically by label', () => {
      const nodes: TreeNode[] = [
        { kind: 'database', label: 'Zebra', connectionName: 'srv', databaseName: 'Zebra', isSystem: false, isOffline: false },
        { kind: 'database', label: 'Alpha', connectionName: 'srv', databaseName: 'Alpha', isSystem: false, isOffline: false },
        { kind: 'database', label: 'Middle', connectionName: 'srv', databaseName: 'Middle', isSystem: false, isOffline: false },
      ];
      const sorted = sortNodes(nodes);
      expect(sorted.map(n => n.label)).toEqual(['Alpha', 'Middle', 'Zebra']);
    });

    it('sorts case-insensitively', () => {
      const nodes: TreeNode[] = [
        { kind: 'database', label: 'banana', connectionName: 'srv', databaseName: 'banana', isSystem: false, isOffline: false },
        { kind: 'database', label: 'Apple', connectionName: 'srv', databaseName: 'Apple', isSystem: false, isOffline: false },
        { kind: 'database', label: 'Cherry', connectionName: 'srv', databaseName: 'Cherry', isSystem: false, isOffline: false },
      ];
      const sorted = sortNodes(nodes);
      expect(sorted.map(n => n.label)).toEqual(['Apple', 'banana', 'Cherry']);
    });

    it('does not mutate the original array', () => {
      const nodes: TreeNode[] = [
        { kind: 'database', label: 'B', connectionName: 'srv', databaseName: 'B', isSystem: false, isOffline: false },
        { kind: 'database', label: 'A', connectionName: 'srv', databaseName: 'A', isSystem: false, isOffline: false },
      ];
      const original = [...nodes];
      sortNodes(nodes);
      expect(nodes).toEqual(original);
    });

    it('returns empty array for empty input', () => {
      expect(sortNodes([])).toEqual([]);
    });
  });

  describe('categorizeDatabases', () => {
    it('separates user and system databases', () => {
      const databases: DatabaseInfo[] = [
        { name: 'master', isSystem: true, state: 'online' },
        { name: 'MyApp', isSystem: false, state: 'online' },
        { name: 'tempdb', isSystem: true, state: 'online' },
        { name: 'Sales', isSystem: false, state: 'online' },
      ];
      const result = categorizeDatabases(databases);
      expect(result.user).toEqual([
        { name: 'MyApp', isSystem: false, state: 'online' },
        { name: 'Sales', isSystem: false, state: 'online' },
      ]);
      expect(result.system).toEqual([
        { name: 'master', isSystem: true, state: 'online' },
        { name: 'tempdb', isSystem: true, state: 'online' },
      ]);
    });

    it('returns empty arrays when no databases provided', () => {
      const result = categorizeDatabases([]);
      expect(result.user).toEqual([]);
      expect(result.system).toEqual([]);
    });

    it('handles all user databases', () => {
      const databases: DatabaseInfo[] = [
        { name: 'App1', isSystem: false, state: 'online' },
        { name: 'App2', isSystem: false, state: 'online' },
      ];
      const result = categorizeDatabases(databases);
      expect(result.user).toHaveLength(2);
      expect(result.system).toHaveLength(0);
    });

    it('handles all system databases', () => {
      const databases: DatabaseInfo[] = [
        { name: 'master', isSystem: true, state: 'online' },
        { name: 'msdb', isSystem: true, state: 'online' },
      ];
      const result = categorizeDatabases(databases);
      expect(result.user).toHaveLength(0);
      expect(result.system).toHaveLength(2);
    });
  });
});
