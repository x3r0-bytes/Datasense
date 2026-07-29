# Datasense — Project Summary

> **Current Version:** 0.10.2  
> **Last Updated:** 2026-07-28

---

## Executive Summary

**Datasense** is a VS Code extension for Microsoft SQL Server development — combining schema-aware IntelliSense, query execution, object exploration, and result export into a single lightweight tool.

**Target Audience:** Database developers, DBAs, and application developers working with SQL Server in enterprise environments.

**Development Phase:** v0.10.0 — feature complete, undergoing full manual QA pass before v1.0.0 release.

---

## Current Status

Datasense is **feature complete and undergoing QA validation**. All core features are implemented, tested, and stable. A full manual QA pass is required before promoting to v1.0.0.

---

## Known Limitations

The following capabilities are explicitly excluded from v1.0.0:

- No Linux/macOS Windows Authentication support (Windows Auth requires the `msnodesqlv8` ODBC driver, which is Windows-only)
- No edit-in-grid for result sets (results are read-only; data modification requires writing SQL)
- No cross-server joins (queries execute against a single server connection at a time)
- No Azure AD / Entra ID authentication (only SQL Authentication and Windows Authentication are supported)
- No IntelliSense for linked server references
- No query plan comparison (side-by-side plan diff)

---

## Features

### 1. T-SQL Syntax Highlighting

A TextMate grammar (`syntaxes/tsql.tmLanguage.json`) provides colorization for SQL files — keywords, identifiers, strings, comments, data types, etc.

### 2. Schema-Aware IntelliSense

A Language Server Protocol (LSP) implementation provides context-sensitive completions:

- **Tables, views, stored procedures** from the connected database
- **Columns** scoped to the table referenced in the current clause
- **Context detection** — knows whether you're in a `SELECT`, `FROM`, `JOIN`, `WHERE`, `EXEC`, CTE, etc. and offers appropriate suggestions
- **Clause State Engine** — formal state transition model tracking which clauses are present and suggesting only grammatically valid successors, with scope isolation for subqueries and CTE bodies
- **4-tier ranking system** — required keywords (tier 0) > columns/aliases/functions (tier 1) > CTE names (tier 2) > schema objects (tier 3)
- **Context-based noise reduction** — FROM/JOIN contexts show only tables/views/CTEs; SELECT/WHERE contexts show only columns/functions; immediately after JOIN suppresses keywords until a table is typed
- **Deterministic keyword injection** — FROM always appears after SELECT column list, ON after JOIN table reference, successor clauses after FROM
- **CTE Resolver** — dedicated module for chained CTE resolution with column propagation through 10+ CTEs, forward reference handling, bracketed identifiers, and column list syntax
- **Smart Join Generator** — suggests JOINs based on foreign key relationships and auto-generates the `ON` clause
- **SELECT \* expansion** — expands `SELECT *` into an explicit column list
- **Schema hover tooltips** — hover over a table, column, or view name to see metadata
- **Contextual keywords** — merges keyword completions (e.g., `FROM` after `SELECT *`, `JOIN` after `INNER`) alongside schema objects
- **Alias generation** — auto-generates table aliases in JOIN completions
- **CTE alias-dot completion** — type `cte_alias.` to get column suggestions with proper resolution priority (table alias > CTE alias > direct CTE name)
- **Smart Aggregation Helper** — type-aware aggregate function completions with snippet insertion (`SUM($1)`), numeric columns ranked higher for arithmetic aggregates, `*` option for COUNT/COUNT_BIG
- **Auto GROUP BY Injection** — detects non-aggregated columns in SELECT and offers a pre-populated `GROUP BY` completion or quick-fix code action
- **HAVING clause awareness** — prioritizes aggregate functions and GROUP BY columns in HAVING context
- **T-SQL Snippet Library** — five pre-built code templates (MERGE, TRY/CATCH, cursor loop, pagination, dynamic SQL) served as IntelliSense completions with tab-stop navigation. Context-aware ranking elevates relevant snippets based on typing context (INSERT/UPDATE → MERGE, BEGIN → TRY/CATCH, DECLARE+cursor → cursor loop, ORDER BY → pagination). Available regardless of connection state.
- **Dynamic SQL IntelliSense** — schema-aware completions inside string literals passed to `EXEC()` and `sp_executesql`. Extracts SQL content from string arguments, unescapes paired quotes, handles variable concatenation boundaries (`' + @var + '`), and provides column/table completions based on the detected SQL clause context. Falls back to keyword-only completions when disconnected or SQL is unparseable.
- **Cross-Database Name Completion** — suggests database names from the multi-database cache in FROM/JOIN contexts when the typed prefix doesn't match local objects. Insertions are bracket-quoted with a trailing dot (e.g., `[OtherDB].`) to start three-part name flow. Ranked at tier 3 below local objects.

### 3. Query Execution

- Run SQL queries from the editor and view results in a dedicated bottom panel tab
- **Batch splitting** — supports `GO` separators to execute multi-batch scripts
- **CodeLens** — inline "Run Query" buttons above batches
- **Statement Outline** — full box border decoration around the active statement using a theme-aware color (`sqlServer.statementOutlineBorder`) with defaults for dark, light, and high-contrast themes. Customizable via theme or `workbench.colorCustomizations`.
- **Per-Statement CodeLens** — inline "Run Statement" / "Stop" buttons above each individual statement, with a 500-statement performance threshold
- **Run/Stop Button Toggle** — the editor toolbar play button becomes a stop button during execution, with per-editor state tracking (Idle/Executing/Canceling)
- **Split/Combined Result Panes** — choose between viewing all result sets stacked in one pane ("single" mode) or in separate tabs ("split" mode), with a toolbar toggle button
- **Query Status Indicator** — status bar item (left side, priority -102) showing row count and execution duration after query completion. Displays spinner during execution, "Cancelled" on user cancellation, "Error" on failure. Formats durations as ms/s/m and row counts with comma separators.
- **Parameter Sniffing / Variable Declarations** — Pre-execution hook detects undeclared `@variable` references and prompts for values with type inference. Generates DECLARE statements automatically, eliminating the "must declare scalar variable" error loop. Handles comments, strings, system variables, EXEC params, batch boundaries, and bracket-quoted names.
- **Execution Plan Visualizer** — Request an estimated execution plan (`Ctrl+Shift+M`) and view it as an interactive left-to-right operator tree in a dedicated WebviewPanel. Shows cost percentages, row estimates, index names, and predicates. Highlights expensive operators (>25% cost). Missing index suggestions displayed as CREATE INDEX DDL.
- **Schema Diagram** — Visualize foreign key relationships in an interactive webview graph that opens in the active editor tab. Two commands: "Schema Diagram" on a database renders all user tables and FK relationships; "Table Diagram" on a table renders only that table and its direct FK neighbors. Progress indicator for large databases (>50 tables). Force-directed auto-layout positions related tables near each other with no overlaps. Drag table cards to custom positions; pan the canvas by dragging the background; zoom with scroll wheel (0.3–3.0 range, cursor-centered). Click table cards to expand/collapse column lists with PK/FK icons and data types. Column-level connector anchoring — when expanded, FK relationship lines anchor to the specific FK/PK column row instead of the card center; collapsed cards use card-center. Smooth 200ms animated endpoint transitions on expand/collapse with interruption handling. Connector dots at column-level endpoints for visual clarity. Click relationship lines to highlight connected tables and view FK details; hover lines for quick tooltip inspection. Export diagrams as PNG (2x DPI) or SVG. Minimap overview for diagrams with >15 tables.

### 4. Multi-Result Export

- When a query returns multiple result sets, export commands show a quick pick listing each by label plus "All Results"
- Single result sets bypass the prompt and export directly
- "All Results" combines using per-format strategies:
  - CSV: blank line + new header row between sets
  - JSON: `[{ "label": "...", "rows": [...] }, ...]` array
  - Excel: one worksheet per set (31-char name truncation with collision resolution)
  - INSERT/CREATE+INSERT: blank line + `GO` + blank line between sets
  - Clipboard text: blank line + heading line per set
- Dismissing the quick pick cancels with no output

### 5. Connection Management

- Connect to SQL Server using **SQL Authentication** or **Windows Authentication** (via `msnodesqlv8`)
- Connections stored in `.sql-connections.json` at workspace root
- Passwords are never persisted to disk — prompted at runtime
- Switch between servers and databases on the fly
- Per-editor connection indicator shows which server/database the current `.sql` file is targeting
- **ODBC Driver Detection** — automatically detects missing ODBC driver for Windows Auth and guides through installation with categorized error dialogs (ODBC missing, invalid credentials, unreachable, timeout)
- **Error Rate Limiting** — suppresses repeated connection error notifications within a 5-second window

### 6. Object Explorer

A sidebar tree view (Activity Bar panel) for browsing server structure:

- **Connection Groups** — Named, color-coded folders for organizing connections (e.g., Prod, Dev, Staging). Groups appear as top-level collapsible nodes with colored square icons. Connections inside a group inherit the group's color.
- **Servers** → **Databases** → **Tables / Views / Stored Procedures**
- Under tables: **Columns, Constraints, Triggers, Indexes, Statistics**
- Triggers, indexes, and statistics are rendered as leaf nodes — expanding them no longer causes infinite `getChildren` loops
- **Search** — Filter loaded nodes by name with case-insensitive substring matching (min 2 chars)
- Context menus: "SELECT TOP 100", "Copy Name", "Schema Diagram" (database), "Table Diagram" (table), "Assign to Group" (server), etc.
- Independent connection pools — browsing doesn't affect the active query connection

### 7. Table Preview

- Double-click a table or view in Object Explorer to open a data preview tab
- Shows first N rows (configurable via `sqlServer.defaultRowLimit`, default 100)
- Filter input with explicit Apply button or Enter key to execute WHERE clause
- Click column headers to sort (ASC/DESC toggle)
- "Edit Query" action opens the generated SQL in a new editor
- Uses the Object Explorer connection pool (independent from query execution)
- Duplicate detection — focuses existing tab if already open for the same table

### 8. Extension Settings

- Full VS Code Settings UI integration with grouped configuration:
  - **Editor**: showInlineRunButtons, showStatementOutline
  - **Query**: timeoutSeconds (0–3600)
  - **Results**: displayMode (single/split), autoOpen
  - **Preview**: defaultMode (simple/query)
  - **Top-level**: defaultRowLimit (1–10000), formatting.enabled
- All settings apply at runtime without window reload

### 9. Keyboard Shortcuts

- Discoverable shortcut list via `Ctrl+Shift+/` (QuickPick with categories)
- Default bindings: Run Query (Ctrl+Shift+E), Cancel Query (Ctrl+Shift+Q), Run Current Statement (Ctrl+Enter), Show Execution Plan (Ctrl+Shift+M)

### 10. GO Batch Navigator

- CodeLens annotations ("Batch N of M") on the first non-blank line of each GO-separated batch
- Click CodeLens to open a quick pick menu listing all batches with preview text for fast jumping
- Document Symbols (Namespace kind) provide batch entries in the breadcrumb bar and Outline panel
- Filters empty batches; respects GO inside string literals and block comments
- Single-batch files (no GO separators) produce no annotations
- Toggle: `sqlServer.editor.showBatchNavigator` setting (default: true)

### 11. Find References & Rename in Workspace

- **Find References**: right-click a table/view/column in Object Explorer → searches all `.sql` files
  - Matches unqualified, schema-qualified, and bracket-quoted identifier forms (case-insensitive)
  - Excludes matches inside comments and string literals
  - Column searches filter to files containing the parent table/view
  - Results displayed in VS Code's References panel (peek view)
- **Rename**: prompts for new name, validates, builds a WorkspaceEdit with refactoring preview
  - Preserves schema qualifiers and bracket quoting during replacement
  - Summary notification on completion

### 12. Schema Diff / Compare

- Compare two database schemas and generate migration scripts:
  - Two-step quick pick for source and target connection+database selection
  - Captures full schema snapshots (tables, columns, indexes, PK/FK/UNIQUE/CHECK/DEFAULT constraints)
  - Case-insensitive comparison categorizes: tables only in source, only in target, modified tables
  - Interactive Diff Panel (webview) with expandable sections and side-by-side definitions
  - "Generate ALTER Script" button with optional "Include DROP statements" checkbox
  - Statement ordering: DROPs → CREATE TABLEs → ALTER TABLEs → CREATE INDEXes
  - GO batch separators between each DDL statement
  - Data loss warnings for potentially destructive column modifications
  - Context menu: "Compare Schema With..." on database nodes (pre-selects source)

### 13. SQL Object Search

- Full-text definition search panel in the Object Explorer sidebar (Redgate SQL Search-style):
  - Search across stored procedure definitions, view definitions, function bodies, table column names, and trigger definitions
  - Object type filter toggles (Procedures, Views, Functions, Tables, Triggers) — all enabled by default
  - Scope filtering: All Connections, single server, specific database, or specific schema
  - "Include system databases" toggle (default OFF) for excluding master/model/msdb/tempdb
  - Results grouped hierarchically (connection → database → object type) with match context snippets and line numbers
  - Highlighted match portions using VS Code's find match highlight color
  - Click any result to open the full object definition in a read-only editor tab
  - Parallel execution (max 4 concurrent), 30-second per-database timeout, 500-result cap
  - Cancel support returning partial results; LRU cache (50 entries) invalidated on connection changes
  - Workspace state persistence for filter/scope selections across sessions

### 14. Destructive Query Warning

- Pre-execution safety gate intercepting dangerous SQL statements before they reach the database:
  - Detects UPDATE without WHERE, DELETE without WHERE, TRUNCATE TABLE, DROP TABLE, and DROP DATABASE
  - Handles aliased UPDATE/DELETE patterns, DELETE TOP(n), multi-table JOIN DELETE
  - Per-statement classification — each statement in a batch analyzed independently
  - Ignores destructive keywords inside comments and string literals (no false positives)
  - Case-insensitive keyword detection; top-level WHERE detection (subquery WHERE doesn't count)
  - Modal confirmation dialog showing offending statement snippet and line number
  - Applies to all execution modes (full file, selection, current statement)
  - Fail-safe design — blocks execution on unexpected errors
  - No configuration — always active (v1.0 safety requirement)

---

## Technical Architecture

### Dual-Process Model

| Process | Role |
|---------|------|
| **Extension Host** (`src/`) | UI, connection management, query execution, Object Explorer, result panel |
| **Language Server** (`server/src/`) | IntelliSense completions, schema caching, linting (syntax, semantic, object references, enhanced syntax) — runs as a separate Node.js process communicating over stdio via LSP |

This separation keeps schema introspection off the UI thread.

### Three Independent Connection Managers

| Manager | Purpose |
|---------|---------|
| `ConnectionManager` | Active query execution connection |
| `ObjectExplorerConnectionManager` | Server-level + per-database pools for tree browsing |
| Language Server pool | Schema introspection for IntelliSense |

All three read the same `.sql-connections.json` but maintain their own pools.

### Key Libraries

| Library | Purpose |
|---------|---------|
| **mssql** v12 (Tedious v19 driver) | SQL Server connectivity |
| **msnodesqlv8** | Windows Authentication via ODBC |
| **vscode-languageserver / vscode-languageclient** | LSP protocol |
| **TypeScript 5.4+** | All source code |

### Build & Test

- Two `tsconfig` files: one for client (`src/`), one for server (`server/src/`)
- **vitest** for unit and property-based tests
- **fast-check** for property-based testing (edge case coverage)
- Packaged with `vsce package` (~9 MB VSIX including runtime `node_modules`)

### UI Component Layout

| Component | Location | Visibility |
|-----------|----------|------------|
| Object Explorer | Activity Bar sidebar | Always |
| SQL Search | Activity Bar sidebar (below Object Explorer) | Always |
| Query Results | Bottom panel tab | When query executes |
| Editor Connection Indicator | Status bar, left side | Only for `.sql` files |
| Status Bar (fallback) | Status bar, right side | Always when connected |
| Table Preview | Editor tab (WebviewPanel) | On double-click table/view |
| Statement Outline | Editor decoration | Only for `.sql` files |
| Statement CodeLens | Editor inline | Only for `.sql` files |
| Query Status Indicator | Status bar, left side (priority -102) | After first query execution, SQL files only |
| Execution Plan Panel | Editor tab (WebviewPanel) | On Show Execution Plan command |
| Schema Diagram Panel | Editor tab (WebviewPanel) | On Schema Diagram command (context menu) |
| Schema Diff Panel | Editor tab (WebviewPanel) | On Schema Diff comparison complete |

---

## Version History

### v0.10.2 (Current)

- **Linter False Positive Fixes** — Eliminated six categories of false positive diagnostics across the T-SQL linting pipeline:
  - Alias-qualified column references (e.g., `SELECT a.Name FROM Employees a`) no longer incorrectly flagged as ORL002 — alias now resolves to the underlying table's column set
  - ORDER BY in subqueries with TOP or OFFSET no longer incorrectly flagged as E004
  - Data types with parentheses (e.g., `DECLARE @v VARCHAR(50)`) no longer flagged as unrecognized functions (ESL003)
  - Bracketed identifiers (e.g., `[dbo].[TableName]`) now correctly match against the schema cache (fixes ORL001 false positives)
  - ORDER BY inside OVER clauses with nested function calls in PARTITION BY no longer incorrectly flagged as E004
  - Removed the unhelpful E012 "TOP without ORDER BY" warning — `SELECT TOP N` without ORDER BY is valid T-SQL for exploratory queries
- Affected modules: `server/src/objectReferenceLinter.ts`, `server/src/semanticLinter.ts`, `server/src/enhancedSyntaxLinter.ts`
- Property-based tests (fast-check) added for both bug condition exploration and preservation of genuine error detection

### v0.10.1

- **Pre-v1 Bugfixes** — Three-part name completions, query cancellation reliability, JOIN ON clause AND conditions, WHERE column/operator suggestions

### v0.10.0

- **Feature Complete Milestone** — All planned features implemented and ready for full manual QA pass before v1.0.0 release
- **Paginated Large Result Sets** — "Show More" button for result sets exceeding 10,000 rows:
  - Initial query caps at 10,000 rows; reports total rows available
  - "Show More (X remaining)" button loads next 10k batch via OFFSET/FETCH
  - Rows appended without replacing previously loaded data
  - Loading state with spinner and disabled button; duplicate click prevention
  - Connection error retains all previously loaded data with retry option
- **Non-Blocking Schema Refresh** — IntelliSense remains responsive during schema cache updates:
  - Atomic snapshot swap — completions served from previous cache while refresh builds a new snapshot in local scope
  - No partial-refresh states observable by completion requests
  - 30-second timeout aborts refresh and retains previous cache
  - Concurrent refresh requests discarded (single in-flight guard)
  - Failed refresh retains previous cache and logs warning
- **Object Explorer Circular Reference Protection** — Graceful handling of circular FK relationships:
  - Constraint items rendered as leaf nodes (no further expansion possible)
  - Ancestor-path cycle detection prevents infinite loops in getChildren
  - Maximum traversal depth of 3 levels from originating table node
  - Self-referencing FK constraints displayed without recursive expansion
- **README Restructure** — New marketplace-facing README with value proposition, 3-step Quick Start, Core Features (5 items), Advanced Features, and link to DEVELOPER-REFERENCE.md
- **PROJECT-SUMMARY Update** — Executive Summary, Current Status, and Known Limitations sections for v1 readiness communication

### v0.9.9

- **Destructive Query Warning** — Pre-execution safety gate that intercepts destructive SQL statements before they reach the database:
  - Detects UPDATE without WHERE, DELETE without WHERE, TRUNCATE TABLE, DROP TABLE, and DROP DATABASE
  - Handles aliased UPDATE/DELETE patterns, DELETE TOP(n), multi-table JOIN DELETE
  - Per-statement classification in multi-statement batches (each analyzed independently)
  - Ignores destructive keywords inside comments (`--`, `/* */` including nested) and string literals
  - Case-insensitive keyword detection; top-level WHERE detection (subquery WHERE doesn't count)
  - Modal confirmation dialog: "This statement affects all rows. Continue?" / "This is a destructive operation. Continue?"
  - Shows offending statement snippet with line number, truncated to 200 chars
  - Applies to all execution modes (full file, selection, current statement)
  - Fail-safe: blocks execution on any unexpected error during analysis
  - No configuration — always active
- New source modules: `src/destructiveStatementAnalyzer.ts`, `src/destructiveQueryGuard.ts`
- Enhanced: `src/extension.ts` (guard integration in `runQuery` and `runCurrentStatement`)

### v0.9.8

- **SQL Object Search** — Redgate SQL Search-style full-text definition search panel in the Object Explorer sidebar:
  - WebviewViewProvider-based panel with search input, object type filter toggles, and scope dropdowns
  - Searches stored procedure definitions, view definitions, function bodies, table column names, and trigger definitions
  - LIKE pattern construction with proper SQL wildcard escaping (parameterized queries for injection safety)
  - Parallel database search with concurrency limit (4), 30-second per-database timeout, and cancel support
  - Results grouped by connection → database → object type with match context snippets and line numbers
  - Click-to-open-definition using existing `openDefinitionEditor()` infrastructure
  - LRU cache (50 entries), workspace state persistence, filter change indicator
  - All styling uses VS Code CSS variables — adapts to dark/light/high-contrast themes
- New source modules: `src/sqlSearchService.ts`, `src/sqlSearchPanelProvider.ts`, `src/sqlSearchProtocol.ts`
- Enhanced: `src/extension.ts`, `package.json`

### v0.9.7

- **Schema Diagram: Column-Level Connectors** — FK relationship lines anchor to specific column rows when table cards are expanded:
  - Endpoints move to the vertical center of the FK/PK column row involved in the relationship (case-insensitive column matching)
  - Collapsed cards retain card-center connection behavior (backward compatible)
  - Smooth 200ms animated transitions on expand/collapse via `requestAnimationFrame` with interruption-safe linear interpolation
  - Horizontal edge selection based on relative card positions (left/right)
  - DOM-based vertical positioning with formula fallback for unrendered elements
  - Connector dots (3px filled circles) at column-level endpoints — fade in/out synchronized with transitions; theme-aware coloring
  - Missing column graceful fallback to expanded card center
  - Drag integration — column-level anchoring maintained during card repositioning
  - Export integration — PNG and SVG render column-level endpoints and dots accurately
  - Minimap unchanged — simplified card-center lines at reduced scale
  - Hit areas and click/hover interactions fully preserved
- Enhanced: `src/schemaDiagramPanel.ts` (resolveConnectionPoint, ConnectorAnimator, getColumnRowInfo, columnRowCache, isColumnLevelEndpoint, animationRedraw, updated computeConnectorPath/drawConnectors/updateSingle/export renderer)

### v0.9.6

- **Interactive Schema Diagram: Polish** — Relationship line interaction, hover tooltips, export, and minimap:
  - Click a relationship line to highlight connected tables and display FK details (constraint name + column mapping) at the connector midpoint
  - Click different lines to switch; click same line again to toggle off; click canvas background to clear all highlights
  - Hit area paths (`stroke-width: 12`, invisible) provide generous click targets on thin SVG lines
  - Dimmed state (opacity 0.25) on non-active cards and connectors for focus clarity
  - Hover tooltips on FK lines — shows constraint name + column mapping at cursor + 12px offset; boundary detection flips tooltip to stay within canvas; suppressed on the currently active line
  - Export PNG — captures full diagram at 2x DPI (retina quality) to an offscreen canvas, posts base64 to extension host, save dialog with file write
  - Export SVG — serializes the diagram DOM with `foreignObject` for HTML cards, inlines CSS, save dialog
  - Error handling: save dialog cancel silently discards; file write failure shows VS Code error notification
  - Minimap — 180×120 canvas overview for diagrams with >15 tables; shows scaled table rectangles and a viewport indicator; click/drag to navigate; hidden for small diagrams
  - Minimap redraws on drag, pan, zoom, and resize; all interactions `stopPropagation` to avoid canvas pan interference
- Enhanced: `src/schemaDiagramPanel.ts` (InteractionController, HoverTooltipController, ExportRenderer, MinimapRenderer, export message handler)

### v0.9.5

- **Interactive Schema Diagram: Core Navigation** — Force-directed auto-layout, drag, pan, and zoom for the Schema Diagram webview:
  - Auto-layout algorithm — deterministic force-directed simulation (300 iterations, inverse-square repulsion, spring attraction, gravity, overlap resolution) computing `{x, y}` positions as a pure function with no DOM or browser API dependency
  - Connected tables cluster together; isolated tables separated ≥80px from the connected cluster; 24px minimum gap between all cards; all positions clamped within 1920×1080 bounds
  - Standalone `src/schemaDiagramLayout.ts` module for testability (exported types: `LayoutInput`, `LayoutConfig`, `Position`, `PositionMap`)
  - Drag-to-reposition — mousedown on `.table-header` initiates drag with 5px movement threshold; rAF-throttled position updates; cursor offset maintained; positions clamped to ≥(0,0); connected connectors redraw per frame; drop shadow during drag
  - Canvas pan — mousedown on background starts pan; no bounds constraints (unlimited panning); rAF-throttled; `grab`/`grabbing` cursor feedback; ends on mouseup, canvas leave, or window leave
  - Zoom — scroll wheel with cursor-centered zoom math; 0.3–3.0 range, 0.1 step per tick; deltaY normalized to single ticks; percentage indicator in bottom-right; double-click indicator resets view
  - Single CSS transform (`translate + scale`) on `#viewport` wrapper for GPU-accelerated pan+zoom compositing
  - Connector renderer — bezier curves computed from PositionMap (not getBoundingClientRect); hit area paths for click targeting; partial redraw via `updateSingle(tableKey)` during drag
  - Backward-compatible click behavior — ≤5px movement toggles expand/collapse + highlights FK-connected tables; >5px movement treated as drag (no toggle)
  - DOM structure updated: `#viewport` wrapper inside `#canvas`, SVG connector layer + table layer inside viewport, zoom indicator and minimap canvas outside viewport
- New source module: `src/schemaDiagramLayout.ts`
- Enhanced: `src/schemaDiagramPanel.ts` (ViewportController, DragController, ConnectorRenderer, absolute positioning, new DOM structure, CSS classes)

### v0.9.4

- **Table Preview IntelliSense** — Syntax highlighting and autocomplete for the Table Preview webview panel:
  - State-machine SQL tokenizer (`highlightSql()`) classifies tokens into keywords, strings, numbers, operators, comments, and functions with HTML-escaped output
  - Query display syntax highlighting — executed SQL query rendered with colorized tokens using VS Code CSS variables for theme adaptation
  - Filter input syntax highlighting — overlay pattern (transparent textarea over highlighted div) provides real-time colorization as users type WHERE clauses
  - Context-aware autocomplete dropdown — suggests column names (with data type labels), SQL keywords, and common functions based on cursor position
  - Context detection: column-start (after AND/OR/start), after-column (comparison operators), after-operator (functions and columns)
  - Keyboard navigation: Arrow Up/Down with wrapping, Enter/Tab to accept, Escape to dismiss, Ctrl+Space to trigger manually
  - Case-insensitive prefix filtering with column-first ordering
  - All logic runs client-side in the webview (no extension host round-trips for completions)
  - VS Code CSS variables exclusively for theming — adapts to dark, light, and high-contrast themes automatically
  - Backward compatible: preserves existing `applyFilter`/`toggleSort` message protocol, `id="filterInput"`, and state restoration
- New source modules: `src/webviewUtils/highlightSql.ts`, `src/webviewUtils/autocompleteContext.ts`
- Enhanced: `src/tablePreviewManager.ts` (inline tokenizer, overlay pattern, autocomplete controller in webview HTML)

### v0.9.3

- **PK Hover Indicator** — Primary key metadata in column hover tooltips:
  - Schema cache queries `sys.indexes` / `sys.index_columns` with `is_primary_key = 1` during refresh
  - PK metadata stored as `Map<string, string[]>` keyed by lowercased `schema.table`, preserving original column casing
  - New `getPrimaryKeyColumns(schema, tableName)` method on `ISchemaCache` with case-insensitive lookup
  - Hover tooltip displays "Primary Key" line after "Table:" and before "Foreign Key →" when column is a PK member
  - Ambiguous columns show per-table PK indicators independently
  - Case-insensitive matching between hovered column and PK metadata
  - PK query runs concurrently in `Promise.all` with existing table/view/procedure/FK queries
  - Graceful degradation: query failure retains prior data; exception in lookup omits indicator silently
  - `querySchemaSnapshot` includes `primaryKeys` property for cross-database hover support

### v0.9.2

- **Object Explorer Search** — Client-side tree filtering for the Object Explorer panel:
  - Search box above the tree view filters loaded nodes by case-insensitive substring match (minimum 2 characters)
  - Matching child nodes displayed with ancestor chain expanded for context
  - Expansion state saved before search and restored on clear
  - 200ms debounced input; 128-character maximum term length
  - Searches across all node types (tables, views, columns, procedures, functions, constraints, triggers, indexes, statistics)
- **Go to Definition Fix** — Three-part name retry in the language server:
  - When `OBJECT_DEFINITION(OBJECT_ID('schema.object'))` returns NULL for supported types (P, V, FN, IF, TF), retries with fully qualified `database.schema.object`
  - 5-second timeout via `Promise.race`; returns `reason: 'encrypted'` if both attempts return NULL
  - Handles schema-qualified and unqualified names (defaults to `dbo`)
  - Returns `reason: 'not_connected'` when no active connection exists
- **Result Panel Column Resize** — Draggable column handles in the query results webview:
  - Draggable `<div class="col-handle">` elements between column headers (5px hit area, full header height)
  - Mouse drag adjusts column width in real-time; clamped to minimum 50px
  - Double-click auto-fits column to widest rendered cell content + 16px padding
  - Removes previous 300px max-width constraint; widths reset on new query results
  - Independent column sizing — resizing one column does not affect others
- New source modules: `src/objectExplorer/searchFilter.ts`, `src/resultPanelUtils.ts`
- Enhanced: `src/objectExplorer/objectExplorerProvider.ts`, `server/src/definitionProvider.ts`, `server/src/server.ts`, `src/resultPanelProvider.ts`

### v0.9.1

- **GO Batch Navigator** — CodeLens and Document Symbol provider for GO-separated batches:
  - "Batch N of M" CodeLens annotations on the first non-blank line of each non-empty batch
  - Click to open quick pick for batch jumping; Document Symbols in breadcrumb/outline
  - Filters empty batches, respects GO inside strings/comments (reuses `batchSplitter` logic)
  - Toggle via `sqlServer.editor.showBatchNavigator` setting
- **Find References in Workspace** — Right-click table/view/column in Object Explorer → search all `.sql` files:
  - Matches unqualified, schema-qualified, and bracket-quoted identifier forms (case-insensitive, word-boundary)
  - Excludes matches inside comments and string literals
  - Column searches filter results to files also containing the parent table/view name
  - Results displayed in VS Code's standard References panel
- **Rename in Workspace** — Bulk text-based rename across workspace SQL files:
  - Preserves schema qualifiers and bracket quoting (`dbo.OldName` → `dbo.NewName`, `[OldName]` → `[NewName]`)
  - Refactoring preview diff with per-file accept/reject before writing
  - Name validation: 1–128 chars, no whitespace or `. [ ] ' "` characters
- **Schema Diff / Compare** — Full database structure comparison and ALTER script generation:
  - Two-step quick pick: source connection+database → target connection+database
  - Schema snapshots via INFORMATION_SCHEMA + sys catalog views (60s timeout)
  - Case-insensitive comparison: tables only in source, only in target, modified (column/index/constraint diffs)
  - Interactive webview Diff Panel with expandable sections, side-by-side source vs target, VS Code theme support
  - "Generate ALTER Script" — ordered T-SQL DDL (DROPs → CREATEs → ALTERs → INDEXes) with GO separators
  - Optional DROP statements; data loss warnings for potentially destructive column changes
  - Context menu: "Compare Schema With..." on database nodes pre-selects source
- New source modules: `src/batchNavigatorProvider.ts`, `src/referenceFinder.ts`, `src/renameRefactorHandler.ts`, `src/schemaDiff/` directory (6 files)
- New commands: `sqlServer.findReferencesInWorkspace`, `sqlServer.renameInWorkspace`, `sqlServer.schemaDiff`, `sqlServer.schemaDiffFromNode`, `sqlServer.generateAlterScript`
- New setting: `sqlServer.editor.showBatchNavigator`
- Extended `src/batchSplitter.ts` with `splitBatchesWithLineInfo` (backward-compatible)

### v0.9.0

- **Multi-Result Export** — Export commands now support queries that return multiple result sets:
  - Quick pick prompt lists each result set by tab label plus "All Results" for multi-result queries
  - Single result sets bypass the prompt entirely
  - Per-format All-Results strategies: CSV (blank line + new header), JSON (`[{label, rows}]`), Excel (one worksheet per set, 31-char name truncation with numeric suffix on collision), INSERT/CREATE+INSERT (blank line + `GO` separator), clipboard text (heading line per set)
  - Pure serializer functions in `src/serializers/multiResultSerializers.ts` (testable without VS Code mocks)
- **Schema Diagram Opens in Active Tab** — `SchemaDiagramPanel` now uses `ViewColumn.Active`; diagrams open as full editor tabs. Revealing an existing panel updates its title before rendering new content.
- **Schema Diagram vs Table Diagram Context Menu Split** — Two separate commands registered in `package.json`:
  - `sqlServer.showSchemaDiagram` (context: `viewItem == database`) — full ERD of all user tables
  - `sqlServer.showTableDiagram` (context: `viewItem == table`) — focused diagram of selected table + direct FK neighbors; "no FK relationships found" message for isolated tables; progress indicator for >50 tables
- **Object Explorer Infinite Loop Fix** — Added `TriggerNode`, `IndexNode`, `StatisticNode` interfaces to `src/objectExplorer/types.ts` with `kind: 'trigger' | 'index' | 'statistic'`. `getTreeItem` maps these to `collapsibleState: None`; `getChildren` returns `[]` defensively. Eliminates the recursive expansion loop that froze the tree view.
- **Schema-Aware Object Reference Linting (Phase 3)** — New `server/src/objectReferenceLinter.ts` module integrated into `lintDocument()`:
  - Validates table/view names in FROM/JOIN against the schema cache (Warning severity)
  - Unqualified names resolve against `dbo` first then any schema; two-part names use specified schema; three-part names silently skipped for unknown databases
  - Column references in SELECT/WHERE/ON/GROUP BY/ORDER BY validated against in-scope tables
  - CTEs, `#temp` tables, and derived table aliases treated as valid
  - Skips entirely when `isConnected === false`, cache empty, or `isRefreshing === true`
- **Enhanced Syntax Error Detection (Phase 4)** — New `server/src/enhancedSyntaxLinter.ts` module integrated into `lintDocument()`:
  - Invalid keyword sequences (e.g., `SELECT FROM`, `WHERE ORDER BY`) → Error, always runs
  - Invalid data type names in CAST/CONVERT (33-type `VALID_DATA_TYPES` set) → Error, always runs
  - Unrecognized function names (not in `BUILTIN_FUNCTIONS` set or schema cache procedures) → Warning, connected only
  - Invalid INSERT column names for cached tables → Warning, connected only
- New source files: `server/src/objectReferenceLinter.ts`, `server/src/enhancedSyntaxLinter.ts`, `src/serializers/multiResultSerializers.ts`
- New node interfaces: `TriggerNode`, `IndexNode`, `StatisticNode` in `src/objectExplorer/types.ts`
- New command: `sqlServer.showTableDiagram` with activation event
- Updated: `src/schemaDiagramPanel.ts`, `src/contextMenuHandler.ts`, `src/exportManager.ts`, `server/src/linter.ts`

### v0.8.0

- **Cross-Database Name Completion in FROM/JOIN** — Database name suggestions when typing in FROM/JOIN contexts:
  - Queries `MultiDatabaseCache.getCachedDatabaseNames()` for matching databases when the typed prefix (≥1 char) doesn't exactly match local objects
  - Inserts bracket-quoted name with trailing dot (e.g., `[Ultimus].`) with proper `]` escaping (`]]`)
  - Ranked at tier 3 with `CompletionItemKind.Module` and detail "Database"; only in FROM/JOIN contexts
  - Excludes the primary database from suggestions
- **Parameter Sniffing / Variable Declarations** — Pre-execution variable detection and prompting:
  - `variableDetector.ts` scans for undeclared `@variable` references per GO-separated batch
  - Excludes `@@` system variables, EXEC named parameters, and references inside comments/strings/dynamic SQL
  - Recognizes all DECLARE forms (single, multi-variable, TABLE) and SET assignments
  - Type inference from column comparisons, IN subqueries, and arithmetic context; fallback to NVARCHAR(MAX)
  - `variablePrompt.ts` provides sequential VS Code input dialogs with inferred type as placeholder and numeric validation
  - `generateDeclareStatements()` produces proper DECLARE statements with NULL handling and type-appropriate quoting
  - Integrated as pre-execution hook in both Run Query and Run Current Statement commands
  - Capped at 20 undeclared variables; user cancel aborts execution
- **Execution Plan Visualizer** — Interactive graphical execution plan rendering:
  - New command `sqlServer.showExecutionPlan` (`Ctrl+Shift+M`) wraps query with `SET SHOWPLAN_XML ON/OFF`
  - `executionPlanParser.ts` — pure function parser (fast-xml-parser) maps SHOWPLAN_XML to typed tree structure; never throws
  - `executionPlanPanel.ts` — WebviewPanel rendering left-to-right operator trees with CSS flexbox
  - Operator nodes show: physicalOp, cost percentage, estimated rows; highlighted at >25% cost (3px border, distinct background)
  - Tooltip on hover: logical op, I/O/CPU costs, rows, output columns, predicates
  - Index Seek/Scan distinguished with color-coded labels; index name displayed
  - Multiple statements as separate labeled sections; missing index suggestions as CREATE INDEX DDL
  - Error handling: no connection → error message, empty text → warning, server error → Result Panel, malformed XML → graceful error display
- New source modules: `src/variableDetector.ts`, `src/variablePrompt.ts`, `src/executionPlanParser.ts`, `src/executionPlanPanel.ts`, `src/schemaDiagramPanel.ts`
- Added `fast-xml-parser` (^5.8.0) runtime dependency
- Enhanced `server/src/completionProvider.ts` (`getDatabaseNameCompletions()` + integration into `getCompletions()`)
- Enhanced `src/extension.ts` (variable detection hook, execution plan command registration, schema diagram command registration)
- New keybinding: Show Execution Plan (`Ctrl+Shift+M`, when `editorLangId == sql`)

### v0.7.0

- **Multi-Database IntelliSense** — Cross-database three-part name completions:
  - Automatically caches schemas from up to 32 databases on the connected server (background, non-blocking)
  - Typing `[OtherDB].[dbo].` provides table/view completions from the referenced database
  - Typing `[OtherDB].` provides schema name completions for that database
  - Three-part name table references in FROM/JOIN resolve column completions through aliases
  - 30-second timeout per database; inaccessible databases skipped with a logged warning
  - Manual schema refresh updates all secondary caches alongside the primary
  - Ambiguity resolution: two-part prefixes check the multi-database cache first
- **Query History** — Persistent query log with search and re-run:
  - Every executed query (success or error) saved automatically with SQL text, timestamp, duration, row count, connection name, database, and server host
  - Persisted as JSON to `.datasense/query-history.json` (max 500 records, oldest evicted)
  - Searchable tree view in the Object Explorer sidebar — case-insensitive substring match against SQL, connection, or database name
  - Click a record to preview full SQL in a read-only editor; click "Re-run" to execute against the original connection
  - Graceful handling of missing connections, corrupted history files, and write errors
- **Connection-Scoped Color Coding** — Visual connection identity:
  - Assign a color to any connection (predefined palette: red, orange, yellow, green, blue, purple, or custom `#RRGGBB` hex)
  - Active connection color displayed as status bar background and 2px top border on SQL editor tabs
  - Color picker in the connection form (Add/Edit/Duplicate) with hex validation
  - Color name or hex value included in status bar tooltip for accessibility
  - Indicators update within 100ms on connection switch and clear on disconnect
- **Export Results** — Multi-format export from the results panel:
  - **CSV** — RFC 4180 compliant with proper quoting, NULL as empty fields
  - **JSON** — Array of objects with 2-space indentation, SQL type mapping (numeric→number, bit→boolean, datetime→ISO 8601, binary→base64, NULL→null)
  - **Excel** — `.xlsx` via exceljs with typed cells (dates as serial numbers, numerics as numbers), worksheet "Results"
  - **INSERT Statements** — One INSERT per row with `[TableName]` placeholder, proper SQL literal formatting (N prefix for Unicode, escaped quotes, bit as 0/1)
  - **CREATE TABLE + INSERT** — Inferred DDL from result metadata + INSERT statements, unknown types default to NVARCHAR(MAX)
  - **Copy as Text** — Fixed-width formatted text table copied to clipboard, 50-char column cap with truncation
  - All serializers implemented as pure functions; save dialogs with timestamped default filenames
- New source modules: `server/src/multiDatabaseCache.ts`, `server/src/crossDatabaseParser.ts`, `src/queryHistoryStore.ts`, `src/queryHistoryProvider.ts`, `src/connectionColorIndicator.ts`, `src/exportManager.ts`, `src/serializers/csvSerializer.ts`, `src/serializers/jsonSerializer.ts`, `src/serializers/insertSerializer.ts`, `src/serializers/createInsertSerializer.ts`, `src/serializers/textTableSerializer.ts`
- Added `exceljs` runtime dependency for Excel export
- Enhanced `server/src/completionProvider.ts` (cross-database reference detection and completion routing)
- Enhanced `server/src/schemaCache.ts` (multi-database pool support)

### v0.6.0

- **Enhanced Statement Outline Decorator** — Upgraded from a left-border-only decoration to a full box border around the active statement using four decoration types (top, middle, bottom, single-line). Registered as a VS Code ThemeColor (`sqlServer.statementOutlineBorder`) with defaults for dark (`#5a5a5a80`), light (`#c8c8c880`), and high-contrast (`#ffffff`) themes. Users can customize via their theme or `workbench.colorCustomizations`.
- **T-SQL Snippet/Template Library** — Five pre-built T-SQL code templates served as IntelliSense completions with tab-stop navigation:
  - `merge` — MERGE statement with MATCHED/NOT MATCHED actions (5 tab stops)
  - `trycatch` — TRY/CATCH block with ERROR_NUMBER/MESSAGE/SEVERITY (2 tab stops)
  - `cursor` — Full cursor loop pattern with DECLARE/OPEN/FETCH/CLOSE/DEALLOCATE (3 tab stops)
  - `paginate` — OFFSET/FETCH pagination (3 tab stops)
  - `dynamicsql` — sp_executesql with parameter definitions (3 tab stops)
  - Context-aware ranking: INSERT/UPDATE elevates MERGE, standalone BEGIN elevates TRY/CATCH, DECLARE+cursor keywords elevates cursor loop, ORDER BY elevates pagination
  - Available regardless of database connection state
- **Dynamic SQL IntelliSense** — Schema-aware completions inside EXEC() and sp_executesql string arguments:
  - Detects cursor position inside string literals and extracts the SQL content
  - Unescapes paired single quotes (`''` → `'`) before parsing
  - Handles variable concatenation boundaries (`' + @var + '`) by splitting at boundaries
  - Provides column completions from schema cache when FROM/JOIN references a known table
  - Falls back to keyword-only completions when disconnected or SQL is unparseable
- **Query Status Indicator** — New status bar item (left side, priority -102) showing execution feedback:
  - Displays "Running..." with spinner during execution
  - Shows row count + duration on completion (e.g., "1,427 rows, 1.2s")
  - Shows "Cancelled, {duration}" on user cancellation; "Error, {duration}" on failure
  - Duration formatting: ms for <1s, seconds with 1 decimal for 1–60s, minutes+seconds for ≥60s
  - Row count formatting: comma separators for ≥1000, singular "row" for 1
  - Hidden until first query execution; hides when switching to non-SQL files
- New source modules: `server/src/snippetLibrary.ts`, `server/src/dynamicSqlParser.ts`, `src/queryStatusIndicator.ts`
- Refactored `src/statementOutlineDecorator.ts` (4 decoration types replacing 1)
- Enhanced `server/src/completionProvider.ts` (dynamic SQL detection + snippet integration)

### v0.5.1

- **Bug Fix: GO batch boundaries** — Statement outline and CodeLens now correctly recognize GO-separated batches on document open and editor switch (not just on edit)
- **Bug Fix: Statement outline border** — Replaced nearly-invisible background highlight with a visible 3px left border for the active statement
- **Bug Fix: FROM context ranking** — Tables and views now rank above successor keywords in FROM context (tables at Tier 1, keywords demoted to Tier 2)
- **Bug Fix: WHERE context ranking** — Columns now rank above successor keywords in WHERE context (keywords demoted to Tier 2)
- **Bug Fix: JOIN ON FK columns** — Added `JOIN_ON` context detection that suggests FK-related column pairs for ON conditions (e.g., `u.UserId = o.UserId`)
- **Bug Fix: Table Preview filter** — Removed aggressive 500ms debounce-on-input; filter now only executes on Enter key or explicit Apply button click
- **Bug Fix: Comment suppression** — IntelliSense no longer suggests completions inside single-line (`--`) or block (`/* */`) comments
- Added `isInsideComment()` helper for robust comment detection (handles string literals, N-prefixed strings, escaped quotes)
- 33 new property-based tests (17 exploration + 16 preservation) validating all fixes

### v0.5.0

- **Table Preview** — Double-click tables/views in Object Explorer to preview data in a dedicated tab with filter, sort, and edit-query capabilities
- **ODBC Driver Detection & Guided Setup** — Categorized connection error handling with actionable dialogs (download link, retry, re-enter credentials, extended timeout)
- **Run/Stop Button State Toggle** — Per-editor execution state machine (Idle/Executing/Canceling) with toolbar icon switching and context key blocking
- **Extension Settings Surface** — 8 new configurable settings with proper VS Code Settings UI grouping, runtime application without reload
- **Split/Combined Result Panes** — Toggle between stacked single-pane and tabbed split-pane display modes for multiple result sets, with "Batch N - Result M" labeling
- **Keyboard Shortcut List** — Discoverable QuickPick command listing all extension shortcuts grouped by category with execute-on-select
- **Statement Outline & Inline Run/Stop** — Per-statement background decoration, CodeLens run/stop actions, 300ms debounced parsing, 500-statement threshold, semicolon-aware splitting respecting strings/comments
- 10 new correctness properties validated via property-based testing (fast-check)
- 9 new source modules, 120+ new tests

### v0.4.4

- **Smart Aggregation Helper & Auto GROUP BY Injection:**
  - Aggregation Context Detector (`aggregationContextDetector.ts`) — backward-scanning algorithm detects when the cursor is inside an aggregate function's parentheses, handles nested parentheses (e.g., `SUM(CASE WHEN ... END)`), graceful degradation on parse errors
  - Type-aware aggregate column completions — numeric columns ranked higher for SUM/AVG/STDEV/VAR; COUNT/COUNT_BIG include `*` option; MIN/MAX suggest all columns regardless of type
  - Aggregate function snippet completions — inserts `FUNCNAME($1)` with cursor inside parentheses and triggers re-completion for column suggestions
  - GROUP BY Analyzer (`groupByAnalyzer.ts`) — parses SELECT list to classify aggregated vs non-aggregated columns, handles aliased expressions, multi-column expressions, and alias qualification
  - Auto GROUP BY completion — suggests `GROUP BY col1, col2, ...` with correct non-aggregated columns when aggregates are present, suppressed when GROUP BY already exists
  - GROUP BY Code Action (`groupByCodeAction.ts`) — quick-fix lightbulb to insert GROUP BY clause after FROM/WHERE with proper indentation, or add missing columns to an existing GROUP BY
  - HAVING clause awareness — prioritizes aggregate functions in HAVING context, suggests GROUP BY columns outside aggregates
  - Multi-table aggregation support — columns from all joined tables in aggregate completions, ambiguous names require qualification, alias resolution for type-aware filtering
- IntelliSense Clause Engine — complete overhaul of the completion system:
  - Clause State Engine (`clauseStateEngine.ts`) — formal state transition table modeling canonical T-SQL clause ordering with scope-aware presence detection (subqueries, CTE bodies, comments, string literals)
  - CTE Resolver (`cteResolver.ts`) — dedicated module for chained CTE resolution with column propagation, forward reference handling, bracketed identifiers, column list syntax, and 10+ CTE chains without truncation
  - 4-tier ranking system replacing the old 6-tier model: required keywords (tier 0) > columns/aliases/functions (tier 1) > CTE names (tier 2) > schema objects (tier 3)
  - Context-based noise reduction: FROM/JOIN shows tables/views/CTEs only; SELECT/WHERE shows columns/functions only; immediately after JOIN suppresses keywords until a table is typed
  - Deterministic keyword injection: FROM after SELECT column list, ON after JOIN table reference, successor clauses after FROM
  - CROSS JOIN correctly never suggests ON
  - Keyword prefix override: typing ≥1 character of a keyword includes it regardless of context filtering
  - CTE alias-dot completion with proper resolution priority (table alias > CTE alias > direct CTE name)
  - 220+ new tests (unit + property-based) covering all correctness properties

### v0.4.3

- Real-time T-SQL syntax error linting — syntax errors highlighted as you type with 500ms debounce, batch-independent parsing, and configurable enable/disable
- T-SQL code formatting — Format Document and Format Selection with uppercase keyword casing, clause-per-line layout, nesting indentation, and configurable tab/space/EOL settings
- Alias-aware column completions in WHERE clauses — type `alias.` to get column suggestions for the aliased table, with CTE support and scope isolation
- Go to Definition for stored procedures, views, and functions — F12 in the editor or right-click in Object Explorer to view object source in a read-only tab

### v0.4.2

- Statement-level scoping for IntelliSense — table references and column suggestions are now scoped to the individual SQL statement containing the cursor, not the entire batch
- Multi-statement batches no longer bleed table references between statements separated by semicolons or top-level DML/DDL keywords
- CTE blocks (WITH...AS) and their consuming DML are treated as a single scope
- SELECT * expansion respects statement boundaries
- Added MIT license and repository metadata to package.json

### v0.4.1

- Dependency consolidation and security audit
- Upgraded mssql from v10 to v12 (tedious v16→v19, resolving azure-identity/msal-node/uuid vulnerabilities)
- Upgraded vitest from v1 to v3 (vite v5→v7, esbuild vulnerability resolved)
- Eliminated duplicate tedious versions in the dependency tree
- Zero npm audit vulnerabilities across the entire dependency tree
- Fixed .vscodeignore (was .vsixignore) to properly exclude source files from VSIX
- No API breaking changes — all 901 tests pass without modification

### v0.4.0

- Clause-flow awareness — tracks which SQL clauses are already present and suggests only grammatically valid next clauses based on canonical T-SQL ordering
- Multi-CTE support — detects chained CTE definitions within a single WITH block and offers earlier CTE names as table completions in later CTEs and the final query
- Subquery scope isolation — independent clause-flow tracking for subqueries and CTE bodies

### v0.3.0

- Smart Join Generator (FK-based JOIN completions with auto-generated ON clauses)
- SELECT \* expansion into explicit column lists
- Schema hover tooltips for tables, columns, and views

### v0.2.1

- Bug fixes and stability improvements

### v0.2.0

- Object Explorer panel with hierarchical server browsing
- Context menu actions (SELECT TOP 100, Copy Name)

### v0.1.1

- Connection management improvements

### v0.1.0

- Initial release
- T-SQL syntax highlighting
- Basic IntelliSense (keywords + schema completions)
- Query execution with results panel
- SQL Auth and Windows Auth support
