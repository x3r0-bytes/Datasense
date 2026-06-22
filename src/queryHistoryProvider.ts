import * as vscode from 'vscode';
import { HistoryRecord, IQueryHistoryStore } from './queryHistoryStore';

// ─── Tree Item ──────────────────────────────────────────────────────────────

export class HistoryTreeItem extends vscode.TreeItem {
  constructor(public readonly record: HistoryRecord) {
    super(formatHistoryLabel(record.sql), vscode.TreeItemCollapsibleState.None);
    this.description = formatHistoryDescription(record);
    this.tooltip = record.sql;
    this.contextValue = 'historyRecord';
    this.command = {
      command: 'sqlServer.queryHistoryOpen',
      title: 'Open Query',
      arguments: [record],
    };
    this.iconPath = new vscode.ThemeIcon(record.success ? 'check' : 'error');
  }
}

// ─── Provider Interface ─────────────────────────────────────────────────────

export interface IQueryHistoryProvider extends vscode.TreeDataProvider<HistoryTreeItem> {
  refresh(): void;
  setFilter(text: string): void;
}

// ─── Pure Helper Functions ──────────────────────────────────────────────────

/**
 * Formats the tree item label: first 80 chars of SQL with leading whitespace trimmed.
 * If trimmed length ≤ 80, returns the full trimmed text.
 */
export function formatHistoryLabel(sql: string): string {
  const trimmed = sql.trimStart();
  if (trimmed.length <= 80) {
    return trimmed;
  }
  return trimmed.substring(0, 80);
}

/**
 * Formats the tree item description: "connectionName • databaseName • 2m ago"
 */
export function formatHistoryDescription(record: HistoryRecord): string {
  const relativeTime = formatRelativeTime(record.timestamp);
  return `${record.connectionName} • ${record.databaseName} • ${relativeTime}`;
}

/**
 * Formats a relative timestamp string.
 * - <60s → "just now"
 * - <60m → "Xm ago"
 * - <24h → "Xh ago"
 * - <7d → "Xd ago"
 * - else → date string (e.g., "Jan 15")
 */
export function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) {
    return 'just now';
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }

  // Older than 7 days: show date string (e.g., "Jan 15")
  const date = new Date(timestamp);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getMonth()]} ${date.getDate()}`;
}

// ─── Provider Implementation ────────────────────────────────────────────────

export class QueryHistoryProvider implements IQueryHistoryProvider {
  private _onDidChangeTreeData = new vscode.EventEmitter<HistoryTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private filter: string = '';

  constructor(private readonly store: IQueryHistoryStore) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setFilter(text: string): void {
    this.filter = text;
    this.refresh();
  }

  getTreeItem(element: HistoryTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.ProviderResult<HistoryTreeItem[]> {
    const records = this.filter
      ? this.store.search(this.filter)
      : this.store.getRecords();

    // Empty history: show welcome message
    if (!this.filter && records.length === 0) {
      const emptyItem = new vscode.TreeItem('No queries executed yet', vscode.TreeItemCollapsibleState.None);
      emptyItem.contextValue = 'empty';
      return [emptyItem as unknown as HistoryTreeItem];
    }

    // Search with no results
    if (this.filter && records.length === 0) {
      const noResultsItem = new vscode.TreeItem('No results found', vscode.TreeItemCollapsibleState.None);
      noResultsItem.contextValue = 'noResults';
      return [noResultsItem as unknown as HistoryTreeItem];
    }

    return records.map(record => new HistoryTreeItem(record));
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
