/**
 * Aggregation context detection for the SQL Server Language Server.
 *
 * Detects when the cursor is inside an aggregate function's parentheses
 * and identifies which function it is. Also exports the full set of
 * recognized aggregate functions used by other modules.
 */

/**
 * Result of detecting aggregation context at the cursor position.
 */
export interface AggregationContextResult {
  /** Whether the cursor is inside an aggregate function's parentheses */
  inAggregate: boolean;
  /** The aggregate function name (uppercase), e.g., "SUM", "COUNT" */
  functionName: string | null;
  /** Whether the aggregate function supports * as an argument */
  supportsWildcard: boolean;
  /** Whether the function requires numeric columns (SUM, AVG, STDEV, etc.) */
  prefersNumeric: boolean;
}

/**
 * Full set of recognized aggregate functions.
 */
export const FULL_AGGREGATE_FUNCTIONS: ReadonlySet<string> = new Set([
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
  'COUNT_BIG', 'STDEV', 'STDEVP', 'VAR', 'VARP',
  'STRING_AGG', 'CHECKSUM_AGG',
]);

/**
 * Aggregate functions that prefer numeric columns (rank them higher).
 */
export const NUMERIC_AGGREGATE_FUNCTIONS: ReadonlySet<string> = new Set([
  'SUM', 'AVG', 'STDEV', 'STDEVP', 'VAR', 'VARP',
]);

/**
 * Aggregate functions that support * as an argument.
 */
export const WILDCARD_AGGREGATE_FUNCTIONS: ReadonlySet<string> = new Set([
  'COUNT', 'COUNT_BIG',
]);

/**
 * Detects whether the cursor is inside an aggregate function's parentheses.
 * Scans backward from the cursor to find the nearest unmatched opening paren
 * preceded by an aggregate function name.
 *
 * Handles nested parentheses (e.g., SUM(CASE WHEN ... END)) by tracking
 * paren depth and only matching the outermost aggregate function.
 *
 * @param textBeforeCursor - SQL text from statement start to cursor
 * @returns AggregationContextResult
 */
export function detectAggregationContext(
  textBeforeCursor: string
): AggregationContextResult {
  // Placeholder implementation — will be fully implemented in task 1.1
  const defaultResult: AggregationContextResult = {
    inAggregate: false,
    functionName: null,
    supportsWildcard: false,
    prefersNumeric: false,
  };

  if (!textBeforeCursor || textBeforeCursor.trim().length === 0) {
    return defaultResult;
  }

  try {
    // Strip string literals and comments for safe scanning
    const cleaned = stripLiteralsAndComments(textBeforeCursor);

    // Scan backward from end to find unmatched opening paren preceded by aggregate function.
    // When nested parens exist inside the aggregate (e.g., SUM(CASE WHEN (...))),
    // we may encounter non-aggregate unmatched parens first. Continue scanning
    // backward to find the outermost aggregate function.
    let depth = 0;
    for (let i = cleaned.length - 1; i >= 0; i--) {
      const ch = cleaned[i];
      if (ch === ')') {
        depth++;
      } else if (ch === '(') {
        if (depth === 0) {
          // Found unmatched opening paren — extract preceding word
          const wordMatch = cleaned.substring(0, i).match(/(\w+)\s*$/);
          if (wordMatch) {
            const funcName = wordMatch[1].toUpperCase();
            if (FULL_AGGREGATE_FUNCTIONS.has(funcName)) {
              return {
                inAggregate: true,
                functionName: funcName,
                supportsWildcard: WILDCARD_AGGREGATE_FUNCTIONS.has(funcName),
                prefersNumeric: NUMERIC_AGGREGATE_FUNCTIONS.has(funcName),
              };
            }
          }
          // Not an aggregate function — continue scanning backward
          // to check if this paren is nested inside an outer aggregate
        } else {
          depth--;
        }
      }
    }

    return defaultResult;
  } catch {
    return defaultResult;
  }
}

/**
 * Strips string literals and comments from SQL text for safe parsing.
 * Replaces content with spaces to preserve character positions.
 */
function stripLiteralsAndComments(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    // Single-quoted string literal
    if (text[i] === "'") {
      result += ' ';
      i++;
      while (i < text.length) {
        if (text[i] === "'" && i + 1 < text.length && text[i + 1] === "'") {
          result += '  ';
          i += 2;
        } else if (text[i] === "'") {
          result += ' ';
          i++;
          break;
        } else {
          result += ' ';
          i++;
        }
      }
    }
    // Line comment
    else if (text[i] === '-' && i + 1 < text.length && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') {
        result += ' ';
        i++;
      }
    }
    // Block comment
    else if (text[i] === '/' && i + 1 < text.length && text[i + 1] === '*') {
      result += '  ';
      i += 2;
      while (i < text.length) {
        if (text[i] === '*' && i + 1 < text.length && text[i + 1] === '/') {
          result += '  ';
          i += 2;
          break;
        }
        result += ' ';
        i++;
      }
    }
    // Normal character
    else {
      result += text[i];
      i++;
    }
  }
  return result;
}
