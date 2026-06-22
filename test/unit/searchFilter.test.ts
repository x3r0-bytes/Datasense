import { describe, it, expect } from 'vitest';
import { isValidSearchTerm, filterNodes, buildFilteredTree, IndexedNode } from '../../src/objectExplorer/searchFilter';
import { TreeNode, TableNode, ViewNode, ColumnNode, FolderNode, ServerNode, DatabaseNode } from '../../src/objectExplorer/types';

// ============================================================================
// Helper Factories
// ============================================================================

function makeServer(label: string, connectionName: string = 'conn1'): ServerNode {
  return { kind: 'server', label, connectionName };
}

function makeDatabase(label: string, connectionName: string = 'conn1'): DatabaseNode {
  return { kind: 'database', label, connectionName, databaseName: label, isSystem: false, isOffline: false };
}

function makeFolder(label: string, connectionName: string = 'conn1'): FolderNode {
  return { kind: 'folder', label, connectionName, folderType: 'tables' };
}

function makeTable(label: string, connectionName: string = 'conn1'): TableNode {
  return { kind: 'table', label, connectionName, database: 'TestDB', schema: 'dbo', tableName: label, isExternal: false };
}

function makeView(label: string, connectionName: string = 'conn1'): ViewNode {
  return { kind: 'view', label, connectionName, database: 'TestDB', schema: 'dbo', viewName: label, isSystem: false };
}

function makeColumn(label: string, connectionName: string = 'conn1'): ColumnNode {
  return { kind: 'column', label, connectionName, database: 'TestDB', columnName: label, dataType: 'int', isPrimaryKey: false, isForeignKey: false };
}

function makeIndexedNode(node: TreeNode, ancestors: TreeNode[] = []): IndexedNode {
  return { node, ancestors, labelLower: node.label.toLowerCase() };
}

// ============================================================================
// isValidSearchTerm
// ============================================================================

describe('searchFilter', () => {
  describe('isValidSearchTerm', () => {
    it('returns false for empty string', () => {
      expect(isValidSearchTerm('')).toBe(false);
    });

    it('returns false for 1 character (below minimum)', () => {
      expect(isValidSearchTerm('a')).toBe(false);
    });

    it('returns true for exactly 2 characters', () => {
      expect(isValidSearchTerm('ab')).toBe(true);
    });

    it('returns true for exactly 128 characters', () => {
      const term = 'a'.repeat(128);
      expect(isValidSearchTerm(term)).toBe(true);
    });

    it('returns false for 129 characters (exceeds maximum)', () => {
      const term = 'a'.repeat(129);
      expect(isValidSearchTerm(term)).toBe(false);
    });

    it('returns true for a typical search term', () => {
      expect(isValidSearchTerm('Users')).toBe(true);
    });
  });

  // ============================================================================
  // filterNodes — case-insensitive matching
  // ============================================================================

  describe('filterNodes', () => {
    it('returns empty array when index is empty', () => {
      const result = filterNodes([], 'test');
      expect(result).toEqual([]);
    });

    it('matches case-insensitively on table nodes', () => {
      const table = makeTable('UserAccounts');
      const index: IndexedNode[] = [makeIndexedNode(table)];

      const result = filterNodes(index, 'useracc');
      expect(result).toHaveLength(1);
      expect(result[0].node).toBe(table);
    });

    it('matches case-insensitively on view nodes', () => {
      const view = makeView('vw_ActiveUsers');
      const index: IndexedNode[] = [makeIndexedNode(view)];

      const result = filterNodes(index, 'ACTIVE');
      expect(result).toHaveLength(1);
      expect(result[0].node).toBe(view);
    });

    it('matches case-insensitively on column nodes', () => {
      const column = makeColumn('CustomerEmail');
      const index: IndexedNode[] = [makeIndexedNode(column)];

      const result = filterNodes(index, 'EMAIL');
      expect(result).toHaveLength(1);
      expect(result[0].node).toBe(column);
    });

    it('matches case-insensitively on folder nodes (procedures)', () => {
      const folder = makeFolder('Stored Procedures');
      folder.folderType = 'programmability';
      const index: IndexedNode[] = [makeIndexedNode(folder)];

      const result = filterNodes(index, 'stored');
      expect(result).toHaveLength(1);
      expect(result[0].node).toBe(folder);
    });

    it('matches substring anywhere in the label', () => {
      const table = makeTable('dbo.OrderDetails');
      const index: IndexedNode[] = [makeIndexedNode(table)];

      const result = filterNodes(index, 'detail');
      expect(result).toHaveLength(1);
    });

    it('returns multiple matches across different node types', () => {
      const table = makeTable('UserTable');
      const view = makeView('UserView');
      const column = makeColumn('UserId');
      const index: IndexedNode[] = [
        makeIndexedNode(table),
        makeIndexedNode(view),
        makeIndexedNode(column),
      ];

      const result = filterNodes(index, 'user');
      expect(result).toHaveLength(3);
    });

    it('returns empty array when no nodes match', () => {
      const table = makeTable('Orders');
      const view = makeView('Products');
      const index: IndexedNode[] = [
        makeIndexedNode(table),
        makeIndexedNode(view),
      ];

      const result = filterNodes(index, 'xyz');
      expect(result).toEqual([]);
    });

    it('uses the labelLower field for matching (not the original label)', () => {
      const node: IndexedNode = {
        node: makeTable('UPPERCASE'),
        ancestors: [],
        labelLower: 'uppercase',
      };

      const result = filterNodes([node], 'UPPER');
      expect(result).toHaveLength(1);
    });
  });

  // ============================================================================
  // buildFilteredTree
  // ============================================================================

  describe('buildFilteredTree', () => {
    it('returns empty array for empty matches', () => {
      const result = buildFilteredTree([]);
      expect(result).toEqual([]);
    });

    it('returns the root node when a root-level node matches', () => {
      const server = makeServer('MyServer');
      const matches: IndexedNode[] = [makeIndexedNode(server)];

      const result = buildFilteredTree(matches);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(server);
    });

    it('returns ancestor root when a deeply nested node matches', () => {
      const server = makeServer('MyServer');
      const db = makeDatabase('TestDB');
      const folder = makeFolder('Tables');
      const table = makeTable('Users');

      const matches: IndexedNode[] = [
        makeIndexedNode(table, [server, db, folder]),
      ];

      const result = buildFilteredTree(matches);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(server);
    });

    it('deduplicates shared ancestor roots from multiple matches', () => {
      const server = makeServer('MyServer');
      const db = makeDatabase('TestDB');
      const folder = makeFolder('Tables');
      const table1 = makeTable('Users');
      const table2 = makeTable('Orders');

      const matches: IndexedNode[] = [
        makeIndexedNode(table1, [server, db, folder]),
        makeIndexedNode(table2, [server, db, folder]),
      ];

      const result = buildFilteredTree(matches);
      // Both matches share the same root server node
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(server);
    });

    it('handles multiple matches at different nesting levels', () => {
      const server = makeServer('MyServer');
      const db = makeDatabase('UserDB');
      const folder = makeFolder('Tables');
      const table = makeTable('UserTable');

      // One match at database level, one at table level
      const matches: IndexedNode[] = [
        makeIndexedNode(db, [server]),
        makeIndexedNode(table, [server, db, folder]),
      ];

      const result = buildFilteredTree(matches);
      // Both share the same root
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(server);
    });

    it('returns multiple roots when matches come from different connections', () => {
      const server1 = makeServer('Server1', 'conn1');
      const server2 = makeServer('Server2', 'conn2');
      const table1 = makeTable('Users', 'conn1');
      const table2 = makeTable('Users', 'conn2');

      const matches: IndexedNode[] = [
        makeIndexedNode(table1, [server1]),
        makeIndexedNode(table2, [server2]),
      ];

      const result = buildFilteredTree(matches);
      expect(result).toHaveLength(2);
    });

    it('preserves the match node itself in the result when it has no ancestors', () => {
      const server = makeServer('SearchableServer');
      const matches: IndexedNode[] = [makeIndexedNode(server)];

      const result = buildFilteredTree(matches);
      expect(result).toContain(server);
    });

    it('handles deep nesting (5 levels) correctly', () => {
      const server = makeServer('Server');
      const db = makeDatabase('DB');
      const folder1 = makeFolder('Tables');
      const table = makeTable('Customers');
      const column = makeColumn('Email');

      const matches: IndexedNode[] = [
        makeIndexedNode(column, [server, db, folder1, table]),
      ];

      const result = buildFilteredTree(matches);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(server);
    });
  });
});
