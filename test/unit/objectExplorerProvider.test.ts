import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ObjectExplorerProvider } from '../../src/objectExplorer/objectExplorerProvider';
import {
  TreeNode,
  ServerNode,
  FolderNode,
  DatabaseNode,
  TableNode,
  ViewNode,
  ServerConnectionConfig,
} from '../../src/objectExplorer/types';

// Mock vscode module
vi.mock('vscode', () => ({
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2,
  },
  TreeItem: class MockTreeItem {
    label: string;
    collapsibleState?: number;
    contextValue?: string;
    iconPath?: any;
    description?: string;
    constructor(label: string) {
      this.label = label;
    }
  },
  ThemeIcon: class MockThemeIcon {
    id: string;
    constructor(id: string) {
      this.id = id;
    }
  },
  EventEmitter: class MockEventEmitter {
    event = vi.fn();
    fire = vi.fn();
    dispose = vi.fn();
  },
}));

/**
 * Creates a mock ObjectExplorerConnectionManager with configurable connections.
 */
function createMockConnectionManager(connections: ServerConnectionConfig[] = []) {
  const mockPool = { connected: true };
  return {
    getConnections: vi.fn(() => connections),
    getGroups: vi.fn(() => []),
    getPool: vi.fn().mockResolvedValue(mockPool),
    getPoolForDatabase: vi.fn().mockResolvedValue(mockPool),
    loadConnections: vi.fn(() => connections),
    saveConnection: vi.fn(),
    removeConnection: vi.fn(),
    dispose: vi.fn(),
  };
}

/**
 * Creates a mock MetadataQueryService with configurable return values.
 */
function createMockMetadataService() {
  return {
    getDatabases: vi.fn().mockResolvedValue([]),
    getTables: vi.fn().mockResolvedValue([]),
    getExternalTables: vi.fn().mockResolvedValue([]),
    getViews: vi.fn().mockResolvedValue([]),
    getSystemViews: vi.fn().mockResolvedValue([]),
    getColumns: vi.fn().mockResolvedValue([]),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTriggers: vi.fn().mockResolvedValue([]),
    getIndexes: vi.fn().mockResolvedValue([]),
    getStatistics: vi.fn().mockResolvedValue([]),
  };
}

describe('ObjectExplorerProvider', () => {
  let provider: ObjectExplorerProvider;
  let mockConnectionManager: ReturnType<typeof createMockConnectionManager>;
  let mockMetadataService: ReturnType<typeof createMockMetadataService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectionManager = createMockConnectionManager();
    mockMetadataService = createMockMetadataService();
    provider = new ObjectExplorerProvider(
      mockConnectionManager as any,
      mockMetadataService as any
    );
  });

  describe('getChildren() - root nodes', () => {
    it('returns empty array when no connections exist', async () => {
      mockConnectionManager.getConnections.mockReturnValue([]);

      const result = await provider.getChildren(undefined);

      expect(result).toEqual([]);
    });

    it('returns server nodes for each configured connection', async () => {
      mockConnectionManager.getConnections.mockReturnValue([
        { name: 'Server1', host: 'host1', authType: 'windows' as const },
        { name: 'Server2', host: 'host2', authType: 'sql' as const },
      ]);

      const result = await provider.getChildren(undefined);

      expect(result).toHaveLength(2);
      expect(result[0].kind).toBe('server');
      expect(result[1].kind).toBe('server');
    });

    it('sorts server nodes alphabetically (case-insensitive)', async () => {
      mockConnectionManager.getConnections.mockReturnValue([
        { name: 'Zeta', host: 'h1', authType: 'windows' as const },
        { name: 'alpha', host: 'h2', authType: 'windows' as const },
        { name: 'Beta', host: 'h3', authType: 'windows' as const },
      ]);

      const result = await provider.getChildren(undefined);

      expect(result.map(n => n.label)).toEqual(['alpha', 'Beta', 'Zeta']);
    });
  });

  describe('getChildren() - server node → 3 folders', () => {
    it('returns exactly 3 folder nodes: Databases, Security, Server Objects', async () => {
      const serverNode: ServerNode = {
        kind: 'server',
        label: 'MyServer',
        connectionName: 'MyServer',
      };

      const result = await provider.getChildren(serverNode);

      expect(result).toHaveLength(3);
      expect(result[0].kind).toBe('folder');
      expect(result[1].kind).toBe('folder');
      expect(result[2].kind).toBe('folder');
      expect(result[0].label).toBe('Databases');
      expect(result[1].label).toBe('Security');
      expect(result[2].label).toBe('Server Objects');
    });

    it('folder nodes have correct folderType values', async () => {
      const serverNode: ServerNode = {
        kind: 'server',
        label: 'MyServer',
        connectionName: 'MyServer',
      };

      const result = await provider.getChildren(serverNode) as FolderNode[];

      expect(result[0].folderType).toBe('databases');
      expect(result[1].folderType).toBe('security');
      expect(result[2].folderType).toBe('serverObjects');
    });

    it('folder nodes inherit the connectionName from the server node', async () => {
      const serverNode: ServerNode = {
        kind: 'server',
        label: 'ProdServer',
        connectionName: 'ProdServer',
      };

      const result = await provider.getChildren(serverNode);

      for (const node of result) {
        expect(node.connectionName).toBe('ProdServer');
      }
    });
  });

  describe('getChildren() - database node → 8 folders', () => {
    it('returns exactly 8 folder nodes for a database', async () => {
      const dbNode: DatabaseNode = {
        kind: 'database',
        label: 'MyDB',
        connectionName: 'Server1',
        databaseName: 'MyDB',
        isSystem: false,
        isOffline: false,
      };

      const result = await provider.getChildren(dbNode);

      expect(result).toHaveLength(8);
    });

    it('returns folders in correct order: Tables, Views, Synonyms, Programmability, External Resources, Service Broker, Storage, Security', async () => {
      const dbNode: DatabaseNode = {
        kind: 'database',
        label: 'MyDB',
        connectionName: 'Server1',
        databaseName: 'MyDB',
        isSystem: false,
        isOffline: false,
      };

      const result = await provider.getChildren(dbNode);

      const labels = result.map(n => n.label);
      expect(labels).toEqual([
        'Tables',
        'Views',
        'Synonyms',
        'Programmability',
        'External Resources',
        'Service Broker',
        'Storage',
        'Security',
      ]);
    });

    it('all database folder nodes have correct folderTypes', async () => {
      const dbNode: DatabaseNode = {
        kind: 'database',
        label: 'TestDB',
        connectionName: 'Server1',
        databaseName: 'TestDB',
        isSystem: false,
        isOffline: false,
      };

      const result = await provider.getChildren(dbNode) as FolderNode[];

      expect(result[0].folderType).toBe('tables');
      expect(result[1].folderType).toBe('views');
      expect(result[2].folderType).toBe('synonyms');
      expect(result[3].folderType).toBe('programmability');
      expect(result[4].folderType).toBe('externalResources');
      expect(result[5].folderType).toBe('serviceBroker');
      expect(result[6].folderType).toBe('storage');
      expect(result[7].folderType).toBe('dbSecurity');
    });

    it('database folder nodes carry the database name', async () => {
      const dbNode: DatabaseNode = {
        kind: 'database',
        label: 'SalesDB',
        connectionName: 'Server1',
        databaseName: 'SalesDB',
        isSystem: false,
        isOffline: false,
      };

      const result = await provider.getChildren(dbNode) as FolderNode[];

      for (const folder of result) {
        expect(folder.database).toBe('SalesDB');
      }
    });
  });

  describe('getChildren() - table node → 5 folders', () => {
    it('returns exactly 5 folder nodes for a table', async () => {
      const tableNode: TableNode = {
        kind: 'table',
        label: 'dbo.Orders',
        connectionName: 'Server1',
        database: 'MyDB',
        schema: 'dbo',
        tableName: 'Orders',
        isExternal: false,
      };

      const result = await provider.getChildren(tableNode);

      expect(result).toHaveLength(5);
    });

    it('returns folders: Columns, Constraints, Triggers, Indexes, Statistics', async () => {
      const tableNode: TableNode = {
        kind: 'table',
        label: 'dbo.Orders',
        connectionName: 'Server1',
        database: 'MyDB',
        schema: 'dbo',
        tableName: 'Orders',
        isExternal: false,
      };

      const result = await provider.getChildren(tableNode);

      const labels = result.map(n => n.label);
      expect(labels).toEqual(['Columns', 'Constraints', 'Triggers', 'Indexes', 'Statistics']);
    });

    it('table folder nodes carry schema and objectName', async () => {
      const tableNode: TableNode = {
        kind: 'table',
        label: 'sales.Customers',
        connectionName: 'Server1',
        database: 'MyDB',
        schema: 'sales',
        tableName: 'Customers',
        isExternal: false,
      };

      const result = await provider.getChildren(tableNode) as FolderNode[];

      for (const folder of result) {
        expect(folder.schema).toBe('sales');
        expect(folder.objectName).toBe('Customers');
        expect(folder.database).toBe('MyDB');
      }
    });
  });

  describe('getChildren() - view node → 5 folders', () => {
    it('returns exactly 5 folder nodes for a view', async () => {
      const viewNode: ViewNode = {
        kind: 'view',
        label: 'dbo.vw_ActiveOrders',
        connectionName: 'Server1',
        database: 'MyDB',
        schema: 'dbo',
        viewName: 'vw_ActiveOrders',
        isSystem: false,
      };

      const result = await provider.getChildren(viewNode);

      expect(result).toHaveLength(5);
      const labels = result.map(n => n.label);
      expect(labels).toEqual(['Columns', 'Constraints', 'Triggers', 'Indexes', 'Statistics']);
    });

    it('view folder nodes carry schema and objectName from the view', async () => {
      const viewNode: ViewNode = {
        kind: 'view',
        label: 'reporting.vw_Summary',
        connectionName: 'Server1',
        database: 'AnalyticsDB',
        schema: 'reporting',
        viewName: 'vw_Summary',
        isSystem: false,
      };

      const result = await provider.getChildren(viewNode) as FolderNode[];

      for (const folder of result) {
        expect(folder.schema).toBe('reporting');
        expect(folder.objectName).toBe('vw_Summary');
        expect(folder.database).toBe('AnalyticsDB');
      }
    });
  });

  describe('getChildren() - empty folder behavior', () => {
    it('returns empty array for Security folder (placeholder)', async () => {
      const securityFolder: FolderNode = {
        kind: 'folder',
        label: 'Security',
        connectionName: 'Server1',
        folderType: 'security',
      };

      const result = await provider.getChildren(securityFolder);

      expect(result).toEqual([]);
    });

    it('returns empty array for Server Objects folder (placeholder)', async () => {
      const serverObjectsFolder: FolderNode = {
        kind: 'folder',
        label: 'Server Objects',
        connectionName: 'Server1',
        folderType: 'serverObjects',
      };

      const result = await provider.getChildren(serverObjectsFolder);

      expect(result).toEqual([]);
    });

    it('returns empty array when tables query returns no results', async () => {
      mockMetadataService.getTables.mockResolvedValue([]);

      const tablesFolder: FolderNode = {
        kind: 'folder',
        label: 'Tables',
        connectionName: 'Server1',
        folderType: 'tablesUser',
        database: 'EmptyDB',
      };

      const result = await provider.getChildren(tablesFolder);

      expect(result).toEqual([]);
    });

    it('returns empty array when columns query returns no results', async () => {
      mockMetadataService.getColumns.mockResolvedValue([]);

      const columnsFolder: FolderNode = {
        kind: 'folder',
        label: 'Columns',
        connectionName: 'Server1',
        folderType: 'columns',
        database: 'MyDB',
        schema: 'dbo',
        objectName: 'EmptyTable',
      };

      const result = await provider.getChildren(columnsFolder);

      expect(result).toEqual([]);
    });

    it('returns empty array for Synonyms folder (placeholder)', async () => {
      const synonymsFolder: FolderNode = {
        kind: 'folder',
        label: 'Synonyms',
        connectionName: 'Server1',
        folderType: 'synonyms',
        database: 'MyDB',
      };

      const result = await provider.getChildren(synonymsFolder);

      expect(result).toEqual([]);
    });
  });

  describe('getChildren() - error node generation on failures', () => {
    it('returns an error node when getDatabases throws', async () => {
      mockConnectionManager.getPool.mockResolvedValue({});
      mockMetadataService.getDatabases.mockRejectedValue(new Error('Connection timeout'));

      const databasesFolder: FolderNode = {
        kind: 'folder',
        label: 'Databases',
        connectionName: 'Server1',
        folderType: 'databases',
      };

      const result = await provider.getChildren(databasesFolder);

      expect(result).toHaveLength(1);
      expect(result[0].kind).toBe('error');
      expect((result[0] as any).message).toBe('Connection timeout');
    });

    it('returns an error node when getPool throws', async () => {
      mockConnectionManager.getPool.mockRejectedValue(new Error('Connection "Server1" not found.'));

      const databasesFolder: FolderNode = {
        kind: 'folder',
        label: 'Databases',
        connectionName: 'Server1',
        folderType: 'databases',
      };

      const result = await provider.getChildren(databasesFolder);

      expect(result).toHaveLength(1);
      expect(result[0].kind).toBe('error');
      expect((result[0] as any).message).toBe('Connection "Server1" not found.');
    });

    it('returns an error node when getTables throws permission error', async () => {
      mockMetadataService.getTables.mockRejectedValue(
        new Error('The server principal does not have permission')
      );

      const tablesFolder: FolderNode = {
        kind: 'folder',
        label: 'Tables',
        connectionName: 'Server1',
        folderType: 'tablesUser',
        database: 'SecureDB',
      };

      const result = await provider.getChildren(tablesFolder);

      expect(result).toHaveLength(1);
      expect(result[0].kind).toBe('error');
      expect((result[0] as any).message).toContain('permission');
    });

    it('error node has the correct connectionName', async () => {
      mockConnectionManager.getPool.mockRejectedValue(new Error('Network error'));

      const folder: FolderNode = {
        kind: 'folder',
        label: 'Databases',
        connectionName: 'ProdServer',
        folderType: 'databases',
      };

      const result = await provider.getChildren(folder);

      expect(result[0].connectionName).toBe('ProdServer');
    });
  });

  describe('getChildren() - node sorting', () => {
    it('sorts database nodes alphabetically (case-insensitive)', async () => {
      mockMetadataService.getDatabases.mockResolvedValue([
        { name: 'Zebra', isSystem: false, state: 'online' },
        { name: 'alpha', isSystem: false, state: 'online' },
        { name: 'Beta', isSystem: false, state: 'online' },
      ]);

      const databasesFolder: FolderNode = {
        kind: 'folder',
        label: 'Databases',
        connectionName: 'Server1',
        folderType: 'databases',
      };

      const result = await provider.getChildren(databasesFolder);

      // User databases sorted + System Databases folder at end
      const userDbLabels = result.filter(n => n.kind === 'database').map(n => n.label);
      expect(userDbLabels).toEqual(['alpha', 'Beta', 'Zebra']);
    });

    it('sorts table nodes alphabetically by schema-qualified label', async () => {
      mockMetadataService.getTables.mockResolvedValue([
        { schema: 'sales', name: 'Orders', isExternal: false },
        { schema: 'dbo', name: 'Products', isExternal: false },
        { schema: 'dbo', name: 'Customers', isExternal: false },
      ]);

      const tablesFolder: FolderNode = {
        kind: 'folder',
        label: 'Tables',
        connectionName: 'Server1',
        folderType: 'tablesUser',
        database: 'MyDB',
      };

      const result = await provider.getChildren(tablesFolder);

      const labels = result.map(n => n.label);
      expect(labels).toEqual(['dbo.Customers', 'dbo.Products', 'sales.Orders']);
    });

    it('sorts view nodes alphabetically', async () => {
      mockMetadataService.getViews.mockResolvedValue([
        { schema: 'reporting', name: 'vw_Summary', isSystem: false },
        { schema: 'dbo', name: 'vw_Active', isSystem: false },
      ]);

      const viewsFolder: FolderNode = {
        kind: 'folder',
        label: 'Views',
        connectionName: 'Server1',
        folderType: 'viewsUser',
        database: 'MyDB',
      };

      const result = await provider.getChildren(viewsFolder);

      const labels = result.map(n => n.label);
      expect(labels).toEqual(['dbo.vw_Active', 'reporting.vw_Summary']);
    });
  });

  describe('getChildren() - Databases folder with categorization', () => {
    it('separates user and system databases correctly', async () => {
      mockMetadataService.getDatabases.mockResolvedValue([
        { name: 'master', isSystem: true, state: 'online' },
        { name: 'model', isSystem: true, state: 'online' },
        { name: 'msdb', isSystem: true, state: 'online' },
        { name: 'tempdb', isSystem: true, state: 'online' },
        { name: 'AppDB', isSystem: false, state: 'online' },
        { name: 'Analytics', isSystem: false, state: 'online' },
      ]);

      const databasesFolder: FolderNode = {
        kind: 'folder',
        label: 'Databases',
        connectionName: 'Server1',
        folderType: 'databases',
      };

      const result = await provider.getChildren(databasesFolder);

      // Should have 2 user databases + 1 System Databases folder
      const dbNodes = result.filter(n => n.kind === 'database');
      const folderNodes = result.filter(n => n.kind === 'folder');

      expect(dbNodes).toHaveLength(2);
      expect(folderNodes).toHaveLength(1);
      expect(folderNodes[0].label).toBe('System Databases');
    });

    it('System Databases folder returns system database nodes', async () => {
      mockMetadataService.getDatabases.mockResolvedValue([
        { name: 'master', isSystem: true, state: 'online' },
        { name: 'model', isSystem: true, state: 'online' },
        { name: 'msdb', isSystem: true, state: 'online' },
        { name: 'tempdb', isSystem: true, state: 'online' },
        { name: 'UserDB', isSystem: false, state: 'online' },
      ]);

      const systemDbFolder: FolderNode = {
        kind: 'folder',
        label: 'System Databases',
        connectionName: 'Server1',
        folderType: 'systemDatabases',
      };

      const result = await provider.getChildren(systemDbFolder);

      expect(result).toHaveLength(4);
      const labels = result.map(n => n.label);
      expect(labels).toContain('master');
      expect(labels).toContain('model');
      expect(labels).toContain('msdb');
      expect(labels).toContain('tempdb');
    });
  });

  describe('getChildren() - Tables folder structure', () => {
    it('Tables folder returns Tables and External Tables sub-folders', async () => {
      const tablesFolder: FolderNode = {
        kind: 'folder',
        label: 'Tables',
        connectionName: 'Server1',
        folderType: 'tables',
        database: 'MyDB',
      };

      const result = await provider.getChildren(tablesFolder);

      expect(result).toHaveLength(2);
      expect(result[0].label).toBe('Tables');
      expect(result[1].label).toBe('External Tables');
      expect((result[0] as FolderNode).folderType).toBe('tablesUser');
      expect((result[1] as FolderNode).folderType).toBe('tablesExternal');
    });
  });

  describe('getChildren() - Views folder structure', () => {
    it('Views folder returns Views and System Views sub-folders', async () => {
      const viewsFolder: FolderNode = {
        kind: 'folder',
        label: 'Views',
        connectionName: 'Server1',
        folderType: 'views',
        database: 'MyDB',
      };

      const result = await provider.getChildren(viewsFolder);

      expect(result).toHaveLength(2);
      expect(result[0].label).toBe('Views');
      expect(result[1].label).toBe('System Views');
      expect((result[0] as FolderNode).folderType).toBe('viewsUser');
      expect((result[1] as FolderNode).folderType).toBe('viewsSystem');
    });
  });

  describe('getTreeItem()', () => {
    it('maps server node to collapsed tree item with server icon', () => {
      const serverNode: ServerNode = {
        kind: 'server',
        label: 'MyServer',
        connectionName: 'MyServer',
      };

      const item = provider.getTreeItem(serverNode);

      expect(item.label).toBe('MyServer');
      expect(item.collapsibleState).toBe(1); // Collapsed
      expect(item.contextValue).toBe('server');
    });

    it('maps folder node to collapsed tree item', () => {
      const folderNode: FolderNode = {
        kind: 'folder',
        label: 'Databases',
        connectionName: 'Server1',
        folderType: 'databases',
      };

      const item = provider.getTreeItem(folderNode);

      expect(item.label).toBe('Databases');
      expect(item.collapsibleState).toBe(1); // Collapsed
      expect(item.contextValue).toBe('folder');
    });

    it('maps error node to non-collapsible tree item with error message', () => {
      const errorNode: TreeNode = {
        kind: 'error',
        label: 'Error',
        connectionName: 'Server1',
        message: 'Connection failed',
      };

      const item = provider.getTreeItem(errorNode);

      expect(item.collapsibleState).toBe(0); // None
      expect(item.contextValue).toBe('error');
      expect(item.description).toBe('Connection failed');
    });

    it('maps column node to non-collapsible leaf item', () => {
      const columnNode: TreeNode = {
        kind: 'column',
        label: 'Id (int)',
        connectionName: 'Server1',
        database: 'MyDB',
        columnName: 'Id',
        dataType: 'int',
        isPrimaryKey: true,
        isForeignKey: false,
      };

      const item = provider.getTreeItem(columnNode);

      expect(item.collapsibleState).toBe(0); // None
      expect(item.contextValue).toBe('columnPK');
    });
  });

  describe('Circular Reference Protection', () => {
    describe('Self-referencing FK rendered as leaf (Requirement 5.5)', () => {
      it('self-referencing FK constraint is displayed as a leaf node with kind constraint', async () => {
        // A table "Employees" has a self-referencing FK: ManagerId → Employees.Id
        mockMetadataService.getConstraints.mockResolvedValue([
          { name: 'FK_Employees_Manager', type: 'FOREIGN KEY' },
        ]);

        const constraintsFolder: FolderNode = {
          kind: 'folder',
          label: 'Constraints',
          connectionName: 'Server1',
          folderType: 'constraints',
          database: 'MyDB',
          schema: 'dbo',
          objectName: 'Employees',
        };

        const result = await provider.getChildren(constraintsFolder);

        expect(result).toHaveLength(1);
        expect(result[0].kind).toBe('constraint');
        expect(result[0].label).toBe('FK_Employees_Manager (FOREIGN KEY)');
      });

      it('constraint node has TreeItemCollapsibleState.None (not expandable)', () => {
        const constraintNode: TreeNode = {
          kind: 'constraint',
          label: 'FK_Employees_Manager (FOREIGN KEY)',
          connectionName: 'Server1',
          database: 'MyDB',
          schema: 'dbo',
          tableName: 'Employees',
          constraintName: 'FK_Employees_Manager',
          constraintType: 'FOREIGN KEY',
        };

        const item = provider.getTreeItem(constraintNode);

        // TreeItemCollapsibleState.None === 0
        expect(item.collapsibleState).toBe(0);
      });

      it('getChildren returns empty array for a constraint node (defensive)', async () => {
        const constraintNode: TreeNode = {
          kind: 'constraint',
          label: 'FK_Employees_Manager (FOREIGN KEY)',
          connectionName: 'Server1',
          database: 'MyDB',
          schema: 'dbo',
          tableName: 'Employees',
          constraintName: 'FK_Employees_Manager',
          constraintType: 'FOREIGN KEY',
        };

        const result = await provider.getChildren(constraintNode);

        expect(result).toEqual([]);
      });
    });

    describe('Mutual FK cycle (A→B→A) terminates at depth (Requirement 5.4)', () => {
      it('mutual cycle between two folder nodes terminates via ancestor-path detection', async () => {
        // Simulate: Table A has FK to Table B, Table B has FK to Table A.
        // Expanding A → Constraints folder → (leaf).
        // The cycle detection operates at the folder level: if expanding
        // the same identity (connectionName+database+schema+objectName+folderType) twice
        // in a single path, it returns [].

        // Create folder nodes representing the same structural position (same identity)
        const folderA: FolderNode = {
          kind: 'folder',
          label: 'Constraints',
          connectionName: 'Server1',
          folderType: 'constraints',
          database: 'MyDB',
          schema: 'dbo',
          objectName: 'TableA',
        };

        // First expansion works normally
        mockMetadataService.getConstraints.mockResolvedValue([
          { name: 'FK_A_to_B', type: 'FOREIGN KEY' },
        ]);
        const firstResult = await provider.getChildren(folderA);
        expect(firstResult.length).toBeGreaterThan(0);

        // Now simulate cycle: same identity node expanded again in the same path.
        // The provider uses expansionPaths to track ancestors.
        // Manually set up the expansion path so that folderA's identity is already an ancestor.
        const identity = {
          connectionName: 'Server1',
          database: 'MyDB',
          schema: 'dbo',
          objectName: 'TableA',
          folderType: 'constraints' as const,
        };
        const identityKey = `Server1::MyDB::dbo::TableA::constraints`;
        // Set the path so the node already appears as its own ancestor
        (provider as any).expansionPaths.set(identityKey, [identity]);

        const cycleResult = await provider.getChildren(folderA);
        expect(cycleResult).toEqual([]);
      });
    });

    describe('Chain cycle (A→B→C→A) terminates (Requirement 5.6)', () => {
      it('chain cycle of three nodes terminates via ancestor-path detection', async () => {
        // Simulate chain: A → B → C → A
        // When C tries to expand back to A's identity, cycle detection fires.

        const folderC: FolderNode = {
          kind: 'folder',
          label: 'Constraints',
          connectionName: 'Server1',
          folderType: 'constraints',
          database: 'MyDB',
          schema: 'dbo',
          objectName: 'TableC',
        };

        // Set up the expansion path with A and B as ancestors,
        // and C's identity matching A (simulating the cycle back to A)
        const identityA = {
          connectionName: 'Server1',
          database: 'MyDB',
          schema: 'dbo',
          objectName: 'TableC',
          folderType: 'constraints' as const,
        };
        const identityB = {
          connectionName: 'Server1',
          database: 'MyDB',
          schema: 'dbo',
          objectName: 'TableB',
          folderType: 'constraints' as const,
        };

        // folderC has identity that matches identityA in its ancestor path
        const identityKey = `Server1::MyDB::dbo::TableC::constraints`;
        (provider as any).expansionPaths.set(identityKey, [identityA, identityB]);

        const result = await provider.getChildren(folderC);
        expect(result).toEqual([]);
      });

      it('chain cycle detected even with different folderTypes in the path', async () => {
        // Simulate: TableA (tables folder) → TableB (tables folder) → TableC (tables folder) → TableA
        const tableNodeA: TableNode = {
          kind: 'table',
          label: 'dbo.TableA',
          connectionName: 'Server1',
          database: 'MyDB',
          schema: 'dbo',
          tableName: 'TableA',
          isExternal: false,
        };

        // Put tableA's identity in its own expansion path to simulate the cycle
        const identityA = {
          connectionName: 'Server1',
          database: 'MyDB',
          schema: 'dbo',
          objectName: 'TableA',
        };
        const identityB = {
          connectionName: 'Server1',
          database: 'MyDB',
          schema: 'dbo',
          objectName: 'TableB',
        };
        const identityC = {
          connectionName: 'Server1',
          database: 'MyDB',
          schema: 'dbo',
          objectName: 'TableC',
        };

        // tableA's serialized key: connectionName::database::schema::objectName::folderType
        // For a table node, folderType is undefined
        const identityKey = `Server1::MyDB::dbo::TableA::`;
        (provider as any).expansionPaths.set(identityKey, [identityA, identityB, identityC]);

        // getChildren for tableA should detect that identityA is in the ancestor path
        const result = await provider.getChildren(tableNodeA);
        expect(result).toEqual([]);
      });
    });

    describe('Depth cap - normal expansion without cycles (Requirement 5.3)', () => {
      it('expansion works at depth 0 (no ancestors)', async () => {
        const tableNode: TableNode = {
          kind: 'table',
          label: 'dbo.Orders',
          connectionName: 'Server1',
          database: 'MyDB',
          schema: 'dbo',
          tableName: 'Orders',
          isExternal: false,
        };

        // No expansion path set — depth is 0
        const result = await provider.getChildren(tableNode);

        // Should return the 5 sub-folders (Columns, Constraints, Triggers, Indexes, Statistics)
        expect(result).toHaveLength(5);
      });

      it('expansion works at depth 1', async () => {
        const tableNode: TableNode = {
          kind: 'table',
          label: 'dbo.Orders',
          connectionName: 'Server1',
          database: 'MyDB',
          schema: 'dbo',
          tableName: 'Orders',
          isExternal: false,
        };

        // Set expansion path with 1 ancestor
        const identityKey = `Server1::MyDB::dbo::Orders::`;
        (provider as any).expansionPaths.set(identityKey, [
          { connectionName: 'Server1', database: 'MyDB', schema: 'dbo', objectName: 'Customers' },
        ]);

        const result = await provider.getChildren(tableNode);
        expect(result).toHaveLength(5);
      });

      it('expansion works at depth 2', async () => {
        const tableNode: TableNode = {
          kind: 'table',
          label: 'dbo.Orders',
          connectionName: 'Server1',
          database: 'MyDB',
          schema: 'dbo',
          tableName: 'Orders',
          isExternal: false,
        };

        // Set expansion path with 2 ancestors
        const identityKey = `Server1::MyDB::dbo::Orders::`;
        (provider as any).expansionPaths.set(identityKey, [
          { connectionName: 'Server1', database: 'MyDB', schema: 'dbo', objectName: 'Customers' },
          { connectionName: 'Server1', database: 'MyDB', schema: 'dbo', objectName: 'Products' },
        ]);

        const result = await provider.getChildren(tableNode);
        expect(result).toHaveLength(5);
      });

      it('expansion is blocked at depth 3 (depth cap)', async () => {
        const tableNode: TableNode = {
          kind: 'table',
          label: 'dbo.Orders',
          connectionName: 'Server1',
          database: 'MyDB',
          schema: 'dbo',
          tableName: 'Orders',
          isExternal: false,
        };

        // Set expansion path with 3 ancestors — hits the depth cap
        const identityKey = `Server1::MyDB::dbo::Orders::`;
        (provider as any).expansionPaths.set(identityKey, [
          { connectionName: 'Server1', database: 'MyDB', schema: 'dbo', objectName: 'Customers' },
          { connectionName: 'Server1', database: 'MyDB', schema: 'dbo', objectName: 'Products' },
          { connectionName: 'Server1', database: 'MyDB', schema: 'dbo', objectName: 'Categories' },
        ]);

        const result = await provider.getChildren(tableNode);
        expect(result).toEqual([]);
      });

      it('expansion is blocked at depth 4 (well beyond cap)', async () => {
        const folderNode: FolderNode = {
          kind: 'folder',
          label: 'Constraints',
          connectionName: 'Server1',
          folderType: 'constraints',
          database: 'MyDB',
          schema: 'dbo',
          objectName: 'DeepTable',
        };

        // Set expansion path with 4 ancestors — well beyond depth cap
        const identityKey = `Server1::MyDB::dbo::DeepTable::constraints`;
        (provider as any).expansionPaths.set(identityKey, [
          { connectionName: 'Server1', database: 'MyDB', schema: 'dbo', objectName: 'A' },
          { connectionName: 'Server1', database: 'MyDB', schema: 'dbo', objectName: 'B' },
          { connectionName: 'Server1', database: 'MyDB', schema: 'dbo', objectName: 'C' },
          { connectionName: 'Server1', database: 'MyDB', schema: 'dbo', objectName: 'D' },
        ]);

        const result = await provider.getChildren(folderNode);
        expect(result).toEqual([]);
      });
    });
  });

  describe('refresh()', () => {
    it('fires the onDidChangeTreeData event', () => {
      // Access the internal emitter to verify fire was called
      const fireSpy = vi.spyOn((provider as any)._onDidChangeTreeData, 'fire');

      provider.refresh();

      expect(fireSpy).toHaveBeenCalledWith(undefined);
    });
  });

  describe('refreshNode()', () => {
    it('fires the onDidChangeTreeData event with the specific node', () => {
      const fireSpy = vi.spyOn((provider as any)._onDidChangeTreeData, 'fire');
      const serverNode = { kind: 'server' as const, label: 'TestServer', connectionName: 'TestServer' };

      provider.refreshNode(serverNode);

      expect(fireSpy).toHaveBeenCalledWith(serverNode);
    });

    it('does not fire with undefined (full-tree refresh)', () => {
      const fireSpy = vi.spyOn((provider as any)._onDidChangeTreeData, 'fire');
      const databaseNode = {
        kind: 'database' as const,
        label: 'MyDB',
        connectionName: 'TestServer',
        databaseName: 'MyDB',
        isSystem: false,
        isOffline: false,
      };

      provider.refreshNode(databaseNode);

      expect(fireSpy).toHaveBeenCalledWith(databaseNode);
      expect(fireSpy).not.toHaveBeenCalledWith(undefined);
    });
  });
});
