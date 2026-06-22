import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConnectionConfig } from '../../src/types';

// Track event listeners
let connectionChangedListeners: Array<(config: ConnectionConfig | null) => void> = [];
let configChangeListeners: Array<(e: any) => void> = [];
let codeLensChangeListeners: Array<() => void> = [];

// Configuration mock state
let mockConfigEnabled = true;

vi.mock('vscode', () => {
  // Mock EventEmitter - defined inside factory to avoid hoisting issues
  class MockEventEmitter {
    private listeners: Array<(...args: any[]) => void> = [];

    get event() {
      return (listener: (...args: any[]) => void) => {
        this.listeners.push(listener);
        codeLensChangeListeners.push(listener as () => void);
        return { dispose: vi.fn() };
      };
    }

    fire(...args: any[]) {
      this.listeners.forEach(l => l(...args));
    }

    dispose() {
      this.listeners = [];
    }
  }

  // Mock CodeLens class
  class MockCodeLens {
    constructor(public range: any, public command?: any) {}
  }

  // Mock Range class
  class MockRange {
    constructor(
      public startLine: number,
      public startChar: number,
      public endLine: number,
      public endChar: number
    ) {}
  }

  return {
    EventEmitter: MockEventEmitter,
    CodeLens: MockCodeLens,
    Range: MockRange,
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: vi.fn((_key: string, _defaultValue: boolean) => {
          return mockConfigEnabled;
        }),
      })),
      onDidChangeConfiguration: vi.fn((listener: (e: any) => void) => {
        configChangeListeners.push(listener);
        return { dispose: vi.fn() };
      }),
    },
  };
});

import { SqlCodeLensProvider } from '../../src/sqlCodeLensProvider';

describe('SqlCodeLensProvider', () => {
  let provider: SqlCodeLensProvider;
  let mockConnectionManager: any;

  beforeEach(() => {
    // Reset state
    connectionChangedListeners = [];
    configChangeListeners = [];
    codeLensChangeListeners = [];
    mockConfigEnabled = true;

    vi.clearAllMocks();

    // Create mock ConnectionManager
    mockConnectionManager = {
      getActiveConfig: vi.fn(() => null),
      onConnectionChanged: vi.fn((listener: (config: ConnectionConfig | null) => void) => {
        connectionChangedListeners.push(listener);
        return { dispose: vi.fn() };
      }),
    };

    provider = new SqlCodeLensProvider(mockConnectionManager);
  });

  describe('returns two CodeLens items when active connection exists', () => {
    it('should return server and database CodeLens when connected', () => {
      const config: ConnectionConfig = {
        name: 'Dev Server',
        host: 'localhost',
        port: 1433,
        database: 'TestDB',
      };
      mockConnectionManager.getActiveConfig.mockReturnValue(config);

      const document = { languageId: 'sql' } as any;
      const lenses = provider.provideCodeLenses(document);

      expect(lenses).toHaveLength(2);
    });

    it('should show server name in first CodeLens', () => {
      const config: ConnectionConfig = {
        name: 'Dev Server',
        host: 'localhost',
        database: 'TestDB',
      };
      mockConnectionManager.getActiveConfig.mockReturnValue(config);

      const document = { languageId: 'sql' } as any;
      const lenses = provider.provideCodeLenses(document);

      expect(lenses[0].command.title).toBe('$(server) Dev Server');
      expect(lenses[0].command.command).toBe('sqlServer.switchServer');
    });

    it('should show database name in second CodeLens', () => {
      const config: ConnectionConfig = {
        name: 'Dev Server',
        host: 'localhost',
        database: 'TestDB',
      };
      mockConnectionManager.getActiveConfig.mockReturnValue(config);

      const document = { languageId: 'sql' } as any;
      const lenses = provider.provideCodeLenses(document);

      expect(lenses[1].command.title).toBe('$(database) TestDB');
      expect(lenses[1].command.command).toBe('sqlServer.switchDatabase');
    });

    it('should default database to master when not specified', () => {
      const config: ConnectionConfig = {
        name: 'Server',
        host: 'localhost',
      };
      mockConnectionManager.getActiveConfig.mockReturnValue(config);

      const document = { languageId: 'sql' } as any;
      const lenses = provider.provideCodeLenses(document);

      expect(lenses[1].command.title).toBe('$(database) master');
    });
  });

  describe('returns single "Connect" CodeLens when no active connection', () => {
    it('should return one CodeLens with Connect title', () => {
      mockConnectionManager.getActiveConfig.mockReturnValue(null);

      const document = { languageId: 'sql' } as any;
      const lenses = provider.provideCodeLenses(document);

      expect(lenses).toHaveLength(1);
      expect(lenses[0].command.title).toBe('$(plug) Connect');
    });

    it('should invoke switchConnection command', () => {
      mockConnectionManager.getActiveConfig.mockReturnValue(null);

      const document = { languageId: 'sql' } as any;
      const lenses = provider.provideCodeLenses(document);

      expect(lenses[0].command.command).toBe('sqlServer.switchConnection');
    });
  });

  describe('returns empty array when disabled via configuration', () => {
    it('should return empty array when showConnectionCodeLens is false', () => {
      // Recreate provider with disabled config
      mockConfigEnabled = false;
      connectionChangedListeners = [];
      configChangeListeners = [];
      codeLensChangeListeners = [];

      provider = new SqlCodeLensProvider(mockConnectionManager);

      const document = { languageId: 'sql' } as any;
      const lenses = provider.provideCodeLenses(document);

      expect(lenses).toEqual([]);
    });

    it('should not call getActiveConfig when disabled', () => {
      mockConfigEnabled = false;
      connectionChangedListeners = [];
      configChangeListeners = [];
      codeLensChangeListeners = [];

      provider = new SqlCodeLensProvider(mockConnectionManager);

      const document = { languageId: 'sql' } as any;
      provider.provideCodeLenses(document);

      expect(mockConnectionManager.getActiveConfig).not.toHaveBeenCalled();
    });
  });

  describe('returns empty array for non-SQL documents', () => {
    it('should return empty array for JavaScript files', () => {
      const document = { languageId: 'javascript' } as any;
      const lenses = provider.provideCodeLenses(document);

      expect(lenses).toEqual([]);
    });

    it('should return empty array for TypeScript files', () => {
      const document = { languageId: 'typescript' } as any;
      const lenses = provider.provideCodeLenses(document);

      expect(lenses).toEqual([]);
    });

    it('should return empty array for JSON files', () => {
      const document = { languageId: 'json' } as any;
      const lenses = provider.provideCodeLenses(document);

      expect(lenses).toEqual([]);
    });

    it('should return empty array for plaintext files', () => {
      const document = { languageId: 'plaintext' } as any;
      const lenses = provider.provideCodeLenses(document);

      expect(lenses).toEqual([]);
    });
  });

  describe('fires onDidChangeCodeLenses when connection changes', () => {
    it('should fire event when connection changes', () => {
      const listener = vi.fn();
      provider.onDidChangeCodeLenses(listener);

      const newConfig: ConnectionConfig = {
        name: 'New Server',
        host: 'newhost',
        database: 'NewDB',
      };
      connectionChangedListeners.forEach(l => l(newConfig));

      expect(listener).toHaveBeenCalled();
    });

    it('should fire event when connection is lost', () => {
      const listener = vi.fn();
      provider.onDidChangeCodeLenses(listener);

      connectionChangedListeners.forEach(l => l(null));

      expect(listener).toHaveBeenCalled();
    });
  });

  describe('responds to configuration change at runtime', () => {
    it('should disable CodeLens when config changes to false', () => {
      // Start enabled
      const document = { languageId: 'sql' } as any;
      mockConnectionManager.getActiveConfig.mockReturnValue(null);

      let lenses = provider.provideCodeLenses(document);
      expect(lenses).toHaveLength(1); // Connect lens

      // Simulate config change to disabled
      mockConfigEnabled = false;
      configChangeListeners.forEach(l =>
        l({ affectsConfiguration: (key: string) => key === 'sqlServer.showConnectionCodeLens' })
      );

      lenses = provider.provideCodeLenses(document);
      expect(lenses).toEqual([]);
    });

    it('should re-enable CodeLens when config changes to true', () => {
      // Start disabled
      mockConfigEnabled = false;
      connectionChangedListeners = [];
      configChangeListeners = [];
      codeLensChangeListeners = [];

      provider = new SqlCodeLensProvider(mockConnectionManager);

      const document = { languageId: 'sql' } as any;
      let lenses = provider.provideCodeLenses(document);
      expect(lenses).toEqual([]);

      // Simulate config change to enabled
      mockConfigEnabled = true;
      configChangeListeners.forEach(l =>
        l({ affectsConfiguration: (key: string) => key === 'sqlServer.showConnectionCodeLens' })
      );

      mockConnectionManager.getActiveConfig.mockReturnValue(null);
      lenses = provider.provideCodeLenses(document);
      expect(lenses).toHaveLength(1);
    });

    it('should fire onDidChangeCodeLenses when config changes', () => {
      const listener = vi.fn();
      provider.onDidChangeCodeLenses(listener);

      mockConfigEnabled = false;
      configChangeListeners.forEach(l =>
        l({ affectsConfiguration: (key: string) => key === 'sqlServer.showConnectionCodeLens' })
      );

      expect(listener).toHaveBeenCalled();
    });

    it('should not react to unrelated configuration changes', () => {
      const listener = vi.fn();
      provider.onDidChangeCodeLenses(listener);

      configChangeListeners.forEach(l =>
        l({ affectsConfiguration: (key: string) => key === 'editor.fontSize' })
      );

      expect(listener).not.toHaveBeenCalled();
    });
  });
});
