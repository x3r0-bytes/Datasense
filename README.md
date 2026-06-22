# Datasense

## Why Datasense?

Datasense brings a complete SQL Server development experience to VS Code with schema-aware IntelliSense that understands your database structure as you type. Built for SQL Server developers and DBAs who want fast, intelligent query authoring without leaving their editor.

## Quick Start

> **Prerequisite:** A SQL Server instance must be accessible from your machine.

1. **Add a connection** — Open the Command Palette (`Ctrl+Shift+P`) and run "SQL Server: Add Connection", or click the `+` icon in the Object Explorer sidebar.
2. **Open a SQL file** — Open an existing `.sql` file or create a new one (`Ctrl+N`, then set language to SQL).
3. **Execute your query** — Click the ▶ Run button in the editor toolbar or press `Ctrl+Shift+E` to see results in the bottom panel.

## Core Features

| Feature | Description |
|---------|-------------|
| **IntelliSense** | Schema-aware completions for tables, columns, views, and stored procedures with context detection across SELECT, FROM, JOIN, WHERE, and more |
| **Query Execution** | Run full files, selections, or individual statements with GO batch splitting, cancel support, and execution plan visualization |
| **Connection Management** | Multiple server connections with SQL Authentication and Windows Authentication, color-coded environments, and connection groups |
| **Object Explorer** | Hierarchical sidebar tree for browsing servers, databases, tables, views, columns, constraints, triggers, indexes, and statistics |
| **Result Export** | Export query results to CSV, JSON, Excel, INSERT statements, or CREATE TABLE + INSERT scripts with multi-result set support |

## Advanced Features

- Real-time T-SQL syntax error linting
- T-SQL code formatting
- Go to Definition for procedures, views, and functions
- Smart Join Generator based on foreign key relationships
- SELECT * expansion into explicit column lists
- Auto GROUP BY injection and aggregation helpers
- Dynamic SQL IntelliSense inside EXEC/sp_executesql strings
- Cross-database and multi-database IntelliSense (three-part names)
- CTE resolution with chained dependency propagation
- Execution Plan Visualizer with missing index suggestions
- Interactive Schema Diagram with column-level FK connectors
- SQL Object Search across connections and databases
- Schema Diff / Compare with ALTER script generation
- Destructive Query Warning (UPDATE/DELETE without WHERE, TRUNCATE, DROP)
- Query History with search and re-run
- Table Preview with filtering and sorting
- Find References and Rename in Workspace
- T-SQL Snippet Library with context-aware ranking
- Parameter Sniffing / Variable Declaration prompts
- Connection Color Coding for environment identification
- Statement Outline with CodeLens run/stop buttons
- GO Batch Navigator for large migration scripts

## Full Documentation

For comprehensive technical details, connection configuration, all commands, keyboard shortcuts, and the full changelog, see [DEVELOPER-REFERENCE.md](DEVELOPER-REFERENCE.md).
