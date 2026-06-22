import { ColumnInfo, ISchemaCache } from './schemaCache';

// --- Interfaces ---

/**
 * Represents the resolved schema of a single CTE.
 * null columns means the CTE used SELECT * (unresolvable).
 */
export interface CTESchema {
  /** CTE identifier name (original case) */
  name: string;
  /** Resolved columns, or null if SELECT * was used */
  columns: ColumnInfo[] | null;
}

/**
 * Result of resolving all CTEs in a statement.
 */
export interface CTEResolutionResult {
  /** Map of lowercase CTE name → CTESchema */
  schemas: Map<string, CTESchema>;
  /** CTE names available at the cursor position (in declaration order) */
  availableNames: string[];
  /** Whether the cursor is inside a CTE chain context */
  inCTEChain: boolean;
}

// --- Public Functions ---

/**
 * Extracts column metadata from a CTE's SELECT clause.
 *
 * Column name resolution rules:
 * 1. Explicit alias (AS name) → use alias name
 * 2. Dotted reference (table.column) → use last segment
 * 3. Simple identifier → use as-is
 * 4. Complex expression without alias → omit
 * 5. SELECT * → return null (unresolvable)
 *
 * All extracted columns have dataType="unknown" and isNullable=true.
 *
 * @param cteBodyText - Text inside the CTE's parentheses
 * @returns Array of ColumnInfo, or null if SELECT * is used
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
 * Resolves all CTEs in a WITH chain in declaration order.
 *
 * Resolution rules:
 * - Each CTE is processed sequentially (first to last).
 * - A CTE can reference previously resolved CTEs and schema tables.
 * - When a CTE references another CTE in FROM/JOIN, its available columns
 *   include the referenced CTE's resolved columns.
 * - Forward references produce zero columns.
 * - SELECT * produces null columns; downstream CTEs get nothing from that ref.
 * - Chains of 10+ CTEs are resolved without truncation.
 *
 * @param statementText - Full statement text containing the WITH block
 * @param cursorOffset - Cursor position for determining available CTEs
 * @param schemaCache - Schema cache for resolving real table references
 * @returns CTEResolutionResult with schema map and availability info
 */
export function resolveChainedCTEs(
  statementText: string,
  cursorOffset: number,
  schemaCache: ISchemaCache
): CTEResolutionResult {
  const emptyResult: CTEResolutionResult = {
    schemas: new Map(),
    availableNames: [],
    inCTEChain: false,
  };

  if (!statementText || !statementText.trim()) {
    return emptyResult;
  }

  // Strip literals and comments to avoid matching keywords inside strings/comments
  const cleaned = stripLiteralsAndComments(statementText);

  // Find the WITH keyword that starts the CTE block
  const cteWithStart = findCTEWithKeyword(cleaned);
  if (cteWithStart === -1) {
    return emptyResult;
  }

  // Parse all CTE definitions from the WITH block
  const cteDefinitions = parseCTEDefinitions(cleaned, statementText, cteWithStart);
  if (cteDefinitions.length === 0) {
    return emptyResult;
  }

  // Resolve each CTE sequentially in declaration order
  const schemas = new Map<string, CTESchema>();

  for (const cteDef of cteDefinitions) {
    const resolvedColumns = resolveCTEBody(cteDef, schemas, schemaCache, statementText);
    const schema: CTESchema = {
      name: cteDef.name,
      columns: resolvedColumns,
    };
    schemas.set(cteDef.name.toLowerCase(), schema);
  }

  // Determine which CTEs are available at the cursor position
  const availableNames: string[] = [];
  let inCTEChain = false;

  // Check if cursor is inside a CTE body
  for (let k = 0; k < cteDefinitions.length; k++) {
    const cte = cteDefinitions[k];
    const effectiveEnd = cte.bodyEnd === -1 ? statementText.length : cte.bodyEnd;

    if (cursorOffset > cte.bodyStart && cursorOffset <= effectiveEnd) {
      // Cursor is inside CTE body K — available names are CTEs 0..K-1
      inCTEChain = true;
      for (let i = 0; i < k; i++) {
        availableNames.push(cteDefinitions[i].name);
      }
      return { schemas, availableNames, inCTEChain };
    }
  }

  // Check if cursor is after all CTE definitions (in the final query)
  const lastCte = cteDefinitions[cteDefinitions.length - 1];
  const lastCteEnd = lastCte.bodyEnd === -1 ? statementText.length : lastCte.bodyEnd;

  if (cursorOffset > lastCteEnd) {
    inCTEChain = true;
    for (const cteDef of cteDefinitions) {
      availableNames.push(cteDef.name);
    }
    return { schemas, availableNames, inCTEChain };
  }

  // Cursor is between WITH keyword and first CTE body, or between CTE definitions
  // Check if cursor is between CTE definitions (after one body ends, before next name)
  if (cursorOffset > cteWithStart) {
    inCTEChain = true;
  }

  return { schemas, availableNames, inCTEChain };
}

// --- Internal types for CTE parsing ---

interface CTEDefinition {
  /** CTE name (brackets stripped) */
  name: string;
  /** Explicit column list if provided, e.g. WITH cte(col1, col2) AS (...) */
  columnList: string[] | null;
  /** Start position of the CTE body (opening paren) in the original text */
  bodyStart: number;
  /** End position of the CTE body (closing paren) in the original text, -1 if incomplete */
  bodyEnd: number;
  /** The raw body text between the parentheses */
  bodyText: string;
}

/**
 * Finds the position of the WITH keyword that starts a CTE block.
 * Distinguishes CTE WITH from table hint WITH (NOLOCK) by requiring
 * an identifier followed by AS pattern after WITH.
 *
 * @returns Position of the WITH keyword, or -1 if not found
 */
function findCTEWithKeyword(cleaned: string): number {
  const withPattern = /\bwith\b/gi;
  let withMatch: RegExpExecArray | null;

  while ((withMatch = withPattern.exec(cleaned)) !== null) {
    const afterWith = cleaned.substring(withMatch.index + withMatch[0].length);

    // CTE requires: identifier (or bracketed identifier) followed by AS
    // Table hints look like WITH (NOLOCK) — paren immediately after WITH
    // Also handle column list syntax: WITH cte(col1, col2) AS (...)
    const cteStartPattern = /^\s*(?:\[[^\]]*\]|[a-zA-Z_][a-zA-Z0-9_]*)(?:\s*\([^)]*\))?\s+as\b/i;
    if (cteStartPattern.test(afterWith)) {
      return withMatch.index;
    }
  }

  return -1;
}

/**
 * Parses CTE definitions from the WITH block.
 * Handles bracketed identifiers, column list syntax, and nested parentheses.
 */
function parseCTEDefinitions(
  cleaned: string,
  originalText: string,
  cteWithStart: number
): CTEDefinition[] {
  const definitions: CTEDefinition[] = [];
  let pos = cteWithStart + 4; // Skip past "WITH"

  while (pos < cleaned.length) {
    // Skip whitespace
    while (pos < cleaned.length && /\s/.test(cleaned[pos])) pos++;
    if (pos >= cleaned.length) break;

    // Parse CTE name (identifier or bracketed identifier)
    let cteName = '';
    if (cleaned[pos] === '[') {
      const closeBracket = cleaned.indexOf(']', pos + 1);
      if (closeBracket === -1) break; // Malformed bracketed identifier
      cteName = cleaned.substring(pos + 1, closeBracket);
      pos = closeBracket + 1;
    } else if (/[a-zA-Z_]/.test(cleaned[pos])) {
      const nameStart = pos;
      while (pos < cleaned.length && /[a-zA-Z0-9_]/.test(cleaned[pos])) pos++;
      cteName = cleaned.substring(nameStart, pos);
    } else {
      break; // Not a valid CTE name — stop parsing
    }

    // Skip whitespace
    while (pos < cleaned.length && /\s/.test(cleaned[pos])) pos++;

    // Check for optional column list: cte(col1, col2)
    let columnList: string[] | null = null;
    if (pos < cleaned.length && cleaned[pos] === '(') {
      // Check if this is a column list (not the AS body)
      // Look ahead: after the closing paren, there should be whitespace + AS
      const closeParen = findMatchingParenSimple(cleaned, pos);
      if (closeParen !== -1) {
        const afterParen = cleaned.substring(closeParen + 1).trimStart();
        if (/^as\b/i.test(afterParen)) {
          // This is a column list
          const colListText = cleaned.substring(pos + 1, closeParen);
          columnList = colListText.split(',').map(c => c.trim()).filter(c => c.length > 0);
          pos = closeParen + 1;
          // Skip whitespace
          while (pos < cleaned.length && /\s/.test(cleaned[pos])) pos++;
        }
      }
    }

    // Expect AS keyword
    if (pos + 2 > cleaned.length) break;
    if (cleaned.substring(pos, pos + 2).toLowerCase() !== 'as') break;
    pos += 2;

    // Skip whitespace
    while (pos < cleaned.length && /\s/.test(cleaned[pos])) pos++;

    // Expect opening paren for the CTE body
    if (pos >= cleaned.length || cleaned[pos] !== '(') break;

    const bodyStart = pos;
    const closePos = findMatchingParenSimple(cleaned, pos);

    if (closePos === -1) {
      // Incomplete CTE body — no closing paren found
      // Body extends to end of text
      const bodyText = originalText.substring(bodyStart + 1);
      definitions.push({
        name: cteName,
        columnList,
        bodyStart,
        bodyEnd: -1,
        bodyText,
      });
      break; // Can't parse further CTEs after an incomplete one
    }

    const bodyText = originalText.substring(bodyStart + 1, closePos);
    definitions.push({
      name: cteName,
      columnList,
      bodyStart,
      bodyEnd: closePos,
      bodyText,
    });

    pos = closePos + 1;

    // Skip whitespace
    while (pos < cleaned.length && /\s/.test(cleaned[pos])) pos++;

    // Check if there's a comma (another CTE definition follows)
    if (pos < cleaned.length && cleaned[pos] === ',') {
      pos++; // Skip comma and continue to next CTE
    } else {
      break; // End of CTE block
    }
  }

  return definitions;
}

/**
 * Resolves the columns for a single CTE body by:
 * 1. If the CTE has an explicit column list, use that
 * 2. Otherwise, extract columns from the SELECT clause
 * 3. Resolve FROM/JOIN references against previously resolved CTEs and schema cache
 */
function resolveCTEBody(
  cteDef: CTEDefinition,
  resolvedCTEs: Map<string, CTESchema>,
  schemaCache: ISchemaCache,
  _statementText: string
): ColumnInfo[] | null {
  // If the CTE has an explicit column list, use that directly
  if (cteDef.columnList && cteDef.columnList.length > 0) {
    return cteDef.columnList.map(colName => ({
      name: stripBrackets(colName),
      dataType: 'unknown',
      isNullable: true,
    }));
  }

  // Extract columns from the CTE body's SELECT clause
  const extractedColumns = extractCTEColumns(cteDef.bodyText);

  // If SELECT * was used, return null
  if (extractedColumns === null) {
    return null;
  }

  // If we got columns from the SELECT clause, return them
  // The extractCTEColumns function already handles alias resolution
  if (extractedColumns.length > 0) {
    return extractedColumns;
  }

  // If extractCTEColumns returned empty array (e.g., alias.* pattern),
  // try to resolve through FROM/JOIN references
  const fromReferences = extractFromJoinReferences(cteDef.bodyText);
  const resolvedFromRefs: ColumnInfo[] = [];

  for (const ref of fromReferences) {
    const refLower = ref.toLowerCase();

    // Check if reference matches a previously resolved CTE
    if (resolvedCTEs.has(refLower)) {
      const referencedCTE = resolvedCTEs.get(refLower)!;
      if (referencedCTE.columns !== null) {
        resolvedFromRefs.push(...referencedCTE.columns);
      }
      // If columns is null (SELECT *), contribute nothing
    } else {
      // Check schema cache for table/view columns
      const schemaColumns = lookupSchemaColumns(ref, schemaCache);
      if (schemaColumns) {
        resolvedFromRefs.push(...schemaColumns);
      }
    }
  }

  // If we resolved columns from references, return them
  if (resolvedFromRefs.length > 0) {
    return resolvedFromRefs;
  }

  // Return empty array if nothing could be resolved
  return extractedColumns;
}

/**
 * Extracts table/CTE references from FROM and JOIN clauses in a CTE body.
 * Returns the reference names (without aliases).
 */
function extractFromJoinReferences(bodyText: string): string[] {
  const references: string[] = [];
  const cleaned = stripLiteralsAndComments(bodyText);

  // Match FROM and JOIN references
  // Pattern: FROM/JOIN followed by an identifier (possibly schema-qualified or bracketed)
  const refPattern = /\b(?:from|join)\s+((?:\[[^\]]*\]|[a-zA-Z_][a-zA-Z0-9_]*)(?:\.(?:\[[^\]]*\]|[a-zA-Z_][a-zA-Z0-9_]*))*)/gi;
  let match: RegExpExecArray | null;

  while ((match = refPattern.exec(cleaned)) !== null) {
    const fullRef = match[1];
    // For schema-qualified references (e.g., dbo.Users), use the full reference
    // For simple references, use as-is
    references.push(fullRef);
  }

  return references;
}

/**
 * Looks up columns for a table/view reference in the schema cache.
 * Handles both schema-qualified (dbo.Users) and unqualified (Users) references.
 */
function lookupSchemaColumns(reference: string, schemaCache: ISchemaCache): ColumnInfo[] | null {
  // Strip brackets from reference parts
  const parts = reference.split('.').map(p => stripBrackets(p));

  if (parts.length === 2) {
    // Schema-qualified: schema.table
    const [schema, tableName] = parts;
    const key = `${schema}.${tableName}`.toLowerCase();

    // Check tables
    for (const table of schemaCache.tables) {
      if (`${table.schema}.${table.name}`.toLowerCase() === key) {
        return table.columns;
      }
    }

    // Check views
    for (const view of schemaCache.views) {
      if (`${view.schema}.${view.name}`.toLowerCase() === key) {
        return view.columns;
      }
    }
  } else if (parts.length === 1) {
    // Unqualified: just table name — search all schemas
    const tableName = parts[0].toLowerCase();

    // Check tables
    for (const table of schemaCache.tables) {
      if (table.name.toLowerCase() === tableName) {
        return table.columns;
      }
    }

    // Check views
    for (const view of schemaCache.views) {
      if (view.name.toLowerCase() === tableName) {
        return view.columns;
      }
    }
  }

  return null;
}

/**
 * Simple matching paren finder that handles nested parentheses.
 * Returns -1 if no match found.
 */
function findMatchingParenSimple(text: string, openPos: number): number {
  let depth = 0;
  for (let i = openPos; i < text.length; i++) {
    if (text[i] === '(') {
      depth++;
    } else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Builds a CTE schema map from resolved CTE definitions.
 * Used by aliasResolver to look up CTE columns during alias-dot completion.
 *
 * Only includes CTEs that are available at the cursor position (from resolution.availableNames).
 * Maps null columns (SELECT *) to empty array for consistent consumer interface.
 *
 * @param resolution - The CTEResolutionResult from resolveChainedCTEs
 * @returns Map of lowercase CTE name → ColumnInfo[] (empty array for SELECT *)
 */
export function buildCTESchemaMap(
  resolution: CTEResolutionResult
): Map<string, ColumnInfo[]> {
  const result = new Map<string, ColumnInfo[]>();

  // Build a set of available CTE names (lowercase) for fast lookup
  const availableSet = new Set(
    resolution.availableNames.map(name => name.toLowerCase())
  );

  // Iterate over resolved schemas and include only those available at cursor position
  for (const [key, schema] of resolution.schemas) {
    const lowerKey = key.toLowerCase();

    // Only include CTEs that are available at the cursor position
    if (!availableSet.has(lowerKey)) {
      continue;
    }

    // Map null columns (SELECT *) to empty array; otherwise use the resolved columns directly
    result.set(lowerKey, schema.columns ?? []);
  }

  return result;
}

// --- Private Helper Functions ---

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
 * Applies the column name resolution rules:
 * 1. Explicit alias (AS name) → use alias name
 * 2. Dotted reference (table.column) → use last segment
 * 3. Simple identifier → use as-is
 * 4. Complex expression without alias → omit
 */
function parseSelectList(selectList: string): ColumnInfo[] {
  const columns: ColumnInfo[] = [];
  const items = splitSelectItems(selectList);

  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;

    // Check for alias.* or * pattern — return null for the whole CTE
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
 * Resolution rules (in priority order):
 * 1. Explicit alias: `expression AS alias` → alias
 * 2. Dotted reference: `table.column` → last segment (column)
 * 3. Simple identifier: `column` → column
 * 4. Complex expression without alias → null (omit)
 */
function extractColumnName(expression: string): string | null {
  const trimmed = expression.trim();
  if (!trimmed) return null;

  // Rule 1: Check for explicit AS alias: `... AS alias`
  const asMatch = /\bas\s+((?:\[[^\]]*\])|(?:[a-zA-Z_][a-zA-Z0-9_]*))\s*$/i.exec(trimmed);
  if (asMatch) {
    return stripBrackets(asMatch[1]);
  }

  // Rule 2: Check for dotted reference: `table.column` or `schema.table.column`
  // Must be a simple dotted identifier (no spaces, no operators)
  const dottedMatch = /^[\w\[\]]+(?:\.[\w\[\]]+)+$/.exec(trimmed);
  if (dottedMatch) {
    const parts = trimmed.split('.');
    return stripBrackets(parts[parts.length - 1]);
  }

  // Rule 3: Simple identifier (no dots, no operators, no parens)
  if (/^(?:\[[^\]]*\]|[a-zA-Z_][a-zA-Z0-9_]*)$/.test(trimmed)) {
    return stripBrackets(trimmed);
  }

  // Rule 4: Complex expression without alias → omit
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
