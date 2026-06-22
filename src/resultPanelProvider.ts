import * as vscode from 'vscode';
import * as mssql from 'mssql';
import { IResultPanel, QueryResult, ResultSet } from './types';
import {
  ExtensionToWebviewMessage,
  WebviewDataMessage,
  WebviewProgressMessage,
  WebviewCancelledMessage,
  WebviewDisplayModeMessage,
  WebviewToExtensionMessage,
  WebviewExportMessage,
  WebviewOpenXmlMessage,
  WebviewRequestBatchMessage,
  PaginatedQueryState,
  WebviewAppendBatchMessage,
  WebviewBatchErrorMessage,
} from './webviewProtocol';
import { ExportManager } from './exportManager';
import { sortRows, filterRows } from './resultPanelUtils';
import { QueryExecutor } from './queryExecutor';

/**
 * ResultPanelProvider implements a WebviewViewProvider that renders query results
 * in the bottom panel area (alongside Terminal, Problems, Output).
 *
 * It replaces the old ResultPanel (side panel) with a dedicated bottom-panel tab.
 */
export class ResultPanelProvider implements vscode.WebviewViewProvider, IResultPanel {
  public static readonly viewType = 'sqlServerResults';

  private view?: vscode.WebviewView;
  private pendingMessage?: ExtensionToWebviewMessage;
  private lastResult?: QueryResult;
  private readonly exportManager: ExportManager;

  /** Pagination state per result set index (Requirement 1.1, 1.3) */
  private paginationStates: Map<number, PaginatedQueryState> = new Map();

  /** Tracks whether a batch fetch is in progress per result set (Requirement 1.10) */
  private isFetchingBatch: Map<number, boolean> = new Map();

  /** Reference to the query executor for fetching batches */
  private queryExecutor?: QueryExecutor;

  constructor(private readonly extensionUri: vscode.Uri, exportManager?: ExportManager) {
    this.exportManager = exportManager || new ExportManager();
  }

  /**
   * Sets the QueryExecutor instance used for fetching additional batches.
   * Must be called after construction (avoids circular dependency).
   */
  setQueryExecutor(executor: QueryExecutor): void {
    this.queryExecutor = executor;
  }

  /**
   * Called by VS Code when the webview view is first made visible.
   * Sets up the webview options and initial HTML content.
   */
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

    // Handle incoming messages from the webview (e.g., tab switches)
    webviewView.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
      this.handleWebviewMessage(message);
    });

    // Handle webview disposal (user closes the panel tab)
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });

    // If there was a pending message (sent before webview was resolved), deliver it now
    if (this.pendingMessage) {
      this.postMessage(this.pendingMessage);
      this.pendingMessage = undefined;
    }
  }

  /**
   * Displays query results in the webview panel.
   * Sends the full QueryResult to the webview via postMessage.
   */
  show(result: QueryResult): void {
    this.lastResult = result;
    const message: WebviewDataMessage = { type: 'data', result };
    this.postMessage(message);
  }

  /**
   * Displays query results and sets up pagination state for large result sets.
   * Computes total row count via COUNT(*) and stores pagination state when > 10,000 rows.
   * Clears previous pagination states before setting up new ones.
   *
   * @param result - The query result from initial execution
   * @param originalSql - The original SQL query text (for OFFSET/FETCH pagination)
   * @param pool - The connection pool for fetching subsequent batches
   */
  async showWithPagination(result: QueryResult, originalSql: string, pool: mssql.ConnectionPool): Promise<void> {
    // Clear previous pagination states (new query execution replaces all state)
    this.paginationStates.clear();
    this.isFetchingBatch.clear();

    // For each result set that hit the 10,000 row cap, compute total row count
    if (result.resultSets && result.resultSets.length > 0 && !result.error) {
      for (let i = 0; i < result.resultSets.length; i++) {
        const rs = result.resultSets[i];
        // Only paginate if the result set is at the cap (10,000 rows)
        if (rs.rowCount >= 10000) {
          try {
            const countSql = `SELECT COUNT(*) as total FROM (${originalSql}) AS __count_query`;
            const request = pool.request();
            const countResult = await request.query(countSql);
            const totalRows = countResult.recordset?.[0]?.total ?? rs.rowCount;

            if (totalRows > 10000) {
              // Set totalRowsAvailable on the result set for the webview
              rs.totalRowsAvailable = totalRows;

              // Store pagination state for this result set
              this.paginationStates.set(i, {
                originalSql,
                pool,
                totalRowsAvailable: totalRows,
                loadedRows: rs.rowCount,
                batchSize: 10000,
                resultSetIndex: i,
              });
              this.isFetchingBatch.set(i, false);
            }
          } catch (err) {
            // COUNT(*) failed — don't block results, just skip pagination for this result set
            console.warn(
              `[Pagination] Failed to compute total row count: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }
    }

    // Display the results (with totalRowsAvailable set on paginated result sets)
    this.show(result);
  }

  /**
   * Displays a progress indicator while a query is executing.
   */
  showProgress(): void {
    const message: WebviewProgressMessage = { type: 'progress' };
    this.postMessage(message);
  }

  /**
   * Displays a cancellation confirmation message.
   */
  showCancellation(): void {
    const message: WebviewCancelledMessage = { type: 'cancelled' };
    this.postMessage(message);
  }

  /**
   * Sets the display mode for the Result Panel (single or split).
   * Sends a message to the webview to re-render current results in the new mode.
   * (Requirements 5.4, 5.5)
   */
  setDisplayMode(mode: 'single' | 'split'): void {
    const message: WebviewDisplayModeMessage = { type: 'displayMode', mode };
    this.postMessage(message);
  }

  /**
   * Returns the currently active result set (first result set or the one at the active tab index).
   * Used by export commands triggered from the command palette.
   * Returns undefined if no result set is available.
   */
  getActiveResultSet(): ResultSet | undefined {
    if (!this.lastResult || !this.lastResult.resultSets || this.lastResult.resultSets.length === 0) {
      return undefined;
    }
    // Default to first result set (the webview manages tab state client-side)
    return this.lastResult.resultSets[0];
  }

  /**
   * Disposes the webview view and cleans up resources.
   */
  dispose(): void {
    // The webview view is managed by VS Code; we just clear our reference
    this.view = undefined;
    this.pendingMessage = undefined;
    this.paginationStates.clear();
    this.isFetchingBatch.clear();
  }

  /**
   * Posts a message to the webview. If the webview is not yet resolved,
   * stores the message as pending and focuses the panel to trigger resolution.
   * Handles postMessage failures gracefully (e.g., webview disposed).
   */
  private postMessage(message: ExtensionToWebviewMessage): void {
    if (this.view) {
      try {
        // Reveal the panel to ensure it's visible
        this.view.show?.(true);
        this.view.webview.postMessage(message);
      } catch {
        // Webview was disposed between the check and the postMessage call.
        // Store as pending so it can be delivered when the view is re-resolved.
        this.view = undefined;
        this.pendingMessage = message;
        // Focus the panel to trigger re-resolution
        vscode.commands.executeCommand('sqlServerResults.focus');
      }
    } else {
      // Webview not yet resolved — store for delivery when it becomes available
      this.pendingMessage = message;
      // Focus the panel to trigger resolution (this causes resolveWebviewView to be called)
      vscode.commands.executeCommand('sqlServerResults.focus');
    }
  }

  /**
   * Handles messages received from the webview.
   */
  private handleWebviewMessage(message: WebviewToExtensionMessage): void {
    switch (message.type) {
      case 'switchTab':
        // Tab switch is handled client-side in the webview.
        // This handler allows the extension host to track the active tab
        // or respond to tab changes in the future if needed.
        break;
      case 'export':
        this.handleExportMessage(message);
        break;
      case 'openXml':
        this.handleOpenXmlMessage(message);
        break;
      case 'requestBatch':
        this.handleRequestBatchMessage(message);
        break;
    }
  }

  /**
   * Handles a requestBatch message from the webview.
   * Fetches the next batch of rows and posts appendBatch or batchError.
   * Rejects duplicate requests while a fetch is in progress (Requirement 1.10).
   */
  private async handleRequestBatchMessage(message: WebviewRequestBatchMessage): Promise<void> {
    const { resultSetIndex } = message;

    // Reject if no query executor is available
    if (!this.queryExecutor) {
      const errorMsg: WebviewBatchErrorMessage = { type: 'batchError', message: 'No query executor available.' };
      this.postMessage(errorMsg);
      return;
    }

    // Reject if no pagination state exists for this result set
    const state = this.paginationStates.get(resultSetIndex);
    if (!state) {
      const errorMsg: WebviewBatchErrorMessage = { type: 'batchError', message: 'No pagination state for this result set.' };
      this.postMessage(errorMsg);
      return;
    }

    // Reject duplicate requests while a fetch is in progress (Requirement 1.10)
    if (this.isFetchingBatch.get(resultSetIndex)) {
      return; // Silently ignore — button should be disabled in webview
    }

    // Mark as fetching
    this.isFetchingBatch.set(resultSetIndex, true);

    try {
      const batchResult = await this.queryExecutor.fetchBatch(state);

      if ('error' in batchResult) {
        // Post error to webview — re-enables the button (Requirement 1.8)
        const errorMsg: WebviewBatchErrorMessage = { type: 'batchError', message: batchResult.error };
        this.postMessage(errorMsg);
      } else {
        // Update pagination state with newly loaded rows
        state.loadedRows += batchResult.rows.length;

        // If all rows have been loaded, remove pagination state
        if (state.loadedRows >= state.totalRowsAvailable) {
          this.paginationStates.delete(resultSetIndex);
          this.isFetchingBatch.delete(resultSetIndex);
        }

        // Post the batch rows to the webview
        const appendMsg: WebviewAppendBatchMessage = {
          type: 'appendBatch',
          rows: batchResult.rows,
          totalRowsAvailable: state.totalRowsAvailable,
          loadedSoFar: state.loadedRows,
        };
        this.postMessage(appendMsg);
      }
    } catch (err) {
      // Unexpected error during fetch
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorMsg: WebviewBatchErrorMessage = { type: 'batchError', message: errorMessage };
      this.postMessage(errorMsg);
    } finally {
      // Clear fetching flag (unless state was removed because all rows loaded)
      if (this.isFetchingBatch.has(resultSetIndex)) {
        this.isFetchingBatch.set(resultSetIndex, false);
      }
    }
  }

  /**
   * Handles an export request from the webview.
   * Retrieves the active result set, applies any active filters/sort,
   * and passes the transformed result set to ExportManager.
   */
  private handleExportMessage(message: WebviewExportMessage): void {
    // No result set displayed — no-op
    if (!this.lastResult || !this.lastResult.resultSets || this.lastResult.resultSets.length === 0) {
      return;
    }

    const tabIndex = message.activeTabIndex;

    // Invalid tab index — no-op
    if (tabIndex < 0 || tabIndex >= this.lastResult.resultSets.length) {
      return;
    }

    const originalResultSet = this.lastResult.resultSets[tabIndex];

    // No data — no-op (ExportManager handles zero-row cases per format)
    // Build the result set with filters/sort applied
    let rows = originalResultSet.rows;

    // Apply per-column filters
    if (message.filters && message.filters.length > 0) {
      for (let i = 0; i < message.filters.length; i++) {
        if (message.filters[i]) {
          rows = filterRows(rows, i, message.filters[i]);
        }
      }
    }

    // Apply sort (only if <= 1000 rows, mirroring the webview's threshold)
    if (message.sortColumn !== null && originalResultSet.rows.length <= 1000) {
      rows = sortRows(rows, message.sortColumn, message.sortDirection || 'asc');
    }

    const exportResultSet: ResultSet = {
      columns: originalResultSet.columns,
      rows,
      rowCount: rows.length,
    };

    this.exportManager.exportResults(message.format, exportResultSet);
  }

  /**
   * Handles an open-xml request from the webview.
   * Opens the XML content in a new untitled editor tab with XML syntax highlighting.
   */
  private async handleOpenXmlMessage(message: WebviewOpenXmlMessage): Promise<void> {
    // Guard: ignore empty/undefined content
    if (!message.content || !message.content.trim()) {
      return;
    }

    try {
      const columnName = message.columnName || 'XML';

      // Open untitled document with XML content and language mode
      const doc = await vscode.workspace.openTextDocument({
        content: message.content,
        language: 'xml',
      });

      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to open XML content: ${errorMessage}`);
    }
  }

  /**
   * Returns the HTML for the webview with full interactive rendering:
   * table grid display, tabbed result sets, client-side sorting, and per-column filtering.
   */
  private getWebviewHtml(): string {
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
      background-color: var(--vscode-panel-background, var(--vscode-editor-background, #1e1e1e));
      padding: 8px;
      overflow: auto;
    }
    .message {
      padding: 16px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .message.error {
      border-left: 3px solid var(--vscode-errorForeground, #f48771);
      padding: 16px;
      display: block;
    }
    .message.success {
      border-left: 3px solid var(--vscode-terminal-ansiGreen, #89d185);
    }
    .message.cancelled {
      border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700);
    }
    .message.progress {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .message.empty {
      border-left: 3px solid var(--vscode-foreground, #cccccc);
      opacity: 0.8;
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
    .status {
      margin-top: 8px;
      opacity: 0.7;
      font-size: 0.9em;
    }
    .error-details p {
      margin: 4px 0;
    }
    .table-container {
      overflow: auto;
      max-height: calc(100vh - 100px);
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
    }
    th {
      background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
      position: sticky;
      top: 0;
      font-weight: 600;
      cursor: pointer;
      user-select: none;
    }
    th.sort-disabled {
      cursor: default;
    }
    .col-handle {
      position: absolute;
      right: -3px;
      top: 0;
      width: 5px;
      height: 100%;
      cursor: col-resize;
      z-index: 10;
      background: transparent;
    }
    .col-handle:hover {
      background: var(--vscode-focusBorder, #007fd4);
      opacity: 0.5;
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
    .filter-row input {
      width: 100%;
      padding: 2px 4px;
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #cccccc);
      font-size: var(--vscode-editor-font-size, 12px);
      font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
    }
    .filter-row input::placeholder {
      color: var(--vscode-input-placeholderForeground, #888);
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
    .sort-disabled-message {
      padding: 4px 8px;
      opacity: 0.7;
      font-size: 0.85em;
      font-style: italic;
    }
    .tabs {
      display: flex;
      gap: 2px;
      margin-bottom: 8px;
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      padding-bottom: 4px;
      overflow-x: auto;
      overflow-y: hidden;
    }
    .tab {
      padding: 4px 12px;
      border: none;
      background: transparent;
      color: var(--vscode-foreground, #cccccc);
      cursor: pointer;
      border-radius: 3px 3px 0 0;
      font-size: var(--vscode-font-size, 13px);
    }
    .tab:hover {
      background: var(--vscode-list-hoverBackground, #2a2d2e);
    }
    .tab.active {
      background: var(--vscode-list-activeSelectionBackground, #094771);
      color: var(--vscode-list-activeSelectionForeground, #ffffff);
    }
    #content {
      width: 100%;
      height: 100%;
    }
    .result-heading {
      margin: 12px 0 6px 0;
      padding: 4px 0;
      font-size: var(--vscode-font-size, 13px);
      font-weight: 600;
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      color: var(--vscode-foreground, #cccccc);
    }
    .result-heading:first-child {
      margin-top: 0;
    }
    .tabs-overflow {
      overflow-x: auto;
      overflow-y: hidden;
      white-space: nowrap;
    }
    .xml-cell {
      color: var(--vscode-textLink-foreground, #3794ff);
      text-decoration: underline;
      cursor: pointer;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      display: inline-block;
      vertical-align: middle;
    }
    .xml-cell:hover {
      color: var(--vscode-textLink-activeForeground, #3794ff);
      text-decoration: underline;
    }
    .show-more-container {
      margin-top: 8px;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
    }
    .show-more-btn {
      padding: 4px 12px;
      border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #cccccc);
      cursor: pointer;
      border-radius: 2px;
      font-size: var(--vscode-font-size, 13px);
      font-family: var(--vscode-font-family, 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif);
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .show-more-btn:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground, #45494e);
    }
    .show-more-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .show-more-btn .btn-spinner {
      width: 12px;
      height: 12px;
      border: 2px solid var(--vscode-foreground, #cccccc);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      display: inline-block;
    }
    .batch-error {
      color: var(--vscode-errorForeground, #f48771);
      font-size: 0.9em;
      margin-top: 4px;
    }
  </style>
</head>
<body>
  <div id="content">
    <div class="message empty">
      <p>Run a query to see results here.</p>
    </div>
  </div>
  <script>
    (function() {
      const vscode = acquireVsCodeApi();
      const contentEl = document.getElementById('content');

      // State for each result set: original rows, sort state, filter state
      let resultSetStates = [];
      let currentResult = null;
      let displayMode = 'single'; // 'single' or 'split' (Requirements 5.1, 5.2)

      // Column resize state per result set (Requirements 3.1, 3.6, 3.8)
      let columnResizeStates = []; // Array of ColumnResizeState objects

      // Pagination state per result set (Requirements 1.2, 1.5, 1.6, 1.9)
      let paginationStates = []; // Array of { totalRowsAvailable, loadedSoFar } or null

      window.addEventListener('message', (event) => {
        const message = event.data;
        switch (message.type) {
          case 'data':
            renderResult(message.result);
            break;
          case 'progress':
            renderProgress();
            break;
          case 'cancelled':
            renderCancellation();
            break;
          case 'displayMode':
            displayMode = message.mode;
            // Re-render current results in the new mode (Requirement 5.4)
            if (currentResult && currentResult.resultSets && currentResult.resultSets.length > 0) {
              renderResultSets(currentResult);
            }
            break;
          case 'appendBatch':
            handleAppendBatch(message);
            break;
          case 'batchError':
            handleBatchError(message);
            break;
        }
      });

      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }

      function isXmlContent(value) {
        if (value == null || value === '') { return false; }
        var trimmed = value.replace(/^\s+/, '');
        if (trimmed.length === 0) { return false; }
        if (trimmed.toLowerCase().indexOf('<?xml') === 0) { return true; }
        if (trimmed.length >= 2 && trimmed[0] === '<' && /[a-zA-Z]/.test(trimmed[1])) { return true; }
        return false;
      }

      function renderProgress() {
        contentEl.innerHTML = '<div class="message progress"><div class="spinner"></div><p>Executing query...</p></div>';
      }

      function renderCancellation() {
        contentEl.innerHTML = '<div class="message cancelled"><p>Query execution was cancelled.</p></div>';
      }

      function renderResult(result) {
        currentResult = result;
        if (result.error) {
          renderError(result);
        } else if (result.resultSets && result.resultSets.length > 0) {
          renderResultSets(result);
        } else {
          renderAffectedRows(result);
        }
      }

      function renderError(result) {
        const err = result.error;
        contentEl.innerHTML = '<div class="message error">' +
          '<h3>Query Error</h3>' +
          '<div class="error-details">' +
          '<p><strong>Error Number:</strong> ' + err.number + '</p>' +
          '<p><strong>Severity:</strong> ' + err.severity + '</p>' +
          '<p><strong>Message:</strong> ' + escapeHtml(err.message) + '</p>' +
          '</div>' +
          '<p class="status">Execution time: ' + result.executionTimeMs + ' ms</p>' +
          '</div>';
      }

      /**
       * Sort rows by column index and direction.
       * Mirrors the logic in resultPanelUtils.ts for consistency.
       */
      function sortRows(rows, columnIndex, direction) {
        return [...rows].sort(function(a, b) {
          var valA = a[columnIndex];
          var valB = b[columnIndex];

          if (valA == null && valB == null) { return 0; }
          if (valA == null) { return 1; }
          if (valB == null) { return -1; }

          if (typeof valA === 'number' && typeof valB === 'number') {
            return direction === 'asc' ? valA - valB : valB - valA;
          }

          var strA = String(valA).toLowerCase();
          var strB = String(valB).toLowerCase();

          if (strA < strB) { return direction === 'asc' ? -1 : 1; }
          if (strA > strB) { return direction === 'asc' ? 1 : -1; }
          return 0;
        });
      }

      /**
       * Filter rows where the cell at columnIndex contains filterText (case-insensitive).
       * Mirrors the logic in resultPanelUtils.ts for consistency.
       */
      function filterRows(rows, columnIndex, filterText) {
        if (!filterText) { return rows; }
        var lowerFilter = filterText.toLowerCase();
        return rows.filter(function(row) {
          var cell = row[columnIndex];
          if (cell == null) {
            return 'null'.indexOf(lowerFilter) !== -1;
          }
          return String(cell).toLowerCase().indexOf(lowerFilter) !== -1;
        });
      }

      /**
       * Apply all active filters and sort to get the displayed rows for a result set.
       */
      function getDisplayedRows(stateIndex) {
        var state = resultSetStates[stateIndex];
        var rows = state.originalRows;

        // Apply filters
        for (var i = 0; i < state.filters.length; i++) {
          if (state.filters[i]) {
            rows = filterRows(rows, i, state.filters[i]);
          }
        }

        // Apply sort (only if <= 1000 rows in original set)
        if (state.sortColumn !== null && state.originalRows.length <= 1000) {
          rows = sortRows(rows, state.sortColumn, state.sortDirection);
        }

        return rows;
      }

      /**
       * Generates display labels for result sets based on batch structure.
       * Mirrors the logic in displayModeController.ts (Requirements 5.1, 5.2, 5.3).
       *
       * - Single batch (batchCount === 1): labels are "Result 1", "Result 2", etc.
       * - Multiple batches (batchCount > 1): labels are "Batch N - Result M".
       */
      function generateLabels(resultSets, batchCount) {
        if (batchCount <= 1) {
          return resultSets.map(function(_, index) {
            return 'Result ' + (index + 1);
          });
        }
        // Multiple batches: track per-batch result index
        var batchCounters = {};
        return resultSets.map(function(rs) {
          var batchIdx = rs.batchIndex || 1;
          var count = (batchCounters[batchIdx] || 0) + 1;
          batchCounters[batchIdx] = count;
          return 'Batch ' + batchIdx + ' - Result ' + count;
        });
      }

      /**
       * Resolves which tab should be active after new results arrive.
       * Preserves the previous tab index if still valid (Requirements 5.6).
       */
      function resolveActiveTabIndex(previousIndex, newCount) {
        if (previousIndex < newCount) {
          return previousIndex;
        }
        return 0;
      }

      // Track the active tab index for tab preservation across re-renders
      var activeTabIndex = 0;

      function renderResultSets(result) {
        // Initialize state for each result set
        resultSetStates = result.resultSets.map(function(rs) {
          return {
            originalRows: rs.rows,
            columns: rs.columns,
            rowCount: rs.rowCount,
            sortColumn: null,
            sortDirection: 'asc',
            filters: new Array(rs.columns.length).fill('')
          };
        });

        // Initialize pagination state per result set (Requirements 1.2, 1.5, 1.6)
        paginationStates = result.resultSets.map(function(rs) {
          if (rs.totalRowsAvailable && rs.totalRowsAvailable > rs.rowCount) {
            return { totalRowsAvailable: rs.totalRowsAvailable, loadedSoFar: rs.rowCount };
          }
          return null;
        });

        // Initialize column resize state per result set (Requirements 3.1, 3.6)
        columnResizeStates = result.resultSets.map(function(rs) {
          return {
            widths: new Array(rs.columns.length).fill(0), // 0 = auto/unset
            isResizing: false,
            activeColumn: null,
            startX: 0,
            startWidth: 0
          };
        });

        // Clear any active drag cursor state when new results arrive (Requirement 3.6)
        document.body.style.cursor = '';
        document.body.style.userSelect = '';

        // Determine batch count for label generation
        var batchCount = 1;
        if (result.resultSets.length > 0 && result.resultSets[0].batchIndex !== undefined) {
          var maxBatch = 0;
          for (var i = 0; i < result.resultSets.length; i++) {
            if (result.resultSets[i].batchIndex > maxBatch) {
              maxBatch = result.resultSets[i].batchIndex;
            }
          }
          batchCount = maxBatch || 1;
        }

        // Generate labels using displayModeController logic (Requirements 5.1, 5.2, 5.3)
        var labels = generateLabels(result.resultSets, batchCount);

        // Resolve active tab for split mode (Requirement 5.6)
        activeTabIndex = resolveActiveTabIndex(activeTabIndex, result.resultSets.length);

        if (displayMode === 'split') {
          renderSplitMode(result, labels);
        } else {
          renderSingleMode(result, labels);
        }
      }

      /**
       * Split mode: render each result set in its own tab (Requirement 5.2).
       */
      function renderSplitMode(result, labels) {
        var html = '';

        // Tabs for result sets
        if (result.resultSets.length > 1) {
          html += '<div class="tabs">';
          for (var i = 0; i < result.resultSets.length; i++) {
            var activeClass = i === activeTabIndex ? ' active' : '';
            html += '<button class="tab' + activeClass + '" data-index="' + i + '">' + escapeHtml(labels[i]) + '</button>';
          }
          html += '</div>';
        }

        // Render each result set (only active one visible)
        for (var i = 0; i < result.resultSets.length; i++) {
          var rs = result.resultSets[i];
          var display = i === activeTabIndex ? 'block' : 'none';

          html += renderResultSetHtml(rs, i, display, result.executionTimeMs);
        }

        html += '<div class="status">Execution time: ' + result.executionTimeMs + ' ms</div>';
        contentEl.innerHTML = html;

        wireTabSwitching();
        wireSortingAndFiltering();
        wireColumnResize();
        wireXmlCellClicks();
        wireShowMoreButtons();
      }

      /**
       * Single mode: render all result sets stacked vertically with headings (Requirement 5.1).
       */
      function renderSingleMode(result, labels) {
        var html = '';

        for (var i = 0; i < result.resultSets.length; i++) {
          var rs = result.resultSets[i];

          // Add heading label for each result set
          if (result.resultSets.length > 1) {
            html += '<h3 class="result-heading">' + escapeHtml(labels[i]) + '</h3>';
          }

          html += renderResultSetHtml(rs, i, 'block', result.executionTimeMs);
        }

        html += '<div class="status">Execution time: ' + result.executionTimeMs + ' ms</div>';
        contentEl.innerHTML = html;

        wireSortingAndFiltering();
        wireColumnResize();
        wireXmlCellClicks();
        wireShowMoreButtons();
      }

      /**
       * Renders a single result set's HTML (table or empty message).
       */
      function renderResultSetHtml(rs, index, display, executionTimeMs) {
        var html = '';

        if (rs.rowCount === 0) {
          html += '<div class="result-set" data-index="' + index + '" style="display:' + display + '">';
          html += '<div class="message empty">';
          html += '<p>No rows returned.</p>';
          html += '</div></div>';
          return html;
        }

        html += '<div class="result-set" data-index="' + index + '" style="display:' + display + '">';

        // Show sorting disabled message for large result sets
        if (rs.rowCount > 1000) {
          html += '<div class="sort-disabled-message">Sorting is unavailable for result sets with more than 1000 rows.</div>';
        }

        html += '<div class="table-container">';
        html += '<table data-rs-index="' + index + '"><thead>';

        // Column headers row (clickable for sorting)
        html += '<tr class="header-row">';
        for (var c = 0; c < rs.columns.length; c++) {
          var sortClass = rs.rowCount > 1000 ? ' sort-disabled' : '';
          html += '<th class="sortable-header' + sortClass + '" data-col="' + c + '" data-rs="' + index + '">';
          html += escapeHtml(rs.columns[c].name);
          html += '<span class="sort-indicator"></span>';
          html += '<span class="col-type">' + escapeHtml(rs.columns[c].dataType) + '</span>';
          // Add column resize handle between adjacent column headers (not on last column)
          if (c < rs.columns.length - 1) {
            html += '<div class="col-handle" data-col="' + c + '" data-rs="' + index + '"></div>';
          }
          html += '</th>';
        }
        html += '</tr>';

        // Filter inputs row
        html += '<tr class="filter-row">';
        for (var c = 0; c < rs.columns.length; c++) {
          html += '<td><input type="text" placeholder="Filter..." data-col="' + c + '" data-rs="' + index + '" /></td>';
        }
        html += '</tr>';

        html += '</thead><tbody>';

        for (var r = 0; r < rs.rows.length; r++) {
          html += '<tr>';
          for (var c = 0; c < rs.rows[r].length; c++) {
            var cell = rs.rows[r][c];
            if (cell === null || cell === undefined) {
              html += '<td><span class="null-value">NULL</span></td>';
            } else if (isXmlContent(String(cell))) {
              var xmlStr = String(cell);
              var truncated = xmlStr.length > 100 ? xmlStr.substring(0, 100) + '...' : xmlStr;
              html += '<td><span class="xml-cell" data-content="' + escapeHtml(xmlStr).replace(/"/g, '&quot;') + '" data-column="' + escapeHtml(rs.columns[c].name).replace(/"/g, '&quot;') + '">' + escapeHtml(truncated) + '</span></td>';
            } else {
              html += '<td>' + escapeHtml(String(cell)) + '</td>';
            }
          }
          html += '</tr>';
        }

        html += '</tbody></table>';
        html += '</div>';
        html += '<div class="row-count">' + rs.rowCount + ' row' + (rs.rowCount !== 1 ? 's' : '') + '</div>';

        // Show More button for paginated result sets (Requirements 1.2, 1.5, 1.6, 1.9)
        html += '<div class="show-more-container" data-rs-index="' + index + '" style="display:none;">';
        html += '<button class="show-more-btn" data-rs-index="' + index + '">Show More</button>';
        html += '<div class="batch-error" data-rs-index="' + index + '" style="display:none;"></div>';
        html += '</div>';

        html += '</div>';

        return html;
      }

      /**
       * Wires tab switching event handlers for split mode.
       */
      function wireTabSwitching() {
        var tabs = contentEl.querySelectorAll('.tab');
        if (tabs.length > 0) {
          tabs.forEach(function(tab) {
            tab.addEventListener('click', function() {
              var index = parseInt(tab.getAttribute('data-index'), 10);
              activeTabIndex = index;
              tabs.forEach(function(t, i) { t.classList.toggle('active', i === index); });
              contentEl.querySelectorAll('.result-set').forEach(function(rs, i) {
                rs.style.display = i === index ? 'block' : 'none';
              });
              vscode.postMessage({ type: 'switchTab', tabIndex: index });
            });
          });
        }
      }

      /**
       * Wires column sorting and filter input event handlers.
       */
      function wireSortingAndFiltering() {
        // Wire up column sorting
        var headers = contentEl.querySelectorAll('.sortable-header:not(.sort-disabled)');
        headers.forEach(function(header) {
          header.addEventListener('click', function() {
            var colIndex = parseInt(header.getAttribute('data-col'), 10);
            var rsIndex = parseInt(header.getAttribute('data-rs'), 10);
            var state = resultSetStates[rsIndex];

            // Toggle sort direction
            if (state.sortColumn === colIndex) {
              state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
            } else {
              state.sortColumn = colIndex;
              state.sortDirection = 'asc';
            }

            // Update sort indicators for this result set
            var rsEl = contentEl.querySelector('.result-set[data-index="' + rsIndex + '"]');
            rsEl.querySelectorAll('.sort-indicator').forEach(function(ind) { ind.textContent = ''; });
            header.querySelector('.sort-indicator').textContent = state.sortDirection === 'asc' ? ' \\u25B2' : ' \\u25BC';

            // Re-render table body
            rerenderTableBody(rsIndex);
          });
        });

        // Wire up filter inputs
        var filterInputs = contentEl.querySelectorAll('.filter-row input');
        filterInputs.forEach(function(input) {
          input.addEventListener('input', function() {
            var colIndex = parseInt(input.getAttribute('data-col'), 10);
            var rsIndex = parseInt(input.getAttribute('data-rs'), 10);
            var state = resultSetStates[rsIndex];

            state.filters[colIndex] = input.value;

            // Re-render table body
            rerenderTableBody(rsIndex);
          });
        });
      }

      /**
       * Wires column resize drag event handlers (Requirements 3.2, 3.3, 3.5, 3.6, 3.9).
       * Adds mousedown on .col-handle elements, mousemove/mouseup on document.
       */
      function wireColumnResize() {
        var handles = contentEl.querySelectorAll('.col-handle');
        handles.forEach(function(handle) {
          handle.addEventListener('mousedown', function(e) {
            e.preventDefault();
            e.stopPropagation();
            var colIndex = parseInt(handle.getAttribute('data-col'), 10);
            var rsIndex = parseInt(handle.getAttribute('data-rs'), 10);
            var resizeState = columnResizeStates[rsIndex];

            // Get the current width of the th element
            var th = handle.parentElement;
            var currentWidth = th.offsetWidth;

            resizeState.isResizing = true;
            resizeState.activeColumn = colIndex;
            resizeState.startX = e.clientX;
            resizeState.startWidth = currentWidth;

            // Apply col-resize cursor to entire viewport during drag (Requirement 3.3)
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
          });

          // Double-click auto-fit: scan all rendered cells to find widest content (Requirements 3.4, 3.5)
          handle.addEventListener('dblclick', function(e) {
            e.preventDefault();
            e.stopPropagation();
            var colIndex = parseInt(handle.getAttribute('data-col'), 10);
            var rsIndex = parseInt(handle.getAttribute('data-rs'), 10);
            var resizeState = columnResizeStates[rsIndex];

            var rsEl = contentEl.querySelector('.result-set[data-index="' + rsIndex + '"]');
            if (!rsEl) { return; }
            var table = rsEl.querySelector('table[data-rs-index="' + rsIndex + '"]');
            if (!table) { return; }

            // Collect all cell text lengths in the target column (including header)
            var longestTextLength = 0;

            // Check header th text
            var headerRow = table.querySelector('tr.header-row');
            if (headerRow) {
              var ths = headerRow.querySelectorAll('th');
              if (ths[colIndex]) {
                var headerText = ths[colIndex].textContent || '';
                if (headerText.length > longestTextLength) {
                  longestTextLength = headerText.length;
                }
              }
            }

            // Scan all tbody td cells at this column index
            var tbody = table.querySelector('tbody');
            if (tbody) {
              var bodyRows = tbody.querySelectorAll('tr');
              bodyRows.forEach(function(row) {
                var tds = row.querySelectorAll('td');
                if (tds[colIndex]) {
                  var cellText = tds[colIndex].textContent || '';
                  if (cellText.length > longestTextLength) {
                    longestTextLength = cellText.length;
                  }
                }
              });
            }

            // Calculate optimal width: longestTextLength * charWidth + 16px padding
            // charWidth ~7px for monospace at typical font sizes
            var charWidth = 7;
            var autoFitWidth = Math.max(50, longestTextLength * charWidth + 16);

            // Apply the auto-fit width
            resizeState.widths[colIndex] = autoFitWidth;
            applyColumnWidth(rsIndex, colIndex, autoFitWidth);
          });
        });

        // Document-level mousemove for drag tracking
        document.addEventListener('mousemove', function(e) {
          // Find active resize state
          for (var i = 0; i < columnResizeStates.length; i++) {
            var resizeState = columnResizeStates[i];
            if (resizeState.isResizing) {
              var delta = e.clientX - resizeState.startX;
              var newWidth = Math.max(50, resizeState.startWidth + delta);

              // Update the width in state
              resizeState.widths[resizeState.activeColumn] = newWidth;

              // Apply width to th and td elements in real-time
              applyColumnWidth(i, resizeState.activeColumn, newWidth);
              break;
            }
          }
        });

        // Document-level mouseup to finalize resize
        document.addEventListener('mouseup', function(e) {
          for (var i = 0; i < columnResizeStates.length; i++) {
            var resizeState = columnResizeStates[i];
            if (resizeState.isResizing) {
              // Finalize: clamp and store final width
              var delta = e.clientX - resizeState.startX;
              var finalWidth = Math.max(50, resizeState.startWidth + delta);
              resizeState.widths[resizeState.activeColumn] = finalWidth;

              // Clear resize state
              resizeState.isResizing = false;
              resizeState.activeColumn = null;
              resizeState.startX = 0;
              resizeState.startWidth = 0;

              // Remove col-resize cursor from viewport
              document.body.style.cursor = '';
              document.body.style.userSelect = '';
              break;
            }
          }
        });
      }

      /**
       * Wires click handlers on .xml-cell spans to open XML content in a new editor tab.
       */
      function wireXmlCellClicks() {
        var xmlCells = contentEl.querySelectorAll('.xml-cell');
        xmlCells.forEach(function(cell) {
          cell.addEventListener('click', function(e) {
            e.stopPropagation();
            var content = cell.getAttribute('data-content');
            var columnName = cell.getAttribute('data-column');
            vscode.postMessage({ type: 'openXml', content: content, columnName: columnName });
          });
        });
      }

      /**
       * Applies a column width to all th and td elements in the specified column.
       */
      function applyColumnWidth(rsIndex, colIndex, width) {
        var rsEl = contentEl.querySelector('.result-set[data-index="' + rsIndex + '"]');
        if (!rsEl) { return; }
        var table = rsEl.querySelector('table[data-rs-index="' + rsIndex + '"]');
        if (!table) { return; }

        // Apply to the header th
        var headerRow = table.querySelector('tr.header-row');
        if (headerRow) {
          var ths = headerRow.querySelectorAll('th');
          if (ths[colIndex]) {
            ths[colIndex].style.width = width + 'px';
            ths[colIndex].style.minWidth = width + 'px';
            ths[colIndex].style.maxWidth = width + 'px';
          }
        }

        // Apply to filter row td
        var filterRow = table.querySelector('tr.filter-row');
        if (filterRow) {
          var filterTds = filterRow.querySelectorAll('td');
          if (filterTds[colIndex]) {
            filterTds[colIndex].style.width = width + 'px';
            filterTds[colIndex].style.minWidth = width + 'px';
            filterTds[colIndex].style.maxWidth = width + 'px';
          }
        }

        // Apply to all body row tds at this column index
        var tbody = table.querySelector('tbody');
        if (tbody) {
          var bodyRows = tbody.querySelectorAll('tr');
          bodyRows.forEach(function(row) {
            var tds = row.querySelectorAll('td');
            if (tds[colIndex]) {
              tds[colIndex].style.width = width + 'px';
              tds[colIndex].style.minWidth = width + 'px';
              tds[colIndex].style.maxWidth = width + 'px';
            }
          });
        }
      }

      /**
       * Re-renders only the table body for a given result set index,
       * applying current filters and sort.
       */
      function rerenderTableBody(rsIndex) {
        var rows = getDisplayedRows(rsIndex);
        var rsEl = contentEl.querySelector('.result-set[data-index="' + rsIndex + '"]');
        var tbody = rsEl.querySelector('tbody');
        var state = resultSetStates[rsIndex];

        var html = '';
        for (var r = 0; r < rows.length; r++) {
          html += '<tr>';
          for (var c = 0; c < rows[r].length; c++) {
            var cell = rows[r][c];
            if (cell === null || cell === undefined) {
              html += '<td><span class="null-value">NULL</span></td>';
            } else if (isXmlContent(String(cell))) {
              var xmlStr = String(cell);
              var truncated = xmlStr.length > 100 ? xmlStr.substring(0, 100) + '...' : xmlStr;
              html += '<td><span class="xml-cell" data-content="' + escapeHtml(xmlStr).replace(/"/g, '&quot;') + '" data-column="' + escapeHtml(state.columns[c].name).replace(/"/g, '&quot;') + '">' + escapeHtml(truncated) + '</span></td>';
            } else {
              html += '<td>' + escapeHtml(String(cell)) + '</td>';
            }
          }
          html += '</tr>';
        }
        tbody.innerHTML = html;

        // Re-wire XML cell click handlers after re-render
        var xmlCells = rsEl.querySelectorAll('.xml-cell');
        xmlCells.forEach(function(cell) {
          cell.addEventListener('click', function(e) {
            e.stopPropagation();
            var content = cell.getAttribute('data-content');
            var columnName = cell.getAttribute('data-column');
            vscode.postMessage({ type: 'openXml', content: content, columnName: columnName });
          });
        });

        // Re-apply column widths after tbody rebuild (preserve resize state)
        var resizeState = columnResizeStates[rsIndex];
        if (resizeState) {
          for (var w = 0; w < resizeState.widths.length; w++) {
            if (resizeState.widths[w] > 0) {
              applyColumnWidth(rsIndex, w, resizeState.widths[w]);
            }
          }
        }

        // Update row count to reflect filtered count
        var rowCountEl = rsEl.querySelector('.row-count');
        var totalRows = state.originalRows.length;
        var displayedRows = rows.length;
        if (displayedRows === totalRows) {
          rowCountEl.textContent = totalRows + ' row' + (totalRows !== 1 ? 's' : '');
        } else {
          rowCountEl.textContent = displayedRows + ' of ' + totalRows + ' row' + (totalRows !== 1 ? 's' : '') + ' (filtered)';
        }
      }

      function renderAffectedRows(result) {
        contentEl.innerHTML = '<div class="message success">' +
          '<p><strong>' + result.rowsAffected + '</strong> row' + (result.rowsAffected !== 1 ? 's' : '') + ' affected</p>' +
          '<p class="status">Execution time: ' + result.executionTimeMs + ' ms</p>' +
          '</div>';
      }

      /**
       * Wires Show More button click handlers and updates visibility based on pagination state.
       * (Requirements 1.2, 1.5, 1.6, 1.7, 1.9, 1.10)
       */
      function wireShowMoreButtons() {
        for (var i = 0; i < paginationStates.length; i++) {
          var pState = paginationStates[i];
          var container = contentEl.querySelector('.show-more-container[data-rs-index="' + i + '"]');
          if (!container) { continue; }

          if (pState && pState.totalRowsAvailable > pState.loadedSoFar) {
            container.style.display = 'flex';
            var btn = container.querySelector('.show-more-btn');
            var remaining = pState.totalRowsAvailable - pState.loadedSoFar;
            btn.textContent = 'Show More (' + remaining.toLocaleString() + ' remaining)';
            btn.disabled = false;

            // Wire click handler
            (function(rsIndex) {
              btn.addEventListener('click', function() {
                requestBatch(rsIndex);
              });
            })(i);
          } else {
            container.style.display = 'none';
          }
        }
      }

      /**
       * Sends a requestBatch message to the extension host and disables the button.
       * (Requirements 1.3, 1.7, 1.10)
       */
      function requestBatch(rsIndex) {
        var container = contentEl.querySelector('.show-more-container[data-rs-index="' + rsIndex + '"]');
        if (!container) { return; }
        var btn = container.querySelector('.show-more-btn');
        if (btn.disabled) { return; } // Ignore duplicate clicks (Requirement 1.10)

        // Disable button and show loading state (Requirement 1.7)
        btn.disabled = true;
        btn.innerHTML = '<span class="btn-spinner"></span> Loading...';

        // Clear any previous error
        var errorEl = container.querySelector('.batch-error');
        if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }

        // Post requestBatch to extension host
        vscode.postMessage({ type: 'requestBatch', resultSetIndex: rsIndex });
      }

      /**
       * Handles appendBatch messages: appends new rows to the table DOM and updates button.
       * (Requirements 1.4, 1.5, 1.6, 1.9)
       */
      function handleAppendBatch(message) {
        var rows = message.rows;
        var totalRowsAvailable = message.totalRowsAvailable;
        var loadedSoFar = message.loadedSoFar;

        // Find the active result set index (use activeTabIndex for the target)
        var rsIndex = activeTabIndex;

        // Find the pagination state for this result set
        // Look for the first result set that has a matching pagination state
        for (var i = 0; i < paginationStates.length; i++) {
          if (paginationStates[i] !== null) {
            rsIndex = i;
            break;
          }
        }

        // Update pagination state
        if (paginationStates[rsIndex]) {
          paginationStates[rsIndex].loadedSoFar = loadedSoFar;
          paginationStates[rsIndex].totalRowsAvailable = totalRowsAvailable;
        }

        // Append rows to internal state
        var state = resultSetStates[rsIndex];
        if (state) {
          for (var r = 0; r < rows.length; r++) {
            state.originalRows.push(rows[r]);
          }
          state.rowCount = state.originalRows.length;
        }

        // Append rows to the table DOM
        var rsEl = contentEl.querySelector('.result-set[data-index="' + rsIndex + '"]');
        if (rsEl) {
          var tbody = rsEl.querySelector('tbody');
          if (tbody) {
            var html = '';
            for (var r = 0; r < rows.length; r++) {
              html += '<tr>';
              for (var c = 0; c < rows[r].length; c++) {
                var cell = rows[r][c];
                if (cell === null || cell === undefined) {
                  html += '<td><span class="null-value">NULL</span></td>';
                } else if (isXmlContent(String(cell))) {
                  var xmlStr = String(cell);
                  var truncated = xmlStr.length > 100 ? xmlStr.substring(0, 100) + '...' : xmlStr;
                  html += '<td><span class="xml-cell" data-content="' + escapeHtml(xmlStr).replace(/"/g, '&quot;') + '" data-column="">' + escapeHtml(truncated) + '</span></td>';
                } else {
                  html += '<td>' + escapeHtml(String(cell)) + '</td>';
                }
              }
              html += '</tr>';
            }
            tbody.insertAdjacentHTML('beforeend', html);

            // Re-wire XML cell clicks for newly appended rows
            var newXmlCells = tbody.querySelectorAll('tr:nth-last-child(-n+' + rows.length + ') .xml-cell');
            newXmlCells.forEach(function(cell) {
              cell.addEventListener('click', function(e) {
                e.stopPropagation();
                var content = cell.getAttribute('data-content');
                var columnName = cell.getAttribute('data-column');
                vscode.postMessage({ type: 'openXml', content: content, columnName: columnName });
              });
            });

            // Re-apply column widths to new rows
            var resizeState = columnResizeStates[rsIndex];
            if (resizeState) {
              for (var w = 0; w < resizeState.widths.length; w++) {
                if (resizeState.widths[w] > 0) {
                  applyColumnWidth(rsIndex, w, resizeState.widths[w]);
                }
              }
            }
          }

          // Update row count display
          var rowCountEl = rsEl.querySelector('.row-count');
          if (rowCountEl) {
            rowCountEl.textContent = loadedSoFar.toLocaleString() + ' row' + (loadedSoFar !== 1 ? 's' : '');
          }
        }

        // Update Show More button
        var container = contentEl.querySelector('.show-more-container[data-rs-index="' + rsIndex + '"]');
        if (container) {
          var btn = container.querySelector('.show-more-btn');
          if (loadedSoFar >= totalRowsAvailable) {
            // All rows loaded — hide button (Requirement 1.6)
            container.style.display = 'none';
            paginationStates[rsIndex] = null;
          } else {
            // More rows remain — update button text and re-enable (Requirement 1.5, 1.9)
            var remaining = totalRowsAvailable - loadedSoFar;
            btn.textContent = 'Show More (' + remaining.toLocaleString() + ' remaining)';
            btn.disabled = false;

            // Re-wire click handler (button content was replaced)
            var newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);
            (function(idx) {
              newBtn.addEventListener('click', function() {
                requestBatch(idx);
              });
            })(rsIndex);
          }
        }
      }

      /**
       * Handles batchError messages: shows error text and re-enables the button.
       * (Requirement 1.8)
       */
      function handleBatchError(message) {
        var errorMessage = message.message;

        // Find the result set with active pagination
        var rsIndex = activeTabIndex;
        for (var i = 0; i < paginationStates.length; i++) {
          if (paginationStates[i] !== null) {
            rsIndex = i;
            break;
          }
        }

        var container = contentEl.querySelector('.show-more-container[data-rs-index="' + rsIndex + '"]');
        if (container) {
          // Show error message below table (Requirement 1.8)
          var errorEl = container.querySelector('.batch-error');
          if (errorEl) {
            errorEl.textContent = errorMessage;
            errorEl.style.display = 'block';
          }

          // Re-enable the button so user can retry (Requirement 1.8)
          var btn = container.querySelector('.show-more-btn');
          if (btn && paginationStates[rsIndex]) {
            var remaining = paginationStates[rsIndex].totalRowsAvailable - paginationStates[rsIndex].loadedSoFar;
            btn.textContent = 'Show More (' + remaining.toLocaleString() + ' remaining)';
            btn.disabled = false;

            // Re-wire click handler
            var newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);
            (function(idx) {
              newBtn.addEventListener('click', function() {
                requestBatch(idx);
              });
            })(rsIndex);
          }
        }
      }

    })();
  </script>
</body>
</html>`;
  }
}
