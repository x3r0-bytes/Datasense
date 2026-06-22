/**
 * GROUP BY Analyzer for the SQL Server Language Server.
 *
 * Parses the SELECT list to identify aggregated vs. non-aggregated columns,
 * and generates GROUP BY clause content. Used by the CompletionProvider to
 * offer auto-populated GROUP BY suggestions and by the CodeAction provider
 * to insert GROUP BY clauses.
 */

import { FULL_AGGREGATE_FUNCTIONS } from './aggregationContextDetector';

/**
 * A column reference found in the SELECT list.
 */
export interface SelectListColumn {
  /** The full column expression as written (e.g., "o.CustomerID") */
  expression: string;
  /** Whether this column is wrapped inside an aggregate function */
  isAggregated: boolean;
  /** The alias if one was specified (e.g., "Name" from "col AS Name") */
  alias: string | null;
}

/**
 * Result of analyzing a SELECT list for aggregation patterns.
 */
export interface SelectListAnalysis {
  /** All column references in the SELECT list */
  columns: SelectListColumn[];
  /** Whether the SELECT list contains at least one aggregate function */
  hasAggregates: boolean;
  /** Non-aggregated column expressions that need GROUP BY */
  nonAggregatedExpressions: string[];
  /** Whether a GROUP BY clause is needed (has both aggregates and non-aggregated cols) */
  needsGroupBy: boolean;
}

/**
 * Analyzes the SELECT list of a SQL statement to identify which columns
 * are aggregated and which are not.
 *
 * Parsing rules:
 * - Splits SELECT list by commas (respecting parenthesis nesting)
 * - Identifies aggregate function calls by matching FULL_AGGREGATE_FUNCTIONS
 * - Handles aliased expressions: uses the original expression, not the alias
 * - Handles expressions with operators (col1 + col2): all column refs are non-aggregated
 * - Ignores literals, *, and computed expressions without column references
 *
 * @param statementText - The full SQL statement text
 * @returns SelectListAnalysis
 */
export function analyzeSelectList(statementText: string): SelectListAnalysis {
  const failureResult: SelectListAnalysis = {
    columns: [],
    hasAggregates: false,
    nonAggregatedExpressions: [],
    needsGroupBy: false,
  };

  if (!statementText || statementText.trim().length === 0) {
    return failureResult;
  }

  try {
    // Step 1: Find SELECT keyword position (case-insensitive)
    const selectMatch = statementText.match(/\bSELECT\b/i);
    if (!selectMatch || selectMatch.index === undefined) {
      return failureResult;
    }
    const selectEnd = selectMatch.index + selectMatch[0].length;

    // Check for DISTINCT/TOP after SELECT
    const afterSelect = statementText.substring(selectEnd);
    const distinctTopMatch = afterSelect.match(/^\s+(?:DISTINCT\s+)?(?:TOP\s+\d+\s+)?/i);
    const selectListStart = selectEnd + (distinctTopMatch ? distinctTopMatch[0].length : 0);

    // Step 2: Find FROM keyword position (end of select list)
    const fromIndex = findTopLevelKeyword(statementText, 'FROM', selectListStart);
    if (fromIndex === -1) {
      return failureResult;
    }

    // Step 3: Extract text between SELECT and FROM
    const selectListText = statementText.substring(selectListStart, fromIndex).trim();
    if (selectListText.length === 0) {
      return failureResult;
    }

    // Step 4: Split by commas (respecting nested parentheses)
    const expressions = splitByComma(selectListText);

    // Step 5: Classify each expression
    const columns: SelectListColumn[] = [];
    let hasAggregates = false;
    const nonAggregatedExpressions: string[] = [];

    for (const rawExpr of expressions) {
      const trimmed = rawExpr.trim();
      if (trimmed.length === 0) continue;

      // Skip standalone * (SELECT *)
      if (trimmed === '*') continue;

      // Strip trailing alias
      const { expression, alias } = stripAlias(trimmed);

      // Check if the expression is wrapped in an aggregate function
      const isAggregated = isAggregateWrapped(expression);

      if (isAggregated) {
        hasAggregates = true;
      }

      columns.push({
        expression,
        isAggregated,
        alias,
      });

      if (!isAggregated) {
        nonAggregatedExpressions.push(expression);
      }
    }

    const needsGroupBy = hasAggregates && nonAggregatedExpressions.length > 0;

    return {
      columns,
      hasAggregates,
      nonAggregatedExpressions,
      needsGroupBy,
    };
  } catch {
    return failureResult;
  }
}

/**
 * Generates the GROUP BY column list string from non-aggregated expressions.
 * Preserves table alias qualification and original column order from SELECT.
 *
 * @param nonAggregatedExpressions - Column expressions needing GROUP BY
 * @returns Comma-separated GROUP BY column list (e.g., "o.CustomerID, o.OrderDate")
 */
export function buildGroupByColumnList(
  nonAggregatedExpressions: string[]
): string {
  return nonAggregatedExpressions.join(', ');
}

// --- Internal Helper Functions ---

/**
 * Finds the position of a top-level SQL keyword (not inside parentheses or strings).
 * Returns -1 if not found.
 */
function findTopLevelKeyword(text: string, keyword: string, startFrom: number): number {
  const upperText = text.toUpperCase();
  const upperKeyword = keyword.toUpperCase();
  let depth = 0;
  let inSingleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = startFrom; i < text.length; i++) {
    const ch = text[i];

    // Handle comments
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && i + 1 < text.length && text[i + 1] === '/') {
        inBlockComment = false;
        i++; // skip '/'
      }
      continue;
    }

    // Start of comments
    if (!inSingleQuote && ch === '-' && i + 1 < text.length && text[i + 1] === '-') {
      inLineComment = true;
      i++; // skip second '-'
      continue;
    }
    if (!inSingleQuote && ch === '/' && i + 1 < text.length && text[i + 1] === '*') {
      inBlockComment = true;
      i++; // skip '*'
      continue;
    }

    // Handle string literals
    if (ch === "'") {
      if (inSingleQuote) {
        // Check for escaped quote ''
        if (i + 1 < text.length && text[i + 1] === "'") {
          i++; // skip escaped quote
          continue;
        }
        inSingleQuote = false;
      } else {
        inSingleQuote = true;
      }
      continue;
    }

    if (inSingleQuote) continue;

    // Track parenthesis depth
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')') {
      depth--;
      continue;
    }

    // Only match at top level (depth === 0)
    if (depth === 0) {
      // Check if keyword matches at this position
      if (upperText.substring(i, i + upperKeyword.length) === upperKeyword) {
        // Verify word boundary before
        if (i > 0) {
          const before = text[i - 1];
          if (/\w/.test(before)) continue;
        }
        // Verify word boundary after
        const afterIdx = i + upperKeyword.length;
        if (afterIdx < text.length) {
          const after = text[afterIdx];
          if (/\w/.test(after)) continue;
        }
        return i;
      }
    }
  }

  return -1;
}

/**
 * Splits a SELECT list by commas, respecting nested parentheses.
 * Does not split on commas inside parentheses (e.g., function arguments).
 */
function splitByComma(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inSingleQuote = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === "'" && !inSingleQuote) {
      inSingleQuote = true;
      current += ch;
    } else if (ch === "'" && inSingleQuote) {
      // Check for escaped quote
      if (i + 1 < text.length && text[i + 1] === "'") {
        current += "''";
        i++;
      } else {
        inSingleQuote = false;
        current += ch;
      }
    } else if (inSingleQuote) {
      current += ch;
    } else if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  if (current.trim().length > 0) {
    parts.push(current);
  }

  return parts;
}

/**
 * Strips a trailing alias from a SELECT expression.
 * Handles both `expr AS alias` and `expr alias` patterns.
 * Returns the original expression and the alias (if any).
 */
function stripAlias(expr: string): { expression: string; alias: string | null } {
  const trimmed = expr.trim();

  // Check for explicit AS alias pattern
  // Match: expression AS alias (case-insensitive)
  const asMatch = trimmed.match(/^(.+?)\s+AS\s+(\[?[\w]+\]?)\s*$/i);
  if (asMatch) {
    return {
      expression: asMatch[1].trim(),
      alias: asMatch[2].replace(/^\[|\]$/g, ''),
    };
  }

  // Check for implicit alias (last word after space, not a keyword or operator)
  // Only match if the last token looks like an identifier and the expression
  // before it doesn't end with an operator or keyword
  const implicitMatch = trimmed.match(/^(.+?)\s+(\[?[a-zA-Z_][\w]*\]?)\s*$/);
  if (implicitMatch) {
    const beforeAlias = implicitMatch[1].trim();
    const possibleAlias = implicitMatch[2];

    // Don't treat SQL keywords as aliases
    const keywords = new Set([
      'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL',
      'LIKE', 'BETWEEN', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
      'AS', 'ON', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'CROSS',
      'GROUP', 'ORDER', 'BY', 'HAVING', 'UNION', 'ALL', 'DISTINCT',
      'TOP', 'INTO', 'VALUES', 'SET', 'UPDATE', 'DELETE', 'INSERT',
    ]);

    if (!keywords.has(possibleAlias.toUpperCase()) && !beforeAlias.endsWith('(')) {
      // Make sure the expression before the alias is valid
      // (ends with a closing paren, identifier, or bracket)
      const lastChar = beforeAlias[beforeAlias.length - 1];
      if (lastChar === ')' || /[\w\]]/.test(lastChar)) {
        return {
          expression: beforeAlias,
          alias: possibleAlias.replace(/^\[|\]$/g, ''),
        };
      }
    }
  }

  return { expression: trimmed, alias: null };
}

/**
 * Checks if an expression is entirely wrapped in an aggregate function.
 * An expression is considered aggregated if it starts with an aggregate
 * function name followed by '(' and the closing ')' matches the end.
 */
function isAggregateWrapped(expression: string): boolean {
  const trimmed = expression.trim();

  // Match pattern: FUNC_NAME(...)
  const funcMatch = trimmed.match(/^(\w+)\s*\(/);
  if (!funcMatch) return false;

  const funcName = funcMatch[1].toUpperCase();
  if (!FULL_AGGREGATE_FUNCTIONS.has(funcName)) return false;

  // Verify the opening paren's matching close paren is at the end
  const openParenIdx = trimmed.indexOf('(', funcMatch[1].length);
  if (openParenIdx === -1) return false;

  // Find the matching closing paren
  let depth = 0;
  for (let i = openParenIdx; i < trimmed.length; i++) {
    if (trimmed[i] === '(') depth++;
    else if (trimmed[i] === ')') {
      depth--;
      if (depth === 0) {
        // The matching close paren should be at or near the end
        // (allow trailing whitespace)
        return i === trimmed.length - 1 || trimmed.substring(i + 1).trim().length === 0;
      }
    }
  }

  return false;
}
