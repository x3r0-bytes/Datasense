# Datasense

A VS Code extension providing a complete SQL editing experience for Microsoft SQL Server. Features T-SQL syntax highlighting, schema-aware IntelliSense via LSP, query execution with result display, Object Explorer, and connection management.

**Current Version:** 0.9.9

## Features

- **T-SQL Syntax Highlighting** — TextMate grammar with support for SQL Server-specific keywords, CTEs, temp tables, bracket-delimited identifiers, and GO batch separators
- **Real-Time Syntax Error Linting** — Detects common T-SQL syntax errors as you type with red squiggles and descriptive messages (missing column lists, incomplete FROM clauses, unclosed BEGIN blocks, and more). Configurable via `sqlServer.linting.enabled` setting.
- **T-SQL Code Formatting** — Format documents and selections with uppercase keyword casing, clause-per-line layout, proper indentation for nested blocks, and configurable tab/space settings. Preserves string literals and comments byte-for-byte. Triggered via VS Code's Format Document (`Shift+Alt+F`) or Format Selection.
- **Schema-Aware IntelliSense** — Context-aware completions powered by a Language Server that introspects your database schema:
  - Tables, views, columns, and stored procedures
  - Context detection for `SELECT`, `FROM`, `JOIN`, `WHERE`, `EXEC`, CTE, and more
  - Alias-aware column completions — type `alias.` in WHERE clauses to get columns for the aliased table
  - Smart Join Generator — suggests JOINs based on foreign key relationships with auto-generated `ON` clauses
  - `SELECT *` expansion into explicit column lists
  - Schema hover tooltips for tables, columns, and views
  - Clause State Engine — formal state transition model that tracks clause presence and suggests only grammatically valid next clauses
  - 4-tier ranking system — required keywords > columns/aliases > CTE names > schema objects
  - Context-based noise reduction — FROM/JOIN contexts show only tables/views/CTEs; SELECT/WHERE contexts show only columns/functions
  - Deterministic keyword injection — FROM after SELECT, ON after JOIN, successor clauses after FROM
  - Multi-CTE resolution with chained dependency propagation (10+ CTEs supported)
  - CTE alias-dot completion — type `cte_alias.` to get CTE column suggestions
  - Smart Aggregation Helper — type-aware aggregate completions with snippet insertion, numeric column ranking for arithmetic aggregates, `*` for COUNT
  - Auto GROUP BY Injection — detects non-aggregated columns and offers pre-populated GROUP BY completion or quick-fix code action
  - HAVING clause awareness — prioritizes aggregate functions and GROUP BY columns in HAVING context
- **Go to Definition** — Right-click stored procedures, views, or functions in Object Explorer and select "Go to Definition" to view their source in a read-only editor tab. Also available via `textDocument/definition` in the editor (Ctrl+Click or F12) for schema-qualified names.
- **Query Execution** — Execute queries directly from the editor with results displayed in a bottom panel tab, including batch splitting on `GO` separators and CodeLens run buttons
- **Connection Management** — Configure and switch between multiple SQL Server connections with SQL Authentication or Windows Authentication
- **Object Explorer** — Sidebar tree view for browsing servers, databases, tables, views, columns, constraints, triggers, indexes, and statistics with context menu actions
- **Connection Groups** — Organize connections into named, color-coded folders (e.g., Prod, Dev, Staging). Groups appear as top-level collapsible nodes in the Object Explorer with a colored square icon. Right-click a connection to assign it to a group; right-click a group to remove it. Colors and group assignments persist across sessions in `.sql-connections.json`.
- **Table Preview** — Double-click a table or view in Object Explorer to open a data preview tab showing the first 100 rows (configurable). Filter with WHERE clauses (Enter key or Apply button), sort by clicking column headers, and open the generated SQL in a full editor.
- **Run/Stop Button Toggle** — The editor toolbar play button becomes a stop button during query execution, with per-editor state tracking and cancel support
- **Statement Outline & Inline Actions** — Full box border decoration around the active statement using a theme-aware color (`sqlServer.statementOutlineBorder`), plus per-statement CodeLens run/stop buttons. Respects GO batch separators and semicolons (string/comment-aware). Customizable via theme or `workbench.colorCustomizations`.
- **T-SQL Snippet Library** — Pre-built templates for common patterns (MERGE, TRY/CATCH, cursor loop, pagination, dynamic SQL) with tab-stop navigation. Context-aware ranking elevates relevant snippets based on what you're typing (e.g., MERGE after INSERT/UPDATE, TRY/CATCH after BEGIN). Available in both connected and disconnected modes.
- **Dynamic SQL IntelliSense** — Schema-aware completions inside string literals passed to `EXEC()` and `sp_executesql`. Handles escaped quotes, variable concatenation boundaries (`' + @var + '`), and provides column/table completions based on the extracted SQL context.
- **Query Status Indicator** — Status bar item showing row count and execution duration after query completion (e.g., "1,427 rows, 1.2s"). Displays a spinner during execution, handles cancellation, and formats large numbers with comma separators and human-readable durations.
- **Cross-Database Name Completion in FROM/JOIN** — When typing an identifier in a FROM or JOIN context that doesn't match local tables/views, suggests database names from the multi-database cache as completions. Selecting a database inserts the bracket-quoted name followed by a dot (e.g., `[OtherDB].`) to start a three-part name. Ranked below local objects (tier 3) so tables/views always appear first.
- **Parameter Sniffing / Variable Declarations** — Detects undeclared `@variable` references before query execution and prompts for values with type inference. Generates proper DECLARE statements and prepends them to the query — eliminates the "must declare scalar variable" error loop. Handles comments, string literals, system variables, EXEC parameters, and GO batch boundaries. Type inference from column comparisons in the schema cache.
- **Execution Plan Visualizer** — Request an estimated execution plan (`Ctrl+Shift+M`) and view it as an interactive left-to-right tree in a dedicated webview panel. Each operator shows cost percentage, row estimates, and physical operation name. Expensive operators (>25% cost) are highlighted. Hover for full details including predicates, I/O/CPU costs, and output columns. Missing index suggestions displayed as CREATE INDEX statements below the plan.
- **Schema Diagram** — Visualize foreign key relationships in an interactive webview graph that opens in the active editor tab. Two separate context menu commands: "Schema Diagram" on a database node renders all user tables and their FK relationships; "Table Diagram" on a table node renders only that table and its direct FK neighbors. Force-directed auto-layout positions related tables near each other. Drag table cards to rearrange; pan the canvas by dragging the background; zoom with scroll wheel (cursor-centered, 0.3–3.0). Click any table card to expand/collapse its column list (shows PK/FK indicators and data types). Column-level connector anchoring — when a card is expanded, FK relationship lines anchor to the specific FK/PK column row instead of the card center; collapsed cards fall back to card-center. Smooth 200ms animated endpoint transitions on expand/collapse with interruption handling. Connector dots (3px circles) appear at column-level endpoints for visual clarity. Click relationship lines to highlight connected tables and view FK details; hover lines for quick tooltip inspection. Export as PNG (2x DPI) or SVG. Minimap overview for large diagrams (>15 tables) with click-to-navigate.
- **SQL Object Search** — Redgate SQL Search-style sidebar panel for full-text definition search across all configured connections. Search stored procedure definitions, view definitions, function bodies, table column names, and trigger definitions with a LIKE-based substring match. Filter by object type (procedures, views, functions, tables, triggers). Scope to specific connections, databases, or schemas. Results grouped hierarchically by connection → database → object type with match context snippets, line numbers, and highlighted match portions. Click any result to open the full object definition in a read-only editor tab. Parallel execution with concurrency limit (4 databases), 30-second per-database timeout, result caching (50 entries, LRU eviction), cancel support with partial results, and workspace state persistence for filters and scope across sessions.
- **Destructive Query Warning** — Pre-execution safety gate that intercepts dangerous SQL statements before they reach the database. Detects UPDATE without WHERE, DELETE without WHERE, TRUNCATE TABLE, DROP TABLE, and DROP DATABASE. Shows a modal confirmation dialog with the offending statement and line number. Handles aliased patterns, subquery WHERE exclusion, multi-table JOINs, DELETE TOP(n), and keywords inside comments/strings. Applies to all execution modes (full file, selection, current statement) with no configuration required.
- **GO Batch Navigator** — CodeLens annotations and breadcrumb symbols for navigating GO-separated batches in large SQL migration scripts. Each non-empty batch shows a "Batch N of M" label on the first non-blank line. Click to open a quick pick menu for jumping between batches. Batches appear in the Outline panel and breadcrumb bar as Namespace symbols with a preview of the first meaningful line. Respects GO inside string literals and block comments. Toggle via `sqlServer.editor.showBatchNavigator` setting.
- **Find References in Workspace** — Right-click a table, view, or column in Object Explorer and select "Find References in Workspace" to search all `.sql` files for occurrences. Matches unqualified, schema-qualified, and bracket-quoted identifier forms. Excludes matches inside comments and string literals. Column searches filter results to files also containing the parent table/view. Results displayed in VS Code's standard References panel.
- **Rename in Workspace** — After finding references, trigger "Rename in Workspace" to perform a text-based rename across all matched `.sql` files. Preserves schema qualifiers and bracket quoting (`dbo.OldName` → `dbo.NewName`, `[OldName]` → `[NewName]`). Shows a refactoring preview diff for review before applying. Validates names (1–128 chars, no whitespace or special characters).
- **Schema Diff / Compare** — Compare the structure of two databases and generate migration scripts:
  - Two-step quick pick flow to select source and target connection+database
  - Captures full schema snapshots (tables, columns, indexes, constraints) via INFORMATION_SCHEMA and sys catalog views
  - Case-insensitive comparison categorizes differences: tables only in source, tables only in target, modified tables (column/index/constraint diffs)
  - Interactive webview panel with expandable sections showing source vs target definitions side by side
  - "Generate ALTER Script" button produces T-SQL DDL (CREATE TABLE, ALTER TABLE ADD/ALTER COLUMN, CREATE INDEX)
  - Optional "Include DROP statements" for destructive changes
  - Statement ordering (DROPs → CREATEs → ALTERs → CREATE INDEXes) with GO separators
  - Data loss warnings for potentially destructive column modifications (shortened VARCHAR, reduced precision)
  - Context menu shortcut: right-click a database node → "Compare Schema With..." pre-selects source
- **Multi-Result Export** — When a query returns multiple result sets, export commands now show a quick pick listing each result set by label plus "All Results". Selecting a specific set exports just that set; "All Results" combines them using per-format strategies: blank line + header row for CSV, `[{label, rows}]` array for JSON, one worksheet per set for Excel, blank line + `GO` separator for INSERT/CREATE+INSERT, and a heading line per set for clipboard text.
- **Schema-Aware Object Reference Linting** — The language server validates table, view, and column names against the schema cache as you type (Warning severity). Resolves unqualified names against `dbo` first, handles two-part (`schema.object`) and three-part (`db.schema.object`) names, aliases, CTEs, temp tables (`#name`), and derived table aliases. Silently skips when disconnected, cache is empty, or refreshing.
- **Enhanced Syntax Error Detection** — Four new linting rules: invalid keyword sequences (e.g., `SELECT FROM` with no column list, `WHERE ORDER BY`) produce Error diagnostics; unrecognized data type names in `CAST`/`CONVERT` produce Error diagnostics; unrecognized function names produce Warning diagnostics; invalid INSERT column names (validated against the schema cache) produce Warning diagnostics. Syntax-only rules fire even when disconnected.
- **Multi-Database IntelliSense** — Cross-database completions for three-part names (e.g., `[OtherDB].[dbo].[Table]`). Caches schemas from up to 32 databases on the same server in the background. Handles bracket-quoted identifiers, ambiguity resolution, and graceful timeout/permission handling.
- **Query History** — Automatic recording of all executed queries with metadata (SQL, duration, row count, connection, timestamp). Searchable "Query History" tree view in the Object Explorer sidebar with relative timestamps, re-run capability, and persistent storage (`.datasense/query-history.json`). Retains up to 500 records.
- **Connection Color Coding** — Assign a color to each connection (6 predefined palette colors or custom hex) for visual environment identification. Displays a 2px colored top-border on all open SQL editors and includes the color name in the status bar tooltip for accessibility.
- **Export Results** — Six export formats from the Results Panel toolbar: CSV (RFC 4180), JSON (typed values), Excel (.xlsx with proper date/number formatting), INSERT statements, CREATE TABLE + INSERT, and Copy as Formatted Text (clipboard). Respects active filters and sort order.
- **Split/Combined Result Panes** — View multiple result sets stacked in one pane or in separate tabs, with a toolbar toggle and "Batch N - Result M" labeling
- **ODBC Driver Detection** — Automatically detects missing ODBC driver and guides through installation with categorized error dialogs
- **Extension Settings** — 8 configurable settings via VS Code's standard Settings UI (row limits, display mode, timeouts, inline buttons, statement outline, auto-open, preview mode, formatting)
- **Keyboard Shortcuts** — Discoverable shortcut list via `Ctrl+Shift+/` with grouped categories and execute-on-select

## Installation

1. Download the `.vsix` file from the latest release
2. Open VS Code
3. Open the Command Palette (`Ctrl+Shift+P`)
4. Run **Extensions: Install from VSIX...**
5. Select the downloaded `.vsix` file
6. Reload VS Code when prompted

## Connection Configuration

Create a `.sql-connections.json` file at the root of your workspace:

```json
{
  "connections": [
    {
      "name": "Local Dev",
      "host": "localhost",
      "port": 1433,
      "database": "MyDatabase",
      "user": "sa",
      "password": "YourPassword",
      "encrypt": false,
      "trustServerCertificate": true,
      "group": "Dev"
    },
    {
      "name": "Production (Windows Auth)",
      "host": "prod-server.corp.local",
      "database": "ProdDB",
      "group": "Prod"
    }
  ],
  "groups": [
    { "name": "Prod", "color": "#E53935" },
    { "name": "Dev", "color": "#43A047" }
  ]
}
```

### Connection Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | — | Display name for the connection |
| `host` | Yes | — | SQL Server hostname or IP address |
| `port` | No | 1433 | SQL Server port number |
| `database` | No | master | Target database name |
| `user` | No | — | SQL Server login username (omit for Windows Auth) |
| `password` | No | — | SQL Server login password (prompted at runtime if omitted) |
| `encrypt` | No | — | Whether to encrypt the connection |
| `trustServerCertificate` | No | — | Whether to trust the server certificate |
| `color` | No | — | Connection color for visual identification (`#RRGGBB` hex format) |
| `group` | No | — | Connection group name (must match a defined group) |

### Authentication Modes

- **SQL Server Authentication**: Provide the `user` field — password will be prompted at runtime if not specified
- **Windows Authentication**: Omit the `user` field to use a trusted connection via the msnodesqlv8 ODBC driver

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| SQL Server: Run Query | `Ctrl+Shift+E` | Execute selected text or full editor content |
| SQL Server: Cancel Query | `Ctrl+Shift+Q` | Cancel the currently executing query |
| SQL Server: Switch Connection | — | Select from configured connections |
| SQL Server: Switch Server | — | Switch to a different server |
| SQL Server: Switch Database | — | Switch to a different database on the current server |
| SQL Server: Refresh Schema | — | Refresh the IntelliSense schema cache |
| SQL Server: Add Connection | — | Add a new server connection |
| SQL Server: Add Connection Group | — | Create a named, color-coded connection group |
| SQL Server: Disconnect | — | Disconnect from the current server |
| SQL Server: SELECT TOP 100 | — | Run SELECT TOP 100 on a table/view (context menu) |
| SQL Server: Copy Object Name | — | Copy an object's name to clipboard (context menu) |
| SQL Server: New Query | — | Open a new SQL file connected to the selected context |
| SQL Server: Run Current Statement | `Ctrl+Enter` | Execute only the statement at the cursor position |
| SQL Server: Show Execution Plan | `Ctrl+Shift+M` | Show estimated execution plan for selected text or full editor |
| SQL Server: Schema Diagram | — | Show full database ERD for a database node (Object Explorer context menu) |
| SQL Server: Table Diagram | — | Show FK relationship diagram for a table node (Object Explorer context menu) |
| Find References in Workspace | — | Search all .sql files for references to a table/view/column (Object Explorer context menu) |
| Rename in Workspace | — | Rename a table/view/column across all workspace .sql files (Object Explorer context menu) |
| SQL Server: Schema Diff — Compare Databases | — | Compare two database schemas and show differences |
| Compare Schema With... | — | Compare schemas using clicked database as source (Object Explorer context menu) |
| SQL Server: Generate ALTER Script | — | Generate T-SQL ALTER/CREATE/DROP script from schema diff |
| SQL Server: Show Keyboard Shortcuts | `Ctrl+Shift+/` | Show all extension keyboard shortcuts |
| SQL Server: Toggle Result Display Mode | — | Switch between single and split result pane modes |
| Go to Definition | — | View source of a procedure/view/function (Object Explorer context menu) |
| SQL Server: Export CSV | — | Export results to CSV file |
| SQL Server: Export JSON | — | Export results to JSON file |
| SQL Server: Export Excel | — | Export results to Excel (.xlsx) file |
| SQL Server: Export INSERT | — | Export results as SQL INSERT statements |
| SQL Server: Export CREATE + INSERT | — | Export results as CREATE TABLE + INSERT statements |
| SQL Server: Copy as Text | — | Copy results as formatted text to clipboard |
| Re-run Query | — | Re-run a query from history (Query History context menu) |
| Clear History | — | Clear all query history records |
| Search History | — | Filter query history by search text |

## Keyboard Shortcuts

| Command | Default Binding | When Clause |
|---------|----------------|-------------|
| Run Query | `Ctrl+Shift+E` | `editorLangId == sql` |
| Cancel Query | `Ctrl+Shift+Q` | `editorLangId == sql` |
| Run Current Statement | `Ctrl+Enter` | `editorLangId == sql` |
| Show Execution Plan | `Ctrl+Shift+M` | `editorLangId == sql` |
| Show Keyboard Shortcuts | `Ctrl+Shift+/` | (always) |

Use `Ctrl+Shift+/` to open a QuickPick listing all extension shortcuts grouped by category. Selecting an entry executes the command immediately.

## Requirements

- VS Code 1.75.0 or later
- **For Windows Authentication:** The [Microsoft ODBC Driver for SQL Server](https://learn.microsoft.com/en-us/sql/connect/odbc/download-odbc-driver-for-sql-server) must be installed on the machine (Driver 17 or 18). This is a one-time system-level install — the same driver used by SSMS and other SQL tools.

> **Common error:** If you see `[Microsoft][ODBC Driver Manager] Data source name not found and no default driver specified`, it means the ODBC driver is not installed. Download and install it from the link above, then restart VS Code.

## Technical Details

- Uses **mssql v12** (Tedious v19 driver) for SQL Server connectivity
- Language Server runs as a separate process for performance isolation
- Three independent connection pools: query execution, Object Explorer, and IntelliSense
- Passwords are never persisted to disk

## Building from Source

### Prerequisites

- **Node.js** 18+ (LTS recommended)
- **npm** (comes with Node.js)
- **VS Code** 1.75.0 or later (for running/debugging the extension)
- **Windows** with the [Microsoft ODBC Driver for SQL Server](https://learn.microsoft.com/en-us/sql/connect/odbc/download-odbc-driver-for-sql-server) (Driver 17 or 18) — required only at runtime for Windows Authentication

### Setup

```bash
# Clone the repository
git clone https://github.com/your-username/datasense.git
cd datasense

# Install dependencies
npm install
```

### Compile

The project has two TypeScript compilation targets (client and language server):

```bash
npm run compile
```

This runs `tsc` against both `tsconfig.json` (client → `out/src/`) and `tsconfig.server.json` (server → `out/server/`).

### Run in Development

1. Open the repo folder in VS Code
2. Press **F5** to launch the Extension Development Host
3. The extension activates automatically for `.sql` files

For continuous compilation during development:

```bash
npm run watch
```

> Note: `watch` only covers the client. After changes to `server/src/`, re-run `npm run compile` and reload the Extension Development Host window (`Ctrl+Shift+P` → "Developer: Reload Window").

### Run Tests

```bash
# Run all unit + property-based tests (single pass, no watch)
npm test

# Run a specific test file
npx vitest run test/unit/connectionManager.test.ts
```

### Package as VSIX

```bash
npx vsce package
```

> **Important:** Do NOT use `--no-dependencies`. The extension requires runtime packages (`mssql`, `msnodesqlv8`, etc.) bundled in the VSIX. Expected size is ~15 MB.

The output `.vsix` file can be installed in any VS Code instance via **Extensions: Install from VSIX...** in the Command Palette.

### Project Layout

| Directory | Purpose |
|-----------|---------|
| `src/` | Client-side extension code (runs in the VS Code extension host) |
| `server/src/` | Language server code (runs as a separate Node.js process via LSP) |
| `test/unit/` | Unit tests (vitest) |
| `test/property/` | Property-based tests (fast-check) |
| `syntaxes/` | T-SQL TextMate grammar |
| `resources/` | Icons and static assets |
| `out/` | Compiled JavaScript output (gitignored) |

## Changelog

### 0.9.9

- **Destructive Query Warning** — Pre-execution safety gate that intercepts destructive SQL statements before they reach the database:
  - Detects UPDATE without WHERE, DELETE without WHERE, TRUNCATE TABLE, DROP TABLE, and DROP DATABASE statements
  - Handles aliased UPDATE/DELETE patterns (e.g., `UPDATE t SET col = val FROM Table t`), DELETE TOP(n), multi-table JOIN DELETE
  - Per-statement classification — each statement in a multi-statement batch analyzed independently
  - Ignores destructive keywords inside comments (`--`, `/* */` including nested) and string literals (no false positives)
  - Case-insensitive keyword detection across all patterns
  - Top-level WHERE detection — WHERE clauses inside subqueries (parenthesized) don't count as filtering the outer statement
  - Modal confirmation dialog with "Yes"/"No" options showing the offending statement snippet and line number
  - Statement text truncated to 200 chars with "..." suffix in the dialog; prefixed with "Line N:"
  - Two context-sensitive messages: "This statement affects all rows. Continue?" for UPDATE/DELETE without WHERE; "This is a destructive operation. Continue?" for TRUNCATE/DROP
  - Applies to all three execution modes: full file, selection, and current statement
  - Selection mode reports line numbers relative to the original document (not the selection)
  - Fail-safe design: if analysis or dialog throws unexpectedly, execution is blocked (never accidentally allows destructive queries)
  - Dialog dismissal (Escape) treated as cancellation
  - No configuration options — always active (refinements planned for v1.1+)
- New source modules: `src/destructiveStatementAnalyzer.ts`, `src/destructiveQueryGuard.ts`
- Enhanced: `src/extension.ts` (guard integration before query execution in both `runQuery` and `runCurrentStatement` commands)
- 109 unit tests + 27 property-based tests covering all 11 correctness properties

### 0.9.8

- **SQL Object Search** — Full Redgate SQL Search-style definition search panel in the Object Explorer sidebar:
  - WebviewViewProvider-based panel registered alongside Object Explorer and Query History in the activity bar container
  - Text input with Enter/button-triggered search (no auto-search on keystroke); minimum 2 non-whitespace characters, maximum 128 characters
  - Object type filter toggles (Stored Procedures, Views, Functions, Tables, Triggers) — all enabled by default; persisted in workspace state
  - Scope filtering: All Connections → single server → specific database → specific schema; scope persisted in workspace state
  - "Include system databases" toggle (default OFF) excluding master/model/msdb/tempdb from broad searches
  - LIKE pattern construction with proper SQL wildcard escaping (`[` → `[[]`, `%` → `[%]`, `_` → `[_]`)
  - Definition search via `sys.sql_modules` for procedures (P/PC), views (V), functions (FN/IF/TF/FS/FT), and triggers (TR)
  - Table column name search via `sys.columns` joined with `sys.tables` and `sys.schemas`
  - Parallel execution across databases with concurrency limit of 4 simultaneous queries
  - 30-second per-database timeout; graceful skip with warning for timed-out or unreachable databases
  - Results capped at 500 matches with truncation notice; cancel button returns partial results
  - Results grouped hierarchically: connection → database → object type; sorted alphabetically within groups
  - Match context snippets (max 100 chars each side) with highlighted matched portion using `--vscode-editor-findMatchHighlightBackground`
  - 1-based line number displayed alongside each match
  - Collapsible result groups (expanded by default) with chevron toggle
  - Result summary header: total count, databases searched, duration
  - Click-to-open-definition: queries full definition from database and opens in read-only editor tab via `openDefinitionEditor()`
  - Table click opens CREATE TABLE DDL (columns with types, nullable, identity)
  - Hover tooltip showing full path: `[Server] → [Database] → [Schema].[Object]`
  - Tab deduplication — activates existing tab instead of opening duplicate
  - Encrypted/missing object handling with informational messages; 5-second definition retrieval timeout
  - LRU cache (50 entries) keyed by search term + scope + filters; invalidated on connection changes
  - Filter change indicator shows "Filters changed since last search" when toggles are modified after results display (no auto re-execute)
  - Welcome message with "Add Connection" link when no connections configured
  - All styling uses VS Code CSS variables exclusively — no hardcoded colors
- New source modules: `src/sqlSearchService.ts`, `src/sqlSearchPanelProvider.ts`, `src/sqlSearchProtocol.ts`
- Enhanced: `src/extension.ts` (search panel registration, cache invalidation wiring)
- Enhanced: `package.json` (view registration, activation event)

### 0.9.7

- **Schema Diagram: Column-Level Connectors** — FK relationship lines now anchor to specific column rows when table cards are expanded:
  - When a table card is expanded, connector endpoints move to the vertical center of the FK/PK column row involved in the relationship (case-insensitive column matching)
  - Collapsed cards retain the existing card-center connection behavior
  - Smooth 200ms animated transitions on expand/collapse using linear interpolation via `requestAnimationFrame`; interruption-safe (rapid expand/collapse restarts animation from current interpolated position)
  - Horizontal edge selection — connector attaches to left or right edge based on relative card positions
  - DOM-based vertical positioning with formula fallback when elements are not yet rendered
  - Connector dots (3px filled circles) appear at column-level endpoints with theme-aware coloring (`--vscode-terminal-ansiBlue` default, `--vscode-focusBorder` when active); dots fade in/out synchronized with endpoint transitions
  - Missing column graceful fallback — if a referenced FK/PK column is not found in the card's column list, endpoint falls back to expanded card center
  - Drag integration — column-level anchoring maintained during card drag with per-frame recalculation
  - Export integration — PNG and SVG exports render column-level endpoints and connector dots accurately
  - Minimap unchanged — continues using simplified card-center straight lines at reduced scale
  - Hit areas regenerated in sync with endpoint changes; click-to-highlight and hover tooltips remain fully functional
- Enhanced: `src/schemaDiagramPanel.ts` (resolveConnectionPoint, ConnectorAnimator, getColumnRowInfo, columnRowCache, isColumnLevelEndpoint, animationRedraw, updated computeConnectorPath/drawConnectors/updateSingle/export renderer)

### 0.9.6

- **Interactive Schema Diagram: Polish** — Relationship line interaction, hover tooltips, export, and minimap:
  - Click a relationship line to highlight connected tables and show FK details (constraint name + column mapping) at the connector midpoint
  - Toggle behavior: click same line to deactivate; click different line to switch; click canvas background to clear
  - Hit area paths (invisible `stroke-width: 12`) for generous click targets on thin SVG lines
  - Dimmed state (opacity 0.25) on non-active cards and connectors
  - Hover tooltips — constraint name + column mapping at cursor + 12px offset; boundary detection flips to stay within canvas; suppressed for the active line
  - Export PNG — captures full diagram at 2x DPI on an offscreen canvas; save dialog with default filename `schema-diagram.png`
  - Export SVG — serializes diagram DOM with `foreignObject` for table card HTML; inlines CSS; save dialog with default `schema-diagram.svg`
  - Error handling: user cancel silently discards; file write error shows VS Code error notification
  - Minimap — 180×120 canvas overview for diagrams with >15 tables; scaled table rectangles + viewport indicator rectangle; click/drag to navigate; hidden for small diagrams
- Enhanced: `src/schemaDiagramPanel.ts` (InteractionController, HoverTooltipController, ExportRenderer, MinimapRenderer, registerMessageHandler)

### 0.9.5

- **Interactive Schema Diagram: Core Navigation** — Force-directed auto-layout, drag-to-reposition, canvas pan, and scroll wheel zoom:
  - Deterministic force-directed layout algorithm — pure function computing `{x, y}` positions for all tables based on FK relationships (300 iterations, repulsion/attraction/gravity/overlap resolution)
  - Connected tables cluster; isolated tables separated ≥80px; 24px minimum gap; positions clamped within bounds
  - Standalone `src/schemaDiagramLayout.ts` module (exportable for testing)
  - Drag-to-reposition — header-only drag with 5px threshold, rAF-throttled, cursor offset maintained, drop shadow
  - Canvas pan — drag background for unlimited panning; `grab`/`grabbing` cursor
  - Zoom — cursor-centered scroll wheel zoom (0.3–3.0 range, 0.1 step); percentage indicator; double-click to reset
  - Single CSS transform (`translate + scale`) on `#viewport` for GPU compositing
  - Bezier connector paths computed from PositionMap; hit area paths for click targeting; partial redraw during drag
  - Backward-compatible click — ≤5px toggles expand/collapse + highlights related; >5px = drag
  - New DOM structure: `#viewport` wrapper, SVG connector layer, absolute-positioned table cards
- New source module: `src/schemaDiagramLayout.ts`
- Enhanced: `src/schemaDiagramPanel.ts` (ViewportController, DragController, ConnectorRenderer, new DOM + CSS)

### 0.9.4

- **Connection Groups** — Organize connections into named, color-coded folders in the Object Explorer:
  - New "Add Connection Group" toolbar button to create a group with a name and color (8 predefined colors)
  - Groups appear as top-level collapsible nodes with a colored square icon
  - Right-click a server → "Assign to Group..." to move it into a group
  - Right-click a group → "Remove Connection Group" to delete (connections become ungrouped)
  - Groups and assignments persist in `.sql-connections.json` under a `"groups"` array
  - Connections inside a group inherit the group's color if they have no individual color set
- **Connection Color Persistence Fix** — Connection colors now correctly persist across VS Code restarts. The `color` field was previously written to the file but never read back during `loadConnections()`.
- **Object Explorer Search Fix** — Fixed a bug where using the search function would display the "No servers connected" welcome view (with the "Add Connection" link) when no results matched, making the UI appear broken. Now shows a "No results found" placeholder instead. Additionally, pressing Escape to dismiss the search input box now correctly clears the search filter.
- **Go to Definition Warning Suppression** — The "Go to Definition is not supported for X (unsupported object type)" notification no longer appears on every hover or implicit definition request. Unsupported types (tables, etc.) are now silently ignored with only a server-console log entry.
- New commands: `sqlServer.addConnectionGroup`, `sqlServer.removeConnectionGroup`, `sqlServer.assignToGroup`
- New type: `ConnectionGroupNode` in `src/objectExplorer/types.ts`
- Enhanced: `src/objectExplorer/objectExplorerConnectionManager.ts` (group CRUD, `persistToFile`, `getGroups`), `src/objectExplorer/objectExplorerProvider.ts` (group tree rendering, search fix), `server/src/server.ts` (definition handler)

### 0.9.1

- **GO Batch Navigator** — CodeLens and Document Symbol provider for GO-separated batches:
  - "Batch N of M" CodeLens annotations on the first non-blank line of each batch
  - Click CodeLens to open a quick pick menu for jumping between batches
  - Document Symbols (breadcrumb/outline) with batch name ("Batch N") and preview of first meaningful line
  - Filters empty batches (whitespace-only), respects GO inside strings/comments
  - Toggle via `sqlServer.editor.showBatchNavigator` setting (default: on)
  - Extends existing `batchSplitter.ts` with `splitBatchesWithLineInfo` for line-aware parsing
- **Find References in Workspace** — Search all `.sql` files for database object references:
  - Right-click table/view/column in Object Explorer → "Find References in Workspace"
  - Matches unqualified (`Name`), schema-qualified (`dbo.Name`), and bracket-quoted (`[Name]`, `[dbo].[Name]`) forms
  - Excludes matches inside comments (`--`, `/* */`) and string literals
  - Column searches filter to files also containing the parent table/view name
  - Results shown in VS Code's standard References panel (peek view)
- **Rename in Workspace** — Bulk rename across workspace SQL files:
  - Right-click table/view/column → "Rename in Workspace" (after references found)
  - Preserves schema qualifiers and bracket quoting during replacement
  - Refactoring preview diff for user review before applying
  - Name validation: 1–128 chars, no whitespace or `. [ ] ' "` characters
  - Summary notification showing replacement count and file count
- **Schema Diff / Compare** — Database structure comparison and migration script generation:
  - Two-step quick pick flow: select source connection+database, then target
  - Captures full schema snapshots (tables, columns, indexes, PK/FK/UNIQUE/CHECK/DEFAULT constraints)
  - Queries INFORMATION_SCHEMA + sys catalog views with 60-second timeout
  - Case-insensitive comparison categorizing: tables only in source, tables only in target, modified tables
  - Interactive webview Diff Panel with expandable sections, side-by-side source vs target, theme-aware styling
  - "Generate ALTER Script" button producing ordered T-SQL DDL with GO separators
  - Optional "Include DROP statements" checkbox for destructive changes
  - Data loss warnings (`-- WARNING: This alteration may cause data loss`) for shortened VARCHAR, reduced precision, incompatible types
  - Statement ordering: DROPs → CREATE TABLEs → ALTER TABLEs → CREATE INDEXes
  - Context menu shortcut: "Compare Schema With..." on database nodes (pre-selects source)
  - Error handling: connection failure, query timeout, same source/target, user dismissal
- New source files: `src/batchNavigatorProvider.ts`, `src/referenceFinder.ts`, `src/renameRefactorHandler.ts`, `src/schemaDiff/schemaDiffTypes.ts`, `src/schemaDiff/snapshotQueryService.ts`, `src/schemaDiff/schemaDiffEngine.ts`, `src/schemaDiff/schemaDiffCommands.ts`, `src/schemaDiff/diffPanel.ts`, `src/schemaDiff/alterScriptGenerator.ts`
- Extended `src/batchSplitter.ts` with `splitBatchesWithLineInfo` function (backward-compatible)
- New commands: `sqlServer.findReferencesInWorkspace`, `sqlServer.renameInWorkspace`, `sqlServer.schemaDiff`, `sqlServer.schemaDiffFromNode`, `sqlServer.generateAlterScript`
- New setting: `sqlServer.editor.showBatchNavigator` (boolean, default: true)
- New Object Explorer context menu entries: "Find References in Workspace" (table/view/column), "Compare Schema With..." (database)

### 0.9.0

- **Multi-Result Export** — Export commands now support multi-result queries:
  - When a query returns >1 result set, a quick pick prompt lists each by tab label plus "All Results"
  - Single result set bypasses the prompt and exports directly
  - "All Results" uses per-format concatenation: CSV (blank line + new header), JSON (`[{label, rows}]` array), Excel (one worksheet per set with 31-char name truncation and collision resolution), INSERT/CREATE+INSERT (blank line + `GO` separator), clipboard text (heading line per set)
  - Dismissing the quick pick cancels with no output
- **Schema Diagram Opens in Active Tab** — Schema diagrams now open in `ViewColumn.Active` (full editor tab) instead of splitting beside the current editor
- **Schema Diagram vs Table Diagram Context Menu Split** — Two separate commands:
  - "Schema Diagram" on database nodes → full ERD of all user tables and FK relationships
  - "Table Diagram" on table nodes → focused diagram showing only the selected table and its direct FK neighbors
  - Progress indicator for databases with >50 tables; "no FK relationships found" message for isolated tables
- **Object Explorer Infinite Loop Fix** — Triggers, indexes, and statistics are now rendered as leaf nodes (`collapsibleState: None`) with dedicated `TriggerNode`, `IndexNode`, and `StatisticNode` types. VS Code no longer attempts to expand them, eliminating the recursive `getChildren` loop that caused the tree view to freeze.
- **Schema-Aware Object Reference Linting (Phase 3)** — New linting pass validates table/view/column references against the schema cache:
  - FROM/JOIN table names validated (unqualified → dbo fallback → any schema; two-part against specified schema; three-part silently skipped for unknown databases)
  - Column references validated in SELECT/WHERE/ON/GROUP BY/ORDER BY against in-scope tables
  - Alias-qualified columns (`alias.column`) resolved to the underlying table
  - CTEs, temp tables (`#name`), and derived table aliases treated as valid and skipped
  - All diagnostics use Warning severity; skipped when disconnected/empty cache/refreshing
- **Enhanced Syntax Error Detection (Phase 4)** — New linting pass with four rule categories:
  - Invalid keyword sequences (e.g., `SELECT FROM`, `WHERE ORDER BY`) → Error severity, always runs
  - Invalid data types in CAST/CONVERT (33 recognized T-SQL types) → Error severity, always runs
  - Unrecognized function names (not in built-in list or schema cache) → Warning, schema-dependent
  - Invalid INSERT column names (validated against cached table) → Warning, schema-dependent
  - Syntax-only rules fire regardless of connection state (Requirement 6.5)
- New source modules: `server/src/objectReferenceLinter.ts`, `server/src/enhancedSyntaxLinter.ts`, `src/serializers/multiResultSerializers.ts`
- New node types: `TriggerNode`, `IndexNode`, `StatisticNode` in `src/objectExplorer/types.ts`
- New command: `sqlServer.showTableDiagram` with activation event and table-scoped context menu entry
- Updated `src/schemaDiagramPanel.ts` (ViewColumn.Active, dynamic titles, showDatabaseDiagram/showTableDiagram methods)
- Updated `src/contextMenuHandler.ts` (showSchemaDiagram/showTableDiagram handlers)
- Updated `src/exportManager.ts` (exportWithSelection, exportAllResults, ExportQuickPickItem interface)
- Updated `server/src/linter.ts` (Phase 3 + Phase 4 integration)

### 0.8.0

- **Cross-Database Name Completion in FROM/JOIN** — Database name suggestions in FROM/JOIN contexts:
  - When typing an identifier prefix (≥1 char) in a FROM or JOIN context, databases from the multi-database cache are offered as completions
  - Selections insert the bracket-quoted database name followed by a dot (e.g., `[Ultimus].`) to start a three-part name flow
  - Properly escapes closing brackets (`]` → `]]`) in database names containing special characters
  - Ranked at tier 3 (below local tables/views at tier 1) with `CompletionItemKind.Module` and detail "Database"
  - Only offered in FROM/JOIN contexts — never in SELECT, WHERE, GROUP BY, HAVING, ORDER BY, or other contexts
  - Excludes the primary (currently connected) database from suggestions
- **Parameter Sniffing / Variable Declarations** — Pre-execution variable detection and prompting:
  - Scans query text for undeclared `@variable` references before execution
  - Correctly excludes `@@` system variables, EXEC named parameters, and references inside comments/strings
  - Recognizes DECLARE (single, multi-variable, TABLE), SET assignments, and bracket-quoted variable names
  - Each GO-separated batch analyzed independently (variables don't leak across batches)
  - Type inference from column comparisons (`@var = Column`), IN subqueries, and arithmetic context
  - VS Code input dialog prompts for each undeclared variable with inferred type as placeholder
  - Numeric validation for INT/BIGINT/DECIMAL/FLOAT types; empty values treated as NULL
  - Generated DECLARE statements prepended to query text in first-occurrence order
  - User can cancel the prompt to abort execution entirely
  - Capped at 20 undeclared variables per prompt
- **Execution Plan Visualizer** — Interactive graphical execution plan display:
  - New command "SQL Server: Show Execution Plan" (`Ctrl+Shift+M`) requests estimated plans via `SET SHOWPLAN_XML ON`
  - Parses SHOWPLAN_XML into a structured operator tree using `fast-xml-parser`
  - Renders as an interactive left-to-right tree in a dedicated WebviewPanel
  - Each operator node shows: physical operation name, cost percentage, and estimated row count
  - Expensive operators (>25% of statement cost) highlighted with thick border and distinct background
  - Hover tooltip shows: logical/physical op, I/O cost, CPU cost, estimated rows, output columns, and predicates
  - Index Seek vs Index Scan distinguished with color-coded labels; index name displayed
  - Multiple statements rendered as separate labeled sections (1-based index + first 80 chars)
  - Missing index suggestions displayed as formatted CREATE INDEX DDL below the plan tree
  - Handles empty/malformed XML gracefully with informational error messages
  - Parser never throws — always returns a typed success/error discriminated union
- New source modules: `src/variableDetector.ts`, `src/variablePrompt.ts`, `src/executionPlanParser.ts`, `src/executionPlanPanel.ts`, `src/schemaDiagramPanel.ts`
- Added `fast-xml-parser` runtime dependency for execution plan XML parsing
- Enhanced `server/src/completionProvider.ts` (database name completion in FROM/JOIN)
- Enhanced `src/extension.ts` (variable detection pre-execution hook, execution plan command)
- New command: Schema Diagram (`sqlServer.showSchemaDiagram`) — available via Object Explorer context menu on table/database nodes
- New keybinding: Show Execution Plan (`Ctrl+Shift+M`)

### 0.7.0

- **Multi-Database IntelliSense** — Cross-database completions for three-part qualified names (`[Database].[Schema].[Object]`):
  - Background caching of up to 32 accessible databases per server (online, with access)
  - Schema completions after `DatabaseName.`, object completions after `DatabaseName.Schema.`, column completions via alias resolution from three-part FROM/JOIN references
  - 30-second per-database timeout with skip-and-continue on errors or permission issues
  - Ambiguity resolution: two-part prefixes check the multi-database cache first
  - Manual schema refresh (`Refresh Schema` command) refreshes all cached databases
- **Query History** — Persistent query log with searchable tree view:
  - All executed queries (success and error) are automatically recorded with SQL text, timestamp, duration, row count, connection name, database, and server
  - "Query History" panel in the Object Explorer sidebar with relative timestamps and success/error icons
  - Case-insensitive search across SQL text, connection name, and database name
  - Re-run: opens the stored SQL in a new editor (verifies the original connection still exists)
  - Persists to `.datasense/query-history.json` (500 record cap, oldest evicted)
  - Resilient to corrupted files and write errors (logs warnings, never interrupts execution)
- **Connection Color Coding** — Visual connection identity indicators:
  - Assign a color (6 predefined palette colors or custom `#RRGGBB` hex) to any connection via the connection form
  - 2px colored top-border decoration on all visible SQL editors when a colored connection is active
  - Status bar background tinting (red → error background, others → warning background)
  - Color name/hex included in the status bar tooltip for screen reader accessibility
  - Instantly clears on disconnect or switch to uncolored connection
- **Export Results** — Six export formats from the Results Panel toolbar:
  - **CSV** — RFC 4180 compliant with proper quoting for commas, quotes, and newlines; NULL → empty field
  - **JSON** — Array of objects with typed values (numbers, booleans, ISO dates, base64 binary, null), 2-space indentation
  - **Excel** — `.xlsx` via exceljs with "Results" worksheet, proper date serial numbers, numeric types, empty cells for NULL
  - **INSERT** — One statement per row with `[TableName]` placeholder, SQL Server literal syntax, N-prefix for Unicode strings
  - **CREATE TABLE + INSERT** — Inferred DDL types from result metadata (all NULLable) followed by INSERT statements
  - **Copy as Text** — Fixed-width formatted text table copied to clipboard with column width caps (50 chars) and truncation
  - All exports respect active column filters and sort order
  - Save dialog with timestamped default filenames; zero-row INSERT shows info message

### 0.6.0

- **Enhanced Statement Outline Decorator** — Upgraded from a left-border-only decoration to a full box border around the active statement using four decoration types (top, middle, bottom, single-line). Uses a registered VS Code ThemeColor (`sqlServer.statementOutlineBorder`) with sensible defaults for dark, light, and high-contrast themes. Users can customize the color via their theme or `workbench.colorCustomizations`.
- **T-SQL Snippet/Template Library** — Five pre-built T-SQL code templates served as IntelliSense completions:
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
  - Handles variable concatenation boundaries (`' + @var + '`) by splitting at boundaries and providing completions for the segment containing the cursor
  - Provides column completions from schema cache when FROM/JOIN references a known table
  - Falls back to keyword-only completions when disconnected or SQL is unparseable
- **Query Status Indicator** — New status bar item (left side, priority -102) showing execution feedback:
  - Displays "Running..." with spinner during execution
  - Shows row count + duration on completion (e.g., "1,427 rows, 1.2s")
  - Shows "Cancelled, {duration}" on user cancellation
  - Shows "Error, {duration}" on failure
  - Duration formatting: ms for <1s, seconds with 1 decimal for 1–60s, minutes+seconds for ≥60s
  - Row count formatting: comma separators for ≥1000, singular "row" for 1
  - Hidden until first query execution; hides when switching to non-SQL files

### 0.5.1

- **Bug Fix: GO batch boundaries** — Statement outline and CodeLens now correctly recognize GO-separated batches on document open and editor switch
- **Bug Fix: Statement outline border** — Replaced invisible background highlight with a visible 3px left border
- **Bug Fix: FROM context ranking** — Tables/views now rank above keywords in FROM context
- **Bug Fix: WHERE context ranking** — Columns now rank above keywords in WHERE context
- **Bug Fix: JOIN ON FK columns** — New `JOIN_ON` context suggests FK-related column pairs for ON conditions
- **Bug Fix: Table Preview filter** — Removed debounce-on-input; filter executes only on Enter or Apply button
- **Bug Fix: Comment suppression** — No completions inside `--` or `/* */` comments
- 33 new property-based tests (exploration + preservation)

### 0.5.0

- **Table Preview** — Double-click tables/views in Object Explorer to preview data with filter, sort, and edit-query capabilities
- **ODBC Driver Detection & Guided Setup** — Categorized connection error handling with actionable dialogs
- **Run/Stop Button State Toggle** — Per-editor execution state machine with toolbar icon switching
- **Extension Settings Surface** — 8 new settings with VS Code Settings UI grouping, runtime application
- **Split/Combined Result Panes** — Single-pane stacked or tabbed split-pane display modes with "Batch N - Result M" labeling
- **Keyboard Shortcut List** — QuickPick command listing all shortcuts grouped by category
- **Statement Outline & Inline Run/Stop** — Per-statement background decoration, CodeLens run/stop actions, 300ms debounced parsing, 500-statement threshold
- New keybindings: Cancel Query (`Ctrl+Shift+Q`), Run Current Statement (`Ctrl+Enter`), Show Keyboard Shortcuts (`Ctrl+Shift+/`)

### 0.4.4

- **Smart Aggregation Helper & Auto GROUP BY Injection:**
  - Type-aware aggregate column completions — numeric columns ranked higher for SUM/AVG/STDEV/VAR; COUNT/COUNT_BIG include `*`; MIN/MAX suggest all columns
  - Aggregate function snippets — inserts `FUNCNAME($1)` with cursor inside parentheses and triggers re-completion
  - Aggregation context detection — backward-scanning algorithm detects cursor inside aggregate parentheses, handles nested expressions like `SUM(CASE WHEN ... END)`
  - Auto GROUP BY completion — suggests `GROUP BY col1, col2, ...` with correct non-aggregated columns, suppressed when GROUP BY already exists
  - GROUP BY Code Action (Quick Fix) — lightbulb to insert GROUP BY after FROM/WHERE with proper indentation, or add missing columns to existing GROUP BY
  - HAVING clause awareness — prioritizes aggregate functions and GROUP BY columns in HAVING context
  - Multi-table aggregation — columns from all joined tables in aggregate completions, ambiguous names require qualification, alias resolution for type-aware filtering
- **IntelliSense Clause Engine** — Complete overhaul of the completion system with a formal Clause State Engine, deterministic keyword injection, 4-tier ranking, and context-based noise reduction:
  - Clause State Engine (`clauseStateEngine.ts`) — models canonical T-SQL clause ordering as a state transition table with scope-aware presence detection (handles subqueries, CTE bodies, comments, and string literals)
  - CTE Resolver (`cteResolver.ts`) — dedicated module for chained CTE resolution with column propagation, forward reference handling, bracketed identifiers, and column list syntax support
  - 4-tier ranking: required keywords (tier 0) > columns/aliases/functions (tier 1) > CTE names (tier 2) > schema objects (tier 3)
  - Context filtering: FROM/JOIN shows tables/views/CTEs only; SELECT/WHERE shows columns/functions only; immediately after JOIN suppresses keywords until a table is typed
  - Deterministic keyword injection: FROM always appears after SELECT column list, ON after JOIN table reference, successor clauses after FROM
  - CROSS JOIN correctly never suggests ON
  - Keyword prefix override: typing ≥1 character of a keyword includes it regardless of context
  - CTE alias-dot completion with proper resolution priority (table alias > CTE alias > direct CTE name)

### 0.4.3

- **Real-Time T-SQL Syntax Error Linting** — Red squiggles appear as you type for common syntax errors (empty SELECT lists, missing table names, unclosed BEGIN blocks). Debounced at 500ms. Disable via `sqlServer.linting.enabled` setting.
- **T-SQL Code Formatting** — Format Document and Format Selection support with uppercase keywords, clause-per-line layout, nested indentation, and configurable tab size / spaces. Invalid SQL is returned unchanged.
- **Alias-Aware Column Completions** — Type `alias.` in WHERE (or other) clauses to get column completions for the aliased table. Supports multi-join queries, self-joins, CTEs with explicit column lists, and schema-name fallthrough.
- **Go to Definition for Database Objects** — Right-click procedures, views, or functions in Object Explorer to view their source. Also works via Ctrl+Click / F12 on schema-qualified names in the editor. Handles encrypted objects and unsupported types gracefully.

### 0.4.2

- Bug fixes for IntelliSense completion edge cases
- Improved EXEC keyword handling

### 0.4.1

- UI improvements and connection form enhancements

### 0.4.0

- ClauseFlow multi-CTE support with scope isolation
- Statement-level scoping for IntelliSense

### 0.3.0

- Smart Join Generator (FK-based JOIN completions with auto-generated ON clauses)
- SELECT * expansion into explicit column lists
- Schema hover tooltips for tables, columns, and views
