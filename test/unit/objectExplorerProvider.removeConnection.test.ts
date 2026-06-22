import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ObjectExplorerProvider } from '../../src/objectExplorer/objectExplorerProvider';
import { ServerNode } from '../../src/objectExplorer/types';

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
    showWarningMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
  },
}));

import * as vscode from 'vscode';

describe('ObjectExplorerProvider.removeConnection', () => {
  let provider: ObjectExplorerProvider;
  let mockConnectionManager: any;
  let mockMetadataService: any;

  const testServerNode: ServerNode = {
    kind: 'server',
    label: 'My Test Server',
    connectionName: 'My Test Server',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockConnectionManager = {
      getConnections: vi.fn().mockReturnValue([]),
      getGroups: vi.fn().mockReturnValue([]),
      removeConnection: vi.fn().mockResolvedValue(undefined),
      getPool: vi.fn(),
      getPoolForDatabase: vi.fn(),
      saveConnection: vi.fn(),
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

  it('shows a confirmation prompt with the connection name', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as any);

    await provider.removeConnection(testServerNode);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'Are you sure you want to remove the connection "My Test Server"?',
      { modal: true },
      'Remove'
    );
  });

  it('removes the connection and refreshes when user confirms', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Remove' as any);

    await provider.removeConnection(testServerNode);

    expect(mockConnectionManager.removeConnection).toHaveBeenCalledWith('My Test Server');
  });

  it('does not remove the connection when user cancels', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as any);

    await provider.removeConnection(testServerNode);

    expect(mockConnectionManager.removeConnection).not.toHaveBeenCalled();
  });

  it('does not remove the connection when user dismisses the dialog', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as any);

    await provider.removeConnection(testServerNode);

    expect(mockConnectionManager.removeConnection).not.toHaveBeenCalled();
  });

  it('uses the node label as the connection name to remove', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Remove' as any);

    const customNode: ServerNode = {
      kind: 'server',
      label: 'Production DB',
      connectionName: 'Production DB',
    };

    await provider.removeConnection(customNode);

    expect(mockConnectionManager.removeConnection).toHaveBeenCalledWith('Production DB');
  });
});
