import * as vscode from 'vscode';
import * as path from 'path';
import { LanguageClient } from 'vscode-languageclient/node';
import { createLanguageClient } from './languageClient';
import { ConnectionManager } from './connectionManager';
import { QueryExecutor, ConnectionMeta } from './queryExecutor';
import { ResultPanelProvider } from './resultPanelProvider';
import { StatusBar } from './statusBar';
import { EditorConnectionIndicator } from './editorConnectionIndicator';
import { ConnectionColorIndicator } from './connectionColorIndicator';
import { ContextMenuHandler } from './contextMenuHandler';
import { switchServer, switchDatabase } from './connectionSwitcher';
import { ConnectionConfig } from './types';
import { ObjectExplorerProvider } from './objectExplorer/objectExplorerProvider';
import { ObjectExplorerConnectionManager } from './objectExplorer/objectExplorerConnectionManager';
import { MetadataQueryService } from './objectExplorer/metadataQueryService';
import { SqlCodeLensProvider } from './sqlCodeLensProvider';
import { ConnectionFormPanel } from './connectionFormPanel';
import { goToDefinitionFromExplorer, DefinitionContentProvider, DEFINITION_SCHEME, setDefinitionContent } from './definitionCommand';
import { ErrorCategoryHandler } from './errorCategoryHandler';
import { ExecutionStateManager } from './executionStateManager';
import { StatementCodeLensProvider } from './statementCodeLensProvider';
import { TablePreviewManager } from './tablePreviewManager';
import { TableNode, ViewNode, ColumnNode } from './objectExplorer/types';
import { StatementOutlineDecorator } from './statementOutlineDecorator';
import { parseStatements, findStatementAtCursor } from './statementParser';
import { registerKeyboardShortcutCommand } from './keyboardShortcutCommand';
import { QueryStatusIndicator } from './queryStatusIndicator';
import { QueryHistoryStore } from './queryHistoryStore';
import { QueryHistoryProvider } from './queryHistoryProvider';
import { registerQueryHistoryCommands } from './queryHistoryCommands';
import { ExportManager } from './exportManager';
import { StatementBoundary } from './types';
import { detectAllUndeclaredVariables } from './variableDetector';
import { promptForVariableValues, generateDeclareStatements } from './variablePrompt';
import { parseExecutionPlanXml } from './executionPlanParser';
import { ExecutionPlanPanel } from './executionPlanPanel';
import { SchemaDiagramPanel } from './schemaDiagramPanel';
import { ReferenceFinder } from './referenceFinder';
import { RenameRefactorHandler } from './renameRefactorHandler';
import { BatchNavigatorProvider } from './batchNavigatorProvider';
import { registerSchemaDiffCommands } from './schemaDiff/schemaDiffCommands';
import { AlterScriptGenerator } from './schemaDiff/alterScriptGenerator';
import { SchemaDiff } from './schemaDiff/schemaDiffTypes';
import { SqlSearchService } from './sqlSearchService';
import { SqlSearchPanelProvider } from './sqlSearchPanelProvider';
import { checkBeforeExecution } from './destructiveQueryGuard';
import { runConnectionDiagnostics } from './connectionDiagnostics';

let client: LanguageClient | undefined;
let connectionManager: ConnectionManager | undefined;
let queryExecutor: QueryExecutor | undefined;
let resultPanelProvider: ResultPanelProvider | undefined;
let statusBar: StatusBar | undefined;
let editorConnectionIndicator: EditorConnectionIndicator | undefined;
let connectionColorIndicator: ConnectionColorIndicator | undefined;
let objectExplorerConnectionManager: ObjectExplorerConnectionManager | undefined;
let errorCategoryHandler: ErrorCategoryHandler | undefined;
let executionStateManager: ExecutionStateManager | undefined;
let tablePreviewManager: TablePreviewManager | undefined;
let queryStatusIndicator: QueryStatusIndicator | undefined;
let executionPlanPanel: ExecutionPlanPanel | undefined;
let schemaDiagramPanel: SchemaDiagramPanel | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Initialize the Language Client
  client = createLanguageClient(context);

  // Instantiate core components
  connectionManager = new ConnectionManager();
  queryExecutor = new QueryExecutor();
  statusBar = new StatusBar();

  // Create output channel and error category handler (Requirements 2.1–2.10)
  const outputChannel = vscode.window.createOutputChannel('SQL Server');
  errorCategoryHandler = new ErrorCategoryHandler(outputChannel);

  // Instantiate ExecutionStateManager for per-editor run/stop state tracking (Requirements 3.1–3.9)
  executionStateManager = new ExecutionStateManager();

  // Instantiate QueryStatusIndicator for row count/duration display (Requirements 5.1, 5.6, 5.8, 5.9)
  queryStatusIndicator = new QueryStatusIndicator();

  // Instantiate the new ResultPanelProvider (bottom panel webview)
  resultPanelProvider = new ResultPanelProvider(context.extensionUri);

  // Wire up the query executor for pagination batch fetching
  resultPanelProvider.setQueryExecutor(queryExecutor);

  // Register ResultPanelProvider as a webview view provider (Requirements 8.1, 8.2)
  const resultPanelRegistration = vscode.window.registerWebviewViewProvider(
    ResultPanelProvider.viewType,
    resultPanelProvider
  );

  // Load connections from workspace config file
  connectionManager.loadConnections();

  // --- Object Explorer Panel Registration ---
  // Determine workspace root for connection persistence
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const workspaceRoot = workspaceFolders && workspaceFolders.length > 0
    ? workspaceFolders[0].uri.fsPath
    : '';

  // Instantiate Object Explorer components
  objectExplorerConnectionManager = new ObjectExplorerConnectionManager(workspaceRoot);
  const metadataService = new MetadataQueryService();
  const objectExplorerProvider = new ObjectExplorerProvider(objectExplorerConnectionManager, metadataService);

  // Load saved connections on activation (Requirements 12.3, 12.4)
  objectExplorerConnectionManager.loadConnections();

  // Instantiate TablePreviewManager for double-click table preview (Requirements 1.1, 1.10)
  tablePreviewManager = new TablePreviewManager(objectExplorerConnectionManager, context.extensionUri);

  // --- SQL Object Search Panel Registration (Requirement 1.1) ---
  const searchService = new SqlSearchService(objectExplorerConnectionManager);
  const searchPanelProvider = new SqlSearchPanelProvider(
    context.extensionUri,
    searchService,
    objectExplorerConnectionManager,
    context.workspaceState
  );
  const searchPanelRegistration = vscode.window.registerWebviewViewProvider(
    SqlSearchPanelProvider.viewType,
    searchPanelProvider
  );

  // Wire connection change events to search cache invalidation.
  // ObjectExplorerProvider.onDidChangeTreeData fires when connections are added, removed,
  // or refreshed — clear the search cache to avoid stale results.
  const searchCacheInvalidationDisposable = objectExplorerProvider.onDidChangeTreeData(() => {
    searchService.clearCache();
  });

  // --- Query History Registration (Requirements 3.3, 4.1, 4.5, 4.6) ---
  const historyStore = new QueryHistoryStore(workspaceRoot);
  historyStore.load().catch(err => {
    console.warn(`[QueryHistory] Failed to load history on activation: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Pass history store to QueryExecutor so it records queries automatically
  queryExecutor.setHistoryStore(historyStore);

  // Instantiate QueryHistoryProvider as TreeDataProvider for the queryHistory view
  const historyProvider = new QueryHistoryProvider(historyStore);
  const historyTreeRegistration = vscode.window.registerTreeDataProvider('queryHistory', historyProvider);

  // Register query history commands (rerun, clear, search, open)
  const connectionsFilePath = path.join(workspaceRoot, '.sql-connections.json');
  const historyDisposables = registerQueryHistoryCommands(historyStore, historyProvider, connectionsFilePath);

  // Register tree view with collapse-all button (Requirements 1.1, 1.2, 1.3, 1.4)
  const treeView = vscode.window.createTreeView('objectExplorer', {
    treeDataProvider: objectExplorerProvider,
    showCollapseAll: true,
  });

  // Discard children on collapse so next expansion re-queries (Requirement 11.6)
  treeView.onDidCollapseElement(() => {
    objectExplorerProvider.refresh();
  });

  // --- SQL CodeLens Provider (Requirements 1.1–1.8) ---
  const codeLensProvider = new SqlCodeLensProvider(connectionManager);
  const codeLensRegistration = vscode.languages.registerCodeLensProvider(
    { language: 'sql' },
    codeLensProvider
  );

  // --- Connection Form Panel (Requirements 4.1–4.13) ---
  const connectionFormPanel = new ConnectionFormPanel(
    context.extensionUri,
    objectExplorerConnectionManager,
    objectExplorerProvider
  );

  // --- Context Menu Handler (Requirements 1.4, 1.5, 1.6, 5.1) ---
  const contextMenuHandler = new ContextMenuHandler(
    objectExplorerProvider,
    objectExplorerConnectionManager,
    queryExecutor,
    connectionManager
  );

  // Pass connection form panel reference to context menu handler for duplicateConnection
  contextMenuHandler.setConnectionFormPanel(connectionFormPanel);

  // --- Definition Content Provider (Requirement 4.5) ---
  const definitionContentProvider = new DefinitionContentProvider();
  const definitionProviderRegistration = vscode.workspace.registerTextDocumentContentProvider(
    DEFINITION_SCHEME,
    definitionContentProvider
  );

  // Register Go to Definition command for Object Explorer (Requirements 4.1, 4.2)
  const goToDefinitionCmd = vscode.commands.registerCommand('sqlServer.goToDefinition', (node) => {
    return goToDefinitionFromExplorer(node, objectExplorerConnectionManager!);
  });

  // Register Add Connection command — opens webview form (Requirements 4.1, 4.2, 4.3)
  const addConnectionCmd = vscode.commands.registerCommand('sqlServer.addConnection', () => {
    connectionFormPanel.open();
  });

  // Register Remove Connection command (Requirement 5.3)
  const removeConnectionCmd = vscode.commands.registerCommand('sqlServer.removeConnection', (node) => {
    return objectExplorerProvider.removeConnection(node);
  });

  // Register Connection Group commands
  const addConnectionGroupCmd = vscode.commands.registerCommand('sqlServer.addConnectionGroup', async () => {
    const name = await vscode.window.showInputBox({
      prompt: 'Enter a name for the connection group',
      placeHolder: 'e.g., Prod, Dev, Staging',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Group name is required';
        }
        const existing = objectExplorerConnectionManager!.getGroups();
        if (existing.some(g => g.name.toLowerCase() === value.trim().toLowerCase())) {
          return 'A group with this name already exists';
        }
        return undefined;
      },
    });
    if (!name) { return; }

    const colorPick = await vscode.window.showQuickPick(
      [
        { label: '$(circle-filled) Red', value: '#E53935' },
        { label: '$(circle-filled) Orange', value: '#FB8C00' },
        { label: '$(circle-filled) Yellow', value: '#FDD835' },
        { label: '$(circle-filled) Green', value: '#43A047' },
        { label: '$(circle-filled) Blue', value: '#1E88E5' },
        { label: '$(circle-filled) Purple', value: '#8E24AA' },
        { label: '$(circle-filled) Teal', value: '#00897B' },
        { label: '$(circle-filled) Gray', value: '#757575' },
      ],
      { placeHolder: 'Pick a group color', ignoreFocusOut: true }
    );
    if (!colorPick) { return; }

    await objectExplorerConnectionManager!.addGroup({ name: name.trim(), color: colorPick.value });
    objectExplorerProvider.refresh();
  });

  const removeConnectionGroupCmd = vscode.commands.registerCommand('sqlServer.removeConnectionGroup', async (node: any) => {
    if (!node || node.kind !== 'connectionGroup') { return; }
    const confirm = await vscode.window.showWarningMessage(
      `Remove group "${node.groupName}"? Connections in this group will become ungrouped.`,
      { modal: true },
      'Remove'
    );
    if (confirm === 'Remove') {
      await objectExplorerConnectionManager!.removeGroup(node.groupName);
      objectExplorerProvider.refresh();
    }
  });

  const assignToGroupCmd = vscode.commands.registerCommand('sqlServer.assignToGroup', async (node: any) => {
    if (!node || node.kind !== 'server') { return; }
    const groups = objectExplorerConnectionManager!.getGroups();
    if (groups.length === 0) {
      vscode.window.showInformationMessage('No connection groups exist. Create one first with the "Add Group" command.');
      return;
    }
    const items = [
      { label: '(None — remove from group)', value: undefined as string | undefined },
      ...groups.map(g => ({ label: g.name, value: g.name as string | undefined })),
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a group for this connection',
      ignoreFocusOut: true,
    });
    if (pick === undefined) { return; } // cancelled
    await objectExplorerConnectionManager!.assignConnectionToGroup(node.connectionName, pick.value);
    objectExplorerProvider.refresh();
  });

  // Register Edit Connection command (Requirements 4.12, 4.13)
  const editConnectionCmd = vscode.commands.registerCommand('sqlServer.editConnection', (node) => {
    const config = objectExplorerConnectionManager!.getConfigByName(node.connectionName);
    if (config) {
      connectionFormPanel.open(config);
    }
  });

  // Register Delete Connection command (Requirements 5.1–5.4)
  const deleteConnectionCmd = vscode.commands.registerCommand('sqlServer.deleteConnection', (node) => {
    return contextMenuHandler.deleteConnection(node);
  });

  // Register Duplicate Connection command (Requirements 5.5, 5.6)
  const duplicateConnectionCmd = vscode.commands.registerCommand('sqlServer.duplicateConnection', (node) => {
    return contextMenuHandler.duplicateConnection(node);
  });

  // Register context menu commands
  const selectTop100Cmd = vscode.commands.registerCommand('sqlServer.selectTop100', (node) => {
    return contextMenuHandler.selectTop100(node);
  });

  const copyObjectNameCmd = vscode.commands.registerCommand('sqlServer.copyObjectName', (node) => {
    return contextMenuHandler.copyObjectName(node);
  });

  const newQueryCmd = vscode.commands.registerCommand('sqlServer.newQuery', (node) => {
    return contextMenuHandler.newQuery(node);
  });

  const refreshNodeCmd = vscode.commands.registerCommand('sqlServer.refreshNode', (node) => {
    return contextMenuHandler.refreshNode(node);
  });

  // Register refreshConnections command — full tree refresh (Requirement 1.4)
  const refreshConnectionsCmd = vscode.commands.registerCommand('sqlServer.refreshConnections', () => {
    objectExplorerProvider.refresh();
  });

  // Register objectExplorerSearch command — opens an InputBox for filtering the Object Explorer tree (Requirements 1.1, 1.5, 1.7)
  const objectExplorerSearchCmd = vscode.commands.registerCommand('sqlServer.objectExplorerSearch', () => {
    const inputBox = vscode.window.createInputBox();
    inputBox.placeholder = 'Search Object Explorer (min 2 characters)';
    inputBox.title = 'Search Object Explorer';

    let accepted = false;

    inputBox.onDidChangeValue((value) => {
      objectExplorerProvider.setSearchTerm(value);
    });

    inputBox.onDidAccept(() => {
      accepted = true;
      // Keep the current filter applied; close the input box
      inputBox.hide();
    });

    inputBox.onDidHide(() => {
      if (!accepted) {
        // User dismissed (Escape) without accepting — clear the search filter
        objectExplorerProvider.setSearchTerm('');
      }
      inputBox.dispose();
    });

    inputBox.show();
  });

  // Register showResults command — used by ContextMenuHandler.selectTop100 to display results
  const showResultsCmd = vscode.commands.registerCommand('sqlServer.showResults', (result) => {
    resultPanelProvider!.show(result);
  });

  // Register openTablePreview command — opens Table Preview for a table/view node (Requirements 1.1, 1.10)
  const openTablePreviewCmd = vscode.commands.registerCommand('sqlServer.openTablePreview', (node: TableNode | ViewNode) => {
    if (node && tablePreviewManager) {
      tablePreviewManager.openPreview(node);
    }
  });

  // Register toggleResultDisplayMode command — toggles between single/split display mode (Requirements 5.4, 5.5)
  const toggleResultDisplayModeCmd = vscode.commands.registerCommand('sqlServer.toggleResultDisplayMode', () => {
    const config = vscode.workspace.getConfiguration('sqlServer.results');
    const currentMode = config.get<string>('displayMode', 'single');
    const newMode = currentMode === 'single' ? 'split' : 'single';
    config.update('displayMode', newMode, vscode.ConfigurationTarget.Global);
  });

  // Register Keyboard Shortcut command — QuickPick listing all extension shortcuts (Requirements 6.1–6.6)
  const keyboardShortcutDisposable = registerKeyboardShortcutCommand(context);
  context.subscriptions.push(keyboardShortcutDisposable);

  // Register Connection Diagnostics command — dumps driver detection info to Output panel
  const diagCmd = vscode.commands.registerCommand('sqlServer.diagnoseConnection', () => {
    runConnectionDiagnostics(outputChannel);
  });
  context.subscriptions.push(diagCmd);

  // --- Editor Connection Indicator (Requirements 6.1, 6.2, 6.3, 6.4) ---
  editorConnectionIndicator = new EditorConnectionIndicator(connectionManager.onConnectionChanged);

  // --- Connection Color Indicator (Requirements 6.1, 6.2, 6.3) ---
  connectionColorIndicator = new ConnectionColorIndicator(connectionManager.onConnectionChanged);
  context.subscriptions.push(connectionColorIndicator);

  // --- Export Manager and Commands (Requirements 7.1, 8.1, 9.1, 10.1, 11.1, 12.1) ---
  const exportManager = new ExportManager();

  const exportCsvCmd = vscode.commands.registerCommand('sqlServer.exportCsv', () => {
    const resultSet = resultPanelProvider?.getActiveResultSet();
    if (resultSet) { exportManager.exportResults('csv', resultSet); }
  });

  const exportJsonCmd = vscode.commands.registerCommand('sqlServer.exportJson', () => {
    const resultSet = resultPanelProvider?.getActiveResultSet();
    if (resultSet) { exportManager.exportResults('json', resultSet); }
  });

  const exportExcelCmd = vscode.commands.registerCommand('sqlServer.exportExcel', () => {
    const resultSet = resultPanelProvider?.getActiveResultSet();
    if (resultSet) { exportManager.exportResults('excel', resultSet); }
  });

  const exportInsertCmd = vscode.commands.registerCommand('sqlServer.exportInsert', () => {
    const resultSet = resultPanelProvider?.getActiveResultSet();
    if (resultSet) { exportManager.exportResults('insert', resultSet); }
  });

  const exportCreateInsertCmd = vscode.commands.registerCommand('sqlServer.exportCreateInsert', () => {
    const resultSet = resultPanelProvider?.getActiveResultSet();
    if (resultSet) { exportManager.exportResults('createInsert', resultSet); }
  });

  const copyAsTextCmd = vscode.commands.registerCommand('sqlServer.copyAsText', () => {
    const resultSet = resultPanelProvider?.getActiveResultSet();
    if (resultSet) { exportManager.exportResults('text', resultSet); }
  });

  const copyAsMarkdownCmd = vscode.commands.registerCommand('sqlServer.copyAsMarkdown', () => {
    const resultSet = resultPanelProvider?.getActiveResultSet();
    if (resultSet) { exportManager.exportResults('markdown', resultSet); }
  });

  // Register switchServer and switchDatabase commands (Requirements 7.1–7.5)
  const switchServerCmd = vscode.commands.registerCommand('sqlServer.switchServer', () => {
    return switchServer(connectionManager!, errorCategoryHandler);
  });

  const switchDatabaseCmd = vscode.commands.registerCommand('sqlServer.switchDatabase', () => {
    return switchDatabase(connectionManager!, errorCategoryHandler);
  });

  // Add Object Explorer and new feature disposables to context.subscriptions
  context.subscriptions.push(
    treeView,
    addConnectionCmd,
    removeConnectionCmd,
    addConnectionGroupCmd,
    removeConnectionGroupCmd,
    assignToGroupCmd,
    editConnectionCmd,
    deleteConnectionCmd,
    duplicateConnectionCmd,
    codeLensRegistration,
    codeLensProvider,
    goToDefinitionCmd,
    definitionProviderRegistration,
    definitionContentProvider,
    historyTreeRegistration,
    ...historyDisposables,
    exportCsvCmd,
    exportJsonCmd,
    exportExcelCmd,
    exportInsertCmd,
    exportCreateInsertCmd,
    copyAsTextCmd,
    copyAsMarkdownCmd,
    searchPanelRegistration,
    searchCacheInvalidationDisposable,
    { dispose: () => historyProvider?.dispose() },
    { dispose: () => objectExplorerConnectionManager?.dispose() },
    { dispose: () => searchPanelProvider?.dispose() }
  );

  // Register commands BEFORE starting the language client
  // so commands are available even if the server fails to start
  const runQueryCmd = vscode.commands.registerCommand('sqlServer.runQuery', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active editor. Open a SQL file to run a query.');
      return;
    }

    const editorUri = editor.document.uri.toString();

    // Prevent duplicate execution if already running (Requirement 3.4)
    if (executionStateManager!.getState(editorUri) !== 'idle') {
      return;
    }

    // Check for active connection; prompt if none
    let pool = connectionManager!.getActiveConnection();
    if (!pool) {
      const connected = await promptForConnection();
      if (!connected) {
        return;
      }
      pool = connectionManager!.getActiveConnection();
      if (!pool) {
        return;
      }
    }

    // Get selected text or full editor content
    const selection = editor.selection;
    const sql = selection.isEmpty
      ? editor.document.getText()
      : editor.document.getText(selection);

    if (!sql.trim()) {
      vscode.window.showWarningMessage('No SQL text to execute.');
      return;
    }

    // Variable detection pre-execution hook (Requirements 3.5, 4.1, 4.4, 4.5)
    let queryText = sql;
    const detectionResults = detectAllUndeclaredVariables(queryText);
    if (detectionResults.length > 0) {
      // Flatten undeclared variables from all batches
      const allUndeclared = detectionResults.flatMap(r => r.undeclaredVariables);
      const values = await promptForVariableValues(allUndeclared);
      if (values === undefined) {
        // User cancelled — abort execution
        return;
      }
      // Prepend DECLARE statements to the query text
      queryText = generateDeclareStatements(values) + '\n' + queryText;
    }

    // Destructive query guard — check for dangerous statements before execution (Requirements 8.1–8.4, 9.1–9.3)
    const documentStartLine = selection.isEmpty ? 0 : selection.start.line;
    const guardResult = await checkBeforeExecution(sql, documentStartLine);
    if (!guardResult.proceed) {
      return; // User cancelled — don't modify result panel
    }

    // Transition to executing state with cancel function (Requirement 3.1)
    executionStateManager!.startExecution(editorUri, () => {
      queryExecutor!.cancel();
    });

    // Show progress indicator in the new bottom panel
    resultPanelProvider!.showProgress();

    // Show running state in query status indicator (Requirement 5.6)
    queryStatusIndicator!.showRunning();
    const queryStartTime = Date.now();

    // Build connection metadata for history recording
    const activeConfig = connectionManager!.getActiveConfig();
    const connectionMeta: ConnectionMeta | undefined = activeConfig ? {
      connectionName: activeConfig.name,
      databaseName: activeConfig.database || 'master',
      serverHost: activeConfig.host,
    } : undefined;

    try {
      // Execute the query
      const result = await queryExecutor!.execute(queryText, pool, connectionMeta);

      // Check if execution was cancelled (either via state manager or result flag)
      const wasCancelled = executionStateManager!.getState(editorUri) === 'canceling' || result.cancelled;
      if (wasCancelled) {
        queryStatusIndicator!.showCancelled(Date.now() - queryStartTime);
      } else {
        queryStatusIndicator!.showResult(result);

        // Display results in the new ResultPanelProvider (bottom panel)
        // Use showWithPagination to compute total row count for large result sets
        await resultPanelProvider!.showWithPagination(result, queryText, pool);
      }

      // Refresh query history tree to show the new record
      historyProvider.refresh();
    } finally {
      // Transition back to idle (Requirement 3.5)
      executionStateManager!.completeExecution(editorUri);
    }
  });

  const cancelQueryCmd = vscode.commands.registerCommand('sqlServer.cancelQuery', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('No active editor.');
      return;
    }

    const editorUri = editor.document.uri.toString();
    const state = executionStateManager!.getState(editorUri);

    if (state === 'executing') {
      // Compute elapsed time BEFORE requesting cancel so status feedback is immediate
      const startTime = executionStateManager!.getStartTime(editorUri);
      const elapsedMs = startTime ? Date.now() - startTime : 0;

      // Transition to canceling — calls the stored cancelFn (Requirement 3.2)
      executionStateManager!.requestCancel(editorUri);

      // Immediate UI feedback: status indicator + result panel (Requirement 5.3)
      queryStatusIndicator!.showCancelled(elapsedMs);
      resultPanelProvider!.showCancellation();
    } else if (state === 'idle') {
      vscode.window.showInformationMessage('No query is currently executing.');
    }
    // If state is 'canceling', treat as no-op (Requirement 3.7)
  });

  const switchConnectionCmd = vscode.commands.registerCommand('sqlServer.switchConnection', async () => {
    await promptForConnection();
  });

  const disconnectCmd = vscode.commands.registerCommand('sqlServer.disconnect', async () => {
    if (!connectionManager!.getActiveConfig()) {
      vscode.window.showInformationMessage('No active SQL Server connection.');
      return;
    }

    await connectionManager!.disconnect();
    connectionManager!.fireConnectionChanged();
    vscode.window.showInformationMessage('Disconnected from SQL Server.');
  });

  // Register retryConnection command — re-attempts connection with provided config (Requirements 2.3, 2.7)
  const retryConnectionCmd = vscode.commands.registerCommand('sqlServer.retryConnection', async (config: ConnectionConfig) => {
    if (!connectionManager || !config) {
      return;
    }

    try {
      await connectionManager.disconnect();
      await connectionManager.connect(config);
      connectionManager.fireConnectionChanged();
      vscode.window.showInformationMessage(`Connected to "${config.name}".`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await errorCategoryHandler!.handleConnectionError(error, config);
    }
  });

  // Register reenterCredentials command — prompts for new credentials and retries (Requirement 2.5)
  const reenterCredentialsCmd = vscode.commands.registerCommand('sqlServer.reenterCredentials', async (config: ConnectionConfig) => {
    if (!connectionManager || !config) {
      return;
    }

    const user = await vscode.window.showInputBox({
      prompt: 'Enter username',
      value: config.user || '',
      placeHolder: 'Username',
    });
    if (user === undefined) {
      return;
    }

    const password = await vscode.window.showInputBox({
      prompt: 'Enter password',
      password: true,
      placeHolder: 'Password',
    });
    if (password === undefined) {
      return;
    }

    const updatedConfig: ConnectionConfig = { ...config, user, password };

    try {
      await connectionManager.disconnect();
      await connectionManager.connect(updatedConfig);
      connectionManager.fireConnectionChanged();
      vscode.window.showInformationMessage(`Connected to "${updatedConfig.name}".`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await errorCategoryHandler!.handleConnectionError(error, updatedConfig);
    }
  });

  const refreshSchemaCmd = vscode.commands.registerCommand('sqlServer.refreshSchema', async () => {
    if (!client) {
      vscode.window.showWarningMessage('Language server is not running.');
      return;
    }

    try {
      await client.sendRequest('sqlServer/refreshSchema', {});
      vscode.window.showInformationMessage('Schema cache refreshed.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to refresh schema: ${message}`);
    }
  });

  // Wire onConnectionChanged event — update status bar and notify language server
  const connectionChangedDisposable = connectionManager.onConnectionChanged((config: ConnectionConfig | null) => {
    // Update status bar (fallback for non-SQL files, Requirement 11.5)
    statusBar!.update(config);

    // Send notification to language server
    if (client) {
      client.sendNotification('sqlServer/connectionChanged', { config });
    }
  });

  // --- Execution State → Context Key + StatementCodeLensProvider wiring (Requirements 3.1–3.9) ---
  // Note: statementCodeLensProvider is instantiated below; the event handler captures it via closure
  // and will only fire after the activate() function completes setup.
  let statementCodeLensProvider: StatementCodeLensProvider | undefined;

  const executionStateChangedDisposable = executionStateManager.onStateChanged(({ uri, state }) => {
    // Set context key for the active editor (Requirement 3.4)
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.uri.toString() === uri) {
      vscode.commands.executeCommand('setContext', 'sqlServer.editorExecuting', state !== 'idle');
    }

    // Wire state changes to StatementCodeLensProvider (Requirement 3.8)
    if (statementCodeLensProvider) {
      if (state === 'idle') {
        statementCodeLensProvider.setExecutingStatement(uri, null);
      }
      // Note: setExecutingStatement for 'executing' is called from the run command
      // with the specific boundary; here we only clear on idle
    }
  });

  // Update context key when active editor changes (per-editor state tracking)
  const activeEditorChangedDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) {
      const editorUri = editor.document.uri.toString();
      const state = executionStateManager!.getState(editorUri);
      vscode.commands.executeCommand('setContext', 'sqlServer.editorExecuting', state !== 'idle');
    } else {
      vscode.commands.executeCommand('setContext', 'sqlServer.editorExecuting', false);
    }
  });

  // Handle editor/document close — remove execution state entry (Requirement 3.9)
  const documentClosedDisposable = vscode.workspace.onDidCloseTextDocument((document) => {
    const uri = document.uri.toString();
    executionStateManager!.removeEditor(uri);
  });

  // Wire onDidChangeConfiguration to apply setting changes at runtime (Requirement 4.9)
  const configurationChangedDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('sqlServer')) {
      // Notify ResultPanelProvider of display mode changes (Requirements 5.4, 5.5)
      if (e.affectsConfiguration('sqlServer.results.displayMode') && resultPanelProvider) {
        const config = vscode.workspace.getConfiguration('sqlServer.results');
        const mode = config.get<string>('displayMode', 'single');
        resultPanelProvider.setDisplayMode(mode as 'single' | 'split');
      }

      // Update TablePreviewManager when defaultRowLimit changes (Requirement 1.8)
      if (e.affectsConfiguration('sqlServer.defaultRowLimit') && tablePreviewManager) {
        tablePreviewManager.updateDefaultRowLimit();
      }
    }
  });

  // --- Statement Outline & Inline Actions (Requirements 7.1–7.12) ---
  statementCodeLensProvider = new StatementCodeLensProvider();
  const statementOutlineDecorator = new StatementOutlineDecorator();

  // Register StatementCodeLensProvider for SQL language
  const statementCodeLensRegistration = vscode.languages.registerCodeLensProvider(
    { language: 'sql' },
    statementCodeLensProvider
  );

  // Set initial connection state
  statementCodeLensProvider!.setConnectionActive(connectionManager!.getActiveConnection() !== null);

  // Wire connectionManager.onConnectionChanged to update statementCodeLensProvider
  const statementConnectionDisposable = connectionManager!.onConnectionChanged((config) => {
    statementCodeLensProvider!.setConnectionActive(config !== null);
  });

  // --- Statement boundaries tracking (per-editor) ---
  const statementBoundariesMap = new Map<string, StatementBoundary[]>();

  // Debounce timer for document change re-parsing (300ms)
  let statementParseTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Parses the given editor's document and updates boundaries for
   * the CodeLens provider and outline decorator.
   */
  function parseAndUpdateStatements(editor: vscode.TextEditor): void {
    const boundaries = parseStatements(editor.document.getText());
    const uri = editor.document.uri.toString();
    statementBoundariesMap.set(uri, boundaries);
    statementCodeLensProvider!.setBoundaries(boundaries);
    statementOutlineDecorator.updateBoundaries(editor, boundaries);
    const cursorLine = editor.selection.active.line;
    statementOutlineDecorator.updateCursorPosition(editor, cursorLine);
  }

  // Wire document open events — parse immediately when a SQL document is opened (Bug 1 fix)
  const statementDocOpenDisposable = vscode.workspace.onDidOpenTextDocument((document) => {
    if (document.languageId !== 'sql') {
      return;
    }

    // Find the editor for this document and parse immediately
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document === document
    );
    if (editor) {
      parseAndUpdateStatements(editor);
    }
  });

  // Wire document change events with 300ms debounce (Requirement 7.9)
  const statementDocChangeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.languageId !== 'sql') {
      return;
    }

    if (statementParseTimer) {
      clearTimeout(statementParseTimer);
    }

    statementParseTimer = setTimeout(() => {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document === event.document) {
        parseAndUpdateStatements(editor);
      }
    }, 300);
  });

  // Wire cursor position changes to update outline decoration (Requirement 7.2)
  const statementCursorDisposable = vscode.window.onDidChangeTextEditorSelection((event) => {
    const editor = event.textEditor;
    if (editor.document.languageId !== 'sql') {
      return;
    }
    const cursorLine = editor.selection.active.line;
    statementOutlineDecorator.updateCursorPosition(editor, cursorLine);
  });

  // Wire active editor change — parse document when switching to a SQL file
  const statementActiveEditorDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor && editor.document.languageId === 'sql') {
      parseAndUpdateStatements(editor);
    }
  });

  // Wire visible editors change — parse any newly visible SQL editors (Bug 1 fix: split view)
  const statementVisibleEditorsDisposable = vscode.window.onDidChangeVisibleTextEditors((editors) => {
    for (const editor of editors) {
      if (editor.document.languageId === 'sql') {
        const uri = editor.document.uri.toString();
        if (!statementBoundariesMap.has(uri)) {
          parseAndUpdateStatements(editor);
        }
      }
    }
  });

  // Parse the currently active editor on activation (if it's SQL)
  if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.languageId === 'sql') {
    parseAndUpdateStatements(vscode.window.activeTextEditor);
  }

  // Parse all visible SQL editors on activation (handles split view / workspace restore)
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.languageId === 'sql' && editor !== vscode.window.activeTextEditor) {
      const uri = editor.document.uri.toString();
      if (!statementBoundariesMap.has(uri)) {
        parseAndUpdateStatements(editor);
      }
    }
  }

  // Register `sqlServer.runCurrentStatement` command (Requirements 7.3, 7.4, 7.5)
  const runCurrentStatementCmd = vscode.commands.registerCommand('sqlServer.runCurrentStatement', async (boundaryArg?: StatementBoundary) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
      vscode.window.showInformationMessage('No active SQL editor.');
      return;
    }

    const editorUri = editor.document.uri.toString();

    // Prevent duplicate execution if already running
    if (executionStateManager!.getState(editorUri) !== 'idle') {
      return;
    }

    // Determine the statement to execute
    let boundary: StatementBoundary | null = boundaryArg || null;
    if (!boundary) {
      const boundaries = statementBoundariesMap.get(editorUri);
      if (boundaries) {
        const cursorLine = editor.selection.active.line;
        boundary = findStatementAtCursor(boundaries, cursorLine);
      }
    }

    if (!boundary) {
      vscode.window.showInformationMessage('No statement found at cursor position.');
      return;
    }

    // Check for active connection
    let pool = connectionManager!.getActiveConnection();
    if (!pool) {
      const connected = await promptForConnection();
      if (!connected) {
        return;
      }
      pool = connectionManager!.getActiveConnection();
      if (!pool) {
        return;
      }
    }

    // Set the executing statement on the CodeLens provider (Requirement 3.8)
    statementCodeLensProvider!.setExecutingStatement(editorUri, boundary);

    // Variable detection pre-execution hook (Requirements 3.5, 4.1, 4.4, 4.5)
    let stmtQueryText = boundary.text;
    const stmtDetectionResults = detectAllUndeclaredVariables(stmtQueryText);
    if (stmtDetectionResults.length > 0) {
      // Flatten undeclared variables from all batches
      const allUndeclared = stmtDetectionResults.flatMap(r => r.undeclaredVariables);
      const values = await promptForVariableValues(allUndeclared);
      if (values === undefined) {
        // User cancelled — abort execution
        statementCodeLensProvider!.setExecutingStatement(editorUri, null);
        return;
      }
      // Prepend DECLARE statements to the query text
      stmtQueryText = generateDeclareStatements(values) + '\n' + stmtQueryText;
    }

    // Destructive query guard — check for dangerous statements before execution (Requirements 8.1–8.4, 9.1–9.3)
    const stmtGuardResult = await checkBeforeExecution(boundary.text, boundary.startLine);
    if (!stmtGuardResult.proceed) {
      statementCodeLensProvider!.setExecutingStatement(editorUri, null);
      return; // User cancelled — don't modify result panel
    }

    // Transition to executing state
    executionStateManager!.startExecution(editorUri, () => {
      queryExecutor!.cancel();
    });

    // Show progress
    resultPanelProvider!.showProgress();

    // Show running state in query status indicator (Requirement 5.6)
    queryStatusIndicator!.showRunning();
    const stmtStartTime = Date.now();

    // Build connection metadata for history recording
    const stmtActiveConfig = connectionManager!.getActiveConfig();
    const stmtConnectionMeta: ConnectionMeta | undefined = stmtActiveConfig ? {
      connectionName: stmtActiveConfig.name,
      databaseName: stmtActiveConfig.database || 'master',
      serverHost: stmtActiveConfig.host,
    } : undefined;

    try {
      const result = await queryExecutor!.execute(stmtQueryText, pool, stmtConnectionMeta);

      // Check if execution was cancelled (either via state manager or result flag)
      const wasCancelled = executionStateManager!.getState(editorUri) === 'canceling' || result.cancelled;
      if (wasCancelled) {
        queryStatusIndicator!.showCancelled(Date.now() - stmtStartTime);
      } else {
        queryStatusIndicator!.showResult(result);

        await resultPanelProvider!.showWithPagination(result, stmtQueryText, pool);
      }

      // Refresh query history tree to show the new record
      historyProvider.refresh();
    } finally {
      // Transition back to idle
      executionStateManager!.completeExecution(editorUri);
      statementCodeLensProvider!.setExecutingStatement(editorUri, null);
    }
  });

  // Register `sqlServer.cancelCurrentStatement` command (Requirement 7.5)
  const cancelCurrentStatementCmd = vscode.commands.registerCommand('sqlServer.cancelCurrentStatement', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const editorUri = editor.document.uri.toString();
    const state = executionStateManager!.getState(editorUri);

    if (state === 'executing') {
      // Compute elapsed time BEFORE requesting cancel so status feedback is immediate
      const startTime = executionStateManager!.getStartTime(editorUri);
      const elapsedMs = startTime ? Date.now() - startTime : 0;

      executionStateManager!.requestCancel(editorUri);

      // Immediate UI feedback: status indicator + result panel (Requirement 5.3)
      queryStatusIndicator!.showCancelled(elapsedMs);
      resultPanelProvider!.showCancellation();
    }
  });

  // --- Execution Plan Visualizer (Requirements 6.1–6.9) ---
  executionPlanPanel = new ExecutionPlanPanel(context.extensionUri);

  const showExecutionPlanCmd = vscode.commands.registerCommand('sqlServer.showExecutionPlan', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active editor. Open a SQL file to show an execution plan.');
      return;
    }

    const editorUri = editor.document.uri.toString();

    // Requirement 6.9: If a query is already executing, no-op
    if (executionStateManager!.getState(editorUri) !== 'idle') {
      return;
    }

    // Requirement 6.6: Check for active connection → error if none
    const pool = connectionManager!.getActiveConnection();
    if (!pool) {
      vscode.window.showErrorMessage('No active SQL Server connection. Connect to a server before requesting an execution plan.');
      return;
    }

    // Requirement 6.2: Get selected text or full document
    const selection = editor.selection;
    const sql = selection.isEmpty
      ? editor.document.getText()
      : editor.document.getText(selection);

    // Requirement 6.7: Check for empty/whitespace query text
    if (!sql.trim()) {
      vscode.window.showWarningMessage('No SQL text to generate an execution plan.');
      return;
    }

    // Requirement 6.3: Wrap query with SET SHOWPLAN_XML ON / OFF
    const wrappedQuery = `SET SHOWPLAN_XML ON;\n${sql}\nSET SHOWPLAN_XML OFF;`;

    // Execute wrapped query to get execution plan XML
    executionStateManager!.startExecution(editorUri, () => {
      queryExecutor!.cancel();
    });

    try {
      const result = await queryExecutor!.execute(wrappedQuery, pool);

      // The execution plan XML is typically in the first column of the first row of the first recordset
      if (result.error) {
        // Requirement 6.5: Display server error in Result Panel
        resultPanelProvider!.show(result);
        return;
      }

      // Extract the XML from the result set
      let xmlString = '';
      if (result.resultSets.length > 0 && result.resultSets[0].rows.length > 0) {
        xmlString = String(result.resultSets[0].rows[0][0] || '');
      }

      if (!xmlString) {
        vscode.window.showErrorMessage('No execution plan XML returned from the server.');
        return;
      }

      // Parse the XML
      const parsedPlan = parseExecutionPlanXml(xmlString);

      if (parsedPlan.success) {
        // Requirement 6.4: Show in ExecutionPlanPanel
        executionPlanPanel!.show(parsedPlan);
      } else {
        // Requirement 7.7/7.9: Display error
        vscode.window.showErrorMessage(`Failed to parse execution plan: ${parsedPlan.error}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Execution plan request failed: ${message}`);
    } finally {
      executionStateManager!.completeExecution(editorUri);
    }
  });

  // --- Schema Diagram (FK relationship visualizer) ---
  schemaDiagramPanel = new SchemaDiagramPanel(context.extensionUri);

  // Pass schema diagram panel reference to context menu handler
  contextMenuHandler.setSchemaDiagramPanel(schemaDiagramPanel);

  const showSchemaDiagramCmd = vscode.commands.registerCommand('sqlServer.showSchemaDiagram', async (node?: any) => {
    if (!node || node.kind !== 'database') {
      vscode.window.showWarningMessage('Right-click a database in the Object Explorer to show a schema diagram.');
      return;
    }
    return contextMenuHandler.showSchemaDiagram(node);
  });

  const showTableDiagramCmd = vscode.commands.registerCommand('sqlServer.showTableDiagram', async (node?: any) => {
    if (!node || node.kind !== 'table') {
      vscode.window.showWarningMessage('Right-click a table in the Object Explorer to show a table diagram.');
      return;
    }
    return contextMenuHandler.showTableDiagram(node);
  });

  const showSchemaScopedDiagramCmd = vscode.commands.registerCommand('sqlServer.showSchemaScopedDiagram', async (node?: any) => {
    if (!node || node.kind !== 'table') {
      vscode.window.showWarningMessage('Right-click a table in the Object Explorer to show a schema diagram.');
      return;
    }
    return contextMenuHandler.showSchemaScopedDiagram(node);
  });

  // --- Find References in Workspace (Requirements 3.1, 3.2, 3.3, 3.4, 3.7, 3.8, 3.9, 3.10) ---
  const referenceFinder = new ReferenceFinder();

  const findReferencesInWorkspaceCmd = vscode.commands.registerCommand('sqlServer.findReferencesInWorkspace', async (node?: any) => {
    // Requirement 3.9: Check for open workspace folder
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      vscode.window.showWarningMessage('A workspace folder must be open to search for references.');
      return;
    }

    if (!node) {
      vscode.window.showWarningMessage('Right-click a table, view, or column in the Object Explorer to find references.');
      return;
    }

    // Resolve object name, type, and parent from tree node (Requirement 3.10)
    let objectName: string;
    let objectType: 'table' | 'view' | 'column';
    let parentObjectName: string | undefined;

    if (node.kind === 'table') {
      objectName = node.tableName;
      objectType = 'table';
    } else if (node.kind === 'view') {
      objectName = node.viewName;
      objectType = 'view';
    } else if (node.kind === 'column') {
      objectName = node.columnName;
      objectType = 'column';
      parentObjectName = node.parentObjectName;
    } else {
      vscode.window.showWarningMessage('Find References is only available for table, view, and column nodes.');
      return;
    }

    // Requirement 3.4: Show progress notification during search
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Searching for references to "${objectName}"...`,
        cancellable: false,
      },
      async () => {
        const matches = await referenceFinder.findReferences({
          objectName,
          objectType,
          parentObjectName,
        });

        if (matches.length === 0) {
          // Requirement 3.4: Show info message when zero results
          vscode.window.showInformationMessage(`No references found in workspace for ${objectName}`);
          return;
        }

        // Requirement 3.3: Display results in VS Code References panel (peek view)
        const locations = matches.map(m => new vscode.Location(m.uri, m.range));
        await vscode.commands.executeCommand(
          'editor.action.showReferences',
          matches[0].uri,
          matches[0].range.start,
          locations
        );
      }
    );
  });

  // --- Rename in Workspace (Requirement 4.1) ---
  const renameRefactorHandler = new RenameRefactorHandler();

  const renameInWorkspaceCmd = vscode.commands.registerCommand('sqlServer.renameInWorkspace', async (node?: any) => {
    // Check for open workspace folder
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      vscode.window.showWarningMessage('A workspace folder must be open to rename references.');
      return;
    }

    if (!node) {
      vscode.window.showWarningMessage('Right-click a table, view, or column in the Object Explorer to rename references.');
      return;
    }

    // Resolve object name, type, and parent from tree node
    let objectName: string;
    let objectType: 'table' | 'view' | 'column';
    let parentObjectName: string | undefined;

    if (node.kind === 'table') {
      objectName = node.tableName;
      objectType = 'table';
    } else if (node.kind === 'view') {
      objectName = node.viewName;
      objectType = 'view';
    } else if (node.kind === 'column') {
      objectName = node.columnName;
      objectType = 'column';
      parentObjectName = node.parentObjectName;
    } else {
      vscode.window.showWarningMessage('Rename in Workspace is only available for table, view, and column nodes.');
      return;
    }

    // Show progress while searching for references
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Searching for references to "${objectName}"...`,
        cancellable: false,
      },
      async () => {
        const matches = await referenceFinder.findReferences({
          objectName,
          objectType,
          parentObjectName,
        });

        if (matches.length === 0) {
          vscode.window.showInformationMessage(`No references found in workspace for ${objectName}`);
          return;
        }

        // Invoke rename with found matches
        await renameRefactorHandler.performRename(objectName, matches);
      }
    );
  });

  // --- Batch Navigator (GO-separated batch CodeLens + Document Symbols) (Requirements 1.1, 2.3) ---
  const batchNavigatorProvider = new BatchNavigatorProvider();
  const batchCodeLensDisposable = vscode.languages.registerCodeLensProvider(
    { language: 'sql' },
    batchNavigatorProvider
  );
  const batchSymbolDisposable = vscode.languages.registerDocumentSymbolProvider(
    { language: 'sql' },
    batchNavigatorProvider
  );
  const batchQuickPickCmd = vscode.commands.registerCommand(
    'sqlServer.batchNavigator.showQuickPick',
    (document: vscode.TextDocument) => batchNavigatorProvider.showBatchQuickPick(document)
  );

  // --- Schema Diff Commands (Requirements 5.1, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9) ---
  const schemaDiffDisposables = registerSchemaDiffCommands(objectExplorerConnectionManager!, context.extensionUri);

  // --- Generate ALTER Script Command (Requirements 7.1, 7.8, 7.13) ---
  const generateAlterScriptCmd = vscode.commands.registerCommand(
    'sqlServer.generateAlterScript',
    async (diff: SchemaDiff | undefined, includeDrops: boolean = false) => {
      let script: string;

      if (!diff) {
        script = '-- No schema differences detected';
      } else {
        const generator = new AlterScriptGenerator();
        const result = generator.generate(diff, { includeDropStatements: includeDrops });
        script = result.trim().length === 0
          ? '-- No schema differences detected'
          : result;
      }

      const document = await vscode.workspace.openTextDocument({ content: script, language: 'sql' });
      await vscode.window.showTextDocument(document);
    }
  );

  // Push all disposables to context.subscriptions
  context.subscriptions.push(
    runQueryCmd,
    cancelQueryCmd,
    switchConnectionCmd,
    disconnectCmd,
    retryConnectionCmd,
    reenterCredentialsCmd,
    refreshSchemaCmd,
    connectionChangedDisposable,
    executionStateChangedDisposable,
    activeEditorChangedDisposable,
    documentClosedDisposable,
    configurationChangedDisposable,
    resultPanelRegistration,
    selectTop100Cmd,
    copyObjectNameCmd,
    newQueryCmd,
    refreshNodeCmd,
    refreshConnectionsCmd,
    objectExplorerSearchCmd,
    showResultsCmd,
    openTablePreviewCmd,
    toggleResultDisplayModeCmd,
    switchServerCmd,
    switchDatabaseCmd,
    outputChannel,
    statementCodeLensRegistration,
    statementConnectionDisposable,
    statementDocOpenDisposable,
    statementDocChangeDisposable,
    statementCursorDisposable,
    statementActiveEditorDisposable,
    statementVisibleEditorsDisposable,
    runCurrentStatementCmd,
    cancelCurrentStatementCmd,
    showExecutionPlanCmd,
    showSchemaDiagramCmd,
    showTableDiagramCmd,
    showSchemaScopedDiagramCmd,
    findReferencesInWorkspaceCmd,
    renameInWorkspaceCmd,
    batchCodeLensDisposable,
    batchSymbolDisposable,
    batchQuickPickCmd,
    batchNavigatorProvider,
    ...schemaDiffDisposables,
    generateAlterScriptCmd,
    { dispose: () => statementCodeLensProvider?.dispose() },
    { dispose: () => statementOutlineDecorator?.dispose() },
    { dispose: () => { if (statementParseTimer) { clearTimeout(statementParseTimer); } } },
    { dispose: () => errorCategoryHandler?.dispose() },
    { dispose: () => statusBar?.dispose() },
    { dispose: () => resultPanelProvider?.dispose() },
    { dispose: () => editorConnectionIndicator?.dispose() },
    { dispose: () => connectionManager?.dispose() },
    { dispose: () => executionStateManager?.dispose() },
    { dispose: () => tablePreviewManager?.dispose() },
    { dispose: () => queryStatusIndicator?.dispose() },
    { dispose: () => executionPlanPanel?.dispose() },
    { dispose: () => schemaDiagramPanel?.dispose() }
  );

  // Start the language client AFTER commands are registered
  // so commands work even if the server fails to start
  try {
    await client.start();

    // Register handler for definition content from the language server.
    // The server sends this notification before returning a Location for Go to Definition,
    // so the DefinitionContentProvider has the content ready when VS Code opens the document.
    client.onNotification('sqlServer/definitionContent', (params: { uri: string; source: string }) => {
      // Parse and re-serialize the URI to ensure the key matches what VS Code will use
      // when calling provideTextDocumentContent
      const parsedUri = vscode.Uri.parse(params.uri);
      setDefinitionContent(parsedUri.toString(), params.source);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showWarningMessage(`SQL Server language server failed to start: ${message}. IntelliSense will be unavailable.`);
    client = undefined;
  }
}

export async function deactivate(): Promise<void> {
  // Stop the language client
  if (client) {
    await client.stop();
    client = undefined;
  }

  // Disconnect from database
  if (connectionManager) {
    await connectionManager.disconnect();
    connectionManager = undefined;
  }

  // Dispose Object Explorer connection manager
  if (objectExplorerConnectionManager) {
    objectExplorerConnectionManager.dispose();
    objectExplorerConnectionManager = undefined;
  }

  // Dispose new components
  if (resultPanelProvider) {
    resultPanelProvider.dispose();
    resultPanelProvider = undefined;
  }

  if (editorConnectionIndicator) {
    editorConnectionIndicator.dispose();
    editorConnectionIndicator = undefined;
  }

  if (connectionColorIndicator) {
    connectionColorIndicator.dispose();
    connectionColorIndicator = undefined;
  }

  if (statusBar) {
    statusBar.dispose();
    statusBar = undefined;
  }

  if (executionStateManager) {
    executionStateManager.dispose();
    executionStateManager = undefined;
  }

  if (tablePreviewManager) {
    tablePreviewManager.dispose();
    tablePreviewManager = undefined;
  }

  if (errorCategoryHandler) {
    errorCategoryHandler.dispose();
    errorCategoryHandler = undefined;
  }

  if (queryStatusIndicator) {
    queryStatusIndicator.dispose();
    queryStatusIndicator = undefined;
  }

  if (executionPlanPanel) {
    executionPlanPanel.dispose();
    executionPlanPanel = undefined;
  }

  if (schemaDiagramPanel) {
    schemaDiagramPanel.dispose();
    schemaDiagramPanel = undefined;
  }

  queryExecutor = undefined;
}

/**
 * Shows a quick pick list of available connections and connects to the selected one.
 * Returns true if a connection was successfully established.
 */
async function promptForConnection(): Promise<boolean> {
  if (!connectionManager) {
    return false;
  }

  const connections = connectionManager.loadConnections();

  if (connections.length === 0) {
    vscode.window.showWarningMessage(
      'No SQL Server connections configured. Add connections to .sql-connections.json in your workspace root.'
    );
    return false;
  }

  const items: vscode.QuickPickItem[] = connections.map(conn => ({
    label: conn.name,
    description: conn.database || 'master',
    detail: `${conn.host}:${conn.port ?? 1433}`,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a SQL Server connection',
  });

  if (!selected) {
    return false;
  }

  try {
    await connectionManager.switchConnection(selected.label);
    return connectionManager.getActiveConnection() !== null;
  } catch (err) {
    // Use categorized error handling if available
    if (errorCategoryHandler) {
      const config = connectionManager.loadConnections().find(c => c.name === selected.label);
      if (config) {
        const error = err instanceof Error ? err : new Error(String(err));
        await errorCategoryHandler.handleConnectionError(error, config);
      }
    }
    return false;
  }
}
