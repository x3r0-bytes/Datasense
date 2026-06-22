// Execution Plan Panel
// Webview-based panel for rendering SQL Server execution plans as interactive
// left-to-right tree visualizations with cost highlighting and tooltips.

import * as vscode from 'vscode';
import { ExecutionPlanResult, PlanOperator, PlanStatement, MissingIndexSuggestion } from './executionPlanParser';

/**
 * Renders the HTML for a single operator node.
 * Exported for testability (Property 15, 16).
 */
export function renderOperatorNodeHtml(operator: PlanOperator): string {
  const costPct = Math.round(operator.costPercentage);
  const rows = Math.round(operator.estimatedRows);
  const isHighlighted = operator.costPercentage > 25;

  // Determine if this is an Index Seek or Index Scan for labeling
  const physicalOpLower = operator.physicalOp.toLowerCase();
  const isIndexSeek = physicalOpLower.includes('seek');
  const isIndexScan = physicalOpLower.includes('scan') && physicalOpLower.includes('index');
  let operatorLabel = '';
  if (isIndexSeek) {
    operatorLabel = '<span class="op-label seek-label">Seek</span>';
  } else if (isIndexScan) {
    operatorLabel = '<span class="op-label scan-label">Scan</span>';
  }

  // Index name display
  const indexNameHtml = operator.indexName
    ? `<div class="index-name" title="${escapeHtml(operator.indexName)}">${escapeHtml(operator.indexName)}</div>`
    : '';

  // Build tooltip content
  const tooltipLines: string[] = [
    `Physical Op: ${escapeHtml(operator.physicalOp)}`,
    `Logical Op: ${escapeHtml(operator.logicalOp)}`,
    `Est. I/O Cost: ${operator.estimatedIOCost.toFixed(7)}`,
    `Est. CPU Cost: ${operator.estimatedCPUCost.toFixed(7)}`,
    `Est. Rows: ${operator.estimatedRows.toFixed(1)}`,
  ];

  if (operator.actualRows !== undefined) {
    tooltipLines.push(`Actual Rows: ${operator.actualRows}`);
  }

  if (operator.outputColumns.length > 0) {
    tooltipLines.push(`Output Columns: ${escapeHtml(operator.outputColumns.join(', '))}`);
  }

  const predicateKeys = Object.keys(operator.predicates);
  if (predicateKeys.length > 0) {
    tooltipLines.push('Predicates:');
    for (const key of predicateKeys) {
      tooltipLines.push(`  ${escapeHtml(key)}: ${escapeHtml(operator.predicates[key])}`);
    }
  }

  const tooltipContent = tooltipLines.join('\n');

  const highlightClass = isHighlighted ? ' highlighted' : '';

  return `<div class="operator-node${highlightClass}" data-tooltip="${escapeAttr(tooltipContent)}">
  <div class="op-name">${escapeHtml(operator.physicalOp)}${operatorLabel}</div>
  <div class="op-cost">${costPct}%</div>
  <div class="op-rows">${rows} rows</div>
  ${indexNameHtml}
</div>`;
}

/**
 * Manages a WebviewPanel that displays execution plan visualizations.
 * Creates a new panel per invocation (or reuses existing if one is open).
 */
export class ExecutionPlanPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /**
   * Opens or reveals the plan panel and renders the given parsed plan.
   */
  show(plan: ExecutionPlanResult): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'executionPlan',
        'Execution Plan',
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          localResourceRoots: [this.extensionUri],
        }
      );

      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }

    this.panel.webview.html = this.generateHtml(plan);
  }

  /**
   * Disposes the webview panel.
   */
  dispose(): void {
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }
  }

  /**
   * Generates the full HTML content for the execution plan webview.
   */
  private generateHtml(plan: ExecutionPlanResult): string {
    // Handle empty plan
    if (plan.statements.length === 0) {
      return this.generateInfoHtml('No execution plan data available.');
    }

    const statementsHtml = plan.statements.map(stmt => this.generateStatementHtml(stmt)).join('\n');
    const missingIndexHtml = this.generateMissingIndexHtml(plan.missingIndexes);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Execution Plan</title>
  <style>${this.getCss()}</style>
</head>
<body>
  <div class="plan-container">
    ${statementsHtml}
    ${missingIndexHtml}
  </div>
  <div class="tooltip" id="tooltip"></div>
  <script>${this.getJs()}</script>
</body>
</html>`;
  }

  /**
   * Generates HTML for an informational/error message.
   */
  private generateInfoHtml(message: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Execution Plan</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 200px;
    }
    .info-message {
      padding: 16px 24px;
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 4px;
      background-color: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      color: var(--vscode-foreground);
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="info-message">${escapeHtml(message)}</div>
</body>
</html>`;
  }

  /**
   * Generates HTML for a single statement section.
   */
  private generateStatementHtml(stmt: PlanStatement): string {
    const truncatedText = stmt.statementText.length > 80
      ? stmt.statementText.substring(0, 80) + '...'
      : stmt.statementText;

    const headerText = `Statement ${stmt.statementIndex}: ${escapeHtml(truncatedText)}`;
    const treeHtml = this.generateTreeHtml(stmt.rootOperator);

    return `<div class="statement-section">
  <h2 class="statement-header">${headerText}</h2>
  <div class="tree-container">
    ${treeHtml}
  </div>
</div>`;
  }

  /**
   * Recursively generates the tree HTML for an operator and its children.
   * Layout: parent on the left, children on the right (data flows right-to-left).
   */
  private generateTreeHtml(operator: PlanOperator): string {
    const nodeHtml = renderOperatorNodeHtml(operator);

    if (operator.children.length === 0) {
      return `<div class="tree-node">
  ${nodeHtml}
</div>`;
    }

    const childrenHtml = operator.children
      .map(child => this.generateTreeHtml(child))
      .join('\n');

    return `<div class="tree-node">
  ${nodeHtml}
  <div class="tree-children">
    ${childrenHtml}
  </div>
</div>`;
  }

  /**
   * Generates HTML for missing index suggestions.
   */
  private generateMissingIndexHtml(suggestions: MissingIndexSuggestion[]): string {
    if (suggestions.length === 0) {
      return '';
    }

    const indexStatements = suggestions.map(s => {
      const keyColumns: string[] = [...s.equalityColumns, ...s.inequalityColumns];
      let createStmt = `CREATE INDEX [IX_Suggested] ON ${s.table} (${keyColumns.join(', ')})`;
      if (s.includedColumns.length > 0) {
        createStmt += ` INCLUDE (${s.includedColumns.join(', ')})`;
      }
      return createStmt;
    });

    const statementsHtml = indexStatements
      .map(stmt => `<pre class="index-statement">${escapeHtml(stmt)}</pre>`)
      .join('\n');

    return `<div class="missing-indexes-section">
  <h2 class="section-header">Missing Index Suggestions</h2>
  ${statementsHtml}
</div>`;
  }

  /**
   * Returns the CSS for the execution plan webview.
   */
  private getCss(): string {
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
      padding: 16px;
      overflow: auto;
    }

    .plan-container {
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .statement-section {
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 4px;
      padding: 12px;
    }

    .statement-header {
      font-size: 1.1em;
      font-weight: 600;
      margin-bottom: 12px;
      color: var(--vscode-foreground);
      border-bottom: 1px solid var(--vscode-widget-border, #444);
      padding-bottom: 8px;
    }

    .tree-container {
      overflow-x: auto;
      padding: 12px 0;
    }

    /* Tree layout: left-to-right (parent left, children right) */
    .tree-node {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 0;
    }

    .tree-children {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-left: 4px;
      padding-left: 20px;
      border-left: 2px solid var(--vscode-widget-border, #555);
      position: relative;
    }

    .tree-children > .tree-node {
      position: relative;
    }

    .tree-children > .tree-node::before {
      content: '';
      position: absolute;
      left: -20px;
      top: 50%;
      width: 20px;
      height: 2px;
      background-color: var(--vscode-widget-border, #555);
    }

    /* Operator node box */
    .operator-node {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      padding: 8px 12px;
      border: 1px solid var(--vscode-widget-border, #555);
      border-radius: 4px;
      background-color: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      min-width: 120px;
      cursor: default;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .operator-node.highlighted {
      border-width: 3px;
      border-color: var(--vscode-errorForeground, #f48771);
      background-color: var(--vscode-inputValidation-errorBackground, rgba(255, 100, 100, 0.15));
    }

    .op-name {
      font-weight: 600;
      font-size: 0.9em;
      margin-bottom: 4px;
      text-align: center;
    }

    .op-cost {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground, #999);
    }

    .op-rows {
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground, #999);
    }

    .op-label {
      display: inline-block;
      font-size: 0.75em;
      font-weight: 500;
      padding: 1px 4px;
      border-radius: 2px;
      margin-left: 4px;
      vertical-align: middle;
    }

    .seek-label {
      background-color: rgba(100, 200, 100, 0.2);
      color: var(--vscode-terminal-ansiGreen, #89d185);
      border: 1px solid var(--vscode-terminal-ansiGreen, #89d185);
    }

    .scan-label {
      background-color: rgba(200, 200, 100, 0.2);
      color: var(--vscode-terminal-ansiYellow, #e5c07b);
      border: 1px solid var(--vscode-terminal-ansiYellow, #e5c07b);
    }

    .index-name {
      font-size: 0.75em;
      color: var(--vscode-descriptionForeground, #888);
      margin-top: 2px;
      max-width: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Tooltip */
    .tooltip {
      display: none;
      position: fixed;
      padding: 8px 12px;
      border: 1px solid var(--vscode-widget-border, #555);
      border-radius: 4px;
      background-color: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
      color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
      font-size: 0.85em;
      white-space: pre-wrap;
      max-width: 500px;
      z-index: 1000;
      pointer-events: none;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }

    .tooltip.visible {
      display: block;
    }

    /* Missing indexes section */
    .missing-indexes-section {
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 4px;
      padding: 12px;
    }

    .section-header {
      font-size: 1.1em;
      font-weight: 600;
      margin-bottom: 12px;
      color: var(--vscode-foreground);
      border-bottom: 1px solid var(--vscode-widget-border, #444);
      padding-bottom: 8px;
    }

    .index-statement {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.9em;
      padding: 8px 12px;
      margin-bottom: 8px;
      background-color: var(--vscode-textCodeBlock-background, rgba(100,100,100,0.1));
      border-radius: 3px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    `;
  }

  /**
   * Returns the JavaScript for tooltip interactivity.
   */
  private getJs(): string {
    return `
    (function() {
      const tooltip = document.getElementById('tooltip');
      const nodes = document.querySelectorAll('.operator-node');

      nodes.forEach(function(node) {
        node.addEventListener('mouseenter', function(e) {
          const content = node.getAttribute('data-tooltip');
          if (content) {
            tooltip.textContent = content;
            tooltip.classList.add('visible');
          }
        });

        node.addEventListener('mousemove', function(e) {
          const x = e.clientX + 12;
          const y = e.clientY + 12;
          tooltip.style.left = x + 'px';
          tooltip.style.top = y + 'px';
        });

        node.addEventListener('mouseleave', function() {
          tooltip.classList.remove('visible');
        });
      });
    })();
    `;
  }
}

// ─── HTML Helpers ───────────────────────────────────────────────────────────

/**
 * Escapes HTML special characters.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Escapes text for use in HTML attributes.
 */
function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '&#10;');
}
