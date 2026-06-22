import * as vscode from 'vscode';
import * as mssql from 'mssql';
import { TablePreviewIdentifier, TablePreviewState, QueryResult, PreviewQueryParams } from './types';
import { buildPreviewQuery, buildTablePreviewId, arePreviewIdsEqual } from './previewQueryBuilder';
import { ObjectExplorerConnectionManager } from './objectExplorer/objectExplorerConnectionManager';
import { TableNode, ViewNode } from './objectExplorer/types';

/**
 * Messages sent from the extension host to the Table Preview webview.
 */
interface PreviewToWebviewMessage {
  type: 'data' | 'progress' | 'error';
  result?: QueryResult;
  error?: string;
  query?: string;
  state?: {
    filterText: string;
    sortColumn: string | null;
    sortDirection: 'ASC' | 'DESC';
  };
}

/**
 * Messages sent from the Table Preview webview to the extension host.
 */
interface PreviewFromWebviewMessage {
  type: 'applyFilter' | 'toggleSort' | 'editQuery' | 'retry';
  filterText?: string;
  columnName?: string;
}

/**
 * Internal state for each open Table Preview tab.
 */
interface TablePreviewTabState {
  identifier: TablePreviewIdentifier;
  panel: vscode.WebviewPanel;
  filterText: string;
  sortColumn: string | null;
  sortDirection: 'ASC' | 'DESC';
  rowLimit: number;
  lastSuccessfulResult: QueryResult | null;
  lastError: string | null;
}

/**
 * Public interface for the Table Preview Manager.
 */
export interface ITablePreviewManager {
  openPreview(node: TableNode | ViewNode): Promise<void>;
  applyFilter(id: TablePreviewIdentifier, filterText: string): Promise<void>;
  toggleSort(id: TablePreviewIdentifier, columnName: string): Promise<void>;
  editQuery(id: TablePreviewIdentifier): Promise<void>;
  dispose(): void;
}

/**
 * TablePreviewManager manages Table Preview tabs (WebviewPanels) for
 * previewing table/view data from Object Explorer. Each unique table
 * gets its own tab, keyed by TablePreviewIdentifier.
 */
export class TablePreviewManager implements ITablePreviewManager {
  private previews: Map<string, TablePreviewTabState> = new Map();

  constructor(
    private readonly connectionManager: ObjectExplorerConnectionManager,
    private readonly extensionUri: vscode.Uri
  ) {}

  /**
   * Opens a Table Preview for the given table or view node.
   * If a preview is already open for the same table, focuses it instead.
   */
  async openPreview(node: TableNode | ViewNode): Promise<void> {
    const identifier = this.extractIdentifier(node);
    const key = buildTablePreviewId(identifier);

    // Check if preview already open — focus it
    const existing = this.previews.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    // Read default row limit from settings
    const rowLimit = this.getRowLimit();

    // Create a new WebviewPanel
    const title = `[${identifier.schema}].[${identifier.objectName}]`;
    const panel = vscode.window.createWebviewPanel(
      'sqlServerTablePreview',
      title,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      }
    );

    const tabState: TablePreviewTabState = {
      identifier,
      panel,
      filterText: '',
      sortColumn: null,
      sortDirection: 'ASC',
      rowLimit,
      lastSuccessfulResult: null,
      lastError: null,
    };

    this.previews.set(key, tabState);

    // Set webview HTML
    panel.webview.html = this.getWebviewHtml(tabState);

    // Handle messages from webview
    panel.webview.onDidReceiveMessage((message: PreviewFromWebviewMessage) => {
      this.handleWebviewMessage(identifier, message);
    });

    // Handle panel disposal
    panel.onDidDispose(() => {
      this.previews.delete(key);
    });

    // Execute initial query
    await this.executePreviewQuery(tabState);
  }

  /**
   * Applies a filter to the preview identified by `id`.
   * Executes immediately — requires explicit user action (Enter key or Apply button).
   */
  async applyFilter(id: TablePreviewIdentifier, filterText: string): Promise<void> {
    const key = buildTablePreviewId(id);
    const tabState = this.previews.get(key);
    if (!tabState) {
      return;
    }

    tabState.filterText = filterText;
    await this.executePreviewQuery(tabState);
  }

  /**
   * Toggles the sort direction for the given column.
   * Cycle: null → ASC → DESC → null
   */
  async toggleSort(id: TablePreviewIdentifier, columnName: string): Promise<void> {
    const key = buildTablePreviewId(id);
    const tabState = this.previews.get(key);
    if (!tabState) {
      return;
    }

    if (tabState.sortColumn === columnName) {
      // Toggle direction: ASC → DESC → null
      if (tabState.sortDirection === 'ASC') {
        tabState.sortDirection = 'DESC';
      } else {
        // DESC → null (clear sort)
        tabState.sortColumn = null;
        tabState.sortDirection = 'ASC';
      }
    } else {
      // New column, start with ASC
      tabState.sortColumn = columnName;
      tabState.sortDirection = 'ASC';
    }

    await this.executePreviewQuery(tabState);
  }

  /**
   * Opens the current generated SQL query in a new untitled SQL editor document.
   */
  async editQuery(id: TablePreviewIdentifier): Promise<void> {
    const key = buildTablePreviewId(id);
    const tabState = this.previews.get(key);
    if (!tabState) {
      return;
    }

    const query = this.buildCurrentQuery(tabState);

    const doc = await vscode.workspace.openTextDocument({
      language: 'sql',
      content: query,
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  }

  /**
   * Disposes all open preview panels and clears state.
   */
  dispose(): void {
    for (const [, tabState] of this.previews) {
      tabState.panel.dispose();
    }
    this.previews.clear();
  }

  /**
   * Updates the default row limit for all open previews and re-executes their queries.
   * Called when `sqlServer.defaultRowLimit` setting changes at runtime.
   */
  updateDefaultRowLimit(): void {
    const newLimit = this.getRowLimit();
    for (const [, tabState] of this.previews) {
      if (tabState.rowLimit !== newLimit) {
        tabState.rowLimit = newLimit;
        this.executePreviewQuery(tabState);
      }
    }
  }

  /**
   * Extracts a TablePreviewIdentifier from a TableNode or ViewNode.
   */
  private extractIdentifier(node: TableNode | ViewNode): TablePreviewIdentifier {
    if (node.kind === 'table') {
      return {
        connectionName: node.connectionName,
        database: node.database,
        schema: node.schema,
        objectName: node.tableName,
      };
    } else {
      return {
        connectionName: node.connectionName,
        database: node.database,
        schema: node.schema,
        objectName: node.viewName,
      };
    }
  }

  /**
   * Reads the `sqlServer.defaultRowLimit` setting from workspace configuration.
   */
  private getRowLimit(): number {
    const config = vscode.workspace.getConfiguration('sqlServer');
    return config.get<number>('defaultRowLimit', 100);
  }

  /**
   * Builds the current SQL query string from the tab state.
   */
  private buildCurrentQuery(tabState: TablePreviewTabState): string {
    const params: PreviewQueryParams = {
      schema: tabState.identifier.schema,
      objectName: tabState.identifier.objectName,
      rowLimit: tabState.rowLimit,
      filterText: tabState.filterText || undefined,
      sortColumn: tabState.sortColumn || undefined,
      sortDirection: tabState.sortColumn ? tabState.sortDirection : undefined,
    };
    return buildPreviewQuery(params);
  }

  /**
   * Executes the preview query and sends results to the webview.
   * On error, preserves the last successful result and shows inline error.
   */
  private async executePreviewQuery(tabState: TablePreviewTabState): Promise<void> {
    // Send progress indicator
    this.postMessage(tabState, {
      type: 'progress',
      state: {
        filterText: tabState.filterText,
        sortColumn: tabState.sortColumn,
        sortDirection: tabState.sortDirection,
      },
    });

    const query = this.buildCurrentQuery(tabState);

    try {
      const pool = await this.connectionManager.getPoolForDatabase(
        tabState.identifier.connectionName,
        tabState.identifier.database
      );

      const result = await this.executeQuery(query, pool);

      if (result.error) {
        // Query returned an error (e.g., invalid filter)
        tabState.lastError = result.error.message;
        this.postMessage(tabState, {
          type: 'error',
          error: result.error.message,
          query,
          result: tabState.lastSuccessfulResult || undefined,
          state: {
            filterText: tabState.filterText,
            sortColumn: tabState.sortColumn,
            sortDirection: tabState.sortDirection,
          },
        });
      } else {
        // Success
        tabState.lastSuccessfulResult = result;
        tabState.lastError = null;
        this.postMessage(tabState, {
          type: 'data',
          result,
          query,
          state: {
            filterText: tabState.filterText,
            sortColumn: tabState.sortColumn,
            sortDirection: tabState.sortDirection,
          },
        });
      }
    } catch (err: any) {
      // Connection error or unexpected failure
      const errorMessage = err?.message || String(err);
      tabState.lastError = errorMessage;
      this.postMessage(tabState, {
        type: 'error',
        error: errorMessage,
        query,
        result: tabState.lastSuccessfulResult || undefined,
        state: {
          filterText: tabState.filterText,
          sortColumn: tabState.sortColumn,
          sortDirection: tabState.sortDirection,
        },
      });
    }
  }

  /**
   * Executes a SQL query against the given connection pool.
   */
  private async executeQuery(sql: string, pool: mssql.ConnectionPool): Promise<QueryResult> {
    const startTime = Date.now();
    const request = pool.request();
    request.multiple = true;

    try {
      const response = await request.query(sql);

      const resultSets = [];
      const recordsets = response.recordsets as mssql.IRecordSet<any>[];

      if (recordsets && recordsets.length > 0) {
        for (const recordset of recordsets) {
          const columns = this.extractColumns(recordset);
          const rows = this.extractRows(recordset, columns);
          resultSets.push({ columns, rows, rowCount: rows.length });
        }
      }

      let rowsAffected = 0;
      if (response.rowsAffected && Array.isArray(response.rowsAffected)) {
        for (const count of response.rowsAffected) {
          if (count >= 0) {
            rowsAffected += count;
          }
        }
      }

      return {
        resultSets,
        rowsAffected,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (err: any) {
      return {
        resultSets: [],
        rowsAffected: 0,
        executionTimeMs: Date.now() - startTime,
        error: {
          number: err?.number ?? 0,
          severity: err?.class ?? 0,
          message: err?.message || String(err),
        },
      };
    }
  }

  /**
   * Extracts column metadata from a recordset.
   */
  private extractColumns(recordset: mssql.IRecordSet<any>): { name: string; dataType: string }[] {
    const columns: { name: string; dataType: string }[] = [];
    if (recordset.columns) {
      for (const [name, col] of Object.entries(recordset.columns)) {
        columns.push({
          name,
          dataType: (col as any).type?.declaration ?? (col as any).type?.name ?? 'unknown',
        });
      }
    }
    return columns;
  }

  /**
   * Extracts row data from a recordset as arrays of values.
   */
  private extractRows(recordset: mssql.IRecordSet<any>, columns: { name: string; dataType: string }[]): any[][] {
    const rows: any[][] = [];
    for (let i = 0; i < recordset.length; i++) {
      const record = recordset[i];
      const row: any[] = columns.map(col => record[col.name]);
      rows.push(row);
    }
    return rows;
  }

  /**
   * Handles messages received from the Table Preview webview.
   */
  private handleWebviewMessage(identifier: TablePreviewIdentifier, message: PreviewFromWebviewMessage): void {
    switch (message.type) {
      case 'applyFilter':
        this.applyFilter(identifier, message.filterText || '');
        break;
      case 'toggleSort':
        if (message.columnName) {
          this.toggleSort(identifier, message.columnName);
        }
        break;
      case 'editQuery':
        this.editQuery(identifier);
        break;
      case 'retry':
        this.retryQuery(identifier);
        break;
    }
  }

  /**
   * Retries the last query for the given preview.
   */
  private async retryQuery(id: TablePreviewIdentifier): Promise<void> {
    const key = buildTablePreviewId(id);
    const tabState = this.previews.get(key);
    if (tabState) {
      await this.executePreviewQuery(tabState);
    }
  }

  /**
   * Posts a message to the webview panel.
   */
  private postMessage(tabState: TablePreviewTabState, message: PreviewToWebviewMessage): void {
    try {
      tabState.panel.webview.postMessage(message);
    } catch {
      // Panel may have been disposed
    }
  }

  /**
   * Returns the HTML content for the Table Preview webview.
   */
  private getWebviewHtml(tabState: TablePreviewTabState): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: var(--vscode-font-family, 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground, #cccccc);
      background-color: var(--vscode-editor-background, #1e1e1e);
      padding: 8px;
      overflow: auto;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      padding: 4px 0;
      border-bottom: 1px solid var(--vscode-panel-border, #444);
    }
    .filter-wrapper {
      flex: 1;
      position: relative;
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      background: var(--vscode-input-background, #3c3c3c);
      border-radius: 2px;
    }
    .filter-highlight {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      padding: 4px 8px;
      font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
      font-size: var(--vscode-editor-font-size, 12px);
      line-height: 1.4;
      white-space: nowrap;
      overflow: hidden;
      pointer-events: none;
      color: var(--vscode-input-foreground, #cccccc);
    }
    #filterInput {
      display: block;
      width: 100%;
      padding: 4px 8px;
      font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
      font-size: var(--vscode-editor-font-size, 12px);
      line-height: 1.4;
      color: transparent;
      caret-color: var(--vscode-foreground, #cccccc);
      background: transparent;
      border: none;
      outline: none;
      resize: none;
      overflow: hidden;
      white-space: nowrap;
      position: relative;
      z-index: 1;
    }
    #filterInput::placeholder {
      color: var(--vscode-input-placeholderForeground, #888);
    }
    .toolbar button {
      padding: 4px 10px;
      border: none;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #ffffff);
      cursor: pointer;
      border-radius: 2px;
      font-size: var(--vscode-font-size, 13px);
    }
    .toolbar button:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }
    .query-display {
      padding: 6px 8px;
      margin-bottom: 8px;
      background: var(--vscode-textBlockQuote-background, #2a2a2a);
      border-left: 3px solid var(--vscode-textLink-foreground, #3794ff);
      font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
      font-size: var(--vscode-editor-font-size, 12px);
      white-space: pre-wrap;
      word-break: break-all;
    }
    .error-banner {
      padding: 8px 12px;
      margin-bottom: 8px;
      background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
      border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
      border-radius: 2px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .error-banner .error-text {
      flex: 1;
    }
    .error-banner button {
      padding: 4px 10px;
      border: none;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #ffffff);
      cursor: pointer;
      border-radius: 2px;
      font-size: var(--vscode-font-size, 13px);
    }
    .message {
      padding: 16px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .message.progress {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid var(--vscode-foreground, #cccccc);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .table-container {
      overflow: auto;
      max-height: calc(100vh - 150px);
    }
    table {
      border-collapse: collapse;
      width: 100%;
      font-size: var(--vscode-editor-font-size, 12px);
      font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
    }
    th, td {
      border: 1px solid var(--vscode-panel-border, #444);
      padding: 4px 8px;
      text-align: left;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 300px;
    }
    th {
      background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
      position: sticky;
      top: 0;
      font-weight: 600;
      cursor: pointer;
      user-select: none;
    }
    th .sort-indicator {
      margin-left: 4px;
      opacity: 0.7;
    }
    .col-type {
      display: block;
      font-size: 0.85em;
      opacity: 0.7;
      font-weight: normal;
    }
    .null-value {
      opacity: 0.5;
      font-style: italic;
    }
    .row-count {
      margin-top: 4px;
      opacity: 0.8;
      font-size: 0.9em;
    }
    .status {
      margin-top: 4px;
      opacity: 0.7;
      font-size: 0.9em;
    }
    /* Autocomplete dropdown styles */
    .autocomplete-dropdown {
      display: none;
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      z-index: 1000;
      margin-top: 2px;
      max-height: calc(8 * 24px);
      overflow-y: auto;
      background: var(--vscode-editorSuggestWidget-background, #252526);
      border: 1px solid var(--vscode-editorSuggestWidget-border, #454545);
      border-radius: 2px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }
    .autocomplete-dropdown.flip-above {
      top: auto;
      bottom: 100%;
      margin-top: 0;
      margin-bottom: 2px;
    }
    .autocomplete-item {
      display: flex;
      align-items: center;
      padding: 4px 8px;
      cursor: pointer;
      height: 24px;
      color: var(--vscode-editorSuggestWidget-foreground, var(--vscode-foreground, #cccccc));
      white-space: nowrap;
      overflow: hidden;
    }
    .autocomplete-item.active {
      background: var(--vscode-editorSuggestWidget-selectedBackground, #04395e);
    }
    .autocomplete-item:hover {
      background: var(--vscode-editorSuggestWidget-selectedBackground, #04395e);
    }
    .autocomplete-item .detail {
      margin-left: auto;
      padding-left: 12px;
      font-size: 0.85em;
      opacity: 0.6;
      color: var(--vscode-editorSuggestWidget-foreground, var(--vscode-foreground, #cccccc));
    }
    /* SQL syntax highlighting token styles */
    .kw {
      color: var(--vscode-debugTokenExpression-keyword, #569cd6);
    }
    .str {
      color: var(--vscode-debugTokenExpression-string, #ce9178);
    }
    .num {
      color: var(--vscode-debugTokenExpression-number, #b5cea8);
    }
    .op {
      color: var(--vscode-foreground, #d4d4d4);
    }
    .cmt {
      color: var(--vscode-debugTokenExpression-name, #6a9955);
    }
    .fn {
      color: var(--vscode-debugTokenExpression-name, #dcdcaa);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="filter-wrapper">
      <div class="filter-highlight" id="filterHighlight"></div>
      <textarea id="filterInput" rows="1" placeholder="WHERE clause filter (e.g., column1 = 'value')"></textarea>
      <div class="autocomplete-dropdown" id="autocompleteDropdown"></div>
    </div>
    <button id="applyFilterBtn">Apply</button>
    <button id="editQueryBtn">Edit Query</button>
  </div>
  <div id="queryDisplay" class="query-display"></div>
  <div id="errorBanner" class="error-banner" style="display:none;">
    <span class="error-text" id="errorText"></span>
    <button id="retryBtn">Retry</button>
  </div>
  <div id="content">
    <div class="message progress"><div class="spinner"></div><p>Loading preview...</p></div>
  </div>
  <script>
    (function() {
      const vscode = acquireVsCodeApi();
      const contentEl = document.getElementById('content');
      const queryDisplayEl = document.getElementById('queryDisplay');
      const errorBannerEl = document.getElementById('errorBanner');
      const errorTextEl = document.getElementById('errorText');
      const filterInput = document.getElementById('filterInput');
      const applyFilterBtn = document.getElementById('applyFilterBtn');
      const editQueryBtn = document.getElementById('editQueryBtn');
      const retryBtn = document.getElementById('retryBtn');
      const filterHighlight = document.getElementById('filterHighlight');

      // --- SQL Syntax Highlighter (inlined for webview isolation) ---

      var SQL_KEYWORDS = ['SELECT','FROM','WHERE','JOIN','AND','OR','NOT','IN','LIKE',
        'BETWEEN','IS','NULL','AS','ON','INNER','LEFT','RIGHT','OUTER',
        'CROSS','TOP','ORDER','BY','GROUP','HAVING','INSERT','UPDATE',
        'DELETE','SET','INTO','VALUES','ASC','DESC','DISTINCT','CASE',
        'WHEN','THEN','ELSE','END'];
      var SQL_KEYWORDS_SET = {};
      for (var ki = 0; ki < SQL_KEYWORDS.length; ki++) {
        SQL_KEYWORDS_SET[SQL_KEYWORDS[ki]] = true;
      }

      var SQL_FUNCTIONS = ['COUNT','SUM','MAX','MIN','AVG','COALESCE','ISNULL','CAST',
        'CONVERT','GETDATE','LEN','SUBSTRING','UPPER','LOWER','DATEADD','DATEDIFF'];
      var SQL_FUNCTIONS_SET = {};
      for (var fi = 0; fi < SQL_FUNCTIONS.length; fi++) {
        SQL_FUNCTIONS_SET[SQL_FUNCTIONS[fi]] = true;
      }

      var SINGLE_CHAR_OPS = {'=':true,'>':true,'<':true,'+':true,'-':true,'*':true,'/':true,'%':true};

      // State constants (replaces const enum)
      var STATE_DEFAULT = 0;
      var STATE_STRING = 1;
      var STATE_LINE_COMMENT = 2;
      var STATE_BLOCK_COMMENT = 3;

      function hlEscape(text) {
        var result = '';
        for (var i = 0; i < text.length; i++) {
          var ch = text[i];
          switch (ch) {
            case '&': result += '&amp;'; break;
            case '<': result += '&lt;'; break;
            case '>': result += '&gt;'; break;
            case '"': result += '&quot;'; break;
            default: result += ch;
          }
        }
        return result;
      }

      function isDigit(ch) {
        return ch >= '0' && ch <= '9';
      }

      function isWordChar(ch) {
        return (ch >= 'a' && ch <= 'z') ||
               (ch >= 'A' && ch <= 'Z') ||
               (ch >= '0' && ch <= '9') ||
               ch === '_';
      }

      function highlightSql(sql) {
        if (!sql) {
          return '';
        }

        var output = '';
        var state = STATE_DEFAULT;
        var i = 0;
        var len = sql.length;
        var tokenBuffer = '';

        while (i < len) {
          var ch = sql[i];
          var next = i + 1 < len ? sql[i + 1] : '';

          switch (state) {
            case STATE_DEFAULT: {
              if (ch === '-' && next === '-') {
                state = STATE_LINE_COMMENT;
                tokenBuffer = '--';
                i += 2;
                break;
              }
              if (ch === '/' && next === '*') {
                state = STATE_BLOCK_COMMENT;
                tokenBuffer = '/*';
                i += 2;
                break;
              }
              if (ch === "'") {
                state = STATE_STRING;
                tokenBuffer = "'";
                i += 1;
                break;
              }
              if ((ch === '<' && next === '>') ||
                  (ch === '!' && next === '=') ||
                  (ch === '>' && next === '=') ||
                  (ch === '<' && next === '=')) {
                output += '<span class="op">' + hlEscape(ch + next) + '</span>';
                i += 2;
                break;
              }
              if (SINGLE_CHAR_OPS[ch]) {
                output += '<span class="op">' + hlEscape(ch) + '</span>';
                i += 1;
                break;
              }
              if (isDigit(ch) || (ch === '.' && next !== '' && isDigit(next))) {
                var numStr = '';
                var hasDot = false;
                while (i < len) {
                  var c = sql[i];
                  if (isDigit(c)) {
                    numStr += c;
                    i++;
                  } else if (c === '.' && !hasDot) {
                    hasDot = true;
                    numStr += c;
                    i++;
                  } else {
                    break;
                  }
                }
                output += '<span class="num">' + hlEscape(numStr) + '</span>';
                break;
              }
              if (isWordChar(ch) && !isDigit(ch)) {
                var word = '';
                while (i < len && isWordChar(sql[i])) {
                  word += sql[i];
                  i++;
                }
                var upper = word.toUpperCase();
                if (SQL_KEYWORDS_SET[upper]) {
                  output += '<span class="kw">' + hlEscape(word) + '</span>';
                } else if (SQL_FUNCTIONS_SET[upper]) {
                  output += '<span class="fn">' + hlEscape(word) + '</span>';
                } else {
                  output += hlEscape(word);
                }
                break;
              }
              output += hlEscape(ch);
              i += 1;
              break;
            }

            case STATE_STRING: {
              if (ch === "'") {
                if (next === "'") {
                  tokenBuffer += "''";
                  i += 2;
                } else {
                  tokenBuffer += "'";
                  output += '<span class="str">' + hlEscape(tokenBuffer) + '</span>';
                  tokenBuffer = '';
                  state = STATE_DEFAULT;
                  i += 1;
                }
              } else {
                tokenBuffer += ch;
                i += 1;
              }
              break;
            }

            case STATE_LINE_COMMENT: {
              if (ch === '\\n') {
                output += '<span class="cmt">' + hlEscape(tokenBuffer) + '</span>';
                output += hlEscape(ch);
                tokenBuffer = '';
                state = STATE_DEFAULT;
                i += 1;
              } else {
                tokenBuffer += ch;
                i += 1;
              }
              break;
            }

            case STATE_BLOCK_COMMENT: {
              if (ch === '*' && next === '/') {
                tokenBuffer += '*/';
                output += '<span class="cmt">' + hlEscape(tokenBuffer) + '</span>';
                tokenBuffer = '';
                state = STATE_DEFAULT;
                i += 2;
              } else {
                tokenBuffer += ch;
                i += 1;
              }
              break;
            }
          }
        }

        // Handle unterminated tokens at end of input
        if (tokenBuffer) {
          switch (state) {
            case STATE_STRING:
              output += '<span class="str">' + hlEscape(tokenBuffer) + '</span>';
              break;
            case STATE_LINE_COMMENT:
              output += '<span class="cmt">' + hlEscape(tokenBuffer) + '</span>';
              break;
            case STATE_BLOCK_COMMENT:
              output += '<span class="cmt">' + hlEscape(tokenBuffer) + '</span>';
              break;
          }
        }

        return output;
      }

      // --- End SQL Syntax Highlighter ---

      // --- Autocomplete Controller (inlined for webview isolation) ---

      // Constants
      var LOGICAL_CONNECTORS = { 'AND': true, 'OR': true, 'NOT': true };
      var COMPARISON_OPERATORS_SET = { '=': true, '<>': true, '>': true, '<': true, '>=': true, '<=': true };
      var WORD_OPERATORS = { 'LIKE': true, 'IN': true, 'BETWEEN': true };

      var WHERE_KEYWORDS = ['AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN', 'IS NULL', 'IS NOT NULL', 'EXISTS'];
      var AUTOCOMPLETE_FUNCTIONS = ['LEN', 'UPPER', 'LOWER', 'CAST', 'CONVERT', 'ISNULL', 'COALESCE', 'GETDATE', 'DATEADD', 'DATEDIFF'];
      var COMPARISON_OP_SUGGESTIONS = ['=', '<>', '>', '<', '>=', '<=', 'LIKE', 'NOT LIKE', 'IN', 'NOT IN', 'BETWEEN', 'IS NULL', 'IS NOT NULL'];
      var MAX_SUGGESTIONS = 10;

      // State
      var currentColumns = []; // Array of { name: string, dataType: string }
      var dropdownEl = document.getElementById('autocompleteDropdown');
      var dropdownVisible = false;
      var selectedIndex = -1;
      var currentItems = [];
      var prefixStart = 0;
      var blurTimeout = null;

      /**
       * Detects suggestion context based on text before cursor.
       * Returns: 'column-start' | 'after-column' | 'after-operator' | 'general'
       */
      function detectContext(text, cursorPos) {
        var textBeforeCursor = text.substring(0, cursorPos);
        var trimmed = textBeforeCursor.trimEnd();

        if (trimmed.length === 0) {
          return 'column-start';
        }

        var tokens = trimmed.split(/\\s+/);
        var lastToken = tokens[tokens.length - 1];
        var lastTokenUpper = lastToken.toUpperCase();

        // Check logical connectors → column-start
        if (LOGICAL_CONNECTORS[lastTokenUpper]) {
          return 'column-start';
        }

        // Check if last token matches a column name (case-insensitive)
        for (var ci = 0; ci < currentColumns.length; ci++) {
          if (currentColumns[ci].name.toUpperCase() === lastTokenUpper) {
            return 'after-column';
          }
        }

        // Check symbol-based comparison operators
        if (COMPARISON_OPERATORS_SET[lastToken]) {
          return 'after-operator';
        }

        // Check word-based operators
        if (WORD_OPERATORS[lastTokenUpper]) {
          return 'after-operator';
        }

        // Check multi-word operators ending: IS NULL, IS NOT NULL
        if (lastTokenUpper === 'NULL' && tokens.length >= 2) {
          var prevToken = tokens[tokens.length - 2].toUpperCase();
          if (prevToken === 'IS' || prevToken === 'NOT') {
            return 'column-start';
          }
        }

        return 'general';
      }

      /**
       * Finds the prefix start position — scans backward from cursorPos
       * to find where the current word/token starts.
       */
      function findPrefixStart(text, cursorPos) {
        var i = cursorPos - 1;
        while (i >= 0 && text[i] !== ' ' && text[i] !== '\\t') {
          i--;
        }
        return i + 1;
      }

      /**
       * Builds and filters suggestions based on context and typed prefix.
       */
      function getFilteredSuggestions(prefix, context) {
        // Dismiss when user types a literal value start in after-operator context
        if (context === 'after-operator' && prefix.length > 0) {
          var firstChar = prefix[0];
          if (firstChar === "'" || firstChar === '-' || (firstChar >= '0' && firstChar <= '9')) {
            return [];
          }
        }

        var candidates = [];

        if (context === 'column-start') {
          // Columns first, then keywords and functions
          for (var i = 0; i < currentColumns.length; i++) {
            candidates.push({ text: currentColumns[i].name, category: 'column', detail: currentColumns[i].dataType });
          }
          for (var i = 0; i < WHERE_KEYWORDS.length; i++) {
            candidates.push({ text: WHERE_KEYWORDS[i], category: 'keyword', detail: '' });
          }
          for (var i = 0; i < AUTOCOMPLETE_FUNCTIONS.length; i++) {
            candidates.push({ text: AUTOCOMPLETE_FUNCTIONS[i], category: 'function', detail: '' });
          }
        } else if (context === 'after-column') {
          // Only comparison operators
          for (var i = 0; i < COMPARISON_OP_SUGGESTIONS.length; i++) {
            candidates.push({ text: COMPARISON_OP_SUGGESTIONS[i], category: 'operator', detail: '' });
          }
        } else if (context === 'after-operator') {
          // Functions and column names
          for (var i = 0; i < AUTOCOMPLETE_FUNCTIONS.length; i++) {
            candidates.push({ text: AUTOCOMPLETE_FUNCTIONS[i], category: 'function', detail: '' });
          }
          for (var i = 0; i < currentColumns.length; i++) {
            candidates.push({ text: currentColumns[i].name, category: 'column', detail: currentColumns[i].dataType });
          }
        } else {
          // general: columns, keywords, functions
          for (var i = 0; i < currentColumns.length; i++) {
            candidates.push({ text: currentColumns[i].name, category: 'column', detail: currentColumns[i].dataType });
          }
          for (var i = 0; i < WHERE_KEYWORDS.length; i++) {
            candidates.push({ text: WHERE_KEYWORDS[i], category: 'keyword', detail: '' });
          }
          for (var i = 0; i < AUTOCOMPLETE_FUNCTIONS.length; i++) {
            candidates.push({ text: AUTOCOMPLETE_FUNCTIONS[i], category: 'function', detail: '' });
          }
        }

        // Filter by case-insensitive starts-with
        var filtered;
        if (prefix.length > 0) {
          var prefixUpper = prefix.toUpperCase();
          filtered = [];
          for (var i = 0; i < candidates.length; i++) {
            if (candidates[i].text.toUpperCase().indexOf(prefixUpper) === 0) {
              filtered.push(candidates[i]);
            }
          }
        } else {
          filtered = candidates;
        }

        if (filtered.length === 0) {
          return [];
        }

        return filtered.slice(0, MAX_SUGGESTIONS);
      }

      /**
       * Renders the dropdown with the given items.
       */
      function showDropdown(items) {
        if (items.length === 0) {
          dismissDropdown();
          return;
        }

        currentItems = items;
        selectedIndex = 0;
        dropdownVisible = true;

        var html = '';
        for (var i = 0; i < items.length; i++) {
          html += '<div class="autocomplete-item' + (i === 0 ? ' active' : '') + '" data-index="' + i + '">';
          html += '<span class="text">' + hlEscape(items[i].text) + '</span>';
          if (items[i].detail) {
            html += '<span class="detail">' + hlEscape(items[i].detail) + '</span>';
          }
          html += '</div>';
        }
        dropdownEl.innerHTML = html;
        dropdownEl.style.display = 'block';

        updateDropdownPosition();

        // Wire click handlers on items
        var itemEls = dropdownEl.querySelectorAll('.autocomplete-item');
        for (var i = 0; i < itemEls.length; i++) {
          (function(idx) {
            itemEls[idx].addEventListener('mousedown', function(e) {
              e.preventDefault();
              selectedIndex = idx;
              insertSuggestion(currentItems[idx]);
            });
          })(i);
        }
      }

      /**
       * Dismisses the dropdown without modifying text.
       */
      function dismissDropdown() {
        dropdownVisible = false;
        selectedIndex = -1;
        currentItems = [];
        dropdownEl.style.display = 'none';
        dropdownEl.innerHTML = '';
      }

      /**
       * Checks if dropdown should flip above the input (not enough space below).
       */
      function updateDropdownPosition() {
        var rect = dropdownEl.getBoundingClientRect();
        var viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        if (rect.bottom > viewportHeight) {
          dropdownEl.classList.add('flip-above');
        } else {
          dropdownEl.classList.remove('flip-above');
        }
      }

      /**
       * Inserts the selected suggestion text, replacing the typed prefix.
       */
      function insertSuggestion(item) {
        var text = filterInput.value;
        var cursorPos = filterInput.selectionStart;

        // Replace from prefixStart to cursorPos with the suggestion text
        var before = text.substring(0, prefixStart);
        var after = text.substring(cursorPos);
        var insertText = item.text;

        // Add trailing space after insertion for convenience
        filterInput.value = before + insertText + after;
        var newCursorPos = prefixStart + insertText.length;
        filterInput.selectionStart = filterInput.selectionEnd = newCursorPos;

        // Update highlight layer
        filterHighlight.innerHTML = highlightSql(filterInput.value);

        dismissDropdown();
      }

      /**
       * Handles autocomplete logic on each input event.
       */
      function handleAutocompleteInput() {
        var text = filterInput.value;
        var cursorPos = filterInput.selectionStart;

        prefixStart = findPrefixStart(text, cursorPos);
        var prefix = text.substring(prefixStart, cursorPos);

        if (prefix.length === 0 && !dropdownVisible) {
          // No prefix typed and dropdown not already showing — do nothing
          return;
        }

        // Detect context using text before the prefix
        var context = detectContext(text, prefixStart);
        var items = getFilteredSuggestions(prefix, context);

        if (items.length === 0) {
          dismissDropdown();
        } else {
          showDropdown(items);
        }
      }

      // --- Event handlers integrating autocomplete ---

      // Filter input event — re-highlight, enforce single-line, trigger autocomplete
      filterInput.addEventListener('input', function() {
        // Enforce single-line by replacing newlines with spaces
        if (filterInput.value.indexOf('\\n') !== -1 || filterInput.value.indexOf('\\r') !== -1) {
          var selStart = filterInput.selectionStart;
          filterInput.value = filterInput.value.replace(/\\r?\\n/g, ' ');
          filterInput.selectionStart = filterInput.selectionEnd = selStart;
        }
        // Update highlight layer
        filterHighlight.innerHTML = highlightSql(filterInput.value);

        // Autocomplete logic
        handleAutocompleteInput();
      });

      // Filter scroll event — sync scrollLeft
      filterInput.addEventListener('scroll', function() {
        filterHighlight.scrollLeft = filterInput.scrollLeft;
      });

      // Filter keydown — integrates autocomplete navigation with existing Enter behavior
      filterInput.addEventListener('keydown', function(e) {
        // Ctrl+Space: show all suggestions for current context
        if (e.key === ' ' && e.ctrlKey) {
          e.preventDefault();
          var text = filterInput.value;
          var cursorPos = filterInput.selectionStart;
          prefixStart = findPrefixStart(text, cursorPos);
          var prefix = text.substring(prefixStart, cursorPos);
          var context = detectContext(text, prefixStart);
          var items = getFilteredSuggestions(prefix, context);
          if (items.length > 0) {
            showDropdown(items);
          }
          return;
        }

        if (dropdownVisible) {
          // Arrow Down — navigate with wrapping
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = (selectedIndex + 1) % currentItems.length;
            updateSelectedItem();
            return;
          }

          // Arrow Up — navigate with wrapping
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = (selectedIndex - 1 + currentItems.length) % currentItems.length;
            updateSelectedItem();
            return;
          }

          // Enter or Tab — insert selected item
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            if (selectedIndex >= 0 && selectedIndex < currentItems.length) {
              insertSuggestion(currentItems[selectedIndex]);
            } else {
              dismissDropdown();
            }
            return;
          }

          // Escape — dismiss without modification
          if (e.key === 'Escape') {
            e.preventDefault();
            dismissDropdown();
            return;
          }
        } else {
          // No dropdown visible — original behavior
          if (e.key === 'Enter') {
            e.preventDefault();
            var text = filterInput.value.trim();
            if (text) {
              vscode.postMessage({ type: 'applyFilter', filterText: text });
            }
          }
        }
      });

      /**
       * Updates the visual highlight on the selected dropdown item.
       */
      function updateSelectedItem() {
        var itemEls = dropdownEl.querySelectorAll('.autocomplete-item');
        for (var i = 0; i < itemEls.length; i++) {
          if (i === selectedIndex) {
            itemEls[i].classList.add('active');
            // Scroll into view if needed
            itemEls[i].scrollIntoView({ block: 'nearest' });
          } else {
            itemEls[i].classList.remove('active');
          }
        }
      }

      // Filter blur — dismiss dropdown with 150ms delay to allow click events
      filterInput.addEventListener('blur', function() {
        blurTimeout = setTimeout(function() {
          dismissDropdown();
        }, 150);
      });

      // Filter focus — cancel any pending blur dismiss
      filterInput.addEventListener('focus', function() {
        if (blurTimeout) {
          clearTimeout(blurTimeout);
          blurTimeout = null;
        }
      });

      // --- End Autocomplete Controller ---

      // Filter paste event — strip formatting, replace newlines
      filterInput.addEventListener('paste', function(e) {
        e.preventDefault();
        var text = (e.clipboardData || window.clipboardData).getData('text/plain');
        text = text.replace(/\\r?\\n/g, ' ');
        document.execCommand('insertText', false, text);
      });

      // Apply filter on button click
      applyFilterBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'applyFilter', filterText: filterInput.value });
      });

      // Edit Query button
      editQueryBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'editQuery' });
      });

      // Retry button
      retryBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'retry' });
      });

      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }

      window.addEventListener('message', function(event) {
        const message = event.data;
        switch (message.type) {
          case 'data':
            renderData(message);
            break;
          case 'progress':
            renderProgress(message);
            break;
          case 'error':
            renderError(message);
            break;
        }
      });

      function renderProgress(message) {
        if (message.state) {
          filterInput.value = message.state.filterText || '';
          filterHighlight.innerHTML = highlightSql(filterInput.value);
        }
        errorBannerEl.style.display = 'none';
        contentEl.innerHTML = '<div class="message progress"><div class="spinner"></div><p>Executing query...</p></div>';
      }

      function renderData(message) {
        errorBannerEl.style.display = 'none';

        if (message.query) {
          queryDisplayEl.innerHTML = highlightSql(message.query);
          queryDisplayEl.style.display = 'block';
        } else {
          queryDisplayEl.innerHTML = '';
          queryDisplayEl.style.display = 'none';
        }

        if (message.state) {
          filterInput.value = message.state.filterText || '';
          filterHighlight.innerHTML = highlightSql(filterInput.value);
        }

        // Extract column metadata for autocomplete
        // Always update currentColumns on data messages — empty array when no columns available
        if (message.result && message.result.resultSets && message.result.resultSets.length > 0 && message.result.resultSets[0].columns) {
          currentColumns = message.result.resultSets[0].columns;
        } else {
          currentColumns = [];
        }

        if (message.result && message.result.resultSets && message.result.resultSets.length > 0) {
          renderResultTable(message.result);
        } else {
          contentEl.innerHTML = '<div class="message"><p>No rows returned.</p></div>';
        }
      }

      function renderError(message) {
        // Show error banner
        errorTextEl.textContent = message.error || 'An error occurred.';
        errorBannerEl.style.display = 'flex';

        if (message.query) {
          queryDisplayEl.innerHTML = highlightSql(message.query);
          queryDisplayEl.style.display = 'block';
        } else {
          queryDisplayEl.innerHTML = '';
          queryDisplayEl.style.display = 'none';
        }

        if (message.state) {
          filterInput.value = message.state.filterText || '';
          filterHighlight.innerHTML = highlightSql(filterInput.value);
        }

        // Preserve last successful result below the error
        if (message.result && message.result.resultSets && message.result.resultSets.length > 0) {
          renderResultTable(message.result);
        } else {
          contentEl.innerHTML = '<div class="message"><p>No data available.</p></div>';
        }
      }

      function renderResultTable(result) {
        var rs = result.resultSets[0];
        if (!rs || rs.rowCount === 0) {
          contentEl.innerHTML = '<div class="message"><p>No rows returned.</p></div>' +
            '<div class="status">Execution time: ' + result.executionTimeMs + ' ms</div>';
          return;
        }

        var html = '<div class="table-container"><table><thead><tr>';
        for (var c = 0; c < rs.columns.length; c++) {
          html += '<th data-col="' + escapeHtml(rs.columns[c].name) + '">';
          html += escapeHtml(rs.columns[c].name);
          html += '<span class="sort-indicator"></span>';
          html += '<span class="col-type">' + escapeHtml(rs.columns[c].dataType) + '</span>';
          html += '</th>';
        }
        html += '</tr></thead><tbody>';

        for (var r = 0; r < rs.rows.length; r++) {
          html += '<tr>';
          for (var c = 0; c < rs.rows[r].length; c++) {
            var cell = rs.rows[r][c];
            if (cell === null || cell === undefined) {
              html += '<td><span class="null-value">NULL</span></td>';
            } else {
              html += '<td>' + escapeHtml(String(cell)) + '</td>';
            }
          }
          html += '</tr>';
        }

        html += '</tbody></table></div>';
        html += '<div class="row-count">' + rs.rowCount + ' row' + (rs.rowCount !== 1 ? 's' : '') + '</div>';
        html += '<div class="status">Execution time: ' + result.executionTimeMs + ' ms</div>';
        contentEl.innerHTML = html;

        // Wire up column header clicks for sorting
        var headers = contentEl.querySelectorAll('th');
        headers.forEach(function(header) {
          header.addEventListener('click', function() {
            var colName = header.getAttribute('data-col');
            vscode.postMessage({ type: 'toggleSort', columnName: colName });
          });
        });
      }
    })();
  </script>
</body>
</html>`;
  }
}
