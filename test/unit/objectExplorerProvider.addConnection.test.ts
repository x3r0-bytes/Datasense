import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ObjectExplorerProvider } from '../../src/objectExplorer/objectExplorerProvider';
import { ServerConnectionConfig } from '../../src/objectExplorer/types';

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

import * as vscode from 'vscode';

describe('ObjectExplorerProvider.addConnection', () => {
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
      saveConnection: vi.fn().mockResolvedValue(undefined),
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

  /**
   * Helper to simulate a full successful Windows Auth connection flow.
   */
  function setupWindowsAuthFlow() {
    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({ label: 'Windows Authentication', value: 'windows' } as any) // auth type
      .mockResolvedValueOnce({ label: 'No', value: false } as any) // encrypt
      .mockResolvedValueOnce({ label: 'Yes', value: true } as any); // trust cert

    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce('localhost') // server name
      .mockResolvedValueOnce('My Local Server') // display name
      .mockResolvedValueOnce(''); // port (empty = default)
  }

  /**
   * Helper to simulate a full successful SQL Auth connection flow.
   */
  function setupSqlAuthFlow() {
    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({ label: 'SQL Server Authentication', value: 'sql' } as any) // auth type
      .mockResolvedValueOnce({ label: 'Yes', value: true } as any) // encrypt
      .mockResolvedValueOnce({ label: 'No', value: false } as any); // trust cert

    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce('db.example.com') // server name
      .mockResolvedValueOnce('Production DB') // display name
      .mockResolvedValueOnce('1433') // port
      .mockResolvedValueOnce('sa') // username
      .mockResolvedValueOnce('P@ssw0rd'); // password
  }

  describe('successful connection flow', () => {
    it('saves a Windows Auth connection and refreshes the tree', async () => {
      setupWindowsAuthFlow();

      await provider.addConnection();

      expect(mockConnectionManager.saveConnection).toHaveBeenCalledTimes(1);
      const savedConfig = mockConnectionManager.saveConnection.mock.calls[0][0] as ServerConnectionConfig;
      expect(savedConfig.name).toBe('My Local Server');
      expect(savedConfig.host).toBe('localhost');
      expect(savedConfig.authType).toBe('windows');
      expect(savedConfig.port).toBeUndefined();
      expect(savedConfig.encrypt).toBe(false);
      expect(savedConfig.trustServerCertificate).toBe(true);
      expect(savedConfig.user).toBeUndefined();
      expect(savedConfig.password).toBeUndefined();
    });

    it('saves a SQL Auth connection with username and password', async () => {
      setupSqlAuthFlow();

      await provider.addConnection();

      expect(mockConnectionManager.saveConnection).toHaveBeenCalledTimes(1);
      const savedConfig = mockConnectionManager.saveConnection.mock.calls[0][0] as ServerConnectionConfig;
      expect(savedConfig.name).toBe('Production DB');
      expect(savedConfig.host).toBe('db.example.com');
      expect(savedConfig.authType).toBe('sql');
      expect(savedConfig.port).toBe(1433);
      expect(savedConfig.encrypt).toBe(true);
      expect(savedConfig.trustServerCertificate).toBe(false);
      expect(savedConfig.user).toBe('sa');
      expect(savedConfig.password).toBe('P@ssw0rd');
    });

    it('refreshes the tree after saving', async () => {
      setupWindowsAuthFlow();
      const refreshSpy = vi.spyOn(provider, 'refresh');

      await provider.addConnection();

      expect(refreshSpy).toHaveBeenCalled();
    });
  });

  describe('cancellation at each step', () => {
    it('does nothing when user cancels auth type selection', async () => {
      vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);

      await provider.addConnection();

      expect(mockConnectionManager.saveConnection).not.toHaveBeenCalled();
    });

    it('does nothing when user cancels server name input', async () => {
      vi.mocked(vscode.window.showQuickPick)
        .mockResolvedValueOnce({ label: 'Windows Authentication', value: 'windows' } as any);
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);

      await provider.addConnection();

      expect(mockConnectionManager.saveConnection).not.toHaveBeenCalled();
    });

    it('does nothing when user cancels display name input', async () => {
      vi.mocked(vscode.window.showQuickPick)
        .mockResolvedValueOnce({ label: 'Windows Authentication', value: 'windows' } as any);
      vi.mocked(vscode.window.showInputBox)
        .mockResolvedValueOnce('localhost') // server name
        .mockResolvedValueOnce(undefined); // display name cancelled

      await provider.addConnection();

      expect(mockConnectionManager.saveConnection).not.toHaveBeenCalled();
    });

    it('does nothing when user cancels port input', async () => {
      vi.mocked(vscode.window.showQuickPick)
        .mockResolvedValueOnce({ label: 'Windows Authentication', value: 'windows' } as any);
      vi.mocked(vscode.window.showInputBox)
        .mockResolvedValueOnce('localhost') // server name
        .mockResolvedValueOnce('My Server') // display name
        .mockResolvedValueOnce(undefined); // port cancelled

      await provider.addConnection();

      expect(mockConnectionManager.saveConnection).not.toHaveBeenCalled();
    });

    it('does nothing when user cancels encrypt selection', async () => {
      vi.mocked(vscode.window.showQuickPick)
        .mockResolvedValueOnce({ label: 'Windows Authentication', value: 'windows' } as any)
        .mockResolvedValueOnce(undefined); // encrypt cancelled
      vi.mocked(vscode.window.showInputBox)
        .mockResolvedValueOnce('localhost')
        .mockResolvedValueOnce('My Server')
        .mockResolvedValueOnce('');

      await provider.addConnection();

      expect(mockConnectionManager.saveConnection).not.toHaveBeenCalled();
    });

    it('does nothing when user cancels trust cert selection', async () => {
      vi.mocked(vscode.window.showQuickPick)
        .mockResolvedValueOnce({ label: 'Windows Authentication', value: 'windows' } as any)
        .mockResolvedValueOnce({ label: 'Yes', value: true } as any) // encrypt
        .mockResolvedValueOnce(undefined); // trust cert cancelled
      vi.mocked(vscode.window.showInputBox)
        .mockResolvedValueOnce('localhost')
        .mockResolvedValueOnce('My Server')
        .mockResolvedValueOnce('');

      await provider.addConnection();

      expect(mockConnectionManager.saveConnection).not.toHaveBeenCalled();
    });

    it('does nothing when user cancels username input (SQL auth)', async () => {
      vi.mocked(vscode.window.showQuickPick)
        .mockResolvedValueOnce({ label: 'SQL Server Authentication', value: 'sql' } as any)
        .mockResolvedValueOnce({ label: 'Yes', value: true } as any)
        .mockResolvedValueOnce({ label: 'No', value: false } as any);
      vi.mocked(vscode.window.showInputBox)
        .mockResolvedValueOnce('localhost')
        .mockResolvedValueOnce('My Server')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce(undefined); // username cancelled

      await provider.addConnection();

      expect(mockConnectionManager.saveConnection).not.toHaveBeenCalled();
    });

    it('does nothing when user cancels password input (SQL auth)', async () => {
      vi.mocked(vscode.window.showQuickPick)
        .mockResolvedValueOnce({ label: 'SQL Server Authentication', value: 'sql' } as any)
        .mockResolvedValueOnce({ label: 'Yes', value: true } as any)
        .mockResolvedValueOnce({ label: 'No', value: false } as any);
      vi.mocked(vscode.window.showInputBox)
        .mockResolvedValueOnce('localhost')
        .mockResolvedValueOnce('My Server')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('sa') // username
        .mockResolvedValueOnce(undefined); // password cancelled

      await provider.addConnection();

      expect(mockConnectionManager.saveConnection).not.toHaveBeenCalled();
    });
  });

  describe('display name uniqueness check', () => {
    it('checks display name against existing connections', async () => {
      mockConnectionManager.getConnections.mockReturnValue([
        { name: 'Existing Server', host: 'host1', authType: 'windows' },
      ]);

      setupWindowsAuthFlow();

      await provider.addConnection();

      // The getConnections should have been called to get existing names
      expect(mockConnectionManager.getConnections).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('shows error message when saveConnection fails', async () => {
      setupWindowsAuthFlow();
      mockConnectionManager.saveConnection.mockRejectedValue(new Error('File write error'));

      await provider.addConnection();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'Failed to save connection: File write error'
      );
    });
  });

  describe('port parsing', () => {
    it('parses port string to number when provided', async () => {
      vi.mocked(vscode.window.showQuickPick)
        .mockResolvedValueOnce({ label: 'Windows Authentication', value: 'windows' } as any)
        .mockResolvedValueOnce({ label: 'No', value: false } as any)
        .mockResolvedValueOnce({ label: 'Yes', value: true } as any);
      vi.mocked(vscode.window.showInputBox)
        .mockResolvedValueOnce('myserver')
        .mockResolvedValueOnce('Test Server')
        .mockResolvedValueOnce('5432'); // custom port

      await provider.addConnection();

      const savedConfig = mockConnectionManager.saveConnection.mock.calls[0][0] as ServerConnectionConfig;
      expect(savedConfig.port).toBe(5432);
    });

    it('leaves port undefined when empty string is provided', async () => {
      setupWindowsAuthFlow();

      await provider.addConnection();

      const savedConfig = mockConnectionManager.saveConnection.mock.calls[0][0] as ServerConnectionConfig;
      expect(savedConfig.port).toBeUndefined();
    });
  });
});
