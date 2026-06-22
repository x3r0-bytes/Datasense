/**
 * Represents a batch region with its line boundaries and text content.
 */
export interface BatchRegion {
  /** 0-based line number of the first line in this batch */
  startLine: number;
  /** 0-based line number of the last line in this batch */
  endLine: number;
  /** The text content of the batch (lines joined with \n) */
  text: string;
}

/**
 * Splits SQL text into batches based on the GO batch separator,
 * returning line metadata for each batch region.
 *
 * GO must appear on its own line (only whitespace allowed before/after).
 * GO within single-quoted string literals or comments is NOT treated as a separator.
 *
 * Only non-empty batches (containing at least one non-whitespace character) are returned.
 * startLine and endLine are 0-based line numbers.
 */
export function splitBatchesWithLineInfo(sql: string): BatchRegion[] {
  const lines = sql.split(/\r?\n/);
  const regions: BatchRegion[] = [];
  let batchStartLine = 0;
  let currentBatch: string[] = [];

  let inBlockComment = false;
  let inString = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inBlockComment && !inString) {
      if (/^\s*GO\s*$/i.test(line)) {
        const batchText = currentBatch.join('\n');
        if (batchText.trim().length > 0) {
          regions.push({
            startLine: batchStartLine,
            endLine: i - 1,
            text: batchText,
          });
        }
        currentBatch = [];
        batchStartLine = i + 1;
        continue;
      }
    }

    currentBatch.push(line);

    updateParserState(line, { inBlockComment, inString }, (state) => {
      inBlockComment = state.inBlockComment;
      inString = state.inString;
    });
  }

  // Add the final batch
  const batchText = currentBatch.join('\n');
  if (batchText.trim().length > 0) {
    regions.push({
      startLine: batchStartLine,
      endLine: lines.length - 1,
      text: batchText,
    });
  }

  return regions;
}

/**
 * Splits SQL text into batches based on the GO batch separator.
 *
 * GO must appear on its own line (only whitespace allowed before/after).
 * GO within single-quoted string literals or comments is NOT treated as a separator.
 */
export function splitBatches(sql: string): string[] {
  const lines = sql.split(/\r?\n/);
  const batches: string[] = [];
  let currentBatch: string[] = [];

  let inBlockComment = false;
  let inString = false;

  for (const line of lines) {
    // Determine if this line is a GO separator by checking context
    // We need to track whether we're inside a block comment or string literal
    // that spans across lines.

    if (!inBlockComment && !inString) {
      // Check if this line is a standalone GO separator
      if (/^\s*GO\s*$/i.test(line)) {
        const batchText = currentBatch.join('\n');
        if (batchText.trim().length > 0) {
          batches.push(batchText);
        }
        currentBatch = [];
        continue;
      }
    }

    // Add line to current batch
    currentBatch.push(line);

    // Update state by scanning the line character by character
    updateParserState(line, { inBlockComment, inString }, (state) => {
      inBlockComment = state.inBlockComment;
      inString = state.inString;
    });
  }

  // Add the final batch
  const batchText = currentBatch.join('\n');
  if (batchText.trim().length > 0) {
    batches.push(batchText);
  }

  return batches;
}

interface ParserState {
  inBlockComment: boolean;
  inString: boolean;
}

/**
 * Scans a line character by character to update parser state
 * (tracking whether we end the line inside a block comment or string literal).
 */
function updateParserState(
  line: string,
  state: ParserState,
  onUpdate: (state: ParserState) => void
): void {
  let inBlockComment = state.inBlockComment;
  let inString = state.inString;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = i + 1 < line.length ? line[i + 1] : '';

    if (inBlockComment) {
      // Look for end of block comment
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++; // skip the '/'
      }
    } else if (inString) {
      // Look for end of string (single quote)
      if (ch === "'") {
        // Check for escaped quote ('')
        if (next === "'") {
          i++; // skip the escaped quote
        } else {
          inString = false;
        }
      }
    } else {
      // Normal context
      if (ch === '-' && next === '-') {
        // Single-line comment — rest of line is comment, state unchanged
        break;
      } else if (ch === '/' && next === '*') {
        inBlockComment = true;
        i++; // skip the '*'
      } else if (ch === "'") {
        inString = true;
      }
    }
  }

  onUpdate({ inBlockComment, inString });
}
