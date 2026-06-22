// src/sqlSearchPanelProvider.ts

import * as vscode from 'vscode';
import { SqlSearchService, SearchRequest, SearchResult, validateSearchTerm } from './sqlSearchService';
import { ObjectExplorerConnectionManager } from './objectExplorer/objectExplorerConnectionManager';
import { openDefinitionEditor } from './definitionCommand';
import {
  SearchWebviewToExtensionMessage,
  SearchExtensionToWebviewMessage,
  SearchExecuteMessage,
  OpenDefinitionMessage,
  GetDatabasesMessage,
  GetSchemasMessage,
  FilterChangedMessage,
  ScopeChangedMessage,
  SystemDbChangedMessage,
} from './sqlSearchProtocol';

export class SqlSearchPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'sqlObjectSearch';

  private view?: vscode.WebviewView;
  private pendingMessages: SearchExtensionToWebviewMessage[] = [];
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly searchService: SqlSearchService,
    private readonly connectionManager: ObjectExplorerConnectionManager,
    private readonly workspaceState: vscode.Memento
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getWebviewHtml();

    // Wire up message handler
    const messageDisposable = webviewView.webview.onDidReceiveMessage(
      (message: SearchWebviewToExtensionMessage) => this.handleWebviewMessage(message)
    );
    this.disposables.push(messageDisposable);

    // Flush pending messages
    for (const msg of this.pendingMessages) {
      webviewView.webview.postMessage(msg);
    }
    this.pendingMessages = [];

    // Restore persisted state to the webview
    this.restorePersistedState();

    // Dispose listener when the view is disposed
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
  }

  private async handleWebviewMessage(message: SearchWebviewToExtensionMessage): Promise<void> {
    switch (message.type) {
      case 'search':
        await this.handleSearch(message);
        break;
      case 'cancel':
        this.searchService.cancel();
        break;
      case 'openDefinition':
        await this.handleOpenDefinition(message);
        break;
      case 'getConnections':
        await this.handleGetConnections();
        break;
      case 'getDatabases':
        await this.handleGetDatabases(message);
        break;
      case 'getSchemas':
        await this.handleGetSchemas(message);
        break;
      case 'filterChanged':
        this.handleFilterChanged(message);
        break;
      case 'scopeChanged':
        this.handleScopeChanged(message);
        break;
      case 'systemDbChanged':
        this.handleSystemDbChanged(message);
        break;
    }
  }

  private async handleSearch(message: SearchExecuteMessage): Promise<void> {
    // Validate search term
    const validation = validateSearchTerm(message.searchTerm);
    if (!validation.valid) {
      this.postMessage({ type: 'validationError', message: validation.message! });
      return;
    }

    try {
      const request: SearchRequest = {
        searchTerm: message.searchTerm,
        objectTypes: message.objectTypes,
        scope: message.scope,
        includeSystemDatabases: message.includeSystemDatabases,
      };

      const result = await this.searchService.search(request, (progress) => {
        this.postMessage({
          type: 'progress',
          databasesCompleted: progress.databasesCompleted,
          databasesTotal: progress.databasesTotal,
          currentDatabase: progress.currentDatabase,
        });
      });

      this.postMessage({
        type: 'results',
        result,
        searchTerm: message.searchTerm,
      });
    } catch (err: any) {
      this.postMessage({
        type: 'error',
        message: err.message || 'Search failed',
      });
    }
  }

  private async handleOpenDefinition(message: OpenDefinitionMessage): Promise<void> {
    const { connectionName, database, schema, objectName, objectType } = message;
    const qualifiedName = `${schema}.${objectName}`;

    try {
      const pool = await this.connectionManager.getPoolForDatabase(connectionName, database);

      let source: string | null = null;

      if (objectType === 'table') {
        source = await this.queryTableDefinition(pool, schema, objectName, qualifiedName);
      } else {
        source = await this.queryModuleDefinition(pool, schema, objectName);
      }

      if (source === null) {
        return; // Error messages already shown inside helper methods
      }

      await openDefinitionEditor(qualifiedName, source);
    } catch (err: any) {
      if (err?.message === '__timeout__') {
        vscode.window.showInformationMessage('Timed out retrieving definition');
      } else {
        vscode.window.showErrorMessage(`Failed to retrieve definition: ${err?.message || String(err)}`);
      }
    }
  }

  /**
   * Queries sys.sql_modules for procedure/view/function/trigger definitions.
   * Returns the definition text, or null if not found / encrypted / timed out.
   */
  private async queryModuleDefinition(
    pool: import('mssql').ConnectionPool,
    schema: string,
    objectName: string
  ): Promise<string | null> {
    const query = `
      SELECT m.definition
      FROM sys.sql_modules m
      JOIN sys.objects o ON m.object_id = o.object_id
      JOIN sys.schemas s ON o.schema_id = s.schema_id
      WHERE s.name = @schema AND o.name = @objectName
    `;

    const result = await this.executeWithTimeout(
      pool.request()
        .input('schema', schema)
        .input('objectName', objectName)
        .query(query),
      5000
    );

    if (!result.recordset || result.recordset.length === 0) {
      vscode.window.showInformationMessage('Object not found');
      return null;
    }

    const definition = result.recordset[0].definition;
    if (!definition) {
      vscode.window.showInformationMessage('Object is encrypted or definition not available');
      return null;
    }

    return definition;
  }

  /**
   * Queries sys.columns for table columns and builds a CREATE TABLE representation.
   * Returns the formatted DDL, or null if not found / timed out.
   */
  private async queryTableDefinition(
    pool: import('mssql').ConnectionPool,
    schema: string,
    objectName: string,
    qualifiedName: string
  ): Promise<string | null> {
    const query = `
      SELECT
        c.name AS column_name,
        t.name AS data_type,
        c.max_length,
        c.precision,
        c.scale,
        c.is_nullable,
        c.is_identity
      FROM sys.columns c
      JOIN sys.types t ON c.user_type_id = t.user_type_id
      WHERE c.object_id = OBJECT_ID(@qualifiedName)
      ORDER BY c.column_id
    `;

    const result = await this.executeWithTimeout(
      pool.request()
        .input('qualifiedName', `${schema}.${objectName}`)
        .query(query),
      5000
    );

    if (!result.recordset || result.recordset.length === 0) {
      vscode.window.showInformationMessage('Object not found');
      return null;
    }

    return this.buildCreateTableStatement(qualifiedName, result.recordset);
  }

  /**
   * Formats column metadata into a CREATE TABLE statement.
   */
  private buildCreateTableStatement(
    qualifiedName: string,
    columns: Array<{
      column_name: string;
      data_type: string;
      max_length: number;
      precision: number;
      scale: number;
      is_nullable: boolean;
      is_identity: boolean;
    }>
  ): string {
    const lines = columns.map((col) => {
      let typeDef = col.data_type;

      // Add length/precision info based on data type
      if (['varchar', 'nvarchar', 'char', 'nchar', 'varbinary', 'binary'].includes(col.data_type)) {
        const len = col.max_length === -1 ? 'MAX' : String(col.data_type.startsWith('n') ? col.max_length / 2 : col.max_length);
        typeDef += `(${len})`;
      } else if (['decimal', 'numeric'].includes(col.data_type)) {
        typeDef += `(${col.precision}, ${col.scale})`;
      } else if (col.data_type === 'float' && col.precision !== 53) {
        typeDef += `(${col.precision})`;
      }

      const nullable = col.is_nullable ? 'NULL' : 'NOT NULL';
      const identity = col.is_identity ? ' IDENTITY' : '';

      return `    [${col.column_name}] ${typeDef}${identity} ${nullable}`;
    });

    return `CREATE TABLE [${qualifiedName.replace('.', '].[')}] (\n${lines.join(',\n')}\n);`;
  }

  /**
   * Wraps a query promise with a 5-second timeout.
   * Throws an error with message '__timeout__' if the timeout is exceeded.
   */
  private async executeWithTimeout<T>(queryPromise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      queryPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('__timeout__')), timeoutMs)
      ),
    ]);
  }

  private async handleGetConnections(): Promise<void> {
    try {
      const connections = this.connectionManager.getConnections();
      this.postMessage({
        type: 'connectionsList',
        connections: connections.map(conn => ({ name: conn.name, host: conn.host }))
      });
    } catch {
      this.postMessage({ type: 'connectionsList', connections: [] });
    }
  }

  private async handleGetDatabases(message: GetDatabasesMessage): Promise<void> {
    try {
      const pool = await this.connectionManager.getPool(message.connectionName);
      const result = await this.executeWithTimeout(
        pool.request().query(`SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY name`),
        10000
      );
      const databases = result.recordset.map((row: any) => row.name);
      this.postMessage({ type: 'databasesList', databases });
    } catch (err: any) {
      this.postMessage({ type: 'error', message: `Failed to retrieve databases: ${err?.message || 'Unknown error'}` });
    }
  }

  private async handleGetSchemas(message: GetSchemasMessage): Promise<void> {
    try {
      const pool = await this.connectionManager.getPoolForDatabase(message.connectionName, message.database);
      const result = await this.executeWithTimeout(
        pool.request().query(`SELECT name FROM sys.schemas WHERE name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest') ORDER BY name`),
        10000
      );
      const schemas = result.recordset.map((row: any) => row.name);
      this.postMessage({ type: 'schemasList', schemas });
    } catch (err: any) {
      this.postMessage({ type: 'error', message: `Failed to retrieve schemas: ${err?.message || 'Unknown error'}` });
    }
  }

  private handleFilterChanged(message: FilterChangedMessage): void {
    this.workspaceState.update('sqlSearch.objectTypeFilter', message.objectTypes);
  }

  private handleScopeChanged(message: ScopeChangedMessage): void {
    this.workspaceState.update('sqlSearch.scope', message.scope);
  }

  private handleSystemDbChanged(message: SystemDbChangedMessage): void {
    this.workspaceState.update('sqlSearch.includeSystemDatabases', message.includeSystemDatabases);
  }

  private restorePersistedState(): void {
    const defaultObjectTypes = {
      procedures: true,
      views: true,
      functions: true,
      tables: true,
      triggers: true,
    };
    const defaultScope = { type: 'all' as const };

    const objectTypes = this.workspaceState.get<{
      procedures: boolean;
      views: boolean;
      functions: boolean;
      tables: boolean;
      triggers: boolean;
    }>('sqlSearch.objectTypeFilter', defaultObjectTypes);

    const scope = this.workspaceState.get<{
      type: 'all' | 'server' | 'database' | 'schema';
      connectionName?: string;
      database?: string;
      schema?: string;
    }>('sqlSearch.scope', defaultScope);

    const includeSystemDatabases = this.workspaceState.get<boolean>('sqlSearch.includeSystemDatabases', false);

    this.postMessage({
      type: 'restoreState',
      objectTypes,
      scope,
      includeSystemDatabases,
    });
  }

  /**
   * Posts a message to the webview. If the view has not yet been resolved,
   * queues the message to be sent once the view is available.
   */
  postMessage(message: SearchExtensionToWebviewMessage): void {
    if (this.view) {
      this.view.webview.postMessage(message);
    } else {
      this.pendingMessages.push(message);
    }
  }

  private getWebviewHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 8px;
      line-height: 1.4;
    }

    /* ─── Search Input Area ─────────────────────────────────── */

    .search-input-area {
      display: flex;
      gap: 4px;
      margin-bottom: 8px;
    }

    .search-input-area input[type="text"] {
      flex: 1;
      padding: 4px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 2px;
      outline: none;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }

    .search-input-area input[type="text"]:focus {
      border-color: var(--vscode-focusBorder);
    }

    .search-input-area input[type="text"]::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    .btn {
      padding: 4px 10px;
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .btn:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .btn-secondary:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .btn-cancel {
      display: none;
    }

    /* ─── Object Type Filters ───────────────────────────────── */

    .section-label {
      font-size: 11px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
      margin-top: 8px;
    }

    .filter-toggles {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 8px;
    }

    .filter-toggle {
      padding: 2px 8px;
      border: 1px solid var(--vscode-button-background);
      border-radius: 12px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: 11px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      user-select: none;
      transition: opacity 0.15s;
    }

    .filter-toggle.inactive {
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border-color: var(--vscode-input-border);
    }

    .filter-toggle:hover {
      opacity: 0.85;
    }

    /* ─── Scope Dropdowns ───────────────────────────────────── */

    .scope-section {
      margin-bottom: 8px;
    }

    .scope-row {
      display: flex;
      gap: 4px;
      margin-bottom: 4px;
    }

    .scope-row select {
      flex: 1;
      padding: 3px 6px;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 2px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      outline: none;
    }

    .scope-row select:focus {
      border-color: var(--vscode-focusBorder);
    }

    /* ─── System Databases Toggle ───────────────────────────── */

    .system-db-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 8px;
      font-size: 12px;
      color: var(--vscode-foreground);
    }

    .system-db-toggle input[type="checkbox"] {
      accent-color: var(--vscode-checkbox-background);
    }

    /* ─── Validation Message ────────────────────────────────── */

    .validation-message {
      display: none;
      padding: 4px 8px;
      margin-bottom: 8px;
      font-size: 12px;
      color: var(--vscode-inputValidation-warningForeground);
      background: var(--vscode-inputValidation-warningBackground);
      border: 1px solid var(--vscode-inputValidation-warningBorder);
      border-radius: 2px;
    }

    /* ─── Progress Indicator ────────────────────────────────── */

    .progress-indicator {
      display: none;
      padding: 6px 8px;
      margin-bottom: 8px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      border-left: 3px solid var(--vscode-progressBar-background);
      background: var(--vscode-editor-background);
    }

    /* ─── Results Container ─────────────────────────────────── */

    .results-container {
      margin-top: 4px;
    }

    .results-summary {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
      padding: 4px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .result-group {
      margin-bottom: 4px;
    }

    .result-group-header {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 3px 4px;
      cursor: pointer;
      font-weight: bold;
      font-size: 12px;
      color: var(--vscode-foreground);
      user-select: none;
    }

    .result-group-header:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .result-group-header .chevron {
      display: inline-block;
      transition: transform 0.15s;
    }

    .result-group-header .chevron.collapsed {
      transform: rotate(-90deg);
    }

    .result-item {
      display: flex;
      align-items: flex-start;
      padding: 3px 8px 3px 20px;
      cursor: pointer;
      font-size: 12px;
      gap: 6px;
    }

    .result-item:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .result-item-icon {
      flex-shrink: 0;
      width: 22px;
      height: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 600;
      border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .result-item-body {
      flex: 1;
      min-width: 0;
    }

    .result-item-name {
      color: var(--vscode-foreground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .result-item-context {
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 1px;
    }

    .match-highlight {
      background: var(--vscode-editor-findMatchHighlightBackground);
      border-radius: 1px;
    }

    .result-item-line {
      flex-shrink: 0;
      color: var(--vscode-editorLineNumber-foreground);
      font-size: 10px;
      padding-top: 2px;
      white-space: nowrap;
    }

    /* ─── Welcome Message ───────────────────────────────────── */

    .welcome-message {
      display: none;
      text-align: center;
      padding: 20px 10px;
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
    }

    .welcome-message a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      cursor: pointer;
    }

    .welcome-message a:hover {
      color: var(--vscode-textLink-activeForeground);
      text-decoration: underline;
    }

    /* ─── No Results Message ────────────────────────────────── */

    .no-results {
      display: none;
      text-align: center;
      padding: 16px 10px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    /* ─── Filter Changed Notice ─────────────────────────────── */

    .filter-changed-notice {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      padding: 2px 8px;
      margin-bottom: 4px;
      font-style: italic;
    }

    /* ─── Truncation Notice ─────────────────────────────────── */

    .truncation-notice {
      display: none;
      padding: 4px 8px;
      margin-bottom: 6px;
      font-size: 11px;
      color: var(--vscode-editorWarning-foreground);
      background: var(--vscode-inputValidation-warningBackground);
      border: 1px solid var(--vscode-inputValidation-warningBorder);
      border-radius: 2px;
    }

    /* ─── Cancelled Notice ──────────────────────────────────── */

    .cancelled-notice {
      display: none;
      padding: 4px 8px;
      margin-bottom: 6px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      border-left: 3px solid var(--vscode-inputValidation-warningBorder);
    }

    /* ─── Error Message ─────────────────────────────────────── */

    .error-message {
      display: none;
      padding: 6px 8px;
      margin-bottom: 8px;
      font-size: 12px;
      color: var(--vscode-inputValidation-errorForeground);
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      border-radius: 2px;
    }
  </style>
</head>
<body>
  <!-- Search Input Area -->
  <div class="search-input-area">
    <input
      type="text"
      id="searchInput"
      maxlength="128"
      placeholder="Search object definitions..."
      aria-label="Search term"
    />
    <button class="btn" id="searchBtn" disabled aria-label="Search">Search</button>
    <button class="btn btn-secondary btn-cancel" id="cancelBtn" aria-label="Cancel search">Cancel</button>
  </div>

  <!-- Validation Message -->
  <div class="validation-message" id="validationMsg"></div>

  <!-- Object Type Filters -->
  <div class="section-label">Object Types</div>
  <div class="filter-toggles" id="filterToggles">
    <span class="filter-toggle" data-type="procedures">Procedures</span>
    <span class="filter-toggle" data-type="views">Views</span>
    <span class="filter-toggle" data-type="functions">Functions</span>
    <span class="filter-toggle" data-type="tables">Tables</span>
    <span class="filter-toggle" data-type="triggers">Triggers</span>
  </div>

  <!-- Filter Changed Notice -->
  <div class="filter-changed-notice" id="filterChangedNotice" style="display:none;">
    Filters changed since last search
  </div>

  <!-- Scope Dropdowns -->
  <div class="section-label">Scope</div>
  <div class="scope-section">
    <div class="scope-row">
      <select id="serverDropdown" aria-label="Server">
        <option value="">All Connections</option>
      </select>
    </div>
    <div class="scope-row">
      <select id="databaseDropdown" aria-label="Database" disabled>
        <option value="">All Databases</option>
      </select>
    </div>
    <div class="scope-row">
      <select id="schemaDropdown" aria-label="Schema" disabled>
        <option value="">All Schemas</option>
      </select>
    </div>
  </div>

  <!-- System Databases Toggle -->
  <div class="system-db-toggle">
    <input type="checkbox" id="systemDbToggle" />
    <label for="systemDbToggle">Include system databases</label>
  </div>

  <!-- Progress Indicator -->
  <div class="progress-indicator" id="progressIndicator"></div>

  <!-- Error Message -->
  <div class="error-message" id="errorMsg"></div>

  <!-- Welcome Message -->
  <div class="welcome-message" id="welcomeMsg">
    <p>No connections configured.</p>
    <p style="margin-top: 8px;">
      <a href="command:sqlServer.addConnection">Add a connection</a> to start searching.
    </p>
  </div>

  <!-- Truncation Notice -->
  <div class="truncation-notice" id="truncationNotice">
    Results truncated at 500 matches. Try narrowing your scope or filters.
  </div>

  <!-- Cancelled Notice -->
  <div class="cancelled-notice" id="cancelledNotice"></div>

  <!-- No Results Message -->
  <div class="no-results" id="noResults">
    No objects matched your search term in the selected scope.
  </div>

  <!-- Results Container -->
  <div class="results-container" id="resultsContainer"></div>

  <script>
    (function() {
      const vscode = acquireVsCodeApi();

      // ─── DOM References ──────────────────────────────────────
      const searchInput = document.getElementById('searchInput');
      const searchBtn = document.getElementById('searchBtn');
      const cancelBtn = document.getElementById('cancelBtn');
      const validationMsg = document.getElementById('validationMsg');
      const filterToggles = document.getElementById('filterToggles');
      const serverDropdown = document.getElementById('serverDropdown');
      const databaseDropdown = document.getElementById('databaseDropdown');
      const schemaDropdown = document.getElementById('schemaDropdown');
      const systemDbToggle = document.getElementById('systemDbToggle');
      const progressIndicator = document.getElementById('progressIndicator');
      const errorMsg = document.getElementById('errorMsg');
      const welcomeMsg = document.getElementById('welcomeMsg');
      const truncationNotice = document.getElementById('truncationNotice');
      const cancelledNotice = document.getElementById('cancelledNotice');
      const noResults = document.getElementById('noResults');
      const resultsContainer = document.getElementById('resultsContainer');
      const filterChangedNotice = document.getElementById('filterChangedNotice');

      // ─── Local State ─────────────────────────────────────────
      let objectTypes = {
        procedures: true,
        views: true,
        functions: true,
        tables: true,
        triggers: true
      };
      let isSearching = false;
      let hasResults = false;
      let lastSearchObjectTypes = null;
      let pendingRestoreScope = null;

      // ─── Input Validation ────────────────────────────────────
      function getSearchTerm() {
        return searchInput.value;
      }

      function isValidTerm(term) {
        const nonWhitespace = term.replace(/\\s/g, '');
        return nonWhitespace.length >= 2 && term.length <= 128;
      }

      function updateSearchButtonState() {
        const term = getSearchTerm();
        const valid = isValidTerm(term);
        searchBtn.disabled = !valid;
      }

      searchInput.addEventListener('keyup', function() {
        updateSearchButtonState();
        // Hide validation message on edit
        validationMsg.style.display = 'none';
      });

      searchInput.addEventListener('input', function() {
        updateSearchButtonState();
      });

      searchInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          const term = getSearchTerm();
          if (isValidTerm(term)) {
            executeSearch();
          }
        }
      });

      // ─── Search Execution ────────────────────────────────────
      function getScope() {
        const server = serverDropdown.value;
        const database = databaseDropdown.value;
        const schema = schemaDropdown.value;

        if (schema) {
          return { type: 'schema', connectionName: server, database: database, schema: schema };
        } else if (database) {
          return { type: 'database', connectionName: server, database: database };
        } else if (server) {
          return { type: 'server', connectionName: server };
        }
        return { type: 'all' };
      }

      function executeSearch() {
        const term = getSearchTerm();

        // Client-side validation
        const nonWhitespace = term.replace(/\\s/g, '');
        if (nonWhitespace.length < 2) {
          showValidation('Enter at least 2 non-whitespace characters.');
          return;
        }
        if (term.length > 128) {
          showValidation('Search term must not exceed 128 characters.');
          return;
        }

        // Check at least one object type is enabled
        const anyEnabled = Object.values(objectTypes).some(v => v);
        if (!anyEnabled) {
          showValidation('Select at least one object type.');
          return;
        }

        hideMessages();
        setSearchingState(true);

        // Save a copy of the current filters used for this search
        lastSearchObjectTypes = Object.assign({}, objectTypes);
        filterChangedNotice.style.display = 'none';

        vscode.postMessage({
          type: 'search',
          searchTerm: term,
          objectTypes: objectTypes,
          scope: getScope(),
          includeSystemDatabases: systemDbToggle.checked
        });
      }

      searchBtn.addEventListener('click', function() {
        executeSearch();
      });

      cancelBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'cancel' });
        setSearchingState(false);
      });

      function setSearchingState(searching) {
        isSearching = searching;
        cancelBtn.style.display = searching ? 'inline-block' : 'none';
        searchBtn.style.display = searching ? 'none' : 'inline-block';
        progressIndicator.style.display = searching ? 'block' : 'none';
        if (searching) {
          progressIndicator.textContent = 'Starting search...';
        }
      }

      // ─── Filter Toggles ─────────────────────────────────────
      const toggleBtns = filterToggles.querySelectorAll('.filter-toggle');
      toggleBtns.forEach(function(btn) {
        btn.addEventListener('click', function() {
          const type = btn.dataset.type;
          objectTypes[type] = !objectTypes[type];
          btn.classList.toggle('inactive', !objectTypes[type]);
          vscode.postMessage({ type: 'filterChanged', objectTypes: objectTypes });

          // Check if all filters are disabled
          const anyEnabled = Object.values(objectTypes).some(function(v) { return v; });
          if (!anyEnabled) {
            filterChangedNotice.textContent = 'Select at least one object type to search';
            filterChangedNotice.style.display = 'block';
          } else if (hasResults && lastSearchObjectTypes) {
            // Compare current filters to last-search filters
            const filtersChanged = Object.keys(objectTypes).some(function(key) {
              return objectTypes[key] !== lastSearchObjectTypes[key];
            });
            if (filtersChanged) {
              filterChangedNotice.textContent = 'Filters changed since last search';
              filterChangedNotice.style.display = 'block';
            } else {
              filterChangedNotice.style.display = 'none';
            }
          } else {
            filterChangedNotice.style.display = 'none';
          }
        });
      });

      // ─── Scope Dropdowns ────────────────────────────────────
      serverDropdown.addEventListener('change', function() {
        const value = serverDropdown.value;
        // Reset child dropdowns
        databaseDropdown.innerHTML = '<option value="">All Databases</option>';
        databaseDropdown.disabled = true;
        schemaDropdown.innerHTML = '<option value="">All Schemas</option>';
        schemaDropdown.disabled = true;

        if (value) {
          vscode.postMessage({ type: 'getDatabases', connectionName: value });
        }
        vscode.postMessage({ type: 'scopeChanged', scope: getScope() });
      });

      databaseDropdown.addEventListener('change', function() {
        const db = databaseDropdown.value;
        const server = serverDropdown.value;
        // Reset schema dropdown
        schemaDropdown.innerHTML = '<option value="">All Schemas</option>';
        schemaDropdown.disabled = true;

        if (db && server) {
          vscode.postMessage({ type: 'getSchemas', connectionName: server, database: db });
        }
        vscode.postMessage({ type: 'scopeChanged', scope: getScope() });
      });

      schemaDropdown.addEventListener('change', function() {
        vscode.postMessage({ type: 'scopeChanged', scope: getScope() });
      });

      // ─── System Databases Toggle ────────────────────────────
      systemDbToggle.addEventListener('change', function() {
        vscode.postMessage({ type: 'systemDbChanged', includeSystemDatabases: systemDbToggle.checked });
      });

      // ─── Message Handling from Extension Host ────────────────
      window.addEventListener('message', function(event) {
        const message = event.data;
        switch (message.type) {
          case 'results':
            handleResults(message);
            break;
          case 'progress':
            handleProgress(message);
            break;
          case 'error':
            handleError(message);
            break;
          case 'connectionsList':
            handleConnectionsList(message);
            break;
          case 'databasesList':
            handleDatabasesList(message);
            break;
          case 'schemasList':
            handleSchemasList(message);
            break;
          case 'validationError':
            handleValidationError(message);
            break;
          case 'restoreState':
            handleRestoreState(message);
            break;
        }
      });

      function handleResults(message) {
        setSearchingState(false);
        hideMessages();
        hasResults = true;

        const result = message.result;
        const searchTerm = message.searchTerm;

        if (result.truncated) {
          truncationNotice.style.display = 'block';
        }

        if (result.cancelled) {
          const notSearched = result.databasesTotal - result.databasesSearched;
          cancelledNotice.textContent = 'Search cancelled. ' + notSearched + ' database(s) were not searched.';
          cancelledNotice.style.display = 'block';
        }

        if (result.items.length === 0) {
          noResults.style.display = 'block';
          resultsContainer.innerHTML = '';
          return;
        }

        // Display summary
        const durationSec = (result.durationMs / 1000).toFixed(1);
        const summary = result.totalCount + ' result' + (result.totalCount !== 1 ? 's' : '') +
          ' in ' + result.databasesSearched + ' database' + (result.databasesSearched !== 1 ? 's' : '') +
          ' (' + durationSec + 's)';

        // Group results: connection → database → objectType
        const groups = groupResults(result.items);
        let html = '<div class="results-summary">' + escapeHtml(summary) + '</div>';
        html += renderGroups(groups, searchTerm);
        resultsContainer.innerHTML = html;

        // Attach click handlers for result items
        resultsContainer.querySelectorAll('[data-result-index]').forEach(function(el) {
          el.addEventListener('click', function() {
            const idx = parseInt(el.dataset.resultIndex, 10);
            const item = result.items[idx];
            if (item) {
              vscode.postMessage({
                type: 'openDefinition',
                connectionName: item.connectionName,
                database: item.database,
                schema: item.schema,
                objectName: item.objectName,
                objectType: item.objectType
              });
            }
          });
        });

        // Attach chevron collapse handlers
        resultsContainer.querySelectorAll('.result-group-header').forEach(function(header) {
          header.addEventListener('click', function() {
            const chevron = header.querySelector('.chevron');
            const body = header.nextElementSibling;
            if (body) {
              const isHidden = body.style.display === 'none';
              body.style.display = isHidden ? '' : 'none';
              chevron.classList.toggle('collapsed', !isHidden);
            }
          });
        });
      }

      function groupResults(items) {
        const groups = {};
        items.forEach(function(item, index) {
          const connKey = item.connectionName;
          const dbKey = item.database;
          const typeKey = item.objectType;
          if (!groups[connKey]) { groups[connKey] = {}; }
          if (!groups[connKey][dbKey]) { groups[connKey][dbKey] = {}; }
          if (!groups[connKey][dbKey][typeKey]) { groups[connKey][dbKey][typeKey] = []; }
          groups[connKey][dbKey][typeKey].push({ item: item, index: index });
        });
        return groups;
      }

      function renderGroups(groups, searchTerm) {
        let html = '';
        const connKeys = Object.keys(groups).sort();
        connKeys.forEach(function(conn) {
          html += '<div class="result-group">';
          html += '<div class="result-group-header"><span class="chevron">&#9660;</span> ' + escapeHtml(conn) + '</div>';
          html += '<div class="result-group-body">';
          const dbKeys = Object.keys(groups[conn]).sort();
          dbKeys.forEach(function(db) {
            html += '<div class="result-group" style="padding-left:12px;">';
            html += '<div class="result-group-header"><span class="chevron">&#9660;</span> ' + escapeHtml(db) + '</div>';
            html += '<div class="result-group-body">';
            const typeKeys = Object.keys(groups[conn][db]).sort();
            typeKeys.forEach(function(type) {
              const typeLabel = type.charAt(0).toUpperCase() + type.slice(1) + 's';
              html += '<div class="result-group" style="padding-left:12px;">';
              html += '<div class="result-group-header"><span class="chevron">&#9660;</span> ' + escapeHtml(typeLabel) + '</div>';
              html += '<div class="result-group-body">';
              const entries = groups[conn][db][type];
              entries.sort(function(a, b) {
                const nameA = a.item.schema + '.' + a.item.objectName;
                const nameB = b.item.schema + '.' + b.item.objectName;
                return nameA.localeCompare(nameB);
              });
              entries.forEach(function(entry) {
                const item = entry.item;
                const qualifiedName = '[' + item.schema + '].[' + item.objectName + ']';
                const context = renderMatchContext(item.matchContext, item.matchStartIndex, item.matchLength);
                const tooltip = conn + ' \\u2192 ' + db + ' \\u2192 ' + item.schema + '.' + item.objectName;
                html += '<div class="result-item" data-result-index="' + entry.index + '" title="' + escapeAttr(tooltip) + '">';
                html += '<span class="result-item-name">' + escapeHtml(qualifiedName) + '<span class="result-line-number">:' + item.matchLine + '</span></span>';
                html += '<span class="result-item-context">' + context + '</span>';
                html += '</div>';
              });
              html += '</div></div>';
            });
            html += '</div></div>';
          });
          html += '</div></div>';
        });
        return html;
      }

      function renderMatchContext(context, startIndex, length) {
        if (!context) { return ''; }
        const before = escapeHtml(context.substring(0, startIndex));
        const match = escapeHtml(context.substring(startIndex, startIndex + length));
        const after = escapeHtml(context.substring(startIndex + length));
        return before + '<span class="match-highlight">' + match + '</span>' + after;
      }

      function handleProgress(message) {
        progressIndicator.style.display = 'block';
        progressIndicator.textContent = 'Searching database ' + message.databasesCompleted + ' of ' + message.databasesTotal + '... (' + escapeHtml(message.currentDatabase) + ')';
      }

      function handleError(message) {
        setSearchingState(false);
        errorMsg.textContent = message.message;
        errorMsg.style.display = 'block';
      }

      function handleConnectionsList(message) {
        const connections = message.connections;
        serverDropdown.innerHTML = '<option value="">All Connections</option>';
        if (connections.length === 0) {
          welcomeMsg.style.display = 'block';
        } else {
          welcomeMsg.style.display = 'none';
          connections.forEach(function(conn) {
            const option = document.createElement('option');
            option.value = conn.name;
            option.textContent = conn.name + ' (' + conn.host + ')';
            serverDropdown.appendChild(option);
          });
        }

        // Restore pending server selection if restoring state
        if (pendingRestoreScope && pendingRestoreScope.connectionName) {
          serverDropdown.value = pendingRestoreScope.connectionName;
          // Trigger database loading for the restored server
          vscode.postMessage({ type: 'getDatabases', connectionName: pendingRestoreScope.connectionName });
        }
      }

      function handleDatabasesList(message) {
        databaseDropdown.innerHTML = '<option value="">All Databases</option>';
        message.databases.forEach(function(db) {
          const option = document.createElement('option');
          option.value = db;
          option.textContent = db;
          databaseDropdown.appendChild(option);
        });
        databaseDropdown.disabled = false;

        // Restore pending database selection if restoring state
        if (pendingRestoreScope && pendingRestoreScope.database) {
          databaseDropdown.value = pendingRestoreScope.database;
          // Trigger schema loading for the restored database
          if (pendingRestoreScope.connectionName && pendingRestoreScope.database) {
            vscode.postMessage({ type: 'getSchemas', connectionName: pendingRestoreScope.connectionName, database: pendingRestoreScope.database });
          }
        }
      }

      function handleSchemasList(message) {
        schemaDropdown.innerHTML = '<option value="">All Schemas</option>';
        // Client-side fallback: exclude sys, INFORMATION_SCHEMA, and guest schemas
        const excludedSchemas = ['sys', 'INFORMATION_SCHEMA', 'guest'];
        message.schemas
          .filter(function(schema) { return excludedSchemas.indexOf(schema) === -1; })
          .forEach(function(schema) {
            const option = document.createElement('option');
            option.value = schema;
            option.textContent = schema;
            schemaDropdown.appendChild(option);
          });
        schemaDropdown.disabled = false;

        // Restore pending schema selection if restoring state
        if (pendingRestoreScope && pendingRestoreScope.schema) {
          schemaDropdown.value = pendingRestoreScope.schema;
        }
        // Clear pending restore scope — restoration complete
        pendingRestoreScope = null;
      }

      function handleValidationError(message) {
        setSearchingState(false);
        showValidation(message.message);
      }

      function handleRestoreState(message) {
        // Restore object type filters
        if (message.objectTypes) {
          objectTypes = message.objectTypes;
          toggleBtns.forEach(function(btn) {
            const type = btn.dataset.type;
            btn.classList.toggle('inactive', !objectTypes[type]);
          });
        }

        // Restore scope — store for deferred restoration when dropdown lists are populated
        if (message.scope) {
          pendingRestoreScope = message.scope;
          // If server dropdown is already populated (e.g. restoreState arrived after connectionsList),
          // apply immediately
          if (message.scope.connectionName && serverDropdown.options.length > 1) {
            serverDropdown.value = message.scope.connectionName;
            vscode.postMessage({ type: 'getDatabases', connectionName: message.scope.connectionName });
          }
        }

        // Restore system databases toggle
        if (typeof message.includeSystemDatabases === 'boolean') {
          systemDbToggle.checked = message.includeSystemDatabases;
        }
      }

      // ─── Helpers ─────────────────────────────────────────────
      function showValidation(msg) {
        validationMsg.textContent = msg;
        validationMsg.style.display = 'block';
      }

      function hideMessages() {
        validationMsg.style.display = 'none';
        errorMsg.style.display = 'none';
        noResults.style.display = 'none';
        truncationNotice.style.display = 'none';
        cancelledNotice.style.display = 'none';
        progressIndicator.style.display = 'none';
        filterChangedNotice.style.display = 'none';
      }

      function escapeHtml(str) {
        return String(str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      function escapeAttr(str) {
        return escapeHtml(str);
      }

      // ─── Initialization ─────────────────────────────────────
      // Request connections list on load
      vscode.postMessage({ type: 'getConnections' });
    })();
  </script>
</body>
</html>`;
  }

  /**
   * Invalidates cached search results for a connection that has changed.
   * Called when connection configuration is added, removed, or modified.
   */
  invalidateConnectionCache(connectionName: string): void {
    this.searchService.invalidateConnection(connectionName);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
