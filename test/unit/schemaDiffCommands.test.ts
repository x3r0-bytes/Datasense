import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode module
vi.mock('vscode', () => ({
  window: {
    showQuickPick: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    withProgress: vi.fn(),
  },
  commands: {
    registerCommand: vi.fn((_id: string, handler: (...args: any[]) => any) => {
      return { dispose: vi.fn(), handler };
    }),
  },
  ProgressLocation: {
    Notification: 15,
  },
}));

vi.mock('mssql', () => ({
  ConnectionPool: vi.fn(),
}));

vi.mock('mssql/msnodesqlv8', () => ({
  ConnectionPool: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import * as vscode from 'vscode';
import { registerSchemaDiffCommands, getLastDiffResult } from '../../src/schemaDiff/schemaDiffCommands';
import { ObjectExplorerConnectionManager } from '../../src/objectExplorer/objectExplorerConnectionManager';

describe('schemaDiffCommands', () => {
  let connectionManager: ObjectExplorerConnectionManager;
  let registeredHandlers: Map<string, (...args: any[]) => any>;

  beforeEach(() => {
    vi.clearAllMocks();
    connectionManager = new ObjectExplorerConnectionManager('/workspace');
    registeredHandlers = new Map();

    // Capture registered command handlers
    vi.mocked(vscode.commands.registerCommand).mockImplementation(
      (id: string, handler: (...args: any[]) => any) => {
        registeredHandlers.set(id, handler);
        return { dispose: vi.fn() };
      }
    );
  });

  describe('registerSchemaDiffCommands', () => {
    it('registers both schemaDiff and schemaDiffFromNode commands', () => {
      const disposables = registerSchemaDiffCommands(connectionManager);

      expect(disposables).toHaveLength(2);
      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        'sqlServer.schemaDiff',
        expect.any(Function)
      );
      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        'sqlServer.schemaDiffFromNode',
        expect.any(Function)
      );
    });
  });

  describe('sqlServer.schemaDiff — command palette', () => {
    beforeEach(() => {
      registerSchemaDiffCommands(connectionManager);
    });

    it('shows a warning if no connections are registered', async () => {
      // connectionManager has no loaded connections (empty)
      vi.spyOn(connectionManager, 'getConnections').mockReturnValue([]);

      const handler = registeredHandlers.get('sqlServer.schemaDiff')!;
      await handler();

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('No connections registered')
      );
    });

    it('cancels silently when user dismisses connection pick (source)', async () => {
      vi.spyOn(connectionManager, 'getConnections').mockReturnValue([
        { name: 'Server1', host: 'localhost', authType: 'windows' },
      ]);

      vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);

      const handler = registeredHandlers.get('sqlServer.schemaDiff')!;
      await handler();

      // No error messages, no progress — just silent cancel
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
      expect(vscode.window.withProgress).not.toHaveBeenCalled();
    });

    it('cancels silently when user dismisses database pick (source)', async () => {
      vi.spyOn(connectionManager, 'getConnections').mockReturnValue([
        { name: 'Server1', host: 'localhost', authType: 'windows' },
      ]);

      // Select connection, then mock getPool, then dismiss database pick
      vi.mocked(vscode.window.showQuickPick)
        .mockResolvedValueOnce({ label: 'Server1', description: 'localhost' } as any) // connection
        .mockResolvedValueOnce(undefined); // database dismissed

      const mockPool = {
        request: () => ({
          query: vi.fn().mockResolvedValue({
            recordset: [{ name: 'MyDB' }, { name: 'TestDB' }],
          }),
        }),
        connected: true,
      };
      vi.spyOn(connectionManager, 'getPool').mockResolvedValue(mockPool as any);

      const handler = registeredHandlers.get('sqlServer.schemaDiff')!;
      await handler();

      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
      expect(vscode.window.withProgress).not.toHaveBeenCalled();
    });

    it('shows error when connection to server fails during database query', async () => {
      vi.spyOn(connectionManager, 'getConnections').mockReturnValue([
        { name: 'Server1', host: 'badhost', authType: 'windows' },
      ]);

      vi.mocked(vscode.window.showQuickPick)
        .mockResolvedValueOnce({ label: 'Server1', description: 'badhost' } as any);

      vi.spyOn(connectionManager, 'getPool').mockRejectedValue(
        new Error('Failed to connect to badhost: Connection refused')
      );

      const handler = registeredHandlers.get('sqlServer.schemaDiff')!;
      await handler();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to connect to Server1')
      );
    });
  });

  describe('sqlServer.schemaDiffFromNode — context menu', () => {
    beforeEach(() => {
      registerSchemaDiffCommands(connectionManager);
    });

    it('shows a warning when node is not a table node', async () => {
      const handler = registeredHandlers.get('sqlServer.schemaDiffFromNode')!;
      await handler({ kind: 'database', connectionName: 'Server1', databaseName: 'MyDB' });

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Right-click a table')
      );
    });

    it('shows a warning when no node is provided', async () => {
      const handler = registeredHandlers.get('sqlServer.schemaDiffFromNode')!;
      await handler(undefined);

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Right-click a table')
      );
    });

    it('pre-selects source from the table node schema and prompts only for target', async () => {
      vi.spyOn(connectionManager, 'getConnections').mockReturnValue([
        { name: 'Server1', host: 'localhost', authType: 'windows' },
        { name: 'Server2', host: 'remotehost', authType: 'sql', user: 'sa' },
      ]);

      // Mock pool for target database query and schema query
      const mockPool = {
        request: () => ({
          query: vi.fn()
            .mockResolvedValueOnce({ recordset: [{ name: 'TargetDB' }] }) // databases
            .mockResolvedValueOnce({ recordset: [{ schema_name: 'dbo' }] }), // schemas
        }),
        connected: true,
      };
      vi.spyOn(connectionManager, 'getPool').mockResolvedValue(mockPool as any);
      vi.spyOn(connectionManager, 'getPoolForDatabase').mockResolvedValue(mockPool as any);

      // User selects target connection + database + schema (3 picks)
      vi.mocked(vscode.window.showQuickPick)
        .mockResolvedValueOnce({ label: 'Server2', description: 'remotehost' } as any) // target connection
        .mockResolvedValueOnce({ label: 'TargetDB' } as any) // target database
        .mockResolvedValueOnce({ label: 'dbo' } as any); // target schema

      // Mock withProgress to execute the callback
      vi.mocked(vscode.window.withProgress).mockImplementation(async (_opts, callback) => {
        return callback({ report: vi.fn() } as any, {} as any);
      });

      const handler = registeredHandlers.get('sqlServer.schemaDiffFromNode')!;
      const tableNode = {
        kind: 'table',
        connectionName: 'Server1',
        database: 'SourceDB',
        schema: 'dbo',
        tableName: 'Orders',
        label: 'dbo.Orders',
      };
      await handler(tableNode);

      // Should only show quick pick for target (3 picks: connection + database + schema)
      expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(3);
    });
  });

  describe('same source and target validation', () => {
    beforeEach(() => {
      registerSchemaDiffCommands(connectionManager);
    });

    it('warns when same connection, database, and schema are selected for source and target', async () => {
      vi.spyOn(connectionManager, 'getConnections').mockReturnValue([
        { name: 'Server1', host: 'localhost', authType: 'windows' },
      ]);

      const mockPool = {
        request: () => ({
          query: vi.fn()
            .mockResolvedValue({ recordset: [{ name: 'MyDB' }] }),
        }),
        connected: true,
      };
      vi.spyOn(connectionManager, 'getPool').mockResolvedValue(mockPool as any);

      // Mock getPoolForDatabase to return a pool that returns schemas
      const mockDbPool = {
        request: () => ({
          query: vi.fn()
            .mockResolvedValue({ recordset: [{ schema_name: 'dbo' }] }),
        }),
        connected: true,
      };
      vi.spyOn(connectionManager, 'getPoolForDatabase').mockResolvedValue(mockDbPool as any);

      // Source: Server1/MyDB/dbo, Target: Server1/MyDB/dbo (same!)
      vi.mocked(vscode.window.showQuickPick)
        .mockResolvedValueOnce({ label: 'Server1', description: 'localhost' } as any) // source connection
        .mockResolvedValueOnce({ label: 'MyDB' } as any) // source database
        .mockResolvedValueOnce({ label: 'dbo' } as any) // source schema
        .mockResolvedValueOnce({ label: 'Server1', description: 'localhost' } as any) // target connection
        .mockResolvedValueOnce({ label: 'MyDB' } as any) // target database
        .mockResolvedValueOnce({ label: 'dbo' } as any); // target schema (same!)

      const handler = registeredHandlers.get('sqlServer.schemaDiff')!;
      await handler();

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'Source and target are the same schema. Choose a different target.'
      );
      expect(vscode.window.withProgress).not.toHaveBeenCalled();
    });
  });

  describe('getLastDiffResult', () => {
    it('returns undefined before any diff is run', () => {
      expect(getLastDiffResult()).toBeUndefined();
    });
  });
});
