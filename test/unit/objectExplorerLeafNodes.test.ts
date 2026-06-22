// Unit tests for Object Explorer leaf node behavior (Task 1.3)
// Validates Requirements 4.1, 4.2, 4.3, 4.7, 4.8

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ObjectExplorerProvider } from '../../src/objectExplorer/objectExplorerProvider';
import {
  TriggerNode,
  IndexNode,
  StatisticNode,
  FolderNode,
} from '../../src/objectExplorer/types';

// Mock vscode module — same pattern used across all existing unit tests
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
  Uri: {
    parse: vi.fn((s: string) => s),
  },
}));

/** Creates a minimal mock ObjectExplorerConnectionManager. */
function createMockConnectionManager() {
  const mockPool = { connected: true };
  return {
    getConnections: vi.fn(() => []),
    getGroups: vi.fn(() => []),
    getPool: vi.fn().mockResolvedValue(mockPool),
    getPoolForDatabase: vi.fn().mockResolvedValue(mockPool),
    loadConnections: vi.fn(() => []),
    saveConnection: vi.fn(),
    removeConnection: vi.fn(),
    dispose: vi.fn(),
  };
}

/** Creates a mock MetadataQueryService with all methods returning empty arrays. */
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

// ============================================================================
// Shared sample nodes used across tests
// ============================================================================

const sampleTriggerNode: TriggerNode = {
  kind: 'trigger',
  label: 'trg_AfterInsert',
  connectionName: 'Server1',
  database: 'MyDB',
  schema: 'dbo',
  tableName: 'Orders',
  triggerName: 'trg_AfterInsert',
};

const sampleIndexNode: IndexNode = {
  kind: 'index',
  label: 'IX_Orders_CustomerId',
  connectionName: 'Server1',
  database: 'MyDB',
  schema: 'dbo',
  tableName: 'Orders',
  indexName: 'IX_Orders_CustomerId',
};

const sampleStatisticNode: StatisticNode = {
  kind: 'statistic',
  label: '_WA_Sys_00000001_3A81B327',
  connectionName: 'Server1',
  database: 'MyDB',
  schema: 'dbo',
  tableName: 'Orders',
  statisticName: '_WA_Sys_00000001_3A81B327',
};

// ============================================================================
// Tests
// ============================================================================

describe('Leaf node behavior — TriggerNode, IndexNode, StatisticNode', () => {
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

  // --------------------------------------------------------------------------
  // Requirement 4.1 — TriggerNode is a leaf (collapsibleState None)
  // --------------------------------------------------------------------------
  describe('getTreeItem() — TriggerNode', () => {
    it('returns collapsibleState None for a trigger node (Requirement 4.1)', () => {
      const item = provider.getTreeItem(sampleTriggerNode);
      expect(item.collapsibleState).toBe(0); // vscode.TreeItemCollapsibleState.None
    });

    it('sets contextValue to "trigger"', () => {
      const item = provider.getTreeItem(sampleTriggerNode);
      expect(item.contextValue).toBe('trigger');
    });

    it('preserves the node label in the returned TreeItem', () => {
      const item = provider.getTreeItem(sampleTriggerNode);
      expect(item.label).toBe('trg_AfterInsert');
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 4.2 — IndexNode is a leaf (collapsibleState None)
  // --------------------------------------------------------------------------
  describe('getTreeItem() — IndexNode', () => {
    it('returns collapsibleState None for an index node (Requirement 4.2)', () => {
      const item = provider.getTreeItem(sampleIndexNode);
      expect(item.collapsibleState).toBe(0); // vscode.TreeItemCollapsibleState.None
    });

    it('sets contextValue to "index"', () => {
      const item = provider.getTreeItem(sampleIndexNode);
      expect(item.contextValue).toBe('index');
    });

    it('preserves the node label in the returned TreeItem', () => {
      const item = provider.getTreeItem(sampleIndexNode);
      expect(item.label).toBe('IX_Orders_CustomerId');
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 4.3 — StatisticNode is a leaf (collapsibleState None)
  // --------------------------------------------------------------------------
  describe('getTreeItem() — StatisticNode', () => {
    it('returns collapsibleState None for a statistic node (Requirement 4.3)', () => {
      const item = provider.getTreeItem(sampleStatisticNode);
      expect(item.collapsibleState).toBe(0); // vscode.TreeItemCollapsibleState.None
    });

    it('sets contextValue to "statistic"', () => {
      const item = provider.getTreeItem(sampleStatisticNode);
      expect(item.contextValue).toBe('statistic');
    });

    it('preserves the node label in the returned TreeItem', () => {
      const item = provider.getTreeItem(sampleStatisticNode);
      expect(item.label).toBe('_WA_Sys_00000001_3A81B327');
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 4.8 — getChildren returns [] for every leaf kind
  //   (VS Code should not call this because collapsibleState is None,
  //    but the implementation guards defensively)
  // --------------------------------------------------------------------------
  describe('getChildren() — returns [] for all leaf node kinds', () => {
    it('returns empty array for a trigger node (Requirement 4.8)', async () => {
      const result = await provider.getChildren(sampleTriggerNode);
      expect(result).toEqual([]);
    });

    it('returns empty array for an index node (Requirement 4.8)', async () => {
      const result = await provider.getChildren(sampleIndexNode);
      expect(result).toEqual([]);
    });

    it('returns empty array for a statistic node (Requirement 4.8)', async () => {
      const result = await provider.getChildren(sampleStatisticNode);
      expect(result).toEqual([]);
    });

    it('does not call any metadata service methods when getChildren is called on a trigger', async () => {
      await provider.getChildren(sampleTriggerNode);
      expect(mockMetadataService.getTriggers).not.toHaveBeenCalled();
    });

    it('does not call any metadata service methods when getChildren is called on an index', async () => {
      await provider.getChildren(sampleIndexNode);
      expect(mockMetadataService.getIndexes).not.toHaveBeenCalled();
    });

    it('does not call any metadata service methods when getChildren is called on a statistic', async () => {
      await provider.getChildren(sampleStatisticNode);
      expect(mockMetadataService.getStatistics).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 4.7 — Empty Triggers/Indexes/Statistics folders return []
  //   with no error nodes
  // --------------------------------------------------------------------------
  describe('getChildren() — empty Triggers folder returns [] with no error nodes (Requirement 4.7)', () => {
    it('returns empty array when getTriggers query returns no results', async () => {
      mockMetadataService.getTriggers.mockResolvedValue([]);

      const triggersFolder: FolderNode = {
        kind: 'folder',
        label: 'Triggers',
        connectionName: 'Server1',
        folderType: 'triggers',
        database: 'MyDB',
        schema: 'dbo',
        objectName: 'Orders',
      };

      const result = await provider.getChildren(triggersFolder);

      expect(result).toEqual([]);
    });

    it('returns no error nodes when triggers folder is empty', async () => {
      mockMetadataService.getTriggers.mockResolvedValue([]);

      const triggersFolder: FolderNode = {
        kind: 'folder',
        label: 'Triggers',
        connectionName: 'Server1',
        folderType: 'triggers',
        database: 'MyDB',
        schema: 'dbo',
        objectName: 'Orders',
      };

      const result = await provider.getChildren(triggersFolder);

      const errorNodes = result.filter(n => n.kind === 'error');
      expect(errorNodes).toHaveLength(0);
    });

    it('returns empty array when getIndexes query returns no results', async () => {
      mockMetadataService.getIndexes.mockResolvedValue([]);

      const indexesFolder: FolderNode = {
        kind: 'folder',
        label: 'Indexes',
        connectionName: 'Server1',
        folderType: 'indexes',
        database: 'MyDB',
        schema: 'dbo',
        objectName: 'Orders',
      };

      const result = await provider.getChildren(indexesFolder);

      expect(result).toEqual([]);
    });

    it('returns no error nodes when indexes folder is empty', async () => {
      mockMetadataService.getIndexes.mockResolvedValue([]);

      const indexesFolder: FolderNode = {
        kind: 'folder',
        label: 'Indexes',
        connectionName: 'Server1',
        folderType: 'indexes',
        database: 'MyDB',
        schema: 'dbo',
        objectName: 'Orders',
      };

      const result = await provider.getChildren(indexesFolder);

      const errorNodes = result.filter(n => n.kind === 'error');
      expect(errorNodes).toHaveLength(0);
    });

    it('returns empty array when getStatistics query returns no results', async () => {
      mockMetadataService.getStatistics.mockResolvedValue([]);

      const statisticsFolder: FolderNode = {
        kind: 'folder',
        label: 'Statistics',
        connectionName: 'Server1',
        folderType: 'statistics',
        database: 'MyDB',
        schema: 'dbo',
        objectName: 'Orders',
      };

      const result = await provider.getChildren(statisticsFolder);

      expect(result).toEqual([]);
    });

    it('returns no error nodes when statistics folder is empty', async () => {
      mockMetadataService.getStatistics.mockResolvedValue([]);

      const statisticsFolder: FolderNode = {
        kind: 'folder',
        label: 'Statistics',
        connectionName: 'Server1',
        folderType: 'statistics',
        database: 'MyDB',
        schema: 'dbo',
        objectName: 'Orders',
      };

      const result = await provider.getChildren(statisticsFolder);

      const errorNodes = result.filter(n => n.kind === 'error');
      expect(errorNodes).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 4.1–4.3 — Non-empty folders return correct leaf node kinds
  // --------------------------------------------------------------------------
  describe('getChildren() — non-empty folders return typed leaf nodes', () => {
    it('Triggers folder returns TriggerNode items (kind: "trigger") for each result', async () => {
      mockMetadataService.getTriggers.mockResolvedValue([
        { name: 'trg_Insert', type: 'AFTER', events: ['INSERT'] },
        { name: 'trg_Update', type: 'AFTER', events: ['UPDATE'] },
      ]);

      const triggersFolder: FolderNode = {
        kind: 'folder',
        label: 'Triggers',
        connectionName: 'Server1',
        folderType: 'triggers',
        database: 'MyDB',
        schema: 'dbo',
        objectName: 'Orders',
      };

      const result = await provider.getChildren(triggersFolder);

      expect(result).toHaveLength(2);
      expect(result.every(n => n.kind === 'trigger')).toBe(true);
    });

    it('trigger leaf nodes have collapsibleState None when passed to getTreeItem', async () => {
      mockMetadataService.getTriggers.mockResolvedValue([
        { name: 'trg_Delete', type: 'AFTER', events: ['DELETE'] },
      ]);

      const triggersFolder: FolderNode = {
        kind: 'folder',
        label: 'Triggers',
        connectionName: 'Server1',
        folderType: 'triggers',
        database: 'MyDB',
        schema: 'dbo',
        objectName: 'Customers',
      };

      const children = await provider.getChildren(triggersFolder);
      const item = provider.getTreeItem(children[0]);

      expect(item.collapsibleState).toBe(0); // None
    });

    it('Indexes folder returns IndexNode items (kind: "index") for each result', async () => {
      mockMetadataService.getIndexes.mockResolvedValue([
        { name: 'PK_Orders', type: 'CLUSTERED', columns: ['OrderId'] },
        { name: 'IX_CustomerId', type: 'NONCLUSTERED', columns: ['CustomerId'] },
      ]);

      const indexesFolder: FolderNode = {
        kind: 'folder',
        label: 'Indexes',
        connectionName: 'Server1',
        folderType: 'indexes',
        database: 'MyDB',
        schema: 'dbo',
        objectName: 'Orders',
      };

      const result = await provider.getChildren(indexesFolder);

      expect(result).toHaveLength(2);
      expect(result.every(n => n.kind === 'index')).toBe(true);
    });

    it('index leaf nodes have collapsibleState None when passed to getTreeItem', async () => {
      mockMetadataService.getIndexes.mockResolvedValue([
        { name: 'PK_Orders', type: 'CLUSTERED', columns: ['OrderId'] },
      ]);

      const indexesFolder: FolderNode = {
        kind: 'folder',
        label: 'Indexes',
        connectionName: 'Server1',
        folderType: 'indexes',
        database: 'MyDB',
        schema: 'dbo',
        objectName: 'Orders',
      };

      const children = await provider.getChildren(indexesFolder);
      const item = provider.getTreeItem(children[0]);

      expect(item.collapsibleState).toBe(0); // None
    });

    it('Statistics folder returns StatisticNode items (kind: "statistic") for each result', async () => {
      mockMetadataService.getStatistics.mockResolvedValue([
        { name: '_WA_Sys_01', columns: ['Col1'], lastUpdated: null },
        { name: '_WA_Sys_02', columns: ['Col2'], lastUpdated: null },
      ]);

      const statisticsFolder: FolderNode = {
        kind: 'folder',
        label: 'Statistics',
        connectionName: 'Server1',
        folderType: 'statistics',
        database: 'MyDB',
        schema: 'dbo',
        objectName: 'Orders',
      };

      const result = await provider.getChildren(statisticsFolder);

      expect(result).toHaveLength(2);
      expect(result.every(n => n.kind === 'statistic')).toBe(true);
    });

    it('statistic leaf nodes have collapsibleState None when passed to getTreeItem', async () => {
      mockMetadataService.getStatistics.mockResolvedValue([
        { name: '_WA_Sys_01', columns: ['OrderDate'], lastUpdated: null },
      ]);

      const statisticsFolder: FolderNode = {
        kind: 'folder',
        label: 'Statistics',
        connectionName: 'Server1',
        folderType: 'statistics',
        database: 'MyDB',
        schema: 'dbo',
        objectName: 'Orders',
      };

      const children = await provider.getChildren(statisticsFolder);
      const item = provider.getTreeItem(children[0]);

      expect(item.collapsibleState).toBe(0); // None
    });
  });

  // --------------------------------------------------------------------------
  // Requirement 4.9 — Metadata query failure returns an ErrorNode (not a loop)
  // --------------------------------------------------------------------------
  describe('getChildren() — metadata query failure returns a single ErrorNode', () => {
    it('returns a single error node when getTriggers throws', async () => {
      mockMetadataService.getTriggers.mockRejectedValue(new Error('Triggers query failed'));

      const triggersFolder: FolderNode = {
        kind: 'folder',
        label: 'Triggers',
        connectionName: 'Server1',
        folderType: 'triggers',
        database: 'MyDB',
        schema: 'dbo',
        objectName: 'Orders',
      };

      const result = await provider.getChildren(triggersFolder);

      expect(result).toHaveLength(1);
      expect(result[0].kind).toBe('error');
      expect((result[0] as any).message).toBe('Triggers query failed');
    });

    it('returns a single error node when getIndexes throws', async () => {
      mockMetadataService.getIndexes.mockRejectedValue(new Error('Indexes query failed'));

      const indexesFolder: FolderNode = {
        kind: 'folder',
        label: 'Indexes',
        connectionName: 'Server1',
        folderType: 'indexes',
        database: 'MyDB',
        schema: 'dbo',
        objectName: 'Orders',
      };

      const result = await provider.getChildren(indexesFolder);

      expect(result).toHaveLength(1);
      expect(result[0].kind).toBe('error');
      expect((result[0] as any).message).toBe('Indexes query failed');
    });

    it('returns a single error node when getStatistics throws', async () => {
      mockMetadataService.getStatistics.mockRejectedValue(new Error('Statistics query failed'));

      const statisticsFolder: FolderNode = {
        kind: 'folder',
        label: 'Statistics',
        connectionName: 'Server1',
        folderType: 'statistics',
        database: 'MyDB',
        schema: 'dbo',
        objectName: 'Orders',
      };

      const result = await provider.getChildren(statisticsFolder);

      expect(result).toHaveLength(1);
      expect(result[0].kind).toBe('error');
      expect((result[0] as any).message).toBe('Statistics query failed');
    });
  });
});
