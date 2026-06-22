/**
 * GROUP BY Code Action Provider for the SQL Server Language Server.
 *
 * Provides quick-fix code actions for:
 * 1. "Add GROUP BY clause" — when SELECT has aggregates + non-aggregated columns
 *    and no GROUP BY is present.
 * 2. "Add missing columns to GROUP BY" — when GROUP BY exists but is missing
 *    some non-aggregated columns from the SELECT list.
 *
 * Both actions use CodeActionKind.QuickFix and integrate with the VS Code
 * lightbulb UI.
 */

import {
  CodeAction,
  CodeActionKind,
  TextEdit,
  Range,
  Position,
} from 'vscode-languageserver/node';

import { analyzeSelectList, buildGroupByColumnList } from './groupByAnalyzer';

/**
 * Returns Code Actions for GROUP BY insertion/completion.
 *
 * Conditions for "Add GROUP BY clause":
 * - SELECT has aggregates + non-aggregated columns
 * - No GROUP BY clause present
 *
 * Conditions for "Add missing columns to GROUP BY":
 * - GROUP BY exists but is missing some non-aggregated columns
 *
 * Returns empty array on any error (graceful degradation).
 *
 * @param documentText - The full text of the document
 * @param documentUri - The URI of the document (for TextEdit targeting)
 * @returns CodeAction[] (may be empty)
 */
export function getGroupByCodeActions(
  documentText: string,
  documentUri: string
): CodeAction[] {
  try {
    const actions: CodeAction[] = [];

    // Analyze the SELECT list for aggregation patterns
    const analysis = analyzeSelectList(documentText);

    // If there are no aggregates or no non-aggregated columns, no action needed
    if (!analysis.hasAggregates || analysis.nonAggregatedExpressions.length === 0) {
      return [];
    }

    // Check if GROUP BY already exists
    const groupByMatch = findGroupByClause(documentText);

    if (!groupByMatch) {
      // Case 1: No GROUP BY present — offer "Add GROUP BY clause"
      const addAction = buildAddGroupByAction(documentText, documentUri, analysis.nonAggregatedExpressions);
      if (addAction) {
        actions.push(addAction);
      }
    } else {
      // Case 2: GROUP BY exists — check if it's missing columns
      const missingAction = buildAddMissingColumnsAction(
        documentText,
        documentUri,
        analysis.nonAggregatedExpressions,
        groupByMatch
      );
      if (missingAction) {
        actions.push(missingAction);
      }
    }

    return actions;
  } catch {
    return [];
  }
}

// --- Internal Types ---

/**
 * Information about an existing GROUP BY clause found in the document.
 */
interface GroupByClauseInfo {
  /** The start offset of "GROUP BY" keyword in the document */
  keywordStart: number;
  /** The start offset of the column list (after "GROUP BY ") */
  columnListStart: number;
  /** The end offset of the column list */
  columnListEnd: number;
  /** The existing column list text */
  columnListText: string;
}

// --- Internal Functions ---

/**
 * Finds the GROUP BY clause in the document text.
 * Returns null if no GROUP BY is present.
 * Skips GROUP BY inside string literals and comments.
 */
function findGroupByClause(text: string): GroupByClauseInfo | null {
  const cleaned = stripLiteralsAndComments(text);
  const match = /\bGROUP\s+BY\b/i.exec(cleaned);

  if (!match || match.index === undefined) {
    return null;
  }

  const keywordStart = match.index;
  const columnListStart = keywordStart + match[0].length;

  // Find the end of the column list: terminated by HAVING, ORDER BY, UNION, 
  // semicolon, or end of text
  const afterGroupBy = cleaned.substring(columnListStart);
  const terminatorMatch = afterGroupBy.match(/\b(?:HAVING|ORDER\s+BY|UNION|EXCEPT|INTERSECT)\b|;/i);

  let columnListEnd: number;
  if (terminatorMatch && terminatorMatch.index !== undefined) {
    columnListEnd = columnListStart + terminatorMatch.index;
  } else {
    columnListEnd = text.length;
  }

  // Get the actual column list text from the original (not cleaned) text
  const columnListText = text.substring(columnListStart, columnListEnd).trim();

  return {
    keywordStart,
    columnListStart,
    columnListEnd,
    columnListText,
  };
}

/**
 * Builds the "Add GROUP BY clause" code action.
 * Determines the insertion position (after WHERE or after FROM) and
 * formats the GROUP BY clause with appropriate indentation.
 */
function buildAddGroupByAction(
  documentText: string,
  documentUri: string,
  nonAggregatedExpressions: string[]
): CodeAction | null {
  const columnList = buildGroupByColumnList(nonAggregatedExpressions);
  if (!columnList) {
    return null;
  }

  // Find insertion position: after WHERE clause end, or after FROM clause end
  const insertionInfo = findInsertionPosition(documentText);
  if (!insertionInfo) {
    return null;
  }

  // Detect indentation style from the surrounding context
  const indent = detectIndentation(documentText, insertionInfo.offset);

  // Determine line ending style
  const eol = documentText.includes('\r\n') ? '\r\n' : '\n';

  // Build the GROUP BY text to insert
  const groupByText = `${eol}${indent}GROUP BY ${columnList}`;

  // Convert offset to Position
  const insertPosition = offsetToPosition(documentText, insertionInfo.offset);

  const edit: TextEdit = {
    range: Range.create(insertPosition, insertPosition),
    newText: groupByText,
  };

  const action: CodeAction = {
    title: 'Add GROUP BY clause',
    kind: CodeActionKind.QuickFix,
    edit: {
      changes: {
        [documentUri]: [edit],
      },
    },
  };

  return action;
}

/**
 * Builds the "Add missing columns to GROUP BY" code action.
 * Compares existing GROUP BY columns with required non-aggregated columns
 * and offers to replace the column list with the complete set.
 */
function buildAddMissingColumnsAction(
  documentText: string,
  documentUri: string,
  nonAggregatedExpressions: string[],
  groupByInfo: GroupByClauseInfo
): CodeAction | null {
  // Parse existing GROUP BY columns
  const existingColumns = parseGroupByColumns(groupByInfo.columnListText);

  // Find which columns are missing
  const missingColumns = nonAggregatedExpressions.filter(expr => {
    const normalizedExpr = expr.trim().toLowerCase();
    return !existingColumns.some(existing => existing.toLowerCase() === normalizedExpr);
  });

  if (missingColumns.length === 0) {
    return null; // All columns already present
  }

  // Build the complete column list (existing + missing, preserving SELECT order)
  const completeColumnList = buildGroupByColumnList(nonAggregatedExpressions);
  if (!completeColumnList) {
    return null;
  }

  // Find the range of the existing column list in the document to replace it
  // We need to find where the actual column text starts (skip whitespace after GROUP BY)
  const afterKeyword = documentText.substring(groupByInfo.columnListStart);
  const firstNonWhitespace = afterKeyword.search(/\S/);
  const actualColumnStart = firstNonWhitespace >= 0
    ? groupByInfo.columnListStart + firstNonWhitespace
    : groupByInfo.columnListStart;

  // Find the actual end of the column list (trim trailing whitespace)
  let actualColumnEnd = groupByInfo.columnListEnd;
  while (actualColumnEnd > actualColumnStart && /\s/.test(documentText[actualColumnEnd - 1])) {
    actualColumnEnd--;
  }

  const startPos = offsetToPosition(documentText, actualColumnStart);
  const endPos = offsetToPosition(documentText, actualColumnEnd);

  const edit: TextEdit = {
    range: Range.create(startPos, endPos),
    newText: completeColumnList,
  };

  const action: CodeAction = {
    title: 'Add missing columns to GROUP BY',
    kind: CodeActionKind.QuickFix,
    edit: {
      changes: {
        [documentUri]: [edit],
      },
    },
  };

  return action;
}

/**
 * Information about where to insert the GROUP BY clause.
 */
interface InsertionPosition {
  /** Character offset in the document where the GROUP BY should be inserted */
  offset: number;
  /** What clause the insertion is after ('WHERE' or 'FROM') */
  afterClause: 'WHERE' | 'FROM';
}

/**
 * Finds the position where a GROUP BY clause should be inserted.
 * Priority: after WHERE clause end > after FROM clause end.
 *
 * The "end" of a clause is determined by finding the next clause keyword
 * or the end of the statement.
 */
function findInsertionPosition(text: string): InsertionPosition | null {
  const cleaned = stripLiteralsAndComments(text);

  // Try to find WHERE clause first (GROUP BY goes after WHERE)
  const whereMatch = /\bWHERE\b/i.exec(cleaned);
  if (whereMatch) {
    const whereEnd = findClauseEnd(cleaned, whereMatch.index + whereMatch[0].length);
    return { offset: whereEnd, afterClause: 'WHERE' };
  }

  // Fall back to FROM clause
  const fromMatch = /\bFROM\b/i.exec(cleaned);
  if (fromMatch) {
    const fromEnd = findClauseEnd(cleaned, fromMatch.index + fromMatch[0].length);
    return { offset: fromEnd, afterClause: 'FROM' };
  }

  return null;
}

/**
 * Finds the end of a clause starting from a given offset.
 * A clause ends at the next top-level clause keyword (GROUP BY, HAVING, ORDER BY, etc.)
 * or at a semicolon or end of text.
 */
function findClauseEnd(cleaned: string, startOffset: number): number {
  const afterClause = cleaned.substring(startOffset);

  // Look for the next clause keyword that would terminate this clause
  // We need to find it at the top level (not inside parentheses)
  let depth = 0;
  let i = 0;

  while (i < afterClause.length) {
    const ch = afterClause[i];

    if (ch === '(') {
      depth++;
      i++;
      continue;
    }
    if (ch === ')') {
      depth--;
      i++;
      continue;
    }

    if (depth === 0) {
      // Check for terminating keywords at top level
      const remaining = afterClause.substring(i);

      if (/^(?:GROUP\s+BY|HAVING|ORDER\s+BY|UNION|EXCEPT|INTERSECT)\b/i.test(remaining)) {
        // Found a terminator — the clause ends just before this keyword
        // Walk back to skip trailing whitespace
        let endPos = startOffset + i;
        while (endPos > startOffset && /\s/.test(cleaned[endPos - 1])) {
          endPos--;
        }
        return endPos;
      }

      // Check for semicolon
      if (ch === ';') {
        let endPos = startOffset + i;
        while (endPos > startOffset && /\s/.test(cleaned[endPos - 1])) {
          endPos--;
        }
        return endPos;
      }
    }

    i++;
  }

  // No terminator found — clause extends to end of text
  // Trim trailing whitespace
  let endPos = startOffset + afterClause.length;
  while (endPos > startOffset && /\s/.test(cleaned[endPos - 1])) {
    endPos--;
  }
  return endPos;
}

/**
 * Detects the indentation style used at the given offset in the document.
 * Looks at the line containing the offset and the surrounding lines to
 * determine the indentation prefix.
 *
 * Strategy:
 * 1. Find the line containing the insertion offset
 * 2. Look at the FROM or WHERE keyword line's indentation
 * 3. Use that as the base indentation for the GROUP BY clause
 */
function detectIndentation(text: string, offset: number): string {
  const lines = text.split('\n');
  let currentOffset = 0;
  let targetLineIndex = 0;

  // Find which line the offset falls on
  for (let i = 0; i < lines.length; i++) {
    const lineLength = lines[i].length + 1; // +1 for \n
    if (currentOffset + lineLength > offset) {
      targetLineIndex = i;
      break;
    }
    currentOffset += lineLength;
  }

  // Look backwards from the target line to find a clause keyword line
  // (FROM, WHERE, JOIN) and use its indentation
  for (let i = targetLineIndex; i >= 0; i--) {
    const line = lines[i];
    const clauseMatch = /^(\s*)(?:FROM|WHERE|JOIN|INNER\s+JOIN|LEFT\s+(?:OUTER\s+)?JOIN|RIGHT\s+(?:OUTER\s+)?JOIN|FULL\s+(?:OUTER\s+)?JOIN|CROSS\s+JOIN)\b/i.exec(line);
    if (clauseMatch) {
      return clauseMatch[1]; // Return the indentation of the clause keyword
    }
  }

  // Fallback: look for SELECT keyword indentation
  for (let i = targetLineIndex; i >= 0; i--) {
    const line = lines[i];
    const selectMatch = /^(\s*)SELECT\b/i.exec(line);
    if (selectMatch) {
      return selectMatch[1]; // Return SELECT's indentation
    }
  }

  // Final fallback: no indentation
  return '';
}

/**
 * Parses the column list from an existing GROUP BY clause.
 * Splits by commas respecting parenthesis nesting.
 */
function parseGroupByColumns(columnListText: string): string[] {
  const columns: string[] = [];
  let current = '';
  let depth = 0;

  for (let i = 0; i < columnListText.length; i++) {
    const ch = columnListText[i];

    if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        columns.push(trimmed);
      }
      current = '';
    } else {
      current += ch;
    }
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) {
    columns.push(trimmed);
  }

  return columns;
}

/**
 * Converts a character offset to a Position (line, character).
 */
function offsetToPosition(text: string, offset: number): Position {
  let line = 0;
  let character = 0;

  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      character = 0;
    } else if (text[i] === '\r') {
      // Skip \r in \r\n sequences
      if (i + 1 < text.length && text[i + 1] === '\n') {
        continue;
      }
      line++;
      character = 0;
    } else {
      character++;
    }
  }

  return Position.create(line, character);
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
