import { StatementBoundary } from './types';

/**
 * Internal representation of a batch with its line offset in the original document.
 */
interface BatchInfo {
  text: string;
  startLine: number; // 0-based line offset in the full document
  lines: string[];
}

/**
 * Splits the document into batches on GO separators (preserving line offsets).
 * Uses the same rules as batchSplitter.ts: GO must be on its own line,
 * not inside string literals or block comments.
 */
function splitIntoBatches(documentText: string): BatchInfo[] {
  const lines = documentText.split(/\r?\n/);
  const batches: BatchInfo[] = [];
  let currentBatchLines: string[] = [];
  let currentBatchStartLine = 0;

  let inBlockComment = false;
  let inString = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];

    if (!inBlockComment && !inString) {
      // Check if this line is a standalone GO separator
      if (/^\s*GO\s*$/i.test(line)) {
        const batchText = currentBatchLines.join('\n');
        if (batchText.trim().length > 0) {
          batches.push({
            text: batchText,
            startLine: currentBatchStartLine,
            lines: currentBatchLines,
          });
        }
        currentBatchLines = [];
        currentBatchStartLine = lineIndex + 1;
        continue;
      }
    }

    currentBatchLines.push(line);

    // Update parser state by scanning the line character by character
    const state = updateParserState(line, inBlockComment, inString);
    inBlockComment = state.inBlockComment;
    inString = state.inString;
  }

  // Add the final batch
  const batchText = currentBatchLines.join('\n');
  if (batchText.trim().length > 0) {
    batches.push({
      text: batchText,
      startLine: currentBatchStartLine,
      lines: currentBatchLines,
    });
  }

  return batches;
}

/**
 * Scans a line character by character to update parser state
 * (tracking whether we end the line inside a block comment or string literal).
 */
function updateParserState(
  line: string,
  inBlockComment: boolean,
  inString: boolean
): { inBlockComment: boolean; inString: boolean } {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = i + 1 < line.length ? line[i + 1] : '';

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++; // skip the '/'
      }
    } else if (inString) {
      if (ch === "'") {
        if (next === "'") {
          i++; // skip escaped quote
        } else {
          inString = false;
        }
      }
    } else {
      if (ch === '-' && next === '-') {
        // Single-line comment — rest of line is comment
        break;
      } else if (ch === '/' && next === '*') {
        inBlockComment = true;
        i++; // skip the '*'
      } else if (ch === "'") {
        inString = true;
      }
    }
  }

  return { inBlockComment, inString };
}

/**
 * Represents a raw segment found by splitting on semicolons within a batch.
 */
interface RawSegment {
  text: string;
  /** 0-based line index within the batch where this segment starts */
  startLineInBatch: number;
  /** 0-based line index within the batch where this segment ends */
  endLineInBatch: number;
}

/**
 * Checks if a text fragment contains any meaningful SQL content
 * (not just whitespace, single-line comments, and block comments).
 * Used to determine if a DML keyword on a new line should start a new statement.
 */
function hasNonCommentContent(text: string): boolean {
  let i = 0;
  let inBlock = false;

  while (i < text.length) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';

    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 2;
      } else {
        i++;
      }
    } else if (ch === '-' && next === '-') {
      // Skip to end of line
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
    } else if (ch === '/' && next === '*') {
      inBlock = true;
      i += 2;
    } else if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
    } else {
      // Found a non-whitespace, non-comment character
      return true;
    }
  }

  return false;
}

/**
 * Splits a batch's text on semicolons that are NOT inside:
 * - String literals (single-quoted, with '' as escape)
 * - Block comments
 * - Single-line comments (-- to end of line)
 *
 * Additionally splits on implicit statement boundaries: top-level DML/DDL keywords
 * (SELECT, INSERT, UPDATE, DELETE, EXEC, EXECUTE, MERGE, WITH, IF, WHILE, PRINT,
 * DECLARE, SET, CREATE, ALTER, DROP, TRUNCATE, GRANT, REVOKE, DENY)
 * that appear at the start of a line (after optional whitespace) and are NOT
 * inside string literals, block comments, or single-line comments.
 *
 * Trailing non-whitespace text after the last separator is treated as a statement.
 */
function splitOnSemicolons(batchLines: string[]): RawSegment[] {
  const segments: RawSegment[] = [];
  let currentSegmentLines: string[] = [];
  let currentSegmentStartLine = 0;

  let inBlockComment = false;
  let inString = false;

  // DML/DDL keywords that implicitly start a new statement when at line start
  // NOTE: SET and WHERE are NOT included because they are continuations of UPDATE/DELETE/SELECT
  // NOTE: INTO is NOT included because it's a continuation of INSERT
  // NOTE: FROM is NOT included because it's a continuation of SELECT/DELETE
  const statementStartKeywords = /^(\s*)(SELECT|INSERT|UPDATE|DELETE|EXEC|EXECUTE|MERGE|WITH|IF|WHILE|PRINT|DECLARE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|DENY)\b/i;

  // Keywords that are continuation of a previous statement (not new statements)
  // e.g., SELECT inside a subquery, INSERT...SELECT, WITH inside a CTE
  // We only split when the keyword is at the START of a line with no preceding
  // non-whitespace content on that line, AND the current segment already has content.

  for (let lineIdx = 0; lineIdx < batchLines.length; lineIdx++) {
    const line = batchLines[lineIdx];

    // Check for implicit statement boundary at line start (only when not in string/comment)
    if (!inBlockComment && !inString && currentSegmentLines.length > 0) {
      const keywordMatch = statementStartKeywords.exec(line);
      if (keywordMatch) {
        // Check if the current segment has any meaningful SQL content
        // (not just whitespace, comments, or empty lines)
        const currentText = currentSegmentLines.join('\n');
        if (hasNonCommentContent(currentText)) {
          // This line starts a new statement — flush the current segment
          segments.push({
            text: currentText,
            startLineInBatch: currentSegmentStartLine,
            endLineInBatch: lineIdx - 1,
          });
          currentSegmentLines = [];
          currentSegmentStartLine = lineIdx;
        }
      }
    }

    // Now process the line character by character for semicolons
    let currentLineFragment = '';
    let lineFullyConsumed = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = i + 1 < line.length ? line[i + 1] : '';

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          currentLineFragment += '*/';
          inBlockComment = false;
          i++; // skip '/'
        } else {
          currentLineFragment += ch;
        }
      } else if (inString) {
        if (ch === "'") {
          if (next === "'") {
            currentLineFragment += "''";
            i++; // skip escaped quote
          } else {
            currentLineFragment += ch;
            inString = false;
          }
        } else {
          currentLineFragment += ch;
        }
      } else {
        // Normal context
        if (ch === ';') {
          // Found a semicolon separator — end current segment
          currentSegmentLines.push(currentLineFragment);
          const segmentText = currentSegmentLines.join('\n');
          segments.push({
            text: segmentText,
            startLineInBatch: currentSegmentStartLine,
            endLineInBatch: lineIdx,
          });
          // Check if the remainder of this line (after the semicolon) is only
          // whitespace/comment — if so, start the next segment on the NEXT line
          const remainder = line.substring(i + 1);
          if (!hasNonCommentContent(remainder)) {
            // Remainder is empty, whitespace-only, or comment-only — skip it
            // But we still need to update parser state for spanning block comments
            const stateAfter = updateParserState(remainder, inBlockComment, inString);
            inBlockComment = stateAfter.inBlockComment;
            inString = stateAfter.inString;
            currentSegmentLines = [];
            currentSegmentStartLine = lineIdx + 1;
            currentLineFragment = '';
            lineFullyConsumed = true;
            break; // done with this line, remainder is discarded
          }
          // Start new segment on the same line (after the semicolon)
          currentSegmentLines = [];
          currentSegmentStartLine = lineIdx;
          currentLineFragment = '';
        } else if (ch === '-' && next === '-') {
          // Single-line comment — rest of line is part of current segment
          currentLineFragment += line.substring(i);
          break; // done with this line
        } else if (ch === '/' && next === '*') {
          currentLineFragment += '/*';
          inBlockComment = true;
          i++; // skip '*'
        } else if (ch === "'") {
          currentLineFragment += ch;
          inString = true;
        } else {
          currentLineFragment += ch;
        }
      }
    }

    // Add the line fragment to the current segment (skip if line was fully consumed by semicolon split)
    if (!lineFullyConsumed) {
      if (currentSegmentLines.length === 0 && currentSegmentStartLine === lineIdx) {
        // This is the first line of a new segment (started on this line after a semicolon)
        currentSegmentLines.push(currentLineFragment);
      } else {
        currentSegmentLines.push(currentLineFragment);
      }
    }
  }

  // Add the final segment (trailing text after last separator)
  if (currentSegmentLines.length > 0) {
    const segmentText = currentSegmentLines.join('\n');
    segments.push({
      text: segmentText,
      startLineInBatch: currentSegmentStartLine,
      endLineInBatch: batchLines.length - 1,
    });
  }

  return segments;
}

/**
 * Computes the actual start and end lines of a segment by trimming leading/trailing
 * whitespace-only lines and adjusting offsets accordingly.
 */
function trimSegmentLines(
  segment: RawSegment,
  batchLines: string[],
  batchStartLine: number
): { startLine: number; endLine: number; text: string } | null {
  // Check if the segment is whitespace-only
  if (segment.text.trim().length === 0) {
    return null;
  }

  // Check if the segment contains only comments and whitespace (no actual SQL)
  if (!hasNonCommentContent(segment.text)) {
    return null;
  }

  // Split the segment text into its constituent lines to find actual content boundaries
  const segLines = segment.text.split('\n');

  // Find first non-whitespace line
  let firstContentLine = 0;
  while (firstContentLine < segLines.length && segLines[firstContentLine].trim().length === 0) {
    firstContentLine++;
  }

  // Find last non-whitespace line
  let lastContentLine = segLines.length - 1;
  while (lastContentLine >= 0 && segLines[lastContentLine].trim().length === 0) {
    lastContentLine--;
  }

  if (firstContentLine > lastContentLine) {
    return null; // all whitespace
  }

  const startLine = batchStartLine + segment.startLineInBatch + firstContentLine;
  const endLine = batchStartLine + segment.startLineInBatch + lastContentLine;
  const text = segLines.slice(firstContentLine, lastContentLine + 1).join('\n');

  return { startLine, endLine, text };
}

/**
 * Parses a SQL document into statement boundaries.
 *
 * 1. Splits on GO using batchSplitter rules (preserving line offsets)
 * 2. Within each batch, splits on semicolons respecting string literals,
 *    block comments, and single-line comments
 * 3. Trims whitespace-only segments
 * 4. Tracks line numbers relative to the full document (0-based)
 * 5. Assigns batchIndex (1-based) and statementIndex (1-based within batch)
 */
export function parseStatements(documentText: string): StatementBoundary[] {
  if (!documentText || documentText.trim().length === 0) {
    return [];
  }

  const batches = splitIntoBatches(documentText);
  const boundaries: StatementBoundary[] = [];

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const rawSegments = splitOnSemicolons(batch.lines);

    let statementIndex = 0;

    for (const segment of rawSegments) {
      const trimmed = trimSegmentLines(segment, batch.lines, batch.startLine);
      if (trimmed === null) {
        continue; // skip whitespace-only segments
      }

      statementIndex++;
      boundaries.push({
        startLine: trimmed.startLine,
        endLine: trimmed.endLine,
        text: trimmed.text,
        batchIndex: batchIdx + 1, // 1-based
        statementIndex, // 1-based within batch
      });
    }
  }

  return boundaries;
}

/**
 * Finds the statement boundary that contains the given cursor line.
 *
 * @param boundaries - Array of non-overlapping StatementBoundary objects
 * @param cursorLine - 0-based line number of the cursor
 * @returns The boundary whose [startLine, endLine] range contains the cursor line,
 *          or null if the cursor is on a line not covered by any boundary
 */
export function findStatementAtCursor(
  boundaries: StatementBoundary[],
  cursorLine: number
): StatementBoundary | null {
  for (const boundary of boundaries) {
    if (cursorLine >= boundary.startLine && cursorLine <= boundary.endLine) {
      return boundary;
    }
  }
  return null;
}
