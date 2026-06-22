import * as mssql from 'mssql';
import { QueryResult } from './types';

/**
 * Webview Message Protocol
 *
 * Defines the message types exchanged between the extension host
 * and the Results Panel webview via postMessage.
 */

// ─── Extension → Webview ────────────────────────────────────────────────────

/**
 * Sends query result data to the webview for rendering.
 */
export interface WebviewDataMessage {
  type: 'data';
  result: QueryResult;
}

/**
 * Signals the webview to display a progress/loading indicator.
 */
export interface WebviewProgressMessage {
  type: 'progress';
}

/**
 * Signals the webview that query execution was cancelled.
 */
export interface WebviewCancelledMessage {
  type: 'cancelled';
}

/**
 * Signals the webview to switch display mode (single/split).
 */
export interface WebviewDisplayModeMessage {
  type: 'displayMode';
  mode: 'single' | 'split';
}

/**
 * Sends an additional batch of rows to the webview for appending to an existing result set.
 */
export interface WebviewAppendBatchMessage {
  type: 'appendBatch';
  rows: any[][];
  totalRowsAvailable: number;
  loadedSoFar: number;
}

/**
 * Signals the webview that a batch loading operation failed.
 */
export interface WebviewBatchErrorMessage {
  type: 'batchError';
  message: string;
}

/**
 * Union of all messages sent from the extension host to the webview.
 */
export type ExtensionToWebviewMessage =
  | WebviewDataMessage
  | WebviewProgressMessage
  | WebviewCancelledMessage
  | WebviewDisplayModeMessage
  | WebviewAppendBatchMessage
  | WebviewBatchErrorMessage;

// ─── Webview → Extension ────────────────────────────────────────────────────

/**
 * Sent from the webview when the user switches between result set tabs.
 */
export interface WebviewTabSwitchMessage {
  type: 'switchTab';
  tabIndex: number;
}

/**
 * Supported export formats for result set data.
 */
export type ExportFormat = 'csv' | 'json' | 'excel' | 'insert' | 'createInsert' | 'text' | 'markdown';

/**
 * Sent from the webview when the user clicks an export button in the toolbar.
 */
export interface WebviewExportMessage {
  type: 'export';
  format: ExportFormat;
  activeTabIndex: number;
  /** Current sort state for the active result set (null if no sort applied) */
  sortColumn: number | null;
  /** Sort direction (only meaningful when sortColumn is set) */
  sortDirection: 'asc' | 'desc';
  /** Per-column filter values (empty string means no filter for that column) */
  filters: string[];
}

/**
 * Sent from the webview when the user clicks an XML cell to open it in an editor.
 */
export interface WebviewOpenXmlMessage {
  type: 'openXml';
  /** The full XML content of the cell */
  content: string;
  /** The column name from query result metadata */
  columnName: string;
}

/**
 * Sent from the webview when the user clicks "Show More" to request the next batch of rows.
 */
export interface WebviewRequestBatchMessage {
  type: 'requestBatch';
  resultSetIndex: number;
}

/**
 * Union of all messages sent from the webview to the extension host.
 */
export type WebviewToExtensionMessage = WebviewTabSwitchMessage | WebviewExportMessage | WebviewOpenXmlMessage | WebviewRequestBatchMessage;


// ─── Pagination State ───────────────────────────────────────────────────────

/**
 * Tracks the state of a paginated query for fetching additional batches.
 * Maintained by the ResultPanelProvider in the extension host.
 */
export interface PaginatedQueryState {
  originalSql: string;
  pool: mssql.ConnectionPool;
  totalRowsAvailable: number;
  loadedRows: number;
  batchSize: number; // always 10_000
  resultSetIndex: number;
}
