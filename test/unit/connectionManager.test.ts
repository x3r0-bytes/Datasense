import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Mock vscode module
vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [
      { uri: { fsPath: '/test-workspace' } }
    ]
  },
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  EventEmitter: class {
    private listeners: Function[] = [];
    event = (listener: Function) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(data: any) {
      this.listeners.forEach(l => l(data));
    }
    dispose() {}
  }
}));

// Mock mssql module
vi.mock('mssql', () => {
  class MockConnectionPool {
    config: any;
    constructor(config: any) {
      this.config = config;
    }
    async connect() { return this; }
    async close() {}
  }
  return {
    ConnectionPool: MockConnectionPool
  };
});

// Mock mssql/msnodesqlv8 module (used for Windows Auth)
vi.mock('mssql/msnodesqlv8', () => {
  class MockConnectionPool {
    config: any;
    constructor(config: any) {
      this.config = config;
    }
    async connect() { return this; }
    async close() {}
  }
  return {
    ConnectionPool: MockConnectionPool
  };
});

import * as fs from 'fs';
import { ConnectionManager } from '../../src/connectionManager';
import * as vscode from 'vscode';

const mockedFs = vi.mocked(fs);

describe('ConnectionManager', () => {
  let manager: ConnectionManager;

  beforeEach(() => {
    manager = new ConnectionManager();
    vi.clearAllMocks();
  });

  describe('loadConnections', () => {
    it('should return empty array and warn when no workspace is open', () => {
      const workspaceMock = vi.mocked(vscode.workspace);
      Object.defineProperty(workspaceMock, 'workspaceFolders', { value: undefined, configurable: true });

      const result = manager.loadConnections();

      expect(result).toEqual([]);
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('No workspace folder open')
      );

      // Restore
      Object.defineProperty(workspaceMock, 'workspaceFolders', {
        value: [{ uri: { fsPath: '/test-workspace' } }],
        configurable: true
      });
    });

    it('should return empty array and warn when config file not found', () => {
      mockedFs.existsSync.mockReturnValue(false);

      const result = manager.loadConnections();

      expect(result).toEqual([]);
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('not found at workspace root')
      );
    });

    it('should return empty array and show error for invalid JSON', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('not valid json {{{');

      const result = manager.loadConnections();

      expect(result).toEqual([]);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Invalid JSON')
      );
    });

    it('should parse valid connections and default port to 1433', () => {
      const configData = JSON.stringify({
        connections: [
          {
            name: 'Local Dev',
            host: 'localhost',
            database: 'TestDB',
            user: 'sa',
            password: 'pass123'
          }
        ]
      });

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(configData);

      const result = manager.loadConnections();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: 'Local Dev',
        host: 'localhost',
        port: 1433,
        database: 'TestDB',
        user: 'sa',
        password: 'pass123',
        encrypt: undefined,
        trustServerCertificate: undefined,
      });
    });

    it('should preserve specified port value', () => {
      const configData = JSON.stringify({
        connections: [
          {
            name: 'Custom Port',
            host: 'server.local',
            port: 1444,
            database: 'MyDB'
          }
        ]
      });

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(configData);

      const result = manager.loadConnections();

      expect(result).toHaveLength(1);
      expect(result[0].port).toBe(1444);
    });

    it('should exclude entries missing required fields and show warning', () => {
      const configData = JSON.stringify({
        connections: [
          { name: 'Valid', host: 'localhost', database: 'DB1' },
          { name: 'Missing Host', database: 'DB2' },
          { host: 'localhost', database: 'DB3' },
          { name: 'No DB', host: 'localhost' },
        ]
      });

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(configData);

      const result = manager.loadConnections();

      // 'Missing Host' and unnamed entry are excluded; 'Valid' and 'No DB' are valid (database defaults to master)
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Valid');
      expect(result[1].name).toBe('No DB');
      expect(result[1].database).toBe('master');
      expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(2);
    });

    it('should handle Windows Auth connections (no user/password)', () => {
      const configData = JSON.stringify({
        connections: [
          {
            name: 'Windows Auth',
            host: 'prod-server',
            database: 'ProdDB'
          }
        ]
      });

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(configData);

      const result = manager.loadConnections();

      expect(result).toHaveLength(1);
      expect(result[0].user).toBeUndefined();
      expect(result[0].password).toBeUndefined();
    });

    it('should preserve optional fields when provided', () => {
      const configData = JSON.stringify({
        connections: [
          {
            name: 'Full Config',
            host: 'server.local',
            port: 1433,
            database: 'TestDB',
            user: 'admin',
            password: 'secret',
            encrypt: true,
            trustServerCertificate: true
          }
        ]
      });

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(configData);

      const result = manager.loadConnections();

      expect(result).toHaveLength(1);
      expect(result[0].encrypt).toBe(true);
      expect(result[0].trustServerCertificate).toBe(true);
    });

    it('should show error when connections field is not an array', () => {
      const configData = JSON.stringify({ connections: 'not-an-array' });

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(configData);

      const result = manager.loadConnections();

      expect(result).toEqual([]);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('must contain a "connections" array')
      );
    });
  });

  describe('connect', () => {
    it('should create a connection pool and set active connection', async () => {
      const config = {
        name: 'Test',
        host: 'localhost',
        port: 1433,
        database: 'TestDB',
        user: 'sa',
        password: 'pass'
      };

      const pool = await manager.connect(config);

      expect(pool).toBeDefined();
      expect(manager.getActiveConnection()).toBe(pool);
      expect(manager.getActiveConfig()).toEqual(config);
    });

    it('should support Windows Auth when user is omitted', async () => {
      const config = {
        name: 'WinAuth',
        host: 'server.local',
        database: 'ProdDB'
      };

      // Mock the msnodesqlv8 require by mocking the module at runtime
      const mssqlNative = require('mssql/msnodesqlv8');
      const originalPool = mssqlNative.ConnectionPool;
      let capturedConfig: any;
      mssqlNative.ConnectionPool = class {
        config: any;
        constructor(config: any) {
          this.config = config;
          capturedConfig = config;
        }
        async connect() { return this; }
        async close() {}
      };

      try {
        const pool = await manager.connect(config);
        expect(pool).toBeDefined();
        expect(capturedConfig.connectionString).toContain('Trusted_Connection=Yes');
        expect(capturedConfig.connectionString).toContain('Server=server.local');
      } finally {
        mssqlNative.ConnectionPool = originalPool;
      }
    });

    it('should set SQL Server auth when user is provided', async () => {
      const config = {
        name: 'SqlAuth',
        host: 'server.local',
        database: 'TestDB',
        user: 'admin',
        password: 'secret'
      };

      const pool = await manager.connect(config);

      expect(pool).toBeDefined();
      expect((pool as any).config.user).toBe('admin');
      expect((pool as any).config.password).toBe('secret');
      // SQL auth should NOT have a connectionString (uses standard config)
      expect((pool as any).config.connectionString).toBeUndefined();
    });
  });

  describe('disconnect', () => {
    it('should close the active pool and clear state', async () => {
      const config = {
        name: 'Test',
        host: 'localhost',
        database: 'TestDB',
        user: 'sa',
        password: 'pass'
      };

      await manager.connect(config);
      expect(manager.getActiveConnection()).not.toBeNull();

      await manager.disconnect();

      expect(manager.getActiveConnection()).toBeNull();
      expect(manager.getActiveConfig()).toBeNull();
    });

    it('should be safe to call when not connected', async () => {
      await expect(manager.disconnect()).resolves.not.toThrow();
    });
  });

  describe('switchConnection', () => {
    it('should switch to a named connection and emit event', async () => {
      const configData = JSON.stringify({
        connections: [
          { name: 'Conn1', host: 'host1', database: 'DB1', user: 'sa', password: 'p1' },
          { name: 'Conn2', host: 'host2', database: 'DB2', user: 'sa', password: 'p2' },
        ]
      });

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(configData);

      manager.loadConnections();

      let eventFired = false;
      let eventConfig: any = null;
      manager.onConnectionChanged((config) => {
        eventFired = true;
        eventConfig = config;
      });

      await manager.switchConnection('Conn2');

      expect(eventFired).toBe(true);
      expect(eventConfig?.name).toBe('Conn2');
      expect(manager.getActiveConfig()?.name).toBe('Conn2');
    });

    it('should show error when connection name not found', async () => {
      const configData = JSON.stringify({
        connections: [
          { name: 'Conn1', host: 'host1', database: 'DB1' }
        ]
      });

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(configData);

      manager.loadConnections();

      await manager.switchConnection('NonExistent');

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('not found')
      );
    });

    it('should retain previous connection on failure', async () => {
      const configData = JSON.stringify({
        connections: [
          { name: 'Conn1', host: 'host1', database: 'DB1', user: 'sa', password: 'p1' },
          { name: 'Conn2', host: 'host2', database: 'DB2', user: 'sa', password: 'p2' },
        ]
      });

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(configData);

      manager.loadConnections();

      // Connect to Conn1 first
      await manager.switchConnection('Conn1');
      expect(manager.getActiveConfig()?.name).toBe('Conn1');

      // Now mock the ConnectionPool constructor to throw for the next connection
      const mssql = await import('mssql');
      const OriginalPool = mssql.ConnectionPool;
      vi.mocked(mssql).ConnectionPool = vi.fn().mockImplementation(() => {
        return {
          connect: vi.fn().mockRejectedValue(new Error('Connection refused')),
          close: vi.fn().mockResolvedValue(undefined),
        };
      }) as any;

      await expect(manager.switchConnection('Conn2')).rejects.toThrow('Connection refused');

      // Should retain previous connection
      expect(manager.getActiveConfig()?.name).toBe('Conn1');

      // Restore
      vi.mocked(mssql).ConnectionPool = OriginalPool;
    });
  });
});
