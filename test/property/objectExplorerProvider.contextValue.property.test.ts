import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

// Mock vscode module
vi.mock('vscode', () => ({
  TreeItem: class {
    label: string;
    collapsibleState: number;
    contextValue?: string;
    iconPath?: any;
    description?: string;
    constructor(label: string, collapsibleState?: number) {
      this.label = label;
      this.collapsibleState = collapsibleState ?? 0;
    }
  },
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2,
  },
  EventEmitter: class {
    fire = vi.fn();
    event = vi.fn();
  },
  ThemeIcon: class {
    id: string;
    constructor(id: string) {
      this.id = id;
    }
  },
  window: {
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
}));

import { ObjectExplorerProvider } from '../../src/objectExplorer/objectExplorerProvider';
import {
  TreeNode,
  ServerNode,
  FolderNode,
  DatabaseNode,
  TableNode,
  ViewNode,
  ColumnNode,
  ErrorNode,
  FolderType,
} from '../../src/objectExplorer/types';

/**
 * Property-based tests for contextValue assignment in ObjectExplorerProvider.getTreeItem()
 * Feature: ui-overhaul-v2, Property 3: contextValue Assignment Correctness
 *
 * Validates: Requirements 5.2
 *
 * For any TreeNode, getTreeItem() assigns a contextValue determined solely by the node's
 * kind and its boolean properties (isExternal, isSystem, isPrimaryKey, isForeignKey, isOffline).
 */

// --- Generators ---

/** Generator: non-empty label string */
const arbitraryLabel: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
    fc.string({ minLength: 0, maxLength: 20 })
  )
  .map(([first, rest]) => first + rest);

/** Generator: non-empty connection name */
const arbitraryConnectionName: fc.Arbitrary<string> = arbitraryLabel;

/** Generator: valid folder types */
const arbitraryFolderType: fc.Arbitrary<FolderType> = fc.constantFrom(
  'databases',
  'systemDatabases',
  'security',
  'serverObjects',
  'tables',
  'tablesUser',
  'tablesExternal',
  'views',
  'viewsUser',
  'viewsSystem',
  'synonyms',
  'programmability',
  'externalResources',
  'serviceBroker',
  'storage',
  'dbSecurity',
  'columns',
  'constraints',
  'triggers',
  'indexes',
  'statistics'
);

/** Generator: ServerNode */
const arbitraryServerNode: fc.Arbitrary<ServerNode> = fc
  .tuple(arbitraryLabel, arbitraryConnectionName)
  .map(([label, connectionName]) => ({
    kind: 'server' as const,
    label,
    connectionName,
  }));

/** Generator: FolderNode */
const arbitraryFolderNode: fc.Arbitrary<FolderNode> = fc
  .tuple(arbitraryLabel, arbitraryConnectionName, arbitraryFolderType)
  .map(([label, connectionName, folderType]) => ({
    kind: 'folder' as const,
    label,
    connectionName,
    folderType,
  }));

/** Generator: DatabaseNode with arbitrary isOffline boolean */
const arbitraryDatabaseNode: fc.Arbitrary<DatabaseNode> = fc
  .tuple(arbitraryLabel, arbitraryConnectionName, arbitraryLabel, fc.boolean(), fc.boolean())
  .map(([label, connectionName, databaseName, isSystem, isOffline]) => ({
    kind: 'database' as const,
    label,
    connectionName,
    databaseName,
    isSystem,
    isOffline,
  }));

/** Generator: TableNode with arbitrary isExternal boolean */
const arbitraryTableNode: fc.Arbitrary<TableNode> = fc
  .tuple(arbitraryLabel, arbitraryConnectionName, arbitraryLabel, arbitraryLabel, arbitraryLabel, fc.boolean())
  .map(([label, connectionName, database, schema, tableName, isExternal]) => ({
    kind: 'table' as const,
    label,
    connectionName,
    database,
    schema,
    tableName,
    isExternal,
  }));

/** Generator: ViewNode with arbitrary isSystem boolean */
const arbitraryViewNode: fc.Arbitrary<ViewNode> = fc
  .tuple(arbitraryLabel, arbitraryConnectionName, arbitraryLabel, arbitraryLabel, arbitraryLabel, fc.boolean())
  .map(([label, connectionName, database, schema, viewName, isSystem]) => ({
    kind: 'view' as const,
    label,
    connectionName,
    database,
    schema,
    viewName,
    isSystem,
  }));

/** Generator: ColumnNode with arbitrary isPrimaryKey and isForeignKey booleans */
const arbitraryColumnNode: fc.Arbitrary<ColumnNode> = fc
  .tuple(
    arbitraryLabel,
    arbitraryConnectionName,
    arbitraryLabel,
    arbitraryLabel,
    arbitraryLabel,
    fc.boolean(),
    fc.boolean()
  )
  .map(([label, connectionName, database, columnName, dataType, isPrimaryKey, isForeignKey]) => ({
    kind: 'column' as const,
    label,
    connectionName,
    database,
    columnName,
    dataType,
    isPrimaryKey,
    isForeignKey,
  }));

/** Generator: ErrorNode */
const arbitraryErrorNode: fc.Arbitrary<ErrorNode> = fc
  .tuple(arbitraryLabel, arbitraryConnectionName, arbitraryLabel)
  .map(([label, connectionName, message]) => ({
    kind: 'error' as const,
    label,
    connectionName,
    message,
  }));

// --- Helper: expected contextValue ---

function expectedContextValue(node: TreeNode): string {
  switch (node.kind) {
    case 'server':
      return 'server';
    case 'folder':
      return 'folder';
    case 'database':
      return node.isOffline ? 'databaseOffline' : 'database';
    case 'table':
      return node.isExternal ? 'externalTable' : 'table';
    case 'view':
      return node.isSystem ? 'systemView' : 'view';
    case 'column':
      if (node.isPrimaryKey) return 'columnPK';
      if (node.isForeignKey) return 'columnFK';
      return 'column';
    case 'error':
      return 'error';
  }
}

// --- Tests ---

describe('ObjectExplorerProvider contextValue Property Tests', () => {
  let provider: ObjectExplorerProvider;
  let mockConnectionManager: any;
  let mockMetadataService: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConnectionManager = {
      getConnections: vi.fn().mockReturnValue([]),
      getGroups: vi.fn().mockReturnValue([]),
      getPool: vi.fn(),
      getPoolForDatabase: vi.fn(),
      saveConnection: vi.fn(),
      removeConnection: vi.fn(),
      loadConnections: vi.fn(),
      dispose: vi.fn(),
    };

    mockMetadataService = {
      getDatabases: vi.fn(),
      getTables: vi.fn(),
      getExternalTables: vi.fn(),
      getViews: vi.fn(),
      getSystemViews: vi.fn(),
      getColumns: vi.fn(),
      getConstraints: vi.fn(),
      getTriggers: vi.fn(),
      getIndexes: vi.fn(),
      getStatistics: vi.fn(),
    };

    provider = new ObjectExplorerProvider(mockConnectionManager, mockMetadataService);
  });

  describe('Feature: ui-overhaul-v2, Property 3: contextValue Assignment Correctness', () => {
    /**
     * Validates: Requirements 5.2
     *
     * For any TreeNode, getTreeItem() assigns a contextValue determined solely by the node's
     * kind and its boolean properties (isExternal, isSystem, isPrimaryKey, isForeignKey, isOffline),
     * following the mapping:
     *   server → "server"
     *   database(online) → "database"
     *   database(offline) → "databaseOffline"
     *   table(user) → "table"
     *   table(external) → "externalTable"
     *   view(user) → "view"
     *   view(system) → "systemView"
     *   column → "column"
     *   column(PK) → "columnPK"
     *   column(FK) → "columnFK"
     *   folder → "folder"
     *   error → "error"
     */

    it('assigns contextValue "server" for any ServerNode', () => {
      fc.assert(
        fc.property(arbitraryServerNode, (node) => {
          const treeItem = provider.getTreeItem(node);
          expect(treeItem.contextValue).toBe('server');
        }),
        { numRuns: 100 }
      );
    });

    it('assigns contextValue "folder" for any FolderNode regardless of folderType', () => {
      fc.assert(
        fc.property(arbitraryFolderNode, (node) => {
          const treeItem = provider.getTreeItem(node);
          expect(treeItem.contextValue).toBe('folder');
        }),
        { numRuns: 100 }
      );
    });

    it('assigns contextValue "database" for online DatabaseNode and "databaseOffline" for offline', () => {
      fc.assert(
        fc.property(arbitraryDatabaseNode, (node) => {
          const treeItem = provider.getTreeItem(node);
          const expected = node.isOffline ? 'databaseOffline' : 'database';
          expect(treeItem.contextValue).toBe(expected);
        }),
        { numRuns: 100 }
      );
    });

    it('assigns contextValue "table" for user TableNode and "externalTable" for external', () => {
      fc.assert(
        fc.property(arbitraryTableNode, (node) => {
          const treeItem = provider.getTreeItem(node);
          const expected = node.isExternal ? 'externalTable' : 'table';
          expect(treeItem.contextValue).toBe(expected);
        }),
        { numRuns: 100 }
      );
    });

    it('assigns contextValue "view" for user ViewNode and "systemView" for system', () => {
      fc.assert(
        fc.property(arbitraryViewNode, (node) => {
          const treeItem = provider.getTreeItem(node);
          const expected = node.isSystem ? 'systemView' : 'view';
          expect(treeItem.contextValue).toBe(expected);
        }),
        { numRuns: 100 }
      );
    });

    it('assigns contextValue "columnPK" for PK, "columnFK" for FK, "column" otherwise', () => {
      fc.assert(
        fc.property(arbitraryColumnNode, (node) => {
          const treeItem = provider.getTreeItem(node);
          const expected = expectedContextValue(node);
          expect(treeItem.contextValue).toBe(expected);
        }),
        { numRuns: 100 }
      );
    });

    it('assigns contextValue "error" for any ErrorNode', () => {
      fc.assert(
        fc.property(arbitraryErrorNode, (node) => {
          const treeItem = provider.getTreeItem(node);
          expect(treeItem.contextValue).toBe('error');
        }),
        { numRuns: 100 }
      );
    });

    it('contextValue is determined solely by kind and boolean properties for any TreeNode', () => {
      const arbitraryTreeNode: fc.Arbitrary<TreeNode> = fc.oneof(
        arbitraryServerNode,
        arbitraryFolderNode,
        arbitraryDatabaseNode,
        arbitraryTableNode,
        arbitraryViewNode,
        arbitraryColumnNode,
        arbitraryErrorNode
      );

      fc.assert(
        fc.property(arbitraryTreeNode, (node) => {
          const treeItem = provider.getTreeItem(node);
          expect(treeItem.contextValue).toBe(expectedContextValue(node));
        }),
        { numRuns: 100 }
      );
    });
  });
});
