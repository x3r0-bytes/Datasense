/**
 * Object Reference Linter — Validates table/view/column references against the schema cache.
 *
 * This module implements Phase 3 of the T-SQL linting pipeline, checking that:
 * - Table and view names in FROM/JOIN clauses exist in the connected database's schema cache
 * - Column names in SELECT/WHERE/ON/GROUP BY/ORDER BY clauses exist on the referenced tables
 *
 * All diagnostics use Warning severity to distinguish from syntax errors.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9
 */

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { ISchemaCache, TableInfo, ViewInfo } from './schemaCache';

// ─── Public Interfaces ─────────────────────────────────────────────────────────

/**
 * Context passed to the object reference linter.
 * Mirrors the pattern of LinterContext used by linter.ts.
 */
export interface ObjectReferenceLinterContext {
  schemaCache: ISchemaCache;
  isConnected: boolean;
  isRefreshing: boolean;
}

// ─── Internal Data Structures ──────────────────────────────────────────────────

/**
 * Tracks a table alias and the underlying table it resolves to.
 */
export interface TableAlias {
  alias: string;      // The alias name (lowercased)
  schema: string;     // Resolved schema (lowercased)
  tableName: string;  // Resolved table name (lowercased)
}

/**
 * Represents the set of objects in scope for a query block.
 * Used to resolve column references during linting.
 */
export interface QueryScope {
  tables: TableAlias[];           // Concrete tables/views in scope (with their aliases)
  cteNames: Set<string>;          // CTE names defined with WITH ... AS (treat as valid)
  tempTables: Set<string>;        // #temp table names (treat as valid)
  derivedAliases: Set<string>;    // Derived table/subquery aliases (treat as valid)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strip SQL string literals and comments from text, preserving character positions
 * (replaced with spaces so offsets remain valid).
 */
function stripStringsAndComments(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    // Single-line comment
    if (text[i] === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') {
        result += ' ';
        i++;
      }
      continue;
    }
    // Block comment
    if (text[i] === '/' && text[i + 1] === '*') {
      result += ' ';
      i++;
      result += ' ';
      i++;
      while (i < text.length) {
        if (text[i] === '*' && text[i + 1] === '/') {
          result += ' ';
          i++;
          result += ' ';
          i++;
          break;
        }
        result += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }
    // N-prefixed string
    if ((text[i] === 'N' || text[i] === 'n') && text[i + 1] === "'") {
      result += ' ';
      i++;
      result += ' ';
      i++;
      while (i < text.length) {
        if (text[i] === "'") {
          result += ' ';
          i++;
          if (i < text.length && text[i] === "'") {
            result += ' ';
            i++;
          } else {
            break;
          }
        } else {
          result += text[i] === '\n' ? '\n' : ' ';
          i++;
        }
      }
      continue;
    }
    // String literal
    if (text[i] === "'") {
      result += ' ';
      i++;
      while (i < text.length) {
        if (text[i] === "'") {
          result += ' ';
          i++;
          if (i < text.length && text[i] === "'") {
            result += ' ';
            i++;
          } else {
            break;
          }
        } else {
          result += text[i] === '\n' ? '\n' : ' ';
          i++;
        }
      }
      continue;
    }
    result += text[i];
    i++;
  }
  return result;
}

/**
 * Get 0-based line and column from a character offset in text.
 */
function getPosition(text: string, offset: number): { line: number; col: number } {
  let line = 0;
  let col = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      col = 0;
    } else {
      col++;
    }
  }
  return { line, col };
}

/**
 * Get the paren nesting depth at a position in text.
 */
function getParenDepthAt(text: string, offset: number): number {
  let depth = 0;
  for (let i = 0; i < offset; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')') depth--;
  }
  return Math.max(0, depth);
}

/**
 * Strip bracket or double-quote delimiters from an identifier.
 * e.g. [MyTable] → MyTable, "dbo" → dbo
 */
function stripDelimiters(id: string): string {
  if ((id.startsWith('[') && id.endsWith(']')) ||
      (id.startsWith('"') && id.endsWith('"'))) {
    return id.slice(1, -1);
  }
  return id;
}

/**
 * Normalize an identifier: strip delimiters and lowercase.
 */
function normalizeId(id: string): string {
  return stripDelimiters(id).toLowerCase();
}

/**
 * Build a quick-lookup set of all table/view names from the schema cache.
 * Keys are "schema.name" in lowercase.
 */
function buildSchemaObjectSet(schemaCache: ISchemaCache): Set<string> {
  const set = new Set<string>();
  for (const t of schemaCache.tables) {
    set.add(`${t.schema.toLowerCase()}.${t.name.toLowerCase()}`);
  }
  for (const v of schemaCache.views) {
    set.add(`${v.schema.toLowerCase()}.${v.name.toLowerCase()}`);
  }
  return set;
}

/**
 * Attempt to resolve an unqualified table/view name against the schema cache.
 * Returns the schema it was found in (dbo first, then any other schema), or null.
 */
function resolveUnqualifiedName(
  nameLower: string,
  schemaCache: ISchemaCache
): string | null {
  // Try dbo first
  for (const t of schemaCache.tables) {
    if (t.schema.toLowerCase() === 'dbo' && t.name.toLowerCase() === nameLower) {
      return 'dbo';
    }
  }
  for (const v of schemaCache.views) {
    if (v.schema.toLowerCase() === 'dbo' && v.name.toLowerCase() === nameLower) {
      return 'dbo';
    }
  }
  // Then any other schema
  for (const t of schemaCache.tables) {
    if (t.name.toLowerCase() === nameLower) {
      return t.schema.toLowerCase();
    }
  }
  for (const v of schemaCache.views) {
    if (v.name.toLowerCase() === nameLower) {
      return v.schema.toLowerCase();
    }
  }
  return null;
}

/**
 * Get columns for a specific table/view (schema + name, both lowercased).
 * Returns null if the table/view is not in the cache.
 */
function getColumnsForTable(
  schemaLower: string,
  tableNameLower: string,
  schemaCache: ISchemaCache
): string[] | null {
  for (const t of schemaCache.tables) {
    if (t.schema.toLowerCase() === schemaLower && t.name.toLowerCase() === tableNameLower) {
      return t.columns.map(c => c.name.toLowerCase());
    }
  }
  for (const v of schemaCache.views) {
    if (v.schema.toLowerCase() === schemaLower && v.name.toLowerCase() === tableNameLower) {
      return v.columns.map(c => c.name.toLowerCase());
    }
  }
  return null;
}

/**
 * Parse CTE names defined at the top level of a batch.
 * Handles: WITH cteName AS (...), cteName2 AS (...), ...
 */
function parseCteNames(stripped: string): Set<string> {
  const cteNames = new Set<string>();

  // Match the WITH keyword followed by one or more CTE definitions at top level
  const withPattern = /\bWITH\s+([\w\[\]"]+)\s+AS\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = withPattern.exec(stripped)) !== null) {
    if (getParenDepthAt(stripped, match.index) === 0) {
      cteNames.add(normalizeId(match[1]));
    }
  }

  // Also handle subsequent CTEs after the first (comma-separated)
  // Pattern: ), cteName AS (
  const subsequentCtePattern = /\)\s*,\s*([\w\[\]"]+)\s+AS\s*\(/gi;
  while ((match = subsequentCtePattern.exec(stripped)) !== null) {
    cteNames.add(normalizeId(match[1]));
  }

  return cteNames;
}

/**
 * Parse FROM/JOIN table references and alias mappings in a single batch.
 * Returns: concrete table aliases (with resolved schema/table), derived aliases, temp tables.
 */
function parseFromJoinClauses(
  stripped: string,
  batchStartLine: number,
  schemaCache: ISchemaCache,
  schemaObjectSet: Set<string>,
  cteNames: Set<string>,
  diagnostics: Diagnostic[],
  originalText: string
): { tables: TableAlias[]; derivedAliases: Set<string>; tempTables: Set<string> } {
  const tables: TableAlias[] = [];
  const derivedAliases = new Set<string>();
  const tempTables = new Set<string>();

  // Pattern to match FROM/JOIN clauses followed by a table reference
  // Handles: FROM [schema.]table [AS] [alias], JOIN [schema.]table [AS] [alias]
  // Also handles subqueries as derived tables: FROM (...) [AS] alias
  // Also handles comma-separated tables: FROM TableA a, TableB b
  const fromJoinPattern = /\b(?:FROM|JOIN|INNER\s+JOIN|LEFT\s+(?:OUTER\s+)?JOIN|RIGHT\s+(?:OUTER\s+)?JOIN|FULL\s+(?:OUTER\s+)?JOIN|CROSS\s+JOIN|CROSS\s+APPLY|OUTER\s+APPLY)\s+/gi;

  let match: RegExpExecArray | null;
  while ((match = fromJoinPattern.exec(stripped)) !== null) {
    const depth = getParenDepthAt(stripped, match.index);
    if (depth !== 0) continue; // Skip FROM/JOIN inside subqueries for top-level scope

    const afterKeyword = stripped.substring(match.index + match[0].length);

    // Check for derived table/subquery: FROM (SELECT ...) AS alias
    if (afterKeyword.trimStart().startsWith('(')) {
      // Find the matching closing paren
      const openIdx = afterKeyword.indexOf('(');
      let parenDepth = 0;
      let closeIdx = -1;
      for (let i = openIdx; i < afterKeyword.length; i++) {
        if (afterKeyword[i] === '(') parenDepth++;
        if (afterKeyword[i] === ')') {
          parenDepth--;
          if (parenDepth === 0) {
            closeIdx = i;
            break;
          }
        }
      }
      if (closeIdx !== -1) {
        const afterParen = afterKeyword.substring(closeIdx + 1).trimStart();
        const aliasMatch = afterParen.match(/^(?:AS\s+)?([\w\[\]"]+)/i);
        if (aliasMatch) {
          derivedAliases.add(normalizeId(aliasMatch[1]));
        }
      }
      continue;
    }

    // Match a table reference: optional database.schema.table, schema.table, or just table
    // Followed by optional alias
    const tableRefPattern = /^([\w\[\]"]+)(?:\.([\w\[\]"]+)(?:\.([\w\[\]"]+))?)?/;
    const tableRefMatch = afterKeyword.trimStart().match(tableRefPattern);
    if (!tableRefMatch) continue;

    const part1 = normalizeId(tableRefMatch[1]);
    const part2 = tableRefMatch[2] ? normalizeId(tableRefMatch[2]) : null;
    const part3 = tableRefMatch[3] ? normalizeId(tableRefMatch[3]) : null;

    // Temp tables start with #
    if (part1.startsWith('#')) {
      tempTables.add(part1);
      // Parse alias if present
      const afterRef = afterKeyword.trimStart().substring(tableRefMatch[0].length).trimStart();
      const aliasMatch = afterRef.match(/^(?:AS\s+)?([\w\[\]"]+)/i);
      if (aliasMatch) {
        const aliasLower = normalizeId(aliasMatch[1]);
        if (!SQL_RESERVED_WORDS.has(aliasLower)) {
          tempTables.add(aliasLower); // treat alias as also valid
        }
      }
      continue;
    }

    // Three-part name: database.schema.object
    if (part3 !== null && part2 !== null) {
      const database = part1;
      const schema = part2;
      const tableName = part3;

      // Check if this database is in the cache; if not, skip silently
      const allTablesAndViews = [...schemaCache.tables, ...schemaCache.views];
      const dbInCache = allTablesAndViews.some(
        obj => obj.schema.toLowerCase() !== '' // We check via the schemaObjectSet
      );
      // Use a simpler check: if schemaObjectSet has ANY entry for this schema, the DB is in cache
      // Since schemaCache represents a single database, treat any 3-part name as "might be external"
      // The spec says: skip silently if database not in active cache.
      // Since we only have one active database cache, we consider 3-part names as possibly external.
      // We can check by looking for schema.tableName in the set - if found it's the same DB, otherwise skip.
      const key = `${schema}.${tableName}`;
      if (!schemaObjectSet.has(key)) {
        // Not in active cache - could be another database, skip silently
        // Still track the alias for column validation purposes
        const afterRef = afterKeyword.trimStart().substring(tableRefMatch[0].length).trimStart();
        const aliasMatch = afterRef.match(/^(?:AS\s+)?([\w\[\]"]+)/i);
        const aliasLower = aliasMatch && !SQL_RESERVED_WORDS.has(normalizeId(aliasMatch[1]))
          ? normalizeId(aliasMatch[1])
          : tableName;
        // Add as a derived alias so column validation is skipped for this
        derivedAliases.add(aliasLower);
        continue;
      }
      // Found in active cache, register the table
      const afterRef = afterKeyword.trimStart().substring(tableRefMatch[0].length).trimStart();
      const aliasMatch = afterRef.match(/^(?:AS\s+)?([\w\[\]"]+)/i);
      const aliasLower = aliasMatch && !SQL_RESERVED_WORDS.has(normalizeId(aliasMatch[1]))
        ? normalizeId(aliasMatch[1])
        : tableName;
      tables.push({ alias: aliasLower, schema, tableName });
      continue;
    }

    // Two-part name: schema.object
    if (part2 !== null) {
      const schema = part1;
      const tableName = part2;
      const key = `${schema}.${tableName}`;

      // Skip CTE names used as table source
      if (cteNames.has(tableName) || cteNames.has(schema)) continue;

      // Get the offset in original stripped text for the identifier
      const trimmedOffset = afterKeyword.length - afterKeyword.trimStart().length;
      const refOffset = match.index + match[0].length + trimmedOffset;

      if (!schemaObjectSet.has(key)) {
        // Not found with specified schema — emit warning
        const pos = getPosition(originalText, refOffset);
        const identLen = tableRefMatch[0].length;
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          range: {
            start: { line: pos.line + batchStartLine, character: pos.col },
            end: { line: pos.line + batchStartLine, character: pos.col + identLen },
          },
          message: `Object '${stripDelimiters(tableRefMatch[1])}.${stripDelimiters(tableRefMatch[2] || '')}' is not recognized in the schema cache.`,
          source: 'tsql-lint',
          code: 'ORL001',
        });
      } else {
        // Found — parse alias
        const afterRef = afterKeyword.trimStart().substring(tableRefMatch[0].length).trimStart();
        const aliasMatch = afterRef.match(/^(?:AS\s+)?([\w\[\]"]+)/i);
        const aliasLower = aliasMatch && !SQL_RESERVED_WORDS.has(normalizeId(aliasMatch[1]))
          ? normalizeId(aliasMatch[1])
          : tableName;
        tables.push({ alias: aliasLower, schema, tableName });
      }
      continue;
    }

    // Unqualified name: just the table name
    const tableName = part1;

    // Skip keywords that follow FROM/JOIN (e.g. FROM OPENROWSET, FROM VALUES)
    if (SQL_RESERVED_WORDS.has(tableName)) continue;

    // Skip CTE names
    if (cteNames.has(tableName)) continue;

    // Temp tables already handled above via #prefix check
    if (tableName.startsWith('#')) {
      tempTables.add(tableName);
      continue;
    }

    // Resolve against dbo first, then any schema
    const resolvedSchema = resolveUnqualifiedName(tableName, schemaCache);

    const trimmedOffset = afterKeyword.length - afterKeyword.trimStart().length;
    const refOffset = match.index + match[0].length + trimmedOffset;

    if (resolvedSchema === null) {
      // Not found — emit warning
      const pos = getPosition(originalText, refOffset);
      const identLen = tableRefMatch[0].length;
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range: {
          start: { line: pos.line + batchStartLine, character: pos.col },
          end: { line: pos.line + batchStartLine, character: pos.col + identLen },
        },
        message: `Object '${stripDelimiters(tableRefMatch[1])}' is not recognized in the schema cache.`,
        source: 'tsql-lint',
        code: 'ORL001',
      });
    } else {
      // Found — parse alias
      const afterRef = afterKeyword.trimStart().substring(tableRefMatch[0].length).trimStart();
      const aliasMatch = afterRef.match(/^(?:AS\s+)?([\w\[\]"]+)/i);
      const aliasLower = aliasMatch && !SQL_RESERVED_WORDS.has(normalizeId(aliasMatch[1]))
        ? normalizeId(aliasMatch[1])
        : tableName;
      tables.push({ alias: aliasLower, schema: resolvedSchema, tableName });
    }
  }

  // Handle comma-separated tables in FROM clauses.
  // After the first table in FROM, additional tables are separated by commas.
  // Pattern: , [schema.]table [AS] alias (at paren depth 0, between FROM and the next major clause)
  const commaTablePattern = /,\s*([\w\[\]"]+)(?:\.([\w\[\]"]+)(?:\.([\w\[\]"]+))?)?\s*/g;
  // Find each FROM clause and scan for comma-separated tables within it
  const fromOnlyPattern = /\bFROM\s+/gi;
  let fromMatch: RegExpExecArray | null;
  while ((fromMatch = fromOnlyPattern.exec(stripped)) !== null) {
    if (getParenDepthAt(stripped, fromMatch.index) !== 0) continue;
    // Find the end of the FROM clause (next major keyword at depth 0)
    const fromClauseEnd = stripped.substring(fromMatch.index + fromMatch[0].length);
    const endMatch = fromClauseEnd.match(/\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|INNER\s+JOIN|LEFT\s+(?:OUTER\s+)?JOIN|RIGHT\s+(?:OUTER\s+)?JOIN|FULL\s+(?:OUTER\s+)?JOIN|CROSS\s+JOIN|CROSS\s+APPLY|OUTER\s+APPLY|JOIN|UNION|EXCEPT|INTERSECT|SET|;)\b/i);
    const fromClauseText = endMatch
      ? fromClauseEnd.substring(0, endMatch.index)
      : fromClauseEnd;

    // Skip the first table reference (already handled by the main loop above)
    // Look for comma-separated additional table references
    commaTablePattern.lastIndex = 0;
    let commaMatch: RegExpExecArray | null;
    while ((commaMatch = commaTablePattern.exec(fromClauseText)) !== null) {
      const cPart1 = normalizeId(commaMatch[1]);
      const cPart2 = commaMatch[2] ? normalizeId(commaMatch[2]) : null;
      const cPart3 = commaMatch[3] ? normalizeId(commaMatch[3]) : null;

      if (SQL_RESERVED_WORDS.has(cPart1)) continue;
      if (cteNames.has(cPart1)) continue;
      if (cPart1.startsWith('#')) { tempTables.add(cPart1); continue; }

      // Determine schema and table name
      let ctSchema: string | null = null;
      let ctTableName: string;
      if (cPart3 !== null && cPart2 !== null) {
        // Three-part: database.schema.table
        ctSchema = cPart2;
        ctTableName = cPart3;
      } else if (cPart2 !== null) {
        // Two-part: schema.table
        ctSchema = cPart1;
        ctTableName = cPart2;
      } else {
        // One-part: table
        ctTableName = cPart1;
        ctSchema = resolveUnqualifiedName(cPart1, schemaCache);
      }

      if (ctSchema === null) continue; // not found, skip silently for comma tables

      // Parse alias: text after the full comma table reference
      const afterCommaRef = fromClauseText.substring(commaMatch.index + commaMatch[0].length);
      const aliasAfterComma = afterCommaRef.match(/^(?:AS\s+)?([\w\[\]"]+)/i);
      const ctAlias = aliasAfterComma && !SQL_RESERVED_WORDS.has(normalizeId(aliasAfterComma[1]))
        ? normalizeId(aliasAfterComma[1])
        : ctTableName;

      const ctKey = `${ctSchema}.${ctTableName}`;
      if (schemaObjectSet.has(ctKey)) {
        tables.push({ alias: ctAlias, schema: ctSchema, tableName: ctTableName });
      } else {
        derivedAliases.add(ctAlias);
      }
    }
  }

  // Also handle UPDATE/DELETE target aliases (e.g., UPDATE a SET ... FROM Table a)
  // These aliases reference a table defined later in the FROM clause.
  // Since we already parsed FROM tables above, just register any UPDATE/DELETE targets
  // as derived aliases to prevent false positives during column validation.
  const updateTargetPattern = /\bUPDATE\s+([\w\[\]"]+)\s+SET\b/gi;
  let utMatch: RegExpExecArray | null;
  while ((utMatch = updateTargetPattern.exec(stripped)) !== null) {
    if (getParenDepthAt(stripped, utMatch.index) !== 0) continue;
    const target = normalizeId(utMatch[1]);
    if (!SQL_RESERVED_WORDS.has(target)) {
      derivedAliases.add(target);
    }
  }
  const deleteTargetPattern = /\bDELETE\s+([\w\[\]"]+)\s+(?:FROM|WHERE|OUTPUT)\b/gi;
  let dtMatch: RegExpExecArray | null;
  while ((dtMatch = deleteTargetPattern.exec(stripped)) !== null) {
    if (getParenDepthAt(stripped, dtMatch.index) !== 0) continue;
    const target = normalizeId(dtMatch[1]);
    if (!SQL_RESERVED_WORDS.has(target) && target !== 'top') {
      derivedAliases.add(target);
    }
  }

  return { tables, derivedAliases, tempTables };
}

/**
 * Parse and validate column references in SELECT/WHERE/ON/GROUP BY/ORDER BY clauses.
 * Produces Warning diagnostics for columns not found on any in-scope table.
 */
function parseAndValidateColumns(
  stripped: string,
  batchStartLine: number,
  scope: QueryScope,
  schemaCache: ISchemaCache,
  diagnostics: Diagnostic[],
  originalText: string
): void {
  // If there are no concrete tables in scope (all CTEs/temp/derived), skip column validation
  if (scope.tables.length === 0) return;

  // Build a map of alias -> column set for fast lookup
  const aliasToColumns = new Map<string, string[]>();
  // Also track all known aliases (even ones without column data) to avoid false positives
  const knownAliases = new Set<string>();
  for (const ta of scope.tables) {
    knownAliases.add(ta.alias);
    knownAliases.add(ta.tableName);
    const cols = getColumnsForTable(ta.schema, ta.tableName, schemaCache);
    if (cols !== null) {
      aliasToColumns.set(ta.alias, cols);
      // Also register the table name itself as a "self-alias"
      aliasToColumns.set(ta.tableName, cols);
    }
  }

  // Build a set of all valid column names across all in-scope tables (for unqualified refs)
  const allValidColumns = new Set<string>();
  for (const cols of aliasToColumns.values()) {
    for (const col of cols) {
      allValidColumns.add(col);
    }
  }

  // Find column references in SQL clauses:
  // We look for identifier tokens in SELECT list, WHERE, ON, GROUP BY, ORDER BY
  // Column references can be:
  //  1. alias.column (qualified)
  //  2. bare_column (unqualified)
  // We must skip table references (already validated in FROM/JOIN pass)

  // Extract clause regions to scan for column references
  // We'll process each clause independently

  // SELECT clause: from SELECT to FROM (at the same paren depth)
  // WHERE clause: from WHERE to next major keyword
  // ON clause: from ON to JOIN/WHERE/GROUP/ORDER/HAVING/UNION/END-OF-STMT
  // GROUP BY: from GROUP BY to HAVING/ORDER/UNION/END-OF-STMT
  // ORDER BY: from ORDER BY to end of statement

  const clausePatterns = [
    { name: 'SELECT', pattern: /\bSELECT\b/gi, endPattern: /\b(?:FROM|INTO)\b/i },
    { name: 'WHERE',  pattern: /\bWHERE\b/gi,  endPattern: /\b(?:GROUP\s+BY|ORDER\s+BY|HAVING|UNION|EXCEPT|INTERSECT|EXEC|EXECUTE|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|DECLARE|IF|WHILE|BEGIN|RETURN|PRINT|GO)\b/i },
    { name: 'ON',     pattern: /\bON\b/gi,      endPattern: /\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|INNER|LEFT|RIGHT|FULL|CROSS|OUTER|JOIN|UNION|EXCEPT|INTERSECT|EXEC|EXECUTE|SELECT|INSERT|UPDATE|DELETE)\b/i },
    { name: 'GROUP BY', pattern: /\bGROUP\s+BY\b/gi, endPattern: /\b(?:HAVING|ORDER\s+BY|UNION|EXCEPT|INTERSECT|EXEC|EXECUTE|SELECT|INSERT|UPDATE|DELETE)\b/i },
    { name: 'ORDER BY', pattern: /\bORDER\s+BY\b/gi, endPattern: /\b(?:OPTION|UNION|EXCEPT|INTERSECT|EXEC|EXECUTE|SELECT|INSERT|UPDATE|DELETE)\b/i },
    { name: 'HAVING', pattern: /\bHAVING\b/gi,   endPattern: /\b(?:ORDER\s+BY|UNION|EXCEPT|INTERSECT|EXEC|EXECUTE|SELECT|INSERT|UPDATE|DELETE)\b/i },
  ];

  for (const clauseDef of clausePatterns) {
    clauseDef.pattern.lastIndex = 0;
    let clauseMatch: RegExpExecArray | null;

    while ((clauseMatch = clauseDef.pattern.exec(stripped)) !== null) {
      // Only validate top-level clauses
      if (getParenDepthAt(stripped, clauseMatch.index) !== 0) continue;

      const clauseStart = clauseMatch.index + clauseMatch[0].length;
      let clauseText = stripped.substring(clauseStart);

      // Find the end of this clause
      const endMatch = clauseDef.endPattern.exec(clauseText);
      if (endMatch) {
        clauseText = clauseText.substring(0, endMatch.index);
      }

      // Scan clause text for identifier tokens, skipping function names and keywords
      validateColumnRefsInClause(
        clauseText,
        clauseStart,
        batchStartLine,
        scope,
        aliasToColumns,
        allValidColumns,
        knownAliases,
        schemaCache,
        diagnostics,
        originalText,
        clauseDef.name === 'SELECT'
      );
    }
  }
}

/**
 * Validate column references within a single clause segment.
 */
function validateColumnRefsInClause(
  clauseText: string,
  clauseOffset: number,
  batchStartLine: number,
  scope: QueryScope,
  aliasToColumns: Map<string, string[]>,
  allValidColumns: Set<string>,
  knownAliases: Set<string>,
  schemaCache: ISchemaCache,
  diagnostics: Diagnostic[],
  originalText: string,
  isSelectClause: boolean
): void {
  // Token pattern: identifier optionally followed by dot-separated parts (up to 4 parts)
  // Captures: part1.part2.part3.part4, part1.part2.part3, part1.part2, or bare part1
  // This handles: database.schema.table.column, database.schema.table, alias.column, bare column
  const tokenPattern = /([\w\[\]"]+)(?:\.([\w\[\]"*]+)(?:\.([\w\[\]"*]+)(?:\.([\w\[\]"*]+))?)?)?/g;
  let tokenMatch: RegExpExecArray | null;

  while ((tokenMatch = tokenPattern.exec(clauseText)) !== null) {
    const rawPart1 = tokenMatch[1];
    const rawPart2 = tokenMatch[2];
    const rawPart3 = tokenMatch[3];
    const rawPart4 = tokenMatch[4];

    const part1 = normalizeId(rawPart1);
    const part2 = rawPart2 ? normalizeId(rawPart2) : null;
    const part3 = rawPart3 ? normalizeId(rawPart3) : null;
    const part4 = rawPart4 ? normalizeId(rawPart4) : null;

    // Four-part name (database.schema.table.column) — skip entirely
    if (part4 !== null) continue;

    // Three-part name (database.schema.object or database.schema.column) — skip entirely
    // The linter cannot validate cross-database references without a multi-database cache
    if (part3 !== null) continue;

    // Skip SQL keywords and common non-column tokens
    if (SQL_RESERVED_WORDS.has(part1)) continue;
    if (AGGREGATE_AND_FUNCTION_NAMES.has(part1)) continue;

    // Skip numeric literals (starts with digit)
    if (/^\d/.test(part1)) continue;

    // Skip * (SELECT * is valid)
    if (part1 === '*') continue;

    // Check what follows this token to detect function calls
    const afterToken = clauseText.substring(tokenMatch.index + tokenMatch[0].length).trimStart();
    const isFunctionCall = afterToken.startsWith('(');

    if (isFunctionCall) {
      // This is a function name, skip it
      continue;
    }

    const tokenAbsOffset = clauseOffset + tokenMatch.index;

    if (part2 !== null) {
      // alias.column qualified reference
      if (part2 === '*') continue; // alias.* is always valid

      const aliasLower = part1;

      // Check if the alias is a known table name, alias, CTE, temp, or derived
      if (scope.cteNames.has(aliasLower) ||
          scope.tempTables.has(aliasLower) ||
          scope.derivedAliases.has(aliasLower)) {
        // Skip validation for CTEs/temp/derived table column references
        continue;
      }

      // Check if it's a column of a known table (the alias might be the schema name in a two-part table name)
      const isKnownAlias = aliasToColumns.has(aliasLower);
      if (!isKnownAlias) {
        // Check if it's a known alias without column data (table exists but columns not cached)
        if (knownAliases.has(aliasLower)) continue;

        // Check if it's any known schema name from the cache (then it's a schema.table.col pattern
        // which we don't validate at the column level)
        const isSchemaName = schemaCache.tables.some(t => t.schema.toLowerCase() === aliasLower) ||
                             schemaCache.views.some(v => v.schema.toLowerCase() === aliasLower);
        if (isSchemaName) continue; // schema.object reference, skip

        // Unknown alias, skip column validation (table may already be flagged)
        continue;
      }

      // Validate the column against the resolved table
      const tableColumns = aliasToColumns.get(aliasLower);
      if (tableColumns && !tableColumns.includes(part2)) {
        // Column not found on the table this alias refers to
        const pos = getPosition(originalText, tokenAbsOffset);
        const fullTokenLen = tokenMatch[0].length;
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          range: {
            start: { line: pos.line + batchStartLine, character: pos.col },
            end: { line: pos.line + batchStartLine, character: pos.col + fullTokenLen },
          },
          message: `Column '${stripDelimiters(rawPart2 || '')}' is not recognized on '${stripDelimiters(rawPart1)}'.`,
          source: 'tsql-lint',
          code: 'ORL002',
        });
      }
    } else {
      // Bare column reference (unqualified)

      // In SELECT clause, a bare identifier could be an alias being defined; skip if followed by AS
      // or if it appears to be a column alias itself
      if (isSelectClause) {
        // If the previous token was AS, this is an alias name, skip
        const beforeToken = clauseText.substring(0, tokenMatch.index).trimEnd();
        if (/\bAS\s*$/i.test(beforeToken)) continue;
      }

      // Skip if it's a known alias name (table or alias reference itself)
      if (aliasToColumns.has(part1)) continue;
      if (knownAliases.has(part1)) continue;

      // Skip if it's in scope as CTE, temp, derived
      if (scope.cteNames.has(part1) ||
          scope.tempTables.has(part1) ||
          scope.derivedAliases.has(part1)) {
        continue;
      }

      // Skip schema names
      const isSchemaName = schemaCache.tables.some(t => t.schema.toLowerCase() === part1) ||
                           schemaCache.views.some(v => v.schema.toLowerCase() === part1);
      if (isSchemaName) continue;

      // Check if column exists on any in-scope table
      if (!allValidColumns.has(part1)) {
        const pos = getPosition(originalText, tokenAbsOffset);
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          range: {
            start: { line: pos.line + batchStartLine, character: pos.col },
            end: { line: pos.line + batchStartLine, character: pos.col + rawPart1.length },
          },
          message: `Column '${stripDelimiters(rawPart1)}' is not recognized on any table in scope.`,
          source: 'tsql-lint',
          code: 'ORL002',
        });
      }
    }
  }
}

// ─── SQL Reserved Words & Common Tokens ───────────────────────────────────────

/**
 * Common T-SQL reserved words that should NOT be treated as column references.
 * This is a sufficient (not exhaustive) set for false-positive prevention.
 */
const SQL_RESERVED_WORDS = new Set<string>([
  'select', 'from', 'where', 'join', 'inner', 'left', 'right', 'full', 'outer',
  'cross', 'on', 'and', 'or', 'not', 'in', 'is', 'null', 'like', 'between',
  'exists', 'all', 'any', 'some', 'case', 'when', 'then', 'else', 'end',
  'as', 'by', 'group', 'order', 'having', 'union', 'except', 'intersect',
  'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'alter',
  'drop', 'table', 'view', 'index', 'procedure', 'function', 'trigger',
  'with', 'cte', 'distinct', 'top', 'offset', 'fetch', 'next', 'rows', 'only',
  'asc', 'desc', 'go', 'begin', 'commit', 'rollback', 'transaction', 'tran',
  'exec', 'execute', 'declare', 'print', 'return', 'if', 'else', 'while',
  'break', 'continue', 'try', 'catch', 'throw', 'raiserror', 'use',
  'primary', 'key', 'foreign', 'references', 'constraint', 'default', 'unique',
  'check', 'identity', 'null', 'notnull', 'apply', 'pivot', 'unpivot',
  'over', 'partition', 'rows', 'range', 'unbounded', 'preceding', 'following',
  'current', 'row', 'output', 'inserted', 'deleted', 'merge', 'matched',
  'using', 'target', 'source', 'option', 'recompile', 'nolock', 'readpast',
  'updlock', 'holdlock', 'tablock', 'rowlock', 'paglock', 'with',
  'true', 'false', 'unknown', 'new', 'var', 'let', 'const',
]);

/**
 * Common aggregate and scalar function names that should not be validated as columns.
 */
const AGGREGATE_AND_FUNCTION_NAMES = new Set<string>([
  'count', 'sum', 'avg', 'min', 'max', 'stdev', 'stdevp', 'var', 'varp',
  'len', 'ltrim', 'rtrim', 'trim', 'upper', 'lower', 'substring', 'charindex',
  'replace', 'stuff', 'left', 'right', 'reverse', 'str', 'char', 'ascii',
  'unicode', 'nchar', 'patindex', 'space', 'replicate', 'format',
  'cast', 'convert', 'try_cast', 'try_convert', 'parse', 'try_parse',
  'isnull', 'coalesce', 'nullif', 'iif', 'choose',
  'getdate', 'getutcdate', 'sysdatetime', 'sysdatetimeoffset', 'sysutcdatetime',
  'dateadd', 'datediff', 'datename', 'datepart', 'year', 'month', 'day',
  'eomonth', 'switchoffset', 'todatetimeoffset', 'isdate',
  'abs', 'ceiling', 'floor', 'round', 'sign', 'sqrt', 'power', 'log', 'exp',
  'pi', 'rand', 'square',
  'row_number', 'rank', 'dense_rank', 'ntile', 'lag', 'lead', 'first_value', 'last_value',
  'newid', 'newsequentialid', 'scope_identity', 'ident_current', 'ident_incr', 'ident_seed',
  'db_name', 'db_id', 'object_id', 'object_name', 'schema_name', 'schema_id',
  'col_name', 'col_length', 'columnproperty', 'typeproperty',
  'host_name', 'app_name', 'current_user', 'user_name', 'system_user', 'suser_name',
  'has_dbaccess', 'is_member', 'is_rolemember', 'permissions',
  'isjson', 'json_value', 'json_query', 'json_modify', 'openjson',
  'string_agg', 'string_split', 'trim', 'concat', 'concat_ws',
  'compress', 'decompress', 'hashbytes', 'pwdencrypt', 'pwdcompare',
  'error_number', 'error_message', 'error_severity', 'error_state', 'error_line', 'error_procedure',
  'xact_state', 'trancount', '@@trancount', '@@rowcount', '@@error',
  'openquery', 'openrowset', 'opendatasource',
  'exists', 'contains', 'freetext', 'containstable', 'freetexttable',
]);

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Validate object references (tables, views, columns) in a SQL batch against the schema cache.
 *
 * Returns Warning-severity diagnostics for:
 * - Table/view names in FROM/JOIN that don't exist in the schema cache
 * - Column names in SELECT/WHERE/ON/GROUP BY/ORDER BY that don't exist on any in-scope table
 *
 * Returns [] immediately if:
 * - Not connected
 * - Schema cache is empty (no tables AND no views)
 * - Schema cache is currently refreshing (isRefreshing)
 *
 * @param text           The SQL batch text to lint
 * @param batchStartLine The 0-based line offset for this batch within the full document
 * @param context        Connection state and schema cache reference
 */
export function lintObjectReferences(
  text: string,
  batchStartLine: number,
  context: ObjectReferenceLinterContext
): Diagnostic[] {
  // Requirement 5.5: Skip entirely when disconnected, cache empty, or refreshing
  if (!context.isConnected) return [];
  if (context.isRefreshing) return [];
  if (context.schemaCache.tables.length === 0 && context.schemaCache.views.length === 0) return [];

  const diagnostics: Diagnostic[] = [];
  const { schemaCache } = context;

  // Pre-build a fast lookup set for all known schema objects
  const schemaObjectSet = buildSchemaObjectSet(schemaCache);

  // Strip strings/comments from text for parsing (positions preserved)
  const stripped = stripStringsAndComments(text);

  // Step 1: Parse CTE names so we don't flag them as unknown tables
  // Requirement 5.7: CTE names are treated as valid
  const cteNames = parseCteNames(stripped);

  // Step 2: Parse FROM/JOIN clauses to build the query scope
  const { tables, derivedAliases, tempTables } = parseFromJoinClauses(
    stripped,
    batchStartLine,
    schemaCache,
    schemaObjectSet,
    cteNames,
    diagnostics,
    text
  );

  // Build the full QueryScope
  const scope: QueryScope = {
    tables,
    cteNames,
    tempTables,
    derivedAliases,
  };

  // Step 3: Validate column references in SELECT/WHERE/ON/GROUP BY/ORDER BY
  // Requirement 5.3, 5.4: Validate column references
  // Only run if we have tables in scope (otherwise, all columns would flag)
  if (scope.tables.length > 0) {
    parseAndValidateColumns(stripped, batchStartLine, scope, schemaCache, diagnostics, text);
  }

  return diagnostics;
}
