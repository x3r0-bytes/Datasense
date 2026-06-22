import { PreviewQueryParams, TablePreviewIdentifier } from './types';

/**
 * Escapes a SQL identifier for use inside bracket-quoted names.
 * Replaces `]` with `]]` to prevent bracket injection.
 */
function escapeBracketIdentifier(name: string): string {
  return name.replace(/\]/g, ']]');
}

/**
 * Generates a preview SQL query from table metadata and optional filters.
 *
 * Produces: SELECT TOP <rowLimit> * FROM [<schema>].[<objectName>]
 * with optional WHERE and ORDER BY clauses.
 */
export function buildPreviewQuery(params: PreviewQueryParams): string {
  const { schema, objectName, rowLimit, filterText, sortColumn, sortDirection } = params;

  const escapedSchema = escapeBracketIdentifier(schema);
  const escapedObject = escapeBracketIdentifier(objectName);

  let query = `SELECT TOP ${rowLimit} * FROM [${escapedSchema}].[${escapedObject}]`;

  if (filterText && filterText.trim().length > 0) {
    query += ` WHERE ${filterText.trim()}`;
  }

  if (sortColumn && sortColumn.trim().length > 0) {
    const escapedSortColumn = escapeBracketIdentifier(sortColumn.trim());
    const direction = sortDirection || 'ASC';
    query += ` ORDER BY [${escapedSortColumn}] ${direction}`;
  }

  return query;
}

/**
 * Creates a unique string key from all 4 fields of a TablePreviewIdentifier.
 * Used to key open preview tabs and detect duplicates.
 */
export function buildTablePreviewId(id: TablePreviewIdentifier): string {
  return `${id.connectionName}|${id.database}|${id.schema}|${id.objectName}`;
}

/**
 * Compares two TablePreviewIdentifier objects for equality.
 * Uses case-insensitive comparison on all 4 fields.
 */
export function arePreviewIdsEqual(a: TablePreviewIdentifier, b: TablePreviewIdentifier): boolean {
  return (
    a.connectionName.toLowerCase() === b.connectionName.toLowerCase() &&
    a.database.toLowerCase() === b.database.toLowerCase() &&
    a.schema.toLowerCase() === b.schema.toLowerCase() &&
    a.objectName.toLowerCase() === b.objectName.toLowerCase()
  );
}
