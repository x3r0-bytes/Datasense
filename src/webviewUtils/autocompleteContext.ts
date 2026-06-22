/**
 * Autocomplete context detection and suggestion filtering for the Table Preview filter input.
 * Determines what type of suggestions to show based on cursor position and previous tokens,
 * then filters and orders suggestions accordingly.
 * Designed to be used both in webview inline scripts and in test files.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type SuggestionContext = 'column-start' | 'after-column' | 'after-operator' | 'general';

export interface SuggestionItem {
  text: string;
  category: 'column' | 'keyword' | 'function' | 'operator';
  detail?: string; // data type for columns
}

export interface ColumnItem {
  name: string;
  dataType: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Logical connectors that indicate the next token should be a column name */
const LOGICAL_CONNECTORS = new Set(['AND', 'OR', 'NOT']);

/** Single-character and multi-character comparison operators */
const COMPARISON_OPERATORS = new Set(['=', '<>', '>', '<', '>=', '<=']);

/** Word-based comparison operators (checked case-insensitively) */
const WORD_OPERATORS = new Set(['LIKE', 'IN', 'BETWEEN']);

/** Multi-word operators — the last word in these sequences */
const MULTI_WORD_OPERATOR_ENDINGS = new Set(['LIKE', 'IN', 'NULL']);

/** WHERE clause keywords for autocomplete suggestions */
const WHERE_KEYWORDS: readonly string[] = [
  'AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN', 'IS NULL', 'IS NOT NULL', 'EXISTS'
];

/** SQL functions for autocomplete suggestions */
const AUTOCOMPLETE_FUNCTIONS: readonly string[] = [
  'LEN', 'UPPER', 'LOWER', 'CAST', 'CONVERT', 'ISNULL', 'COALESCE',
  'GETDATE', 'DATEADD', 'DATEDIFF'
];

/** Comparison operators shown in the after-column context */
const COMPARISON_OPERATOR_SUGGESTIONS: readonly string[] = [
  '=', '<>', '>', '<', '>=', '<=', 'LIKE', 'NOT LIKE', 'IN', 'NOT IN',
  'BETWEEN', 'IS NULL', 'IS NOT NULL'
];

/** Maximum number of visible suggestions */
const MAX_SUGGESTIONS = 10;

// ─── Context Detection ────────────────────────────────────────────────────────

/**
 * Determines the suggestion context based on cursor position and surrounding text.
 *
 * Logic:
 * 1. Extract text before cursor, split by whitespace
 * 2. If at start → 'column-start'
 * 3. If previous token is AND/OR/NOT → 'column-start'
 * 4. If previous token matches a column name (case-insensitive) → 'after-column'
 * 5. If previous token is a comparison operator → 'after-operator'
 * 6. Otherwise → 'general'
 */
export function detectSuggestionContext(
  text: string,
  cursorPos: number,
  columns: ColumnItem[]
): SuggestionContext {
  const textBeforeCursor = text.substring(0, cursorPos);
  const trimmed = textBeforeCursor.trimEnd();

  // If nothing meaningful before cursor → column-start
  if (trimmed.length === 0) {
    return 'column-start';
  }

  // Split by whitespace to get tokens
  const tokens = trimmed.split(/\s+/);
  const lastToken = tokens[tokens.length - 1];
  const lastTokenUpper = lastToken.toUpperCase();

  // Check if last token is a logical connector → column-start
  if (LOGICAL_CONNECTORS.has(lastTokenUpper)) {
    return 'column-start';
  }

  // Check if last token matches a column name (case-insensitive)
  const columnNames = new Set(columns.map(c => c.name.toUpperCase()));
  if (columnNames.has(lastTokenUpper)) {
    return 'after-column';
  }

  // Check if last token is a comparison operator (symbol-based)
  if (COMPARISON_OPERATORS.has(lastToken)) {
    return 'after-operator';
  }

  // Check for word-based operators (LIKE, IN, BETWEEN) — but NOT when they are
  // part of multi-word operators like "NOT LIKE" or "NOT IN" (those still resolve to after-operator)
  if (WORD_OPERATORS.has(lastTokenUpper)) {
    return 'after-operator';
  }

  // Check for multi-word operators: "NOT LIKE", "NOT IN", "IS NULL", "IS NOT NULL"
  // If the last token is "NULL" and second-to-last is "IS" or "NOT" → this is a completed value, general
  // If the last token is "NOT" preceded by "IS" → could be part of "IS NOT NULL", but NOT alone triggers column-start (handled above)
  if (lastTokenUpper === 'NULL' && tokens.length >= 2) {
    const prevToken = tokens[tokens.length - 2].toUpperCase();
    if (prevToken === 'IS' || prevToken === 'NOT') {
      // "IS NULL" or "IS NOT NULL" is a completed expression → next should be column-start (like after AND/OR)
      return 'column-start';
    }
  }

  return 'general';
}

// ─── Suggestion Filtering ─────────────────────────────────────────────────────

/**
 * Builds and filters suggestions based on the current context and typed prefix.
 *
 * - In 'column-start' context: columns first, then keywords and functions
 * - In 'after-column' context: only comparison operators
 * - In 'after-operator' context: functions and column names
 * - In 'general' context: all (columns, keywords, functions)
 *
 * Filters by case-insensitive starts-with matching on prefix.
 * Returns empty array when:
 *   - prefix matches zero suggestions (dismiss signal)
 *   - user types a literal value start (digit, single-quote, minus) in after-operator context
 * Limits to MAX_SUGGESTIONS (10) items.
 */
export function filterSuggestions(
  prefix: string,
  context: SuggestionContext,
  columns: ColumnItem[]
): SuggestionItem[] {
  // Dismiss when user types a literal value start in after-operator context
  if (context === 'after-operator' && prefix.length > 0) {
    const firstChar = prefix[0];
    if (firstChar === "'" || firstChar === '-' || (firstChar >= '0' && firstChar <= '9')) {
      return [];
    }
  }

  let candidates: SuggestionItem[];

  switch (context) {
    case 'column-start':
      candidates = [
        ...buildColumnSuggestions(columns),
        ...buildKeywordSuggestions(),
        ...buildFunctionSuggestions()
      ];
      break;

    case 'after-column':
      candidates = buildOperatorSuggestions();
      break;

    case 'after-operator':
      candidates = [
        ...buildFunctionSuggestions(),
        ...buildColumnSuggestions(columns)
      ];
      break;

    case 'general':
    default:
      candidates = [
        ...buildColumnSuggestions(columns),
        ...buildKeywordSuggestions(),
        ...buildFunctionSuggestions()
      ];
      break;
  }

  // Filter by case-insensitive starts-with matching
  const filtered = prefix.length > 0
    ? candidates.filter(item => item.text.toUpperCase().startsWith(prefix.toUpperCase()))
    : candidates;

  // Dismiss when zero matches
  if (filtered.length === 0) {
    return [];
  }

  // Limit to max visible suggestions
  return filtered.slice(0, MAX_SUGGESTIONS);
}

// ─── Suggestion Builders ──────────────────────────────────────────────────────

function buildColumnSuggestions(columns: ColumnItem[]): SuggestionItem[] {
  return columns.map(col => ({
    text: col.name,
    category: 'column' as const,
    detail: col.dataType
  }));
}

function buildKeywordSuggestions(): SuggestionItem[] {
  return WHERE_KEYWORDS.map(kw => ({
    text: kw,
    category: 'keyword' as const
  }));
}

function buildFunctionSuggestions(): SuggestionItem[] {
  return AUTOCOMPLETE_FUNCTIONS.map(fn => ({
    text: fn,
    category: 'function' as const
  }));
}

function buildOperatorSuggestions(): SuggestionItem[] {
  return COMPARISON_OPERATOR_SUGGESTIONS.map(op => ({
    text: op,
    category: 'operator' as const
  }));
}
