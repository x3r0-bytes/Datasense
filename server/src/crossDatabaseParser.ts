/**
 * Cross-Database Parser — Detects multi-part name references (three-part names)
 * in T-SQL text for cross-database IntelliSense completions.
 *
 * Handles patterns like:
 * - DatabaseName.SchemaName.ObjectName
 * - [DatabaseName].[SchemaName].[ObjectName]
 * - Mixed bracket/unquoted combinations
 */

import { IMultiDatabaseCache } from './multiDatabaseCache';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface CrossDatabaseReference {
  /** The database name (unbracketed) */
  database: string;
  /** The schema name if present (unbracketed) */
  schema?: string;
  /** The object name if present (unbracketed) */
  object?: string;
  /** Whether the reference is incomplete (has trailing dot suggesting completions) */
  isIncomplete: boolean;
  /** What completions should be offered */
  completionTarget: 'schemas' | 'objects' | 'columns';
}

export interface CrossDatabaseTableReference {
  database?: string;
  schema: string;
  name: string;
  alias?: string;
}

// ─── Identifier Utilities ─────────────────────────────────────────────────────

/**
 * Strips bracket quotes from a SQL Server identifier.
 * "[MyDB]" → "MyDB", "MyDB" → "MyDB", "[]" → ""
 */
export function unquoteIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// ─── Cross-Database Reference Detection ───────────────────────────────────────

/**
 * Regex pattern for a single SQL Server identifier (bracketed or unquoted).
 * - Bracketed: \[[^\]]*\]
 * - Unquoted: [a-zA-Z_#@][a-zA-Z0-9_#@$]*
 */
const IDENT_PATTERN = String.raw`(?:\[[^\]]*\]|[a-zA-Z_#@][a-zA-Z0-9_#@$]*)`;

/**
 * Parses the text immediately before the cursor to detect a cross-database
 * reference pattern. Handles bracket-quoted and unquoted identifiers.
 *
 * Patterns detected:
 * - `DatabaseName.` → completionTarget: 'schemas'
 * - `DatabaseName.SchemaName.` → completionTarget: 'objects'
 * - `DatabaseName.SchemaName.ObjectName` (complete) → completionTarget: 'columns'
 *
 * Ambiguity resolution (Requirement 2.3):
 * When a two-part prefix like `Sales.` could be either `DatabaseName.` or `SchemaName.`,
 * the parser checks `multiDbCache.hasDatabase('Sales')`. If the name exists in the
 * multi-database cache, treat as database qualifier. Otherwise return null (let
 * standard schema resolution handle it).
 */
export function detectCrossDatabaseReference(
  textBeforeCursor: string,
  multiDbCache: IMultiDatabaseCache
): CrossDatabaseReference | null {
  // Detection order (most specific first):
  // 1. Four-part with trailing dot: Database.Schema.Object. → completionTarget: 'columns'
  // 2. Three-part complete (no trailing dot): Database.Schema.Object → completionTarget: 'columns'
  // 3. Two-part with trailing dot: Database.Schema. → completionTarget: 'objects'
  // 4. One-part with trailing dot: Database. → completionTarget: 'schemas'

  // Negative lookbehind to ensure the first identifier is properly anchored — must NOT be
  // preceded by identifier characters. This prevents SQL keywords (FROM, JOIN, SELECT)
  // from being captured as part of the database identifier when they directly abut it
  // without whitespace. Bracket-quoted identifiers (starting with [) are inherently safe
  // since [ is not an identifier char, but unquoted identifiers need this boundary check.
  const ANCHOR = String.raw`(?<![a-zA-Z0-9_#@$])`;

  // Pattern: four-part with trailing dot: Database.Schema.Object.
  // Supports bracket-quoted identifiers with spaces/special chars (e.g., [My Database].[dbo].[Users].)
  const fourPartDotRegex = new RegExp(
    `${ANCHOR}(${IDENT_PATTERN})\\.(${IDENT_PATTERN})\\.(${IDENT_PATTERN})\\.$`
  );

  // Pattern: three-part complete reference (no trailing dot)
  // DatabaseName.SchemaName.ObjectName at end of text (not followed by dot)
  const threePartCompleteRegex = new RegExp(
    `${ANCHOR}(${IDENT_PATTERN})\\.(${IDENT_PATTERN})\\.(${IDENT_PATTERN})$`
  );

  // Pattern: two-part with trailing dot: Database.Schema.
  // Supports bracket-quoted identifiers with spaces/special chars (e.g., [My Database].[dbo].)
  const twoPartDotRegex = new RegExp(
    `${ANCHOR}(${IDENT_PATTERN})\\.(${IDENT_PATTERN})\\.$`
  );

  // Pattern: one-part with trailing dot: Database.
  // Supports bracket-quoted identifiers with spaces/special chars (e.g., [My Database].)
  const onePartDotRegex = new RegExp(
    `${ANCHOR}(${IDENT_PATTERN})\\.$`
  );

  // Check four-part with trailing dot (Database.Schema.Object.) — column completions
  const fourPartMatch = textBeforeCursor.match(fourPartDotRegex);
  if (fourPartMatch) {
    const database = unquoteIdentifier(fourPartMatch[1]);
    const schema = unquoteIdentifier(fourPartMatch[2]);
    const object = unquoteIdentifier(fourPartMatch[3]);

    // Only treat as cross-database if the first part is a known database
    if (multiDbCache.hasDatabase(database)) {
      return {
        database,
        schema,
        object,
        isIncomplete: true,
        completionTarget: 'columns',
      };
    }
  }

  // Check three-part complete (Database.Schema.Object) — no trailing dot
  const threePartMatch = textBeforeCursor.match(threePartCompleteRegex);
  if (threePartMatch) {
    const database = unquoteIdentifier(threePartMatch[1]);
    const schema = unquoteIdentifier(threePartMatch[2]);
    const object = unquoteIdentifier(threePartMatch[3]);

    // Only treat as cross-database if the first part is a known database
    if (multiDbCache.hasDatabase(database)) {
      return {
        database,
        schema,
        object,
        isIncomplete: false,
        completionTarget: 'columns',
      };
    }
  }

  // Check two-part with trailing dot (Database.Schema.)
  const twoPartMatch = textBeforeCursor.match(twoPartDotRegex);
  if (twoPartMatch) {
    const firstPart = unquoteIdentifier(twoPartMatch[1]);
    const secondPart = unquoteIdentifier(twoPartMatch[2]);

    // Ambiguity resolution: is firstPart a database or a schema?
    if (multiDbCache.hasDatabase(firstPart)) {
      // Treat as Database.Schema. → offer objects (tables/views)
      return {
        database: firstPart,
        schema: secondPart,
        isIncomplete: true,
        completionTarget: 'objects',
      };
    }
    // If not a known database, this is Schema.Object. — not a cross-database ref
    return null;
  }

  // Check one-part with trailing dot (Database.)
  const onePartMatch = textBeforeCursor.match(onePartDotRegex);
  if (onePartMatch) {
    const name = unquoteIdentifier(onePartMatch[1]);

    // Ambiguity resolution (Requirement 2.3):
    // If the name exists in the multi-database cache, treat as database qualifier.
    // Otherwise, it's likely a schema qualifier — not our concern.
    if (multiDbCache.hasDatabase(name)) {
      return {
        database: name,
        isIncomplete: true,
        completionTarget: 'schemas',
      };
    }
    // Not a known database — let standard schema resolution handle it
    return null;
  }

  return null;
}

// ─── Cross-Database Table Reference Extraction ────────────────────────────────

/**
 * Extracts table references from FROM/JOIN clauses, including three-part names.
 * Returns table references with database, schema, name, and alias.
 *
 * Handles patterns:
 * - FROM [DB].[Schema].[Table] AS alias
 * - FROM DB.Schema.Table alias
 * - JOIN [DB].[Schema].[Table] ON ...
 * - Mixed bracket and unquoted identifiers
 */
export function extractCrossDatabaseTableRefs(
  statementText: string
): CrossDatabaseTableReference[] {
  const references: CrossDatabaseTableReference[] = [];

  // Strip string literals and comments to avoid false matches
  const cleaned = stripLiteralsAndComments(statementText);

  // Match FROM and JOIN keywords to find table reference positions
  const clauseRegex = /\b(?:from|(?:inner\s+)?join|left\s+(?:outer\s+)?join|right\s+(?:outer\s+)?join|full\s+(?:outer\s+)?join|cross\s+join)\b/gi;

  let clauseMatch: RegExpExecArray | null;
  while ((clauseMatch = clauseRegex.exec(cleaned)) !== null) {
    const afterClause = cleaned.substring(clauseMatch.index + clauseMatch[0].length);
    const tableRefs = parseTableReferences(afterClause);
    for (const ref of tableRefs) {
      references.push(ref);
    }
  }

  return references;
}

/**
 * Parses a comma-separated list of table references from the text following
 * a FROM or JOIN keyword. Stops at clause boundaries.
 */
function parseTableReferences(text: string): CrossDatabaseTableReference[] {
  const references: CrossDatabaseTableReference[] = [];

  // Split by commas (but not within parentheses)
  const segments = splitByComma(text);

  for (const segment of segments) {
    const ref = parseSingleTableReference(segment.trim());
    if (ref) {
      references.push(ref);
    }
  }

  return references;
}

/**
 * Splits text by commas, respecting parenthesis nesting.
 * Stops at clause boundary keywords.
 */
function splitByComma(text: string): string[] {
  const segments: string[] = [];
  let current = '';
  let depth = 0;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    // Check for clause boundary keywords at depth 0
    if (depth === 0) {
      const remaining = text.substring(i);
      if (isClauseBoundary(remaining)) {
        break;
      }
    }

    if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      if (depth > 0) {
        depth--;
        current += ch;
      } else {
        // Unbalanced closing paren — stop
        break;
      }
    } else if (ch === ',' && depth === 0) {
      segments.push(current);
      current = '';
    } else {
      current += ch;
    }
    i++;
  }

  if (current.trim()) {
    segments.push(current);
  }

  return segments;
}

/**
 * Checks if the remaining text starts with a clause boundary keyword.
 */
function isClauseBoundary(text: string): boolean {
  const boundaryPattern = /^(?:where|group\s+by|having|order\s+by|union|except|intersect|for|option|on|set|values|output|into|using|when|then|else|end|go)\b/i;
  return boundaryPattern.test(text.trimStart());
}

/**
 * Parses a single table reference segment (the text for one table in a FROM/JOIN).
 * Detects three-part, two-part, and single-part names, plus aliases.
 *
 * Examples:
 * - "[DB].[dbo].[Users] AS u" → { database: "DB", schema: "dbo", name: "Users", alias: "u" }
 * - "dbo.Orders o" → { schema: "dbo", name: "Orders", alias: "o" }
 * - "Products" → { schema: "dbo", name: "Products" }
 */
function parseSingleTableReference(text: string): CrossDatabaseTableReference | null {
  // Build a regex that captures dot-separated identifiers
  const identRegex = new RegExp(
    `^\\s*(${IDENT_PATTERN})(?:\\.(${IDENT_PATTERN}))?(?:\\.(${IDENT_PATTERN}))?`
  );

  const match = text.match(identRegex);
  if (!match || !match[1]) {
    return null;
  }

  const parts: string[] = [];
  if (match[1]) parts.push(unquoteIdentifier(match[1]));
  if (match[2]) parts.push(unquoteIdentifier(match[2]));
  if (match[3]) parts.push(unquoteIdentifier(match[3]));

  if (parts.length === 0) {
    return null;
  }

  // Extract alias: look for AS keyword or bare identifier after the name
  const fullMatchLength = match[0].length;
  const afterName = text.substring(fullMatchLength).trim();
  const alias = extractAlias(afterName);

  // Determine reference shape based on number of parts
  if (parts.length === 3) {
    // Three-part: Database.Schema.Object
    return {
      database: parts[0],
      schema: parts[1],
      name: parts[2],
      alias,
    };
  } else if (parts.length === 2) {
    // Two-part: Schema.Object (no database qualifier)
    return {
      schema: parts[0],
      name: parts[1],
      alias,
    };
  } else {
    // Single-part: Object (assume dbo schema)
    return {
      schema: 'dbo',
      name: parts[0],
      alias,
    };
  }
}

/**
 * Extracts an alias from text following a table name.
 * Handles both "AS alias" and bare "alias" forms.
 * Ignores SQL keywords that can't be aliases.
 */
function extractAlias(text: string): string | undefined {
  if (!text) return undefined;

  // WITH hints like WITH (NOLOCK) — skip them
  const withHintPattern = /^with\s*\(/i;
  let remaining = text;
  if (withHintPattern.test(remaining)) {
    // Skip the WITH (...) hint
    const parenStart = remaining.indexOf('(');
    let depth = 0;
    let i = parenStart;
    while (i < remaining.length) {
      if (remaining[i] === '(') depth++;
      else if (remaining[i] === ')') {
        depth--;
        if (depth === 0) { i++; break; }
      }
      i++;
    }
    remaining = remaining.substring(i).trim();
  }

  // AS keyword followed by alias
  const asPattern = new RegExp(`^as\\s+(${IDENT_PATTERN})`, 'i');
  const asMatch = remaining.match(asPattern);
  if (asMatch) {
    return unquoteIdentifier(asMatch[1]);
  }

  // Bare alias (identifier that's not a keyword)
  const barePattern = new RegExp(`^(${IDENT_PATTERN})`, 'i');
  const bareMatch = remaining.match(barePattern);
  if (bareMatch) {
    const candidate = bareMatch[1];
    const unquoted = unquoteIdentifier(candidate);
    // Don't treat SQL keywords as aliases
    if (!isReservedKeyword(unquoted)) {
      return unquoted;
    }
  }

  return undefined;
}

/**
 * Checks if an identifier is a reserved SQL keyword that can't be used as an alias
 * without quoting.
 */
function isReservedKeyword(word: string): boolean {
  const keywords = new Set([
    'where', 'group', 'having', 'order', 'on', 'and', 'or', 'not',
    'join', 'inner', 'left', 'right', 'full', 'outer', 'cross',
    'union', 'except', 'intersect', 'select', 'from', 'into',
    'insert', 'update', 'delete', 'set', 'values', 'create',
    'alter', 'drop', 'exec', 'execute', 'declare', 'if', 'else',
    'while', 'begin', 'end', 'return', 'go', 'use', 'with',
    'for', 'option', 'between', 'like', 'in', 'exists', 'is',
    'null', 'case', 'when', 'then', 'as', 'by', 'asc', 'desc',
    'top', 'distinct', 'all', 'merge', 'using', 'matched',
    'output', 'inserted', 'deleted', 'over', 'partition',
  ]);
  return keywords.has(word.toLowerCase());
}

// ─── String Utility Functions ─────────────────────────────────────────────────

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
      while (i < text.length && text[i] !== '\n') {
        result += ' ';
        i++;
      }
      continue;
    }

    // Block comment
    if (text[i] === '/' && i + 1 < text.length && text[i + 1] === '*') {
      result += ' ';
      i++;
      result += ' ';
      i++;
      while (i < text.length) {
        if (text[i] === '*' && i + 1 < text.length && text[i + 1] === '/') {
          result += ' ';
          i++;
          result += ' ';
          i++;
          break;
        }
        result += ' ';
        i++;
      }
      continue;
    }

    // String literal (single-quoted)
    if (text[i] === "'") {
      result += ' ';
      i++;
      while (i < text.length) {
        if (text[i] === "'") {
          result += ' ';
          i++;
          if (i < text.length && text[i] === "'") {
            // Escaped quote
            result += ' ';
            i++;
          } else {
            break;
          }
        } else {
          result += ' ';
          i++;
        }
      }
      continue;
    }

    // N-prefixed string literal
    if ((text[i] === 'N' || text[i] === 'n') && i + 1 < text.length && text[i + 1] === "'") {
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
          result += ' ';
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
