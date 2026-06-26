/**
 * Completion context detection for the SQL Server Language Server.
 *
 * Determines the SQL clause context at the cursor position and extracts
 * table references from FROM/JOIN clauses in the current query.
 * Also provides context-aware completion items based on schema cache.
 */

import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
  Position,
  Range,
  TextEdit,
} from 'vscode-languageserver/node';

import { ColumnInfo, ISchemaCache, TableInfo, ViewInfo } from './schemaCache';
import { getJoinCompletions } from './joinGenerator';
import { resolveAlias, filterColumnsByPrefix, AliasResolution } from './aliasResolver';
import { resolveChainedCTEs, buildCTESchemaMap } from './cteResolver';
import {
  detectAggregationContext,
  FULL_AGGREGATE_FUNCTIONS,
  NUMERIC_AGGREGATE_FUNCTIONS,
  WILDCARD_AGGREGATE_FUNCTIONS,
} from './aggregationContextDetector';
import { analyzeSelectList, buildGroupByColumnList } from './groupByAnalyzer';
import {
  getClausePresenceSet as getClausePresenceSetFromEngine,
  getValidSuccessors,
  ClauseState,
  ClausePresenceSet as EngineClausePresenceSet,
} from './clauseStateEngine';
import { detectDynamicSqlContext, DynamicSqlContext } from './dynamicSqlParser';
import {
  getMatchingSnippets,
  detectSnippetContext,
  toCompletionItem,
  SNIPPET_DEFINITIONS,
} from './snippetLibrary';
import {
  detectCrossDatabaseReference,
  extractCrossDatabaseTableRefs,
  CrossDatabaseReference,
} from './crossDatabaseParser';
import { IMultiDatabaseCache } from './multiDatabaseCache';

// --- Relevance Ranking Constants ---

/**
 * Sort-text tier prefixes for the 4-tier ranking system.
 * Lower prefix = higher priority in the completion list.
 */
export const RANK_TIERS = {
  /** Tier 0: Required clause keywords (FROM after SELECT, ON after JOIN, etc.) */
  REQUIRED_KEYWORD: '0',
  /** Tier 1: Contextual columns and aliases */
  COLUMNS_AND_ALIASES: '1',
  /** Tier 2: Local table references (CTE names in FROM/JOIN) */
  LOCAL_REFERENCES: '2',
  /** Tier 3: Global schema objects (tables, views, procedures) */
  SCHEMA_OBJECTS: '3',
} as const;

/** Aggregate functions that get priority boost in SELECT context */
export const AGGREGATE_FUNCTIONS = new Set([
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
]);

/**
 * Numeric data types that support arithmetic aggregation (SUM, AVG, STDEV, etc.).
 */
export const NUMERIC_DATA_TYPES: ReadonlySet<string> = new Set([
  'int', 'bigint', 'smallint', 'tinyint',
  'decimal', 'numeric', 'money', 'smallmoney',
  'float', 'real',
]);

/**
 * Maps a CompletionContext value to the corresponding ClauseState
 * from the Clause State Engine. Returns null for contexts that don't
 * have a direct mapping (EXEC, CTE, UPDATE, DECLARE, NONE).
 */
export function contextToClauseState(context: CompletionContext): ClauseState | null {
  switch (context) {
    case 'SELECT': return 'SELECT';
    case 'FROM': return 'FROM';
    case 'JOIN': return 'JOIN';
    case 'WHERE': return 'WHERE';
    case 'GROUP_BY': return 'GROUP_BY';
    case 'HAVING': return 'HAVING';
    case 'ORDER_BY': return 'ORDER_BY';
    default: return null;
  }
}

/** Window functions that get secondary priority in SELECT context */
export const WINDOW_FUNCTIONS = new Set([
  'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE',
  'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE',
]);

/**
 * Applies the 4-tier ranking system to completion items.
 *
 * Sort text format: "{tier}_{label_lowercase}"
 *
 * Tier assignment rules (default / SELECT context):
 * - Tier 0: Keywords returned by getValidSuccessors() for the current context
 * - Tier 1: CompletionItems with kind=Field (columns) or kind=Function
 * - Tier 2: CTE name completions (detail="CTE")
 * - Tier 3: Schema objects (tables, views, procedures)
 *
 * Context-aware overrides:
 * - FROM context: Tables/views promoted to Tier 0, keywords demoted to Tier 2
 * - WHERE context: Columns stay at Tier 1, keywords demoted to Tier 2
 *
 * When no required keywords exist, tier 0 is empty and items use tiers 1-3.
 * Within each tier, items are sorted alphabetically by label (ascending).
 *
 * @param items - Completion items to rank
 * @param requiredKeywords - Keywords that should be tier 0 (from getValidSuccessors)
 * @param context - Optional SQL clause context for context-aware ranking adjustments
 * @returns Same items array with sortText assigned
 */
export function applyTieredRanking(
  items: CompletionItem[],
  requiredKeywords: string[],
  context?: CompletionContext
): CompletionItem[] {
  // Build a set of required keywords for fast case-insensitive lookup
  const requiredSet = new Set(requiredKeywords.map(k => k.toLowerCase()));

  for (const item of items) {
    const label = typeof item.label === 'string' ? item.label : '';
    const labelLower = label.toLowerCase();
    let tier: string;

    // Snippets from the snippet library already have their own sortText assigned
    // (elevated: "2_snippet_*", non-elevated: "3_snippet_*"). Preserve it.
    if (item.kind === CompletionItemKind.Snippet && item.detail === 'Snippet' && item.sortText) {
      continue;
    }

    // JOIN generator items already have their own sortText assigned
    // (FK items: "0_*", non-FK items: "1_*"). Preserve it when in JOIN context.
    if (context === 'JOIN' && item.kind === CompletionItemKind.Module && item.sortText &&
        item.insertTextFormat === InsertTextFormat.Snippet) {
      continue;
    }

    // --- Context-aware ranking for FROM ---
    if (context === 'FROM') {
      const isTableOrView = item.kind === CompletionItemKind.Module &&
        (item.detail === 'Table' || item.detail === 'View');

      if (item.detail === 'CTE') {
        // CTE names get Tier 0 in FROM context (local references, highest priority)
        tier = RANK_TIERS.REQUIRED_KEYWORD;
      } else if (isTableOrView) {
        // Tables/views get Tier 1 in FROM context (below CTEs, above keywords)
        tier = RANK_TIERS.COLUMNS_AND_ALIASES;
      } else if (requiredSet.size > 0 && requiredSet.has(labelLower)) {
        // Successor keywords demoted to Tier 2 in FROM context
        tier = RANK_TIERS.LOCAL_REFERENCES;
      } else if (item.kind === CompletionItemKind.Keyword) {
        // Other keywords demoted to Tier 3 in FROM context
        tier = RANK_TIERS.SCHEMA_OBJECTS;
      } else {
        tier = RANK_TIERS.SCHEMA_OBJECTS;
      }
    }
    // --- Context-aware ranking for WHERE ---
    else if (context === 'WHERE') {
      if (item.kind === CompletionItemKind.Field || item.kind === CompletionItemKind.Function) {
        // Columns and functions stay at Tier 1 in WHERE context
        tier = RANK_TIERS.COLUMNS_AND_ALIASES;
      } else if (requiredSet.size > 0 && requiredSet.has(labelLower)) {
        // Successor keywords (AND, OR, GROUP BY, etc.) demoted to Tier 2 in WHERE context
        tier = RANK_TIERS.LOCAL_REFERENCES;
      } else if (item.kind === CompletionItemKind.Keyword) {
        // Other keywords also at Tier 2
        tier = RANK_TIERS.LOCAL_REFERENCES;
      } else if (item.detail === 'CTE') {
        tier = RANK_TIERS.LOCAL_REFERENCES;
      } else {
        tier = RANK_TIERS.SCHEMA_OBJECTS;
      }
    }
    // --- Default ranking (SELECT and all other contexts) ---
    else {
      // Tier 0: Keywords from getValidSuccessors (case-insensitive match)
      if (requiredSet.size > 0 && requiredSet.has(labelLower)) {
        tier = RANK_TIERS.REQUIRED_KEYWORD;
      }
      // Tier 1: Columns (Field), aliases, or functions
      else if (item.kind === CompletionItemKind.Field || item.kind === CompletionItemKind.Function) {
        tier = RANK_TIERS.COLUMNS_AND_ALIASES;
      }
      // Tier 2: CTE names (identified by detail="CTE")
      else if (item.detail === 'CTE') {
        tier = RANK_TIERS.LOCAL_REFERENCES;
      }
      // Tier 3: Everything else (schema objects — tables, views, procedures)
      else {
        tier = RANK_TIERS.SCHEMA_OBJECTS;
      }
    }

    item.sortText = `${tier}_${labelLower}`;
  }

  return items;
}

// --- Context-Based Item Filtering ---

/**
 * Options for context-based item filtering.
 */
export interface ContextFilterOptions {
  /** Whether the current prefix is alias-dot qualified (e.g., "t.") */
  isAliasDotQualified?: boolean;
  /** Whether the current prefix is schema-dot qualified (e.g., "dbo.") */
  isSchemaDotQualified?: boolean;
  /** Whether a table reference has been typed after a JOIN keyword */
  isJoinWithTableRef?: boolean;
  /** Whether the current JOIN is a CROSS JOIN */
  isCrossJoin?: boolean;
  /** The prefix the user has typed (for keyword prefix override) */
  typedPrefix?: string;
  /** Required keywords from getValidSuccessors (tier 0 keywords) */
  requiredKeywords?: string[];
}

/**
 * Applies context-based filtering to completion items before ranking.
 *
 * Context filtering rules:
 *
 * FROM/JOIN context:
 *   Include: tables, views, CTE names, successor keywords
 *   Exclude: columns, functions (unless alias-dot qualified)
 *
 * SELECT/WHERE/GROUP_BY/ORDER_BY/HAVING context:
 *   Include: columns, functions, aliases, successor keywords
 *   Exclude: standalone table/view names (unless schema-dot qualified)
 *
 * Immediately after JOIN keyword (no table ref typed yet):
 *   Include: tables, views, CTE names
 *   Exclude: successor keywords (WHERE, ORDER BY, etc.)
 *
 * After JOIN + table reference + whitespace:
 *   Include: ON (tier 0), successor keywords
 *   Exclude: tables/views (user already specified the join target)
 *
 * CROSS JOIN context:
 *   Same as JOIN but ON is never suggested
 *
 * NONE context:
 *   Include: all keywords, functions
 *   Exclude: tier 0 keywords (no required keyword in NONE context)
 *
 * Prefix override:
 *   If user has typed ≥1 character matching a keyword prefix,
 *   that keyword is included regardless of context filtering.
 *
 * @param items - The completion items to filter
 * @param context - The detected SQL clause context
 * @param options - Additional filtering options
 * @returns Filtered array of completion items
 */
export function applyContextFilter(
  items: CompletionItem[],
  context: CompletionContext,
  options: ContextFilterOptions = {}
): CompletionItem[] {
  const {
    isAliasDotQualified = false,
    isSchemaDotQualified = false,
    isJoinWithTableRef = false,
    isCrossJoin = false,
    typedPrefix = '',
    requiredKeywords = [],
  } = options;

  // Build sets for fast lookup
  const requiredKeywordSet = new Set(requiredKeywords.map(k => k.toLowerCase()));

  return items.filter(item => {
    const label = typeof item.label === 'string' ? item.label : '';
    const labelLower = label.toLowerCase();

    // --- Prefix override ---
    // If user typed ≥1 char matching a keyword prefix, include that keyword regardless of context
    if (typedPrefix.length >= 1 && item.kind === CompletionItemKind.Keyword) {
      if (labelLower.startsWith(typedPrefix.toLowerCase())) {
        return true;
      }
    }

    // --- Classify the item ---
    const isColumn = item.kind === CompletionItemKind.Field;
    const isFunction = item.kind === CompletionItemKind.Function;
    const isKeyword = item.kind === CompletionItemKind.Keyword;
    const isSnippet = item.kind === CompletionItemKind.Snippet && item.detail === 'Snippet';
    const isTableOrView = item.kind === CompletionItemKind.Module &&
      (item.detail === 'Table' || item.detail === 'View');
    const isFKItem = item.kind === CompletionItemKind.Module &&
      typeof item.detail === 'string' && item.detail.startsWith('FK');
    const isCTEName = item.detail === 'CTE';
    const isRequiredKeyword = isKeyword && requiredKeywordSet.has(labelLower);

    // Snippets always pass through context filtering — they have their own sortText ranking
    if (isSnippet) {
      return true;
    }

    // --- Apply context-specific filtering ---
    switch (context) {
      case 'FROM':
      case 'JOIN': {
        // Special case: immediately after JOIN keyword (no table ref typed)
        if ((context === 'JOIN') && !isJoinWithTableRef && !isAliasDotQualified) {
          // Include only tables, views, CTE names, FK items; suppress all keywords
          if (isTableOrView || isCTEName || isFKItem) return true;
          // Exclude everything else (columns, functions, keywords)
          return false;
        }

        // Special case: after JOIN + table reference + whitespace
        if ((context === 'JOIN') && isJoinWithTableRef) {
          // Include ON (tier 0) and successor keywords; exclude tables/views
          if (isKeyword) {
            // For CROSS JOIN, never suggest ON
            if (isCrossJoin && labelLower === 'on') {
              return false;
            }
            return true;
          }
          // Exclude tables, views, CTE names (user already specified join target)
          if (isTableOrView || isCTEName || isFKItem) return false;
          // Exclude columns and functions too (not relevant after table ref)
          return false;
        }

        // General FROM/JOIN context
        // Include: tables, views, CTE names, FK items, successor keywords
        if (isTableOrView || isCTEName || isFKItem) return true;
        if (isKeyword) return true;
        // Exclude: columns and functions (unless alias-dot qualified)
        if (isColumn || isFunction) {
          return isAliasDotQualified;
        }
        return true;
      }

      case 'SELECT':
      case 'WHERE':
      case 'GROUP_BY':
      case 'ORDER_BY':
      case 'HAVING': {
        // Include: columns, functions, aliases, successor keywords
        if (isColumn || isFunction) return true;
        if (isKeyword) return true;
        if (isCTEName) return true; // CTE names can be used as aliases
        // Exclude: standalone table/view names (unless schema-dot qualified)
        if (isTableOrView) {
          return isSchemaDotQualified;
        }
        return true;
      }

      case 'NONE': {
        // Include: all keywords and functions; omit tier 0 keywords
        if (isRequiredKeyword) return false;
        if (isKeyword || isFunction) return true;
        // Include everything else (tables, views, columns, CTEs)
        return true;
      }

      default:
        // For other contexts (EXEC, CTE, UPDATE, DECLARE), pass through all items
        return true;
    }
  });
}

/**
 * Result of extracting the current batch from a document.
 */
export interface BatchScope {
  /** The text content of the current batch */
  text: string;
  /** The character offset in the document where this batch starts */
  startOffset: number;
}

/**
 * The SQL clause context the cursor is currently positioned in.
 */
export type CompletionContext =
  | 'FROM'
  | 'JOIN'
  | 'JOIN_ON'
  | 'SELECT'
  | 'WHERE'
  | 'ORDER_BY'
  | 'GROUP_BY'
  | 'HAVING'
  | 'EXEC'
  | 'CTE'
  | 'UPDATE'
  | 'INSERT'
  | 'ALTER_TABLE'
  | 'DECLARE'
  | 'NONE';

/**
 * Detailed JOIN context information returned by detectJoinContext().
 * Identifies the specific JOIN keyword variant when the cursor is in a JOIN context.
 */
export interface JoinContextInfo {
  type: 'join' | 'default';
  /** The specific JOIN keyword variant, e.g., 'INNER JOIN', 'LEFT OUTER JOIN' */
  joinType?: string;
}

/**
 * A table reference extracted from a FROM or JOIN clause.
 */
export interface TableReference {
  database?: string;
  schema?: string;
  name: string;
  alias?: string;
}

/**
 * Set of clause keywords already present in the current statement scope.
 * Used to suppress re-suggestion of already-present clauses.
 */
export type ClausePresenceSet = Set<'SELECT' | 'FROM' | 'JOIN' | 'WHERE' | 'GROUP_BY' | 'HAVING' | 'ORDER_BY'>;

/**
 * Information about CTE names available at the cursor position.
 */
export interface CTEChainInfo {
  /** Whether the cursor is inside a CTE chain context */
  inCTEChain: boolean;
  /** CTE names defined before the cursor position (available as table references) */
  availableNames: string[];
}

/**
 * Internal representation of a single CTE definition within a chain.
 */
interface CTEDefinition {
  /** The CTE identifier name */
  name: string;
  /** Character offset of the opening paren of the CTE body */
  bodyStart: number;
  /** Character offset of the closing paren of the CTE body (-1 if incomplete) */
  bodyEnd: number;
}

/**
 * @deprecated Use `getClausePresenceSet` from `clauseStateEngine.ts` instead.
 * This function is retained temporarily for backward compatibility with existing
 * contextual keyword logic. It will be removed once task 7.4 completes the full switchover.
 *
 * Scans the current statement backward from the cursor to identify
 * which clause keywords are already present.
 *
 * Respects subquery boundaries: clauses inside subqueries are not
 * included in the outer statement's presence set.
 *
 * @param statementText - The SQL text of the current statement (from delimiter to cursor)
 * @param cursorOffset - The cursor position within the statement text
 * @returns A set of clause keywords present in the current scope
 */
export function getClausePresenceSet(statementText: string, cursorOffset: number): ClausePresenceSet {
  const result: ClausePresenceSet = new Set();

  // Work with text up to the cursor position
  const textToCursor = statementText.substring(0, cursorOffset);

  // Strip literals and comments to avoid false keyword matches
  const cleaned = stripLiteralsAndComments(textToCursor);

  // Find the innermost scope containing the cursor by identifying
  // subquery boundaries. A subquery is a parenthesized block starting with SELECT.
  const scopeText = findInnermostScope(cleaned, cleaned.length);

  // Scan for clause keywords within the scope
  const clausePatterns: Array<{ key: ClausePresenceSet extends Set<infer T> ? T : never; regex: RegExp }> = [
    { key: 'SELECT', regex: /\bselect\b/gi },
    { key: 'FROM', regex: /\bfrom\b/gi },
    { key: 'JOIN', regex: /\b(?:inner\s+join|left\s+(?:outer\s+)?join|right\s+(?:outer\s+)?join|full\s+(?:outer\s+)?join|cross\s+join|join)\b/gi },
    { key: 'WHERE', regex: /\bwhere\b/gi },
    { key: 'GROUP_BY', regex: /\bgroup\s+by\b/gi },
    { key: 'HAVING', regex: /\bhaving\b/gi },
    { key: 'ORDER_BY', regex: /\border\s+by\b/gi },
  ];

  for (const { key, regex } of clausePatterns) {
    if (regex.test(scopeText)) {
      result.add(key);
    }
  }

  return result;
}

/**
 * Detects whether the cursor is inside a CTE chain and returns
 * the names of CTEs defined before the cursor position.
 *
 * A CTE chain is a WITH block containing one or more CTE definitions:
 *   WITH cte1 AS (...), cte2 AS (...), ... SELECT ...
 *
 * Distinguishes CTEs from table hints: WITH <identifier> AS (...) is a CTE,
 * while WITH (NOLOCK) is a table hint.
 *
 * @deprecated Use `resolveChainedCTEs()` from `cteResolver.ts` instead.
 * This function is kept temporarily for backward compatibility until task 7.4 cleanup.
 * The new resolver provides full column metadata in addition to CTE name detection.
 *
 * @param statementText - The full statement text containing the WITH block
 * @param cursorOffset - The cursor position within the statement
 * @returns CTEChainInfo with available CTE names
 */
export function detectCTEChain(statementText: string, cursorOffset: number): CTEChainInfo {
  const noChain: CTEChainInfo = { inCTEChain: false, availableNames: [] };

  // Strip literals and comments to avoid matching keywords inside strings/comments
  const cleaned = stripLiteralsAndComments(statementText);

  // Find the WITH keyword that starts the CTE block
  const withPattern = /\bwith\b/gi;
  let withMatch: RegExpExecArray | null;
  let cteWithStart = -1;

  while ((withMatch = withPattern.exec(cleaned)) !== null) {
    const afterWith = cleaned.substring(withMatch.index + withMatch[0].length);

    // Distinguish CTE from table hint: CTE requires an identifier followed by AS
    // Table hints look like WITH (NOLOCK) — paren immediately after WITH
    const cteStartPattern = /^\s*(?:\[[^\]]*\]|[a-zA-Z_][a-zA-Z0-9_]*)\s+as\b/i;
    if (cteStartPattern.test(afterWith)) {
      cteWithStart = withMatch.index;
      break; // Use the first WITH that looks like a CTE
    }
  }

  if (cteWithStart === -1) {
    return noChain;
  }

  // Parse CTE definitions starting after the WITH keyword
  const cteDefinitions: CTEDefinition[] = [];
  let pos = cteWithStart + 4; // Skip past "WITH"

  while (pos < cleaned.length) {
    // Skip whitespace
    while (pos < cleaned.length && /\s/.test(cleaned[pos])) pos++;

    if (pos >= cleaned.length) break;

    // Parse CTE name (identifier or bracketed identifier)
    let cteName = '';
    if (cleaned[pos] === '[') {
      const closeBracket = cleaned.indexOf(']', pos + 1);
      if (closeBracket === -1) break; // Malformed bracketed identifier
      cteName = cleaned.substring(pos + 1, closeBracket);
      pos = closeBracket + 1;
    } else if (/[a-zA-Z_]/.test(cleaned[pos])) {
      const nameStart = pos;
      while (pos < cleaned.length && /[a-zA-Z0-9_]/.test(cleaned[pos])) pos++;
      cteName = cleaned.substring(nameStart, pos);
    } else {
      break; // Not a valid CTE name — stop parsing
    }

    // Skip whitespace
    while (pos < cleaned.length && /\s/.test(cleaned[pos])) pos++;

    // Expect AS keyword
    if (pos + 2 > cleaned.length) break;
    if (cleaned.substring(pos, pos + 2).toLowerCase() !== 'as') break; // Malformed CTE — missing AS
    pos += 2;

    // Skip whitespace
    while (pos < cleaned.length && /\s/.test(cleaned[pos])) pos++;

    // Expect opening paren for the CTE body
    if (pos >= cleaned.length || cleaned[pos] !== '(') break;

    const bodyStart = pos;
    const closePos = findMatchingParen(cleaned, pos);

    if (closePos === -1) {
      // Incomplete CTE body — no closing paren found
      // Body extends to end of text
      cteDefinitions.push({
        name: cteName,
        bodyStart: bodyStart,
        bodyEnd: -1,
      });
      break; // Can't parse further CTEs after an incomplete one
    }

    cteDefinitions.push({
      name: cteName,
      bodyStart: bodyStart,
      bodyEnd: closePos,
    });

    pos = closePos + 1;

    // Skip whitespace
    while (pos < cleaned.length && /\s/.test(cleaned[pos])) pos++;

    // Check if there's a comma (another CTE definition follows)
    if (pos < cleaned.length && cleaned[pos] === ',') {
      pos++; // Skip comma and continue to next CTE
    } else {
      break; // End of CTE block
    }
  }

  // Need at least 1 CTE definition for a chain context to be meaningful
  if (cteDefinitions.length === 0) {
    return noChain;
  }

  // Determine cursor position relative to CTE bodies
  // Case 1: Cursor is inside CTE body K → available names are CTEs 1..K-1
  for (let k = 0; k < cteDefinitions.length; k++) {
    const cte = cteDefinitions[k];
    const effectiveEnd = cte.bodyEnd === -1 ? statementText.length : cte.bodyEnd;

    if (cursorOffset > cte.bodyStart && cursorOffset <= effectiveEnd) {
      // Cursor is inside CTE body K
      const availableNames = cteDefinitions.slice(0, k).map(d => d.name);
      return {
        inCTEChain: true,
        availableNames,
      };
    }
  }

  // Case 2: Cursor is after all CTE definitions (in the final SELECT/INSERT/UPDATE/DELETE)
  const lastCte = cteDefinitions[cteDefinitions.length - 1];
  const lastCteEnd = lastCte.bodyEnd === -1 ? statementText.length : lastCte.bodyEnd;

  if (cursorOffset > lastCteEnd) {
    return {
      inCTEChain: true,
      availableNames: cteDefinitions.map(d => d.name),
    };
  }

  // Cursor is before the CTE bodies or between WITH and first CTE body start
  // (e.g., typing the CTE name or AS keyword)
  return noChain;
}

/**
 * Finds the text of the innermost scope containing the cursor position.
 * A scope boundary is defined by a parenthesized `(SELECT ...)` block.
 * If the cursor is inside a subquery, returns only the text within that subquery.
 * If the cursor is in the outer query, returns the text with subquery contents removed.
 */
function findInnermostScope(cleaned: string, cursorPos: number): string {
  // Find all opening parentheses that start a subquery (followed by SELECT)
  // and determine if the cursor is inside any of them.
  // We need to find the innermost subquery containing the cursor.

  let innermostStart = -1;
  let innermostEnd = -1;

  // Iterate through the text to find subquery boundaries
  for (let i = 0; i < cursorPos && i < cleaned.length; i++) {
    if (cleaned[i] === '(') {
      // Check if this paren starts a subquery (content starts with SELECT)
      const afterParen = cleaned.substring(i + 1).trimStart();
      if (/^select\b/i.test(afterParen)) {
        // Find the matching closing paren
        const closePos = findMatchingParen(cleaned, i);
        // Check if cursor is inside this subquery
        if (closePos === -1 || cursorPos <= closePos) {
          // Cursor is inside this subquery (or subquery is incomplete)
          if (cursorPos > i) {
            innermostStart = i + 1;
            innermostEnd = closePos === -1 ? cleaned.length : closePos;
          }
        }
      }
    }
  }

  if (innermostStart !== -1) {
    // Cursor is inside a subquery — analyze only that subquery's text
    const subqueryText = cleaned.substring(innermostStart, Math.min(cursorPos, innermostEnd));
    // Recursively check for nested subqueries within this scope
    return findInnermostScope(subqueryText, subqueryText.length);
  }

  // Cursor is in the outer scope — strip subquery contents to avoid counting their clauses
  return stripSubqueryContents(cleaned.substring(0, cursorPos));
}

/**
 * Strips the contents of subqueries (parenthesized SELECT blocks) from text,
 * replacing them with spaces to preserve positions. This ensures clauses
 * inside subqueries are not counted in the outer scope.
 */
function stripSubqueryContents(text: string): string {
  let result = text;
  let changed = true;

  // Iteratively strip innermost subqueries first (handles nested subqueries)
  while (changed) {
    changed = false;
    let i = 0;
    while (i < result.length) {
      if (result[i] === '(') {
        const closePos = findMatchingParen(result, i);
        if (closePos === -1) {
          // Incomplete subquery — check if it starts with SELECT
          const afterParen = result.substring(i + 1).trimStart();
          if (/^select\b/i.test(afterParen)) {
            // Replace everything from the paren to end with spaces
            const replacement = ' '.repeat(result.length - i);
            result = result.substring(0, i) + replacement;
            changed = true;
          }
          i++;
          continue;
        }

        // Check if the content inside starts with SELECT (after whitespace)
        const inner = result.substring(i + 1, closePos).trimStart();
        if (/^select\b/i.test(inner)) {
          // Replace the entire subquery (including parens) with spaces
          const replacement = ' '.repeat(closePos - i + 1);
          result = result.substring(0, i) + replacement + result.substring(closePos + 1);
          changed = true;
          i += replacement.length;
        } else {
          i++;
        }
      } else {
        i++;
      }
    }
  }

  return result;
}

/**
 * Detects the SQL clause context based on the text before the cursor.
 *
 * Looks for the most recent clause keyword to determine what kind of
 * completions should be offered. Keywords are matched case-insensitively.
 */
export function detectContext(textBeforeCursor: string): CompletionContext {
  // Strip string literals and comments to avoid false matches inside them
  const cleaned = stripLiteralsAndComments(textBeforeCursor);

  // Check for CTE preamble: WITH <name> AS (at end of text)
  // This matches "WITH MyCTE AS" or "WITH [My CTE] AS" but NOT "WITH (NOLOCK)"
  // because the pattern requires an identifier followed by AS, not an opening parenthesis
  if (/\bwith\s+(?:\[[^\]]*\]|[a-zA-Z_]\w*)\s+as\s*$/i.test(cleaned)) {
    return 'CTE';
  }

  // Check for subsequent CTE in a chain: , <name> AS (at end of text)
  // This matches ", cte2 AS" for CTEs after the first one
  if (/,\s*(?:\[[^\]]*\]|[a-zA-Z_]\w*)\s+as\s*$/i.test(cleaned)) {
    return 'CTE';
  }

  // Check for ALTER TABLE context: ALTER TABLE at end or ALTER TABLE followed by whitespace
  if (/\balter\s+table\s+$/i.test(cleaned) || /\balter\s+table\s*$/i.test(cleaned)) {
    return 'ALTER_TABLE';
  }

  // Check for INSERT INTO context: INSERT INTO followed by whitespace (suggest tables)
  if (/\binsert\s+into\s+$/i.test(cleaned) || /\binsert\s+into\s*$/i.test(cleaned)) {
    return 'INSERT';
  }

  // Check for INSERT context (without INTO yet): INSERT followed by whitespace
  // This should suggest INTO keyword
  if (/\binsert\s*$/i.test(cleaned)) {
    return 'INSERT';
  }

  // Check for JOIN ... ON context: cursor is immediately after ON in a JOIN clause
  // This must be checked BEFORE the generic keyword patterns because ON conditions
  // would otherwise fall through to WHERE context.
  // Matches: JOIN table ON, JOIN schema.table alias ON, INNER JOIN [schema].[table] alias ON, etc.
  if (/\b(?:INNER\s+JOIN|LEFT\s+(?:OUTER\s+)?JOIN|RIGHT\s+(?:OUTER\s+)?JOIN|FULL\s+(?:OUTER\s+)?JOIN|CROSS\s+JOIN|JOIN)\s+(?:\[?[a-zA-Z_#]\w*\]?\.?\[?[a-zA-Z_#]\w*\]?)(?:\s+(?:AS\s+)?[a-zA-Z_]\w*)?\s+ON\s+$/i.test(cleaned)) {
    return 'JOIN_ON';
  }

  // Match clause keywords with word boundaries. Order matters: more specific
  // patterns (ORDER BY, GROUP BY) must be checked before their prefixes.
  // We search for the LAST occurrence of each keyword to find the most recent context.
  const patterns: Array<{ context: CompletionContext; regex: RegExp }> = [
    { context: 'ORDER_BY', regex: /\border\s+by\b/gi },
    { context: 'GROUP_BY', regex: /\bgroup\s+by\b/gi },
    { context: 'HAVING', regex: /\bhaving\b/gi },
    { context: 'EXEC', regex: /\b(?:exec|execute)\b/gi },
    { context: 'UPDATE', regex: /\bupdate\b/gi },
    { context: 'FROM', regex: /\bfrom\b/gi },
    { context: 'JOIN', regex: /\b(?:inner\s+join|left\s+(?:outer\s+)?join|right\s+(?:outer\s+)?join|full\s+(?:outer\s+)?join|cross\s+join|join)\b/gi },
    { context: 'WHERE', regex: /\bwhere\b/gi },
    { context: 'DECLARE', regex: /\bdeclare\b/gi },
    { context: 'SELECT', regex: /\bselect\b/gi },
  ];

  let latestMatch: { context: CompletionContext; index: number } | null = null;

  for (const { context, regex } of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(cleaned)) !== null) {
      const matchEnd = match.index + match[0].length;
      if (latestMatch === null || matchEnd > latestMatch.index) {
        latestMatch = { context, index: matchEnd };
      }
    }
  }

  if (latestMatch === null) {
    return 'NONE';
  }

  return latestMatch.context;
}

/**
 * Detects detailed JOIN context from the text before the cursor.
 *
 * Returns a JoinContextInfo object indicating whether the cursor is positioned
 * after a JOIN keyword variant, and if so, which specific variant was used.
 *
 * Supported JOIN keyword variants (case-insensitive):
 *   - JOIN
 *   - INNER JOIN
 *   - LEFT JOIN
 *   - LEFT OUTER JOIN
 *   - RIGHT JOIN
 *   - RIGHT OUTER JOIN
 *   - FULL JOIN
 *   - FULL OUTER JOIN
 *   - CROSS JOIN
 */
export function detectJoinContext(textBeforeCursor: string): JoinContextInfo {
  const cleaned = stripLiteralsAndComments(textBeforeCursor);

  // Match JOIN keyword variants at the end of the text (possibly followed by whitespace).
  // Order matters: more specific (longer) patterns must be checked first to avoid
  // partial matches (e.g., "LEFT OUTER JOIN" before "LEFT JOIN").
  const joinPattern = /\b(left\s+outer\s+join|right\s+outer\s+join|full\s+outer\s+join|inner\s+join|left\s+join|right\s+join|full\s+join|cross\s+join|join)\s*$/i;

  const match = joinPattern.exec(cleaned);
  if (match) {
    // Normalize the matched join type: collapse whitespace and uppercase
    const rawJoinType = match[1].replace(/\s+/g, ' ').toUpperCase();
    return { type: 'join', joinType: rawJoinType };
  }

  return { type: 'default' };
}

/**
 * Extracts table references from FROM and JOIN clauses in the query text.
 *
 * Parses schema.table or table references with optional aliases.
 * Handles common patterns like:
 *   - FROM dbo.Users
 *   - FROM dbo.Users u
 *   - FROM dbo.Users AS u
 *   - JOIN schema.Table AS alias
 *   - FROM Orders, Customers (comma-separated)
 *
 * Excludes:
 *   - Subqueries: (SELECT ...) patterns
 *   - CTEs: WITH name AS (...) patterns
 */
export function extractTableReferences(queryText: string): TableReference[] {
  let cleaned = stripLiteralsAndComments(queryText);

  // Remove CTE definitions: WITH name AS (...), name2 AS (...)
  // Replace the entire WITH...AS(...) block up to the final main query
  cleaned = stripCTEDefinitions(cleaned);

  // Remove subqueries (parenthesized expressions starting with SELECT)
  cleaned = stripSubqueries(cleaned);

  const references: TableReference[] = [];

  // Pattern to match FROM or JOIN keywords followed by table references
  // Captures: FROM/JOIN keyword, then one or more table references separated by commas (for FROM)
  const clauseRegex = /\b(?:from|(?:inner\s+)?join|left\s+(?:outer\s+)?join|right\s+(?:outer\s+)?join|full\s+(?:outer\s+)?join|cross\s+join)\b/gi;

  let clauseMatch: RegExpExecArray | null;
  while ((clauseMatch = clauseRegex.exec(cleaned)) !== null) {
    const afterClause = cleaned.substring(clauseMatch.index + clauseMatch[0].length);
    const tableRefs = parseTableList(afterClause);
    for (const ref of tableRefs) {
      references.push(ref);
    }
  }

  return references;
}

/**
 * Strips CTE definitions (WITH name AS (...)) from the query text.
 * Replaces CTE blocks with spaces to preserve character positions.
 * Only strips the definition part; the main query after the CTE remains.
 */
function stripCTEDefinitions(text: string): string {
  // Match WITH keyword at the start of a statement (possibly preceded by whitespace)
  const withPattern = /\bwith\b/gi;
  let match: RegExpExecArray | null;
  let result = text;

  while ((match = withPattern.exec(result)) !== null) {
    const afterWith = result.substring(match.index + match[0].length);

    // Check if this looks like a CTE: WITH <name> AS (
    const cteStartPattern = /^\s*(?:\[[^\]]*\]|[a-zA-Z_][a-zA-Z0-9_]*)\s+as\s*\(/i;
    if (!cteStartPattern.test(afterWith)) {
      continue; // Not a CTE (could be WITH (NOLOCK) hint)
    }

    // Find the end of the CTE block: scan for the final closing paren
    // that ends the last CTE definition, handling nested parens and
    // multiple CTE definitions separated by commas
    let pos = match.index + match[0].length;
    let cteEnd = findCTEBlockEnd(result, pos);

    if (cteEnd > pos) {
      // Replace the WITH...CTE block with spaces
      const replacement = ' '.repeat(cteEnd - match.index);
      result = result.substring(0, match.index) + replacement + result.substring(cteEnd);
      // Reset regex since we modified the string
      withPattern.lastIndex = match.index + replacement.length;
    }
  }

  return result;
}

/**
 * Finds the end position of a CTE block starting after the WITH keyword.
 * Handles multiple CTE definitions separated by commas:
 *   WITH cte1 AS (...), cte2 AS (...)
 * Returns the position after the last closing paren of the CTE definitions.
 */
function findCTEBlockEnd(text: string, startPos: number): number {
  let pos = startPos;

  while (pos < text.length) {
    // Skip whitespace
    while (pos < text.length && /\s/.test(text[pos])) pos++;

    // Expect a CTE name (identifier or bracketed identifier)
    if (pos >= text.length) break;
    if (text[pos] === '[') {
      const closeBracket = text.indexOf(']', pos + 1);
      if (closeBracket === -1) break;
      pos = closeBracket + 1;
    } else if (/[a-zA-Z_]/.test(text[pos])) {
      while (pos < text.length && /[a-zA-Z0-9_]/.test(text[pos])) pos++;
    } else {
      break; // Not a valid CTE name
    }

    // Skip whitespace
    while (pos < text.length && /\s/.test(text[pos])) pos++;

    // Expect AS keyword
    if (pos + 2 > text.length) break;
    if (text.substring(pos, pos + 2).toLowerCase() !== 'as') break;
    pos += 2;

    // Skip whitespace
    while (pos < text.length && /\s/.test(text[pos])) pos++;

    // Expect opening paren and find matching close
    if (pos >= text.length || text[pos] !== '(') break;
    const closePos = findMatchingParen(text, pos);
    if (closePos === -1) break;
    pos = closePos + 1;

    // Skip whitespace
    while (pos < text.length && /\s/.test(text[pos])) pos++;

    // Check if there's a comma (another CTE definition follows)
    if (pos < text.length && text[pos] === ',') {
      pos++; // Skip comma and continue to next CTE
    } else {
      break; // End of CTE block
    }
  }

  return pos;
}

/**
 * Finds the position of the matching closing parenthesis for an opening paren.
 * Handles nested parentheses. Returns -1 if no match found.
 */
function findMatchingParen(text: string, openPos: number): number {
  let depth = 0;
  for (let i = openPos; i < text.length; i++) {
    if (text[i] === '(') {
      depth++;
    } else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Strips subqueries (parenthesized expressions starting with SELECT) from the text.
 * Replaces them with spaces to preserve character positions.
 * Non-subquery parenthesized expressions are left intact.
 */
function stripSubqueries(text: string): string {
  let result = text;
  let changed = true;

  // Iteratively strip innermost subqueries first (handles nested subqueries)
  while (changed) {
    changed = false;
    let i = 0;
    while (i < result.length) {
      if (result[i] === '(') {
        const closePos = findMatchingParen(result, i);
        if (closePos === -1) {
          i++;
          continue;
        }

        // Check if the content inside starts with SELECT (after whitespace)
        const inner = result.substring(i + 1, closePos).trimStart();
        if (/^select\b/i.test(inner)) {
          // Replace the entire subquery (including parens) with spaces
          const replacement = ' '.repeat(closePos - i + 1);
          result = result.substring(0, i) + replacement + result.substring(closePos + 1);
          changed = true;
          i += replacement.length;
        } else {
          i++;
        }
      } else {
        i++;
      }
    }
  }

  return result;
}

/**
 * Parses a comma-separated list of table references from text following a FROM/JOIN keyword.
 * Stops at the next SQL keyword boundary.
 */
function parseTableList(text: string): TableReference[] {
  const results: TableReference[] = [];

  // Stop at the next major SQL keyword
  const stopKeywords = /\b(?:where|select|from|join|inner\s+join|left\s+join|right\s+join|full\s+join|cross\s+join|on|order\s+by|group\s+by|having|union|except|intersect|into|set|values|exec|execute)\b/i;
  const stopMatch = stopKeywords.exec(text);
  const segment = stopMatch ? text.substring(0, stopMatch.index) : text;

  // Split by comma for multiple table references in FROM clause
  const parts = segment.split(',');

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const ref = parseOneTableReference(trimmed);
    if (ref) {
      results.push(ref);
    }
  }

  return results;
}

/**
 * Parses a single table reference like "schema.table AS alias" or "table alias".
 * Handles three-part names: "database.schema.table AS alias".
 */
function parseOneTableReference(text: string): TableReference | null {
  // Match: optional_database.optional_schema.table_name optional_AS optional_alias
  // Identifiers can be: [bracketed], or simple alphanumeric/underscore/#
  const identPattern = '(?:\\[[^\\]]*\\]|[#]?[a-zA-Z_][a-zA-Z0-9_]*)';
  const tableRefRegex = new RegExp(
    `^\\s*(${identPattern})(?:\\.(${identPattern}))?(?:\\.(${identPattern}))?` +  // db.schema.name or schema.name or just name
    `(?:\\s+(?:as\\s+)?(${identPattern}))?` +            // optional alias
    `\\s*`,
    'i'
  );

  const match = tableRefRegex.exec(text);
  if (!match) return null;

  const firstPart = stripBrackets(match[1]);
  const secondPart = match[2] ? stripBrackets(match[2]) : undefined;
  const thirdPart = match[3] ? stripBrackets(match[3]) : undefined;
  const aliasPart = match[4] ? stripBrackets(match[4]) : undefined;

  if (thirdPart) {
    // Three-part: database.schema.table
    return {
      database: firstPart,
      schema: secondPart,
      name: thirdPart,
      alias: aliasPart,
    };
  } else if (secondPart) {
    // Two-part: schema.table
    return {
      schema: firstPart,
      name: secondPart,
      alias: aliasPart,
    };
  } else {
    // Single-part: just table name (no schema)
    return {
      name: firstPart,
      alias: aliasPart,
    };
  }
}

/**
 * Strips square brackets from a bracketed identifier.
 */
function stripBrackets(identifier: string): string {
  if (identifier.startsWith('[') && identifier.endsWith(']')) {
    return identifier.slice(1, -1);
  }
  return identifier;
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
    // String literal (single-quoted, handles escaped quotes '')
    else if (text[i] === '\'') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\'') {
          if (j + 1 < text.length && text[j + 1] === '\'') {
            j += 2; // escaped quote
          } else {
            j += 1; // end of string
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


// --- SQL Server Keywords ---

const SQL_KEYWORDS: string[] = [
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER',
  'CROSS', 'ON', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'IS',
  'NULL', 'AS', 'ORDER', 'BY', 'GROUP', 'HAVING', 'DISTINCT', 'TOP', 'WITH',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'ALTER',
  'DROP', 'TABLE', 'VIEW', 'INDEX', 'PROCEDURE', 'FUNCTION', 'TRIGGER',
  'BEGIN', 'END', 'IF', 'ELSE', 'WHILE', 'RETURN', 'DECLARE', 'SET',
  'EXEC', 'EXECUTE', 'UNION', 'ALL', 'EXCEPT', 'INTERSECT', 'CASE', 'WHEN',
  'THEN', 'ELSE', 'END', 'CAST', 'CONVERT', 'COALESCE', 'NULLIF',
  'GO', 'USE', 'PRINT', 'RAISERROR', 'THROW', 'TRY', 'CATCH',
  'TRANSACTION', 'COMMIT', 'ROLLBACK', 'SAVE', 'NOLOCK', 'MERGE',
  'PIVOT', 'UNPIVOT', 'APPLY', 'CROSS APPLY', 'OUTER APPLY',
  'ASC', 'DESC', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'CONSTRAINT',
  'DEFAULT', 'CHECK', 'UNIQUE', 'IDENTITY', 'OUTPUT', 'OVER', 'PARTITION',
  'ROWS', 'RANGE', 'PRECEDING', 'FOLLOWING', 'UNBOUNDED', 'CURRENT', 'ROW',
];

// --- SQL Server Built-in Functions ---

const SQL_BUILTIN_FUNCTIONS: string[] = [
  'ISNULL', 'COALESCE', 'CONVERT', 'CAST', 'DATEADD', 'DATEDIFF',
  'STRING_AGG', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'LEN', 'CHARINDEX',
  'SUBSTRING', 'REPLACE', 'LTRIM', 'RTRIM', 'TRIM', 'UPPER', 'LOWER',
  'GETDATE', 'GETUTCDATE', 'SYSDATETIME', 'DATEPART', 'DATENAME',
  'YEAR', 'MONTH', 'DAY', 'FORMAT', 'TRY_CONVERT', 'TRY_CAST',
  'IIF', 'CHOOSE', 'STUFF', 'CONCAT', 'CONCAT_WS',
  'LEFT', 'RIGHT', 'REVERSE', 'REPLICATE', 'SPACE',
  'ABS', 'CEILING', 'FLOOR', 'ROUND', 'POWER', 'SQRT',
  'NEWID', 'SCOPE_IDENTITY', 'IDENT_CURRENT', 'OBJECT_ID',
  'DB_NAME', 'SCHEMA_NAME', 'USER_NAME', 'SUSER_SNAME',
  'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE',
  'JSON_VALUE', 'JSON_QUERY', 'JSON_MODIFY', 'ISJSON',
  'STRING_SPLIT', 'PARSENAME', 'QUOTENAME',
];

// --- Clause-Flow State Machine ---

/**
 * Lookup table mapping each clause context to its valid successor clause keywords
 * per the canonical T-SQL ordering:
 *   SELECT → FROM → JOIN → WHERE → GROUP BY → HAVING → ORDER BY
 *
 * JOIN variants are always allowed regardless of presence (multiple JOINs are valid).
 */
export const VALID_SUCCESSORS: Record<string, string[]> = {
  'SELECT': ['FROM', 'INTO', 'WHERE'],
  'FROM':   ['JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'WHERE', 'GROUP BY', 'ORDER BY'],
  'JOIN':   ['JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'WHERE', 'GROUP BY', 'ORDER BY'],
  'WHERE':  ['AND', 'OR', 'GROUP BY', 'ORDER BY'],
  'GROUP_BY': ['HAVING', 'ORDER BY'],
  'HAVING': ['ORDER BY'],
};

// --- Context-Aware Completion Provider ---

/**
 * Detects whether the text before the cursor contains a complete WHERE condition.
 * A complete condition is: WHERE <column> <operator> <value> followed by trailing whitespace.
 *
 * Checks for comparison operators (=, <>, !=, <, >, <=, >=, LIKE, IN, IS, BETWEEN, NOT)
 * followed by a value token and trailing whitespace after the last WHERE keyword.
 *
 * @param textBeforeCursor - The text before the cursor position
 * @returns true if a complete condition pattern is detected after the last WHERE
 */
export function hasCompleteCondition(textBeforeCursor: string): boolean {
  // Find the last WHERE keyword
  const wherePattern = /\bwhere\b/gi;
  let lastWhereIndex = -1;
  let match: RegExpExecArray | null;
  while ((match = wherePattern.exec(textBeforeCursor)) !== null) {
    lastWhereIndex = match.index + match[0].length;
  }

  if (lastWhereIndex === -1) {
    return false;
  }

  // Get text after the last WHERE keyword
  const afterWhere = textBeforeCursor.substring(lastWhereIndex);

  // Check if there's at least one comparison operator followed by a value token and trailing whitespace
  // Pattern: <something> <operator> <value> <whitespace at end>
  // Operators: =, <>, !=, <, >, <=, >=, LIKE, IN, IS, BETWEEN, NOT
  const conditionPattern = /(?:=|<>|!=|<=|>=|<|>|\bLIKE\b|\bIN\b|\bIS\b|\bBETWEEN\b|\bNOT\b)\s*(?:'[^']*'|\([^)]*\)|[\w.@]+)\s+$/i;

  return conditionPattern.test(afterWhere);
}

/**
 * Returns contextual keyword completions appropriate for the current context.
 * Detects partial keyword states where the user needs keyword suggestions
 * alongside schema-object completions.
 *
 * Now accepts an optional clause-presence set to suppress already-present clauses
 * and enforce canonical T-SQL ordering.
 *
 * @param context - The detected SQL clause context
 * @param textBeforeCursor - The text before the cursor position
 * @param presentClauses - Optional set of clauses already in the statement
 * @returns Array of keyword CompletionItems to merge into results
 */
export function getContextualKeywords(
  context: CompletionContext,
  textBeforeCursor: string,
  presentClauses?: ClausePresenceSet
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const trimmed = textBeforeCursor.trimEnd();

  // Detect partial join keywords: text ending with INNER, LEFT, RIGHT, FULL, CROSS
  // These need JOIN or OUTER JOIN to complete the keyword sequence
  if (/\b(?:INNER|LEFT|RIGHT|FULL|CROSS)\s*$/i.test(trimmed)) {
    items.push({
      label: 'JOIN',
      kind: CompletionItemKind.Keyword,
      detail: 'Keyword',
    });
    // OUTER JOIN is valid after LEFT, RIGHT, FULL (not INNER or CROSS)
    if (/\b(?:LEFT|RIGHT|FULL)\s*$/i.test(trimmed)) {
      items.push({
        label: 'OUTER JOIN',
        kind: CompletionItemKind.Keyword,
        detail: 'Keyword',
      });
    }
    return items;
  }

  // Detect star-only select list (e.g., "SELECT * " or "SELECT TOP 10 * ")
  const isStarOnlySelect = /\bSELECT\b(\s+TOP\s+\d+)?\s+\*\s+$/i.test(textBeforeCursor);

  // If presentClauses is provided and non-empty, use clause-flow state machine
  if (presentClauses && presentClauses.size > 0) {
    // Only suggest clause-flow keywords at whitespace boundaries after completed tokens.
    // For SELECT context, require content after the SELECT keyword (column expressions)
    // before suggesting successors like FROM/INTO/WHERE.
    let atWhitespaceBoundary = false;
    if (context === 'SELECT') {
      atWhitespaceBoundary = /\bSELECT\b.*[\w\*\]\)]\s+$/i.test(textBeforeCursor);
    } else {
      atWhitespaceBoundary = /[\w\*\]\)]\s+$/i.test(textBeforeCursor);
    }

    if (atWhitespaceBoundary) {
      const successors = VALID_SUCCESSORS[context];
      if (successors) {
        const conditionComplete = context === 'WHERE' ? hasCompleteCondition(textBeforeCursor) : true;
        for (const keyword of successors) {
          // AND/OR should only be suggested when there's a complete condition in WHERE
          if ((keyword === 'AND' || keyword === 'OR') && !conditionComplete) {
            continue;
          }
          // Suppress INTO when select list is star-only (SELECT * INTO is invalid without FROM)
          if (keyword === 'INTO' && context === 'SELECT' && isStarOnlySelect) {
            continue;
          }
          // Determine the presence key for this keyword
          const presenceKey = getPresenceKey(keyword);
          // JOIN is always allowed (multiple JOINs are valid in T-SQL)
          const isJoinVariant = presenceKey === 'JOIN';
          // Skip if the clause is already present (unless it's a JOIN variant)
          if (!isJoinVariant && presenceKey && presentClauses.has(presenceKey)) {
            continue;
          }
          items.push({
            label: keyword,
            kind: CompletionItemKind.Keyword,
            detail: 'Keyword',
          });
        }
        return items;
      }
    }
    return items;
  }

  // Fallback: existing behavior when presentClauses is undefined/empty

  // After SELECT context (end of column list): suggest FROM, INTO, WHERE
  // Detect when user has finished selecting columns (text ends with space after
  // a non-keyword token like `*`, column name, or closing bracket)
  if (context === 'SELECT') {
    // Check if text ends with a pattern suggesting columns are done
    // e.g., "SELECT * ", "SELECT col1, col2 ", "SELECT TOP 10 * "
    if (/\bSELECT\b.*[\w\*\]\)]\s+$/i.test(textBeforeCursor)) {
      items.push(
        { label: 'FROM', kind: CompletionItemKind.Keyword, detail: 'Keyword' },
      );
      // Only suggest INTO for named column lists (not star-only selects)
      if (!isStarOnlySelect) {
        items.push(
          { label: 'INTO', kind: CompletionItemKind.Keyword, detail: 'Keyword' },
        );
      }
      items.push(
        { label: 'WHERE', kind: CompletionItemKind.Keyword, detail: 'Keyword' },
      );
    }
  }

  // After FROM context: suggest WHERE, JOIN variants
  if (context === 'FROM') {
    // Only suggest keywords when text ends with a space after a table reference
    // (not when user is mid-typing a table name)
    if (/[\w\]\)]\s+$/i.test(textBeforeCursor)) {
      items.push(
        { label: 'WHERE', kind: CompletionItemKind.Keyword, detail: 'Keyword' },
        { label: 'JOIN', kind: CompletionItemKind.Keyword, detail: 'Keyword' },
        { label: 'INNER JOIN', kind: CompletionItemKind.Keyword, detail: 'Keyword' },
        { label: 'LEFT JOIN', kind: CompletionItemKind.Keyword, detail: 'Keyword' },
        { label: 'RIGHT JOIN', kind: CompletionItemKind.Keyword, detail: 'Keyword' },
        { label: 'FULL JOIN', kind: CompletionItemKind.Keyword, detail: 'Keyword' },
      );
    }
  }

  // After WHERE context with a complete condition: suggest AND, OR
  if (context === 'WHERE') {
    if (hasCompleteCondition(textBeforeCursor)) {
      items.push(
        { label: 'AND', kind: CompletionItemKind.Keyword, detail: 'Keyword' },
        { label: 'OR', kind: CompletionItemKind.Keyword, detail: 'Keyword' },
      );
    }
  }

  return items;
}

/**
 * Maps a keyword label to its corresponding ClausePresenceSet key.
 * JOIN variants all map to 'JOIN'. Returns undefined for keywords
 * that don't have a presence key (e.g., INTO).
 */
function getPresenceKey(keyword: string): ClausePresenceSet extends Set<infer T> ? T : never | undefined {
  const upper = keyword.toUpperCase();
  if (upper === 'JOIN' || upper === 'INNER JOIN' || upper === 'LEFT JOIN' ||
      upper === 'RIGHT JOIN' || upper === 'FULL JOIN' || upper === 'CROSS JOIN') {
    return 'JOIN' as any;
  }
  if (upper === 'WHERE') return 'WHERE' as any;
  if (upper === 'GROUP BY') return 'GROUP_BY' as any;
  if (upper === 'HAVING') return 'HAVING' as any;
  if (upper === 'ORDER BY') return 'ORDER_BY' as any;
  if (upper === 'FROM') return 'FROM' as any;
  if (upper === 'SELECT') return 'SELECT' as any;
  return undefined as any;
}

/**
 * Determines whether the cursor at the given offset is inside a SQL comment.
 *
 * Handles both single-line comments (`-- ...`) and block comments (`/* ... * /`).
 * Correctly ignores `--` and `/*` sequences that appear inside string literals.
 *
 * @param documentText - The full document text
 * @param offset - The cursor position (character offset)
 * @returns true if the cursor is inside a comment, false otherwise
 */
export function isInsideComment(documentText: string, offset: number): boolean {
  // We scan from the start of the text up to the offset, tracking state.
  let i = 0;
  const limit = Math.min(offset, documentText.length);

  while (i < limit) {
    const ch = documentText[i];

    // --- String literal (single-quoted, handles escaped quotes '') ---
    if (ch === '\'') {
      i++; // skip opening quote
      while (i < documentText.length) {
        if (documentText[i] === '\'') {
          if (i + 1 < documentText.length && documentText[i + 1] === '\'') {
            i += 2; // escaped quote ''
          } else {
            i++; // closing quote
            break;
          }
        } else {
          i++;
        }
      }
      continue;
    }

    // --- N-prefixed string literal ---
    if ((ch === 'N' || ch === 'n') && i + 1 < documentText.length && documentText[i + 1] === '\'') {
      i += 2; // skip N and opening quote
      while (i < documentText.length) {
        if (documentText[i] === '\'') {
          if (i + 1 < documentText.length && documentText[i + 1] === '\'') {
            i += 2; // escaped quote ''
          } else {
            i++; // closing quote
            break;
          }
        } else {
          i++;
        }
      }
      continue;
    }

    // --- Single-line comment (--) ---
    if (ch === '-' && i + 1 < limit && documentText[i + 1] === '-') {
      // We're entering a single-line comment. Find the end of line.
      const lineEnd = documentText.indexOf('\n', i);
      const commentEnd = lineEnd === -1 ? documentText.length : lineEnd;
      // If the offset falls within this comment range, cursor is inside a comment
      if (offset > i && offset <= commentEnd) {
        return true;
      }
      // Skip past the comment
      i = commentEnd;
      continue;
    }

    // --- Block comment (/* ... */) ---
    if (ch === '/' && i + 1 < limit && documentText[i + 1] === '*') {
      // We're entering a block comment. Find the closing */.
      const closePos = documentText.indexOf('*/', i + 2);
      const commentEnd = closePos === -1 ? documentText.length : closePos + 2;
      // If the offset falls within this block comment range, cursor is inside
      if (offset > i && offset <= (closePos === -1 ? documentText.length : closePos + 2)) {
        return true;
      }
      // Skip past the block comment
      i = commentEnd;
      continue;
    }

    i++;
  }

  return false;
}

/**
 * Generates snippet completions for the current cursor context.
 * Detects context triggers to elevate relevant snippets and filters
 * by the typed prefix. Snippets are available regardless of connection state.
 *
 * @param textBeforeCursor - The text before the cursor position
 * @returns Array of snippet CompletionItems with appropriate sortText
 */
function getSnippetCompletions(textBeforeCursor: string): CompletionItem[] {
  const prefix = getCurrentPrefix(textBeforeCursor);
  const elevatedPrefixes = detectSnippetContext(textBeforeCursor);

  // Get all snippets that match the typed prefix
  const matchingSnippets = SNIPPET_DEFINITIONS.filter((s) =>
    s.prefix.toLowerCase().startsWith(prefix.toLowerCase())
  );

  return matchingSnippets.map((snippet) => {
    const elevated = elevatedPrefixes.has(snippet.prefix);
    return toCompletionItem(snippet, elevated);
  });
}

/**
 * Returns context-aware completion items based on the document text,
 * cursor position, and schema cache state.
 *
 * @param documentText - The full text of the document
 * @param offset - The character offset of the cursor in the document
 * @param schemaCache - The schema cache (or null if disconnected)
 * @param isConnected - Whether there is an active database connection
 * @param multiDatabaseCache - Optional multi-database cache for cross-database completions
 */
export function getCompletions(
  documentText: string,
  offset: number,
  schemaCache: ISchemaCache | null,
  isConnected: boolean,
  multiDatabaseCache?: IMultiDatabaseCache | null
): CompletionItem[] {
  // Early return for comments — no completions inside comments
  if (isInsideComment(documentText, offset)) {
    return [];
  }

  const textBeforeCursor = documentText.substring(0, offset);

  // --- Dynamic SQL Detection ---
  // Check if cursor is inside a dynamic SQL string (EXEC() or sp_executesql argument).
  // If so, provide completions based on the extracted SQL context rather than the
  // surrounding T-SQL code.
  const dynamicSqlContext = detectDynamicSqlContext(documentText, offset);
  if (dynamicSqlContext) {
    return getDynamicSqlCompletions(dynamicSqlContext, schemaCache, isConnected);
  }

  // If disconnected or no schema cache, return keywords and built-in functions
  if (!isConnected || !schemaCache) {
    const keywordItems = getKeywordCompletions(textBeforeCursor);
    const snippetItems = getSnippetCompletions(textBeforeCursor);
    return [...keywordItems, ...snippetItems];
  }

  // --- Cross-Database Reference Detection ---
  // Before standard context detection (and before the isPopulating guard), check if the
  // cursor is at a cross-database reference pattern (e.g., "OtherDB.", "OtherDB.dbo.",
  // or "OtherDB.dbo.Table"). Cross-database completions use the multiDatabaseCache which
  // is independent of the primary schemaCache's population state, so this check must run
  // even while the local schema cache is still loading.
  // This ensures cross-database completions are returned for valid three-part patterns
  // in all SQL contexts (FROM, JOIN, SELECT, WHERE) without being blocked by the
  // schemaCache.isPopulating guard below.
  if (multiDatabaseCache) {
    const crossDbRef = detectCrossDatabaseReference(textBeforeCursor, multiDatabaseCache);
    if (crossDbRef) {
      return getCrossDatabaseCompletions(crossDbRef, multiDatabaseCache, documentText, offset);
    }
  }

  // If schema cache is still populating, return keyword-only completions
  // (this guard only affects non-cross-database completions)
  if (schemaCache.isPopulating) {
    const keywordItems = getKeywordCompletions(textBeforeCursor);
    const snippetItems = getSnippetCompletions(textBeforeCursor);
    return [...keywordItems, ...snippetItems];
  }

  // Extract the current batch scope — all subsequent table reference extraction
  // and column completions use batch-scoped text to avoid cross-batch noise
  const batchScope = extractCurrentBatch(documentText, offset);

  // NEW: Narrow to statement scope within the batch
  // If batchScope.text is empty, skip statement scoping entirely (existing behavior preserved)
  let scopedText: string;
  if (batchScope.text) {
    const cursorOffsetInBatch = offset - batchScope.startOffset;
    scopedText = getStatementScopeText(batchScope.text, cursorOffsetInBatch);
  } else {
    scopedText = batchScope.text;
  }

  // Extract the current statement text by scanning backward from the cursor
  // to the nearest GO separator, semicolon, or start of document.
  const currentStatement = extractCurrentStatement(documentText, offset);
  const cursorOffsetInStatement = currentStatement.length;

  const context = detectContext(currentStatement);

  // Determine which clauses are already present in the current statement scope
  const presentClauses = getClausePresenceSet(currentStatement, cursorOffsetInStatement);

  // --- Clause State Engine integration (from clauseStateEngine.ts) ---
  // Compute the clause presence set using the formal engine for scope-aware detection
  const enginePresenceSet = getClausePresenceSetFromEngine(currentStatement, cursorOffsetInStatement);

  // Determine valid successor keywords based on the current clause context
  const clauseState = contextToClauseState(context);
  const requiredKeywords: string[] = clauseState
    ? getValidSuccessors(clauseState, enginePresenceSet)
    : [];

  // Detect CTE chain context: if cursor is inside a CTE chain, get available CTE names
  // @deprecated — Use resolveChainedCTEs() for new CTE resolution logic (task 7.3).
  // Kept temporarily for backward compatibility until task 7.4 cleanup.
  const cteChain = detectCTEChain(currentStatement, cursorOffsetInStatement);

  // NEW (task 7.3): Resolve chained CTEs using the dedicated cteResolver module.
  // This provides full column metadata for CTE alias-dot completions.
  const cteResolution = resolveChainedCTEs(currentStatement, cursorOffsetInStatement, schemaCache);
  const cteSchemaMap = buildCTESchemaMap(cteResolution);

  // --- Aggregation Context Detection ---
  // Detect if cursor is inside an aggregate function's parentheses.
  // This check runs BEFORE the context switch because aggregation context
  // can occur within any clause (SELECT, WHERE, HAVING, etc.).
  const aggregationContext = detectAggregationContext(currentStatement);
  if (aggregationContext.inAggregate) {
    // When inside an aggregate function, return type-filtered column completions
    // and suppress table/view suggestions.
    const tableRefs = extractTableReferences(scopedText);

    // If no tables are referenced (no FROM clause), offer aggregate function names only
    if (tableRefs.length === 0) {
      return getAggregateFunctionSnippets();
    }

    // Collect columns from all referenced tables with alias info
    const allColumns: Array<ColumnInfo & { tableAlias?: string }> = [];
    // Track column names to detect ambiguity (shared names across tables)
    const columnNameCount = new Map<string, number>();

    for (const ref of tableRefs) {
      const matchingTable = findTableOrView(schemaCache, ref, multiDatabaseCache);
      if (!matchingTable) continue;

      for (const col of matchingTable.columns) {
        const colNameLower = col.name.toLowerCase();
        columnNameCount.set(colNameLower, (columnNameCount.get(colNameLower) || 0) + 1);
        allColumns.push({
          ...col,
          tableAlias: ref.alias || ref.name,
        });
      }
    }

    // Build final column list: qualify ambiguous names, leave unique names unqualified
    // When multiple tables exist, always qualify to be safe
    const hasMultipleTables = tableRefs.length > 1;
    const columnsForCompletion: Array<ColumnInfo & { tableAlias?: string }> = [];

    for (const col of allColumns) {
      const colNameLower = col.name.toLowerCase();
      const isAmbiguous = (columnNameCount.get(colNameLower) || 0) > 1;

      if (hasMultipleTables && isAmbiguous) {
        // Ambiguous column: only show qualified version
        columnsForCompletion.push(col);
      } else if (hasMultipleTables) {
        // Non-ambiguous but multi-table: show qualified for clarity
        columnsForCompletion.push(col);
      } else {
        // Single table: show unqualified
        columnsForCompletion.push({ ...col, tableAlias: undefined });
      }
    }

    return getAggregateColumnCompletions(
      columnsForCompletion,
      aggregationContext.functionName!
    );
  }

  let schemaObjectCompletions: CompletionItem[];

  switch (context) {
    case 'FROM':
      schemaObjectCompletions = getTableAndViewCompletions(schemaCache, textBeforeCursor);
      // Merge CTE name completions into FROM results when inside a CTE chain.
      // Prefer cteResolution (new resolver) over cteChain (deprecated) for available names.
      {
        const availableCTENames = cteResolution.availableNames.length > 0
          ? cteResolution.availableNames
          : (cteChain.inCTEChain ? cteChain.availableNames : []);
        if (availableCTENames.length > 0) {
          const prefix = getCurrentPrefix(textBeforeCursor);
          const cteCompletions = getCTENameCompletions(availableCTENames, prefix);
          schemaObjectCompletions = [...cteCompletions, ...schemaObjectCompletions];
        }
      }
      break;

    case 'JOIN': {
      // Route JOIN context to JoinGenerator for FK-based completions
      // Use statement-scoped text for table reference extraction
      const joinContext = detectJoinContext(textBeforeCursor);
      if (joinContext.type === 'join') {
        const sourceTableRefs = extractTableReferences(scopedText);
        const existingAliases = sourceTableRefs
          .filter(ref => ref.alias)
          .map(ref => ref.alias!);
        const prefix = getJoinPrefix(textBeforeCursor);
        const result = getJoinCompletions(
          { sourceTableRefs, existingAliases, prefix },
          schemaCache
        );
        schemaObjectCompletions = result.items;
      } else {
        // Fallback: if detectJoinContext doesn't confirm JOIN, use table/view completions
        schemaObjectCompletions = getTableAndViewCompletions(schemaCache, textBeforeCursor);
      }
      // Merge CTE name completions into JOIN results when inside a CTE chain.
      // Prefer cteResolution (new resolver) over cteChain (deprecated) for available names.
      {
        const availableCTENames = cteResolution.availableNames.length > 0
          ? cteResolution.availableNames
          : (cteChain.inCTEChain ? cteChain.availableNames : []);
        if (availableCTENames.length > 0) {
          const ctePrefix = joinContext.type === 'join' ? getJoinPrefix(textBeforeCursor) : getCurrentPrefix(textBeforeCursor);
          const cteCompletions = getCTENameCompletions(availableCTENames, ctePrefix);
          schemaObjectCompletions = [...cteCompletions, ...schemaObjectCompletions];
        }
      }
      break;
    }

    case 'JOIN_ON': {
      // JOIN ON context: provide FK-related column pair completions for the ON condition.
      // Extract the joined table and source tables, look up FK relationships,
      // and return completions like "u.UserId = o.UserId".
      schemaObjectCompletions = getJoinOnCompletions(scopedText, textBeforeCursor, schemaCache);
      break;
    }

    case 'SELECT':
    case 'WHERE':
    case 'ORDER_BY':
    case 'GROUP_BY':
      // Check for alias.dot prefix pattern (e.g., user typed "o.")
      // If detected, return only columns from the aliased table
      if (context === 'WHERE') {
        const aliasDotResult = handleAliasDotPrefix(
          textBeforeCursor,
          cteChain.inCTEChain ? extractInnermostSelectScope(documentText, offset) : scopedText,
          schemaCache,
          cteChain.availableNames,
          cteSchemaMap,
          multiDatabaseCache
        );
        if (aliasDotResult !== null) {
          // aliasDotResult is either columns from the matched alias or empty (unknown alias)
          schemaObjectCompletions = aliasDotResult;
          break;
        }
      }
      // When inside a CTE body, extract table references from the CTE body scope
      // rather than the batch text. extractTableReferences strips CTE definitions,
      // which removes the very FROM clause we need when the cursor is inside a CTE body.
      if (cteChain.inCTEChain) {
        const scopeText = extractInnermostSelectScope(documentText, offset);
        schemaObjectCompletions = getColumnCompletions(scopeText, schemaCache, textBeforeCursor, cteChain.availableNames, context, multiDatabaseCache);
      } else {
        schemaObjectCompletions = getColumnCompletions(scopedText, schemaCache, textBeforeCursor, cteChain.availableNames, context, multiDatabaseCache);
      }

      // In SELECT context, merge aggregate function snippet completions
      // so users get SUM($1), COUNT($1), etc. with re-trigger behavior
      if (context === 'SELECT') {
        const aggregateSnippets = getAggregateFunctionSnippets();
        schemaObjectCompletions = [...schemaObjectCompletions, ...aggregateSnippets];
      }

      // In WHERE context, also suggest comparison operators after a known column name.
      // Operators are NOT suggested in SELECT, ORDER_BY, or GROUP_BY contexts.
      if (context === 'WHERE') {
        const scopeText = cteChain.inCTEChain ? extractInnermostSelectScope(documentText, offset) : scopedText;
        const operatorItems = getOperatorCompletions(textBeforeCursor, scopeText, schemaCache, multiDatabaseCache);
        if (operatorItems.length > 0) {
          schemaObjectCompletions = [...schemaObjectCompletions, ...operatorItems];
        }
      }
      break;

    case 'HAVING': {
      // HAVING clause: prioritize aggregate function completions and suggest
      // GROUP BY columns outside aggregates. When inside an aggregate in HAVING,
      // the aggregation context detection above handles column suggestions.
      // Check for alias.dot prefix pattern
      const havingAliasDotResult = handleAliasDotPrefix(
        textBeforeCursor,
        cteChain.inCTEChain ? extractInnermostSelectScope(documentText, offset) : scopedText,
        schemaCache,
        cteChain.availableNames,
        cteSchemaMap,
        multiDatabaseCache
      );
      if (havingAliasDotResult !== null) {
        schemaObjectCompletions = havingAliasDotResult;
        break;
      }

      // Outside an aggregate in HAVING: suggest GROUP BY columns + aggregate function snippets
      // Extract GROUP BY columns from the current statement
      const havingGroupByColumns = extractGroupByColumns(currentStatement);
      const havingScopeText = cteChain.inCTEChain ? extractInnermostSelectScope(documentText, offset) : scopedText;

      if (havingGroupByColumns.length > 0) {
        // Suggest GROUP BY columns as field completions
        const prefix = getCurrentPrefix(textBeforeCursor);
        const groupByItems: CompletionItem[] = havingGroupByColumns.map(col => ({
          label: col,
          kind: CompletionItemKind.Field,
          detail: 'GROUP BY column',
          sortText: `${RANK_TIERS.COLUMNS_AND_ALIASES}_${col.toLowerCase()}`,
        }));
        // Filter by prefix
        const lowerPrefix = prefix.toLowerCase();
        const filteredGroupByItems = prefix
          ? groupByItems.filter(item => (item.label as string).toLowerCase().startsWith(lowerPrefix))
          : groupByItems;
        schemaObjectCompletions = filteredGroupByItems;
      } else {
        // No GROUP BY found — fall back to all column completions
        if (cteChain.inCTEChain) {
          schemaObjectCompletions = getColumnCompletions(havingScopeText, schemaCache, textBeforeCursor, cteChain.availableNames, context, multiDatabaseCache);
        } else {
          schemaObjectCompletions = getColumnCompletions(scopedText, schemaCache, textBeforeCursor, cteChain.availableNames, context, multiDatabaseCache);
        }
      }

      // Always add aggregate function snippets in HAVING (they are prioritized)
      const havingAggregateSnippets = getAggregateFunctionSnippets();
      schemaObjectCompletions = [...havingAggregateSnippets, ...schemaObjectCompletions];
      break;
    }

    case 'EXEC':
      schemaObjectCompletions = getProcedureCompletions(schemaCache, textBeforeCursor);
      break;

    case 'UPDATE':
      schemaObjectCompletions = getTableAndViewCompletions(schemaCache, textBeforeCursor);
      break;

    case 'INSERT': {
      // INSERT context: if "INSERT INTO" is already typed, suggest tables
      // If just "INSERT" is typed, suggest INTO keyword + tables
      const insertCleaned = stripLiteralsAndComments(textBeforeCursor);
      if (/\binsert\s+into\s+/i.test(insertCleaned)) {
        schemaObjectCompletions = getTableAndViewCompletions(schemaCache, textBeforeCursor);
      } else {
        // Just "INSERT" — suggest INTO keyword prominently, plus tables
        const intoItem: CompletionItem = {
          label: 'INTO',
          kind: CompletionItemKind.Keyword,
          detail: 'Keyword',
          sortText: `${RANK_TIERS.REQUIRED_KEYWORD}_into`,
        };
        const tables = getTableAndViewCompletions(schemaCache, textBeforeCursor);
        schemaObjectCompletions = [intoItem, ...tables];
      }
      break;
    }

    case 'ALTER_TABLE':
      schemaObjectCompletions = getTableAndViewCompletions(schemaCache, textBeforeCursor);
      break;

    case 'DECLARE':
      schemaObjectCompletions = getDataTypeCompletions();
      break;

    case 'CTE':
      // Return CTE-appropriate completions: a (SELECT snippet and relevant keywords
      {
        const cteItems = getCTECompletions();
        const snippetItems = getSnippetCompletions(textBeforeCursor);
        return [...cteItems, ...snippetItems];
      }

    case 'NONE':
    default: {
      const keywordItems = getKeywordCompletions(textBeforeCursor);
      const snippetItems = getSnippetCompletions(textBeforeCursor);
      return [...keywordItems, ...snippetItems];
    }
  }

  // --- Cross-Database Name Completions (FROM/JOIN only) ---
  // When in FROM or JOIN context with a non-empty prefix, offer database name suggestions
  // from the MultiDatabaseCache. These are ranked at tier 3 (SCHEMA_OBJECTS) so local
  // tables/views/CTEs always appear above database names.
  if ((context === 'FROM' || context === 'JOIN') && multiDatabaseCache) {
    const dbPrefix = getCurrentPrefix(textBeforeCursor);
    // Strip leading bracket if present (user may type "[Ult" to start bracket-quoting)
    const cleanDbPrefix = dbPrefix.startsWith('[') ? dbPrefix.substring(1) : dbPrefix;

    if (cleanDbPrefix.length >= 1 && !cleanDbPrefix.includes('.')) {
      // Compute line-relative offsets for the textEdit range
      const lastNewline = textBeforeCursor.lastIndexOf('\n');
      const cursorCharOnLine = lastNewline === -1 ? offset : offset - (lastNewline + 1);
      const prefixStartCharOnLine = cursorCharOnLine - dbPrefix.length;
      const cursorLine = textBeforeCursor.split('\n').length - 1;

      // Call getDatabaseNameCompletions with the clean prefix
      const dbCompletions = getDatabaseNameCompletions(
        cleanDbPrefix,
        multiDatabaseCache,
        prefixStartCharOnLine,
        cursorCharOnLine
      );

      // Fix the line number in textEdit ranges (getDatabaseNameCompletions uses line 0)
      if (cursorLine > 0) {
        for (const item of dbCompletions) {
          if (item.textEdit && 'range' in item.textEdit) {
            item.textEdit = TextEdit.replace(
              Range.create(
                Position.create(cursorLine, prefixStartCharOnLine),
                Position.create(cursorLine, cursorCharOnLine)
              ),
              item.textEdit.newText
            );
          }
        }
      }

      if (dbCompletions.length > 0) {
        schemaObjectCompletions = [...schemaObjectCompletions, ...dbCompletions];
      }
    }
  }

  // Merge contextual keywords into the result alongside schema-object completions
  // Pass the clause-presence set to enable clause-flow filtering
  const contextualKeywords = getContextualKeywords(context, textBeforeCursor, presentClauses);
  const mergedCompletions = contextualKeywords.length > 0
    ? [...schemaObjectCompletions, ...contextualKeywords]
    : [...schemaObjectCompletions];

  // Merge snippet completions into the results (available in all connected contexts)
  const snippetItems = getSnippetCompletions(textBeforeCursor);
  if (snippetItems.length > 0) {
    mergedCompletions.push(...snippetItems);
  }

  // --- Auto GROUP BY Completion ---
  // Offer a GROUP BY completion when the SELECT list has aggregates + non-aggregated columns,
  // no GROUP BY is already present, and cursor is after FROM/WHERE.
  const groupByItem = getGroupByCompletion(currentStatement, context);
  if (groupByItem) {
    mergedCompletions.push(groupByItem);
  }

  // Determine context filter options for noise reduction
  const prefix = getCurrentPrefix(textBeforeCursor);
  const isAliasDotQualified = prefix.includes('.');
  const isSchemaDotQualified = isAliasDotQualified && schemaCache.tables.some(
    t => t.schema.toLowerCase() === prefix.split('.')[0].toLowerCase()
  );

  // Determine if we're in a JOIN context with a table reference already typed
  let isJoinWithTableRef = false;
  let isCrossJoin = false;
  if (context === 'JOIN') {
    const joinContext = detectJoinContext(textBeforeCursor);
    if (joinContext.type === 'join' && joinContext.joinType) {
      isCrossJoin = joinContext.joinType.includes('CROSS');
      // Check if there's a table reference after the JOIN keyword
      const joinPrefix = getJoinPrefix(textBeforeCursor);
      // If the join prefix contains a word followed by whitespace, a table ref has been typed
      isJoinWithTableRef = /\S+\s+$/.test(joinPrefix);
    }
  }

  // Apply context-based filtering before ranking (noise reduction)
  const filteredCompletions = applyContextFilter(mergedCompletions, context, {
    isAliasDotQualified,
    isSchemaDotQualified,
    isJoinWithTableRef,
    isCrossJoin,
    typedPrefix: prefix.includes('.') ? prefix.split('.').pop() || '' : prefix,
    requiredKeywords,
  });

  // Apply the 4-tier ranking system
  return applyTieredRanking(filteredCompletions, requiredKeywords, context);
}

/**
 * Extracts the current SQL statement text by scanning backward from the cursor
 * to the nearest statement delimiter: GO (on its own line), semicolon, or start of document.
 *
/**
 * Handles cross-database completion requests by returning items from the target
 * database's schema cache based on the detected reference pattern.
 *
 * @param ref - The detected cross-database reference with completionTarget
 * @param multiDbCache - The multi-database cache containing secondary database schemas
 * @param documentText - The full document text (for column resolution via alias)
 * @param offset - The cursor offset in the document
 * @returns Completion items from the target database, or empty array if database not cached
 */
function getCrossDatabaseCompletions(
  ref: CrossDatabaseReference,
  multiDbCache: IMultiDatabaseCache,
  documentText: string,
  offset: number
): CompletionItem[] {
  // Get the target database's cache — return empty if not available (Requirement 2.5)
  const targetCache = multiDbCache.getCache(ref.database);
  if (!targetCache) {
    return [];
  }

  switch (ref.completionTarget) {
    case 'schemas': {
      // Return unique schema names from the target database's tables and views
      const schemaSet = new Set<string>();
      for (const table of targetCache.tables) {
        schemaSet.add(table.schema);
      }
      for (const view of targetCache.views) {
        schemaSet.add(view.schema);
      }

      const items: CompletionItem[] = [];
      for (const schema of schemaSet) {
        items.push({
          label: schema,
          kind: CompletionItemKind.Module,
          detail: `Schema (${ref.database})`,
          sortText: `${RANK_TIERS.SCHEMA_OBJECTS}_${schema.toLowerCase()}`,
        });
      }
      return items;
    }

    case 'objects': {
      // Return tables and views from the target schema in the target database
      const schemaLower = ref.schema!.toLowerCase();
      const items: CompletionItem[] = [];

      for (const table of targetCache.tables) {
        if (table.schema.toLowerCase() === schemaLower) {
          items.push({
            label: table.name,
            kind: CompletionItemKind.Module,
            detail: `Table (${ref.database}.${ref.schema})`,
            sortText: `${RANK_TIERS.SCHEMA_OBJECTS}_${table.name.toLowerCase()}`,
          });
        }
      }

      for (const view of targetCache.views) {
        if (view.schema.toLowerCase() === schemaLower) {
          items.push({
            label: view.name,
            kind: CompletionItemKind.Module,
            detail: `View (${ref.database}.${ref.schema})`,
            sortText: `${RANK_TIERS.SCHEMA_OBJECTS}_${view.name.toLowerCase()}`,
          });
        }
      }

      return items;
    }

    case 'columns': {
      // Resolve columns for a four-part reference (Database.Schema.Table.)
      // or a three-part complete reference (Database.Schema.Table) used directly.
      // First try to find the table in FROM/JOIN clauses; if not found, look up
      // the table directly in the target database cache (supports direct column
      // access like `SELECT MyDatabase.dbo.Users.` without FROM).
      const currentStatement = extractCurrentStatement(documentText, offset);
      const crossDbTableRefs = extractCrossDatabaseTableRefs(currentStatement);

      // Find the table reference matching the detected cross-database reference
      const dbLower = ref.database.toLowerCase();
      const schemaLower = ref.schema!.toLowerCase();
      const objectLower = ref.object!.toLowerCase();

      // Try to find from FROM/JOIN clause first (optional — not required for four-part access)
      const matchingRef = crossDbTableRefs.find(
        r => r.database?.toLowerCase() === dbLower &&
             r.schema.toLowerCase() === schemaLower &&
             r.name.toLowerCase() === objectLower
      );

      // Look up the table/view in the target database cache directly
      // (This works whether or not the table is referenced in FROM/JOIN)
      const table = targetCache.tables.find(
        t => t.schema.toLowerCase() === schemaLower &&
             t.name.toLowerCase() === objectLower
      );
      const view = !table ? targetCache.views.find(
        v => v.schema.toLowerCase() === schemaLower &&
             v.name.toLowerCase() === objectLower
      ) : null;

      const targetObject = table || view;
      if (!targetObject) {
        return [];
      }

      // Return column completions from the target object
      const items: CompletionItem[] = [];
      for (const col of targetObject.columns) {
        items.push({
          label: col.name,
          kind: CompletionItemKind.Field,
          detail: `${col.dataType}${col.isNullable ? ', nullable' : ''} (${ref.database}.${ref.schema}.${ref.object})`,
          sortText: `${RANK_TIERS.COLUMNS_AND_ALIASES}_${col.name.toLowerCase()}`,
        });
      }
      return items;
    }

    default:
      return [];
  }
}

/**
 * Generates database name completion items for FROM/JOIN contexts.
 * Called when the typed prefix doesn't match local objects.
 *
 * Each item uses:
 * - label: unquoted database name (for VS Code prefix filtering)
 * - kind: CompletionItemKind.Module
 * - detail: "Database"
 * - insertText: bracket-quoted name with trailing dot (e.g., `[Ultimus].`)
 * - insertTextFormat: PlainText
 * - sortText: tier 3 (`"3_<name>"`)
 * - textEdit.range: from prefixStartOffset to cursorOffset
 *
 * Excludes the primary (currently connected) database from suggestions.
 * Doubles any `]` characters in the name for proper bracket escaping.
 *
 * @param prefix - The typed prefix for case-insensitive filtering
 * @param multiDbCache - The multi-database cache containing all accessible databases
 * @param prefixStartOffset - Start offset accounting for a leading `[` if typed
 * @param cursorOffset - The current cursor offset (end of typed prefix)
 * @returns CompletionItem[] for matching database names
 */
export function getDatabaseNameCompletions(
  prefix: string,
  multiDbCache: IMultiDatabaseCache,
  prefixStartOffset: number,
  cursorOffset: number
): CompletionItem[] {
  const allNames = multiDbCache.getCachedDatabaseNames();
  const primaryLower = multiDbCache.primaryDatabase.toLowerCase();

  // Filter out the primary database and apply prefix matching
  const lowerPrefix = prefix.toLowerCase();
  const matchingNames = allNames.filter(name => {
    // Exclude primary database
    if (name.toLowerCase() === primaryLower) {
      return false;
    }
    // Case-insensitive prefix match
    return name.toLowerCase().startsWith(lowerPrefix);
  });

  return matchingNames.map(name => {
    // Bracket-quote the name unconditionally, doubling any `]` characters
    const escaped = name.replace(/\]/g, ']]');
    const insertText = `[${escaped}].`;

    const item: CompletionItem = {
      label: name,
      kind: CompletionItemKind.Module,
      detail: 'Database',
      insertText,
      insertTextFormat: InsertTextFormat.PlainText,
      sortText: `${RANK_TIERS.SCHEMA_OBJECTS}_${name.toLowerCase()}`,
      textEdit: TextEdit.replace(
        Range.create(
          Position.create(0, prefixStartOffset),
          Position.create(0, cursorOffset)
        ),
        insertText
      ),
    };

    return item;
  });
}

/**
 * Extracts the text of the innermost SELECT scope from the full document text
 * at the given cursor position. When the cursor is inside a CTE body or subquery,
 * this returns the full text of that scope (from opening paren to closing paren
 * or end of text). This allows extractTableReferences to find FROM/JOIN clauses
 * within the current scope without being confused by CTE definition stripping.
 *
 * If no unmatched opening paren with SELECT is found, returns the full document text.
 */
function extractInnermostSelectScope(documentText: string, cursorOffset: number): string {
  const textBeforeCursor = documentText.substring(0, cursorOffset);

  // Find the last unmatched opening paren that starts a SELECT block
  // Walk backward through the text before cursor tracking paren depth
  let depth = 0;
  let scopeStart = -1;

  for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
    if (textBeforeCursor[i] === ')') {
      depth++;
    } else if (textBeforeCursor[i] === '(') {
      if (depth > 0) {
        depth--;
      } else {
        // This is an unmatched opening paren — check if followed by SELECT
        const afterParen = textBeforeCursor.substring(i + 1).trimStart();
        if (/^select\b/i.test(afterParen)) {
          scopeStart = i + 1; // Start after the opening paren
          break;
        }
      }
    }
  }

  if (scopeStart === -1) {
    // No unmatched paren with SELECT found — in the final query after CTEs
    return documentText;
  }

  // Find the matching closing paren from scopeStart-1 in the full document
  const openParenPos = scopeStart - 1;
  let parenDepth = 1;
  let scopeEnd = documentText.length;
  for (let i = scopeStart; i < documentText.length; i++) {
    if (documentText[i] === '(') parenDepth++;
    else if (documentText[i] === ')') {
      parenDepth--;
      if (parenDepth === 0) {
        scopeEnd = i;
        break;
      }
    }
  }

  // Return the full scope text (from after opening paren to before closing paren)
  return documentText.substring(scopeStart, scopeEnd);
}

/**
 * Extracts the current SQL statement text by scanning backward from the cursor
 * to the nearest statement delimiter: GO (on its own line), semicolon, or start of document.
 *
 * This provides the statement boundary needed for clause-presence analysis.
 *
 * @param documentText - The full document text
 * @param offset - The cursor offset in the document
 * @returns The text of the current statement (from delimiter to cursor)
 */
export function extractCurrentStatement(documentText: string, offset: number): string {
  const textBeforeCursor = documentText.substring(0, offset);

  // Strip literals and comments so we don't match delimiters inside them
  const cleaned = stripLiteralsAndComments(textBeforeCursor);

  // Find the latest statement delimiter position in the cleaned text
  let delimiterEnd = 0;

  // Search for semicolons (statement terminators)
  for (let i = cleaned.length - 1; i >= 0; i--) {
    if (cleaned[i] === ';') {
      delimiterEnd = i + 1;
      break;
    }
  }

  // Search for GO keyword on its own line (batch separator)
  // GO must be on its own line (possibly with leading/trailing whitespace)
  const goPattern = /^[ \t]*go[ \t]*$/gim;
  let goMatch: RegExpExecArray | null;
  while ((goMatch = goPattern.exec(cleaned)) !== null) {
    const goEnd = goMatch.index + goMatch[0].length;
    // Include the newline after GO if present
    const afterGo = goEnd < cleaned.length && cleaned[goEnd] === '\n' ? goEnd + 1 : goEnd;
    if (afterGo > delimiterEnd && afterGo <= offset) {
      delimiterEnd = afterGo;
    }
  }

  // Return the original (non-cleaned) text from the delimiter to the cursor
  return textBeforeCursor.substring(delimiterEnd);
}

/**
 * Extracts the current batch text by finding the GO separators
 * (or document boundaries) surrounding the cursor position.
 *
 * GO recognition rules:
 * - A line containing only "GO" (case-insensitive), optionally followed
 *   by a repeat count (integer), with no other non-whitespace characters
 * - GO inside single-line comments (--), block comments, or string
 *   literals (single-quoted or N-prefixed) is NOT treated as a separator
 *
 * When the cursor is on a GO line, the cursor is treated as belonging to
 * the batch before the GO line.
 *
 * @param documentText - The full document text
 * @param cursorOffset - The character offset of the cursor
 * @returns The batch scope containing the cursor
 */
export function extractCurrentBatch(
  documentText: string,
  cursorOffset: number
): BatchScope {
  // Handle empty document
  if (!documentText) {
    return { text: '', startOffset: 0 };
  }

  const lines = documentText.split(/\r?\n/);
  let charPos = 0;
  let inBlockComment = false;
  let inString = false;

  // Track line start offsets and which lines are GO separators
  const lineOffsets: number[] = [];
  const goLineIndices: number[] = [];

  const goPattern = /^\s*GO(?:\s+\d+)?\s*$/i;

  for (let i = 0; i < lines.length; i++) {
    lineOffsets.push(charPos);
    const line = lines[i];

    if (!inBlockComment && !inString) {
      if (goPattern.test(line)) {
        goLineIndices.push(i);
        // Advance charPos past this line (+1 for newline, except for last line)
        charPos += line.length + (i < lines.length - 1 ? 1 : 0);
        continue;
      }
    }

    // Update parser state by scanning the line character by character
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const next = j + 1 < line.length ? line[j + 1] : '';

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          j++; // skip the '/'
        }
      } else if (inString) {
        if (ch === "'") {
          if (next === "'") {
            j++; // skip escaped quote
          } else {
            inString = false;
          }
        }
      } else {
        if (ch === '-' && next === '-') {
          break; // rest of line is single-line comment
        } else if (ch === '/' && next === '*') {
          inBlockComment = true;
          j++; // skip the '*'
        } else if (ch === "'") {
          inString = true;
        } else if ((ch === 'N' || ch === 'n') && next === "'") {
          inString = true;
          j++; // skip the opening quote
        }
      }
    }

    // Advance charPos past this line (+1 for newline, except for last line)
    charPos += line.length + (i < lines.length - 1 ? 1 : 0);
  }

  // Determine which line the cursor is on
  let cursorLine = 0;
  for (let i = 0; i < lineOffsets.length; i++) {
    if (i + 1 < lineOffsets.length) {
      if (cursorOffset < lineOffsets[i + 1]) {
        cursorLine = i;
        break;
      }
    } else {
      cursorLine = i;
    }
  }

  // If cursor is on a GO line, treat it as belonging to the batch before the GO
  // Find the GO line index that matches cursorLine
  const cursorOnGo = goLineIndices.includes(cursorLine);

  // Find bounding GO lines around the cursor
  let batchStartLine = 0;
  let batchEndLine = lines.length;

  for (const goLine of goLineIndices) {
    if (cursorOnGo) {
      // Cursor is on a GO line: batch is everything before this GO line
      if (goLine === cursorLine) {
        batchEndLine = goLine;
        break;
      } else if (goLine < cursorLine) {
        batchStartLine = goLine + 1;
      }
    } else {
      if (goLine < cursorLine) {
        batchStartLine = goLine + 1;
      } else if (goLine >= cursorLine) {
        batchEndLine = goLine;
        break;
      }
    }
  }

  const startOffset = lineOffsets[batchStartLine] || 0;

  // Calculate end offset
  let endOffset: number;
  if (batchEndLine < lines.length) {
    endOffset = lineOffsets[batchEndLine];
  } else {
    endOffset = documentText.length;
  }

  // Extract the batch text, trimming trailing newline if present
  let text = documentText.substring(startOffset, endOffset);
  // Remove trailing newline that precedes the GO line (if any)
  if (text.endsWith('\r\n')) {
    text = text.slice(0, -2);
  } else if (text.endsWith('\n')) {
    text = text.slice(0, -1);
  }

  return { text, startOffset };
}

/**
 * Extracts the current prefix being typed (the word at the cursor position).
 */
function getCurrentPrefix(textBeforeCursor: string): string {
  // Match the last word-like characters (including dots for schema.name patterns)
  const match = textBeforeCursor.match(/[\w.#\[\]]*$/);
  return match ? match[0] : '';
}

/**
 * Extracts the prefix typed after the JOIN keyword for filtering join suggestions.
 * Returns the text between the last JOIN keyword and the cursor position.
 */
function getJoinPrefix(textBeforeCursor: string): string {
  const cleaned = stripLiteralsAndComments(textBeforeCursor);
  // Find the last JOIN keyword variant and return what follows it (trimmed of leading whitespace)
  const joinPattern = /\b(?:left\s+outer\s+join|right\s+outer\s+join|full\s+outer\s+join|inner\s+join|left\s+join|right\s+join|full\s+join|cross\s+join|join)\s*/gi;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = joinPattern.exec(cleaned)) !== null) {
    lastMatch = match;
  }
  if (!lastMatch) {
    return '';
  }
  const afterJoin = cleaned.substring(lastMatch.index + lastMatch[0].length);
  // The prefix is whatever word characters (including dots) the user has typed
  const prefixMatch = afterJoin.match(/^[\w.#\[\]]*/);
  return prefixMatch ? prefixMatch[0] : '';
}

/**
 * Filters items by case-insensitive prefix match.
 */
function filterByPrefix<T>(items: T[], prefix: string, getLabel: (item: T) => string): T[] {
  if (!prefix) return items;
  const lowerPrefix = prefix.toLowerCase();
  return items.filter(item => getLabel(item).toLowerCase().startsWith(lowerPrefix));
}

/**
 * Returns table and view completions with schema prefixes (e.g., dbo.Users).
 * When the user has already typed a schema prefix (e.g., "dbo."), sets insertText
 * to just the table/view name to prevent duplication (e.g., insertText: "Users").
 */
function getTableAndViewCompletions(
  schemaCache: ISchemaCache,
  textBeforeCursor: string
): CompletionItem[] {
  const prefix = getCurrentPrefix(textBeforeCursor);
  const hasSchemaDot = prefix.includes('.');
  const items: CompletionItem[] = [];

  // Add tables
  for (const table of schemaCache.tables) {
    const label = `${table.schema}.${table.name}`;
    const item: CompletionItem = {
      label,
      kind: CompletionItemKind.Module,
      detail: 'Table',
    };
    // When the user has already typed a schema prefix (e.g., "dbo."),
    // set insertText to just the table name to avoid duplication
    if (hasSchemaDot) {
      item.insertText = table.name;
    }
    items.push(item);
  }

  // Add views
  for (const view of schemaCache.views) {
    const label = `${view.schema}.${view.name}`;
    const item: CompletionItem = {
      label,
      kind: CompletionItemKind.Module,
      detail: 'View',
    };
    if (hasSchemaDot) {
      item.insertText = view.name;
    }
    items.push(item);
  }

  return filterByPrefix(items, prefix, item => item.label as string);
}

/**
 * Returns CTE name completion items for use in FROM/JOIN contexts.
 * CTE names are offered alongside real table/view completions with a sortText
 * that ensures they appear before real tables in the completion list.
 *
 * @param cteNames - Array of CTE names available at the cursor position
 * @param prefix - The currently typed prefix for case-insensitive filtering
 * @returns Array of CompletionItems with kind=Module and detail="CTE"
 */
export function getCTENameCompletions(cteNames: string[], prefix: string): CompletionItem[] {
  const items: CompletionItem[] = [];

  for (const name of cteNames) {
    items.push({
      label: name,
      kind: CompletionItemKind.Module,
      detail: 'CTE',
      sortText: `0_${name.toLowerCase()}`,
    });
  }

  // Apply case-insensitive prefix filtering
  if (!prefix) return items;
  const lowerPrefix = prefix.toLowerCase();
  return items.filter(item => (item.label as string).toLowerCase().startsWith(lowerPrefix));
}

/**
 * Returns column completions from tables referenced in FROM/JOIN clauses.
 * Shows data type and nullability in the detail field.
 * Excludes table references that match CTE names (no column inference from CTEs).
 *
 * @param batchText - The text of the current batch (not full document)
 * @param schemaCache - The schema cache
 * @param textBeforeCursor - Text before cursor for prefix detection
 * @param cteNames - Available CTE names
 * @param context - The current SQL clause context (for ranking)
 */
function getColumnCompletions(
  batchText: string,
  schemaCache: ISchemaCache,
  textBeforeCursor: string,
  cteNames: string[] = [],
  context: CompletionContext = 'NONE',
  multiDatabaseCache?: IMultiDatabaseCache | null
): CompletionItem[] {
  const prefix = getCurrentPrefix(textBeforeCursor);
  const tableRefs = extractTableReferences(batchText);
  const items: CompletionItem[] = [];

  // Build a set of CTE names (lowercase) to exclude from column resolution
  const cteNameSet = new Set(cteNames.map(n => n.toLowerCase()));

  for (const ref of tableRefs) {
    // Skip table references that match a CTE name (Requirement 7.1-7.5)
    // CTE references should not produce column completions
    if (!ref.schema && cteNameSet.has(ref.name.toLowerCase())) {
      continue;
    }

    const matchingTable = findTableOrView(schemaCache, ref, multiDatabaseCache);
    if (!matchingTable) continue;

    for (const col of matchingTable.columns) {
      const nullability = col.isNullable ? 'nullable' : 'not null';

      // In WHERE context, qualify columns with alias prefix when the table has an alias
      // (Requirements 6.1, 6.2, 6.3)
      if (context === 'WHERE' && ref.alias) {
        const label = `${ref.alias}.${col.name}`;
        items.push({
          label,
          kind: CompletionItemKind.Field,
          detail: `${col.dataType} (${nullability}) — ${ref.alias}`,
          insertText: label,
        });
      } else {
        items.push({
          label: col.name,
          kind: CompletionItemKind.Field,
          detail: `${col.dataType} (${nullability})`,
        });
      }
    }
  }

  // Deduplicate columns by name (same column name from different tables)
  const seen = new Set<string>();
  const deduplicated: CompletionItem[] = [];
  for (const item of items) {
    const key = `${item.label}|${item.detail}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(item);
    }
  }

  return filterByPrefix(deduplicated, prefix, item => item.label as string);
}

/**
 * Handles the case where the user has typed an alias followed by a dot (e.g., `o.`).
 * Returns only columns from the table matching the typed alias, without the alias
 * prefix in insertText (since the user has already typed `alias.`).
 *
 * Uses resolveAlias() from aliasResolver.ts for unified alias resolution that
 * handles both table aliases and CTE aliases/names via the cteSchemaMap.
 *
 * Returns null if the textBeforeCursor does not end with an alias.dot pattern,
 * allowing the caller to fall through to normal column completion logic.
 * Returns an empty array if the alias doesn't match any defined alias.
 *
 * @param textBeforeCursor - Text before the cursor position
 * @param batchText - The current batch text for table reference extraction
 * @param schemaCache - Schema cache for column lookup
 * @param cteNames - Available CTE names to exclude from alias matching
 * @param cteSchemaMap - Map of lowercase CTE name → ColumnInfo[] from buildCTESchemaMap()
 * @returns Column completions for the aliased table, empty array for unknown alias, or null if not an alias.dot pattern
 */
export function handleAliasDotPrefix(
  textBeforeCursor: string,
  batchText: string,
  schemaCache: ISchemaCache,
  cteNames: string[] = [],
  cteSchemaMap: Map<string, ColumnInfo[]> = new Map(),
  multiDatabaseCache?: IMultiDatabaseCache | null
): CompletionItem[] | null {
  // Extract the prefix at the cursor (includes dots for schema.name patterns)
  const prefix = getCurrentPrefix(textBeforeCursor);

  // Check if prefix matches "alias." or "alias.partialColumn" pattern
  const dotIndex = prefix.indexOf('.');
  if (dotIndex === -1) return null;

  const typedAlias = prefix.substring(0, dotIndex);
  const columnPrefix = prefix.substring(dotIndex + 1);

  // Don't treat schema-qualified names (e.g., "dbo.") as alias patterns
  // An alias is typically a short identifier assigned in FROM/JOIN, not a schema name
  // We check against table references to see if it matches an alias
  const tableRefs = extractTableReferences(batchText);

  // Use resolveAlias() for unified resolution (table aliases + CTE aliases/names)
  const resolution = resolveAlias(typedAlias, tableRefs, cteSchemaMap, schemaCache, multiDatabaseCache);

  // If the prefix is a schema name, let normal completion handle it
  if (resolution.isSchemaName) {
    return null;
  }

  // If alias was not found, return empty list (Requirement 6.5 / 7.4)
  if (!resolution.found) {
    // Check if the typed prefix could be a schema name (e.g., "dbo.")
    // that resolveAlias didn't detect (fallback check)
    const isSchemaPrefix = schemaCache.tables.some(
      t => t.schema.toLowerCase() === typedAlias.toLowerCase()
    ) || schemaCache.views.some(
      v => v.schema.toLowerCase() === typedAlias.toLowerCase()
    );

    if (isSchemaPrefix) {
      return null; // Let normal table/view completion handle schema.name patterns
    }

    return [];
  }

  // Build completion items from resolved columns
  const items: CompletionItem[] = [];
  for (const col of resolution.columns) {
    items.push({
      label: col.name,
      kind: CompletionItemKind.Field,
      detail: `${col.dataType} (${col.isNullable ? 'nullable' : 'not null'}) — ${typedAlias}`,
      insertText: col.name, // Only insert column name (alias.dot already typed)
      sortText: `${RANK_TIERS.COLUMNS_AND_ALIASES}_${col.name.toLowerCase()}`,
    });
  }

  // Apply column prefix filtering if user has typed characters after the dot
  if (columnPrefix) {
    const lowerPrefix = columnPrefix.toLowerCase();
    return items.filter(item => (item.label as string).toLowerCase().startsWith(lowerPrefix));
  }

  return items;
}

/**
 * Detects if the identifier immediately before the cursor matches a known
 * column from the current batch's table references.
 *
 * Handles both bare column names and alias-qualified names (e.g., "o.OrderDate").
 *
 * @param textBeforeCursor - Text before cursor position
 * @param batchText - Current batch text for table reference extraction
 * @param schemaCache - Schema cache for column lookup
 * @returns The matched ColumnInfo if found, or null
 */
export function detectColumnBeforeCursor(
  textBeforeCursor: string,
  batchText: string,
  schemaCache: ISchemaCache,
  multiDatabaseCache?: IMultiDatabaseCache | null
): ColumnInfo | null {
  // Strip literals and comments to avoid matching identifiers inside strings/comments
  const cleaned = stripLiteralsAndComments(textBeforeCursor);

  // Match the last identifier before cursor (possibly alias-qualified)
  // Supports: bare column names like "OrderDate" or alias.column like "o.OrderDate"
  const identMatch = cleaned.match(
    /\b([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?)\s*$/
  );
  if (!identMatch) return null;

  const identifier = identMatch[1];
  const tableRefs = extractTableReferences(batchText);

  // Handle alias.column pattern
  if (identifier.includes('.')) {
    const [alias, colName] = identifier.split('.');
    const ref = tableRefs.find(
      r => r.alias?.toLowerCase() === alias.toLowerCase()
    );
    if (!ref) return null;
    const table = findTableOrView(schemaCache, ref, multiDatabaseCache);
    if (!table) return null;
    return table.columns.find(
      c => c.name.toLowerCase() === colName.toLowerCase()
    ) || null;
  }

  // Handle bare column name — search all referenced tables
  for (const ref of tableRefs) {
    const table = findTableOrView(schemaCache, ref, multiDatabaseCache);
    if (!table) continue;
    const col = table.columns.find(
      c => c.name.toLowerCase() === identifier.toLowerCase()
    );
    if (col) return col;
  }

  return null;
}

// --- Data Type Constants for Operator Priority ---

/** String data types for operator priority */
export const STRING_TYPES = new Set([
  'varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext',
]);

/** Numeric data types for operator priority */
export const NUMERIC_TYPES = new Set([
  'int', 'bigint', 'smallint', 'tinyint',
  'decimal', 'numeric', 'float', 'real',
  'money', 'smallmoney',
]);

/** Date/time data types for operator priority */
export const DATETIME_TYPES = new Set([
  'date', 'datetime', 'datetime2', 'datetimeoffset',
  'smalldatetime', 'time',
]);

/**
 * Detects if the cursor is positioned after a column name in a WHERE clause
 * and returns comparison operator suggestions with data-type-aware ordering.
 *
 * @param textBeforeCursor - Text before the cursor
 * @param batchText - The current batch text
 * @param schemaCache - Schema cache for column type lookup
 * @returns Operator completion items, or empty array if not after a column
 */
export function getOperatorCompletions(
  textBeforeCursor: string,
  batchText: string,
  schemaCache: ISchemaCache,
  multiDatabaseCache?: IMultiDatabaseCache | null
): CompletionItem[] {
  const col = detectColumnBeforeCursor(textBeforeCursor, batchText, schemaCache, multiDatabaseCache);
  if (!col) return [];

  const operators = ['=', '<>', '<', '>', '>=', '<=', 'LIKE', 'IN', 'BETWEEN', 'IS NULL', 'IS NOT NULL'];
  const dataType = col.dataType.toLowerCase();

  let priorityOps: string[];
  if (STRING_TYPES.has(dataType)) {
    priorityOps = ['LIKE', '='];
  } else if (NUMERIC_TYPES.has(dataType)) {
    priorityOps = ['=', '<>', '<', '>', '>=', '<='];
  } else if (DATETIME_TYPES.has(dataType)) {
    priorityOps = ['BETWEEN', '>=', '<='];
  } else {
    priorityOps = []; // All equal priority
  }

  const prioritySet = new Set(priorityOps);

  return operators.map(op => ({
    label: op,
    kind: CompletionItemKind.Operator,
    detail: 'Comparison Operator',
    sortText: prioritySet.has(op) ? `0_${op}` : `1_${op}`,
  }));
}

// --- JOIN ON FK Column Completions ---

/**
 * Returns FK-related column pair completions for a JOIN ON context.
 *
 * When the user types `JOIN dbo.Orders o ON `, this function:
 * 1. Extracts the joined table name and alias from the text before cursor
 * 2. Extracts source tables from the FROM clause
 * 3. Looks up FK relationships between the joined table and source tables
 * 4. Returns completion items like "u.UserId = o.UserId"
 *
 * @param scopedText - The statement-scoped text for table reference extraction
 * @param textBeforeCursor - The full text before the cursor
 * @param schemaCache - The schema cache with FK data
 * @returns CompletionItem[] with FK column pair completions
 */
function getJoinOnCompletions(
  scopedText: string,
  textBeforeCursor: string,
  schemaCache: ISchemaCache
): CompletionItem[] {
  const items: CompletionItem[] = [];

  // Extract the joined table and alias from the text before cursor
  // Pattern: JOIN [schema.]table [alias] ON at the end
  const joinOnPattern = /\b(?:INNER\s+JOIN|LEFT\s+(?:OUTER\s+)?JOIN|RIGHT\s+(?:OUTER\s+)?JOIN|FULL\s+(?:OUTER\s+)?JOIN|CROSS\s+JOIN|JOIN)\s+(\[?[a-zA-Z_#]\w*\]?(?:\.?\[?[a-zA-Z_#]\w*\]?)?)(?:\s+(?:AS\s+)?([a-zA-Z_]\w*))?\s+ON\s+$/i;
  const cleaned = stripLiteralsAndComments(textBeforeCursor);
  const joinMatch = joinOnPattern.exec(cleaned);

  if (!joinMatch) {
    return items;
  }

  // Parse the joined table reference
  const joinedTableRaw = joinMatch[1];
  const joinedAlias = joinMatch[2];

  let joinedSchema: string | undefined;
  let joinedTableName: string;

  // Parse schema.table or just table
  const dotIndex = joinedTableRaw.indexOf('.');
  if (dotIndex !== -1) {
    joinedSchema = stripBrackets(joinedTableRaw.substring(0, dotIndex));
    joinedTableName = stripBrackets(joinedTableRaw.substring(dotIndex + 1));
  } else {
    joinedTableName = stripBrackets(joinedTableRaw);
  }

  const effectiveJoinedSchema = joinedSchema || 'dbo';
  const joinedRef: TableReference = {
    schema: effectiveJoinedSchema,
    name: joinedTableName,
    alias: joinedAlias,
  };

  // Extract source tables from the FROM clause (excluding the joined table itself)
  const allTableRefs = extractTableReferences(scopedText);
  const sourceTableRefs = allTableRefs.filter(ref => {
    const refSchema = ref.schema || 'dbo';
    return !(refSchema.toLowerCase() === effectiveJoinedSchema.toLowerCase() &&
             ref.name.toLowerCase() === joinedTableName.toLowerCase());
  });

  // Look up FK relationships for the joined table
  const fks = schemaCache.getForeignKeysForTable(effectiveJoinedSchema, joinedTableName);

  // Also look up FK relationships from source tables that reference the joined table
  for (const sourceRef of sourceTableRefs) {
    const sourceSchema = sourceRef.schema || 'dbo';
    const sourceFks = schemaCache.getForeignKeysForTable(sourceSchema, sourceRef.name);
    for (const fk of sourceFks) {
      // Only add if it relates to the joined table and isn't already in fks
      const referencedKey = `${fk.referencedSchema}.${fk.referencedTable}`.toLowerCase();
      const referencingKey = `${fk.referencingSchema}.${fk.referencingTable}`.toLowerCase();
      const joinedKey = `${effectiveJoinedSchema}.${joinedTableName}`.toLowerCase();

      if (referencedKey === joinedKey || referencingKey === joinedKey) {
        if (!fks.some(existing => existing.constraintName === fk.constraintName)) {
          fks.push(fk);
        }
      }
    }
  }

  if (fks.length === 0) {
    // No FK relationships found — fall back to column completions from all tables
    return items;
  }

  // Build ON condition completions from FK relationships
  const joinedKey = `${effectiveJoinedSchema}.${joinedTableName}`.toLowerCase();
  const joinedPrefix = joinedAlias || joinedTableName;

  for (const fk of fks) {
    const referencingKey = `${fk.referencingSchema}.${fk.referencingTable}`.toLowerCase();
    const referencedKey = `${fk.referencedSchema}.${fk.referencedTable}`.toLowerCase();

    // Determine which side is the joined table and which is the source
    let sourceRef: TableReference | undefined;
    let pairs: Array<{ sourceCol: string; joinedCol: string }>;

    if (referencingKey === joinedKey) {
      // Joined table is the referencing table → source is the referenced table
      sourceRef = sourceTableRefs.find(ref => {
        const refSchema = ref.schema || 'dbo';
        return refSchema.toLowerCase() === fk.referencedSchema.toLowerCase() &&
               ref.name.toLowerCase() === fk.referencedTable.toLowerCase();
      });
      pairs = fk.columnPairs.map(cp => ({
        joinedCol: cp.referencingColumn,
        sourceCol: cp.referencedColumn,
      }));
    } else if (referencedKey === joinedKey) {
      // Joined table is the referenced table → source is the referencing table
      sourceRef = sourceTableRefs.find(ref => {
        const refSchema = ref.schema || 'dbo';
        return refSchema.toLowerCase() === fk.referencingSchema.toLowerCase() &&
               ref.name.toLowerCase() === fk.referencingTable.toLowerCase();
      });
      pairs = fk.columnPairs.map(cp => ({
        joinedCol: cp.referencedColumn,
        sourceCol: cp.referencingColumn,
      }));
    } else {
      continue; // FK doesn't involve the joined table
    }

    if (!sourceRef) {
      continue; // Source table not found in FROM clause
    }

    const sourcePrefix = sourceRef.alias || sourceRef.name;

    // Build the ON condition text
    const onCondition = pairs
      .map(p => `${sourcePrefix}.${p.sourceCol} = ${joinedPrefix}.${p.joinedCol}`)
      .join(' AND ');

    // Create a completion item for this FK relationship
    const label = onCondition;
    const detail = `FK: ${fk.constraintName}`;

    items.push({
      label,
      kind: CompletionItemKind.Field,
      detail,
      insertText: onCondition,
      sortText: `${RANK_TIERS.REQUIRED_KEYWORD}_${label.toLowerCase()}`,
    });
  }

  return items;
}

// --- Aggregate Column Completions ---

/**
 * Snippet templates for aggregate function completions.
 * $1 marks the cursor position inside parentheses.
 */
const AGGREGATE_SNIPPETS: Record<string, string> = {
  'COUNT':        'COUNT($1)',
  'COUNT_BIG':    'COUNT_BIG($1)',
  'SUM':          'SUM($1)',
  'AVG':          'AVG($1)',
  'MIN':          'MIN($1)',
  'MAX':          'MAX($1)',
  'STDEV':        'STDEV($1)',
  'STDEVP':       'STDEVP($1)',
  'VAR':          'VAR($1)',
  'VARP':         'VARP($1)',
  'STRING_AGG':   'STRING_AGG($1, $2)',
  'CHECKSUM_AGG': 'CHECKSUM_AGG($1)',
};

/**
 * Returns aggregate function snippet completion items.
 * Each item inserts the function name with parentheses and a cursor placeholder,
 * and triggers re-completion after insertion so column suggestions appear immediately.
 *
 * @returns CompletionItem[] with snippet insertText and re-trigger command
 */
export function getAggregateFunctionSnippets(): CompletionItem[] {
  const items: CompletionItem[] = [];

  for (const [funcName, snippet] of Object.entries(AGGREGATE_SNIPPETS)) {
    items.push({
      label: funcName,
      kind: CompletionItemKind.Function,
      detail: 'Aggregate Function',
      insertText: snippet,
      insertTextFormat: InsertTextFormat.Snippet,
      command: {
        title: 'Trigger Suggest',
        command: 'editor.action.triggerSuggest',
      },
    });
  }

  return items;
}

/**
 * Returns column completions ranked by data type affinity for the
 * given aggregate function. Numeric columns get a higher sort priority
 * when inside SUM, AVG, STDEV, STDEVP, VAR, or VARP.
 *
 * For COUNT/COUNT_BIG: includes all columns plus a `*` item.
 * For MIN/MAX: includes all columns with equal ranking.
 * For numeric aggregates: numeric columns ranked higher than non-numeric.
 *
 * @param columns - Available columns from referenced tables (with optional tableAlias)
 * @param aggregateFunction - The aggregate function name (uppercase)
 * @param tableAlias - Optional table alias to prefix column names
 * @returns CompletionItem[] with sortText adjusted for type ranking
 */
export function getAggregateColumnCompletions(
  columns: Array<ColumnInfo & { tableAlias?: string }>,
  aggregateFunction: string
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const prefersNumeric = NUMERIC_AGGREGATE_FUNCTIONS.has(aggregateFunction);
  const supportsWildcard = WILDCARD_AGGREGATE_FUNCTIONS.has(aggregateFunction);

  // Add * for COUNT/COUNT_BIG
  if (supportsWildcard) {
    items.push({
      label: '*',
      kind: CompletionItemKind.Field,
      detail: 'All columns',
      sortText: '0_*',
    });
  }

  for (const col of columns) {
    const isNumeric = NUMERIC_DATA_TYPES.has(col.dataType.toLowerCase());
    const label = col.tableAlias ? `${col.tableAlias}.${col.name}` : col.name;
    const nullability = col.isNullable ? 'nullable' : 'not null';

    let sortText: string;
    if (prefersNumeric) {
      // Numeric columns ranked higher (tier 0), non-numeric lower (tier 2)
      sortText = isNumeric ? `0_${label.toLowerCase()}` : `2_${label.toLowerCase()}`;
    } else {
      // Equal ranking for all columns (MIN/MAX, COUNT, etc.)
      sortText = `1_${label.toLowerCase()}`;
    }

    items.push({
      label,
      kind: CompletionItemKind.Field,
      detail: `${col.dataType} (${nullability})${col.tableAlias ? ` — ${col.tableAlias}` : ''}`,
      sortText,
    });
  }

  return items;
}

/**
 * Returns the auto-populated GROUP BY completion item when conditions are met:
 * - SELECT has both aggregates and non-aggregated columns (needsGroupBy: true)
 * - No GROUP BY clause already exists in the statement
 * - Cursor is after FROM or WHERE (not inside SELECT list)
 *
 * The completion item is ranked at tier 0 when the user types a prefix
 * matching "GROUP" (e.g., "GR", "GROUP", "GROUP B").
 *
 * @param statementText - The full current statement text
 * @param context - The detected completion context
 * @returns CompletionItem or null if conditions not met
 */
export function getGroupByCompletion(
  statementText: string,
  context: CompletionContext
): CompletionItem | null {
  try {
    // Condition 1: Cursor must be after FROM or WHERE (not inside SELECT list)
    // Valid contexts: FROM, WHERE, JOIN, GROUP_BY, ORDER_BY, NONE
    // We also allow NONE context since user might be typing "GROUP" at a blank position after FROM
    if (context === 'SELECT' || context === 'EXEC' || context === 'CTE' ||
        context === 'UPDATE' || context === 'DECLARE') {
      return null;
    }

    // Condition 2: Check if GROUP BY already exists in the statement (case-insensitive)
    if (/\bGROUP\s+BY\b/i.test(statementText)) {
      return null;
    }

    // Condition 3: Analyze the SELECT list for aggregates + non-aggregated columns
    const analysis = analyzeSelectList(statementText);
    if (!analysis.needsGroupBy) {
      return null;
    }

    // Build the GROUP BY column list
    const columnList = buildGroupByColumnList(analysis.nonAggregatedExpressions);
    if (!columnList) {
      return null;
    }

    // Build the completion item
    const insertText = `GROUP BY ${columnList}`;
    const label = `GROUP BY ${columnList}`;

    return {
      label,
      kind: CompletionItemKind.Snippet,
      detail: 'Add GROUP BY for non-aggregated columns',
      insertText,
      sortText: `0_group by`,
    };
  } catch {
    // Graceful degradation: return null on any error
    return null;
  }
}

/**
 * Extracts column expressions from the GROUP BY clause of a SQL statement.
 * Returns an array of column expression strings (e.g., ["o.CustomerID", "o.OrderDate"]).
 * Returns an empty array if no GROUP BY clause is found.
 *
 * @param statementText - The full SQL statement text
 * @returns Array of GROUP BY column expression strings
 */
function extractGroupByColumns(statementText: string): string[] {
  const cleaned = stripLiteralsAndComments(statementText);

  // Find the GROUP BY clause
  const groupByMatch = /\bGROUP\s+BY\b/gi.exec(cleaned);
  if (!groupByMatch) return [];

  const afterGroupBy = cleaned.substring(groupByMatch.index + groupByMatch[0].length);

  // Find the end of the GROUP BY clause (next major keyword or end of text)
  const endKeywords = /\b(?:HAVING|ORDER\s+BY|UNION|EXCEPT|INTERSECT|FOR|OPTION)\b/i;
  const endMatch = endKeywords.exec(afterGroupBy);
  const groupByText = endMatch ? afterGroupBy.substring(0, endMatch.index) : afterGroupBy;

  // Split by commas respecting parenthesis depth
  const columns: string[] = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < groupByText.length; i++) {
    const ch = groupByText[i];
    if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) columns.push(trimmed);
      current = '';
    } else {
      current += ch;
    }
  }

  const lastTrimmed = current.trim();
  if (lastTrimmed) columns.push(lastTrimmed);

  return columns;
}

/**
 * Finds a table or view in the schema cache matching a table reference.
 */
function findTableOrView(
  schemaCache: ISchemaCache,
  ref: TableReference,
  multiDatabaseCache?: IMultiDatabaseCache | null
): TableInfo | ViewInfo | null {
  // If the reference has a database qualifier, look it up in the multiDatabaseCache
  if (ref.database && multiDatabaseCache) {
    const targetCache = multiDatabaseCache.getCache(ref.database);
    if (targetCache) {
      const schemaToMatch = ref.schema || 'dbo';
      const table = targetCache.tables.find(
        t => t.schema.toLowerCase() === schemaToMatch.toLowerCase() &&
             t.name.toLowerCase() === ref.name.toLowerCase()
      );
      if (table) return table;

      const view = targetCache.views.find(
        v => v.schema.toLowerCase() === schemaToMatch.toLowerCase() &&
             v.name.toLowerCase() === ref.name.toLowerCase()
      );
      if (view) return view;
    }
    // If the database matches the primary cache, fall through to normal lookup
    if (ref.database.toLowerCase() !== (multiDatabaseCache.primaryDatabase || '').toLowerCase()) {
      return null;
    }
  }

  // Try to match with schema prefix
  if (ref.schema) {
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
    // No schema specified - match by name only
    const table = schemaCache.tables.find(
      t => t.name.toLowerCase() === ref.name.toLowerCase()
    );
    if (table) return table;

    const view = schemaCache.views.find(
      v => v.name.toLowerCase() === ref.name.toLowerCase()
    );
    if (view) return view;
  }

  return null;
}

/**
 * Returns stored procedure completions with schema prefixes.
 */
function getProcedureCompletions(
  schemaCache: ISchemaCache,
  textBeforeCursor: string
): CompletionItem[] {
  const prefix = getCurrentPrefix(textBeforeCursor);
  const hasSchemaDot = prefix.includes('.');
  const items: CompletionItem[] = [];

  for (const proc of schemaCache.procedures) {
    const label = `${proc.schema}.${proc.name}`;
    const item: CompletionItem = {
      label,
      kind: CompletionItemKind.Method,
      detail: 'Stored Procedure',
    };
    // When the user has already typed a schema prefix (e.g., "dbo."),
    // set insertText to just the procedure name to avoid duplication
    if (hasSchemaDot) {
      item.insertText = proc.name;
    }
    items.push(item);
  }

  return filterByPrefix(items, prefix, item => item.label as string);
}

/**
 * Returns SQL Server data type keyword completions for DECLARE context.
 * Provides common T-SQL data types as keyword completion items.
 */
export function getDataTypeCompletions(): CompletionItem[] {
  const dataTypes = [
    'INT', 'VARCHAR', 'NVARCHAR', 'BIGINT', 'SMALLINT', 'TINYINT', 'BIT',
    'DATETIME', 'DATETIME2', 'DATE', 'TIME', 'FLOAT', 'DECIMAL', 'NUMERIC',
    'CHAR', 'NCHAR', 'TEXT', 'NTEXT', 'UNIQUEIDENTIFIER', 'XML',
    'VARBINARY', 'BINARY', 'MONEY', 'SMALLMONEY', 'REAL', 'TABLE',
  ];

  return dataTypes.map(dt => ({
    label: dt,
    kind: CompletionItemKind.Keyword,
    detail: 'Data Type',
  }));
}

/**
 * Returns SQL Server keyword and built-in function completions.
 */
function getKeywordCompletions(textBeforeCursor: string): CompletionItem[] {
  const prefix = getCurrentPrefix(textBeforeCursor);
  const items: CompletionItem[] = [];

  for (const keyword of SQL_KEYWORDS) {
    items.push({
      label: keyword,
      kind: CompletionItemKind.Keyword,
      detail: 'Keyword',
    });
  }

  for (const func of SQL_BUILTIN_FUNCTIONS) {
    items.push({
      label: func,
      kind: CompletionItemKind.Function,
      detail: 'Built-in Function',
    });
  }

  return filterByPrefix(items, prefix, item => item.label as string);
}

/**
 * Returns completions for dynamic SQL context (inside EXEC() or sp_executesql strings).
 *
 * Uses the extracted SQL text from the dynamic SQL parser to detect the SQL clause
 * context and provide appropriate completions:
 * - If connected and the extracted SQL references a cached table in FROM/JOIN,
 *   provides column completions in SELECT/WHERE/ORDER BY/GROUP BY/HAVING contexts
 * - If not connected or context is unparseable (NONE with no clause keywords),
 *   falls back to keyword-only completions
 *
 * @param dynamicCtx - The dynamic SQL context from detectDynamicSqlContext()
 * @param schemaCache - The schema cache (or null if disconnected)
 * @param isConnected - Whether there is an active database connection
 * @returns Completion items appropriate for the dynamic SQL context
 */
function getDynamicSqlCompletions(
  dynamicCtx: DynamicSqlContext,
  schemaCache: ISchemaCache | null,
  isConnected: boolean
): CompletionItem[] {
  const { extractedSql, cursorOffset } = dynamicCtx;

  // Use the extracted SQL text up to the cursor offset for context detection
  const textBeforeCursor = extractedSql.substring(0, cursorOffset);

  // Detect the SQL clause context within the extracted dynamic SQL
  const context = detectContext(textBeforeCursor);

  // If not connected or no schema cache, return keyword-only completions
  if (!isConnected || !schemaCache) {
    return getKeywordCompletions(textBeforeCursor);
  }

  // If context is NONE and no clause keywords are present, fall back to keywords
  if (context === 'NONE') {
    // Check if there are any recognizable clause keywords in the extracted SQL
    const hasClauseKeywords = /\b(?:SELECT|FROM|WHERE|JOIN|ORDER\s+BY|GROUP\s+BY|HAVING|INSERT|UPDATE|DELETE|EXEC|EXECUTE|DECLARE)\b/i.test(extractedSql);
    if (!hasClauseKeywords) {
      return getKeywordCompletions(textBeforeCursor);
    }
    // If there are clause keywords but context is NONE (cursor before first keyword),
    // still return keywords
    return getKeywordCompletions(textBeforeCursor);
  }

  // For column-providing contexts (SELECT, WHERE, ORDER_BY, GROUP_BY, HAVING),
  // extract table references from the full extracted SQL and provide column completions
  const columnContexts: CompletionContext[] = ['SELECT', 'WHERE', 'ORDER_BY', 'GROUP_BY', 'HAVING'];
  if (columnContexts.includes(context)) {
    // Extract table references from the full extracted SQL
    const tableRefs = extractTableReferences(extractedSql);

    // Check if any referenced table exists in the schema cache
    const resolvedColumns: CompletionItem[] = [];
    for (const ref of tableRefs) {
      const matchingTable = findTableOrView(schemaCache, ref);
      if (!matchingTable) continue;

      for (const col of matchingTable.columns) {
        const nullability = col.isNullable ? 'nullable' : 'not null';
        resolvedColumns.push({
          label: col.name,
          kind: CompletionItemKind.Field,
          detail: `${col.dataType} (${nullability})`,
        });
      }
    }

    if (resolvedColumns.length > 0) {
      // Provide column completions filtered by prefix, plus contextual keywords
      const prefix = getCurrentPrefix(textBeforeCursor);
      const filteredColumns = filterByPrefix(resolvedColumns, prefix, item => item.label as string);

      // Also include contextual keywords for the current context
      const contextualKeywords = getContextualKeywords(context, textBeforeCursor);
      const merged = [...filteredColumns, ...contextualKeywords];

      return applyTieredRanking(merged, [], context);
    }

    // No tables found in schema cache — fall back to keyword completions
    return getKeywordCompletions(textBeforeCursor);
  }

  // For FROM/JOIN contexts, provide table/view completions
  if (context === 'FROM' || context === 'JOIN') {
    const tableCompletions = getTableAndViewCompletions(schemaCache, textBeforeCursor);
    return applyTieredRanking(tableCompletions, [], context);
  }

  // For EXEC context, provide procedure completions
  if (context === 'EXEC') {
    return getProcedureCompletions(schemaCache, textBeforeCursor);
  }

  // For all other contexts, return keyword completions
  return getKeywordCompletions(textBeforeCursor);
}

/**
 * Returns CTE body completions when the cursor is after `WITH <name> AS`.
 * Provides a (SELECT snippet for starting the CTE body and relevant keywords.
 */
function getCTECompletions(): CompletionItem[] {
  return [
    {
      label: '(SELECT',
      kind: CompletionItemKind.Snippet,
      detail: 'CTE Body',
      insertText: '(\n    SELECT $1\n    FROM $2\n)',
    },
    {
      label: 'SELECT',
      kind: CompletionItemKind.Keyword,
      detail: 'Keyword',
    },
    {
      label: 'INSERT',
      kind: CompletionItemKind.Keyword,
      detail: 'Keyword',
    },
    {
      label: 'UPDATE',
      kind: CompletionItemKind.Keyword,
      detail: 'Keyword',
    },
    {
      label: 'DELETE',
      kind: CompletionItemKind.Keyword,
      detail: 'Keyword',
    },
  ];
}

// --- Statement-Level Scoping ---

/**
 * A segment of SQL text representing one statement within a batch.
 */
export interface StatementSegment {
  /** The text content of this statement segment */
  text: string;
  /** The character offset within the batch text where this segment starts */
  startOffset: number;
  /** The character offset within the batch text where this segment ends (exclusive) */
  endOffset: number;
}

/**
 * Keywords that start new SQL statements when they appear at parenthesis
 * depth zero. Matched case-insensitively.
 */
export const TOP_LEVEL_KEYWORDS = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE',
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
  'EXEC', 'EXECUTE',
  'WITH', 'DECLARE', 'SET',
  'IF', 'WHILE', 'BEGIN',
]);

/**
 * Keywords that represent the "consuming DML" after a CTE block.
 * When a WITH...AS block is detected, the splitter looks for one of
 * these keywords to end the CTE scope (the CTE + this DML = one segment).
 */
export const CTE_CONSUMING_KEYWORDS = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE',
]);

/**
 * Determines if position `pos` in text is the start of a top-level
 * keyword that constitutes a statement boundary.
 *
 * A keyword is a boundary when:
 * - It matches a TOP_LEVEL_KEYWORDS entry (case-insensitive)
 * - It is not mid-identifier (preceded by a word character)
 * - It is followed by a word boundary (whitespace, paren, or end of text)
 * - It is preceded by: a newline (possibly with whitespace after it),
 *   or only whitespace since the segment start
 * - pos > segmentStart (don't split at the very start of the current segment)
 */
function isTopLevelKeywordBoundary(
  text: string,
  pos: number,
  segmentStart: number
): boolean {
  // Don't split at the very start of the current segment
  if (pos === segmentStart) return false;

  // Must be at a word boundary (not mid-identifier)
  if (pos > 0 && /[a-zA-Z0-9_]/.test(text[pos - 1])) {
    return false;
  }

  // Try to match a keyword at this position
  const remaining = text.substring(pos);
  const keywordMatch = remaining.match(/^([a-zA-Z]+)\b/);
  if (!keywordMatch) return false;

  const keyword = keywordMatch[1].toUpperCase();
  if (!TOP_LEVEL_KEYWORDS.has(keyword)) return false;

  // Check preceding context: must be first non-whitespace on a new line
  // or first token after segment start (only whitespace between segmentStart and pos)
  const textBefore = text.substring(segmentStart, pos);

  // Check if preceded by newline (with optional whitespace after it)
  const lastNewline = textBefore.lastIndexOf('\n');
  if (lastNewline !== -1) {
    const afterNewline = textBefore.substring(lastNewline + 1);
    if (/^\s*$/.test(afterNewline)) {
      return true; // Keyword is first non-whitespace on a new line
    }
  }

  // Also treat as boundary if the preceding text (since segment start) is only whitespace
  // (e.g., after a semicolon-terminated segment on the same line)
  if (/^\s*$/.test(textBefore)) {
    return true;
  }

  return false;
}

/**
 * Checks if position `pos` starts a CTE pattern: WITH <identifier> AS (
 */
function isCTEStart(text: string, pos: number): boolean {
  const remaining = text.substring(pos);
  return /^with\s+(?:\[[^\]]*\]|[a-zA-Z_][a-zA-Z0-9_]*)\s+as\s*\(/i.test(remaining);
}

/**
 * Finds the position of the matching closing parenthesis for statement splitting.
 * Handles nested parentheses, string literals, and comments.
 * Returns -1 if no match found.
 */
function findMatchingParenPosition(text: string, openPos: number): number {
  let depth = 0;
  let inStr = false;
  let inBlock = false;
  let inLine = false;

  for (let i = openPos; i < text.length; i++) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';

    if (inLine) {
      if (ch === '\n') inLine = false;
      continue;
    }

    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }

    if (inStr) {
      if (ch === "'") {
        if (next === "'") {
          i++; // escaped quote
        } else {
          inStr = false;
        }
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      inLine = true;
      i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }

    if (ch === "'") {
      inStr = true;
      continue;
    }

    if ((ch === 'N' || ch === 'n') && next === "'") {
      inStr = true;
      i++;
      continue;
    }

    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

/**
 * Skips past a CTE block (WITH name AS (...) [, name2 AS (...)] <consuming DML>)
 * and returns the position at the consuming DML keyword.
 * The entire CTE block + consuming DML remains in the current segment.
 */
function skipCTEBlock(text: string, withPos: number): number {
  let pos = withPos;

  // Skip past "WITH"
  pos += 4;

  // Parse CTE definitions (name AS (...), name2 AS (...), ...)
  while (pos < text.length) {
    // Skip whitespace
    while (pos < text.length && /\s/.test(text[pos])) pos++;

    if (pos >= text.length) break;

    // Skip CTE name (identifier or bracketed identifier)
    if (text[pos] === '[') {
      const close = text.indexOf(']', pos + 1);
      if (close === -1) return text.length;
      pos = close + 1;
    } else if (/[a-zA-Z_]/.test(text[pos])) {
      while (pos < text.length && /[a-zA-Z0-9_]/.test(text[pos])) pos++;
    } else {
      break;
    }

    // Skip whitespace + AS
    while (pos < text.length && /\s/.test(text[pos])) pos++;
    if (pos + 2 <= text.length && text.substring(pos, pos + 2).toLowerCase() === 'as') {
      pos += 2;
    } else {
      break;
    }

    // Skip whitespace
    while (pos < text.length && /\s/.test(text[pos])) pos++;

    // Skip the parenthesized CTE body
    if (pos < text.length && text[pos] === '(') {
      const closePos = findMatchingParenPosition(text, pos);
      if (closePos === -1) return text.length; // Unbalanced — treat rest as current segment
      pos = closePos + 1; // Move past closing paren
    } else {
      break;
    }

    // Skip whitespace
    while (pos < text.length && /\s/.test(text[pos])) pos++;

    // Check for comma (another CTE definition)
    if (pos < text.length && text[pos] === ',') {
      pos++;
      continue;
    }

    break;
  }

  // Now pos should be at the consuming DML keyword (SELECT, INSERT, etc.)
  // The consuming DML is part of this CTE scope — don't split here.
  // Return pos to continue scanning from after the CTE definitions.
  return pos;
}

/**
 * Splits batch text into individual statement segments.
 *
 * Statement boundaries are:
 * - Semicolons at parenthesis depth zero (not inside strings/comments)
 * - Top-level DML/DDL keywords at parenthesis depth zero that start a new
 *   logical line or follow a semicolon-terminated statement
 *
 * CTE blocks (WITH name AS (...) [, name2 AS (...)] SELECT/INSERT/UPDATE/DELETE/MERGE)
 * are kept as a single segment including the consuming DML statement.
 *
 * Subqueries (parenthesized SELECT) do NOT create statement boundaries.
 *
 * @param batchText - The text of the current batch (output of extractCurrentBatch)
 * @returns Array of statement segments in document order. Concatenating all
 *          segment texts produces the original batchText character-for-character.
 */
export function splitStatements(batchText: string): StatementSegment[] {
  if (!batchText || !batchText.trim()) {
    return [{ text: batchText, startOffset: 0, endOffset: batchText.length }];
  }

  const segments: StatementSegment[] = [];
  let segmentStart = 0;
  let depth = 0; // Parenthesis depth counter
  let i = 0;
  let inString = false;
  let inBlockComment = false;
  let inLineComment = false;

  while (i < batchText.length) {
    const ch = batchText[i];
    const next = i + 1 < batchText.length ? batchText[i + 1] : '';

    // Handle line comment state
    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
      }
      i++;
      continue;
    }

    // Handle block comment state
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    // Handle string literal state
    if (inString) {
      if (ch === "'") {
        if (next === "'") {
          i += 2; // Escaped quote
        } else {
          inString = false;
          i++;
        }
      } else {
        i++;
      }
      continue;
    }

    // Enter line comment
    if (ch === '-' && next === '-') {
      inLineComment = true;
      i += 2;
      continue;
    }

    // Enter block comment
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }

    // Enter string literal
    if (ch === "'") {
      inString = true;
      i++;
      continue;
    }
    if ((ch === 'N' || ch === 'n') && next === "'" && (i === 0 || !/[a-zA-Z0-9_]/.test(batchText[i - 1]))) {
      inString = true;
      i += 2;
      continue;
    }

    // Track parenthesis depth
    if (ch === '(') {
      depth++;
      i++;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth--;
      i++;
      continue;
    }

    // Only detect boundaries at depth 0
    if (depth === 0) {
      // Semicolon boundary
      if (ch === ';') {
        // Include the semicolon in the current segment
        const segmentEnd = i + 1;
        segments.push({
          text: batchText.substring(segmentStart, segmentEnd),
          startOffset: segmentStart,
          endOffset: segmentEnd,
        });
        segmentStart = segmentEnd;
        i++;
        continue;
      }

      // Check for CTE pattern at any WITH keyword (even at segment start)
      // This must be checked before the keyword boundary logic to prevent
      // the consuming DML from being split into a separate segment.
      if (/[a-zA-Z]/.test(ch)) {
        // Check if this position starts a WITH keyword that is a CTE
        if ((ch === 'W' || ch === 'w') && isCTEStart(batchText, i)) {
          // Ensure we're at a word boundary (not mid-identifier)
          if (i === 0 || !/[a-zA-Z0-9_]/.test(batchText[i - 1])) {
            // If this CTE starts a new statement (not at segment start), emit previous segment
            if (i > segmentStart && isTopLevelKeywordBoundary(batchText, i, segmentStart)) {
              segments.push({
                text: batchText.substring(segmentStart, i),
                startOffset: segmentStart,
                endOffset: i,
              });
              segmentStart = i;
            }
            // Skip past the entire CTE block definitions to the consuming DML keyword.
            // The consuming DML is part of this CTE scope — skip past its keyword
            // so it doesn't trigger a boundary on the next iteration.
            const cteEnd = skipCTEBlock(batchText, i);
            const consumingMatch = batchText.substring(cteEnd).match(/^([a-zA-Z]+)\b/);
            if (consumingMatch) {
              i = cteEnd + consumingMatch[0].length;
            } else {
              i = cteEnd;
            }
            continue;
          }
        }

        // Top-level keyword boundary
        if (isTopLevelKeywordBoundary(batchText, i, segmentStart)) {
          // Start a new segment at this keyword (if not at segment start)
          if (i > segmentStart) {
            segments.push({
              text: batchText.substring(segmentStart, i),
              startOffset: segmentStart,
              endOffset: i,
            });
            segmentStart = i;
          }
          i++;
          continue;
        }
      }
    }

    i++;
  }

  // Final segment (remaining text)
  if (segmentStart < batchText.length) {
    segments.push({
      text: batchText.substring(segmentStart, batchText.length),
      startOffset: segmentStart,
      endOffset: batchText.length,
    });
  }

  return segments;
}

/**
 * Finds the statement segment containing the given cursor offset.
 *
 * When the cursor is exactly on a semicolon or in whitespace between
 * statements (after a boundary, before the next keyword), the cursor
 * is assigned to the preceding statement scope.
 *
 * @param segments - Array of statement segments from splitStatements()
 * @param offsetInBatch - Cursor offset relative to the start of the batch text
 * @returns The statement segment containing the cursor, or the last segment
 *          if the offset is beyond all segments
 */
export function findStatementAtOffset(
  segments: StatementSegment[],
  offsetInBatch: number
): StatementSegment {
  if (segments.length === 0) {
    return { text: '', startOffset: 0, endOffset: 0 };
  }

  // Find the segment containing the offset
  for (const segment of segments) {
    if (offsetInBatch >= segment.startOffset && offsetInBatch < segment.endOffset) {
      return segment;
    }
  }

  // If offset is exactly at a segment boundary (e.g., on a semicolon that
  // ended the previous segment), or beyond all segments, return the last segment
  // that ends at or before the offset
  for (let i = segments.length - 1; i >= 0; i--) {
    if (offsetInBatch >= segments[i].startOffset) {
      return segments[i];
    }
  }

  // Fallback: return first segment
  return segments[0];
}

/**
 * Extracts the statement-scoped text for the cursor position within a batch.
 *
 * This is the primary integration point: given batch text and a cursor offset
 * within that batch, returns the narrowed statement text that should be used
 * for table reference extraction.
 *
 * For single-statement batches (no boundaries detected), returns the full
 * batch text unchanged (preserving backward compatibility).
 *
 * @param batchText - The batch text from extractCurrentBatch()
 * @param offsetInBatch - Cursor offset relative to batch start
 * @returns The statement-scoped text for table reference extraction
 */
export function getStatementScopeText(
  batchText: string,
  offsetInBatch: number
): string {
  const segments = splitStatements(batchText);

  // Single segment = single statement batch → return full batch text (backward compat)
  if (segments.length <= 1) {
    return batchText;
  }

  const segment = findStatementAtOffset(segments, offsetInBatch);
  return segment.text;
}
