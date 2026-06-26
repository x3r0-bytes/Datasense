/**
 * Diff Panel — Webview-based Schema Comparison Results Display
 *
 * Renders schema diff results in an interactive webview panel with:
 * - Summary header showing difference counts by category
 * - Expandable sections for tables to create, tables only in target, and modified tables
 * - Side-by-side source vs target column/index/constraint comparisons
 * - "Generate ALTER Script" button with "Include DROP statements" checkbox
 * - Progress indicator for large comparisons (>100 tables)
 * - VS Code theme-aware styling (dark/light mode support)
 */

import * as vscode from 'vscode';
import {
  SchemaDiff,
  TableSnapshot,
  TableDiff,
  ColumnSnapshot,
  ColumnDiff,
  IndexDiff,
  ConstraintDiff,
  IndexSnapshot,
  ConstraintSnapshot,
} from './schemaDiffTypes';

export class DiffPanel {
  private panel: vscode.WebviewPanel | undefined;
  private currentDiff: SchemaDiff | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /**
   * Create or reveal the diff panel webview.
   * If the panel already exists, it is revealed and content is updated.
   */
  show(diff: SchemaDiff): void {
    this.currentDiff = diff;

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      this.panel.webview.html = this.getHtmlContent(diff, this.panel.webview);
      return;
    }

    const title = `Schema Diff: ${diff.source.database}.${diff.source.schemaName} vs ${diff.target.database}.${diff.target.schemaName}`;

    this.panel = vscode.window.createWebviewPanel(
      'schemaDiff',
      title,
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'SchemaDiff.png');

    this.panel.webview.html = this.getHtmlContent(diff, this.panel.webview);

    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      undefined
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.currentDiff = undefined;
    });
  }

  /**
   * Generate full HTML content for the webview.
   */
  getHtmlContent(diff: SchemaDiff, webview: vscode.Webview): string {
    const isEmpty =
      diff.tablesOnlyInSource.length === 0 &&
      diff.tablesOnlyInTarget.length === 0 &&
      diff.modifiedTables.length === 0;

    const totalTables =
      diff.tablesOnlyInSource.length +
      diff.tablesOnlyInTarget.length +
      diff.modifiedTables.length;

    const showProgress = totalTables > 100;

    let bodyContent: string;

    if (isEmpty) {
      bodyContent = this.renderEmptyDiff(diff);
    } else {
      bodyContent = this.renderDiffContent(diff, showProgress);
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Schema Diff</title>
  <style>${this.getStyles()}</style>
</head>
<body>
  ${bodyContent}
  <script>${this.getScript()}</script>
</body>
</html>`;
  }

  /**
   * Handle messages from the webview (e.g., "generateAlterScript").
   */
  handleMessage(message: { command: string; includeDrops?: boolean }): void {
    switch (message.command) {
      case 'generateAlterScript':
        vscode.commands.executeCommand(
          'sqlServer.generateAlterScript',
          this.currentDiff,
          message.includeDrops ?? false
        );
        break;
    }
  }

  /**
   * Dispose the webview panel and clean up resources.
   */
  dispose(): void {
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
      this.currentDiff = undefined;
    }
  }

  // ─── Private Rendering Methods ────────────────────────────────────────────────

  private renderEmptyDiff(diff: SchemaDiff): string {
    return `
      <div class="empty-diff">
        <div class="empty-icon">✓</div>
        <h2>No structural differences found between ${this.escapeHtml(diff.source.database)}.${this.escapeHtml(diff.source.schemaName)} and ${this.escapeHtml(diff.target.database)}.${this.escapeHtml(diff.target.schemaName)}</h2>
        <p class="empty-subtitle">Source: ${this.escapeHtml(diff.source.connectionName)} | Target: ${this.escapeHtml(diff.target.connectionName)}</p>
      </div>`;
  }

  private renderDiffContent(diff: SchemaDiff, showProgress: boolean): string {
    const sections: string[] = [];

    // Progress indicator for large comparisons
    if (showProgress) {
      sections.push(`<div class="progress-indicator" id="progressIndicator">
        <span class="spinner"></span> Processing comparison results...
      </div>`);
    }

    // Summary header
    sections.push(this.renderSummaryHeader(diff));

    // Action bar with Generate ALTER Script button
    sections.push(this.renderActionBar());

    // Tables to Create in Target (tablesOnlyInSource)
    if (diff.tablesOnlyInSource.length > 0) {
      sections.push(this.renderTablesOnlyInSource(diff.tablesOnlyInSource));
    }

    // Tables Only in Target (not in Source)
    if (diff.tablesOnlyInTarget.length > 0) {
      sections.push(this.renderTablesOnlyInTarget(diff.tablesOnlyInTarget));
    }

    // Modified Tables
    if (diff.modifiedTables.length > 0) {
      sections.push(this.renderModifiedTables(diff.modifiedTables));
    }

    return sections.join('\n');
  }

  private renderSummaryHeader(diff: SchemaDiff): string {
    const parts: string[] = [];

    if (diff.summary.tablesToCreate > 0) {
      parts.push(`<span class="badge badge-added">${diff.summary.tablesToCreate} table${diff.summary.tablesToCreate !== 1 ? 's' : ''} to create</span>`);
    }
    if (diff.summary.tablesModified > 0) {
      parts.push(`<span class="badge badge-modified">${diff.summary.tablesModified} table${diff.summary.tablesModified !== 1 ? 's' : ''} modified</span>`);
    }
    if (diff.summary.tablesOnlyInTarget > 0) {
      parts.push(`<span class="badge badge-removed">${diff.summary.tablesOnlyInTarget} table${diff.summary.tablesOnlyInTarget !== 1 ? 's' : ''} only in target</span>`);
    }

    const sourceLabel = `${this.escapeHtml(diff.source.connectionName)} / ${this.escapeHtml(diff.source.database)}.${this.escapeHtml(diff.source.schemaName)}`;
    const targetLabel = `${this.escapeHtml(diff.target.connectionName)} / ${this.escapeHtml(diff.target.database)}.${this.escapeHtml(diff.target.schemaName)}`;

    return `
      <div class="summary-header">
        <h1>Schema Diff: ${this.escapeHtml(diff.source.database)}.${this.escapeHtml(diff.source.schemaName)} → ${this.escapeHtml(diff.target.database)}.${this.escapeHtml(diff.target.schemaName)}</h1>
        <p class="connections">Source: ${sourceLabel} | Target: ${targetLabel}</p>
        <div class="summary-badges">${parts.join(' ')}</div>
        <p class="total-differences">${diff.summary.totalDifferences} total difference${diff.summary.totalDifferences !== 1 ? 's' : ''}</p>
      </div>`;
  }

  private renderActionBar(): string {
    return `
      <div class="action-bar">
        <button class="btn-primary" id="generateScriptBtn">Generate ALTER Script</button>
        <label class="checkbox-label">
          <input type="checkbox" id="includeDrops" />
          Include DROP statements
        </label>
      </div>`;
  }

  private renderTablesOnlyInSource(tables: TableSnapshot[]): string {
    const tableRows = tables.map(table => this.renderTableSnapshot(table)).join('');

    return `
      <div class="section">
        <h2 class="section-title section-added">Tables to Create in Target (${tables.length})</h2>
        ${tableRows}
      </div>`;
  }

  private renderTablesOnlyInTarget(tables: TableSnapshot[]): string {
    const tableRows = tables.map(table => this.renderTableSnapshot(table)).join('');

    return `
      <div class="section">
        <h2 class="section-title section-removed">Tables Only in Target (not in Source) (${tables.length})</h2>
        ${tableRows}
      </div>`;
  }

  private renderTableSnapshot(table: TableSnapshot): string {
    const fullName = `${this.escapeHtml(table.schema)}.${this.escapeHtml(table.name)}`;
    const columnRows = table.columns.map(col => `
      <tr>
        <td>${this.escapeHtml(col.name)}</td>
        <td>${this.escapeHtml(col.dataType)}</td>
        <td>${col.isNullable ? 'YES' : 'NO'}</td>
        <td>${col.defaultValue ? this.escapeHtml(col.defaultValue) : '—'}</td>
        <td>${col.isIdentity ? `IDENTITY(${col.identitySeed ?? 1},${col.identityIncrement ?? 1})` : '—'}</td>
      </tr>`).join('');

    return `
      <details class="table-details">
        <summary class="table-name">${fullName}</summary>
        <table class="column-table">
          <thead>
            <tr>
              <th>Column</th>
              <th>Data Type</th>
              <th>Nullable</th>
              <th>Default</th>
              <th>Identity</th>
            </tr>
          </thead>
          <tbody>${columnRows}</tbody>
        </table>
      </details>`;
  }

  private renderModifiedTables(tables: TableDiff[]): string {
    const tableRows = tables.map(table => this.renderTableDiff(table)).join('');

    return `
      <div class="section">
        <h2 class="section-title section-modified">Modified Tables (${tables.length})</h2>
        ${tableRows}
      </div>`;
  }

  private renderTableDiff(table: TableDiff): string {
    const fullName = `${this.escapeHtml(table.schema)}.${this.escapeHtml(table.name)}`;
    const subsections: string[] = [];

    // Column diffs
    if (table.columnDiffs.length > 0) {
      subsections.push(this.renderColumnDiffs(table.columnDiffs));
    }

    // Index diffs
    if (table.indexDiffs.length > 0) {
      subsections.push(this.renderIndexDiffs(table.indexDiffs));
    }

    // Constraint diffs
    if (table.constraintDiffs.length > 0) {
      subsections.push(this.renderConstraintDiffs(table.constraintDiffs));
    }

    return `
      <details class="table-details" open>
        <summary class="table-name">${fullName}</summary>
        <div class="table-diff-content">
          ${subsections.join('\n')}
        </div>
      </details>`;
  }

  private renderColumnDiffs(diffs: ColumnDiff[]): string {
    const rows = diffs.map(diff => {
      const typeClass = `diff-${diff.type}`;
      const typeLabel = diff.type.charAt(0).toUpperCase() + diff.type.slice(1);

      if (diff.type === 'added') {
        return `
          <tr class="${typeClass}">
            <td><span class="diff-badge badge-added">${typeLabel}</span></td>
            <td>${this.escapeHtml(diff.columnName)}</td>
            <td class="source-col">—</td>
            <td class="target-col">${this.renderColumnSnapshot(diff.target!)}</td>
          </tr>`;
      } else if (diff.type === 'removed') {
        return `
          <tr class="${typeClass}">
            <td><span class="diff-badge badge-removed">${typeLabel}</span></td>
            <td>${this.escapeHtml(diff.columnName)}</td>
            <td class="source-col">${this.renderColumnSnapshot(diff.source!)}</td>
            <td class="target-col">—</td>
          </tr>`;
      } else {
        return `
          <tr class="${typeClass}">
            <td><span class="diff-badge badge-modified">${typeLabel}</span></td>
            <td>${this.escapeHtml(diff.columnName)}</td>
            <td class="source-col">${this.renderColumnSnapshot(diff.source!)}</td>
            <td class="target-col">${this.renderColumnSnapshot(diff.target!)}</td>
          </tr>`;
      }
    }).join('');

    return `
      <details class="sub-section" open>
        <summary class="sub-section-title">Columns (${diffs.length} change${diffs.length !== 1 ? 's' : ''})</summary>
        <table class="diff-table">
          <thead>
            <tr>
              <th>Change</th>
              <th>Column</th>
              <th>Source</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </details>`;
  }

  private renderIndexDiffs(diffs: IndexDiff[]): string {
    const rows = diffs.map(diff => {
      const typeClass = `diff-${diff.type}`;
      const typeLabel = diff.type.charAt(0).toUpperCase() + diff.type.slice(1);

      if (diff.type === 'added') {
        return `
          <tr class="${typeClass}">
            <td><span class="diff-badge badge-added">${typeLabel}</span></td>
            <td>${this.escapeHtml(diff.indexName)}</td>
            <td class="source-col">—</td>
            <td class="target-col">${this.renderIndexSnapshot(diff.target!)}</td>
          </tr>`;
      } else if (diff.type === 'removed') {
        return `
          <tr class="${typeClass}">
            <td><span class="diff-badge badge-removed">${typeLabel}</span></td>
            <td>${this.escapeHtml(diff.indexName)}</td>
            <td class="source-col">${this.renderIndexSnapshot(diff.source!)}</td>
            <td class="target-col">—</td>
          </tr>`;
      } else {
        return `
          <tr class="${typeClass}">
            <td><span class="diff-badge badge-modified">${typeLabel}</span></td>
            <td>${this.escapeHtml(diff.indexName)}</td>
            <td class="source-col">${this.renderIndexSnapshot(diff.source!)}</td>
            <td class="target-col">${this.renderIndexSnapshot(diff.target!)}</td>
          </tr>`;
      }
    }).join('');

    return `
      <details class="sub-section" open>
        <summary class="sub-section-title">Indexes (${diffs.length} change${diffs.length !== 1 ? 's' : ''})</summary>
        <table class="diff-table">
          <thead>
            <tr>
              <th>Change</th>
              <th>Index</th>
              <th>Source</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </details>`;
  }

  private renderConstraintDiffs(diffs: ConstraintDiff[]): string {
    const rows = diffs.map(diff => {
      const typeClass = `diff-${diff.type}`;
      const typeLabel = diff.type.charAt(0).toUpperCase() + diff.type.slice(1);

      if (diff.type === 'added') {
        return `
          <tr class="${typeClass}">
            <td><span class="diff-badge badge-added">${typeLabel}</span></td>
            <td>${this.escapeHtml(diff.constraintName)}</td>
            <td>${this.escapeHtml(diff.constraintType)}</td>
            <td class="source-col">—</td>
            <td class="target-col">${this.renderConstraintSnapshot(diff.target!)}</td>
          </tr>`;
      } else if (diff.type === 'removed') {
        return `
          <tr class="${typeClass}">
            <td><span class="diff-badge badge-removed">${typeLabel}</span></td>
            <td>${this.escapeHtml(diff.constraintName)}</td>
            <td>${this.escapeHtml(diff.constraintType)}</td>
            <td class="source-col">${this.renderConstraintSnapshot(diff.source!)}</td>
            <td class="target-col">—</td>
          </tr>`;
      } else {
        return `
          <tr class="${typeClass}">
            <td><span class="diff-badge badge-modified">${typeLabel}</span></td>
            <td>${this.escapeHtml(diff.constraintName)}</td>
            <td>${this.escapeHtml(diff.constraintType)}</td>
            <td class="source-col">${this.renderConstraintSnapshot(diff.source!)}</td>
            <td class="target-col">${this.renderConstraintSnapshot(diff.target!)}</td>
          </tr>`;
      }
    }).join('');

    return `
      <details class="sub-section" open>
        <summary class="sub-section-title">Constraints (${diffs.length} change${diffs.length !== 1 ? 's' : ''})</summary>
        <table class="diff-table">
          <thead>
            <tr>
              <th>Change</th>
              <th>Constraint</th>
              <th>Type</th>
              <th>Source</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </details>`;
  }

  private renderColumnSnapshot(col: ColumnSnapshot): string {
    const parts: string[] = [
      this.escapeHtml(col.dataType),
      col.isNullable ? 'NULL' : 'NOT NULL',
    ];
    if (col.defaultValue) {
      parts.push(`DEFAULT ${this.escapeHtml(col.defaultValue)}`);
    }
    if (col.isIdentity) {
      parts.push(`IDENTITY(${col.identitySeed ?? 1},${col.identityIncrement ?? 1})`);
    }
    return `<code>${parts.join(', ')}</code>`;
  }

  private renderIndexSnapshot(idx: IndexSnapshot): string {
    const parts: string[] = [
      this.escapeHtml(idx.type),
      idx.isUnique ? 'UNIQUE' : '',
      `(${idx.columns.map(c => this.escapeHtml(c)).join(', ')})`,
    ].filter(p => p.length > 0);

    if (idx.includedColumns.length > 0) {
      parts.push(`INCLUDE (${idx.includedColumns.map(c => this.escapeHtml(c)).join(', ')})`);
    }
    return `<code>${parts.join(' ')}</code>`;
  }

  private renderConstraintSnapshot(constraint: ConstraintSnapshot): string {
    const parts: string[] = [
      `(${constraint.columns.map(c => this.escapeHtml(c)).join(', ')})`,
    ];
    if (constraint.definition) {
      parts.push(this.escapeHtml(constraint.definition));
    }
    return `<code>${parts.join(' ')}</code>`;
  }

  // ─── Styles ───────────────────────────────────────────────────────────────────

  private getStyles(): string {
    return `
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
        padding: 20px 30px;
        line-height: 1.6;
      }

      h1 {
        font-size: 1.4em;
        font-weight: 600;
        margin-bottom: 4px;
        color: var(--vscode-foreground);
      }

      h2 {
        font-size: 1.15em;
        font-weight: 600;
        margin-bottom: 12px;
      }

      .connections {
        color: var(--vscode-descriptionForeground);
        font-size: 0.9em;
        margin-bottom: 8px;
      }

      /* ─── Empty Diff ─── */
      .empty-diff {
        text-align: center;
        padding: 60px 20px;
      }

      .empty-icon {
        font-size: 3em;
        color: var(--vscode-testing-iconPassed, #73c991);
        margin-bottom: 16px;
      }

      .empty-diff h2 {
        font-weight: 500;
        margin-bottom: 8px;
      }

      .empty-subtitle {
        color: var(--vscode-descriptionForeground);
        font-size: 0.9em;
      }

      /* ─── Summary Header ─── */
      .summary-header {
        margin-bottom: 20px;
        padding-bottom: 16px;
        border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      }

      .summary-badges {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 6px;
      }

      .badge {
        display: inline-block;
        padding: 2px 10px;
        border-radius: 12px;
        font-size: 0.85em;
        font-weight: 500;
      }

      .badge-added {
        background-color: rgba(51, 153, 51, 0.2);
        color: var(--vscode-testing-iconPassed, #73c991);
        border: 1px solid rgba(51, 153, 51, 0.4);
      }

      .badge-removed {
        background-color: rgba(204, 51, 51, 0.2);
        color: var(--vscode-testing-iconFailed, #f48771);
        border: 1px solid rgba(204, 51, 51, 0.4);
      }

      .badge-modified {
        background-color: rgba(204, 153, 0, 0.2);
        color: var(--vscode-editorWarning-foreground, #cca700);
        border: 1px solid rgba(204, 153, 0, 0.4);
      }

      .total-differences {
        color: var(--vscode-descriptionForeground);
        font-size: 0.85em;
      }

      /* ─── Action Bar ─── */
      .action-bar {
        display: flex;
        align-items: center;
        gap: 16px;
        margin-bottom: 24px;
        padding: 12px 16px;
        background-color: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
        border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
        border-radius: 4px;
      }

      .btn-primary {
        padding: 6px 14px;
        border: none;
        border-radius: 2px;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        cursor: pointer;
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        outline: none;
      }

      .btn-primary:hover {
        background-color: var(--vscode-button-hoverBackground);
      }

      .btn-primary:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 1px;
      }

      .checkbox-label {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.9em;
        cursor: pointer;
        color: var(--vscode-foreground);
      }

      .checkbox-label input[type="checkbox"] {
        accent-color: var(--vscode-focusBorder);
      }

      /* ─── Sections ─── */
      .section {
        margin-bottom: 28px;
      }

      .section-title {
        padding: 8px 12px;
        border-radius: 4px;
        margin-bottom: 12px;
      }

      .section-added {
        background-color: rgba(51, 153, 51, 0.1);
        border-left: 3px solid var(--vscode-testing-iconPassed, #73c991);
      }

      .section-removed {
        background-color: rgba(204, 51, 51, 0.1);
        border-left: 3px solid var(--vscode-testing-iconFailed, #f48771);
      }

      .section-modified {
        background-color: rgba(204, 153, 0, 0.1);
        border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700);
      }

      /* ─── Table Details ─── */
      .table-details {
        margin-bottom: 12px;
        border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
        border-radius: 4px;
        overflow: hidden;
      }

      .table-details summary {
        cursor: pointer;
        padding: 8px 12px;
        font-weight: 500;
        background-color: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
        user-select: none;
      }

      .table-details summary:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .table-diff-content {
        padding: 8px 12px;
      }

      /* ─── Sub-sections ─── */
      .sub-section {
        margin-bottom: 12px;
      }

      .sub-section-title {
        cursor: pointer;
        font-weight: 500;
        font-size: 0.95em;
        padding: 4px 8px;
        margin-bottom: 8px;
        color: var(--vscode-foreground);
        user-select: none;
      }

      .sub-section-title:hover {
        color: var(--vscode-textLink-foreground);
      }

      /* ─── Tables ─── */
      .column-table,
      .diff-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.9em;
        margin-bottom: 8px;
      }

      .column-table th,
      .diff-table th {
        text-align: left;
        padding: 6px 10px;
        font-weight: 600;
        background-color: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
        border-bottom: 2px solid var(--vscode-widget-border, var(--vscode-panel-border));
        color: var(--vscode-foreground);
      }

      .column-table td,
      .diff-table td {
        padding: 5px 10px;
        border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
        vertical-align: top;
      }

      .diff-table .source-col {
        background-color: rgba(51, 153, 51, 0.05);
      }

      .diff-table .target-col {
        background-color: rgba(204, 51, 51, 0.05);
      }

      .diff-table tr.diff-added td {
        background-color: rgba(51, 153, 51, 0.08);
      }

      .diff-table tr.diff-removed td {
        background-color: rgba(204, 51, 51, 0.08);
      }

      .diff-table tr.diff-modified td {
        background-color: rgba(204, 153, 0, 0.08);
      }

      .diff-badge {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 3px;
        font-size: 0.8em;
        font-weight: 500;
      }

      code {
        font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
        font-size: 0.9em;
        color: var(--vscode-textPreformat-foreground, var(--vscode-foreground));
      }

      /* ─── Progress Indicator ─── */
      .progress-indicator {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 16px;
        margin-bottom: 16px;
        background-color: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
        border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
        border-radius: 4px;
        font-size: 0.9em;
        color: var(--vscode-descriptionForeground);
      }

      .spinner {
        display: inline-block;
        width: 14px;
        height: 14px;
        border: 2px solid var(--vscode-descriptionForeground);
        border-top-color: transparent;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      .progress-indicator.hidden {
        display: none;
      }
    `;
  }

  // ─── Script ───────────────────────────────────────────────────────────────────

  private getScript(): string {
    return `
      (function() {
        const vscode = acquireVsCodeApi();

        // Generate ALTER Script button
        const generateBtn = document.getElementById('generateScriptBtn');
        const includeDropsCheckbox = document.getElementById('includeDrops');

        if (generateBtn) {
          generateBtn.addEventListener('click', function() {
            const includeDrops = includeDropsCheckbox ? includeDropsCheckbox.checked : false;
            vscode.postMessage({
              command: 'generateAlterScript',
              includeDrops: includeDrops
            });
          });
        }

        // Hide progress indicator after content has rendered
        const progressEl = document.getElementById('progressIndicator');
        if (progressEl) {
          setTimeout(function() {
            progressEl.classList.add('hidden');
          }, 500);
        }
      })();
    `;
  }

  // ─── Utilities ────────────────────────────────────────────────────────────────

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
