/**
 * SELECT * Expansion — Code action provider for expanding SELECT * into
 * an explicit column list based on resolved tables in the schema cache.
 *
 * Detects when the cursor is on a `*` token within a SELECT clause,
 * resolves referenced tables from FROM/JOIN clauses, and offers a
 * code action to expand the star into the full column list.
 */

import {
  CodeAction,
  CodeActionKind,
  Range,
  TextEdit,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { ISchemaCache, TableInfo, ViewInfo } from './schemaCache';
import { extractCurrentBatch, extractTableReferences, getStatementScopeText, TableReference } from './completionProvider';

/**
 * Returns code actions for expanding SELECT * at the given range.
 *
 * Offers a "refactor.rewrite" code action when:
 * - The range/cursor is positioned on a `*` token within a SELECT clause
 * - At least one table referenced in FROM/JOIN clauses is resolved in the schema cache
 *
 * Returns an empty array when:
 * - The cursor is not on a `*` token
 * - The `*` is not within a SELECT clause context
 * - No tables can be resolved from the schema cache
 */
export function getExpandStarActions(
  document: TextDocument,
  range: Range,
  schemaCache: ISchemaCache
): CodeAction[] {
  const text = document.getText();

  // Find the `*` token at or near the cursor position
  const starInfo = findStarAtRange(text, document, range);
  if (!starInfo) {
    return [];
  }

  // Verify the `*` is within a SELECT clause context
  if (!isStarInSelectContext(text, starInfo.offset)) {
    return [];
  }

  // Scope to the current batch containing the `*` token
  const batchScope = extractCurrentBatch(text, starInfo.offset);

  // Narrow to statement scope within the batch
  const cursorOffsetInBatch = starInfo.offset - batchScope.startOffset;
  const statementText = getStatementScopeText(batchScope.text, cursorOffsetInBatch);

  // Extract table references from FROM/JOIN clauses within the current statement only
  const tableRefs = extractTableReferences(statementText);
  if (tableRefs.length === 0) {
    return [];
  }

  // Resolve table references against the schema cache
  const resolvedTables = resolveTableReferences(tableRefs, schemaCache);
  if (resolvedTables.length === 0) {
    return [];
  }

  // Build the column expansion text
  const columnList = buildColumnList(resolvedTables, tableRefs, text, starInfo.starRange);

  // Create the code action
  const action: CodeAction = {
    title: 'Expand SELECT * to column list',
    kind: CodeActionKind.RefactorRewrite,
    edit: {
      changes: {
        [document.uri]: [
          TextEdit.replace(starInfo.starRange, columnList),
        ],
      },
    },
  };

  return [action];
}

/**
 * Information about a found `*` token in the document.
 */
interface StarInfo {
  /** Character offset of the `*` in the document text */
  offset: number;
  /** The LSP range covering the `*` character */
  starRange: Range;
}

/**
 * Finds a `*` token at or overlapping the given range.
 * Returns null if no `*` is found at the cursor position.
 */
function findStarAtRange(
  text: string,
  document: TextDocument,
  range: Range
): StarInfo | null {
  const startOffset = document.offsetAt(range.start);
  const endOffset = document.offsetAt(range.end);

  // Check if the range directly covers or is adjacent to a `*`
  // Case 1: cursor is directly on the `*` (zero-width range or single char selection)
  if (startOffset < text.length && text[startOffset] === '*') {
    return {
      offset: startOffset,
      starRange: {
        start: document.positionAt(startOffset),
        end: document.positionAt(startOffset + 1),
      },
    };
  }

  // Case 2: selection covers the `*`
  for (let i = startOffset; i < endOffset && i < text.length; i++) {
    if (text[i] === '*') {
      return {
        offset: i,
        starRange: {
          start: document.positionAt(i),
          end: document.positionAt(i + 1),
        },
      };
    }
  }

  // Case 3: cursor is right after the `*` (e.g., position is at offset where char before is `*`)
  if (startOffset > 0 && text[startOffset - 1] === '*') {
    return {
      offset: startOffset - 1,
      starRange: {
        start: document.positionAt(startOffset - 1),
        end: document.positionAt(startOffset),
      },
    };
  }

  return null;
}

/**
 * Determines whether the `*` at the given offset is within a SELECT clause context.
 *
 * Checks that the most recent clause keyword before the `*` is SELECT (not FROM, WHERE, etc.)
 * and that the `*` is not part of a multiplication expression or count(*).
 */
function isStarInSelectContext(text: string, starOffset: number): boolean {
  const textBefore = text.substring(0, starOffset);

  // Strip string literals and comments to avoid false matches
  const cleaned = stripLiteralsAndComments(textBefore);

  // Check if the `*` is inside a function call like COUNT(*)
  // Look at the character immediately before the `*` (ignoring whitespace)
  const trimmedBefore = cleaned.trimEnd();
  if (trimmedBefore.endsWith('(')) {
    return false;
  }

  // Find the most recent clause keyword
  const patterns: Array<{ context: string; regex: RegExp }> = [
    { context: 'ORDER_BY', regex: /\border\s+by\b/gi },
    { context: 'GROUP_BY', regex: /\bgroup\s+by\b/gi },
    { context: 'FROM', regex: /\bfrom\b/gi },
    { context: 'JOIN', regex: /\b(?:inner\s+join|left\s+(?:outer\s+)?join|right\s+(?:outer\s+)?join|full\s+(?:outer\s+)?join|cross\s+join|join)\b/gi },
    { context: 'WHERE', regex: /\bwhere\b/gi },
    { context: 'SELECT', regex: /\bselect\b/gi },
    { context: 'HAVING', regex: /\bhaving\b/gi },
  ];

  let latestMatch: { context: string; index: number } | null = null;

  for (const { context, regex } of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(cleaned)) !== null) {
      const matchEnd = match.index + match[0].length;
      if (latestMatch === null || matchEnd > latestMatch.index) {
        latestMatch = { context, index: matchEnd };
      }
    }
  }

  return latestMatch !== null && latestMatch.context === 'SELECT';
}

/**
 * A resolved table with its columns and reference info.
 */
interface ResolvedTable {
  ref: TableReference;
  table: TableInfo | ViewInfo;
}

/**
 * Resolves table references against the schema cache.
 * Returns only those references that match a table or view in the cache.
 *
 * Resolution rules:
 * - If table has schema prefix: match schema.name (case-insensitive)
 * - If table has no schema prefix: match by name only (case-insensitive), prefer dbo schema
 */
function resolveTableReferences(
  refs: TableReference[],
  schemaCache: ISchemaCache
): ResolvedTable[] {
  const resolved: ResolvedTable[] = [];

  for (const ref of refs) {
    const match = findTableOrView(schemaCache, ref);
    if (match) {
      resolved.push({ ref, table: match });
    }
  }

  return resolved;
}

/**
 * Finds a table or view in the schema cache matching a table reference.
 *
 * - With schema prefix: exact case-insensitive match on schema + name
 * - Without schema prefix: match by name, prefer dbo schema
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
    // No schema specified - match by name, prefer dbo
    const tables = schemaCache.tables.filter(
      t => t.name.toLowerCase() === ref.name.toLowerCase()
    );
    if (tables.length > 0) {
      // Prefer dbo schema
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
 * Builds the column list string that replaces `*`.
 *
 * - Multiple tables referenced: prefix each column with alias (or table name if no alias)
 * - Single table referenced: no prefix on columns
 * - Columns listed in ORDINAL_POSITION order (array order from schema cache)
 * - FROM tables first, then JOIN tables in appearance order
 * - Each column on a separate line with indentation matching the SELECT keyword line
 * - Skip unresolved tables; expand only resolved ones
 */
function buildColumnList(
  resolvedTables: ResolvedTable[],
  allRefs: TableReference[],
  text: string,
  starRange: Range
): string {
  // Multiple tables are "referenced" when more than one table appears in FROM/JOIN clauses,
  // regardless of how many are resolved. This determines whether columns get prefixed.
  const multipleTablesReferenced = allRefs.length > 1;

  // Determine indentation from the line containing the SELECT keyword
  const indent = getSelectIndentation(text, starRange);

  const columns: string[] = [];

  for (const { ref, table } of resolvedTables) {
    const prefix = multipleTablesReferenced
      ? (ref.alias || ref.name) + '.'
      : '';

    for (const col of table.columns) {
      columns.push(`${prefix}${col.name}`);
    }
  }

  if (columns.length === 0) {
    return '*';
  }

  // Format: first column on same line, subsequent columns on new lines with indentation
  if (columns.length === 1) {
    return columns[0];
  }

  return columns.join(',\n' + indent);
}

/**
 * Gets the indentation string for the line containing the SELECT keyword
 * that corresponds to the `*` being expanded.
 * Falls back to the indentation of the line containing the `*`.
 */
function getSelectIndentation(text: string, starRange: Range): string {
  // Find the line containing the star
  const lines = text.split('\n');
  const starLine = starRange.start.line;

  // Look backwards from the star line to find the SELECT keyword
  for (let i = starLine; i >= 0; i--) {
    const line = lines[i];
    const selectMatch = /^(\s*)select\b/i.exec(line);
    if (selectMatch) {
      // Return indentation + extra spaces to align with column position after SELECT
      return selectMatch[1] + '       '; // "SELECT " is 7 chars
    }
  }

  // Fallback: use the indentation of the star's line + some padding
  if (starLine < lines.length) {
    const lineText = lines[starLine];
    const indentMatch = /^(\s*)/.exec(lineText);
    return indentMatch ? indentMatch[1] : '';
  }

  return '';
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
    // String literal (single-quoted)
    else if (text[i] === '\'') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\'') {
          if (j + 1 < text.length && text[j + 1] === '\'') {
            j += 2;
          } else {
            j += 1;
            break;
          }
        } else {
          j++;
        }
      }
      result += ' '.repeat(j - i);
      i = j;
    }
    // N-prefixed string literal
    else if (
      (text[i] === 'N' || text[i] === 'n') &&
      i + 1 < text.length &&
      text[i + 1] === '\''
    ) {
      let j = i + 2;
      while (j < text.length) {
        if (text[j] === '\'') {
          if (j + 1 < text.length && text[j + 1] === '\'') {
            j += 2;
          } else {
            j += 1;
            break;
          }
        } else {
          j++;
        }
      }
      result += ' '.repeat(j - i);
      i = j;
    }
    // Regular character
    else {
      result += text[i];
      i++;
    }
  }

  return result;
}
