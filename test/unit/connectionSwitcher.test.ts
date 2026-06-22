import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode module
vi.mock('vscode', () => ({
  window: {
    showQuickPick: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
}));

import * as vscode from 'vscode';
import { switchServer, switchDatabase } from '../../src/connectionSwitcher';
import { ConnectionConfig } from '../../src/types';

// Helper to create a mock ConnectionManager
function createMockConnectionManager(overrides: Partial<Record<string, any>> = {}) {
  return {
    loadConnections: vi.fn().mockReturnValue([]),
    getActiveConfig: vi.fn().mockReturnValue(null),
    getActiveConnection: vi.fn().mockReturnValue(null),
    switchConnection: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue({}),
    disconnect: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

describe('switchServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should show warning when no connections are configured', async () => {
    const manager = createMockConnectionManager({
      loadConnections: vi.fn().mockReturnValue([]),
    });

    await switchServer(manager);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('No SQL Server connections configured')
    );
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('should show QuickPick with all configured connections', async () => {
    const connections: ConnectionConfig[] = [
      { name: 'Dev Server', host: 'localhost', port: 1433, database: 'DevDB' },
      { name: 'Prod Server', host: 'prod.example.com', port: 1434, database: 'ProdDB' },
    ];

    const manager = createMockConnectionManager({
      loadConnections: vi.fn().mockReturnValue(connections),
      getActiveConfig: vi.fn().mockReturnValue(null),
    });

    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    await switchServer(manager);

    expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Dev Server', description: 'localhost:1433' }),
        expect.objectContaining({ label: 'Prod Server', description: 'prod.example.com:1434' }),
      ]),
      expect.objectContaining({ placeHolder: 'Select a server connection' })
    );
  });

  it('should mark the currently connected server in the QuickPick', async () => {
    const connections: ConnectionConfig[] = [
      { name: 'Dev Server', host: 'localhost', port: 1433, database: 'DevDB' },
      { name: 'Prod Server', host: 'prod.example.com', port: 1434, database: 'ProdDB' },
    ];

    const manager = createMockConnectionManager({
      loadConnections: vi.fn().mockReturnValue(connections),
      getActiveConfig: vi.fn().mockReturnValue(connections[0]),
    });

    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    await switchServer(manager);

    const quickPickItems = vi.mocked(vscode.window.showQuickPick).mock.calls[0][0] as vscode.QuickPickItem[];
    expect(quickPickItems[0].detail).toContain('Currently connected');
    expect(quickPickItems[1].detail).toBeUndefined();
  });

  it('should do nothing when user cancels the QuickPick', async () => {
    const connections: ConnectionConfig[] = [
      { name: 'Dev Server', host: 'localhost', database: 'DevDB' },
    ];

    const manager = createMockConnectionManager({
      loadConnections: vi.fn().mockReturnValue(connections),
      getActiveConfig: vi.fn().mockReturnValue(null),
    });

    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    await switchServer(manager);

    expect(manager.switchConnection).not.toHaveBeenCalled();
  });

  it('should call switchConnection with the selected server name', async () => {
    const connections: ConnectionConfig[] = [
      { name: 'Dev Server', host: 'localhost', database: 'DevDB' },
      { name: 'Prod Server', host: 'prod.example.com', database: 'ProdDB' },
    ];

    const manager = createMockConnectionManager({
      loadConnections: vi.fn().mockReturnValue(connections),
      getActiveConfig: vi.fn().mockReturnValue(null),
    });

    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: 'Prod Server', description: 'prod.example.com:1433' });

    await switchServer(manager);

    expect(manager.switchConnection).toHaveBeenCalledWith('Prod Server');
  });

  it('should show error message on connection failure', async () => {
    const connections: ConnectionConfig[] = [
      { name: 'Bad Server', host: 'unreachable.host', database: 'DB' },
    ];

    const manager = createMockConnectionManager({
      loadConnections: vi.fn().mockReturnValue(connections),
      getActiveConfig: vi.fn().mockReturnValue(null),
      switchConnection: vi.fn().mockRejectedValue(new Error('Connection refused')),
    });

    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: 'Bad Server', description: 'unreachable.host:1433' });

    await switchServer(manager);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to connect to "Bad Server"')
    );
  });

  it('should default port to 1433 in description when not specified', async () => {
    const connections: ConnectionConfig[] = [
      { name: 'No Port', host: 'server.local' },
    ];

    const manager = createMockConnectionManager({
      loadConnections: vi.fn().mockReturnValue(connections),
      getActiveConfig: vi.fn().mockReturnValue(null),
    });

    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    await switchServer(manager);

    const quickPickItems = vi.mocked(vscode.window.showQuickPick).mock.calls[0][0] as vscode.QuickPickItem[];
    expect(quickPickItems[0].description).toBe('server.local:1433');
  });
});

describe('switchDatabase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should show info message when no active connection exists', async () => {
    const manager = createMockConnectionManager({
      getActiveConnection: vi.fn().mockReturnValue(null),
      getActiveConfig: vi.fn().mockReturnValue(null),
    });

    await switchDatabase(manager);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Connect to a server first');
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('should query databases and show QuickPick', async () => {
    const mockRecordset = [
      { name: 'master' },
      { name: 'TestDB' },
      { name: 'ProductionDB' },
    ];

    const mockPool = {
      request: vi.fn().mockReturnValue({
        query: vi.fn().mockResolvedValue({ recordset: mockRecordset }),
      }),
    };

    const activeConfig: ConnectionConfig = {
      name: 'Dev Server',
      host: 'localhost',
      database: 'master',
    };

    const manager = createMockConnectionManager({
      getActiveConnection: vi.fn().mockReturnValue(mockPool),
      getActiveConfig: vi.fn().mockReturnValue(activeConfig),
    });

    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    await switchDatabase(manager);

    expect(mockPool.request).toHaveBeenCalled();
    expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ label: 'master' }),
        expect.objectContaining({ label: 'TestDB' }),
        expect.objectContaining({ label: 'ProductionDB' }),
      ]),
      expect.objectContaining({ placeHolder: 'Select a database' })
    );
  });

  it('should mark the currently selected database in the QuickPick', async () => {
    const mockRecordset = [
      { name: 'master' },
      { name: 'TestDB' },
    ];

    const mockPool = {
      request: vi.fn().mockReturnValue({
        query: vi.fn().mockResolvedValue({ recordset: mockRecordset }),
      }),
    };

    const activeConfig: ConnectionConfig = {
      name: 'Dev Server',
      host: 'localhost',
      database: 'TestDB',
    };

    const manager = createMockConnectionManager({
      getActiveConnection: vi.fn().mockReturnValue(mockPool),
      getActiveConfig: vi.fn().mockReturnValue(activeConfig),
    });

    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    await switchDatabase(manager);

    const quickPickItems = vi.mocked(vscode.window.showQuickPick).mock.calls[0][0] as vscode.QuickPickItem[];
    expect(quickPickItems[0].detail).toBeUndefined(); // master
    expect(quickPickItems[1].detail).toContain('Currently selected'); // TestDB
  });

  it('should show error when database query fails', async () => {
    const mockPool = {
      request: vi.fn().mockReturnValue({
        query: vi.fn().mockRejectedValue(new Error('Permission denied')),
      }),
    };

    const activeConfig: ConnectionConfig = {
      name: 'Dev Server',
      host: 'localhost',
      database: 'master',
    };

    const manager = createMockConnectionManager({
      getActiveConnection: vi.fn().mockReturnValue(mockPool),
      getActiveConfig: vi.fn().mockReturnValue(activeConfig),
    });

    await switchDatabase(manager);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to retrieve database list')
    );
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('should do nothing when user cancels the QuickPick', async () => {
    const mockRecordset = [{ name: 'master' }, { name: 'TestDB' }];

    const mockPool = {
      request: vi.fn().mockReturnValue({
        query: vi.fn().mockResolvedValue({ recordset: mockRecordset }),
      }),
    };

    const activeConfig: ConnectionConfig = {
      name: 'Dev Server',
      host: 'localhost',
      database: 'master',
    };

    const manager = createMockConnectionManager({
      getActiveConnection: vi.fn().mockReturnValue(mockPool),
      getActiveConfig: vi.fn().mockReturnValue(activeConfig),
    });

    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    await switchDatabase(manager);

    expect(manager.disconnect).not.toHaveBeenCalled();
    expect(manager.connect).not.toHaveBeenCalled();
  });

  it('should disconnect and reconnect with the selected database', async () => {
    const mockRecordset = [{ name: 'master' }, { name: 'NewDB' }];

    const mockPool = {
      request: vi.fn().mockReturnValue({
        query: vi.fn().mockResolvedValue({ recordset: mockRecordset }),
      }),
    };

    const activeConfig: ConnectionConfig = {
      name: 'Dev Server',
      host: 'localhost',
      port: 1433,
      database: 'master',
    };

    const manager = createMockConnectionManager({
      getActiveConnection: vi.fn().mockReturnValue(mockPool),
      getActiveConfig: vi.fn().mockReturnValue(activeConfig),
    });

    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: 'NewDB' });

    await switchDatabase(manager);

    expect(manager.disconnect).toHaveBeenCalled();
    expect(manager.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Dev Server',
        host: 'localhost',
        port: 1433,
        database: 'NewDB',
      })
    );
  });

  it('should show error and restore previous connection on failure', async () => {
    const mockRecordset = [{ name: 'master' }, { name: 'BadDB' }];

    const mockPool = {
      request: vi.fn().mockReturnValue({
        query: vi.fn().mockResolvedValue({ recordset: mockRecordset }),
      }),
    };

    const activeConfig: ConnectionConfig = {
      name: 'Dev Server',
      host: 'localhost',
      database: 'master',
    };

    const manager = createMockConnectionManager({
      getActiveConnection: vi.fn().mockReturnValue(mockPool),
      getActiveConfig: vi.fn().mockReturnValue(activeConfig),
      disconnect: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn()
        .mockRejectedValueOnce(new Error('Database not found'))
        .mockResolvedValueOnce({}), // restoration succeeds
    });

    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: 'BadDB' });

    await switchDatabase(manager);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to switch to database "BadDB"')
    );
    // Should attempt to restore previous connection
    expect(manager.connect).toHaveBeenCalledTimes(2);
    expect(manager.connect).toHaveBeenLastCalledWith(activeConfig);
  });

  it('should default current database to master when not specified', async () => {
    const mockRecordset = [{ name: 'master' }, { name: 'OtherDB' }];

    const mockPool = {
      request: vi.fn().mockReturnValue({
        query: vi.fn().mockResolvedValue({ recordset: mockRecordset }),
      }),
    };

    const activeConfig: ConnectionConfig = {
      name: 'Dev Server',
      host: 'localhost',
      // database not specified — should default to 'master'
    };

    const manager = createMockConnectionManager({
      getActiveConnection: vi.fn().mockReturnValue(mockPool),
      getActiveConfig: vi.fn().mockReturnValue(activeConfig),
    });

    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    await switchDatabase(manager);

    const quickPickItems = vi.mocked(vscode.window.showQuickPick).mock.calls[0][0] as vscode.QuickPickItem[];
    // 'master' should be marked as currently selected since database defaults to 'master'
    expect(quickPickItems[0].detail).toContain('Currently selected');
  });
});
