import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock vscode module
const mockCreateTreeView = vi.fn();
const mockRegisterCommand = vi.fn();

vi.mock('vscode', () => ({
  window: {
    createTreeView: (...args: any[]) => mockCreateTreeView(...args),
    registerTreeDataProvider: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    registerWebviewViewProvider: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    showWarningMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    onDidChangeActiveTextEditor: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onDidChangeTextEditorSelection: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onDidChangeVisibleTextEditors: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    activeTextEditor: undefined,
    visibleTextEditors: [],
    createStatusBarItem: vi.fn().mockReturnValue({
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      text: '',
      tooltip: '',
      command: '',
    }),
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      append: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    })),
    createTextEditorDecorationType: vi.fn().mockReturnValue({
      dispose: vi.fn(),
    }),
  },
  commands: {
    registerCommand: (...args: any[]) => mockRegisterCommand(...args),
    executeCommand: vi.fn(),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, defaultValue: any) => defaultValue),
    })),
    onDidChangeConfiguration: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onDidChangeTextDocument: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onDidOpenTextDocument: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onDidCloseTextDocument: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    registerTextDocumentContentProvider: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  },
  languages: {
    registerCodeLensProvider: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    registerDocumentSymbolProvider: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItem: class MockTreeItem {
    label: string;
    constructor(label: string) { this.label = label; }
  },
  ThemeIcon: class MockThemeIcon {
    id: string;
    constructor(id: string) { this.id = id; }
  },
  ThemeColor: class MockThemeColor {
    id: string;
    constructor(id: string) { this.id = id; }
  },
  EventEmitter: class MockEventEmitter {
    event = vi.fn();
    fire = vi.fn();
    dispose = vi.fn();
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  Uri: { file: (path: string) => ({ fsPath: path }) },
}));

// Mock the language client module
vi.mock('../../src/languageClient', () => ({
  createLanguageClient: vi.fn(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendNotification: vi.fn(),
    sendRequest: vi.fn(),
  })),
}));

// Mock the ConnectionManager
const mockConnectionManagerLoadConnections = vi.fn().mockReturnValue([]);
const mockConnectionManagerOnConnectionChanged = vi.fn().mockReturnValue({ dispose: vi.fn() });
vi.mock('../../src/connectionManager', () => ({
  ConnectionManager: vi.fn(() => ({
    loadConnections: mockConnectionManagerLoadConnections,
    onConnectionChanged: mockConnectionManagerOnConnectionChanged,
    getActiveConnection: vi.fn().mockReturnValue(null),
    getActiveConfig: vi.fn().mockReturnValue(null),
    disconnect: vi.fn().mockResolvedValue(undefined),
    fireConnectionChanged: vi.fn(),
    dispose: vi.fn(),
  })),
}));

// Mock QueryExecutor, ResultPanelProvider, StatusBar
vi.mock('../../src/queryExecutor', () => ({
  QueryExecutor: vi.fn(() => ({
    execute: vi.fn(),
    cancel: vi.fn(),
    isExecuting: false,
    setHistoryStore: vi.fn(),
  })),
}));

vi.mock('../../src/resultPanelProvider', () => {
  const MockResultPanelProvider = vi.fn(() => ({
    show: vi.fn(),
    showProgress: vi.fn(),
    showCancellation: vi.fn(),
    showWithPagination: vi.fn(),
    setQueryExecutor: vi.fn(),
    dispose: vi.fn(),
  }));
  (MockResultPanelProvider as any).viewType = 'sqlServerResults';
  return { ResultPanelProvider: MockResultPanelProvider };
});

vi.mock('../../src/statusBar', () => ({
  StatusBar: vi.fn(() => ({
    update: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock('../../src/editorConnectionIndicator', () => ({
  EditorConnectionIndicator: vi.fn(() => ({
    update: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock('../../src/contextMenuHandler', () => ({
  ContextMenuHandler: vi.fn(() => ({
    selectTop100: vi.fn(),
    copyObjectName: vi.fn(),
    newQuery: vi.fn(),
    refreshNode: vi.fn(),
    deleteConnection: vi.fn(),
    duplicateConnection: vi.fn(),
    setConnectionFormPanel: vi.fn(),
    setSchemaDiagramPanel: vi.fn(),
  })),
}));

vi.mock('../../src/connectionSwitcher', () => ({
  switchServer: vi.fn(),
  switchDatabase: vi.fn(),
}));

// Mock SqlCodeLensProvider
vi.mock('../../src/sqlCodeLensProvider', () => ({
  SqlCodeLensProvider: vi.fn(() => ({
    onDidChangeCodeLenses: vi.fn(),
    provideCodeLenses: vi.fn().mockReturnValue([]),
    dispose: vi.fn(),
  })),
}));

// Mock ConnectionFormPanel
const mockConnectionFormPanelOpen = vi.fn();
vi.mock('../../src/connectionFormPanel', () => ({
  ConnectionFormPanel: vi.fn(() => ({
    open: mockConnectionFormPanelOpen,
    dispose: vi.fn(),
  })),
}));

// Mock definitionCommand
vi.mock('../../src/definitionCommand', () => ({
  goToDefinitionFromExplorer: vi.fn(),
  DefinitionContentProvider: vi.fn(() => ({
    provideTextDocumentContent: vi.fn().mockReturnValue(''),
    onDidChange: vi.fn(),
    dispose: vi.fn(),
  })),
  DEFINITION_SCHEME: 'tsql-definition',
}));

// Mock ErrorCategoryHandler
vi.mock('../../src/errorCategoryHandler', () => ({
  ErrorCategoryHandler: vi.fn(() => ({
    handleConnectionError: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  })),
}));

// Mock ExecutionStateManager
vi.mock('../../src/executionStateManager', () => ({
  ExecutionStateManager: vi.fn(() => ({
    getState: vi.fn().mockReturnValue('idle'),
    getStartTime: vi.fn().mockReturnValue(null),
    startExecution: vi.fn(),
    requestCancel: vi.fn(),
    completeExecution: vi.fn(),
    removeEditor: vi.fn(),
    onStateChanged: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    dispose: vi.fn(),
  })),
}));

// Mock StatementCodeLensProvider
vi.mock('../../src/statementCodeLensProvider', () => ({
  StatementCodeLensProvider: vi.fn(() => ({
    setExecutingStatement: vi.fn(),
    setConnectionActive: vi.fn(),
    setBoundaries: vi.fn(),
    provideCodeLenses: vi.fn().mockReturnValue([]),
    onDidChangeCodeLenses: vi.fn(),
    dispose: vi.fn(),
  })),
}));

// Mock ObjectExplorerConnectionManager
const mockOELoadConnections = vi.fn().mockReturnValue([]);
const mockOEDispose = vi.fn();
vi.mock('../../src/objectExplorer/objectExplorerConnectionManager', () => ({
  ObjectExplorerConnectionManager: vi.fn(() => ({
    loadConnections: mockOELoadConnections,
    saveConnection: vi.fn(),
    removeConnection: vi.fn(),
    getConnections: vi.fn().mockReturnValue([]),
    getGroups: vi.fn().mockReturnValue([]),
    getPool: vi.fn(),
    getPoolForDatabase: vi.fn(),
    dispose: mockOEDispose,
  })),
}));

// Mock MetadataQueryService
vi.mock('../../src/objectExplorer/metadataQueryService', () => ({
  MetadataQueryService: vi.fn(() => ({
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
  })),
}));

// Mock ObjectExplorerProvider
const mockAddConnection = vi.fn();
const mockRemoveConnection = vi.fn();
const mockRefresh = vi.fn();
vi.mock('../../src/objectExplorer/objectExplorerProvider', () => ({
  ObjectExplorerProvider: vi.fn(() => ({
    getTreeItem: vi.fn(),
    getChildren: vi.fn().mockResolvedValue([]),
    onDidChangeTreeData: vi.fn(),
    refresh: mockRefresh,
    refreshNode: vi.fn(),
    addConnection: mockAddConnection,
    removeConnection: mockRemoveConnection,
  })),
}));

// Mock QueryHistoryStore
vi.mock('../../src/queryHistoryStore', () => ({
  QueryHistoryStore: vi.fn(() => ({
    load: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    addRecord: vi.fn(),
    getRecords: vi.fn().mockReturnValue([]),
    search: vi.fn().mockReturnValue([]),
    clear: vi.fn(),
  })),
  createHistoryRecord: vi.fn(),
}));

// Mock QueryHistoryProvider
vi.mock('../../src/queryHistoryProvider', () => ({
  QueryHistoryProvider: vi.fn(() => ({
    refresh: vi.fn(),
    setFilter: vi.fn(),
    getTreeItem: vi.fn(),
    getChildren: vi.fn().mockReturnValue([]),
    onDidChangeTreeData: vi.fn(),
    dispose: vi.fn(),
  })),
}));

// Mock QueryHistoryCommands
vi.mock('../../src/queryHistoryCommands', () => ({
  registerQueryHistoryCommands: vi.fn(() => []),
}));

// Mock BatchNavigatorProvider
vi.mock('../../src/batchNavigatorProvider', () => ({
  BatchNavigatorProvider: vi.fn(() => ({
    provideCodeLenses: vi.fn().mockReturnValue([]),
    resolveCodeLens: vi.fn(),
    provideDocumentSymbols: vi.fn().mockReturnValue([]),
    showBatchQuickPick: vi.fn().mockResolvedValue(undefined),
    onDidChangeCodeLenses: vi.fn(),
    parseBatches: vi.fn().mockReturnValue([]),
    dispose: vi.fn(),
  })),
}));

import { activate } from '../../src/extension';
import { ObjectExplorerConnectionManager } from '../../src/objectExplorer/objectExplorerConnectionManager';

describe('Extension Activation - Object Explorer Registration', () => {
  let mockContext: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateTreeView.mockReturnValue({
      onDidCollapseElement: vi.fn(),
      dispose: vi.fn(),
    });
    mockRegisterCommand.mockReturnValue({ dispose: vi.fn() });
    mockContext = {
      subscriptions: [],
      extensionPath: '/test/extension',
      extensionUri: { fsPath: '/test/extension' },
      storageUri: undefined,
      globalStorageUri: { fsPath: '/test/global' },
      logUri: { fsPath: '/test/logs' },
      extensionMode: 1,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Tree view registration', () => {
    it('registers the tree view with id "objectExplorer" and showCollapseAll: true', async () => {
      await activate(mockContext);

      expect(mockCreateTreeView).toHaveBeenCalledWith('objectExplorer', {
        treeDataProvider: expect.any(Object),
        showCollapseAll: true,
      });
    });

    it('registers the tree view exactly once', async () => {
      await activate(mockContext);

      expect(mockCreateTreeView).toHaveBeenCalledTimes(1);
    });
  });

  describe('Command registration', () => {
    it('registers the sqlServer.addConnection command', async () => {
      await activate(mockContext);

      const registeredCommands = mockRegisterCommand.mock.calls.map(
        (call: any[]) => call[0]
      );
      expect(registeredCommands).toContain('sqlServer.addConnection');
    });

    it('registers the sqlServer.removeConnection command', async () => {
      await activate(mockContext);

      const registeredCommands = mockRegisterCommand.mock.calls.map(
        (call: any[]) => call[0]
      );
      expect(registeredCommands).toContain('sqlServer.removeConnection');
    });

    it('addConnection command calls connectionFormPanel.open()', async () => {
      await activate(mockContext);

      // Find the addConnection command handler
      const addConnectionCall = mockRegisterCommand.mock.calls.find(
        (call: any[]) => call[0] === 'sqlServer.addConnection'
      );
      expect(addConnectionCall).toBeDefined();

      // Execute the command handler
      const handler = addConnectionCall![1];
      handler();

      expect(mockConnectionFormPanelOpen).toHaveBeenCalled();
    });

    it('removeConnection command calls objectExplorerProvider.removeConnection()', async () => {
      await activate(mockContext);

      // Find the removeConnection command handler
      const removeConnectionCall = mockRegisterCommand.mock.calls.find(
        (call: any[]) => call[0] === 'sqlServer.removeConnection'
      );
      expect(removeConnectionCall).toBeDefined();

      // Execute the command handler with a mock node
      const handler = removeConnectionCall![1];
      const mockNode = { kind: 'server', label: 'Test', connectionName: 'Test' };
      handler(mockNode);

      expect(mockRemoveConnection).toHaveBeenCalledWith(mockNode);
    });
  });

  describe('Connection loading on activation', () => {
    it('calls ObjectExplorerConnectionManager.loadConnections() during activation', async () => {
      await activate(mockContext);

      expect(mockOELoadConnections).toHaveBeenCalled();
    });

    it('calls loadConnections() exactly once during activation', async () => {
      await activate(mockContext);

      expect(mockOELoadConnections).toHaveBeenCalledTimes(1);
    });

    it('creates ObjectExplorerConnectionManager with workspace root path', async () => {
      await activate(mockContext);

      expect(ObjectExplorerConnectionManager).toHaveBeenCalledWith('/test/workspace');
    });
  });

  describe('Disposables registration', () => {
    it('adds disposables to context.subscriptions', async () => {
      await activate(mockContext);

      // Should have multiple subscriptions registered
      expect(mockContext.subscriptions.length).toBeGreaterThan(0);
    });

    it('registers the tree view as a disposable', async () => {
      await activate(mockContext);

      // The tree view mock has a dispose method and should be in subscriptions
      const hasTreeViewDisposable = mockContext.subscriptions.some(
        (sub: any) => sub.dispose !== undefined
      );
      expect(hasTreeViewDisposable).toBe(true);
    });
  });
});
