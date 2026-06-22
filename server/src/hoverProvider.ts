/**
 * Hover provider for the SQL Server Language Server.
 *
 * Resolves identifiers at the cursor position against the SchemaCache
 * and returns formatted metadata tooltips for tables, columns, and views.
 */

import { Hover, Position, MarkupKind } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ISchemaCache, TableInfo, ViewInfo, ColumnInfo, ForeignKeyInfo } from './schemaCache';
import { extractTableReferences, TableReference } from './completionProvider';

/**
 * Represents a resolved column match with its owning table context.
 */
interface ColumnMatch {
  column: ColumnInfo;
  table: TableInfo;
}

/**
 * Returns hover information for the identifier at the given position.
 *
 * - Returns null if the schema cache is populating
 * - Returns null if the identifier cannot be resolved
 * - Returns null if the resolved table has zero columns
 * - For resolved tables with 1+ columns: shows schema, name, column count,
 *   column list with data types, and FK relationships if any
 * - For columns: shows data type, nullability, owning table, PK/FK indicators
 * - For ambiguous columns: shows metadata for all matches grouped by table
 *
 * @param document - The text document
 * @param position - The cursor position
 * @param schemaCache - The schema cache instance
 * @returns Hover info or null
 */
export function getHoverInfo(
  document: TextDocument,
  position: Position,
  schemaCache: ISchemaCache
): Hover | null {
  // Return null when schema cache is populating (Requirement 11.4)
  if (schemaCache.isPopulating) {
    return null;
  }

  // Extract the identifier at the cursor position
  const identifier = getIdentifierAtPosition(document, position);
  if (!identifier) {
    return null;
  }

  // Try to resolve as a table
  const tableResult = resolveTable(identifier, schemaCache);
  if (tableResult) {
    return buildTableHover(tableResult, schemaCache);
  }

  // Try to resolve as a view (Requirement 13.1, 13.2, 13.3)
  const viewResult = resolveView(identifier, schemaCache);
  if (viewResult) {
    return buildViewHover(viewResult);
  }

  // Try to resolve as a column (Requirement 12.1-12.5)
  const columnHover = resolveColumnHover(identifier, document, schemaCache);
  if (columnHover) {
    return columnHover;
  }

  // Identifier could not be resolved
  return null;
}

/**
 * Extracts the identifier (word) at the given cursor position.
 * Handles schema-qualified identifiers like `dbo.Orders`.
 * Valid identifier characters: letters, digits, underscores, dots (for schema qualification).
 */
export function getIdentifierAtPosition(
  document: TextDocument,
  position: Position
): string | null {
  const line = document.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line + 1, character: 0 },
  });

  // Remove trailing newline if present
  const lineText = line.replace(/\r?\n$/, '');

  if (position.character > lineText.length) {
    return null;
  }

  // Find the start and end of the identifier at the cursor position
  // Valid identifier chars: letters, digits, underscores, dots (for schema.table)
  const identCharRegex = /[a-zA-Z0-9_.]/;

  let start = position.character;
  let end = position.character;

  // Expand left
  while (start > 0 && identCharRegex.test(lineText[start - 1])) {
    start--;
  }

  // Expand right
  while (end < lineText.length && identCharRegex.test(lineText[end])) {
    end++;
  }

  if (start === end) {
    return null;
  }

  const word = lineText.substring(start, end);

  // Must contain at least one letter or underscore to be a valid identifier
  if (!/[a-zA-Z_]/.test(word)) {
    return null;
  }

  return word;
}

/**
 * Resolves an identifier against the schema cache tables.
 * Handles both schema-qualified (`dbo.Orders`) and unqualified (`Orders`) identifiers.
 * Uses case-insensitive matching.
 *
 * @returns The matching TableInfo or null
 */
function resolveTable(
  identifier: string,
  schemaCache: ISchemaCache
): TableInfo | null {
  const parts = identifier.split('.');

  if (parts.length === 2) {
    // Schema-qualified: schema.tableName
    const [schema, tableName] = parts;
    const match = schemaCache.tables.find(
      t =>
        t.schema.toLowerCase() === schema.toLowerCase() &&
        t.name.toLowerCase() === tableName.toLowerCase()
    );
    return match || null;
  } else if (parts.length === 1) {
    // Unqualified: try to resolve by name only, prefer dbo schema
    const tableName = parts[0];
    const matches = schemaCache.tables.filter(
      t => t.name.toLowerCase() === tableName.toLowerCase()
    );

    if (matches.length === 0) {
      return null;
    }

    // Prefer dbo schema
    const dboMatch = matches.find(
      t => t.schema.toLowerCase() === 'dbo'
    );
    return dboMatch || matches[0];
  }

  return null;
}

/**
 * Resolves an identifier against the schema cache views.
 * Handles both schema-qualified (`dbo.MyView`) and unqualified (`MyView`) identifiers.
 * Uses case-insensitive matching (Requirement 13.3).
 *
 * @returns The matching ViewInfo or null
 */
function resolveView(
  identifier: string,
  schemaCache: ISchemaCache
): ViewInfo | null {
  const parts = identifier.split('.');

  if (parts.length === 2) {
    // Schema-qualified: schema.viewName
    const [schema, viewName] = parts;
    const match = schemaCache.views.find(
      v =>
        v.schema.toLowerCase() === schema.toLowerCase() &&
        v.name.toLowerCase() === viewName.toLowerCase()
    );
    return match || null;
  } else if (parts.length === 1) {
    // Unqualified: try to resolve by name only, prefer dbo schema
    const viewName = parts[0];
    const matches = schemaCache.views.filter(
      v => v.name.toLowerCase() === viewName.toLowerCase()
    );

    if (matches.length === 0) {
      return null;
    }

    // Prefer dbo schema
    const dboMatch = matches.find(
      v => v.schema.toLowerCase() === 'dbo'
    );
    return dboMatch || matches[0];
  }

  return null;
}

/**
 * Resolves a column hover from the identifier and document context.
 *
 * Column resolution logic:
 * - If identifier contains a dot (e.g., `o.OrderId` or `Orders.OrderId`):
 *   - The part before the dot is the table alias or table name
 *   - The part after the dot is the column name
 *   - Resolve the table first, then find the column in that table
 * - If identifier has no dot (e.g., `OrderId`):
 *   - Look through all tables referenced in the FROM/JOIN clauses
 *   - If the column exists in exactly one table → resolve it
 *   - If the column exists in multiple tables → ambiguous (show all matches)
 *   - If the column doesn't exist in any table → return null
 *
 * @param identifier - The identifier at the cursor position
 * @param document - The text document
 * @param schemaCache - The schema cache instance
 * @returns Hover info or null
 */
function resolveColumnHover(
  identifier: string,
  document: TextDocument,
  schemaCache: ISchemaCache
): Hover | null {
  const parts = identifier.split('.');
  const documentText = document.getText();
  const tableRefs = extractTableReferences(documentText);

  if (parts.length === 2) {
    // Dot-prefixed: alias.column or tableName.column
    const [prefix, columnName] = parts;
    return resolveQualifiedColumn(prefix, columnName, tableRefs, schemaCache);
  } else if (parts.length === 1) {
    // Unqualified column: look through FROM/JOIN context
    const columnName = parts[0];
    return resolveUnqualifiedColumn(columnName, tableRefs, schemaCache);
  }

  return null;
}

/**
 * Resolves a qualified column (prefix.columnName) where prefix is a table alias or name.
 */
function resolveQualifiedColumn(
  prefix: string,
  columnName: string,
  tableRefs: TableReference[],
  schemaCache: ISchemaCache
): Hover | null {
  // Find the table reference matching the prefix (alias or table name)
  const matchingRef = tableRefs.find(
    ref =>
      (ref.alias && ref.alias.toLowerCase() === prefix.toLowerCase()) ||
      ref.name.toLowerCase() === prefix.toLowerCase()
  );

  if (!matchingRef) {
    return null;
  }

  // Resolve the table reference to a TableInfo in the schema cache
  const table = findTableInCache(matchingRef, schemaCache);
  if (!table) {
    return null;
  }

  // Find the column in the table
  const column = table.columns.find(
    c => c.name.toLowerCase() === columnName.toLowerCase()
  );
  if (!column) {
    return null;
  }

  return buildColumnHover({ column, table }, schemaCache);
}

/**
 * Resolves an unqualified column by searching all tables in FROM/JOIN context.
 * If found in exactly one table → resolved.
 * If found in multiple tables → ambiguous (show all matches).
 * If not found → return null.
 */
function resolveUnqualifiedColumn(
  columnName: string,
  tableRefs: TableReference[],
  schemaCache: ISchemaCache
): Hover | null {
  const matches: ColumnMatch[] = [];

  for (const ref of tableRefs) {
    const table = findTableInCache(ref, schemaCache);
    if (!table) continue;

    const column = table.columns.find(
      c => c.name.toLowerCase() === columnName.toLowerCase()
    );
    if (column) {
      matches.push({ column, table });
    }
  }

  if (matches.length === 0) {
    return null;
  }

  if (matches.length === 1) {
    return buildColumnHover(matches[0], schemaCache);
  }

  // Ambiguous: column exists in multiple tables (Requirement 12.4)
  return buildAmbiguousColumnHover(columnName, matches, schemaCache);
}

/**
 * Finds a table in the schema cache matching a table reference.
 * Matches by schema + name, or by name only (preferring dbo schema).
 */
function findTableInCache(
  ref: TableReference,
  schemaCache: ISchemaCache
): TableInfo | null {
  if (ref.schema) {
    return schemaCache.tables.find(
      t =>
        t.schema.toLowerCase() === ref.schema!.toLowerCase() &&
        t.name.toLowerCase() === ref.name.toLowerCase()
    ) || null;
  }

  // No schema specified - match by name only
  const matches = schemaCache.tables.filter(
    t => t.name.toLowerCase() === ref.name.toLowerCase()
  );

  if (matches.length === 0) return null;

  // Prefer dbo schema
  const dboMatch = matches.find(t => t.schema.toLowerCase() === 'dbo');
  return dboMatch || matches[0];
}

/**
 * Builds a Hover object for a resolved column.
 *
 * Format:
 * **ColumnName**: dataType (nullable/not null)
 *
 * Table: schema.TableName
 * Primary Key (if applicable)
 * Foreign Key → schema.ReferencedTable.ReferencedColumn (if applicable)
 */
function buildColumnHover(
  match: ColumnMatch,
  schemaCache: ISchemaCache
): Hover | null {
  const { column, table } = match;
  const lines: string[] = [];

  const nullability = column.isNullable ? 'nullable' : 'not null';
  lines.push(`**${column.name}**: ${column.dataType} (${nullability})`);
  lines.push('');
  lines.push(`Table: ${table.schema}.${table.name}`);

  // Primary Key indicator (Requirement 3.1, 3.3)
  try {
    const pkColumns = schemaCache.getPrimaryKeyColumns(table.schema, table.name);
    if (pkColumns.some(pk => pk.toLowerCase() === column.name.toLowerCase())) {
      lines.push('Primary Key');
    }
  } catch {
    // Graceful degradation: omit PK indicator on error (Requirement 7.4)
  }

  // Check FK relationships (Requirement 12.3)
  const fkInfo = getColumnForeignKeyInfo(column.name, table, schemaCache);
  if (fkInfo) {
    lines.push(fkInfo);
  }

  const content = lines.join('\n');

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: content,
    },
  };
}

/**
 * Builds a Hover object for an ambiguous column (exists in multiple tables).
 * Gracefully degrades to no tooltip if display fails (Requirement 12.4).
 *
 * Format:
 * **ColumnName** (ambiguous)
 *
 * In schema.Table1:
 * - ColumnName: dataType (nullable/not null)
 *
 * In schema.Table2:
 * - ColumnName: dataType (nullable/not null)
 */
function buildAmbiguousColumnHover(
  columnName: string,
  matches: ColumnMatch[],
  schemaCache: ISchemaCache
): Hover | null {
  try {
    const lines: string[] = [];

    lines.push(`**${columnName}** (ambiguous)`);

    for (const match of matches) {
      const { column, table } = match;
      const nullability = column.isNullable ? 'nullable' : 'not null';
      lines.push('');
      lines.push(`In ${table.schema}.${table.name}:`);
      lines.push(`- ${column.name}: ${column.dataType} (${nullability})`);

      // PK indicator per table (Requirement 5.1, 5.2)
      try {
        const pkColumns = schemaCache.getPrimaryKeyColumns(table.schema, table.name);
        if (pkColumns.some(pk => pk.toLowerCase() === column.name.toLowerCase())) {
          lines.push('Primary Key');
        }
      } catch {
        // Graceful degradation: omit PK indicator for this table
      }

      // FK indicator per table (Requirement 5.3)
      const fkInfo = getColumnForeignKeyInfo(column.name, table, schemaCache);
      if (fkInfo) {
        lines.push(fkInfo);
      }
    }

    const content = lines.join('\n');

    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: content,
      },
    };
  } catch {
    // Gracefully degrade to no tooltip if display fails (Requirement 12.4)
    return null;
  }
}

/**
 * Checks if a column is a referencing column in any FK relationship for the given table.
 * Returns a formatted string like "Foreign Key → schema.ReferencedTable.ReferencedColumn"
 * or null if the column is not part of any FK.
 */
function getColumnForeignKeyInfo(
  columnName: string,
  table: TableInfo,
  schemaCache: ISchemaCache
): string | null {
  const foreignKeys = schemaCache.getForeignKeysForTable(table.schema, table.name);

  for (const fk of foreignKeys) {
    // Only check FKs where this table is the referencing table
    if (
      fk.referencingSchema.toLowerCase() === table.schema.toLowerCase() &&
      fk.referencingTable.toLowerCase() === table.name.toLowerCase()
    ) {
      // Check if this column is one of the referencing columns
      const pair = fk.columnPairs.find(
        p => p.referencingColumn.toLowerCase() === columnName.toLowerCase()
      );
      if (pair) {
        return `Foreign Key → ${fk.referencedSchema}.${fk.referencedTable}.${pair.referencedColumn}`;
      }
    }
  }

  return null;
}

/**
 * Builds a Hover object for a resolved table.
 * Returns null if the table has zero columns.
 *
 * Format:
 * **schema.TableName** (Table)
 *
 * Columns (N):
 * - ColName: dataType (nullable/not null)
 *
 * Foreign Keys:
 * - FK_Name → schema.ReferencedTable
 */
function buildTableHover(
  table: TableInfo,
  schemaCache: ISchemaCache
): Hover | null {
  // Return null for tables with zero columns (Requirement 11.1)
  if (table.columns.length === 0) {
    return null;
  }

  const lines: string[] = [];

  // Header
  lines.push(`**${table.schema}.${table.name}** (Table)`);
  lines.push('');

  // Column count and list
  lines.push(`Columns (${table.columns.length}):`);
  for (const col of table.columns) {
    const nullability = col.isNullable ? 'nullable' : 'not null';
    lines.push(`- ${col.name}: ${col.dataType} (${nullability})`);
  }

  // Foreign key relationships (Requirement 11.2)
  const foreignKeys = schemaCache.getForeignKeysForTable(table.schema, table.name);
  if (foreignKeys.length > 0) {
    lines.push('');
    lines.push('Foreign Keys:');
    for (const fk of foreignKeys) {
      const referencedDisplay = formatFkReference(fk, table);
      lines.push(`- ${fk.constraintName} → ${referencedDisplay}`);
    }
  }

  const content = lines.join('\n');

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: content,
    },
  };
}

/**
 * Builds a Hover object for a resolved view.
 *
 * Format:
 * **schema.ViewName** (View)
 *
 * Columns (N):
 * - ColName: dataType (nullable/not null)
 */
function buildViewHover(view: ViewInfo): Hover | null {
  // Return null for views with zero columns
  if (view.columns.length === 0) {
    return null;
  }

  const lines: string[] = [];

  // Header
  lines.push(`**${view.schema}.${view.name}** (View)`);
  lines.push('');

  // Column count and list
  lines.push(`Columns (${view.columns.length}):`);
  for (const col of view.columns) {
    const nullability = col.isNullable ? 'nullable' : 'not null';
    lines.push(`- ${col.name}: ${col.dataType} (${nullability})`);
  }

  const content = lines.join('\n');

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: content,
    },
  };
}

/**
 * Formats the FK reference display for a hover tooltip.
 * Shows the "other" table in the relationship relative to the hovered table.
 */
function formatFkReference(fk: ForeignKeyInfo, currentTable: TableInfo): string {
  // If the current table is the referencing table, show the referenced table
  if (
    fk.referencingSchema.toLowerCase() === currentTable.schema.toLowerCase() &&
    fk.referencingTable.toLowerCase() === currentTable.name.toLowerCase()
  ) {
    return `${fk.referencedSchema}.${fk.referencedTable}`;
  }

  // If the current table is the referenced table, show the referencing table
  return `${fk.referencingSchema}.${fk.referencingTable}`;
}
