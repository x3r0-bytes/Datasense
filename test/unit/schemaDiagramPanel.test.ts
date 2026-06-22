// Unit tests for SchemaDiagramPanel changes (Task 3.4)
// Validates Requirements 2.1, 2.2, 2.3, 2.4, 3.8

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock vscode ─────────────────────────────────────────────────────────────
// vi.mock is hoisted to the top of the file by vitest, so we must NOT reference
// variables declared with const/let inside the factory. Use vi.fn() inline and
// retrieve the mock references via vi.mocked() after the import.

vi.mock('vscode', () => ({
  ViewColumn: {
    Active: 1,
    Beside: 2,
  },
  window: {
    createWebviewPanel: vi.fn(),
    withProgress: vi.fn((_opts: any, task: () => Promise<void>) => task()),
  },
  ProgressLocation: {
    Notification: 15,
  },
  Uri: {
    parse: vi.fn((s: string) => ({ toString: () => s })),
  },
}));

import * as vscode from 'vscode';
import { SchemaDiagramPanel, DiagramData } from '../../src/schemaDiagramPanel';

// ─── Test data helpers ───────────────────────────────────────────────────────

function makeExtensionUri(): vscode.Uri {
  return vscode.Uri.parse('vscode-test://extension');
}

function emptyDiagramData(): DiagramData {
  return { tables: [], relationships: [] };
}

function singleTableData(
  schema: string,
  tableName: string,
  withRelationships = false
): DiagramData {
  return {
    tables: [
      {
        schema,
        name: tableName,
        columns: [
          { name: 'Id', dataType: 'int', isPrimaryKey: true, isForeignKey: false },
        ],
      },
    ],
    relationships: withRelationships
      ? [
          {
            fromSchema: schema,
            fromTable: tableName,
            fromColumn: 'Id',
            toSchema: 'dbo',
            toTable: 'Other',
            toColumn: 'RefId',
            constraintName: 'FK_Test',
          },
        ]
      : [],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SchemaDiagramPanel', () => {
  let panelInstance: SchemaDiagramPanel;
  let mockPanel: {
    title: string;
    webview: { html: string; onDidReceiveMessage: ReturnType<typeof vi.fn> };
    reveal: ReturnType<typeof vi.fn>;
    onDidDispose: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Create a fresh mock panel for each test
    mockPanel = {
      title: '',
      webview: { html: '', onDidReceiveMessage: vi.fn() },
      reveal: vi.fn(),
      onDidDispose: vi.fn(),
      dispose: vi.fn(),
    };

    // Make createWebviewPanel return our fresh mock panel
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mockPanel as any);

    panelInstance = new SchemaDiagramPanel(makeExtensionUri());
  });

  // ==========================================================================
  // Requirement 2.1 — show() creates the panel with ViewColumn.Active
  // ==========================================================================

  describe('show() — ViewColumn.Active (Requirement 2.1)', () => {
    it('creates the webview panel with ViewColumn.Active (not ViewColumn.Beside)', () => {
      panelInstance.show(emptyDiagramData(), 'Schema Diagram - MyDB');

      expect(vscode.window.createWebviewPanel).toHaveBeenCalledOnce();

      const [, , viewColumn] = vi.mocked(vscode.window.createWebviewPanel).mock.calls[0];
      expect(viewColumn).toBe(vscode.ViewColumn.Active);
    });

    it('does NOT create the panel with ViewColumn.Beside', () => {
      panelInstance.show(emptyDiagramData(), 'Schema Diagram - MyDB');

      const [, , viewColumn] = vi.mocked(vscode.window.createWebviewPanel).mock.calls[0];
      expect(viewColumn).not.toBe(vscode.ViewColumn.Beside);
    });

    it('passes the title as the panel display name', () => {
      panelInstance.show(emptyDiagramData(), 'My Custom Title');

      const [, title] = vi.mocked(vscode.window.createWebviewPanel).mock.calls[0];
      expect(title).toBe('My Custom Title');
    });

    it('sets webview HTML after creation', () => {
      panelInstance.show(emptyDiagramData(), 'Schema Diagram');

      expect(mockPanel.webview.html).toBeTruthy();
    });
  });

  // ==========================================================================
  // Requirement 2.2 — revealing an existing panel updates title before render
  // ==========================================================================

  describe('show() — reveal existing panel (Requirement 2.2)', () => {
    it('does not create a second panel when panel already exists', () => {
      panelInstance.show(emptyDiagramData(), 'First Title');
      panelInstance.show(emptyDiagramData(), 'Second Title');

      // createWebviewPanel should only have been called once
      expect(vscode.window.createWebviewPanel).toHaveBeenCalledOnce();
    });

    it('reveals the existing panel with ViewColumn.Active on second call', () => {
      panelInstance.show(emptyDiagramData(), 'First Title');
      panelInstance.show(emptyDiagramData(), 'Second Title');

      expect(mockPanel.reveal).toHaveBeenCalledWith(vscode.ViewColumn.Active);
    });

    it('updates panel.title before rendering new HTML content', () => {
      // First call creates the panel
      panelInstance.show(emptyDiagramData(), 'First Title');

      // Track the order of title assignment and HTML assignment using a sequence log
      const sequence: string[] = [];

      Object.defineProperty(mockPanel, 'title', {
        get() { return sequence.filter(s => s.startsWith('title:')).at(-1)?.slice(6) ?? ''; },
        set(v: string) { sequence.push(`title:${v}`); },
        configurable: true,
      });

      Object.defineProperty(mockPanel.webview, 'html', {
        get() { return ''; },
        set(_v: string) { sequence.push('html'); },
        configurable: true,
      });

      // Second call should update title then set HTML
      panelInstance.show(emptyDiagramData(), 'Updated Title');

      const titleIdx = sequence.indexOf('title:Updated Title');
      const htmlIdx = sequence.indexOf('html');

      expect(titleIdx).toBeGreaterThanOrEqual(0);
      expect(htmlIdx).toBeGreaterThan(titleIdx);
    });

    it('panel.title equals the new title after the second show() call', () => {
      panelInstance.show(emptyDiagramData(), 'First Title');
      panelInstance.show(emptyDiagramData(), 'New Title');

      expect(mockPanel.title).toBe('New Title');
    });
  });

  // ==========================================================================
  // Requirement 2.3 — showDatabaseDiagram sets title to "Schema Diagram - {DB}"
  // ==========================================================================

  describe('showDatabaseDiagram() — title formatting (Requirement 2.3)', () => {
    it('sets title to "Schema Diagram - MyDB"', async () => {
      await panelInstance.showDatabaseDiagram(emptyDiagramData(), 'MyDB');

      // The title is passed as the 2nd argument to createWebviewPanel on first open
      const [, title] = vi.mocked(vscode.window.createWebviewPanel).mock.calls[0];
      expect(title).toBe('Schema Diagram - MyDB');
    });

    it('includes the database name verbatim in the title', async () => {
      await panelInstance.showDatabaseDiagram(emptyDiagramData(), 'Production_2024');

      const [, title] = vi.mocked(vscode.window.createWebviewPanel).mock.calls[0];
      expect(title).toBe('Schema Diagram - Production_2024');
    });

    it('passes the correct title to createWebviewPanel', async () => {
      await panelInstance.showDatabaseDiagram(emptyDiagramData(), 'SalesDB');

      const [, title] = vi.mocked(vscode.window.createWebviewPanel).mock.calls[0];
      expect(title).toBe('Schema Diagram - SalesDB');
    });

    it('opens panel in ViewColumn.Active', async () => {
      await panelInstance.showDatabaseDiagram(emptyDiagramData(), 'MyDB');

      const [, , viewColumn] = vi.mocked(vscode.window.createWebviewPanel).mock.calls[0];
      expect(viewColumn).toBe(vscode.ViewColumn.Active);
    });

    it('updates panel.title when panel already exists', async () => {
      // First call creates the panel
      await panelInstance.showDatabaseDiagram(emptyDiagramData(), 'FirstDB');
      // Second call should set panel.title directly
      await panelInstance.showDatabaseDiagram(emptyDiagramData(), 'SecondDB');

      expect(mockPanel.title).toBe('Schema Diagram - SecondDB');
    });
  });

  // ==========================================================================
  // Requirement 2.4 — showTableDiagram sets title to "Table Diagram - {schema}.{table}"
  // ==========================================================================

  describe('showTableDiagram() — title formatting (Requirement 2.4)', () => {
    it('sets title to "Table Diagram - dbo.Orders"', () => {
      panelInstance.showTableDiagram(singleTableData('dbo', 'Orders'), 'dbo', 'Orders');

      // Title passed to createWebviewPanel on first open
      const [, title] = vi.mocked(vscode.window.createWebviewPanel).mock.calls[0];
      expect(title).toBe('Table Diagram - dbo.Orders');
    });

    it('combines schema and tableName with a dot separator', () => {
      panelInstance.showTableDiagram(singleTableData('hr', 'Employees'), 'hr', 'Employees');

      const [, title] = vi.mocked(vscode.window.createWebviewPanel).mock.calls[0];
      expect(title).toBe('Table Diagram - hr.Employees');
    });

    it('passes the correct title to createWebviewPanel', () => {
      panelInstance.showTableDiagram(singleTableData('sales', 'Invoices'), 'sales', 'Invoices');

      const [, title] = vi.mocked(vscode.window.createWebviewPanel).mock.calls[0];
      expect(title).toBe('Table Diagram - sales.Invoices');
    });

    it('opens panel in ViewColumn.Active', () => {
      panelInstance.showTableDiagram(singleTableData('dbo', 'Products'), 'dbo', 'Products');

      const [, , viewColumn] = vi.mocked(vscode.window.createWebviewPanel).mock.calls[0];
      expect(viewColumn).toBe(vscode.ViewColumn.Active);
    });

    it('updates panel.title when panel already exists', () => {
      // First call creates the panel
      panelInstance.showTableDiagram(singleTableData('dbo', 'Orders'), 'dbo', 'Orders');
      // Second call should set panel.title directly
      panelInstance.showTableDiagram(singleTableData('hr', 'Employees'), 'hr', 'Employees');

      expect(mockPanel.title).toBe('Table Diagram - hr.Employees');
    });
  });

  // ==========================================================================
  // Requirement 3.8 — table with no FK relationships renders with "no relationships" message
  // ==========================================================================

  describe('No FK relationships message (Requirement 3.8)', () => {
    it('includes "No foreign key relationships found." in the HTML when relationships is empty', () => {
      const dataNoRelationships = singleTableData('dbo', 'Orders', false);

      panelInstance.show(dataNoRelationships, 'Table Diagram - dbo.Orders');

      expect(mockPanel.webview.html).toContain('No foreign key relationships found.');
    });

    it('does NOT include the "no relationships" message when relationships exist', () => {
      const dataWithRelationships = singleTableData('dbo', 'Orders', true);

      panelInstance.show(dataWithRelationships, 'Table Diagram - dbo.Orders');

      expect(mockPanel.webview.html).not.toContain('No foreign key relationships found.');
    });

    it('showTableDiagram renders the selected table in the HTML', () => {
      const data = singleTableData('dbo', 'Orders', false);

      panelInstance.showTableDiagram(data, 'dbo', 'Orders');

      expect(mockPanel.webview.html).toContain('Orders');
    });

    it('showTableDiagram with no FK relationships still includes the "no relationships" message', () => {
      const data = singleTableData('dbo', 'Orders', false);

      panelInstance.showTableDiagram(data, 'dbo', 'Orders');

      expect(mockPanel.webview.html).toContain('No foreign key relationships found.');
    });

    it('empty tables array renders an info message (not the no-relationships banner)', () => {
      panelInstance.show(emptyDiagramData(), 'Schema Diagram');

      // An empty table set shows a general info message, not the FK message
      expect(mockPanel.webview.html).not.toContain('No foreign key relationships found.');
    });
  });
});
