/**
 * Clause State Engine for the SQL Server Language Server.
 *
 * Models the canonical T-SQL clause order as a state transition table
 * and provides functions to determine valid successor clauses based on
 * the current clause state and which clauses are already present.
 */

/**
 * Canonical T-SQL clause states.
 */
export type ClauseState =
  | 'WITH'
  | 'SELECT'
  | 'FROM'
  | 'JOIN'
  | 'WHERE'
  | 'GROUP_BY'
  | 'HAVING'
  | 'ORDER_BY';

/**
 * Set of clause keywords already present in the current statement scope.
 */
export type ClausePresenceSet = Set<ClauseState>;

/**
 * The canonical T-SQL clause transition table.
 * Maps each clause state to its valid successor clause keywords.
 */
export const TRANSITION_TABLE: Readonly<Record<ClauseState, readonly string[]>> = {
  WITH:     ['SELECT'],
  SELECT:   ['FROM'],
  FROM:     ['JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN',
             'CROSS JOIN', 'WHERE', 'GROUP BY', 'ORDER BY'],
  JOIN:     ['JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN',
             'CROSS JOIN', 'ON', 'WHERE', 'GROUP BY', 'ORDER BY'],
  WHERE:    ['GROUP BY', 'ORDER BY'],
  GROUP_BY: ['HAVING', 'ORDER BY'],
  HAVING:   ['ORDER BY'],
  ORDER_BY: [],
};

/**
 * JOIN variant keywords that are never filtered from successors,
 * since multiple JOINs are valid within the same statement scope.
 */
const JOIN_VARIANTS = new Set([
  'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN',
]);

/**
 * Maps successor keyword strings to their corresponding ClauseState values
 * for presence-set lookup. JOIN variants all map to 'JOIN', and multi-word
 * clauses map to their underscore-separated form.
 */
const KEYWORD_TO_CLAUSE_STATE: Record<string, ClauseState> = {
  'SELECT': 'SELECT',
  'FROM': 'FROM',
  'JOIN': 'JOIN',
  'INNER JOIN': 'JOIN',
  'LEFT JOIN': 'JOIN',
  'RIGHT JOIN': 'JOIN',
  'FULL JOIN': 'JOIN',
  'CROSS JOIN': 'JOIN',
  'ON': 'JOIN', // ON is part of a JOIN clause scope
  'WHERE': 'WHERE',
  'GROUP BY': 'GROUP_BY',
  'HAVING': 'HAVING',
  'ORDER BY': 'ORDER_BY',
};

/**
 * Filters a list of successor keywords by removing those already present
 * in the clause presence set, except for JOIN variants which are never
 * filtered (multiple JOINs are valid in the same statement).
 *
 * @param successors - Array of keyword strings to filter
 * @param presenceSet - Clauses already present in the current scope
 * @returns Filtered array of keyword strings
 */
export function filterByPresence(
  successors: string[],
  presenceSet: ClausePresenceSet
): string[] {
  return successors.filter(keyword => {
    // JOIN variants are never filtered — multiple JOINs are valid
    if (JOIN_VARIANTS.has(keyword)) {
      return true;
    }

    // Map the keyword to its clause state and check presence
    const clauseState = KEYWORD_TO_CLAUSE_STATE[keyword];
    if (clauseState && presenceSet.has(clauseState)) {
      return false; // Already present — filter it out
    }

    return true; // Not present — keep it
  });
}

/**
 * Returns the valid successor keywords for a given clause state,
 * filtered by the current presence set.
 *
 * Rules:
 * - JOIN variants are never filtered (multiple JOINs are valid).
 * - All other clauses are removed if already present in the set.
 *
 * @param currentClause - The detected clause context
 * @param presenceSet - Clauses already present in the current scope
 * @returns Array of keyword strings that are valid successors
 */
export function getValidSuccessors(
  currentClause: ClauseState,
  presenceSet: ClausePresenceSet
): string[] {
  const successors = TRANSITION_TABLE[currentClause];
  return filterByPresence([...successors], presenceSet);
}

/**
 * Single-word clause keywords that we recognize.
 * Multi-word keywords (GROUP BY, ORDER BY, INNER JOIN, etc.) are handled
 * by matching the first word and then looking ahead for the second word.
 */
const SINGLE_WORD_CLAUSES: ReadonlyArray<{ word: string; state: ClauseState }> = [
  { word: 'WITH', state: 'WITH' },
  { word: 'SELECT', state: 'SELECT' },
  { word: 'FROM', state: 'FROM' },
  { word: 'WHERE', state: 'WHERE' },
  { word: 'HAVING', state: 'HAVING' },
];

/**
 * First words of multi-word clause keywords, mapped to their possible
 * second words and resulting clause states.
 */
const MULTI_WORD_FIRST: ReadonlyMap<string, ReadonlyArray<{ second: string; state: ClauseState }>> = new Map([
  ['GROUP', [{ second: 'BY', state: 'GROUP_BY' }]],
  ['ORDER', [{ second: 'BY', state: 'ORDER_BY' }]],
  ['INNER', [{ second: 'JOIN', state: 'JOIN' }]],
  ['LEFT', [{ second: 'JOIN', state: 'JOIN' }]],
  ['RIGHT', [{ second: 'JOIN', state: 'JOIN' }]],
  ['FULL', [{ second: 'JOIN', state: 'JOIN' }]],
  ['CROSS', [{ second: 'JOIN', state: 'JOIN' }]],
  ['JOIN', []], // Plain JOIN — no second word needed
]);

/** Lexer states for the character scanner */
const enum LexState {
  Normal,
  InString,
  InBlockComment,
  InLineComment,
}

/**
 * Checks if a character is a word boundary (not a valid identifier character).
 */
function isWordBoundary(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  // Valid SQL identifier chars: letters, digits, underscore, @, #
  return !/[a-zA-Z0-9_@#]/.test(ch);
}

/**
 * Extracts a word starting at position `pos` in the text (up to `limit`).
 * Returns the word in uppercase and its length, or null if no word starts there.
 */
function extractWord(text: string, pos: number, limit: number): { word: string; length: number } | null {
  if (pos >= limit) return null;
  const ch = text[pos];
  if (!ch || !/[a-zA-Z_@#]/.test(ch)) return null;

  let end = pos + 1;
  while (end < limit && /[a-zA-Z0-9_@#]/.test(text[end])) {
    end++;
  }
  return { word: text.slice(pos, end).toUpperCase(), length: end - pos };
}

/**
 * Skips whitespace starting at `pos` and returns the new position.
 */
function skipWhitespace(text: string, pos: number, limit: number): number {
  while (pos < limit && (text[pos] === ' ' || text[pos] === '\t' || text[pos] === '\r' || text[pos] === '\n')) {
    pos++;
  }
  return pos;
}

/**
 * Scans the current statement text up to the cursor position and returns
 * the set of clause keywords present in the current scope.
 *
 * Scope rules:
 * - Keywords inside string literals, comments, or parenthesized subqueries
 *   are excluded.
 * - When the cursor is inside a subquery or CTE body, only keywords within
 *   that scope are counted.
 *
 * @param statementText - SQL text from statement start to end of document
 * @param cursorOffset - Cursor position within statementText
 * @returns ClausePresenceSet for the innermost scope containing the cursor
 */
export function getClausePresenceSet(
  statementText: string,
  cursorOffset: number
): ClausePresenceSet {
  const limit = Math.min(cursorOffset, statementText.length);

  // We maintain a stack of presence sets for nested scopes.
  // Index 0 is the outermost (top-level) scope.
  // Each time we enter a parenthesized block, we push a new set.
  // Each time we leave one, we pop.
  const scopeStack: ClausePresenceSet[] = [new Set<ClauseState>()];

  let state = LexState.Normal;
  let i = 0;

  while (i < limit) {
    const ch = statementText[i];

    switch (state) {
      case LexState.InString: {
        // Inside a single-quoted string literal
        if (ch === "'") {
          // Check for escaped quote ('')
          if (i + 1 < limit && statementText[i + 1] === "'") {
            i += 2; // Skip escaped quote
          } else {
            // End of string
            state = LexState.Normal;
            i++;
          }
        } else {
          i++;
        }
        break;
      }

      case LexState.InBlockComment: {
        // Inside /* ... */
        if (ch === '*' && i + 1 < limit && statementText[i + 1] === '/') {
          state = LexState.Normal;
          i += 2;
        } else {
          i++;
        }
        break;
      }

      case LexState.InLineComment: {
        // Inside -- ... (until end of line)
        if (ch === '\n') {
          state = LexState.Normal;
          i++;
        } else {
          i++;
        }
        break;
      }

      case LexState.Normal: {
        // Check for start of block comment
        if (ch === '/' && i + 1 < limit && statementText[i + 1] === '*') {
          state = LexState.InBlockComment;
          i += 2;
          break;
        }

        // Check for start of line comment
        if (ch === '-' && i + 1 < limit && statementText[i + 1] === '-') {
          state = LexState.InLineComment;
          i += 2;
          break;
        }

        // Check for start of string literal (including N-prefixed)
        if (ch === "'") {
          state = LexState.InString;
          i++;
          break;
        }
        if ((ch === 'N' || ch === 'n') && i + 1 < limit && statementText[i + 1] === "'") {
          // N'...' string literal — check it's not part of a longer word
          if (i === 0 || isWordBoundary(statementText[i - 1])) {
            state = LexState.InString;
            i += 2; // Skip N and opening quote
            break;
          }
        }

        // Track parenthesis depth for scope isolation
        if (ch === '(') {
          scopeStack.push(new Set<ClauseState>());
          i++;
          break;
        }
        if (ch === ')') {
          if (scopeStack.length > 1) {
            scopeStack.pop();
          }
          i++;
          break;
        }

        // Try to match a keyword at the current position
        // Only match if we're at a word boundary (start of text or preceded by non-word char)
        if (i > 0 && !isWordBoundary(statementText[i - 1])) {
          i++;
          break;
        }

        const wordResult = extractWord(statementText, i, limit);
        if (!wordResult) {
          i++;
          break;
        }

        const { word, length: wordLen } = wordResult;

        // Check for multi-word keywords first
        const multiWordOptions = MULTI_WORD_FIRST.get(word);
        if (multiWordOptions !== undefined) {
          if (word === 'JOIN') {
            // Plain JOIN — no second word needed, just verify word boundary after
            if (isWordBoundary(statementText[i + wordLen])) {
              scopeStack[scopeStack.length - 1].add('JOIN');
            }
            i += wordLen;
            break;
          }

          // Look ahead for the second word
          let matched = false;
          const afterFirst = skipWhitespace(statementText, i + wordLen, limit);
          if (afterFirst < limit) {
            const secondResult = extractWord(statementText, afterFirst, limit);
            if (secondResult) {
              for (const option of multiWordOptions) {
                if (secondResult.word === option.second && isWordBoundary(statementText[afterFirst + secondResult.length])) {
                  scopeStack[scopeStack.length - 1].add(option.state);
                  i = afterFirst + secondResult.length;
                  matched = true;
                  break;
                }
              }
            }
          }

          if (!matched) {
            // The first word didn't form a multi-word keyword.
            // For words like FULL, LEFT, RIGHT, INNER, CROSS — they aren't
            // standalone clause keywords, so just skip past them.
            i += wordLen;
          }
          break;
        }

        // Check for single-word clause keywords
        let foundSingle = false;
        for (const clause of SINGLE_WORD_CLAUSES) {
          if (word === clause.word && isWordBoundary(statementText[i + wordLen])) {
            scopeStack[scopeStack.length - 1].add(clause.state);
            foundSingle = true;
            break;
          }
        }

        i += wordLen;
        if (foundSingle) break;

        break;
      }
    }
  }

  // Return the innermost scope (top of stack)
  return scopeStack[scopeStack.length - 1];
}
