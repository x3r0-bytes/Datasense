/**
 * Alias Resolver for the SQL Server Language Server.
 *
 * Resolves table aliases to their column lists using the schema cache.
 * Handles alias-dot completions in WHERE clauses by determining whether
 * a typed prefix refers to a table alias, CTE name, or schema name.
 */

import { TableReference } from './completionProvider';
import { ISchemaCache, ColumnInfo, TableInfo, ViewInfo } from './schemaCache';

// --- Interfaces ---

/**
 * Result of resolving an alias to its columns.
 */
export interface AliasResolution {
  /** The resolved columns for the alias */
  columns: ColumnInfo[];
  /** Whether the alias was found (true) or not (false) */
  found: boolean;
  /** If the prefix is a schema name rather than an alias */
  isSchemaName: boolean;
}

// --- Public Functions ---

/**
 * Resolve an alias to its columns.
 *
 * Resolution priority order:
 * 1. Table alias (FROM/JOIN alias) → schema cache columns
 * 2. CTE alias (FROM/JOIN alias pointing to a CTE name) → CTE schema columns
 * 3. Direct CTE name match → CTE schema columns
 * 4. Schema name → fallthrough (not an alias)
 * 5. No match → empty result
 *
 * Table aliases take priority over direct CTE name matches (Req 7.6).
 *
 * @param alias - The alias or prefix typed before the dot
 * @param tableReferences - Table references extracted from FROM/JOIN clauses in the current scope
 * @param cteColumns - Map of CTE name → columns (empty array means SELECT * was used)
 * @param schemaCache - The schema cache for looking up table/view columns
 * @returns AliasResolution with columns, found status, and schema name indicator
 */
export function resolveAlias(
  alias: string,
  tableReferences: TableReference[],
  cteColumns: Map<string, ColumnInfo[]>,
  schemaCache: ISchemaCache
): AliasResolution {
  const emptyResult: AliasResolution = { columns: [], found: false, isSchemaName: false };

  if (!alias) {
    return emptyResult;
  }

  const aliasLower = alias.toLowerCase();

  // Step 1 & 2: Check if prefix matches a defined table alias
  const matchedRef = tableReferences.find(
    ref => ref.alias !== undefined && ref.alias.toLowerCase() === aliasLower
  );

  if (matchedRef) {
    // Step 1: Try resolving from schema cache first (table alias → schema cache columns)
    const columns = lookupColumnsForReference(matchedRef, schemaCache);
    if (columns.length > 0) {
      return { columns, found: true, isSchemaName: false };
    }

    // Step 2: If schema cache lookup returned nothing, check if the reference
    // points to a CTE name (CTE alias → CTE schema columns)
    const refNameLower = matchedRef.name.toLowerCase();
    const cteColumnsForRef = lookupCTEColumns(refNameLower, cteColumns);
    if (cteColumnsForRef !== undefined) {
      return { columns: cteColumnsForRef, found: true, isSchemaName: false };
    }

    // Alias was found in table references but couldn't resolve columns
    // (table not in schema cache and not a CTE) — still report as found
    return { columns: [], found: true, isSchemaName: false };
  }

  // Step 3: Check if prefix directly matches a CTE name
  const directCteColumns = lookupCTEColumns(aliasLower, cteColumns);
  if (directCteColumns !== undefined) {
    return { columns: directCteColumns, found: true, isSchemaName: false };
  }

  // Step 4: Check if prefix matches a schema name in the cache (fallthrough)
  if (isSchemaName(aliasLower, schemaCache)) {
    return { columns: [], found: false, isSchemaName: true };
  }

  // Step 5: No match found
  return emptyResult;
}

/**
 * Extract column names from a CTE's SELECT list.
 *
 * Parses the CTE body text to find the SELECT clause and extract column
 * names/aliases from it. Returns null if the CTE uses SELECT * (cannot
 * resolve columns without schema knowledge).
 *
 * @param cteBodyText - The text inside the CTE's parentheses (the query body)
 * @returns Array of ColumnInfo for the CTE's columns, or null if SELECT * is used
 */
export function extractCTEColumns(cteBodyText: string): ColumnInfo[] | null {
  if (!cteBodyText || !cteBodyText.trim()) {
    return null;
  }

  // Strip comments and string literals to avoid false matches
  const cleaned = stripLiteralsAndComments(cteBodyText);

  // Find the first SELECT keyword (the outermost one)
  const selectMatch = /\bselect\b/i.exec(cleaned);
  if (!selectMatch) {
    return null;
  }

  // Get text after SELECT, handling TOP and DISTINCT
  let afterSelect = cleaned.substring(selectMatch.index + selectMatch[0].length).trimStart();

  // Skip DISTINCT keyword if present
  const distinctMatch = /^distinct\b/i.exec(afterSelect);
  if (distinctMatch) {
    afterSelect = afterSelect.substring(distinctMatch[0].length).trimStart();
  }

  // Skip TOP N / TOP (N) PERCENT if present
  const topMatch = /^top\s+(?:\(\s*\d+\s*\)|\d+)(?:\s+percent)?\s*/i.exec(afterSelect);
  if (topMatch) {
    afterSelect = afterSelect.substring(topMatch[0].length).trimStart();
  }

  // Check for SELECT * — return null
  if (/^\*\s*(?:$|,|\bfrom\b)/i.test(afterSelect)) {
    return null;
  }

  // Find the FROM keyword to delimit the SELECT list
  // We need to respect parentheses depth (subqueries, function calls)
  const selectListEnd = findFromKeywordPosition(afterSelect);
  const selectList = selectListEnd === -1 ? afterSelect : afterSelect.substring(0, selectListEnd);

  // Parse the column list
  const columns = parseSelectList(selectList);
  return columns;
}

/**
 * Filter columns by a typed prefix (case-insensitive startsWith match).
 *
 * @param columns - The full list of columns to filter
 * @param prefix - The typed prefix after the dot (e.g., "Na" from "u.Na")
 * @returns Filtered columns whose names start with the prefix
 */
export function filterColumnsByPrefix(columns: ColumnInfo[], prefix: string): ColumnInfo[] {
  if (!prefix) {
    return columns;
  }

  const prefixLower = prefix.toLowerCase();
  return columns.filter(col => col.name.toLowerCase().startsWith(prefixLower));
}

// --- Private Helper Functions ---

/**
 * Look up columns for a CTE name in the CTE schema map (case-insensitive).
 * Returns undefined if the CTE name is not found in the map.
 */
function lookupCTEColumns(
  nameLower: string,
  cteColumns: Map<string, ColumnInfo[]>
): ColumnInfo[] | undefined {
  // Check direct lowercase key match first
  if (cteColumns.has(nameLower)) {
    return cteColumns.get(nameLower)!;
  }

  // Fallback: case-insensitive scan (in case the map uses original casing)
  for (const [cteName, columns] of cteColumns) {
    if (cteName.toLowerCase() === nameLower) {
      return columns;
    }
  }

  return undefined;
}

/**
 * Look up columns for a table reference in the schema cache.
 * Handles both schema-qualified and unqualified table names.
 */
function lookupColumnsForReference(ref: TableReference, schemaCache: ISchemaCache): ColumnInfo[] {
  const tableOrView = findTableOrView(schemaCache, ref);
  if (tableOrView) {
    return tableOrView.columns;
  }
  return [];
}

/**
 * Finds a table or view in the schema cache matching a table reference.
 * Case-insensitive matching. Prefers dbo schema when no schema is specified.
 */
function findTableOrView(
  schemaCache: ISchemaCache,
  ref: TableReference
): TableInfo | ViewInfo | null {
  if (ref.schema) {
    // Match with schema prefix (case-insensitive)
    const table = schemaCache.tables.find(
      t => t.schema.toLowerCase() === ref.schema!.toLowerCase() &&
           t.name.toLowerCase() === ref.name.toLowerCase()
    );
    if (table) return table;

    const view = schemaCache.views.find(
      v => v.schema.toLowerCase() === ref.schema!.toLowerCase() &&
           v.name.toLowerCase() === ref.name.toLowerCase()
    );
    if (view) return view;
  } else {
    // No schema specified — match by name, prefer dbo
    const tables = schemaCache.tables.filter(
      t => t.name.toLowerCase() === ref.name.toLowerCase()
    );
    if (tables.length > 0) {
      const dboTable = tables.find(t => t.schema.toLowerCase() === 'dbo');
      return dboTable || tables[0];
    }

    const views = schemaCache.views.filter(
      v => v.name.toLowerCase() === ref.name.toLowerCase()
    );
    if (views.length > 0) {
      const dboView = views.find(v => v.schema.toLowerCase() === 'dbo');
      return dboView || views[0];
    }
  }

  return null;
}

/**
 * Checks whether a given name matches any schema name present in the schema cache.
 * A schema name is considered present if any table or view uses that schema.
 */
function isSchemaName(nameLower: string, schemaCache: ISchemaCache): boolean {
  const hasTableSchema = schemaCache.tables.some(
    t => t.schema.toLowerCase() === nameLower
  );
  if (hasTableSchema) return true;

  const hasViewSchema = schemaCache.views.some(
    v => v.schema.toLowerCase() === nameLower
  );
  return hasViewSchema;
}

/**
 * Find the position of the FROM keyword at the top level (not inside parentheses).
 * Returns -1 if no FROM is found.
 */
function findFromKeywordPosition(text: string): number {
  let depth = 0;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') {
      depth++;
    } else if (text[i] === ')') {
      depth--;
    } else if (depth === 0) {
      // Check for FROM keyword at this position
      if (i + 4 <= text.length &&
          /\bfrom\b/i.test(text.substring(i, i + 5))) {
        // Verify it's a word boundary before "from"
        if (i === 0 || /\s/.test(text[i - 1])) {
          return i;
        }
      }
    }
  }

  return -1;
}

/**
 * Parse a SELECT column list into ColumnInfo entries.
 * Extracts column names from expressions, handling aliases (AS or implicit).
 */
function parseSelectList(selectList: string): ColumnInfo[] {
  const columns: ColumnInfo[] = [];
  const items = splitSelectItems(selectList);

  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;

    // Check for alias.* pattern — return null for the whole CTE
    if (/^\w+\.\*$/.test(trimmed) || trimmed === '*') {
      return [];
    }

    const columnName = extractColumnName(trimmed);
    if (columnName) {
      columns.push({
        name: columnName,
        dataType: 'unknown',
        isNullable: true,
      });
    }
  }

  return columns;
}

/**
 * Split a SELECT list by commas, respecting parentheses depth.
 * Commas inside function calls or subqueries are not treated as separators.
 */
function splitSelectItems(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      items.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  if (current.trim()) {
    items.push(current);
  }

  return items;
}

/**
 * Extract the column name from a SELECT item expression.
 *
 * Handles patterns:
 * - `expression AS alias` → alias
 * - `expression alias` (implicit alias, last word) → alias
 * - `table.column` → column
 * - `column` → column
 * - `function(...)` → null (no clear name)
 */
function extractColumnName(expression: string): string | null {
  const trimmed = expression.trim();
  if (!trimmed) return null;

  // Check for explicit AS alias: `... AS alias`
  const asMatch = /\bas\s+((?:\[[^\]]*\])|(?:[a-zA-Z_][a-zA-Z0-9_]*))\s*$/i.exec(trimmed);
  if (asMatch) {
    return stripBrackets(asMatch[1]);
  }

  // Check for implicit alias: last token after a space that looks like an identifier
  // But NOT if the expression ends with a closing paren (function call without alias)
  if (!trimmed.endsWith(')')) {
    // Split by whitespace and check if the last token is a simple identifier
    const tokens = trimmed.split(/\s+/);
    if (tokens.length > 1) {
      const lastToken = tokens[tokens.length - 1];
      // Must be a valid identifier (not a keyword, not containing operators)
      if (/^(?:\[[^\]]*\]|[a-zA-Z_][a-zA-Z0-9_]*)$/.test(lastToken)) {
        // Make sure the previous token isn't a comparison operator or keyword that takes an operand
        const prevToken = tokens[tokens.length - 2].toUpperCase();
        const nonAliasKeywords = new Set(['AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN', 'IS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'BY']);
        if (!nonAliasKeywords.has(prevToken) && !/^[=<>!+\-*/]/.test(prevToken)) {
          return stripBrackets(lastToken);
        }
      }
    }
  }

  // Check for dotted reference: `schema.table.column` or `table.column` → last part
  const dottedMatch = /^[\w\[\]]+\.[\w\[\]]+(?:\.[\w\[\]]+)?$/.exec(trimmed);
  if (dottedMatch) {
    const parts = trimmed.split('.');
    return stripBrackets(parts[parts.length - 1]);
  }

  // Simple identifier
  if (/^(?:\[[^\]]*\]|[a-zA-Z_][a-zA-Z0-9_]*)$/.test(trimmed)) {
    return stripBrackets(trimmed);
  }

  // Expression ending with closing paren (function call) — try to find an alias
  // If no alias found, use the function name as a fallback
  if (trimmed.endsWith(')')) {
    // Check if there's a simple function name at the start
    const funcMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/.exec(trimmed);
    if (funcMatch) {
      return funcMatch[1];
    }
  }

  return null;
}

/**
 * Strips square brackets from a bracketed identifier.
 */
function stripBrackets(identifier: string): string {
  if (identifier.startsWith('[') && identifier.endsWith(']')) {
    return identifier.slice(1, -1);
  }
  return identifier;
}

/**
 * Strips string literals and comments from SQL text to avoid false keyword matches.
 * Replaces their content with spaces to preserve character positions.
 */
function stripLiteralsAndComments(text: string): string {
  let result = '';
  let i = 0;

  while (i < text.length) {
    // Single-line comment
    if (text[i] === '-' && i + 1 < text.length && text[i + 1] === '-') {
      const end = text.indexOf('\n', i);
      const commentEnd = end === -1 ? text.length : end;
      result += ' '.repeat(commentEnd - i);
      i = commentEnd;
    }
    // Multi-line comment
    else if (text[i] === '/' && i + 1 < text.length && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const commentEnd = end === -1 ? text.length : end + 2;
      result += ' '.repeat(commentEnd - i);
      i = commentEnd;
    }
    // String literal (single-quoted, handles escaped quotes '')
    else if (text[i] === '\'') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\'') {
          if (j + 1 < text.length && text[j + 1] === '\'') {
            j += 2; // escaped quote
          } else {
            j += 1; // end of string
            break;
          }
        } else {
          j++;
        }
      }
      result += ' '.repeat(j - i);
      i = j;
    }
    // Normal character
    else {
      result += text[i];
      i++;
    }
  }

  return result;
}
