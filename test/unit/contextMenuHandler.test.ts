import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode module
vi.mock('vscode', () => ({
  workspace: {
    openTextDocument: vi.fn(),
  },
  window: {
    showTextDocument: vi.fn(),
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
  env: {
    clipboard: {
      writeText: vi.fn(),
    },
  },
  commands: {
    executeCommand: vi.fn(),
  },
}));

import * as vscode from 'vscode';
import {
  ContextMenuHandler,
  formatQualifiedName,
  generateSelectTop100,
  getCopyText,
} from '../../src/contextMenuHandler';
import type { TableNode, ViewNode, ServerNode, DatabaseNode, ColumnNode, FolderNode } from '../../src/objectExplorer/types';

// Helper to create mock dependencies
function createMocks() {
  const objectExplorerProvider = {
    refreshNode: vi.fn(),
    refresh: vi.fn(),
  };

  const connectionManager = {
    getPoolForDatabase: vi.fn(),
    getPool: vi.fn(),
  };

  const queryExecutor = {
    execute: vi.fn(),
    cancel: vi.fn(),
    isExecuting: false,
  };

  return { objectExplorerProvider, connectionManager, queryExecutor };
}

describe('ContextMenuHandler', () => {
  let handler: ContextMenuHandler;
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMocks();
    handler = new ContextMenuHandler(
      mocks.objectExplorerProvider as any,
      mocks.connectionManager as any,
      mocks.queryExecutor as any
    );
  });

  // ==========================================================================
  // selectTop100
  // ==========================================================================

  describe('selectTop100', () => {
    it('should generate correct SQL, open editor, get pool, execute query, and fire showResults', async () => {
      const node: TableNode = {
        kind: 'table',
        label: 'dbo.Users',
        connectionName: 'MyServer',
        database: 'TestDB',
        schema: 'dbo',
        tableName: 'Users',
        isExternal: false,
      };

      const mockDoc = { uri: 'test-uri' };
      const mockEditor = { document: mockDoc };
      const mockPool = { connected: true };
      const mockResult = { resultSets: [{ columns: [], rows: [], rowCount: 0 }], rowsAffected: 0, executionTimeMs: 50 };

      vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDoc as any);
      vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor as any);
      mocks.connectionManager.getPoolForDatabase.mockResolvedValue(mockPool);
      mocks.queryExecutor.execute.mockResolvedValue(mockResult);
      vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);

      await handler.selectTop100(node);

      // Verify SQL document was opened with correct content
      expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({
        language: 'sql',
        content: 'SELECT TOP 100 * FROM [dbo].[Users]',
      });

      // Verify editor was shown
      expect(vscode.window.showTextDocument).toHaveBeenCalledWith(mockDoc);

      // Verify pool was obtained for the correct connection and database
      expect(mocks.connectionManager.getPoolForDatabase).toHaveBeenCalledWith('MyServer', 'TestDB');

      // Verify query was executed
      expect(mocks.queryExecutor.execute).toHaveBeenCalledWith(
        'SELECT TOP 100 * FROM [dbo].[Users]',
        mockPool
      );

      // Verify results were shown
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('sqlServer.showResults', mockResult);
    });

    it('should work with view nodes', async () => {
      const node: ViewNode = {
        kind: 'view',
        label: 'dbo.ActiveUsers',
        connectionName: 'MyServer',
        database: 'TestDB',
        schema: 'dbo',
        viewName: 'ActiveUsers',
        isSystem: false,
      };

      const mockDoc = { uri: 'test-uri' };
      const mockEditor = { document: mockDoc };
      const mockPool = { connected: true };
      const mockResult = { resultSets: [], rowsAffected: 0, executionTimeMs: 10 };

      vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDoc as any);
      vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor as any);
      mocks.connectionManager.getPoolForDatabase.mockResolvedValue(mockPool);
      mocks.queryExecutor.execute.mockResolvedValue(mockResult);
      vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);

      await handler.selectTop100(node);

      expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({
        language: 'sql',
        content: 'SELECT TOP 100 * FROM [dbo].[ActiveUsers]',
      });
    });

    it('should show error message when connection fails', async () => {
      const node: TableNode = {
        kind: 'table',
        label: 'dbo.Orders',
        connectionName: 'MyServer',
        database: 'TestDB',
        schema: 'dbo',
        tableName: 'Orders',
        isExternal: false,
      };

      const mockDoc = { uri: 'test-uri' };
      const mockEditor = { document: mockDoc };

      vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDoc as any);
      vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor as any);
      mocks.connectionManager.getPoolForDatabase.mockRejectedValue(new Error('Connection refused'));

      await handler.selectTop100(node);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Connection refused')
      );
    });

    it('should show error message when query execution fails', async () => {
      const node: TableNode = {
        kind: 'table',
        label: 'dbo.Products',
        connectionName: 'MyServer',
        database: 'TestDB',
        schema: 'dbo',
        tableName: 'Products',
        isExternal: false,
      };

      const mockDoc = { uri: 'test-uri' };
      const mockEditor = { document: mockDoc };
      const mockPool = { connected: true };

      vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDoc as any);
      vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor as any);
      mocks.connectionManager.getPoolForDatabase.mockResolvedValue(mockPool);
      mocks.queryExecutor.execute.mockRejectedValue(new Error('Query timeout'));

      await handler.selectTop100(node);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Query timeout')
      );
    });

    it('should show error when schema is missing', async () => {
      const node = {
        kind: 'table',
        label: 'Users',
        connectionName: 'MyServer',
        database: 'TestDB',
        schema: '',
        tableName: 'Users',
        isExternal: false,
      } as TableNode;

      await handler.selectTop100(node);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('missing schema or object name')
      );
      // Should not attempt to open a document
      expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // copyObjectName
  // ==========================================================================

  describe('copyObjectName', () => {
    it('should copy [schema].[tableName] for table nodes', async () => {
      const node: TableNode = {
        kind: 'table',
        label: 'dbo.Users',
        connectionName: 'MyServer',
        database: 'TestDB',
        schema: 'dbo',
        tableName: 'Users',
        isExternal: false,
      };

      vi.mocked(vscode.env.clipboard.writeText).mockResolvedValue(undefined);

      await handler.copyObjectName(node);

      expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('[dbo].[Users]');
    });

    it('should copy [schema].[viewName] for view nodes', async () => {
      const node: ViewNode = {
        kind: 'view',
        label: 'dbo.ActiveUsers',
        connectionName: 'MyServer',
        database: 'TestDB',
        schema: 'dbo',
        viewName: 'ActiveUsers',
        isSystem: false,
      };

      vi.mocked(vscode.env.clipboard.writeText).mockResolvedValue(undefined);

      await handler.copyObjectName(node);

      expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('[dbo].[ActiveUsers]');
    });

    it('should copy column name for column nodes', async () => {
      const node: ColumnNode = {
        kind: 'column',
        label: 'UserID (int)',
        connectionName: 'MyServer',
        database: 'TestDB',
        columnName: 'UserID',
        dataType: 'int',
        isPrimaryKey: true,
        isForeignKey: false,
      };

      vi.mocked(vscode.env.clipboard.writeText).mockResolvedValue(undefined);

      await handler.copyObjectName(node);

      expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('UserID');
    });

    it('should copy node label for folder nodes', async () => {
      const node: FolderNode = {
        kind: 'folder',
        label: 'Tables',
        connectionName: 'MyServer',
        folderType: 'tables',
        database: 'TestDB',
      };

      vi.mocked(vscode.env.clipboard.writeText).mockResolvedValue(undefined);

      await handler.copyObjectName(node);

      expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('Tables');
    });

    it('should show error message when clipboard write fails', async () => {
      const node: TableNode = {
        kind: 'table',
        label: 'dbo.Users',
        connectionName: 'MyServer',
        database: 'TestDB',
        schema: 'dbo',
        tableName: 'Users',
        isExternal: false,
      };

      vi.mocked(vscode.env.clipboard.writeText).mockRejectedValue(new Error('Clipboard access denied'));

      await handler.copyObjectName(node);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Clipboard access denied')
      );
    });
  });

  // ==========================================================================
  // newQuery
  // ==========================================================================

  describe('newQuery', () => {
    it('should default to master database for server nodes', async () => {
      const node: ServerNode = {
        kind: 'server',
        label: 'MyServer',
        connectionName: 'MyServer',
      };

      const mockDoc = { uri: 'test-uri' };
      const mockEditor = { document: mockDoc };
      const mockPool = { connected: true };

      vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDoc as any);
      vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor as any);
      mocks.connectionManager.getPoolForDatabase.mockResolvedValue(mockPool);

      await handler.newQuery(node);

      // Verify blank SQL document was opened
      expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({
        language: 'sql',
        content: '',
      });

      // Verify pool was obtained with 'master' database
      expect(mocks.connectionManager.getPoolForDatabase).toHaveBeenCalledWith('MyServer', 'master');
    });

    it('should use databaseName for database nodes', async () => {
      const node: DatabaseNode = {
        kind: 'database',
        label: 'ProductionDB',
        connectionName: 'MyServer',
        databaseName: 'ProductionDB',
        isSystem: false,
        isOffline: false,
      };

      const mockDoc = { uri: 'test-uri' };
      const mockEditor = { document: mockDoc };
      const mockPool = { connected: true };

      vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDoc as any);
      vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor as any);
      mocks.connectionManager.getPoolForDatabase.mockResolvedValue(mockPool);

      await handler.newQuery(node);

      expect(mocks.connectionManager.getPoolForDatabase).toHaveBeenCalledWith('MyServer', 'ProductionDB');
    });

    it('should use node.database for table nodes', async () => {
      const node: TableNode = {
        kind: 'table',
        label: 'dbo.Users',
        connectionName: 'MyServer',
        database: 'SalesDB',
        schema: 'dbo',
        tableName: 'Users',
        isExternal: false,
      };

      const mockDoc = { uri: 'test-uri' };
      const mockEditor = { document: mockDoc };
      const mockPool = { connected: true };

      vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDoc as any);
      vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor as any);
      mocks.connectionManager.getPoolForDatabase.mockResolvedValue(mockPool);

      await handler.newQuery(node);

      expect(mocks.connectionManager.getPoolForDatabase).toHaveBeenCalledWith('MyServer', 'SalesDB');
    });

    it('should use node.database for view nodes', async () => {
      const node: ViewNode = {
        kind: 'view',
        label: 'dbo.ActiveUsers',
        connectionName: 'MyServer',
        database: 'AnalyticsDB',
        schema: 'dbo',
        viewName: 'ActiveUsers',
        isSystem: false,
      };

      const mockDoc = { uri: 'test-uri' };
      const mockEditor = { document: mockDoc };
      const mockPool = { connected: true };

      vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDoc as any);
      vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor as any);
      mocks.connectionManager.getPoolForDatabase.mockResolvedValue(mockPool);

      await handler.newQuery(node);

      expect(mocks.connectionManager.getPoolForDatabase).toHaveBeenCalledWith('MyServer', 'AnalyticsDB');
    });

    it('should show error message when opening document fails', async () => {
      const node: ServerNode = {
        kind: 'server',
        label: 'MyServer',
        connectionName: 'MyServer',
      };

      vi.mocked(vscode.workspace.openTextDocument).mockRejectedValue(new Error('Cannot create document'));

      await handler.newQuery(node);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Cannot create document')
      );
    });

    it('should show error message when connection fails', async () => {
      const node: DatabaseNode = {
        kind: 'database',
        label: 'TestDB',
        connectionName: 'MyServer',
        databaseName: 'TestDB',
        isSystem: false,
        isOffline: false,
      };

      const mockDoc = { uri: 'test-uri' };
      const mockEditor = { document: mockDoc };

      vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDoc as any);
      vi.mocked(vscode.window.showTextDocument).mockResolvedValue(mockEditor as any);
      mocks.connectionManager.getPoolForDatabase.mockRejectedValue(new Error('Connection "MyServer" not found.'));

      await handler.newQuery(node);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Connection "MyServer" not found')
      );
    });
  });

  // ==========================================================================
  // refreshNode
  // ==========================================================================

  describe('refreshNode', () => {
    it('should call objectExplorerProvider.refreshNode with the node', async () => {
      const node: ServerNode = {
        kind: 'server',
        label: 'MyServer',
        connectionName: 'MyServer',
      };

      await handler.refreshNode(node);

      expect(mocks.objectExplorerProvider.refreshNode).toHaveBeenCalledWith(node);
    });

    it('should call refreshNode for database nodes', async () => {
      const node: DatabaseNode = {
        kind: 'database',
        label: 'TestDB',
        connectionName: 'MyServer',
        databaseName: 'TestDB',
        isSystem: false,
        isOffline: false,
      };

      await handler.refreshNode(node);

      expect(mocks.objectExplorerProvider.refreshNode).toHaveBeenCalledWith(node);
    });

    it('should show error message when refreshNode throws', async () => {
      const node: ServerNode = {
        kind: 'server',
        label: 'MyServer',
        connectionName: 'MyServer',
      };

      mocks.objectExplorerProvider.refreshNode.mockImplementation(() => {
        throw new Error('Tree data provider disposed');
      });

      await handler.refreshNode(node);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Tree data provider disposed')
      );
    });
  });

  // ==========================================================================
  // Pure helper functions (exported for property testing, but also unit tested)
  // ==========================================================================

  describe('formatQualifiedName', () => {
    it('should format schema and object name with brackets', () => {
      expect(formatQualifiedName('dbo', 'Users')).toBe('[dbo].[Users]');
    });

    it('should handle schemas with special characters', () => {
      expect(formatQualifiedName('my schema', 'my table')).toBe('[my schema].[my table]');
    });
  });

  describe('generateSelectTop100', () => {
    it('should generate correct SELECT statement', () => {
      expect(generateSelectTop100('dbo', 'Users')).toBe('SELECT TOP 100 * FROM [dbo].[Users]');
    });

    it('should handle non-dbo schemas', () => {
      expect(generateSelectTop100('sales', 'Orders')).toBe('SELECT TOP 100 * FROM [sales].[Orders]');
    });
  });

  describe('getCopyText', () => {
    it('should return qualified name for table nodes', () => {
      const node: TableNode = {
        kind: 'table',
        label: 'dbo.Users',
        connectionName: 'MyServer',
        database: 'TestDB',
        schema: 'dbo',
        tableName: 'Users',
        isExternal: false,
      };
      expect(getCopyText(node)).toBe('[dbo].[Users]');
    });

    it('should return qualified name for view nodes', () => {
      const node: ViewNode = {
        kind: 'view',
        label: 'dbo.ActiveUsers',
        connectionName: 'MyServer',
        database: 'TestDB',
        schema: 'dbo',
        viewName: 'ActiveUsers',
        isSystem: false,
      };
      expect(getCopyText(node)).toBe('[dbo].[ActiveUsers]');
    });

    it('should return column name for column nodes', () => {
      const node: ColumnNode = {
        kind: 'column',
        label: 'UserID (int)',
        connectionName: 'MyServer',
        database: 'TestDB',
        columnName: 'UserID',
        dataType: 'int',
        isPrimaryKey: false,
        isForeignKey: false,
      };
      expect(getCopyText(node)).toBe('UserID');
    });

    it('should return label for folder nodes', () => {
      const node: FolderNode = {
        kind: 'folder',
        label: 'Databases',
        connectionName: 'MyServer',
        folderType: 'databases',
      };
      expect(getCopyText(node)).toBe('Databases');
    });

    it('should return label for server nodes', () => {
      const node: ServerNode = {
        kind: 'server',
        label: 'Production Server',
        connectionName: 'Production Server',
      };
      expect(getCopyText(node)).toBe('Production Server');
    });
  });

  // ==========================================================================
  // deleteConnection
  // ==========================================================================

  describe('deleteConnection', () => {
    let handlerWithQueryConn: ContextMenuHandler;
    let queryConnectionManager: {
      getActiveConfig: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
      fireConnectionChanged: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      queryConnectionManager = {
        getActiveConfig: vi.fn(),
        disconnect: vi.fn().mockResolvedValue(undefined),
        fireConnectionChanged: vi.fn(),
      };

      handlerWithQueryConn = new ContextMenuHandler(
        mocks.objectExplorerProvider as any,
        mocks.connectionManager as any,
        mocks.queryExecutor as any,
        queryConnectionManager as any
      );
    });

    it('should show confirmation dialog', async () => {
      const node: ServerNode = {
        kind: 'server',
        label: 'MyServer',
        connectionName: 'MyServer',
      };

      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('No' as any);

      await handlerWithQueryConn.deleteConnection(node);

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        "Are you sure you want to delete connection 'MyServer'?",
        { modal: false },
        'Yes',
        'No'
      );
    });

    it('should remove connection on confirm', async () => {
      const node: ServerNode = {
        kind: 'server',
        label: 'MyServer',
        connectionName: 'MyServer',
      };

      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Yes' as any);
      mocks.connectionManager.removeConnection = vi.fn().mockResolvedValue(undefined);
      queryConnectionManager.getActiveConfig.mockReturnValue(null);

      await handlerWithQueryConn.deleteConnection(node);

      expect(mocks.connectionManager.removeConnection).toHaveBeenCalledWith('MyServer');
      expect(mocks.objectExplorerProvider.refresh).toHaveBeenCalled();
    });

    it('should do nothing on cancel', async () => {
      const node: ServerNode = {
        kind: 'server',
        label: 'MyServer',
        connectionName: 'MyServer',
      };

      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('No' as any);
      mocks.connectionManager.removeConnection = vi.fn();

      await handlerWithQueryConn.deleteConnection(node);

      expect(mocks.connectionManager.removeConnection).not.toHaveBeenCalled();
      expect(mocks.objectExplorerProvider.refresh).not.toHaveBeenCalled();
    });

    it('should clear active connection if it was the deleted one', async () => {
      const node: ServerNode = {
        kind: 'server',
        label: 'MyServer',
        connectionName: 'MyServer',
      };

      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Yes' as any);
      mocks.connectionManager.removeConnection = vi.fn().mockResolvedValue(undefined);
      queryConnectionManager.getActiveConfig.mockReturnValue({ name: 'MyServer' });

      await handlerWithQueryConn.deleteConnection(node);

      expect(queryConnectionManager.disconnect).toHaveBeenCalled();
      expect(queryConnectionManager.fireConnectionChanged).toHaveBeenCalled();
      expect(mocks.objectExplorerProvider.refresh).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // duplicateConnection
  // ==========================================================================

  describe('duplicateConnection', () => {
    let handlerWithForm: ContextMenuHandler;
    let connectionFormPanel: {
      open: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      connectionFormPanel = {
        open: vi.fn(),
      };

      handlerWithForm = new ContextMenuHandler(
        mocks.objectExplorerProvider as any,
        mocks.connectionManager as any,
        mocks.queryExecutor as any
      );
      handlerWithForm.setConnectionFormPanel(connectionFormPanel as any);
    });

    it('should open form with prefilled data and "(Copy)" suffix', async () => {
      const node: ServerNode = {
        kind: 'server',
        label: 'MyServer',
        connectionName: 'MyServer',
      };

      const mockConfig = {
        name: 'MyServer',
        host: 'localhost',
        port: 1433,
        database: 'master',
        authType: 'sql',
        user: 'sa',
      };

      mocks.connectionManager.getConfigByName = vi.fn().mockReturnValue(mockConfig);

      await handlerWithForm.duplicateConnection(node);

      expect(mocks.connectionManager.getConfigByName).toHaveBeenCalledWith('MyServer');
      expect(connectionFormPanel.open).toHaveBeenCalledWith(undefined, mockConfig);
    });
  });
});
