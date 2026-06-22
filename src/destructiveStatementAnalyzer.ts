/**
 * DestructiveStatementAnalyzer — pure, stateless module that analyzes SQL text
 * for destructive statements. No VS Code dependencies.
 */

/** Classification of why a statement is destructive */
export type DestructiveReason =
  | 'UPDATE_WITHOUT_WHERE'
  | 'DELETE_WITHOUT_WHERE'
  | 'TRUNCATE_TABLE'
  | 'DROP_TABLE'
  | 'DROP_DATABASE';

/** A single detected destructive statement */
export interface DestructiveStatement {
  /** The full statement text (untrimmed, preserving original formatting) */
  text: string;
  /** 1-based line number in the original document */
  lineNumber: number;
  /** Classification reason */
  reason: DestructiveReason;
}

/** Result of analyzing SQL text */
export interface AnalysisResult {
  /** All detected destructive statements, ordered by lineNumber */
  statements: DestructiveStatement[];
}

/**
 * Strips comments and string literals from SQL text, replacing them with
 * equivalent-length whitespace to preserve character positions and line numbers.
 *
 * Handles:
 * - Single-line comments (-- to end of line)
 * - Block comments (/* ... *​/), including nested
 * - String literals ('...') with '' escape sequences
 * - Unclosed block comments (treats remainder as comment)
 * - Unclosed string literals (treats remainder as string)
 *
 * @param sql - Raw SQL text
 * @returns SQL text with comments/strings replaced by spaces
 */
/**
 * Represents a parsed statement with its position in the original text.
 */
export interface ParsedStatement {
  /** The statement text (from the stripped SQL) */
  text: string;
  /** 0-based start line within the provided SQL text */
  startLine: number;
  /** 0-based character offset where this statement starts in the full input string */
  startOffset: number;
}

/**
 * Splits stripped SQL into individual statements using semicolons as
 * delimiters and GO as batch separators. Since comments/strings are already
 * stripped, all semicolons are real statement boundaries.
 *
 * - Splits on GO lines (standalone, case-insensitive)
 * - Within each batch, splits on semicolons
 * - Treats end-of-batch as implicit terminator
 * - Skips empty/whitespace-only segments
 *
 * @param strippedSql - SQL text with comments/strings already stripped
 * @returns Array of parsed statements with line positions
 */
export function parseStatements(strippedSql: string): ParsedStatement[] {
  const results: ParsedStatement[] = [];
  const lines = strippedSql.split('\n');

  // First pass: identify GO separator lines and split into batches.
  // A GO line is one that contains only "GO" (case-insensitive) with optional whitespace.
  const goPattern = /^\s*GO\s*$/i;

  // We'll process line-by-line, accumulating batches.
  // Each batch tracks its starting line index, its collected lines, and
  // the absolute character offset in the full input where the batch starts.
  interface Batch {
    startLine: number;
    lines: string[];
    absoluteCharOffset: number;
  }

  const batches: Batch[] = [];
  // Track current character position as we scan lines
  let charPos = 0;
  let currentBatch: Batch = { startLine: 0, lines: [], absoluteCharOffset: 0 };

  for (let i = 0; i < lines.length; i++) {
    if (goPattern.test(lines[i])) {
      // End current batch at this GO line
      batches.push(currentBatch);
      // Advance charPos past this GO line (line length + newline char)
      charPos += lines[i].length + (i < lines.length - 1 ? 1 : 0);
      // Start a new batch on the next line
      currentBatch = { startLine: i + 1, lines: [], absoluteCharOffset: charPos };
    } else {
      currentBatch.lines.push(lines[i]);
      // Advance charPos past this line (line length + newline char)
      charPos += lines[i].length + (i < lines.length - 1 ? 1 : 0);
    }
  }
  // Push the final batch
  batches.push(currentBatch);

  // Second pass: within each batch, split on semicolons and track line positions.
  for (const batch of batches) {
    if (batch.lines.length === 0) {
      continue;
    }

    // Rejoin the batch lines to split on semicolons, but we need to track
    // which line each character belongs to for start-line calculation.
    const batchText = batch.lines.join('\n');

    // Split on semicolons - since comments/strings are already stripped,
    // every semicolon is a real boundary.
    const segments = splitOnSemicolons(batchText);

    for (const segment of segments) {
      // Skip empty/whitespace-only segments
      if (segment.text.trim().length === 0) {
        continue;
      }

      // The segment's startLine is relative to the batch. Add the batch's
      // starting line offset to get the absolute line in the original input.
      results.push({
        text: segment.text,
        startLine: batch.startLine + segment.lineOffset,
        startOffset: batch.absoluteCharOffset + segment.charOffset,
      });
    }
  }

  return results;
}

/**
 * Splits text on semicolons and returns each segment with its line offset
 * within the provided text and its character offset relative to the batch start.
 * The lineOffset is the 0-based line number where the first non-whitespace
 * character of the segment appears.
 */
function splitOnSemicolons(text: string): Array<{ text: string; lineOffset: number; charOffset: number }> {
  const segments: Array<{ text: string; lineOffset: number; charOffset: number }> = [];
  let currentStart = 0;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === ';') {
      const segmentText = text.substring(currentStart, i);
      segments.push({
        text: segmentText,
        lineOffset: getFirstContentLine(text, currentStart),
        charOffset: currentStart,
      });
      currentStart = i + 1;
    }
  }

  // Final segment (implicit terminator at end-of-batch)
  if (currentStart < text.length) {
    segments.push({
      text: text.substring(currentStart),
      lineOffset: getFirstContentLine(text, currentStart),
      charOffset: currentStart,
    });
  }

  return segments;
}

/**
 * Finds the 0-based line number of the first non-whitespace character
 * starting from the given position in the full text.
 */
function getFirstContentLine(text: string, fromIndex: number): number {
  // Count newlines from start of text to the first non-whitespace char at/after fromIndex
  let lineCount = 0;
  // First, count all newlines from start to fromIndex
  for (let i = 0; i < fromIndex && i < text.length; i++) {
    if (text[i] === '\n') {
      lineCount++;
    }
  }
  // Now scan forward from fromIndex to find first non-whitespace, counting newlines along the way
  for (let i = fromIndex; i < text.length; i++) {
    if (text[i] === '\n') {
      lineCount++;
    } else if (text[i] !== ' ' && text[i] !== '\t' && text[i] !== '\r') {
      return lineCount;
    }
  }
  // All whitespace - return line at fromIndex
  return lineCount;
}

/**
 * Determines if a WHERE keyword exists at the top level of a statement
 * (not nested inside parentheses from subqueries).
 *
 * Algorithm:
 * 1. Scan the statement character by character
 * 2. Track parenthesis depth (increment on '(', decrement on ')')
 * 3. When depth == 0 and we encounter \bWHERE\b (case-insensitive), return true
 * 4. If end of statement reached without finding top-level WHERE, return false
 */
export function hasTopLevelWhere(statement: string): boolean {
  let depth = 0;
  let i = 0;
  const len = statement.length;

  while (i < len) {
    const ch = statement[i];

    if (ch === '(') {
      depth++;
      i++;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (depth === 0) {
      // Check if we're at the start of "WHERE" (case-insensitive) with word boundaries
      if (
        (ch === 'W' || ch === 'w') &&
        i + 4 < len &&
        matchesWhereAt(statement, i)
      ) {
        // Check word boundary before
        const beforeOk = i === 0 || !isWordChar(statement[i - 1]);
        // Check word boundary after
        const afterOk = i + 5 >= len || !isWordChar(statement[i + 5]);

        if (beforeOk && afterOk) {
          return true;
        }
      }
      i++;
    } else {
      i++;
    }
  }

  return false;
}

/**
 * Checks if the substring at position i matches "WHERE" (case-insensitive).
 */
function matchesWhereAt(str: string, i: number): boolean {
  const w = str.substring(i, i + 5).toUpperCase();
  return w === 'WHERE';
}

/**
 * Checks if a character is a word character (alphanumeric or underscore).
 */
function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

/**
 * Classifies a single statement as destructive or safe.
 *
 * Detection patterns (all case-insensitive):
 *
 * 1. TRUNCATE TABLE: always destructive
 * 2. DROP TABLE: always destructive
 * 3. DROP DATABASE: always destructive
 * 4. UPDATE without WHERE: destructive if no top-level WHERE
 * 5. DELETE without WHERE: destructive if no top-level WHERE
 *
 * NOT flagged: DROP VIEW, DROP PROCEDURE, DROP INDEX, DROP FUNCTION, etc.
 */
export function classifyStatement(statement: string): DestructiveReason | null {
  const normalized = statement.trim();

  // Check TRUNCATE TABLE (always destructive)
  if (/^\s*TRUNCATE\s+TABLE\b/i.test(normalized)) {
    return 'TRUNCATE_TABLE';
  }

  // Check DROP TABLE (always destructive)
  if (/^\s*DROP\s+TABLE\b/i.test(normalized)) {
    return 'DROP_TABLE';
  }

  // Check DROP DATABASE (always destructive)
  if (/^\s*DROP\s+DATABASE\b/i.test(normalized)) {
    return 'DROP_DATABASE';
  }

  // Check UPDATE without WHERE
  if (/^\s*UPDATE\b/i.test(normalized)) {
    if (!hasTopLevelWhere(normalized)) {
      return 'UPDATE_WITHOUT_WHERE';
    }
    return null; // has WHERE, safe
  }

  // Check DELETE without WHERE
  if (/^\s*DELETE\b/i.test(normalized)) {
    if (!hasTopLevelWhere(normalized)) {
      return 'DELETE_WITHOUT_WHERE';
    }
    return null; // has WHERE, safe
  }

  return null; // not a destructive pattern
}

export function stripCommentsAndStrings(sql: string): string {
  const result: string[] = [];
  let i = 0;

  while (i < sql.length) {
    // Check for single-line comment: --
    if (sql[i] === '-' && i + 1 < sql.length && sql[i + 1] === '-') {
      // Replace everything from -- to end of line (excluding the newline itself)
      i += 2;
      result.push('  '); // replace the two dashes
      while (i < sql.length && sql[i] !== '\n') {
        result.push(' ');
        i++;
      }
      // Don't consume the newline — it will be handled in the next iteration
    }
    // Check for block comment: /*
    else if (sql[i] === '/' && i + 1 < sql.length && sql[i + 1] === '*') {
      // Handle nested block comments
      let depth = 1;
      result.push('  '); // replace /*
      i += 2;

      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && i + 1 < sql.length && sql[i + 1] === '*') {
          depth++;
          result.push('  ');
          i += 2;
        } else if (sql[i] === '*' && i + 1 < sql.length && sql[i + 1] === '/') {
          depth--;
          result.push('  ');
          i += 2;
        } else {
          // Preserve newlines for line number tracking
          result.push(sql[i] === '\n' ? '\n' : ' ');
          i++;
        }
      }

      // If depth > 0, we hit end of input (unclosed block comment)
      // All remaining text was already consumed and replaced with spaces
    }
    // Check for string literal: '
    else if (sql[i] === '\'') {
      result.push(' '); // replace opening quote
      i++;

      while (i < sql.length) {
        if (sql[i] === '\'') {
          // Check for escaped quote ''
          if (i + 1 < sql.length && sql[i + 1] === '\'') {
            result.push('  '); // replace both quotes
            i += 2;
          } else {
            // End of string literal
            result.push(' '); // replace closing quote
            i++;
            break;
          }
        } else {
          // Preserve newlines for line number tracking
          result.push(sql[i] === '\n' ? '\n' : ' ');
          i++;
        }
      }

      // If we exited the while loop without breaking, it's an unclosed string literal
      // All remaining text was already consumed and replaced with spaces
    }
    // Regular character — keep as-is
    else {
      result.push(sql[i]);
      i++;
    }
  }

  return result.join('');
}

/**
 * Analyzes SQL text for destructive statements.
 *
 * @param sqlText - The raw SQL text to analyze
 * @param documentStartLine - 0-based line offset for selection mode
 *                            (the line number of the first line of sqlText
 *                             within the full document). Defaults to 0.
 * @returns AnalysisResult with all destructive statements found
 */
export function analyze(
  sqlText: string,
  documentStartLine?: number
): AnalysisResult {
  // Handle empty/whitespace-only input
  if (!sqlText || sqlText.trim().length === 0) {
    return { statements: [] };
  }

  const offset = documentStartLine || 0;

  // Step 1: Strip comments and string literals (preserves character positions)
  const strippedSql = stripCommentsAndStrings(sqlText);

  // Step 2: Parse into individual statements with position info
  const parsedStatements = parseStatements(strippedSql);

  // Step 3: Classify each statement and collect destructive ones
  const destructiveStatements: DestructiveStatement[] = [];

  for (const stmt of parsedStatements) {
    const reason = classifyStatement(stmt.text);
    if (reason !== null) {
      // Extract original text from the raw SQL using the same character offsets.
      // Since stripCommentsAndStrings preserves length (replaces with same-length
      // whitespace), the offsets from the stripped text map directly to the original.
      const originalText = sqlText.substring(
        stmt.startOffset,
        stmt.startOffset + stmt.text.length
      );

      destructiveStatements.push({
        text: originalText,
        lineNumber: stmt.startLine + offset + 1, // convert 0-based to 1-based
        reason,
      });
    }
  }

  // Step 4: Sort by lineNumber ascending
  destructiveStatements.sort((a, b) => a.lineNumber - b.lineNumber);

  return { statements: destructiveStatements };
}
