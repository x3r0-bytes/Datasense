/**
 * Dynamic SQL Parser for IntelliSense inside EXEC() and sp_executesql strings.
 *
 * Detects when the cursor is inside a dynamic SQL string literal, extracts
 * the SQL content (unescaping paired quotes), handles variable concatenation
 * boundaries, and returns the relevant segment for context detection.
 */

/**
 * Context information about a dynamic SQL string at the cursor position.
 */
export interface DynamicSqlContext {
  /** Whether the cursor is inside a dynamic SQL string */
  isDynamicSql: boolean;
  /** The extracted SQL text (with quotes unescaped) */
  extractedSql: string;
  /** Cursor offset within the extracted SQL */
  cursorOffset: number;
  /** Whether the string contains variable concatenation boundaries */
  hasVariables: boolean;
}

/**
 * Detects if the cursor is inside a string literal argument to EXEC() or sp_executesql.
 *
 * Detection logic:
 * 1. Scan backward from cursor to find if we're inside a string literal (track quote parity)
 * 2. If inside a string, scan further back to find `EXEC(` or `sp_executesql`
 * 3. Extract the string content, unescape `''` → `'`
 * 4. If the string contains `' + @variable + '` patterns, split at boundaries
 * 5. Determine which segment contains the cursor
 * 6. Handle N-prefixed strings (N'...')
 * 7. Return null if not inside a dynamic SQL string
 *
 * @param fullText - The complete document text
 * @param cursorOffset - The cursor position (0-based character offset)
 * @returns DynamicSqlContext if inside a dynamic SQL string, null otherwise
 */
export function detectDynamicSqlContext(
  fullText: string,
  cursorOffset: number
): DynamicSqlContext | null {
  // Step 1: Find if cursor is inside a string literal by scanning backward
  const stringInfo = findEnclosingStringLiteral(fullText, cursorOffset);
  if (!stringInfo) {
    return null;
  }

  // Step 2: Check if this string is an argument to EXEC() or sp_executesql
  const textBeforeString = fullText.substring(0, stringInfo.outerStart);
  if (!isDynamicSqlCall(textBeforeString)) {
    return null;
  }

  // Step 3: Extract the full concatenated string content (handling ' + @var + ' boundaries)
  const rawContent = fullText.substring(stringInfo.contentStart, stringInfo.contentEnd);
  const cursorInContent = cursorOffset - stringInfo.contentStart;

  // Step 4: Check for variable concatenation boundaries
  const fullConcatenated = extractFullConcatenatedString(fullText, stringInfo);
  const hasVariables = fullConcatenated.hasVariables;

  if (hasVariables) {
    // Split at variable boundaries and find the segment containing the cursor
    const segmentResult = extractSegmentAtCursor(rawContent, cursorInContent);
    const unescaped = unescapeSqlString(segmentResult.segment);
    // Adjust cursor offset for unescaping
    const adjustedOffset = adjustOffsetForUnescaping(
      segmentResult.segment,
      segmentResult.segmentOffset
    );

    return {
      isDynamicSql: true,
      extractedSql: unescaped,
      cursorOffset: adjustedOffset,
      hasVariables: true,
    };
  }

  // No variable boundaries — use the entire string content
  const unescaped = unescapeSqlString(rawContent);
  const adjustedOffset = adjustOffsetForUnescaping(rawContent, cursorInContent);

  return {
    isDynamicSql: true,
    extractedSql: unescaped,
    cursorOffset: adjustedOffset,
    hasVariables: false,
  };
}

/**
 * Unescapes paired single quotes ('') to single quotes (').
 *
 * In T-SQL string literals, a single quote is represented by two consecutive
 * single quotes. This function converts them back to single quotes.
 *
 * @param escaped - The escaped string content (without surrounding quotes)
 * @returns The unescaped string
 */
export function unescapeSqlString(escaped: string): string {
  return escaped.replace(/''/g, "'");
}

/**
 * Splits a dynamic SQL string at variable concatenation boundaries
 * (`' + @var + '`) and returns the segment containing the cursor.
 *
 * Variable boundaries look like: `' + @variableName + '`
 * The pattern matches the closing quote, plus sign, @variable, plus sign,
 * and opening quote of the next segment.
 *
 * @param sqlText - The raw string content (between quotes, may contain escaped quotes)
 * @param cursorOffset - The cursor position within the sqlText
 * @returns The segment containing the cursor and the cursor's offset within that segment
 */
export function extractSegmentAtCursor(
  sqlText: string,
  cursorOffset: number
): { segment: string; segmentOffset: number } {
  // Pattern to match variable concatenation boundaries within the string content.
  // Inside the string, a boundary looks like: ' + @var + '
  // But since we're looking at the content BETWEEN the outer quotes,
  // the boundary pattern is: '' + @var + ''
  // (because the quotes adjacent to + are escaped as '' within the string literal)
  //
  // However, when the string is built with concatenation, the actual text in the
  // document between the outer quotes of each segment doesn't contain the boundary.
  // The boundary exists OUTSIDE the string segments.
  //
  // For content within a single string literal that conceptually represents
  // concatenation, we look for the pattern: '' + @identifier + ''
  // This represents where a variable would be spliced in.
  const boundaryPattern = /''\s*\+\s*@[a-zA-Z_][a-zA-Z0-9_]*\s*\+\s*''/g;

  const boundaries: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = boundaryPattern.exec(sqlText)) !== null) {
    boundaries.push({ start: match.index, end: match.index + match[0].length });
  }

  if (boundaries.length === 0) {
    // No boundaries found — return the entire text as one segment
    return { segment: sqlText, segmentOffset: cursorOffset };
  }

  // Find which segment the cursor is in
  let segmentStart = 0;

  for (const boundary of boundaries) {
    if (cursorOffset <= boundary.start) {
      // Cursor is before this boundary — it's in the current segment
      const segment = sqlText.substring(segmentStart, boundary.start);
      return { segment, segmentOffset: cursorOffset - segmentStart };
    }
    // Move past this boundary to the next segment
    segmentStart = boundary.end;
  }

  // Cursor is after the last boundary
  const segment = sqlText.substring(segmentStart);
  return { segment, segmentOffset: cursorOffset - segmentStart };
}

// --- Internal Helper Functions ---

/**
 * Information about a string literal found in the text.
 */
interface StringLiteralInfo {
  /** Start of the entire string expression (including N prefix if present) */
  outerStart: number;
  /** Start of the string content (after the opening quote) */
  contentStart: number;
  /** End of the string content (before the closing quote, or end of text if unclosed) */
  contentEnd: number;
  /** Whether the string has an N prefix */
  isNPrefixed: boolean;
}

/**
 * Scans the text to find if the cursor is inside a string literal.
 * Tracks quote parity to determine if the cursor position is within quotes.
 *
 * @param text - The full document text
 * @param cursorOffset - The cursor position
 * @returns StringLiteralInfo if cursor is inside a string, null otherwise
 */
function findEnclosingStringLiteral(
  text: string,
  cursorOffset: number
): StringLiteralInfo | null {
  let i = 0;

  while (i < text.length) {
    // Skip single-line comments
    if (text[i] === '-' && i + 1 < text.length && text[i + 1] === '-') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end + 1;
      continue;
    }

    // Skip multi-line comments
    if (text[i] === '/' && i + 1 < text.length && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }

    // Check for N-prefixed string literal
    const isNPrefix = (text[i] === 'N' || text[i] === 'n') &&
      i + 1 < text.length && text[i + 1] === '\'';

    if (isNPrefix || text[i] === '\'') {
      const outerStart = i;
      const quoteStart = isNPrefix ? i + 2 : i + 1;
      let j = quoteStart;

      // Scan forward to find the end of the string literal
      while (j < text.length) {
        if (text[j] === '\'') {
          if (j + 1 < text.length && text[j + 1] === '\'') {
            j += 2; // Escaped quote — skip both
          } else {
            // End of string literal
            break;
          }
        } else {
          j++;
        }
      }

      // Check if cursor is inside this string literal
      if (cursorOffset >= quoteStart && cursorOffset <= j) {
        // j is at the closing quote position (or end of text if unclosed)
        if (j >= text.length) {
          // Unclosed string — cursor might still be inside
          return {
            outerStart,
            contentStart: quoteStart,
            contentEnd: text.length,
            isNPrefixed: isNPrefix,
          };
        }
        return {
          outerStart,
          contentStart: quoteStart,
          contentEnd: j,
          isNPrefixed: isNPrefix,
        };
      }

      // Move past this string literal
      i = j < text.length ? j + 1 : j;
    } else {
      i++;
    }
  }

  return null;
}

/**
 * Checks if the text before a string literal indicates a dynamic SQL call.
 * Looks for EXEC(, EXECUTE(, or sp_executesql patterns.
 *
 * @param textBefore - The text before the string literal's opening quote
 * @returns true if this is a dynamic SQL call context
 */
function isDynamicSqlCall(textBefore: string): boolean {
  // Trim trailing whitespace for matching
  const trimmed = textBefore.trimEnd();

  // Match EXEC( or EXECUTE( — the string is the argument inside parens
  // Pattern: EXEC/EXECUTE followed by optional whitespace and opening paren,
  // possibly with other content before the string
  if (/\b(?:EXEC|EXECUTE)\s*\(/i.test(trimmed)) {
    // Verify we're inside the parens (no closing paren after the opening)
    const lastExecParen = findLastExecOpenParen(trimmed);
    if (lastExecParen !== -1) {
      // Check there's no unmatched closing paren between the EXEC( and our position
      const afterParen = trimmed.substring(lastExecParen + 1);
      if (!hasUnmatchedCloseParen(afterParen)) {
        return true;
      }
    }
  }

  // Match sp_executesql — the string is the first argument after the procedure name
  // Pattern: EXEC/EXECUTE sp_executesql <whitespace> [N]'
  // Or just: sp_executesql <whitespace> [N]'
  if (/\b(?:(?:EXEC|EXECUTE)\s+)?sp_executesql\s+$/i.test(trimmed) ||
      /\b(?:(?:EXEC|EXECUTE)\s+)?sp_executesql\s+N?$/i.test(trimmed)) {
    return true;
  }

  // Also match when sp_executesql is followed by optional N prefix
  // e.g., "EXEC sp_executesql N" or "EXEC sp_executesql "
  if (/\b(?:(?:EXEC|EXECUTE)\s+)?sp_executesql\s+N?\s*$/i.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Finds the position of the last EXEC/EXECUTE opening parenthesis.
 */
function findLastExecOpenParen(text: string): number {
  const pattern = /\b(?:EXEC|EXECUTE)\s*\(/gi;
  let lastMatch = -1;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    lastMatch = match.index + match[0].length - 1; // Position of the '('
  }

  return lastMatch;
}

/**
 * Checks if a text fragment has an unmatched closing parenthesis.
 * This indicates we've exited the EXEC() call.
 */
function hasUnmatchedCloseParen(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') {
      depth++;
    } else if (text[i] === ')') {
      if (depth === 0) {
        return true; // Unmatched close paren
      }
      depth--;
    }
    // Skip string literals to avoid counting parens inside strings
    else if (text[i] === '\'') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\'') {
          if (j + 1 < text.length && text[j + 1] === '\'') {
            j += 2;
          } else {
            break;
          }
        } else {
          j++;
        }
      }
      i = j;
    }
  }
  return false;
}

/**
 * Extracts information about the full concatenated string expression,
 * detecting if variable boundaries exist in the broader expression.
 *
 * Looks at the text around the string literal to detect patterns like:
 * 'SELECT ...' + @var + 'WHERE ...'
 */
function extractFullConcatenatedString(
  fullText: string,
  stringInfo: StringLiteralInfo
): { hasVariables: boolean } {
  // Check for variable concatenation patterns in the content itself
  // Inside a single string literal, variables appear as: '' + @var + ''
  const content = fullText.substring(stringInfo.contentStart, stringInfo.contentEnd);
  const internalBoundary = /''\s*\+\s*@[a-zA-Z_][a-zA-Z0-9_]*\s*\+\s*''/;
  if (internalBoundary.test(content)) {
    return { hasVariables: true };
  }

  // Also check for concatenation outside the string literal
  // Pattern before: ... + ' (our string starts here)
  // Pattern after: ' + @var + ' (continues after our string)
  const textAfterString = fullText.substring(stringInfo.contentEnd + 1); // +1 to skip closing quote
  const textBeforeString = fullText.substring(0, stringInfo.outerStart);

  // Check if there's a + @var pattern after the closing quote
  const afterPattern = /^\s*\+\s*@[a-zA-Z_][a-zA-Z0-9_]*/;
  // Check if there's a @var + pattern before the opening quote
  const beforePattern = /@[a-zA-Z_][a-zA-Z0-9_]*\s*\+\s*$/;

  if (afterPattern.test(textAfterString) || beforePattern.test(textBeforeString)) {
    return { hasVariables: true };
  }

  return { hasVariables: false };
}

/**
 * Adjusts a cursor offset to account for unescaping of paired single quotes.
 * When '' becomes ', each pair before the cursor reduces the offset by 1.
 *
 * @param escaped - The escaped string
 * @param offset - The cursor offset in the escaped string
 * @returns The adjusted offset in the unescaped string
 */
function adjustOffsetForUnescaping(escaped: string, offset: number): number {
  let adjustment = 0;
  let i = 0;

  while (i < offset && i < escaped.length) {
    if (escaped[i] === '\'' && i + 1 < escaped.length && escaped[i + 1] === '\'') {
      adjustment++;
      i += 2;
    } else {
      i++;
    }
  }

  return offset - adjustment;
}
