// Schema Diagram Panel
// Webview-based panel for visualizing foreign key relationships between tables.
// Interactive — click a table node to expand/collapse its column list.

import * as vscode from 'vscode';
import * as mssql from 'mssql';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface DiagramTable {
  schema: string;
  name: string;
  columns: DiagramColumn[];
}

export interface DiagramColumn {
  name: string;
  dataType: string;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
}

export interface DiagramRelationship {
  fromSchema: string;
  fromTable: string;
  fromColumn: string;
  toSchema: string;
  toTable: string;
  toColumn: string;
  constraintName: string;
}

export interface DiagramData {
  tables: DiagramTable[];
  relationships: DiagramRelationship[];
}

// ─── Column-Level Connector Interfaces ──────────────────────────────────────

export interface ConnectionPointConfig {
  cardPosition: { x: number; y: number };
  cardExpanded: boolean;
  cardExpandedHeight: number;       // actual rendered height when expanded
  partnerCenterX: number;           // x-center of the connected partner card
  columnName: string;               // FK or PK column name from the relationship
  columnRows: ColumnRowInfo[];      // columns present in the card
}

export interface ColumnRowInfo {
  name: string;
  index: number;         // zero-based position in column list
  offsetTop: number;     // from DOM, or 0 if not rendered
  offsetHeight: number;  // from DOM, or 0 if not rendered
}

export interface ConnectionPoint {
  x: number;
  y: number;
}

export interface AnimationState {
  relIndex: number;
  startFrom: ConnectionPoint;    // "from" endpoint at animation start
  startTo: ConnectionPoint;      // "to" endpoint at animation start
  targetFrom: ConnectionPoint;   // target "from" endpoint
  targetTo: ConnectionPoint;     // target "to" endpoint
  startTime: number;             // performance.now() when animation began
  duration: number;              // milliseconds (200ms default)
}

// ─── Column-Level Connector Constants ───────────────────────────────────────

export var CARD_WIDTH = 220;         // fixed card width
export var CARD_HEIGHT = 60;         // collapsed card height
export var HEADER_HEIGHT = 36;       // header area height (padding + font + border)
export var COLUMN_ROW_HEIGHT = 24;   // approximate row height for fallback formula
export var ANIMATION_DURATION = 200; // ms — endpoint transition duration

// ─── Column-Level Connector Functions ───────────────────────────────────────

/**
 * Resolves the connection point (x, y) for a connector endpoint on a table card.
 * Pure function — no DOM access, no side effects.
 *
 * Logic:
 * 1. Horizontal X: left edge if partner center is to the left of this card's center;
 *    right edge otherwise. Default to right edge when centers are equal.
 * 2. If collapsed: Y = cardPosition.y + CARD_HEIGHT / 2.
 * 3. If expanded:
 *    - Find matching column via case-insensitive name comparison.
 *    - If found and offsetHeight > 0: Y = cardPosition.y + offsetTop + (offsetHeight / 2).
 *    - If found but offsetHeight === 0: Y = cardPosition.y + HEADER_HEIGHT + (index * COLUMN_ROW_HEIGHT) + (COLUMN_ROW_HEIGHT / 2).
 *    - If not found: Y = cardPosition.y + cardExpandedHeight / 2.
 */
export function resolveConnectionPoint(config: ConnectionPointConfig): ConnectionPoint {
  var cardCenterX = config.cardPosition.x + CARD_WIDTH / 2;

  // Horizontal edge selection
  var x: number;
  if (config.partnerCenterX < cardCenterX) {
    x = config.cardPosition.x; // left edge
  } else {
    x = config.cardPosition.x + CARD_WIDTH; // right edge (also default when equal)
  }

  // Vertical position
  var y: number;
  if (!config.cardExpanded) {
    // Collapsed: card center
    y = config.cardPosition.y + CARD_HEIGHT / 2;
  } else {
    // Expanded: find matching column (case-insensitive)
    var matchedRow: ColumnRowInfo | undefined;
    var targetName = config.columnName.toLowerCase();
    for (var i = 0; i < config.columnRows.length; i++) {
      if (config.columnRows[i].name.toLowerCase() === targetName) {
        matchedRow = config.columnRows[i];
        break;
      }
    }

    if (matchedRow) {
      if (matchedRow.offsetHeight > 0) {
        // DOM measurement available
        y = config.cardPosition.y + matchedRow.offsetTop + (matchedRow.offsetHeight / 2);
      } else {
        // Fallback formula (DOM not yet rendered)
        y = config.cardPosition.y + HEADER_HEIGHT + (matchedRow.index * COLUMN_ROW_HEIGHT) + (COLUMN_ROW_HEIGHT / 2);
      }
    } else {
      // Column not found: expanded card center
      y = config.cardPosition.y + config.cardExpandedHeight / 2;
    }
  }

  return { x, y };
}

// ─── Query Functions ────────────────────────────────────────────────────────

/**
 * Queries all foreign key relationships for a set of tables in a database.
 * Returns relationships where either the parent or referenced table is in the provided set.
 */
export async function queryForeignKeyRelationships(
  pool: mssql.ConnectionPool,
  database: string,
  tables: Array<{ schema: string; name: string }>
): Promise<DiagramRelationship[]> {
  if (tables.length === 0) {
    return [];
  }

  const safeName = `[${database.replace(/\]/g, ']]')}]`;
  const request = pool.request();

  // Build a filter for the selected tables
  const tableFilters = tables
    .map((t, i) => {
      request.input(`schema${i}`, mssql.NVarChar, t.schema);
      request.input(`table${i}`, mssql.NVarChar, t.name);
      return `(ps.name = @schema${i} AND pt.name = @table${i}) OR (rs.name = @schema${i} AND rt.name = @table${i})`;
    })
    .join(' OR ');

  const result = await request.query(`
    USE ${safeName};
    SELECT
      fk.name AS constraint_name,
      ps.name AS from_schema,
      pt.name AS from_table,
      pc.name AS from_column,
      rs.name AS to_schema,
      rt.name AS to_table,
      rc.name AS to_column
    FROM sys.foreign_key_columns fkc
    INNER JOIN sys.foreign_keys fk ON fkc.constraint_object_id = fk.object_id
    INNER JOIN sys.tables pt ON fkc.parent_object_id = pt.object_id
    INNER JOIN sys.schemas ps ON pt.schema_id = ps.schema_id
    INNER JOIN sys.columns pc ON fkc.parent_object_id = pc.object_id AND fkc.parent_column_id = pc.column_id
    INNER JOIN sys.tables rt ON fkc.referenced_object_id = rt.object_id
    INNER JOIN sys.schemas rs ON rt.schema_id = rs.schema_id
    INNER JOIN sys.columns rc ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id
    WHERE ${tableFilters}
    ORDER BY fk.name, fkc.constraint_column_id
  `);

  return result.recordset.map((row: any) => ({
    fromSchema: row.from_schema,
    fromTable: row.from_table,
    fromColumn: row.from_column,
    toSchema: row.to_schema,
    toTable: row.to_table,
    toColumn: row.to_column,
    constraintName: row.constraint_name,
  }));
}

/**
 * Queries columns for a set of tables.
 */
export async function queryTableColumns(
  pool: mssql.ConnectionPool,
  database: string,
  tables: Array<{ schema: string; name: string }>
): Promise<DiagramTable[]> {
  if (tables.length === 0) {
    return [];
  }

  const safeName = `[${database.replace(/\]/g, ']]')}]`;
  const results: DiagramTable[] = [];

  for (const table of tables) {
    const request = pool.request();
    request.input('schemaName', mssql.NVarChar, table.schema);
    request.input('tableName', mssql.NVarChar, table.name);

    const result = await request.query(`
      USE ${safeName};
      SELECT
        c.name AS column_name,
        TYPE_NAME(c.user_type_id) AS type_name,
        c.max_length,
        c.precision,
        c.scale,
        CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS is_primary_key,
        CASE WHEN fk.parent_column_id IS NOT NULL THEN 1 ELSE 0 END AS is_foreign_key
      FROM sys.columns c
      INNER JOIN sys.objects o ON c.object_id = o.object_id
      INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
      LEFT JOIN (
        SELECT ic.object_id, ic.column_id
        FROM sys.index_columns ic
        INNER JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        WHERE i.is_primary_key = 1
      ) pk ON pk.object_id = o.object_id AND pk.column_id = c.column_id
      LEFT JOIN (
        SELECT DISTINCT parent_object_id, parent_column_id
        FROM sys.foreign_key_columns
      ) fk ON fk.parent_object_id = o.object_id AND fk.parent_column_id = c.column_id
      WHERE s.name = @schemaName AND o.name = @tableName
      ORDER BY c.column_id
    `);

    results.push({
      schema: table.schema,
      name: table.name,
      columns: result.recordset.map((row: any) => ({
        name: row.column_name,
        dataType: formatDataType(row.type_name, row.max_length, row.precision, row.scale),
        isPrimaryKey: row.is_primary_key === 1,
        isForeignKey: row.is_foreign_key === 1,
      })),
    });
  }

  return results;
}

/**
 * Formats a data type string with qualifiers.
 */
function formatDataType(
  typeName: string,
  maxLength: number | null,
  precision: number | null,
  scale: number | null
): string {
  const lower = typeName.toLowerCase();
  if (['nvarchar', 'nchar'].includes(lower)) {
    const len = maxLength === -1 ? 'MAX' : String((maxLength || 0) / 2);
    return `${typeName}(${len})`;
  }
  if (['varchar', 'char', 'varbinary', 'binary'].includes(lower)) {
    const len = maxLength === -1 ? 'MAX' : String(maxLength || 0);
    return `${typeName}(${len})`;
  }
  if (['decimal', 'numeric'].includes(lower)) {
    return `${typeName}(${precision ?? 18}, ${scale ?? 0})`;
  }
  return typeName;
}

// ─── Panel Class ────────────────────────────────────────────────────────────

/**
 * Manages a WebviewPanel that displays an interactive schema diagram
 * showing foreign key relationships between selected tables.
 */
export class SchemaDiagramPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /**
   * Opens or reveals the schema diagram panel with the given title and data.
   * Uses ViewColumn.Active so the diagram opens as a full editor tab.
   * When revealing an existing panel, updates the title before rendering.
   */
  show(data: DiagramData, title: string): void {
    if (this.panel) {
      this.panel.title = title;
      this.panel.reveal(vscode.ViewColumn.Active);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'schemaDiagram',
        title,
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          localResourceRoots: [this.extensionUri],
        }
      );

      this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'ERD.png');

      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });

      this.registerMessageHandler();
    }

    this.panel.webview.html = this.generateHtml(data);
  }

  /**
   * Generates and shows a full-database ERD.
   * Shows a progress indicator if there are more than 50 tables.
   * On metadata query failure, displays an error message and does not render a partial diagram.
   * Silently handles panel disposal during the operation.
   */
  async showDatabaseDiagram(data: DiagramData, databaseName: string): Promise<void> {
    const title = `Schema Diagram - ${databaseName}`;
    const shouldShowProgress = data.tables.length > 50;

    const renderFn = (): void => {
      this.show(data, title);
    };

    if (shouldShowProgress) {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Rendering schema diagram for "${databaseName}" (${data.tables.length} tables)…`,
          cancellable: false,
        },
        async () => {
          renderFn();
        }
      );
    } else {
      renderFn();
    }
  }

  /**
   * Generates and shows a focused table ERD (the selected table plus its FK neighbours).
   * On metadata query failure, displays an error message and does not render a partial diagram.
   * Silently handles panel disposal during the operation.
   */
  showTableDiagram(data: DiagramData, schema: string, tableName: string): void {
    const title = `Table Diagram - ${schema}.${tableName}`;
    this.show(data, title);
  }

  /**
   * Displays an error message in the panel via generateInfoHtml.
   * Does not render a partial diagram — call this on metadata query failure.
   * Creates the panel if it doesn't exist yet.
   * Gracefully handles panel disposal (silently ignores if panel is gone).
   */
  showErrorMessage(message: string, title: string): void {
    try {
      if (!this.panel) {
        this.panel = vscode.window.createWebviewPanel(
          'schemaDiagram',
          title,
          vscode.ViewColumn.Active,
          {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
          }
        );
        this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'ERD.png');
        this.panel.onDidDispose(() => {
          this.panel = undefined;
        });
        this.registerMessageHandler();
      } else {
        this.panel.title = title;
        this.panel.reveal(vscode.ViewColumn.Active);
      }
      this.panel.webview.html = this.generateInfoHtml(message);
    } catch {
      // Panel was disposed during the query — silently ignore
    }
  }

  /**
   * Registers the webview message handler for export operations.
   * Handles 'export-png' and 'export-svg' messages from the webview.
   * On user cancel: discards data silently.
   * On file write error: shows a VS Code error notification with no partial file left on disk.
   */
  private registerMessageHandler(): void {
    if (!this.panel) {
      return;
    }

    this.panel.webview.onDidReceiveMessage(async (message: { type: string; data: string }) => {
      switch (message.type) {
        case 'export-png': {
          const pngUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file('schema-diagram.png'),
            filters: { 'PNG Image': ['png'] },
          });
          if (pngUri) {
            try {
              const pngData = Buffer.from(message.data, 'base64');
              await vscode.workspace.fs.writeFile(pngUri, pngData);
            } catch (err: unknown) {
              const errorMessage = err instanceof Error ? err.message : 'Unknown error';
              vscode.window.showErrorMessage(`Failed to save PNG export: ${errorMessage}`);
            }
          }
          break;
        }
        case 'export-svg': {
          const svgUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file('schema-diagram.svg'),
            filters: { 'SVG Image': ['svg'] },
          });
          if (svgUri) {
            try {
              const svgData = Buffer.from(message.data, 'utf-8');
              await vscode.workspace.fs.writeFile(svgUri, svgData);
            } catch (err: unknown) {
              const errorMessage = err instanceof Error ? err.message : 'Unknown error';
              vscode.window.showErrorMessage(`Failed to save SVG export: ${errorMessage}`);
            }
          }
          break;
        }
      }
    });
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
   * Generates the full HTML for the schema diagram webview.
   */
  private generateHtml(data: DiagramData): string {
    if (data.tables.length === 0) {
      return this.generateInfoHtml('No tables selected for diagram.');
    }

    const noRelationshipsHtml = data.relationships.length === 0
      ? `<div class="no-relationships">No foreign key relationships found.</div>`
      : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Schema Diagram</title>
  <style>${this.getCss()}</style>
</head>
<body>
  <div class="diagram-header">
    <h1>Schema Diagram</h1>
    <span class="table-count">${data.tables.length} table${data.tables.length !== 1 ? 's' : ''}, ${data.relationships.length} relationship${data.relationships.length !== 1 ? 's' : ''}</span>
    <button id="exportPng">Export PNG</button>
    <button id="exportSvg">Export SVG</button>
  </div>
  ${noRelationshipsHtml}
  <div class="diagram-canvas" id="canvas">
    <div id="viewport" style="transform: translate(0px, 0px) scale(1)">
      <svg id="connectors" class="connector-layer"></svg>
      <div id="tables" class="table-layer"></div>
    </div>
    <div id="zoom-indicator">100%</div>
    <canvas id="minimap" class="minimap" width="180" height="120"></canvas>
    <div id="fk-tooltip" class="fk-tooltip hidden"></div>
  </div>
  <script>
    (function() {
      const tables = ${JSON.stringify(data.tables)};
      const relationships = ${JSON.stringify(data.relationships)};
      ${this.getJs()}
    })();
  </script>
</body>
</html>`;
  }

  /**
   * Generates HTML for info/empty state messages.
   */
  private generateInfoHtml(message: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Schema Diagram</title>
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
   * Returns the CSS for the schema diagram.
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
      overflow: hidden;
    }

    .diagram-header {
      display: flex;
      align-items: baseline;
      gap: 12px;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--vscode-widget-border);
      padding-bottom: 12px;
    }

    .diagram-header h1 {
      font-size: 1.3em;
      font-weight: 600;
    }

    .table-count {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
    }

    .diagram-canvas {
      position: relative;
      height: calc(100vh - 80px);
      width: 100%;
      overflow: hidden;
      cursor: grab;
    }

    .diagram-canvas.panning {
      cursor: grabbing;
    }

    /* Viewport — pan+zoom transform container */
    .viewport {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      transform-origin: 0 0;
      will-change: transform;
    }

    .connector-layer {
      position: absolute;
      top: 0;
      left: 0;
      width: 4000px;
      height: 4000px;
      pointer-events: none;
      z-index: 1;
      overflow: visible;
    }

    /* Hit-area paths override parent pointer-events to receive mouse interactions */
    .connector-layer .hit-area {
      pointer-events: stroke;
    }

    .table-layer {
      position: relative;
      z-index: 2;
    }

    /* Table card — absolute positioning for layout algorithm */
    .table-card {
      position: absolute;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 6px;
      background-color: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      min-width: 200px;
      max-width: 320px;
      width: 220px;
      overflow: hidden;
      cursor: pointer;
      user-select: none;
      transition: border-color 0.15s, box-shadow 0.15s, opacity 0.15s;
    }

    .table-card:hover {
      border-color: var(--vscode-focusBorder);
    }

    .table-card.expanded {
      border-color: var(--vscode-focusBorder);
    }

    /* Dragging state — drop shadow + elevated z-index */
    .table-card.dragging {
      box-shadow: 0 8px 24px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
      z-index: 1000;
      cursor: grabbing;
      transition: none;
    }

    /* Highlighted state — 2px solid accent border */
    .table-card.highlighted {
      border: 2px solid var(--vscode-focusBorder);
    }

    /* Dimmed state — reduced opacity */
    .table-card.dimmed {
      opacity: 0.25;
    }

    .table-header {
      padding: 8px 12px;
      font-weight: 600;
      font-size: 0.95em;
      border-bottom: 1px solid var(--vscode-widget-border);
      background-color: var(--vscode-sideBarSectionHeader-background);
      border-radius: 6px 6px 0 0;
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: grab;
      overflow: hidden;
    }

    .table-card.dragging .table-header {
      cursor: grabbing;
    }

    .table-header .icon {
      font-size: 0.8em;
      opacity: 0.7;
    }

    .table-header .schema-name {
      font-weight: 400;
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
      flex-shrink: 0;
    }

    .table-header .table-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }

    .table-columns {
      display: none;
      padding: 0;
    }

    .table-card.expanded .table-columns {
      display: block;
    }

    .column-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 12px;
      font-size: 0.85em;
      border-bottom: 1px solid var(--vscode-widget-border);
    }

    .column-row:last-child {
      border-bottom: none;
    }

    .column-row.pk {
      font-weight: 600;
    }

    .column-row.fk {
      font-style: italic;
    }

    .column-icon {
      font-size: 0.75em;
      width: 16px;
      text-align: center;
      flex-shrink: 0;
    }

    .column-icon.pk-icon {
      color: var(--vscode-terminal-ansiYellow);
    }

    .column-icon.fk-icon {
      color: var(--vscode-terminal-ansiBlue);
    }

    .column-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .column-type {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
      flex-shrink: 0;
    }

    .expand-hint {
      padding: 6px 12px;
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
      text-align: center;
    }

    .table-card.expanded .expand-hint {
      display: none;
    }

    /* Connector lines (SVG) */
    .connector-line {
      stroke: var(--vscode-terminal-ansiBlue);
      stroke-width: 1.5;
      fill: none;
      opacity: 0.6;
    }

    /* Active connector — bold stroke with accent color */
    .connector-line.active {
      stroke: var(--vscode-focusBorder);
      stroke-width: 3;
      opacity: 1;
    }

    /* Dimmed connector — reduced opacity */
    .connector-line.dimmed {
      opacity: 0.25;
    }

    .connector-dot {
      fill: var(--vscode-terminal-ansiBlue);
    }

    /* Hit area — invisible wide stroke for click targeting */
    .hit-area {
      stroke-width: 12;
      opacity: 0;
      fill: none;
      pointer-events: stroke;
      cursor: pointer;
    }

    .no-relationships {
      padding: 16px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }

    /* FK Detail Tooltip */
    .fk-tooltip {
      position: absolute;
      z-index: 2000;
      max-width: 400px;
      padding: 8px 12px;
      border: 1px solid var(--vscode-editorHoverWidget-border);
      border-radius: 4px;
      background-color: var(--vscode-editorHoverWidget-background);
      color: var(--vscode-editorHoverWidget-foreground);
      font-size: 0.85em;
      line-height: 1.4;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none;
      box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
    }

    .fk-tooltip.hidden {
      display: none;
    }

    /* Zoom indicator — fixed bottom-right percentage label */
    .zoom-indicator {
      position: absolute;
      bottom: 12px;
      right: 12px;
      padding: 4px 10px;
      border-radius: 4px;
      background-color: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border);
      color: var(--vscode-foreground);
      font-size: 0.8em;
      font-weight: 500;
      z-index: 100;
      cursor: pointer;
      user-select: none;
    }

    /* Minimap — fixed bottom-right canvas */
    .minimap {
      position: absolute;
      bottom: 40px;
      right: 12px;
      width: 180px;
      height: 120px;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 4px;
      background-color: var(--vscode-editorWidget-background);
      opacity: 0.85;
      z-index: 100;
      cursor: pointer;
    }
    `;
  }

  /**
   * Returns the JavaScript for interactive behavior.
   */
  private getJs(): string {
    return `
    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('canvas');
    const svg = document.getElementById('connectors');
    const tableLayer = document.getElementById('tables');
    const viewportEl = document.getElementById('viewport');
    const zoomIndicator = document.getElementById('zoom-indicator');

    // Callback registry for viewport/position changes (used by MinimapRenderer)
    var onViewportChangeCallbacks = [];
    var onPositionChangeCallbacks = [];
    function notifyViewportChange() {
      for (var i = 0; i < onViewportChangeCallbacks.length; i++) {
        onViewportChangeCallbacks[i]();
      }
    }
    function notifyPositionChange() {
      for (var i = 0; i < onPositionChangeCallbacks.length; i++) {
        onPositionChangeCallbacks[i]();
      }
    }

    // ─── Layout Algorithm (pure function, inlined) ───────────────────────────
    ${this.getLayoutAlgorithmJs()}

    // ─── ViewportController ──────────────────────────────────────────────────
    var ViewportController = (function() {
      var state = { panX: 0, panY: 0, zoom: 1.0 };
      var isPanning = false;
      var panStartX = 0;
      var panStartY = 0;
      var panStartPanX = 0;
      var panStartPanY = 0;
      var rafPending = false;

      function screenToDiagram(screenX, screenY) {
        var rect = canvas.getBoundingClientRect();
        var relX = screenX - rect.left;
        var relY = screenY - rect.top;
        return {
          x: (relX - state.panX) / state.zoom,
          y: (relY - state.panY) / state.zoom
        };
      }

      function diagramToScreen(diagX, diagY) {
        var rect = canvas.getBoundingClientRect();
        return {
          x: diagX * state.zoom + state.panX + rect.left,
          y: diagY * state.zoom + state.panY + rect.top
        };
      }

      function applyTransform() {
        viewportEl.style.transform = 'translate(' + state.panX + 'px, ' + state.panY + 'px) scale(' + state.zoom + ')';
      }

      function updateZoomIndicator() {
        zoomIndicator.textContent = Math.round(state.zoom * 100) + '%';
      }

      function startPan(screenX, screenY) {
        isPanning = true;
        panStartX = screenX;
        panStartY = screenY;
        panStartPanX = state.panX;
        panStartPanY = state.panY;
        canvas.style.cursor = 'grabbing';
      }

      function updatePan(screenX, screenY) {
        if (!isPanning) return;
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(function() {
          rafPending = false;
          if (!isPanning) return;
          var dx = screenX - panStartX;
          var dy = screenY - panStartY;
          state.panX = panStartPanX + dx;
          state.panY = panStartPanY + dy;
          applyTransform();
          notifyViewportChange();
        });
      }

      function endPan() {
        if (!isPanning) return;
        isPanning = false;
        canvas.style.cursor = 'grab';
      }

      function applyZoom(delta, cursorScreenX, cursorScreenY) {
        // Get diagram point under cursor before zoom
        var diagPoint = screenToDiagram(cursorScreenX, cursorScreenY);

        // Compute new zoom level: positive delta = zoom in, negative = zoom out
        var tick = delta > 0 ? -1 : 1; // wheel deltaY positive = scroll down = zoom out
        var newZoom = state.zoom + tick * 0.1;
        // Clamp to 0.3–3.0
        if (newZoom < 0.3) newZoom = 0.3;
        if (newZoom > 3.0) newZoom = 3.0;

        state.zoom = Math.round(newZoom * 100) / 100; // avoid floating point drift

        // Adjust pan so diagram point stays at same screen position
        var rect = canvas.getBoundingClientRect();
        var relX = cursorScreenX - rect.left;
        var relY = cursorScreenY - rect.top;
        state.panX = relX - diagPoint.x * state.zoom;
        state.panY = relY - diagPoint.y * state.zoom;

        applyTransform();
        updateZoomIndicator();
        notifyViewportChange();
      }

      function resetView() {
        state.panX = 0;
        state.panY = 0;
        state.zoom = 1.0;
        applyTransform();
        updateZoomIndicator();
        notifyViewportChange();
      }

      function getState() {
        return state;
      }

      function getIsPanning() {
        return isPanning;
      }

      // ─── Event Bindings ─────────────────────────────────────────────────────

      // Wheel event for zoom (on canvas)
      canvas.addEventListener('wheel', function(e) {
        e.preventDefault();
        // Normalize deltaY to single tick
        var deltaY = e.deltaY;
        if (deltaY === 0) return;
        applyZoom(deltaY, e.clientX, e.clientY);
      }, { passive: false });

      // Pan: mousedown on canvas background
      canvas.addEventListener('mousedown', function(e) {
        // Only start pan if clicking on canvas background (not on table cards)
        // Drag takes priority over pan
        if (e.target === canvas || e.target === viewportEl || e.target === svg) {
          if (e.button === 0) { // primary button only
            e.preventDefault();
            startPan(e.clientX, e.clientY);
          }
        }
      });

      // Pan: mousemove (on document to capture even if mouse leaves canvas briefly)
      document.addEventListener('mousemove', function(e) {
        if (isPanning) {
          // If DragController started a drag, cancel pan
          if (typeof DragController !== 'undefined' && DragController.isDragging()) {
            endPan();
            return;
          }
          e.preventDefault();
          updatePan(e.clientX, e.clientY);
        }
      });

      // Pan: mouseup
      document.addEventListener('mouseup', function(e) {
        if (isPanning) {
          endPan();
        }
      });

      // End pan if mouse leaves canvas
      canvas.addEventListener('mouseleave', function(e) {
        if (isPanning) {
          endPan();
        }
      });

      // End pan if mouse leaves browser window
      document.addEventListener('mouseleave', function(e) {
        if (isPanning) {
          endPan();
        }
      });

      // Set cursor to grab on canvas background hover
      canvas.addEventListener('mouseover', function(e) {
        if (!isPanning && (e.target === canvas || e.target === viewportEl || e.target === svg)) {
          canvas.style.cursor = 'grab';
        }
      });

      canvas.addEventListener('mouseout', function(e) {
        if (!isPanning && (e.target === canvas || e.target === viewportEl || e.target === svg)) {
          canvas.style.cursor = '';
        }
      });

      // Double-click zoom indicator resets view
      zoomIndicator.addEventListener('dblclick', function(e) {
        e.preventDefault();
        e.stopPropagation();
        resetView();
      });

      // Set initial cursor
      canvas.style.cursor = 'grab';

      return {
        state: state,
        screenToDiagram: screenToDiagram,
        diagramToScreen: diagramToScreen,
        startPan: startPan,
        updatePan: updatePan,
        endPan: endPan,
        applyZoom: applyZoom,
        resetView: resetView,
        applyTransform: applyTransform,
        getState: getState,
        getIsPanning: getIsPanning
      };
    })();

    // Compute layout positions
    const positionMap = layoutAlgorithm({ tables: tables, relationships: relationships });

    // Column row cache — keyed by tableKey (schema.table), populated on expand, cleared on collapse
    var columnRowCache = new Map();

    // ─── DragController ──────────────────────────────────────────────────────
    var DragController = (function() {
      var dragState = {
        active: false,
        cardElement: null,
        tableKey: '',
        offsetX: 0,
        offsetY: 0,
        startX: 0,
        startY: 0,
        moved: false
      };

      var dragRafId = null;

      function onMouseDown(e, card, tableKey) {
        // Only initiate from .table-header elements (not column rows)
        if (!e.target.closest('.table-header')) return;
        // Only primary mouse button
        if (e.button !== 0) return;

        e.preventDefault();
        e.stopPropagation();

        // Record start position (screen coords) for 5px threshold
        dragState.startX = e.clientX;
        dragState.startY = e.clientY;
        dragState.active = true;
        dragState.cardElement = card;
        dragState.tableKey = tableKey;
        dragState.moved = false;

        // Record cursor offset from card top-left in diagram space
        var cardLeft = parseFloat(card.style.left) || 0;
        var cardTop = parseFloat(card.style.top) || 0;
        var diagPos = ViewportController.screenToDiagram(e.clientX, e.clientY);
        dragState.offsetX = diagPos.x - cardLeft;
        dragState.offsetY = diagPos.y - cardTop;
      }

      function onMouseMove(e) {
        if (!dragState.active) return;

        // Check 5px movement threshold to distinguish click from drag
        var dx = e.clientX - dragState.startX;
        var dy = e.clientY - dragState.startY;
        var distance = Math.sqrt(dx * dx + dy * dy);

        if (!dragState.moved) {
          if (distance <= 5) return;
          // Threshold exceeded — this is a real drag
          dragState.moved = true;
          dragState.cardElement.classList.add('dragging');
          document.body.style.cursor = 'grabbing';
        }

        // Schedule position update via rAF (max one per frame)
        if (dragRafId !== null) return;

        var clientX = e.clientX;
        var clientY = e.clientY;
        dragRafId = requestAnimationFrame(function() {
          dragRafId = null;
          if (!dragState.active || !dragState.moved) return;

          // Convert current mouse position to diagram space
          var diagPos = ViewportController.screenToDiagram(clientX, clientY);

          // Compute new card position maintaining cursor-to-corner offset
          var newX = diagPos.x - dragState.offsetX;
          var newY = diagPos.y - dragState.offsetY;

          // Clamp to minimum (0, 0)
          if (newX < 0) newX = 0;
          if (newY < 0) newY = 0;

          // Update card position
          dragState.cardElement.style.left = newX + 'px';
          dragState.cardElement.style.top = newY + 'px';

          // Update positionMap
          positionMap.set(dragState.tableKey, { x: newX, y: newY });

          // Redraw only connected connectors on each frame during drag (partial redraw)
          updateSingle(dragState.tableKey);

          // Notify minimap of position change
          notifyPositionChange();
        });
      }

      function endDrag() {
        if (!dragState.active) return;

        if (dragState.moved && dragState.cardElement) {
          // Remove drag visual feedback
          dragState.cardElement.classList.remove('dragging');
          document.body.style.cursor = '';

          // Store final position in positionMap
          var finalX = parseFloat(dragState.cardElement.style.left) || 0;
          var finalY = parseFloat(dragState.cardElement.style.top) || 0;
          positionMap.set(dragState.tableKey, { x: finalX, y: finalY });
        }

        // Cancel any pending rAF
        if (dragRafId !== null) {
          cancelAnimationFrame(dragRafId);
          dragRafId = null;
        }

        // Reset state
        var wasMoved = dragState.moved;
        dragState.active = false;
        dragState.cardElement = null;
        dragState.tableKey = '';
        dragState.moved = false;

        return wasMoved;
      }

      function onMouseUp(e) {
        if (!dragState.active) return;

        if (dragState.moved) {
          // This was a real drag — end it
          var card = dragState.cardElement;
          endDrag();
          // Set suppress flag to prevent click handler from firing
          if (card) card._suppressClick = true;
        } else {
          // Movement was ≤5px — this is a click, not a drag
          // Reset drag state but let the click handler run
          dragState.active = false;
          dragState.cardElement = null;
          dragState.tableKey = '';
          dragState.moved = false;
        }
      }

      function isDragging() {
        return dragState.active && dragState.moved;
      }

      // Bind global mouse events for drag tracking
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);

      // End drag if mouse leaves the browser window
      document.addEventListener('mouseleave', function(e) {
        if (dragState.active) {
          endDrag();
        }
      });

      return {
        onMouseDown: onMouseDown,
        isDragging: isDragging,
        endDrag: endDrag
      };
    })();
    // ─── End DragController ──────────────────────────────────────────────────

    // Render table cards
    tables.forEach(function(table, index) {
      const card = document.createElement('div');
      card.className = 'table-card';
      card.dataset.schema = table.schema;
      card.dataset.table = table.name;
      card.dataset.index = String(index);

      const header = document.createElement('div');
      header.className = 'table-header';
      header.innerHTML = '<span class="icon">&#x1F4CB;</span>'
        + '<span class="schema-name">' + escapeH(table.schema) + '.</span>'
        + '<span class="table-name">' + escapeH(table.name) + '</span>';
      card.appendChild(header);

      const hint = document.createElement('div');
      hint.className = 'expand-hint';
      hint.textContent = 'Click to show columns';
      card.appendChild(hint);

      const colContainer = document.createElement('div');
      colContainer.className = 'table-columns';

      table.columns.forEach(function(col) {
        const row = document.createElement('div');
        row.className = 'column-row' + (col.isPrimaryKey ? ' pk' : '') + (col.isForeignKey ? ' fk' : '');

        let iconHtml = '<span class="column-icon">&bull;</span>';
        if (col.isPrimaryKey) {
          iconHtml = '<span class="column-icon pk-icon">&#x1F511;</span>';
        } else if (col.isForeignKey) {
          iconHtml = '<span class="column-icon fk-icon">&#x1F517;</span>';
        }

        row.innerHTML = iconHtml
          + '<span class="column-name">' + escapeH(col.name) + '</span>'
          + '<span class="column-type">' + escapeH(col.dataType) + '</span>';
        colContainer.appendChild(row);
      });

      card.appendChild(colContainer);

      // Apply position from layout algorithm
      const tableKey = table.schema + '.' + table.name;
      const pos = positionMap.get(tableKey);
      if (pos) {
        card.style.position = 'absolute';
        card.style.left = pos.x + 'px';
        card.style.top = pos.y + 'px';
      }

      tableLayer.appendChild(card);

      // Bind mousedown on header for drag initiation
      header.addEventListener('mousedown', function(e) {
        DragController.onMouseDown(e, card, tableKey);
      });

      // Click to expand/collapse — only fires if drag did not occur (≤5px movement)
      card.addEventListener('click', function() {
        // If a drag just completed, suppress this click
        if (card._suppressClick) {
          card._suppressClick = false;
          return;
        }

        // ─── BEFORE state change: capture current endpoint positions ────────────
        var affectedRelationships = [];
        relationships.forEach(function(rel, index) {
          var fromKey = rel.fromSchema + '.' + rel.fromTable;
          var toKey = rel.toSchema + '.' + rel.toTable;
          if (fromKey !== tableKey && toKey !== tableKey) return;
          if (fromKey === toKey) return;

          var pathData = computeConnectorPath(fromKey, toKey, rel.fromColumn, rel.toColumn);
          if (!pathData) return;

          affectedRelationships.push({
            index: index,
            rel: rel,
            currentFrom: { x: pathData.x1, y: pathData.y1 },
            currentTo: { x: pathData.x2, y: pathData.y2 },
            startDotOpacity: {
              from: pathData.fromIsColumnLevel ? 0.8 : 0,
              to: pathData.toIsColumnLevel ? 0.8 : 0
            }
          });
        });

        // Toggle expand/collapse
        card.classList.toggle('expanded');

        // Refresh column row cache for this card (populate on expand, clear on collapse)
        refreshColumnRowCache(tableKey, card);

        // Preserve card position from PositionMap (do NOT reset on expand/collapse)
        const existingPos = positionMap.get(tableKey);
        if (existingPos) {
          card.style.left = existingPos.x + 'px';
          card.style.top = existingPos.y + 'px';
        }

        // Always highlight FK-connected tables on click (Req 9.5)
        highlightRelated(table.schema, table.name);

        // ─── AFTER state change: compute target endpoints and animate ───────────
        affectedRelationships.forEach(function(item) {
          var fromKey = item.rel.fromSchema + '.' + item.rel.fromTable;
          var toKey = item.rel.toSchema + '.' + item.rel.toTable;

          var pathData = computeConnectorPath(fromKey, toKey, item.rel.fromColumn, item.rel.toColumn);
          if (!pathData) return;

          var targetFrom = { x: pathData.x1, y: pathData.y1 };
          var targetTo = { x: pathData.x2, y: pathData.y2 };

          // Dot opacity: target based on new state (after toggle)
          var targetDotOpacity = {
            from: pathData.fromIsColumnLevel ? 0.8 : 0,
            to: pathData.toIsColumnLevel ? 0.8 : 0
          };

          ConnectorAnimator.animate(item.index, item.currentFrom, item.currentTo, targetFrom, targetTo, item.startDotOpacity, targetDotOpacity);
        });

        // Start animation loop or snap directly if requestAnimationFrame not available
        if (typeof requestAnimationFrame !== 'undefined') {
          startAnimationLoop();
        } else {
          // Graceful degradation: snap directly to target
          drawConnectors();
        }
      });
    });

    function highlightRelated(schema, name) {
      // Find all FK-connected tables for the clicked table
      const relatedKeys = new Set();
      relationships.forEach(function(r) {
        if (r.fromSchema === schema && r.fromTable === name) {
          relatedKeys.add(r.toSchema + '.' + r.toTable);
        }
        if (r.toSchema === schema && r.toTable === name) {
          relatedKeys.add(r.fromSchema + '.' + r.fromTable);
        }
      });

      // Apply .highlighted to FK-connected cards, remove from all others (Req 9.5)
      document.querySelectorAll('.table-card').forEach(function(card) {
        const key = card.dataset.schema + '.' + card.dataset.table;
        if (relatedKeys.has(key)) {
          card.classList.add('highlighted');
        } else {
          card.classList.remove('highlighted');
        }
      });
    }

    // ─── ConnectorRenderer ─────────────────────────────────────────────────
    var CARD_WIDTH = 220;
    var CARD_HEIGHT = 60;
    var HEADER_HEIGHT = 36;       // header area height (padding + font + border)
    var COLUMN_ROW_HEIGHT = 24;   // approximate row height for fallback formula
    var ANIMATION_DURATION = 200; // ms — endpoint transition duration

    /**
     * Resolves the connection point (x, y) for a connector endpoint on a table card.
     * Pure function — no DOM access, no side effects.
     */
    function resolveConnectionPoint(config) {
      var cardCenterX = config.cardPosition.x + CARD_WIDTH / 2;

      // Horizontal edge selection
      var x;
      if (config.partnerCenterX < cardCenterX) {
        x = config.cardPosition.x; // left edge
      } else {
        x = config.cardPosition.x + CARD_WIDTH; // right edge (also default when equal)
      }

      // Vertical position
      var y;
      if (!config.cardExpanded) {
        // Collapsed: card center
        y = config.cardPosition.y + CARD_HEIGHT / 2;
      } else {
        // Expanded: find matching column (case-insensitive)
        var matchedRow = null;
        var targetName = config.columnName.toLowerCase();
        for (var i = 0; i < config.columnRows.length; i++) {
          if (config.columnRows[i].name.toLowerCase() === targetName) {
            matchedRow = config.columnRows[i];
            break;
          }
        }

        if (matchedRow) {
          if (matchedRow.offsetHeight > 0) {
            // DOM measurement available
            y = config.cardPosition.y + matchedRow.offsetTop + (matchedRow.offsetHeight / 2);
          } else {
            // Fallback formula (DOM not yet rendered)
            y = config.cardPosition.y + HEADER_HEIGHT + (matchedRow.index * COLUMN_ROW_HEIGHT) + (COLUMN_ROW_HEIGHT / 2);
          }
        } else {
          // Column not found: expanded card center
          y = config.cardPosition.y + config.cardExpandedHeight / 2;
        }
      }

      return { x: x, y: y };
    }

    /**
     * Reads all .column-row elements within a card and returns their layout info.
     * offsetTop is relative to the card element (nearest positioned ancestor).
     * Called once per expand/collapse transition and cached — NOT on every frame.
     */
    function getColumnRowInfo(cardElement) {
      var rows = cardElement.querySelectorAll('.column-row');
      var result = [];
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var nameEl = row.querySelector('.column-name');
        var name = nameEl ? nameEl.textContent || '' : '';
        result.push({
          name: name,
          index: i,
          offsetTop: row.offsetTop,
          offsetHeight: row.offsetHeight
        });
      }
      return result;
    }

    /**
     * Populate or clear the column row cache for a given table card.
     * Called on expand (populates via getColumnRowInfo) and collapse (clears entry).
     */
    function refreshColumnRowCache(tableKey, cardElement) {
      if (cardElement.classList.contains('expanded')) {
        columnRowCache.set(tableKey, getColumnRowInfo(cardElement));
      } else {
        columnRowCache.delete(tableKey);
      }
    }

    // ─── ConnectorAnimator ────────────────────────────────────────────────────
    // Animation state machine for smooth endpoint transitions.
    // Uses linear interpolation over ANIMATION_DURATION (200ms).
    var ConnectorAnimator = {
      activeAnimations: new Map(),

      /**
       * Begin or restart an animation for a relationship.
       * If an animation is already in progress for this relIndex, compute the
       * current interpolated position and start the new animation from there.
       */
      animate: function(relIndex, currentFrom, currentTo, targetFrom, targetTo, dotOpacityStart, dotOpacityTarget) {
        var startFrom = currentFrom;
        var startTo = currentTo;
        var startDotOpacity = dotOpacityStart || { from: 0, to: 0 };
        var targetDotOpacity = dotOpacityTarget || { from: 0.8, to: 0.8 };

        // Handle interruption: if already animating this relationship,
        // compute current interpolated position and use it as the new start
        if (ConnectorAnimator.activeAnimations.has(relIndex)) {
          var existing = ConnectorAnimator.activeAnimations.get(relIndex);
          var now = performance.now();
          var elapsed = now - existing.startTime;
          var t = Math.min(Math.max(elapsed / existing.duration, 0), 1);

          startFrom = {
            x: existing.startFrom.x + (existing.targetFrom.x - existing.startFrom.x) * t,
            y: existing.startFrom.y + (existing.targetFrom.y - existing.startFrom.y) * t
          };
          startTo = {
            x: existing.startTo.x + (existing.targetTo.x - existing.startTo.x) * t,
            y: existing.startTo.y + (existing.targetTo.y - existing.startTo.y) * t
          };

          // Interpolate current dot opacity for smooth interruption
          startDotOpacity = {
            from: existing.dotOpacityStart.from + (existing.dotOpacityTarget.from - existing.dotOpacityStart.from) * t,
            to: existing.dotOpacityStart.to + (existing.dotOpacityTarget.to - existing.dotOpacityStart.to) * t
          };

          ConnectorAnimator.activeAnimations.delete(relIndex);
        }

        ConnectorAnimator.activeAnimations.set(relIndex, {
          relIndex: relIndex,
          startFrom: startFrom,
          startTo: startTo,
          targetFrom: targetFrom,
          targetTo: targetTo,
          dotOpacityStart: startDotOpacity,
          dotOpacityTarget: targetDotOpacity,
          startTime: performance.now(),
          duration: ANIMATION_DURATION
        });
      },

      /**
       * Cancel a running animation, returning current interpolated position or null.
       */
      cancel: function(relIndex) {
        if (!ConnectorAnimator.activeAnimations.has(relIndex)) {
          return null;
        }

        var anim = ConnectorAnimator.activeAnimations.get(relIndex);
        var now = performance.now();
        var elapsed = now - anim.startTime;
        var t = Math.min(Math.max(elapsed / anim.duration, 0), 1);

        var interpolatedFrom = {
          x: anim.startFrom.x + (anim.targetFrom.x - anim.startFrom.x) * t,
          y: anim.startFrom.y + (anim.targetFrom.y - anim.startFrom.y) * t
        };
        var interpolatedTo = {
          x: anim.startTo.x + (anim.targetTo.x - anim.startTo.x) * t,
          y: anim.startTo.y + (anim.targetTo.y - anim.startTo.y) * t
        };

        ConnectorAnimator.activeAnimations.delete(relIndex);

        return { from: interpolatedFrom, to: interpolatedTo };
      },

      /**
       * Called on each rAF tick — updates all active animations via linear interpolation.
       * Removes completed animations (t >= 1).
       */
      tick: function(now) {
        var toRemove = [];

        ConnectorAnimator.activeAnimations.forEach(function(anim, relIndex) {
          var elapsed = now - anim.startTime;
          var t = Math.min(Math.max(elapsed / anim.duration, 0), 1);

          if (t >= 1) {
            toRemove.push(relIndex);
          }
        });

        for (var i = 0; i < toRemove.length; i++) {
          ConnectorAnimator.activeAnimations.delete(toRemove[i]);
        }
      },

      /**
       * Check if any animations are active.
       */
      isAnimating: function() {
        return ConnectorAnimator.activeAnimations.size > 0;
      }
    };

    /**
     * Determine if a given endpoint is at column-level (card is expanded AND column
     * name matches a row in the column row cache). Returns true for column-level,
     * false for card-center.
     */
    function isColumnLevelEndpoint(tableKey, columnName) {
      var rows = columnRowCache.get(tableKey);
      if (!rows || rows.length === 0) return false;
      // Card must be expanded (having cache entries implies expanded)
      var targetName = (columnName || '').toLowerCase();
      if (!targetName) return false;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].name.toLowerCase() === targetName) {
          return true;
        }
      }
      return false;
    }

    /**
     * Compute the bezier path data and connection points for a single relationship.
     * Uses positionMap (diagram-space coordinates) — NOT getBoundingClientRect.
     * The SVG is inside #viewport so coordinates are in diagram space.
     * Uses resolveConnectionPoint for endpoint resolution (column-level when expanded).
     */
    function computeConnectorPath(fromKey, toKey, fromColumn, toColumn) {
      var fromPos = positionMap.get(fromKey);
      var toPos = positionMap.get(toKey);
      if (!fromPos || !toPos) return null;
      if (fromKey === toKey) return null; // self-referencing FK guard

      // Get card elements to determine expanded state and height
      var fromCard = tableLayer.querySelector('[data-schema="' + fromKey.split('.')[0] + '"][data-table="' + fromKey.split('.')[1] + '"]');
      var toCard = tableLayer.querySelector('[data-schema="' + toKey.split('.')[0] + '"][data-table="' + toKey.split('.')[1] + '"]');

      // Resolve FROM endpoint
      var fromPoint = resolveConnectionPoint({
        cardPosition: fromPos,
        cardExpanded: fromCard ? fromCard.classList.contains('expanded') : false,
        cardExpandedHeight: fromCard ? fromCard.offsetHeight : CARD_HEIGHT,
        partnerCenterX: toPos.x + CARD_WIDTH / 2,
        columnName: fromColumn || '',
        columnRows: columnRowCache.get(fromKey) || []
      });

      // Resolve TO endpoint
      var toPoint = resolveConnectionPoint({
        cardPosition: toPos,
        cardExpanded: toCard ? toCard.classList.contains('expanded') : false,
        cardExpandedHeight: toCard ? toCard.offsetHeight : CARD_HEIGHT,
        partnerCenterX: fromPos.x + CARD_WIDTH / 2,
        columnName: toColumn || '',
        columnRows: columnRowCache.get(toKey) || []
      });

      var x1 = fromPoint.x;
      var y1 = fromPoint.y;
      var x2 = toPoint.x;
      var y2 = toPoint.y;

      // Determine if each endpoint is column-level (for dot visibility)
      var fromIsColumnLevel = isColumnLevelEndpoint(fromKey, fromColumn);
      var toIsColumnLevel = isColumnLevelEndpoint(toKey, toColumn);

      // Bezier control points: horizontal offset from endpoints
      var fromCenterX = fromPos.x + CARD_WIDTH / 2;
      var toCenterX = toPos.x + CARD_WIDTH / 2;
      var dx = Math.abs(x2 - x1);
      var cpOffset = Math.max(dx * 0.4, 40);
      var cp1x = x1 + (fromCenterX < toCenterX ? cpOffset : -cpOffset);
      var cp1y = y1;
      var cp2x = x2 + (fromCenterX < toCenterX ? -cpOffset : cpOffset);
      var cp2y = y2;

      var d = 'M ' + x1 + ' ' + y1 + ' C ' + cp1x + ' ' + cp1y + ' ' + cp2x + ' ' + cp2y + ' ' + x2 + ' ' + y2;

      return { d: d, x1: x1, y1: y1, x2: x2, y2: y2, fromIsColumnLevel: fromIsColumnLevel, toIsColumnLevel: toIsColumnLevel };
    }

    /**
     * Draw all connectors from scratch. Clears the SVG and redraws everything.
     * Uses positionMap entries for position data (not getBoundingClientRect).
     * Skips relationships where either card is not found in the positionMap.
     */
    function drawConnectors() {
      svg.innerHTML = '';

      relationships.forEach(function(rel, index) {
        var fromKey = rel.fromSchema + '.' + rel.fromTable;
        var toKey = rel.toSchema + '.' + rel.toTable;

        // Skip if either card not found in DOM or positionMap
        var fromCard = tableLayer.querySelector('[data-schema="' + rel.fromSchema + '"][data-table="' + rel.fromTable + '"]');
        var toCard = tableLayer.querySelector('[data-schema="' + rel.toSchema + '"][data-table="' + rel.toTable + '"]');
        if (!fromCard || !toCard) return;
        if (fromKey === toKey) return;

        var pathData = computeConnectorPath(fromKey, toKey, rel.fromColumn, rel.toColumn);
        if (!pathData) return;

        // Hit area path (invisible, wide) — added FIRST so it's behind visible path
        var hitArea = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hitArea.setAttribute('d', pathData.d);
        hitArea.setAttribute('class', 'hit-area');
        hitArea.setAttribute('stroke-width', '12');
        hitArea.setAttribute('opacity', '0');
        hitArea.setAttribute('pointer-events', 'stroke');
        hitArea.setAttribute('data-rel-index', String(index));
        hitArea.setAttribute('stroke', 'transparent');
        hitArea.setAttribute('fill', 'none');
        svg.appendChild(hitArea);

        // Visible connector path
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', pathData.d);
        path.setAttribute('class', 'connector-line');
        path.setAttribute('data-from', fromKey);
        path.setAttribute('data-to', toKey);
        path.setAttribute('data-rel-index', String(index));
        svg.appendChild(path);

        // Endpoint dots (rendered above path for SVG stacking order)
        var dot1 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot1.setAttribute('cx', String(pathData.x1));
        dot1.setAttribute('cy', String(pathData.y1));
        dot1.setAttribute('r', '3');
        dot1.setAttribute('class', 'connector-dot');
        dot1.setAttribute('data-rel-index', String(index));
        dot1.setAttribute('fill', 'var(--vscode-terminal-ansiBlue)');
        dot1.setAttribute('opacity', pathData.fromIsColumnLevel ? '0.8' : '0');
        svg.appendChild(dot1);

        var dot2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot2.setAttribute('cx', String(pathData.x2));
        dot2.setAttribute('cy', String(pathData.y2));
        dot2.setAttribute('r', '3');
        dot2.setAttribute('class', 'connector-dot');
        dot2.setAttribute('data-rel-index', String(index));
        dot2.setAttribute('fill', 'var(--vscode-terminal-ansiBlue)');
        dot2.setAttribute('opacity', pathData.toIsColumnLevel ? '0.8' : '0');
        svg.appendChild(dot2);
      });
    }

    /**
     * Partial redraw: only update connectors connected to the given tableKey.
     * Used during drag for performance — avoids clearing and redrawing ALL paths.
     */
    function updateSingle(tableKey) {
      relationships.forEach(function(rel, index) {
        var fromKey = rel.fromSchema + '.' + rel.fromTable;
        var toKey = rel.toSchema + '.' + rel.toTable;

        // Only redraw paths connected to the dragged table
        if (fromKey !== tableKey && toKey !== tableKey) return;

        // Skip if either card not found
        var fromCard = tableLayer.querySelector('[data-schema="' + rel.fromSchema + '"][data-table="' + rel.fromTable + '"]');
        var toCard = tableLayer.querySelector('[data-schema="' + rel.toSchema + '"][data-table="' + rel.toTable + '"]');
        if (!fromCard || !toCard) return;
        if (fromKey === toKey) return;

        var pathData = computeConnectorPath(fromKey, toKey, rel.fromColumn, rel.toColumn);
        if (!pathData) return;

        // Find existing elements by data-rel-index and update their d/position
        var relIndex = String(index);
        var hitArea = svg.querySelector('.hit-area[data-rel-index="' + relIndex + '"]');
        var visiblePath = svg.querySelector('.connector-line[data-rel-index="' + relIndex + '"]');

        if (hitArea) {
          hitArea.setAttribute('d', pathData.d);
        }
        if (visiblePath) {
          visiblePath.setAttribute('d', pathData.d);
        }

        // Update endpoint dots — find the two dots after the visible path for this relationship
        // Dots are at positions: hitArea, visiblePath, dot1, dot2 in DOM order per relationship
        // We need to find them by traversing siblings or use a more targeted approach
        var dots = svg.querySelectorAll('.connector-dot');
        // Each relationship produces 2 dots, so index*2 and index*2+1 would work
        // But since we might have skipped relationships, we need to find dots adjacent to the path
        if (visiblePath) {
          var next1 = visiblePath.nextElementSibling;
          var next2 = next1 ? next1.nextElementSibling : null;
          if (next1 && next1.classList.contains('connector-dot')) {
            next1.setAttribute('cx', String(pathData.x1));
            next1.setAttribute('cy', String(pathData.y1));
            next1.setAttribute('opacity', pathData.fromIsColumnLevel ? '0.8' : '0');
          }
          if (next2 && next2.classList.contains('connector-dot')) {
            next2.setAttribute('cx', String(pathData.x2));
            next2.setAttribute('cy', String(pathData.y2));
            next2.setAttribute('opacity', pathData.toIsColumnLevel ? '0.8' : '0');
          }
        }
      });
    }

    function escapeH(str) {
      var div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    // ─── Animation Loop ──────────────────────────────────────────────────────
    // Drives the ConnectorAnimator: interpolates endpoints and redraws SVG paths
    // using requestAnimationFrame. Graceful degradation if rAF unavailable.
    var animationLoopRunning = false;

    function startAnimationLoop() {
      if (animationLoopRunning) return; // already running
      animationLoopRunning = true;
      requestAnimationFrame(animationLoop);
    }

    function animationLoop() {
      ConnectorAnimator.tick(performance.now());
      animationRedraw();

      if (ConnectorAnimator.isAnimating()) {
        requestAnimationFrame(animationLoop);
      } else {
        animationLoopRunning = false;
        // Final full redraw to ensure everything is at target positions
        drawConnectors();
      }
    }

    /**
     * Redraw connectors with interpolated positions during animation.
     * For relationships with active animations, compute interpolated endpoints
     * and update SVG path d attributes directly. For other relationships, use
     * the standard computeConnectorPath.
     */
    function animationRedraw() {
      relationships.forEach(function(rel, index) {
        var fromKey = rel.fromSchema + '.' + rel.fromTable;
        var toKey = rel.toSchema + '.' + rel.toTable;
        if (fromKey === toKey) return;

        var relIndexStr = String(index);
        var hitArea = svg.querySelector('.hit-area[data-rel-index="' + relIndexStr + '"]');
        var visiblePath = svg.querySelector('.connector-line[data-rel-index="' + relIndexStr + '"]');
        if (!hitArea && !visiblePath) return;

        var x1, y1, x2, y2;
        var dot1Opacity, dot2Opacity;

        // Check if this relationship has an active animation
        var anim = ConnectorAnimator.activeAnimations.get(index);
        if (anim) {
          // Compute interpolated position
          var now = performance.now();
          var elapsed = now - anim.startTime;
          var t = Math.min(Math.max(elapsed / anim.duration, 0), 1);

          x1 = anim.startFrom.x + (anim.targetFrom.x - anim.startFrom.x) * t;
          y1 = anim.startFrom.y + (anim.targetFrom.y - anim.startFrom.y) * t;
          x2 = anim.startTo.x + (anim.targetTo.x - anim.startTo.x) * t;
          y2 = anim.startTo.y + (anim.targetTo.y - anim.startTo.y) * t;

          // Interpolate dot opacity synchronized with endpoint transition
          dot1Opacity = anim.dotOpacityStart.from + (anim.dotOpacityTarget.from - anim.dotOpacityStart.from) * t;
          dot2Opacity = anim.dotOpacityStart.to + (anim.dotOpacityTarget.to - anim.dotOpacityStart.to) * t;
        } else {
          // No animation — use standard path computation
          var pathData = computeConnectorPath(fromKey, toKey, rel.fromColumn, rel.toColumn);
          if (!pathData) return;
          x1 = pathData.x1;
          y1 = pathData.y1;
          x2 = pathData.x2;
          y2 = pathData.y2;
          dot1Opacity = pathData.fromIsColumnLevel ? 0.8 : 0;
          dot2Opacity = pathData.toIsColumnLevel ? 0.8 : 0;
        }

        // Compute bezier control points from interpolated endpoints
        var fromPos = positionMap.get(fromKey);
        var toPos = positionMap.get(toKey);
        if (!fromPos || !toPos) return;

        var fromCenterX = fromPos.x + CARD_WIDTH / 2;
        var toCenterX = toPos.x + CARD_WIDTH / 2;
        var dx = Math.abs(x2 - x1);
        var cpOffset = Math.max(dx * 0.4, 40);
        var cp1x = x1 + (fromCenterX < toCenterX ? cpOffset : -cpOffset);
        var cp1y = y1;
        var cp2x = x2 + (fromCenterX < toCenterX ? -cpOffset : cpOffset);
        var cp2y = y2;

        var d = 'M ' + x1 + ' ' + y1 + ' C ' + cp1x + ' ' + cp1y + ' ' + cp2x + ' ' + cp2y + ' ' + x2 + ' ' + y2;

        // Update path d attributes
        if (hitArea) {
          hitArea.setAttribute('d', d);
        }
        if (visiblePath) {
          visiblePath.setAttribute('d', d);

          // Update endpoint dots (siblings after the visible path)
          var next1 = visiblePath.nextElementSibling;
          var next2 = next1 ? next1.nextElementSibling : null;
          if (next1 && next1.classList.contains('connector-dot')) {
            next1.setAttribute('cx', String(x1));
            next1.setAttribute('cy', String(y1));
            next1.setAttribute('opacity', String(dot1Opacity));
          }
          if (next2 && next2.classList.contains('connector-dot')) {
            next2.setAttribute('cx', String(x2));
            next2.setAttribute('cy', String(y2));
            next2.setAttribute('opacity', String(dot2Opacity));
          }
        }
      });
    }

    // Initial draw after layout
    setTimeout(drawConnectors, 100);

    // Initial minimap setup — will be triggered after MinimapRenderer is defined
    // (see post-MinimapRenderer initialization below)

    // ─── InteractionController (relationship line click/highlight) ────────────
    var InteractionController = (function() {
      var activeRelIndex = null;
      var fkTooltip = document.getElementById('fk-tooltip');

      // Track mousedown position on hit areas for click vs drag discrimination (4px threshold)
      var hitAreaMouseDown = null; // { x, y, relIndex }

      /**
       * Get the midpoint of a bezier curve connector for tooltip positioning.
       * Computes the point at t=0.5 on the cubic bezier.
       */
      function getConnectorMidpoint(relIndex) {
        var rel = relationships[relIndex];
        if (!rel) return null;

        var fromKey = rel.fromSchema + '.' + rel.fromTable;
        var toKey = rel.toSchema + '.' + rel.toTable;
        var pathData = computeConnectorPath(fromKey, toKey, rel.fromColumn, rel.toColumn);
        if (!pathData) return null;

        // Use the resolved endpoints from computeConnectorPath (column-level or card-center)
        var fromPos = positionMap.get(fromKey);
        var toPos = positionMap.get(toKey);
        if (!fromPos || !toPos) return null;

        var fromCenterX = fromPos.x + CARD_WIDTH / 2;
        var toCenterX = toPos.x + CARD_WIDTH / 2;

        var x1 = pathData.x1;
        var y1 = pathData.y1;
        var x2 = pathData.x2;
        var y2 = pathData.y2;

        var dx = Math.abs(x2 - x1);
        var cpOffset = Math.max(dx * 0.4, 40);
        var cp1x = x1 + (fromCenterX < toCenterX ? cpOffset : -cpOffset);
        var cp1y = y1;
        var cp2x = x2 + (fromCenterX < toCenterX ? -cpOffset : cpOffset);
        var cp2y = y2;

        // Evaluate cubic bezier at t = 0.5
        var t = 0.5;
        var mt = 1 - t;
        var midX = mt*mt*mt*x1 + 3*mt*mt*t*cp1x + 3*mt*t*t*cp2x + t*t*t*x2;
        var midY = mt*mt*mt*y1 + 3*mt*mt*t*cp1y + 3*mt*t*t*cp2y + t*t*t*y2;

        return { x: midX, y: midY };
      }

      /**
       * Activate a connector: apply .active to it, .highlighted to connected cards, .dimmed to all others.
       */
      function activateConnector(relIndex) {
        var rel = relationships[relIndex];
        if (!rel) return;

        activeRelIndex = relIndex;

        var fromKey = rel.fromSchema + '.' + rel.fromTable;
        var toKey = rel.toSchema + '.' + rel.toTable;
        var connectedKeys = new Set([fromKey, toKey]);

        // Apply .active to the clicked connector, .dimmed to all others
        svg.querySelectorAll('.connector-line').forEach(function(line) {
          var idx = parseInt(line.getAttribute('data-rel-index'), 10);
          if (idx === relIndex) {
            line.classList.add('active');
            line.classList.remove('dimmed');
          } else {
            line.classList.add('dimmed');
            line.classList.remove('active');
          }
        });

        // Update connector dots: active dots use accent color with full opacity (only at column-level endpoints)
        svg.querySelectorAll('.connector-dot').forEach(function(dot) {
          var idx = parseInt(dot.getAttribute('data-rel-index'), 10);
          if (idx === relIndex) {
            dot.classList.add('active');
            dot.setAttribute('fill', 'var(--vscode-focusBorder)');
            // Only show active dot at column-level endpoints
            var dotRel = relationships[idx];
            var dotFromKey = dotRel.fromSchema + '.' + dotRel.fromTable;
            var dotToKey = dotRel.toSchema + '.' + dotRel.toTable;
            // Determine if this dot is the "from" or "to" dot by checking its position
            var nextSibling = dot.nextElementSibling;
            var prevSibling = dot.previousElementSibling;
            // First dot follows the path, second dot follows the first dot
            if (prevSibling && prevSibling.classList.contains('connector-line')) {
              // This is the first dot (from endpoint)
              dot.setAttribute('opacity', isColumnLevelEndpoint(dotFromKey, dotRel.fromColumn) ? '1.0' : '0');
            } else if (prevSibling && prevSibling.classList.contains('connector-dot')) {
              // This is the second dot (to endpoint)
              dot.setAttribute('opacity', isColumnLevelEndpoint(dotToKey, dotRel.toColumn) ? '1.0' : '0');
            }
          } else {
            dot.classList.remove('active');
            dot.setAttribute('fill', 'var(--vscode-terminal-ansiBlue)');
            // Restore opacity based on column-level state
            var otherRel = relationships[idx];
            if (otherRel) {
              var oFromKey = otherRel.fromSchema + '.' + otherRel.fromTable;
              var oToKey = otherRel.toSchema + '.' + otherRel.toTable;
              var prevSib = dot.previousElementSibling;
              if (prevSib && prevSib.classList.contains('connector-line')) {
                dot.setAttribute('opacity', isColumnLevelEndpoint(oFromKey, otherRel.fromColumn) ? '0.8' : '0');
              } else if (prevSib && prevSib.classList.contains('connector-dot')) {
                dot.setAttribute('opacity', isColumnLevelEndpoint(oToKey, otherRel.toColumn) ? '0.8' : '0');
              }
            }
          }
        });

        // Apply .highlighted to connected table cards, .dimmed to all others
        document.querySelectorAll('.table-card').forEach(function(card) {
          var key = card.dataset.schema + '.' + card.dataset.table;
          if (connectedKeys.has(key)) {
            card.classList.add('highlighted');
            card.classList.remove('dimmed');
          } else {
            card.classList.add('dimmed');
            card.classList.remove('highlighted');
          }
        });

        // Show FK detail tooltip at connector midpoint
        showFkDetail(relIndex);
      }

      /**
       * Deactivate all: remove .active, .highlighted, .dimmed from everything and dismiss tooltip.
       */
      function deactivateAll() {
        activeRelIndex = null;

        svg.querySelectorAll('.connector-line').forEach(function(line) {
          line.classList.remove('active');
          line.classList.remove('dimmed');
        });

        // Revert connector dots to default styling
        svg.querySelectorAll('.connector-dot').forEach(function(dot) {
          dot.classList.remove('active');
          dot.setAttribute('fill', 'var(--vscode-terminal-ansiBlue)');
          // Restore opacity based on column-level state
          var idx = parseInt(dot.getAttribute('data-rel-index'), 10);
          var dotRel = relationships[idx];
          if (dotRel) {
            var dFromKey = dotRel.fromSchema + '.' + dotRel.fromTable;
            var dToKey = dotRel.toSchema + '.' + dotRel.toTable;
            var prevSib = dot.previousElementSibling;
            if (prevSib && prevSib.classList.contains('connector-line')) {
              dot.setAttribute('opacity', isColumnLevelEndpoint(dFromKey, dotRel.fromColumn) ? '0.8' : '0');
            } else if (prevSib && prevSib.classList.contains('connector-dot')) {
              dot.setAttribute('opacity', isColumnLevelEndpoint(dToKey, dotRel.toColumn) ? '0.8' : '0');
            }
          } else {
            dot.setAttribute('opacity', '0');
          }
        });

        document.querySelectorAll('.table-card').forEach(function(card) {
          card.classList.remove('highlighted');
          card.classList.remove('dimmed');
        });

        hideTooltip();
      }

      /**
       * Show FK detail tooltip at the midpoint of the active connector.
       */
      function showFkDetail(relIndex) {
        var rel = relationships[relIndex];
        if (!rel) { hideTooltip(); return; }

        var midpoint = getConnectorMidpoint(relIndex);
        if (!midpoint) { hideTooltip(); return; }

        // Build tooltip content: constraint name (line 1) + column mapping (line 2)
        var constraintName = rel.constraintName || 'FK Constraint';
        var mapping = rel.fromSchema + '.' + rel.fromTable + '.' + rel.fromColumn
          + ' \\u2192 '
          + rel.toSchema + '.' + rel.toTable + '.' + rel.toColumn;

        fkTooltip.innerHTML = '<div style="font-weight:600;">' + escapeH(constraintName) + '</div>'
          + '<div style="color:var(--vscode-descriptionForeground);">' + escapeH(mapping) + '</div>';

        // Position tooltip at the midpoint in diagram space, converted to screen space
        // The tooltip is positioned absolutely within #canvas, so we need the diagram-space
        // midpoint transformed through the viewport transform
        var vpState = ViewportController.getState();
        var screenX = midpoint.x * vpState.zoom + vpState.panX;
        var screenY = midpoint.y * vpState.zoom + vpState.panY;

        fkTooltip.style.left = screenX + 'px';
        fkTooltip.style.top = screenY + 'px';
        fkTooltip.classList.remove('hidden');
      }

      /**
       * Hide the FK detail tooltip.
       */
      function hideTooltip() {
        fkTooltip.classList.add('hidden');
      }

      /**
       * Handle click on a hit area (after confirming it's a click, not a drag).
       */
      function onHitAreaClick(e, relIndex) {
        e.stopPropagation();

        if (activeRelIndex === relIndex) {
          // Toggle off: clicking the same active connector deactivates it
          deactivateAll();
        } else {
          // Deactivate previous, activate new (or activate from none)
          deactivateAll();
          activateConnector(relIndex);
        }
      }

      /**
       * Handle canvas background click: clear everything.
       */
      function onCanvasClick(e) {
        // Only act if clicking on canvas/viewport/svg background (not on cards or connectors)
        if (e.target === canvas || e.target === viewportEl || e.target === svg) {
          if (activeRelIndex !== null) {
            deactivateAll();
          }
        }
      }

      // ─── Event Bindings (using event delegation on SVG) ─────────────────────

      // Hit-area paths have pointer-events: stroke which overrides the parent SVG's
      // pointer-events: none. Events on hit areas bubble up to the viewport element.
      // Use event delegation on the viewport to catch hit area mousedown/mouseup.
      viewportEl.addEventListener('mousedown', function(e) {
        var hitArea = e.target.closest('.hit-area');
        if (!hitArea) return;

        // Record mousedown position for 4px threshold
        hitAreaMouseDown = {
          x: e.clientX,
          y: e.clientY,
          relIndex: parseInt(hitArea.getAttribute('data-rel-index'), 10)
        };
      });

      viewportEl.addEventListener('mouseup', function(e) {
        if (!hitAreaMouseDown) return;

        var dx = e.clientX - hitAreaMouseDown.x;
        var dy = e.clientY - hitAreaMouseDown.y;
        var distance = Math.sqrt(dx * dx + dy * dy);

        if (distance <= 4) {
          // This is a click (movement ≤4px) — activate/deactivate connector
          onHitAreaClick(e, hitAreaMouseDown.relIndex);
        }
        // If distance > 4px, it's a drag/pan — do nothing (ViewportController handles it)

        hitAreaMouseDown = null;
      });

      // Canvas background click to clear selection
      canvas.addEventListener('click', function(e) {
        onCanvasClick(e);
      });

      return {
        activeRelIndex: activeRelIndex,
        getActiveRelIndex: function() { return activeRelIndex; },
        onHitAreaClick: onHitAreaClick,
        onCanvasClick: onCanvasClick,
        deactivateAll: deactivateAll
      };
    })();
    // ─── End InteractionController ───────────────────────────────────────────

    // ─── HoverTooltipController (FK line hover tooltips) ─────────────────────
    var HoverTooltipController = (function() {
      var fkTooltip = document.getElementById('fk-tooltip');
      var isHovering = false;
      var hoveredRelIndex = null;

      /**
       * Position the tooltip at cursor + 12px offset, with boundary detection.
       * Flips left/above cursor if tooltip would extend past canvas edge.
       * Coordinates are relative to the #canvas element.
       */
      function positionTooltip(clientX, clientY) {
        var canvasRect = canvas.getBoundingClientRect();
        var cursorX = clientX - canvasRect.left;
        var cursorY = clientY - canvasRect.top;

        // Default position: 12px right, 12px below cursor
        var tooltipX = cursorX + 12;
        var tooltipY = cursorY + 12;

        // Show tooltip temporarily to measure its dimensions
        fkTooltip.style.left = tooltipX + 'px';
        fkTooltip.style.top = tooltipY + 'px';
        fkTooltip.classList.remove('hidden');

        var tooltipWidth = fkTooltip.offsetWidth;
        var tooltipHeight = fkTooltip.offsetHeight;
        var canvasWidth = canvasRect.width;
        var canvasHeight = canvasRect.height;

        // Boundary detection: flip tooltip left if it would extend past right edge
        if (tooltipX + tooltipWidth > canvasWidth) {
          tooltipX = cursorX - 12 - tooltipWidth;
        }

        // Boundary detection: flip tooltip above if it would extend past bottom edge
        if (tooltipY + tooltipHeight > canvasHeight) {
          tooltipY = cursorY - 12 - tooltipHeight;
        }

        fkTooltip.style.left = tooltipX + 'px';
        fkTooltip.style.top = tooltipY + 'px';
      }

      /**
       * Show hover tooltip for a relationship at the given cursor position.
       */
      function showHoverTooltip(relIndex, clientX, clientY) {
        var rel = relationships[relIndex];
        if (!rel) return;

        // Build tooltip content: constraint name (line 1) + column mapping (line 2)
        var constraintName = rel.constraintName || 'FK Constraint';
        var mapping = rel.fromSchema + '.' + rel.fromTable + '.' + rel.fromColumn
          + ' \u2192 '
          + rel.toSchema + '.' + rel.toTable + '.' + rel.toColumn;

        fkTooltip.innerHTML = '<div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:400px;">' + escapeH(constraintName) + '</div>'
          + '<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:400px;color:var(--vscode-descriptionForeground);">' + escapeH(mapping) + '</div>';

        positionTooltip(clientX, clientY);
        isHovering = true;
        hoveredRelIndex = relIndex;
      }

      /**
       * Hide the hover tooltip immediately.
       */
      function hideHoverTooltip() {
        // Only hide if we are in hover mode (don't hide click-activated tooltip)
        if (isHovering) {
          fkTooltip.classList.add('hidden');
          isHovering = false;
          hoveredRelIndex = null;
        }
      }

      // ─── Event Bindings (event delegation on viewportEl) ────────────────────

      viewportEl.addEventListener('mouseenter', function(e) {
        var hitArea = e.target.closest ? e.target.closest('.hit-area') : null;
        if (!hitArea) return;

        var relIndex = parseInt(hitArea.getAttribute('data-rel-index'), 10);

        // Suppress hover tooltip if this line is the currently active connector (Req 6.6)
        if (InteractionController.getActiveRelIndex() === relIndex) return;

        showHoverTooltip(relIndex, e.clientX, e.clientY);
      }, true); // use capture phase to catch events on SVG children

      viewportEl.addEventListener('mousemove', function(e) {
        if (!isHovering) return;

        var hitArea = e.target.closest ? e.target.closest('.hit-area') : null;
        if (!hitArea) {
          // Mouse moved off a hit area but still in viewport — hide tooltip
          hideHoverTooltip();
          return;
        }

        var relIndex = parseInt(hitArea.getAttribute('data-rel-index'), 10);

        // If moved to a different hit area, update tooltip for the new line
        if (relIndex !== hoveredRelIndex) {
          // Suppress hover tooltip if this line is the currently active connector
          if (InteractionController.getActiveRelIndex() === relIndex) {
            hideHoverTooltip();
            return;
          }
          showHoverTooltip(relIndex, e.clientX, e.clientY);
          return;
        }

        // Suppress hover tooltip if this line became the active connector
        if (InteractionController.getActiveRelIndex() === relIndex) {
          hideHoverTooltip();
          return;
        }

        // Update tooltip position maintaining 12px offset
        positionTooltip(e.clientX, e.clientY);
      }, true);

      viewportEl.addEventListener('mouseleave', function(e) {
        var hitArea = e.target.closest ? e.target.closest('.hit-area') : null;
        if (hitArea || isHovering) {
          hideHoverTooltip();
        }
      }, true);

      // Also listen for mouseout from hit area paths specifically
      // (mouseenter/mouseleave with capture on the parent catches child-to-parent transitions)
      svg.addEventListener('mouseout', function(e) {
        if (!isHovering) return;
        // If the related target is not a hit area (or null), hide tooltip
        var relatedTarget = e.relatedTarget;
        if (!relatedTarget || !(relatedTarget.closest && relatedTarget.closest('.hit-area'))) {
          hideHoverTooltip();
        }
      });

      return {
        isHovering: function() { return isHovering; },
        hideHoverTooltip: hideHoverTooltip
      };
    })();
    // ─── End HoverTooltipController ──────────────────────────────────────────

    // ─── ExportRenderer (PNG and SVG export) ─────────────────────────────────
    var ExportRenderer = (function() {
      var PADDING = 40;

      /**
       * Compute the diagram bounding box from all positions in positionMap + card dimensions.
       * Returns { minX, minY, maxX, maxY, width, height } or null if no tables.
       */
      function computeBoundingBox() {
        if (positionMap.size === 0) return null;

        var minX = Infinity, minY = Infinity;
        var maxX = -Infinity, maxY = -Infinity;

        positionMap.forEach(function(pos) {
          if (pos.x < minX) minX = pos.x;
          if (pos.y < minY) minY = pos.y;
          if (pos.x + CARD_WIDTH > maxX) maxX = pos.x + CARD_WIDTH;
          if (pos.y + CARD_HEIGHT > maxY) maxY = pos.y + CARD_HEIGHT;
        });

        // Also account for expanded cards (taller than CARD_HEIGHT)
        document.querySelectorAll('.table-card.expanded').forEach(function(card) {
          var key = card.dataset.schema + '.' + card.dataset.table;
          var pos = positionMap.get(key);
          if (pos) {
            var cardBottom = pos.y + card.offsetHeight;
            if (cardBottom > maxY) maxY = cardBottom;
          }
        });

        return {
          minX: minX - PADDING,
          minY: minY - PADDING,
          maxX: maxX + PADDING,
          maxY: maxY + PADDING,
          width: (maxX - minX) + PADDING * 2,
          height: (maxY - minY) + PADDING * 2
        };
      }

      /**
       * Get the current background color from computed styles (VS Code theme).
       */
      function getBackgroundColor() {
        return getComputedStyle(document.body).backgroundColor || '#1e1e1e';
      }

      /**
       * Get the foreground color from computed styles.
       */
      function getForegroundColor() {
        return getComputedStyle(document.body).color || '#cccccc';
      }

      /**
       * Get the connector stroke color from computed styles.
       */
      function getConnectorColor() {
        var line = document.querySelector('.connector-line');
        if (line) {
          return getComputedStyle(line).stroke || '#569cd6';
        }
        return '#569cd6';
      }

      /**
       * Get the card background color from computed styles.
       */
      function getCardBackgroundColor() {
        var card = document.querySelector('.table-card');
        if (card) {
          return getComputedStyle(card).backgroundColor || '#252526';
        }
        return '#252526';
      }

      /**
       * Get the card border color from computed styles.
       */
      function getCardBorderColor() {
        var card = document.querySelector('.table-card');
        if (card) {
          return getComputedStyle(card).borderColor || '#444444';
        }
        return '#444444';
      }

      /**
       * Get the card header background color from computed styles.
       */
      function getHeaderBackgroundColor() {
        var header = document.querySelector('.table-header');
        if (header) {
          return getComputedStyle(header).backgroundColor || '#333333';
        }
        return '#333333';
      }

      /**
       * Export diagram as PNG at 2x DPI.
       * Creates an offscreen canvas, draws background + connectors + table cards,
       * encodes as base64, and posts to extension host.
       */
      function exportPng() {
        var bbox = computeBoundingBox();
        if (!bbox) return; // No tables — do nothing

        var dpr = 2; // 2x DPI for retina quality
        var canvasEl = document.createElement('canvas');
        canvasEl.width = bbox.width * dpr;
        canvasEl.height = bbox.height * dpr;
        var ctx = canvasEl.getContext('2d');
        if (!ctx) return;

        // Scale for retina
        ctx.scale(dpr, dpr);

        // Offset to account for bounding box origin
        var offsetX = -bbox.minX;
        var offsetY = -bbox.minY;

        // 1. Draw background
        ctx.fillStyle = getBackgroundColor();
        ctx.fillRect(0, 0, bbox.width, bbox.height);

        // 2. Draw all connector bezier paths
        var connectorColor = getConnectorColor();
        ctx.strokeStyle = connectorColor;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.6;

        relationships.forEach(function(rel) {
          var fromKey = rel.fromSchema + '.' + rel.fromTable;
          var toKey = rel.toSchema + '.' + rel.toTable;
          if (fromKey === toKey) return;

          var pathData = computeConnectorPath(fromKey, toKey, rel.fromColumn, rel.toColumn);
          if (!pathData) return;

          // Use the resolved endpoints from computeConnectorPath (column-level for expanded, card-center for collapsed)
          var x1 = pathData.x1;
          var y1 = pathData.y1;
          var x2 = pathData.x2;
          var y2 = pathData.y2;

          var fromPos = positionMap.get(fromKey);
          var toPos = positionMap.get(toKey);
          if (!fromPos || !toPos) return;

          var fromCenterX = fromPos.x + CARD_WIDTH / 2;
          var toCenterX = toPos.x + CARD_WIDTH / 2;

          var dx = Math.abs(x2 - x1);
          var cpOffset = Math.max(dx * 0.4, 40);
          var cp1x = x1 + (fromCenterX < toCenterX ? cpOffset : -cpOffset);
          var cp1y = y1;
          var cp2x = x2 + (fromCenterX < toCenterX ? -cpOffset : cpOffset);
          var cp2y = y2;

          // Draw bezier curve
          ctx.beginPath();
          ctx.moveTo(x1 + offsetX, y1 + offsetY);
          ctx.bezierCurveTo(
            cp1x + offsetX, cp1y + offsetY,
            cp2x + offsetX, cp2y + offsetY,
            x2 + offsetX, y2 + offsetY
          );
          ctx.stroke();

          // Draw endpoint dots (only visible at column-level endpoints)
          ctx.fillStyle = connectorColor;
          if (pathData.fromIsColumnLevel) {
            ctx.globalAlpha = 0.8;
            ctx.beginPath();
            ctx.arc(x1 + offsetX, y1 + offsetY, 3, 0, Math.PI * 2);
            ctx.fill();
          }
          if (pathData.toIsColumnLevel) {
            ctx.globalAlpha = 0.8;
            ctx.beginPath();
            ctx.arc(x2 + offsetX, y2 + offsetY, 3, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 0.6;
        });

        ctx.globalAlpha = 1.0;

        // 3. Draw all table cards as rounded rectangles with text
        var cardBg = getCardBackgroundColor();
        var cardBorder = getCardBorderColor();
        var headerBg = getHeaderBackgroundColor();
        var fgColor = getForegroundColor();
        var borderRadius = 6;

        document.querySelectorAll('.table-card').forEach(function(card) {
          var key = card.dataset.schema + '.' + card.dataset.table;
          var pos = positionMap.get(key);
          if (!pos) return;

          var isExpanded = card.classList.contains('expanded');
          var cardW = CARD_WIDTH;
          var cardH = isExpanded ? card.offsetHeight : CARD_HEIGHT;

          var x = pos.x + offsetX;
          var y = pos.y + offsetY;

          // Draw card background with rounded corners
          ctx.fillStyle = cardBg;
          ctx.strokeStyle = cardBorder;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x + borderRadius, y);
          ctx.lineTo(x + cardW - borderRadius, y);
          ctx.quadraticCurveTo(x + cardW, y, x + cardW, y + borderRadius);
          ctx.lineTo(x + cardW, y + cardH - borderRadius);
          ctx.quadraticCurveTo(x + cardW, y + cardH, x + cardW - borderRadius, y + cardH);
          ctx.lineTo(x + borderRadius, y + cardH);
          ctx.quadraticCurveTo(x, y + cardH, x, y + cardH - borderRadius);
          ctx.lineTo(x, y + borderRadius);
          ctx.quadraticCurveTo(x, y, x + borderRadius, y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();

          // Draw header background
          var headerH = 35;
          ctx.fillStyle = headerBg;
          ctx.beginPath();
          ctx.moveTo(x + borderRadius, y);
          ctx.lineTo(x + cardW - borderRadius, y);
          ctx.quadraticCurveTo(x + cardW, y, x + cardW, y + borderRadius);
          ctx.lineTo(x + cardW, y + headerH);
          ctx.lineTo(x, y + headerH);
          ctx.lineTo(x, y + borderRadius);
          ctx.quadraticCurveTo(x, y, x + borderRadius, y);
          ctx.closePath();
          ctx.fill();

          // Draw header separator line
          ctx.strokeStyle = cardBorder;
          ctx.beginPath();
          ctx.moveTo(x, y + headerH);
          ctx.lineTo(x + cardW, y + headerH);
          ctx.stroke();

          // Draw table name text in header
          ctx.fillStyle = fgColor;
          ctx.font = '600 12px var(--vscode-font-family, sans-serif)';
          var schemaText = card.dataset.schema + '.';
          var nameText = card.dataset.table;
          ctx.globalAlpha = 0.7;
          var textX = x + 12;
          var textY = y + headerH / 2 + 4;
          ctx.fillText(schemaText, textX, textY);
          var schemaWidth = ctx.measureText(schemaText).width;
          ctx.globalAlpha = 1.0;
          ctx.fillText(nameText, textX + schemaWidth, textY);

          // If expanded, draw column rows
          if (isExpanded) {
            var rowY = y + headerH;
            var rows = card.querySelectorAll('.column-row');
            ctx.font = '11px var(--vscode-font-family, sans-serif)';
            rows.forEach(function(row) {
              rowY += 22;
              var colName = row.querySelector('.column-name');
              var colType = row.querySelector('.column-type');
              if (colName) {
                ctx.fillStyle = fgColor;
                ctx.globalAlpha = 1.0;
                ctx.fillText(colName.textContent || '', x + 30, rowY);
              }
              if (colType) {
                ctx.fillStyle = fgColor;
                ctx.globalAlpha = 0.6;
                ctx.fillText(colType.textContent || '', x + 140, rowY);
              }
            });
            ctx.globalAlpha = 1.0;
          }
        });

        // 4. Encode as base64 and post to extension host
        var dataUrl = canvasEl.toDataURL('image/png');
        var base64Data = dataUrl.replace(/^data:image\\/png;base64,/, '');
        vscode.postMessage({ type: 'export-png', data: base64Data });
      }

      /**
       * Export diagram as SVG.
       * Creates SVG root with bounding box dimensions, copies connector paths,
       * wraps table card HTML in foreignObject, inlines CSS, serializes to string,
       * and posts to extension host.
       */
      function exportSvg() {
        var bbox = computeBoundingBox();
        if (!bbox) return; // No tables — do nothing

        var offsetX = -bbox.minX;
        var offsetY = -bbox.minY;

        // Create SVG root
        var svgNs = 'http://www.w3.org/2000/svg';
        var xhtmlNs = 'http://www.w3.org/1999/xhtml';
        var svgRoot = document.createElementNS(svgNs, 'svg');
        svgRoot.setAttribute('xmlns', svgNs);
        svgRoot.setAttribute('xmlns:xhtml', xhtmlNs);
        svgRoot.setAttribute('width', String(bbox.width));
        svgRoot.setAttribute('height', String(bbox.height));
        svgRoot.setAttribute('viewBox', '0 0 ' + bbox.width + ' ' + bbox.height);

        // Add background rect with theme color
        var bgRect = document.createElementNS(svgNs, 'rect');
        bgRect.setAttribute('width', String(bbox.width));
        bgRect.setAttribute('height', String(bbox.height));
        bgRect.setAttribute('fill', getBackgroundColor());
        svgRoot.appendChild(bgRect);

        // Inline CSS styles
        var styleEl = document.querySelector('style');
        var cssText = styleEl ? styleEl.textContent : '';
        var svgStyle = document.createElementNS(svgNs, 'style');
        svgStyle.textContent = cssText;
        svgRoot.appendChild(svgStyle);

        // Copy all connector SVG paths (visible ones and dots) offset by bounding box origin
        var connectorGroup = document.createElementNS(svgNs, 'g');
        connectorGroup.setAttribute('transform', 'translate(' + offsetX + ',' + offsetY + ')');

        svg.querySelectorAll('.connector-line').forEach(function(line) {
          var clone = line.cloneNode(true);
          connectorGroup.appendChild(clone);
        });
        svg.querySelectorAll('.connector-dot').forEach(function(dot) {
          var clone = dot.cloneNode(true);
          connectorGroup.appendChild(clone);
        });
        svgRoot.appendChild(connectorGroup);

        // Wrap each table card HTML in foreignObject
        document.querySelectorAll('.table-card').forEach(function(card) {
          var key = card.dataset.schema + '.' + card.dataset.table;
          var pos = positionMap.get(key);
          if (!pos) return;

          var isExpanded = card.classList.contains('expanded');
          var cardW = CARD_WIDTH;
          var cardH = isExpanded ? card.offsetHeight : CARD_HEIGHT;

          var fo = document.createElementNS(svgNs, 'foreignObject');
          fo.setAttribute('x', String(pos.x + offsetX));
          fo.setAttribute('y', String(pos.y + offsetY));
          fo.setAttribute('width', String(cardW));
          fo.setAttribute('height', String(cardH));

          // Clone card HTML content
          var cardClone = card.cloneNode(true);
          cardClone.setAttribute('xmlns', xhtmlNs);
          // Reset position styles (foreignObject handles positioning)
          cardClone.style.position = 'relative';
          cardClone.style.left = '0';
          cardClone.style.top = '0';
          fo.appendChild(cardClone);
          svgRoot.appendChild(fo);
        });

        // Serialize to string
        var serializer = new XMLSerializer();
        var svgString = serializer.serializeToString(svgRoot);
        vscode.postMessage({ type: 'export-svg', data: svgString });
      }

      // ─── Button bindings ────────────────────────────────────────────────────
      var exportPngBtn = document.getElementById('exportPng');
      var exportSvgBtn = document.getElementById('exportSvg');

      if (exportPngBtn) {
        exportPngBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          exportPng();
        });
      }

      if (exportSvgBtn) {
        exportSvgBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          exportSvg();
        });
      }

      return {
        exportPng: exportPng,
        exportSvg: exportSvg
      };
    })();
    // ─── End ExportRenderer ──────────────────────────────────────────────────

    // ─── MinimapRenderer (scaled overview canvas with click-to-navigate) ─────
    var MinimapRenderer = (function() {
      var minimapCanvas = document.getElementById('minimap');
      var ctx = minimapCanvas.getContext('2d');
      var MINIMAP_WIDTH = 180;
      var MINIMAP_HEIGHT = 120;
      var CARD_WIDTH = 220;
      var CARD_HEIGHT = 60;
      var PADDING = 8;
      var MIN_RECT_WIDTH = 4;
      var MIN_RECT_HEIGHT = 3;
      var isDragging = false;

      function setVisible(tableCount) {
        if (tableCount > 15) {
          minimapCanvas.style.display = 'block';
        } else {
          minimapCanvas.style.display = 'none';
        }
      }

      function computeBoundingBox(posMap) {
        var minX = Infinity, minY = Infinity;
        var maxX = -Infinity, maxY = -Infinity;
        posMap.forEach(function(pos) {
          if (pos.x < minX) minX = pos.x;
          if (pos.y < minY) minY = pos.y;
          if (pos.x + CARD_WIDTH > maxX) maxX = pos.x + CARD_WIDTH;
          if (pos.y + CARD_HEIGHT > maxY) maxY = pos.y + CARD_HEIGHT;
        });
        if (minX === Infinity) {
          return { x: 0, y: 0, width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT };
        }
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
      }

      function redraw(posMap, viewportState, canvasSize) {
        // Clear canvas
        ctx.clearRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);

        // Draw background with theme color at 0.85 opacity
        var bgColor = getComputedStyle(document.body).getPropertyValue('--vscode-editorWidget-background').trim() || '#252526';
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);
        ctx.globalAlpha = 1.0;

        if (posMap.size === 0) return;

        // Compute diagram bounding box with padding
        var bbox = computeBoundingBox(posMap);
        var bboxPaddedWidth = bbox.width + PADDING * 2;
        var bboxPaddedHeight = bbox.height + PADDING * 2;

        // Compute uniform scale to fit within minimap
        var scaleX = MINIMAP_WIDTH / bboxPaddedWidth;
        var scaleY = MINIMAP_HEIGHT / bboxPaddedHeight;
        var scale = Math.min(scaleX, scaleY);

        // Centering offset within minimap
        var scaledWidth = bboxPaddedWidth * scale;
        var scaledHeight = bboxPaddedHeight * scale;
        var offsetX = (MINIMAP_WIDTH - scaledWidth) / 2;
        var offsetY = (MINIMAP_HEIGHT - scaledHeight) / 2;

        // Draw filled rectangles per card
        var fgColor = getComputedStyle(document.body).getPropertyValue('--vscode-editor-foreground').trim() || '#cccccc';
        ctx.fillStyle = fgColor;
        ctx.globalAlpha = 0.6;

        posMap.forEach(function(pos) {
          var rx = offsetX + (pos.x - bbox.x + PADDING) * scale;
          var ry = offsetY + (pos.y - bbox.y + PADDING) * scale;
          var rw = Math.max(CARD_WIDTH * scale, MIN_RECT_WIDTH);
          var rh = Math.max(CARD_HEIGHT * scale, MIN_RECT_HEIGHT);
          ctx.fillRect(rx, ry, rw, rh);
        });

        ctx.globalAlpha = 1.0;

        // Draw viewport indicator rectangle
        var vpState = viewportState;
        var canvasEl = document.getElementById('canvas');
        var canvasW = canvasSize.w || canvasEl.clientWidth;
        var canvasH = canvasSize.h || canvasEl.clientHeight;

        // The visible area in diagram coordinates
        var visibleLeft = (0 - vpState.panX) / vpState.zoom;
        var visibleTop = (0 - vpState.panY) / vpState.zoom;
        var visibleWidth = canvasW / vpState.zoom;
        var visibleHeight = canvasH / vpState.zoom;

        // Convert visible area to minimap coordinates
        var vpRectX = offsetX + (visibleLeft - bbox.x + PADDING) * scale;
        var vpRectY = offsetY + (visibleTop - bbox.y + PADDING) * scale;
        var vpRectW = visibleWidth * scale;
        var vpRectH = visibleHeight * scale;

        // Draw viewport indicator with accent color
        var accentColor = getComputedStyle(document.body).getPropertyValue('--vscode-focusBorder').trim() || '#007acc';

        // Fill with 0.2 opacity
        ctx.globalAlpha = 0.2;
        ctx.fillStyle = accentColor;
        ctx.fillRect(vpRectX, vpRectY, vpRectW, vpRectH);

        // 1px border with full opacity
        ctx.globalAlpha = 1.0;
        ctx.strokeStyle = accentColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(vpRectX, vpRectY, vpRectW, vpRectH);
      }

      function minimapToDiagram(mx, my) {
        // Reverse the minimap coordinate transformation to get diagram coordinates
        var bbox = computeBoundingBox(positionMap);
        var bboxPaddedWidth = bbox.width + PADDING * 2;
        var bboxPaddedHeight = bbox.height + PADDING * 2;

        var scaleX = MINIMAP_WIDTH / bboxPaddedWidth;
        var scaleY = MINIMAP_HEIGHT / bboxPaddedHeight;
        var scale = Math.min(scaleX, scaleY);

        var scaledWidth = bboxPaddedWidth * scale;
        var scaledHeight = bboxPaddedHeight * scale;
        var offsetX = (MINIMAP_WIDTH - scaledWidth) / 2;
        var offsetY = (MINIMAP_HEIGHT - scaledHeight) / 2;

        // Convert minimap pixel coords to diagram coords
        var diagX = (mx - offsetX) / scale - PADDING + bbox.x;
        var diagY = (my - offsetY) / scale - PADDING + bbox.y;

        return { x: diagX, y: diagY };
      }

      function navigateTo(mx, my) {
        var diagCoords = minimapToDiagram(mx, my);
        var canvasEl = document.getElementById('canvas');
        var canvasW = canvasEl.clientWidth;
        var canvasH = canvasEl.clientHeight;
        var vpState = ViewportController.getState();

        // Center the viewport on the clicked diagram coordinates
        vpState.panX = (canvasW / 2) - diagCoords.x * vpState.zoom;
        vpState.panY = (canvasH / 2) - diagCoords.y * vpState.zoom;

        ViewportController.applyTransform();
        notifyViewportChange();
      }

      function triggerRedraw() {
        var canvasEl = document.getElementById('canvas');
        redraw(positionMap, ViewportController.getState(), { w: canvasEl.clientWidth, h: canvasEl.clientHeight });
      }

      function onMouseDown(e) {
        e.stopPropagation();
        e.preventDefault();
        isDragging = true;
        var rect = minimapCanvas.getBoundingClientRect();
        var mx = e.clientX - rect.left;
        var my = e.clientY - rect.top;
        navigateTo(mx, my);
      }

      function onMouseMove(e) {
        if (!isDragging) return;
        e.stopPropagation();
        e.preventDefault();
        var rect = minimapCanvas.getBoundingClientRect();
        var mx = e.clientX - rect.left;
        var my = e.clientY - rect.top;
        navigateTo(mx, my);
      }

      function onMouseUp(e) {
        if (!isDragging) return;
        e.stopPropagation();
        e.preventDefault();
        isDragging = false;
      }

      // ─── Event Bindings ─────────────────────────────────────────────────────

      minimapCanvas.addEventListener('mousedown', onMouseDown);
      document.addEventListener('mousemove', function(e) {
        if (isDragging) {
          onMouseMove(e);
        }
      });
      document.addEventListener('mouseup', function(e) {
        if (isDragging) {
          onMouseUp(e);
        }
      });

      // Stop propagation on all minimap interactions to prevent canvas pan
      minimapCanvas.addEventListener('click', function(e) {
        e.stopPropagation();
      });

      return {
        canvas: minimapCanvas,
        ctx: ctx,
        redraw: redraw,
        onMouseDown: onMouseDown,
        onMouseMove: onMouseMove,
        onMouseUp: onMouseUp,
        setVisible: setVisible,
        triggerRedraw: triggerRedraw
      };
    })();
    // ─── End MinimapRenderer ─────────────────────────────────────────────────

    // Initialize minimap: set visibility and initial redraw after layout is ready
    MinimapRenderer.setVisible(tables.length);
    setTimeout(function() {
      MinimapRenderer.triggerRedraw();
    }, 150);

    // Register minimap as a listener for viewport and position changes
    onViewportChangeCallbacks.push(function() {
      MinimapRenderer.triggerRedraw();
    });
    onPositionChangeCallbacks.push(function() {
      MinimapRenderer.triggerRedraw();
    });

    // Handle resize: redraw all connectors within one animation frame
    var resizeRafId = null;
    window.addEventListener('resize', function() {
      if (resizeRafId !== null) return;
      resizeRafId = requestAnimationFrame(function() {
        resizeRafId = null;
        drawConnectors();
        MinimapRenderer.triggerRedraw();
      });
    });
    `;
  }

  /**
   * Returns the layout algorithm as a self-contained JavaScript function string
   * for embedding in the webview. This is the browser-compatible version of
   * src/schemaDiagramLayout.ts (no TypeScript, no imports).
   */
  private getLayoutAlgorithmJs(): string {
    return `
    function layoutAlgorithm(input) {
      var REPULSION_STRENGTH = 8000;
      var ATTRACTION_STRENGTH = 0.003;
      var GRAVITY_STRENGTH = 0.005;
      var DAMPING_FACTOR = 0.85;
      var ISOLATED_TABLE_OFFSET = 80;

      var config = {
        canvasWidth: (input.config && input.config.canvasWidth) || 1920,
        canvasHeight: (input.config && input.config.canvasHeight) || 1080,
        cardWidth: (input.config && input.config.cardWidth) || 220,
        cardHeight: (input.config && input.config.cardHeight) || 60,
        minGap: (input.config && input.config.minGap) || 24,
        iterations: (input.config && input.config.iterations) || 300
      };

      var result = new Map();
      if (!input.tables || input.tables.length === 0) { return result; }

      // Deduplicate
      var seen = new Set();
      var uniqueTables = [];
      for (var i = 0; i < input.tables.length; i++) {
        var t = input.tables[i];
        var key = t.schema + '.' + t.name;
        if (!seen.has(key)) {
          seen.add(key);
          uniqueTables.push({ schema: t.schema, name: t.name, key: key });
        }
      }

      // Single table: center
      if (uniqueTables.length === 1) {
        result.set(uniqueTables[0].key, { x: 40, y: 40 });
        return result;
      }

      // Build adjacency
      var tableKeys = new Set(uniqueTables.map(function(t) { return t.key; }));
      var adjacency = new Map();
      uniqueTables.forEach(function(t) { adjacency.set(t.key, new Set()); });
      (input.relationships || []).forEach(function(rel) {
        var fromKey = rel.fromSchema + '.' + rel.fromTable;
        var toKey = rel.toSchema + '.' + rel.toTable;
        if (tableKeys.has(fromKey) && tableKeys.has(toKey) && fromKey !== toKey) {
          adjacency.get(fromKey).add(toKey);
          adjacency.get(toKey).add(fromKey);
        }
      });

      // Classify connected vs isolated
      var connectedKeys = new Set();
      adjacency.forEach(function(neighbors, key) {
        if (neighbors.size > 0) { connectedKeys.add(key); }
      });
      var isolatedKeys = uniqueTables.map(function(t) { return t.key; }).filter(function(k) { return !connectedKeys.has(k); });

      // Initialize positions: horizontal spread for connected, grid for isolated
      var positions = new Map();
      var centerX = config.canvasWidth / 2;
      var centerY = config.canvasHeight / 2;

      var connectedList = uniqueTables.filter(function(t) { return connectedKeys.has(t.key); });
      if (connectedList.length > 0) {
        var spacing = config.cardWidth + config.minGap + 40;
        var maxPerRow = Math.max(3, Math.ceil(Math.sqrt(connectedList.length * 2)));
        var rowSpacing = config.cardHeight + config.minGap + 60;

        for (var ci = 0; ci < connectedList.length; ci++) {
          var col = ci % maxPerRow;
          var row = Math.floor(ci / maxPerRow);
          var rowCount = Math.min(maxPerRow, connectedList.length - row * maxPerRow);
          var rowWidth = (rowCount - 1) * spacing;
          var rowStartX = centerX - rowWidth / 2;
          var totalRows = Math.ceil(connectedList.length / maxPerRow);

          positions.set(connectedList[ci].key, {
            x: rowStartX + col * spacing,
            y: centerY - ((totalRows - 1) * rowSpacing) / 2 + row * rowSpacing
          });
        }
      }
      if (isolatedKeys.length > 0) {
        var cols = Math.ceil(Math.sqrt(isolatedKeys.length));
        var gridStartX = centerX - (cols * (config.cardWidth + config.minGap)) / 2;
        var gridStartY = centerY + config.canvasHeight * 0.25;
        for (var ii = 0; ii < isolatedKeys.length; ii++) {
          var iCol = ii % cols;
          var iRow = Math.floor(ii / cols);
          positions.set(isolatedKeys[ii], {
            x: gridStartX + iCol * (config.cardWidth + config.minGap),
            y: gridStartY + iRow * (config.cardHeight + config.minGap)
          });
        }
      }

      // Velocities
      var velocities = new Map();
      uniqueTables.forEach(function(t) { velocities.set(t.key, { vx: 0, vy: 0 }); });
      var keys = uniqueTables.map(function(t) { return t.key; });

      // Force simulation
      for (var iter = 0; iter < config.iterations; iter++) {
        var forces = new Map();
        keys.forEach(function(k) { forces.set(k, { fx: 0, fy: 0 }); });

        // Repulsion
        for (var ri = 0; ri < keys.length; ri++) {
          for (var rj = ri + 1; rj < keys.length; rj++) {
            var posA = positions.get(keys[ri]);
            var posB = positions.get(keys[rj]);
            var dx = posA.x - posB.x;
            var dy = posA.y - posB.y;
            var distSq = dx * dx + dy * dy;
            if (distSq < 1) { distSq = 1; dx = 1; dy = 0; }
            var dist = Math.sqrt(distSq);
            var force = REPULSION_STRENGTH / distSq;
            var fx = (dx / dist) * force;
            var fy = (dy / dist) * force;
            var fA = forces.get(keys[ri]);
            var fB = forces.get(keys[rj]);
            fA.fx += fx; fA.fy += fy;
            fB.fx -= fx; fB.fy -= fy;
          }
        }

        // Attraction
        adjacency.forEach(function(neighbors, key) {
          var pA = positions.get(key);
          var frc = forces.get(key);
          neighbors.forEach(function(nk) {
            var pB = positions.get(nk);
            frc.fx += (pB.x - pA.x) * ATTRACTION_STRENGTH;
            frc.fy += (pB.y - pA.y) * ATTRACTION_STRENGTH;
          });
        });

        // Gravity
        keys.forEach(function(k) {
          var p = positions.get(k);
          var f = forces.get(k);
          f.fx += (centerX - p.x) * GRAVITY_STRENGTH;
          f.fy += (centerY - p.y) * GRAVITY_STRENGTH;
        });

        // Apply
        keys.forEach(function(k) {
          var vel = velocities.get(k);
          var f = forces.get(k);
          vel.vx = (vel.vx + f.fx) * DAMPING_FACTOR;
          vel.vy = (vel.vy + f.fy) * DAMPING_FACTOR;
          var p = positions.get(k);
          p.x += vel.vx;
          p.y += vel.vy;
        });
      }

      // Overlap resolution
      function resolveOverlaps() {
        var effectiveWidth = config.cardWidth + config.minGap;
        var effectiveHeight = config.cardHeight + config.minGap;
        for (var pass = 0; pass < 50; pass++) {
          var hadOverlap = false;
          for (var oi = 0; oi < keys.length; oi++) {
            for (var oj = oi + 1; oj < keys.length; oj++) {
              var pA = positions.get(keys[oi]);
              var pB = positions.get(keys[oj]);
              var ox = effectiveWidth - Math.abs(pA.x - pB.x);
              var oy = effectiveHeight - Math.abs(pA.y - pB.y);
              if (ox > 0 && oy > 0) {
                hadOverlap = true;
                if (ox < oy) {
                  var pushX = ox / 2 + 1;
                  if (pA.x < pB.x) { pA.x -= pushX; pB.x += pushX; }
                  else { pA.x += pushX; pB.x -= pushX; }
                } else {
                  var pushY = oy / 2 + 1;
                  if (pA.y < pB.y) { pA.y -= pushY; pB.y += pushY; }
                  else { pA.y += pushY; pB.y -= pushY; }
                }
              }
            }
          }
          if (!hadOverlap) break;
        }
      }

      resolveOverlaps();

      // Isolated separation
      if (connectedKeys.size > 0 && isolatedKeys.length > 0) {
        var minBX = Infinity, minBY = Infinity, maxBX = -Infinity, maxBY = -Infinity;
        connectedKeys.forEach(function(ck) {
          var p = positions.get(ck);
          if (p.x < minBX) minBX = p.x;
          if (p.y < minBY) minBY = p.y;
          if (p.x + config.cardWidth > maxBX) maxBX = p.x + config.cardWidth;
          if (p.y + config.cardHeight > maxBY) maxBY = p.y + config.cardHeight;
        });
        isolatedKeys.forEach(function(ik) {
          var p = positions.get(ik);
          var iLeft = p.x, iRight = p.x + config.cardWidth;
          var iTop = p.y, iBottom = p.y + config.cardHeight;
          var dL = iLeft - maxBX, dR = minBX - iRight;
          var dT = iTop - maxBY, dB = minBY - iBottom;
          var hOvr = !(dL >= 0 || dR >= 0);
          var vOvr = !(dT >= 0 || dB >= 0);
          if (hOvr && vOvr) {
            var opts = [
              { axis: 'x', dir: 1, dist: maxBX - iLeft + ISOLATED_TABLE_OFFSET },
              { axis: 'x', dir: -1, dist: iRight - minBX + ISOLATED_TABLE_OFFSET },
              { axis: 'y', dir: 1, dist: maxBY - iTop + ISOLATED_TABLE_OFFSET },
              { axis: 'y', dir: -1, dist: iBottom - minBY + ISOLATED_TABLE_OFFSET }
            ];
            opts.sort(function(a, b) { return a.dist - b.dist; });
            var best = opts[0];
            if (best.axis === 'x') p.x += best.dir * best.dist;
            else p.y += best.dir * best.dist;
          } else if (hOvr) {
            var vDist = Math.max(dT, dB);
            if (vDist < ISOLATED_TABLE_OFFSET) {
              var needed = ISOLATED_TABLE_OFFSET - vDist;
              if (dT >= 0) p.y += needed; else p.y -= needed;
            }
          } else if (vOvr) {
            var hDist = Math.max(dL, dR);
            if (hDist < ISOLATED_TABLE_OFFSET) {
              var needed2 = ISOLATED_TABLE_OFFSET - hDist;
              if (dL >= 0) p.x += needed2; else p.x -= needed2;
            }
          }
        });
      }

      resolveOverlaps();

      // Normalize: shift so top-left is at (40, 40) padding
      var minPosX = Infinity, minPosY = Infinity;
      keys.forEach(function(k) {
        var p = positions.get(k);
        if (p.x < minPosX) minPosX = p.x;
        if (p.y < minPosY) minPosY = p.y;
      });
      if (minPosX !== Infinity) {
        var shiftX = 40 - minPosX;
        var shiftY = 40 - minPosY;
        keys.forEach(function(k) {
          var p = positions.get(k);
          p.x += shiftX;
          p.y += shiftY;
        });
      }

      // Build result
      keys.forEach(function(k) {
        var p = positions.get(k);
        result.set(k, { x: p.x, y: p.y });
      });

      return result;
    }
    `;
  }
}

// ─── HTML Helpers ───────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
