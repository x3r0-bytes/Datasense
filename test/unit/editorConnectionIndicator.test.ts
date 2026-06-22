import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConnectionConfig } from '../../src/types';

// Mock StatusBarItem instances
function createMockStatusBarItem() {
  return {
    text: '',
    tooltip: '',
    command: '',
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
}

const mockServerItem = createMockStatusBarItem();
const mockDatabaseItem = createMockStatusBarItem();
let createStatusBarItemCallCount = 0;

// Track onDidChangeActiveTextEditor listeners
let editorChangeListeners: Array<(editor: any) => void> = [];

const mockWindow = {
  createStatusBarItem: vi.fn(() => {
    createStatusBarItemCallCount++;
    if (createStatusBarItemCallCount % 2 === 1) {
      return mockServerItem;
    }
    return mockDatabaseItem;
  }),
  onDidChangeActiveTextEditor: vi.fn((listener: (editor: any) => void) => {
    editorChangeListeners.push(listener);
    return { dispose: vi.fn() };
  }),
  activeTextEditor: undefined as any,
};

vi.mock('vscode', () => ({
  window: {
    createStatusBarItem: vi.fn(() => {
      createStatusBarItemCallCount++;
      if (createStatusBarItemCallCount % 2 === 1) {
        return mockServerItem;
      }
      return mockDatabaseItem;
    }),
    onDidChangeActiveTextEditor: vi.fn((listener: (editor: any) => void) => {
      editorChangeListeners.push(listener);
      return { dispose: vi.fn() };
    }),
    activeTextEditor: undefined,
  },
  StatusBarAlignment: {
    Left: 1,
    Right: 2,
  },
}));

import * as vscode from 'vscode';
import { EditorConnectionIndicator } from '../../src/editorConnectionIndicator';

describe('EditorConnectionIndicator', () => {
  let indicator: EditorConnectionIndicator;
  let connectionChangedListeners: Array<(config: ConnectionConfig | null) => void>;
  let mockOnConnectionChanged: any;

  beforeEach(() => {
    // Reset mocks
    createStatusBarItemCallCount = 0;
    editorChangeListeners = [];
    connectionChangedListeners = [];

    Object.assign(mockServerItem, {
      text: '',
      tooltip: '',
      command: '',
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    });
    Object.assign(mockDatabaseItem, {
      text: '',
      tooltip: '',
      command: '',
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    });

    vi.clearAllMocks();

    // Re-wire the mock implementations after clearAllMocks
    vi.mocked(vscode.window.createStatusBarItem).mockImplementation((() => {
      createStatusBarItemCallCount++;
      if (createStatusBarItemCallCount % 2 === 1) {
        return mockServerItem;
      }
      return mockDatabaseItem;
    }) as any);

    vi.mocked(vscode.window.onDidChangeActiveTextEditor).mockImplementation(((listener: (editor: any) => void) => {
      editorChangeListeners.push(listener);
      return { dispose: vi.fn() };
    }) as any);

    // Set activeTextEditor to undefined (no editor open)
    (vscode.window as any).activeTextEditor = undefined;

    // Create a mock event that captures listeners
    mockOnConnectionChanged = (listener: (config: ConnectionConfig | null) => void) => {
      connectionChangedListeners.push(listener);
      return { dispose: vi.fn() };
    };

    indicator = new EditorConnectionIndicator(mockOnConnectionChanged);
  });

  describe('constructor', () => {
    it('should create two StatusBarItems with Left alignment', () => {
      expect(vscode.window.createStatusBarItem).toHaveBeenCalledTimes(2);
      // Both should be Left alignment (1)
      expect(vscode.window.createStatusBarItem).toHaveBeenCalledWith(1, -100);
      expect(vscode.window.createStatusBarItem).toHaveBeenCalledWith(1, -101);
    });

    it('should assign switchServer command to server item', () => {
      expect(mockServerItem.command).toBe('sqlServer.switchServer');
    });

    it('should assign switchDatabase command to database item', () => {
      expect(mockDatabaseItem.command).toBe('sqlServer.switchDatabase');
    });

    it('should register onDidChangeActiveTextEditor listener', () => {
      expect(vscode.window.onDidChangeActiveTextEditor).toHaveBeenCalled();
      expect(editorChangeListeners.length).toBeGreaterThan(0);
    });

    it('should subscribe to onConnectionChanged event', () => {
      expect(connectionChangedListeners.length).toBe(1);
    });
  });

  describe('update(null) - placeholder state', () => {
    it('should set server item text to placeholder when config is null', () => {
      indicator.update(null);
      expect(mockServerItem.text).toBe('$(server) No Connection');
    });

    it('should set server item tooltip to no connection message', () => {
      indicator.update(null);
      expect(mockServerItem.tooltip).toBe('No active connection. Click to connect.');
    });

    it('should clear database item text when config is null', () => {
      indicator.update(null);
      expect(mockDatabaseItem.text).toBe('');
    });

    it('should clear database item tooltip when config is null', () => {
      indicator.update(null);
      expect(mockDatabaseItem.tooltip).toBe('');
    });
  });

  describe('update(config) - connected state', () => {
    const config: ConnectionConfig = {
      name: 'Dev Server',
      host: 'localhost',
      port: 1433,
      database: 'TestDB',
    };

    it('should set server item text with server name', () => {
      indicator.update(config);
      expect(mockServerItem.text).toBe('$(server) Dev Server');
    });

    it('should set server item tooltip with connection details', () => {
      indicator.update(config);
      expect(mockServerItem.tooltip).toBe(
        'Connected to Dev Server (localhost:1433). Click to switch server.'
      );
    });

    it('should set database item text with database name', () => {
      indicator.update(config);
      expect(mockDatabaseItem.text).toBe('$(database) TestDB');
    });

    it('should set database item tooltip with database name', () => {
      indicator.update(config);
      expect(mockDatabaseItem.tooltip).toBe('Database: TestDB. Click to switch database.');
    });

    it('should default database to master when not specified', () => {
      const configNoDb: ConnectionConfig = {
        name: 'Server',
        host: 'localhost',
      };
      indicator.update(configNoDb);
      expect(mockDatabaseItem.text).toBe('$(database) master');
      expect(mockDatabaseItem.tooltip).toBe('Database: master. Click to switch database.');
    });

    it('should default port to 1433 in tooltip when not specified', () => {
      const configNoPort: ConnectionConfig = {
        name: 'Server',
        host: 'myhost',
        database: 'DB1',
      };
      indicator.update(configNoPort);
      expect(mockServerItem.tooltip).toBe(
        'Connected to Server (myhost:1433). Click to switch server.'
      );
    });
  });

  describe('show()', () => {
    it('should show server item', () => {
      indicator.show();
      expect(mockServerItem.show).toHaveBeenCalled();
    });

    it('should show database item when a connection config exists', () => {
      const config: ConnectionConfig = {
        name: 'Server',
        host: 'localhost',
        database: 'DB',
      };
      indicator.update(config);
      indicator.show();
      expect(mockDatabaseItem.show).toHaveBeenCalled();
    });

    it('should not show database item when no connection config exists', () => {
      indicator.update(null);
      mockDatabaseItem.show.mockClear();
      indicator.show();
      expect(mockDatabaseItem.show).not.toHaveBeenCalled();
    });
  });

  describe('hide()', () => {
    it('should hide server item', () => {
      indicator.hide();
      expect(mockServerItem.hide).toHaveBeenCalled();
    });

    it('should hide database item', () => {
      indicator.hide();
      expect(mockDatabaseItem.hide).toHaveBeenCalled();
    });
  });

  describe('onDidChangeActiveTextEditor - SQL file', () => {
    it('should show indicator when active editor is a SQL file', () => {
      const sqlEditor = {
        document: { languageId: 'sql' },
      };

      editorChangeListeners.forEach(listener => listener(sqlEditor));

      expect(mockServerItem.show).toHaveBeenCalled();
    });

    it('should show database item for SQL file when connection exists', () => {
      const config: ConnectionConfig = {
        name: 'Server',
        host: 'localhost',
        database: 'DB',
      };
      indicator.update(config);
      mockDatabaseItem.show.mockClear();
      mockServerItem.show.mockClear();

      const sqlEditor = {
        document: { languageId: 'sql' },
      };
      editorChangeListeners.forEach(listener => listener(sqlEditor));

      expect(mockServerItem.show).toHaveBeenCalled();
      expect(mockDatabaseItem.show).toHaveBeenCalled();
    });
  });

  describe('onDidChangeActiveTextEditor - non-SQL file', () => {
    it('should hide indicator when active editor is a non-SQL file', () => {
      const jsEditor = {
        document: { languageId: 'javascript' },
      };

      editorChangeListeners.forEach(listener => listener(jsEditor));

      expect(mockServerItem.hide).toHaveBeenCalled();
      expect(mockDatabaseItem.hide).toHaveBeenCalled();
    });

    it('should hide indicator for TypeScript files', () => {
      const tsEditor = {
        document: { languageId: 'typescript' },
      };

      editorChangeListeners.forEach(listener => listener(tsEditor));

      expect(mockServerItem.hide).toHaveBeenCalled();
      expect(mockDatabaseItem.hide).toHaveBeenCalled();
    });

    it('should hide indicator for JSON files', () => {
      const jsonEditor = {
        document: { languageId: 'json' },
      };

      editorChangeListeners.forEach(listener => listener(jsonEditor));

      expect(mockServerItem.hide).toHaveBeenCalled();
      expect(mockDatabaseItem.hide).toHaveBeenCalled();
    });
  });

  describe('onDidChangeActiveTextEditor - undefined', () => {
    it('should hide indicator when editor is undefined (no active editor)', () => {
      editorChangeListeners.forEach(listener => listener(undefined));

      expect(mockServerItem.hide).toHaveBeenCalled();
      expect(mockDatabaseItem.hide).toHaveBeenCalled();
    });
  });

  describe('dispose()', () => {
    it('should dispose server item', () => {
      indicator.dispose();
      expect(mockServerItem.dispose).toHaveBeenCalled();
    });

    it('should dispose database item', () => {
      indicator.dispose();
      expect(mockDatabaseItem.dispose).toHaveBeenCalled();
    });
  });

  describe('onConnectionChanged event triggers update', () => {
    it('should update indicator text when connection changes', () => {
      const newConfig: ConnectionConfig = {
        name: 'Production',
        host: 'prod.server.com',
        port: 1433,
        database: 'ProdDB',
      };

      connectionChangedListeners.forEach(listener => listener(newConfig));

      expect(mockServerItem.text).toBe('$(server) Production');
      expect(mockDatabaseItem.text).toBe('$(database) ProdDB');
    });

    it('should update to placeholder when connection is lost', () => {
      const config: ConnectionConfig = {
        name: 'Server',
        host: 'localhost',
        database: 'DB',
      };
      connectionChangedListeners.forEach(listener => listener(config));
      expect(mockServerItem.text).toBe('$(server) Server');

      connectionChangedListeners.forEach(listener => listener(null));

      expect(mockServerItem.text).toBe('$(server) No Connection');
      expect(mockDatabaseItem.text).toBe('');
    });

    it('should reactively update when switching servers', () => {
      const server1: ConnectionConfig = {
        name: 'Server1',
        host: 'host1',
        database: 'DB1',
      };
      const server2: ConnectionConfig = {
        name: 'Server2',
        host: 'host2',
        database: 'DB2',
      };

      connectionChangedListeners.forEach(listener => listener(server1));
      expect(mockServerItem.text).toBe('$(server) Server1');
      expect(mockDatabaseItem.text).toBe('$(database) DB1');

      connectionChangedListeners.forEach(listener => listener(server2));
      expect(mockServerItem.text).toBe('$(server) Server2');
      expect(mockDatabaseItem.text).toBe('$(database) DB2');
    });
  });
});
