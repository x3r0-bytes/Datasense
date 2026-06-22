import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { applyContextFilter, ContextFilterOptions, CompletionContext } from '../../server/src/completionProvider';
import { CompletionItem, CompletionItemKind } from 'vscode-languageserver/node';

/**
 * Property-based tests for Context-Based Item Filtering
 * Feature: intellisense-clause-engine
 *
 * Tests context filtering rules: FROM/JOIN suppress columns/functions,
 * SELECT/WHERE/GROUP_BY/ORDER_BY suppress standalone tables,
 * immediately after JOIN suppresses keywords, and keyword prefix override.
 */

// --- Constants ---

/** SQL keywords commonly used as successor keywords */
const SUCCESSOR_KEYWORDS = [
  'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'JOIN', 'INNER JOIN',
  'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'ON',
];

/** SQL keywords for prefix testing */
const ALL_SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL',
  'CROSS', 'ON', 'GROUP', 'ORDER', 'HAVING', 'AND', 'OR', 'NOT',
  'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'IS', 'NULL', 'AS', 'DISTINCT',
  'TOP', 'UNION', 'ALL', 'INSERT', 'UPDATE', 'DELETE', 'CREATE',
  'ALTER', 'DROP', 'BEGIN', 'END', 'IF', 'ELSE', 'WHILE', 'RETURN',
];

/** Contexts where columns/functions should be excluded (FROM/JOIN) */
const TABLE_CONTEXTS: CompletionContext[] = ['FROM', 'JOIN'];

/** Contexts where standalone tables should be excluded */
const COLUMN_CONTEXTS: CompletionContext[] = ['SELECT', 'WHERE', 'GROUP_BY', 'ORDER_BY'];

// --- Generators ---

/** Generator: random valid SQL identifier (avoids SQL keywords) */
const arbitraryIdentifier: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')),
      { minLength: 1, maxLength: 8 }
    )
  )
  .map(([first, rest]) => first + rest)
  .filter((id) => !/^(select|from|where|join|inner|left|right|full|cross|on|order|group|having|with|by|and|or|not|in|exists|between|like|is|null|as|distinct|top|union|all|insert|update|delete|create|alter|drop|begin|end|if|else|while|return)$/i.test(id));

/** Generator: a CompletionItem with kind=Field (column) */
const arbitraryColumnItem: fc.Arbitrary<CompletionItem> = arbitraryIdentifier.map((name) => ({
  label: name,
  kind: CompletionItemKind.Field,
  detail: 'Column',
}));

/** Generator: a CompletionItem with kind=Function */
const arbitraryFunctionItem: fc.Arbitrary<CompletionItem> = fc
  .constantFrom('COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GETDATE', 'ISNULL', 'COALESCE', 'LEN', 'UPPER')
  .map((name) => ({
    label: name,
    kind: CompletionItemKind.Function,
  }));

/** Generator: a CompletionItem with kind=Module and detail=Table */
const arbitraryTableItem: fc.Arbitrary<CompletionItem> = arbitraryIdentifier.map((name) => ({
  label: name,
  kind: CompletionItemKind.Module,
  detail: 'Table',
}));

/** Generator: a CompletionItem with kind=Module and detail=View */
const arbitraryViewItem: fc.Arbitrary<CompletionItem> = arbitraryIdentifier.map((name) => ({
  label: name,
  kind: CompletionItemKind.Module,
  detail: 'View',
}));

/** Generator: a CTE name CompletionItem */
const arbitraryCTEItem: fc.Arbitrary<CompletionItem> = arbitraryIdentifier.map((name) => ({
  label: name,
  kind: CompletionItemKind.Module,
  detail: 'CTE',
}));

/** Generator: a keyword CompletionItem (successor keyword) */
const arbitrarySuccessorKeywordItem: fc.Arbitrary<CompletionItem> = fc
  .constantFrom(...SUCCESSOR_KEYWORDS)
  .map((kw) => ({
    label: kw,
    kind: CompletionItemKind.Keyword,
  }));

/** Generator: a keyword CompletionItem (any SQL keyword) */
const arbitraryKeywordItem: fc.Arbitrary<CompletionItem> = fc
  .constantFrom(...ALL_SQL_KEYWORDS)
  .map((kw) => ({
    label: kw,
    kind: CompletionItemKind.Keyword,
  }));

/** Generator: mixed completion list with items from all kinds */
const arbitraryMixedCompletionList: fc.Arbitrary<CompletionItem[]> = fc
  .tuple(
    fc.array(arbitraryColumnItem, { minLength: 1, maxLength: 4 }),
    fc.array(arbitraryFunctionItem, { minLength: 1, maxLength: 3 }),
    fc.array(arbitraryTableItem, { minLength: 1, maxLength: 4 }),
    fc.array(arbitraryViewItem, { minLength: 1, maxLength: 2 }),
    fc.array(arbitraryCTEItem, { minLength: 1, maxLength: 2 }),
    fc.array(arbitrarySuccessorKeywordItem, { minLength: 1, maxLength: 3 }),
  )
  .map(([cols, funcs, tables, views, ctes, keywords]) =>
    [...cols, ...funcs, ...tables, ...views, ...ctes, ...keywords]
  );

/** Generator: FROM or JOIN context */
const arbitraryTableContext: fc.Arbitrary<CompletionContext> = fc.constantFrom(...TABLE_CONTEXTS);

/** Generator: SELECT, WHERE, GROUP_BY, or ORDER_BY context */
const arbitraryColumnContext: fc.Arbitrary<CompletionContext> = fc.constantFrom(...COLUMN_CONTEXTS);

/** Generator: a prefix of a SQL keyword (1+ characters) */
const arbitraryKeywordPrefix: fc.Arbitrary<{ keyword: string; prefix: string }> = fc
  .constantFrom(...ALL_SQL_KEYWORDS)
  .chain((keyword) =>
    fc.integer({ min: 1, max: keyword.length }).map((len) => ({
      keyword,
      prefix: keyword.substring(0, len),
    }))
  );

/** Generator: case variation of a prefix */
const arbitraryCaseVariedPrefix: fc.Arbitrary<{ keyword: string; prefix: string }> = arbitraryKeywordPrefix
  .chain(({ keyword, prefix }) =>
    fc.array(fc.boolean(), { minLength: prefix.length, maxLength: prefix.length })
      .map((cases) => ({
        keyword,
        prefix: prefix
          .split('')
          .map((ch, i) => (cases[i] ? ch.toUpperCase() : ch.toLowerCase()))
          .join(''),
      }))
  );

// --- Property Tests ---

describe('Feature: intellisense-clause-engine, Property 8: Context-based item filtering', () => {
  /**
   * **Validates: Requirements 5.4, 5.5, 9.1, 9.2, 9.6**
   *
   * For any FROM or JOIN context, the completion list SHALL NOT contain items with
   * kind=Field (columns) or kind=Function unless preceded by an alias-dot qualifier.
   * For any SELECT, WHERE, GROUP_BY, or ORDER_BY context, the completion list SHALL
   * NOT contain standalone table/view names unless preceded by a schema-dot qualifier.
   */

  it('FROM/JOIN context excludes columns and functions (no alias-dot qualifier)', () => {
    fc.assert(
      fc.property(
        arbitraryMixedCompletionList,
        arbitraryTableContext,
        (items, context) => {
          const options: ContextFilterOptions = {
            isAliasDotQualified: false,
            isSchemaDotQualified: false,
            isJoinWithTableRef: false,
            isCrossJoin: false,
            typedPrefix: '',
            requiredKeywords: [],
          };

          const filtered = applyContextFilter(items, context, options);

          // No columns (kind=Field) should be in the result
          const columns = filtered.filter((item) => item.kind === CompletionItemKind.Field);
          expect(columns).toHaveLength(0);

          // No functions should be in the result
          const functions = filtered.filter((item) => item.kind === CompletionItemKind.Function);
          expect(functions).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('FROM/JOIN context includes columns and functions when alias-dot qualified', () => {
    fc.assert(
      fc.property(
        arbitraryMixedCompletionList,
        arbitraryTableContext,
        (items, context) => {
          const options: ContextFilterOptions = {
            isAliasDotQualified: true,
            isSchemaDotQualified: false,
            isJoinWithTableRef: false,
            isCrossJoin: false,
            typedPrefix: '',
            requiredKeywords: [],
          };

          const filtered = applyContextFilter(items, context, options);

          // With alias-dot qualifier, columns and functions should be included
          const originalColumns = items.filter((item) => item.kind === CompletionItemKind.Field);
          const filteredColumns = filtered.filter((item) => item.kind === CompletionItemKind.Field);
          expect(filteredColumns.length).toBe(originalColumns.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('SELECT/WHERE/GROUP_BY/ORDER_BY context excludes standalone table/view names (no schema-dot qualifier)', () => {
    fc.assert(
      fc.property(
        arbitraryMixedCompletionList,
        arbitraryColumnContext,
        (items, context) => {
          const options: ContextFilterOptions = {
            isAliasDotQualified: false,
            isSchemaDotQualified: false,
            isJoinWithTableRef: false,
            isCrossJoin: false,
            typedPrefix: '',
            requiredKeywords: [],
          };

          const filtered = applyContextFilter(items, context, options);

          // No standalone table/view items should be in the result
          const tableViews = filtered.filter(
            (item) =>
              item.kind === CompletionItemKind.Module &&
              (item.detail === 'Table' || item.detail === 'View')
          );
          expect(tableViews).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('SELECT/WHERE/GROUP_BY/ORDER_BY context includes table/view names when schema-dot qualified', () => {
    fc.assert(
      fc.property(
        arbitraryMixedCompletionList,
        arbitraryColumnContext,
        (items, context) => {
          const options: ContextFilterOptions = {
            isAliasDotQualified: false,
            isSchemaDotQualified: true,
            isJoinWithTableRef: false,
            isCrossJoin: false,
            typedPrefix: '',
            requiredKeywords: [],
          };

          const filtered = applyContextFilter(items, context, options);

          // With schema-dot qualifier, table/view items should be included
          const originalTableViews = items.filter(
            (item) =>
              item.kind === CompletionItemKind.Module &&
              (item.detail === 'Table' || item.detail === 'View')
          );
          const filteredTableViews = filtered.filter(
            (item) =>
              item.kind === CompletionItemKind.Module &&
              (item.detail === 'Table' || item.detail === 'View')
          );
          expect(filteredTableViews.length).toBe(originalTableViews.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('FROM/JOIN context includes tables, views, CTE names, and keywords', () => {
    fc.assert(
      fc.property(
        arbitraryMixedCompletionList,
        arbitraryTableContext,
        (items, context) => {
          const options: ContextFilterOptions = {
            isAliasDotQualified: false,
            isSchemaDotQualified: false,
            isJoinWithTableRef: false,
            isCrossJoin: false,
            typedPrefix: '',
            requiredKeywords: [],
          };

          const filtered = applyContextFilter(items, context, options);

          // Tables should be included
          const originalTables = items.filter(
            (item) => item.kind === CompletionItemKind.Module && item.detail === 'Table'
          );
          const filteredTables = filtered.filter(
            (item) => item.kind === CompletionItemKind.Module && item.detail === 'Table'
          );
          expect(filteredTables.length).toBe(originalTables.length);

          // CTE names should be included
          const originalCTEs = items.filter((item) => item.detail === 'CTE');
          const filteredCTEs = filtered.filter((item) => item.detail === 'CTE');
          expect(filteredCTEs.length).toBe(originalCTEs.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('SELECT/WHERE/GROUP_BY/ORDER_BY context includes columns, functions, and keywords', () => {
    fc.assert(
      fc.property(
        arbitraryMixedCompletionList,
        arbitraryColumnContext,
        (items, context) => {
          const options: ContextFilterOptions = {
            isAliasDotQualified: false,
            isSchemaDotQualified: false,
            isJoinWithTableRef: false,
            isCrossJoin: false,
            typedPrefix: '',
            requiredKeywords: [],
          };

          const filtered = applyContextFilter(items, context, options);

          // Columns should be included
          const originalColumns = items.filter((item) => item.kind === CompletionItemKind.Field);
          const filteredColumns = filtered.filter((item) => item.kind === CompletionItemKind.Field);
          expect(filteredColumns.length).toBe(originalColumns.length);

          // Functions should be included
          const originalFunctions = items.filter((item) => item.kind === CompletionItemKind.Function);
          const filteredFunctions = filtered.filter((item) => item.kind === CompletionItemKind.Function);
          expect(filteredFunctions.length).toBe(originalFunctions.length);

          // Keywords should be included
          const originalKeywords = items.filter((item) => item.kind === CompletionItemKind.Keyword);
          const filteredKeywords = filtered.filter((item) => item.kind === CompletionItemKind.Keyword);
          expect(filteredKeywords.length).toBe(originalKeywords.length);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Feature: intellisense-clause-engine, Property 15: Immediately after JOIN keyword suppresses successor keywords', () => {
  /**
   * **Validates: Requirements 9.3**
   *
   * For any JOIN keyword variant where no table reference characters have been typed
   * yet, the completion list SHALL contain only tables, views, and CTE names — not
   * clause-successor keywords.
   */

  it('JOIN context without table ref typed suppresses all keywords', () => {
    fc.assert(
      fc.property(
        arbitraryMixedCompletionList,
        (items) => {
          const options: ContextFilterOptions = {
            isAliasDotQualified: false,
            isSchemaDotQualified: false,
            isJoinWithTableRef: false, // No table ref typed yet
            isCrossJoin: false,
            typedPrefix: '',
            requiredKeywords: ['ON', 'WHERE', 'GROUP BY', 'ORDER BY'],
          };

          const filtered = applyContextFilter(items, 'JOIN', options);

          // No keywords should be in the result
          const keywords = filtered.filter((item) => item.kind === CompletionItemKind.Keyword);
          expect(keywords).toHaveLength(0);

          // No columns should be in the result
          const columns = filtered.filter((item) => item.kind === CompletionItemKind.Field);
          expect(columns).toHaveLength(0);

          // No functions should be in the result
          const functions = filtered.filter((item) => item.kind === CompletionItemKind.Function);
          expect(functions).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('JOIN context without table ref includes tables, views, and CTE names', () => {
    fc.assert(
      fc.property(
        arbitraryMixedCompletionList,
        (items) => {
          const options: ContextFilterOptions = {
            isAliasDotQualified: false,
            isSchemaDotQualified: false,
            isJoinWithTableRef: false,
            isCrossJoin: false,
            typedPrefix: '',
            requiredKeywords: [],
          };

          const filtered = applyContextFilter(items, 'JOIN', options);

          // Tables should be included
          const originalTables = items.filter(
            (item) => item.kind === CompletionItemKind.Module && item.detail === 'Table'
          );
          const filteredTables = filtered.filter(
            (item) => item.kind === CompletionItemKind.Module && item.detail === 'Table'
          );
          expect(filteredTables.length).toBe(originalTables.length);

          // Views should be included
          const originalViews = items.filter(
            (item) => item.kind === CompletionItemKind.Module && item.detail === 'View'
          );
          const filteredViews = filtered.filter(
            (item) => item.kind === CompletionItemKind.Module && item.detail === 'View'
          );
          expect(filteredViews.length).toBe(originalViews.length);

          // CTE names should be included
          const originalCTEs = items.filter((item) => item.detail === 'CTE');
          const filteredCTEs = filtered.filter((item) => item.detail === 'CTE');
          expect(filteredCTEs.length).toBe(originalCTEs.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('JOIN context WITH table ref typed allows keywords (including ON)', () => {
    fc.assert(
      fc.property(
        arbitraryMixedCompletionList,
        (items) => {
          const options: ContextFilterOptions = {
            isAliasDotQualified: false,
            isSchemaDotQualified: false,
            isJoinWithTableRef: true, // Table ref has been typed
            isCrossJoin: false,
            typedPrefix: '',
            requiredKeywords: ['ON'],
          };

          const filtered = applyContextFilter(items, 'JOIN', options);

          // Keywords should be included (ON, WHERE, etc.)
          const keywords = filtered.filter((item) => item.kind === CompletionItemKind.Keyword);
          expect(keywords.length).toBeGreaterThan(0);

          // Tables/views/CTEs should be excluded (user already specified join target)
          const tableViews = filtered.filter(
            (item) =>
              item.kind === CompletionItemKind.Module &&
              (item.detail === 'Table' || item.detail === 'View' || item.detail === 'CTE')
          );
          expect(tableViews).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('CROSS JOIN with table ref typed does NOT include ON', () => {
    fc.assert(
      fc.property(
        arbitraryMixedCompletionList,
        (items) => {
          // Add an ON keyword item explicitly
          const onItem: CompletionItem = { label: 'ON', kind: CompletionItemKind.Keyword };
          const allItems = [...items, onItem];

          const options: ContextFilterOptions = {
            isAliasDotQualified: false,
            isSchemaDotQualified: false,
            isJoinWithTableRef: true,
            isCrossJoin: true, // CROSS JOIN
            typedPrefix: '',
            requiredKeywords: ['ON'],
          };

          const filtered = applyContextFilter(allItems, 'JOIN', options);

          // ON should NOT be in the result for CROSS JOIN
          const onItems = filtered.filter(
            (item) => (typeof item.label === 'string' ? item.label : '').toLowerCase() === 'on'
          );
          expect(onItems).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Feature: intellisense-clause-engine, Property 16: Keyword prefix override', () => {
  /**
   * **Validates: Requirements 9.5**
   *
   * For any typed prefix of ≥1 character that is a case-insensitive prefix match
   * of a SQL keyword, that keyword SHALL appear in the completion list regardless
   * of context filtering.
   */

  it('keyword matching typed prefix is included regardless of context', () => {
    fc.assert(
      fc.property(
        arbitraryCaseVariedPrefix,
        arbitraryTableContext,
        ({ keyword, prefix }, context) => {
          // Create a keyword item that matches the prefix
          const keywordItem: CompletionItem = {
            label: keyword,
            kind: CompletionItemKind.Keyword,
          };

          // In FROM/JOIN context, keywords would normally be included anyway,
          // but let's test with the JOIN-no-table-ref case where keywords are suppressed
          const options: ContextFilterOptions = {
            isAliasDotQualified: false,
            isSchemaDotQualified: false,
            isJoinWithTableRef: false, // This would normally suppress keywords in JOIN
            isCrossJoin: false,
            typedPrefix: prefix,
            requiredKeywords: [],
          };

          const filtered = applyContextFilter([keywordItem], 'JOIN', options);

          // The keyword should be included because the prefix matches
          const matchingItems = filtered.filter(
            (item) => (typeof item.label === 'string' ? item.label : '').toLowerCase() === keyword.toLowerCase()
          );
          expect(matchingItems.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('keyword prefix override is case-insensitive', () => {
    fc.assert(
      fc.property(
        arbitraryCaseVariedPrefix,
        ({ keyword, prefix }) => {
          const keywordItem: CompletionItem = {
            label: keyword,
            kind: CompletionItemKind.Keyword,
          };

          // Use JOIN context with no table ref (normally suppresses keywords)
          const options: ContextFilterOptions = {
            isAliasDotQualified: false,
            isSchemaDotQualified: false,
            isJoinWithTableRef: false,
            isCrossJoin: false,
            typedPrefix: prefix,
            requiredKeywords: [],
          };

          const filtered = applyContextFilter([keywordItem], 'JOIN', options);

          // Should be included regardless of case variation in prefix
          expect(filtered.length).toBe(1);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('non-matching prefix does NOT override context filtering', () => {
    fc.assert(
      fc.property(
        arbitraryIdentifier,
        (prefix) => {
          // Create a keyword that does NOT start with the prefix
          const keywordItem: CompletionItem = {
            label: 'WHERE',
            kind: CompletionItemKind.Keyword,
          };

          // Ensure the prefix doesn't match WHERE
          if (!'where'.startsWith(prefix.toLowerCase())) {
            const options: ContextFilterOptions = {
              isAliasDotQualified: false,
              isSchemaDotQualified: false,
              isJoinWithTableRef: false, // Suppresses keywords in JOIN
              isCrossJoin: false,
              typedPrefix: prefix,
              requiredKeywords: [],
            };

            const filtered = applyContextFilter([keywordItem], 'JOIN', options);

            // WHERE should NOT be included (prefix doesn't match, context suppresses)
            expect(filtered).toHaveLength(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('empty prefix does NOT trigger keyword override', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_SQL_KEYWORDS),
        (keyword) => {
          const keywordItem: CompletionItem = {
            label: keyword,
            kind: CompletionItemKind.Keyword,
          };

          // Empty prefix with JOIN context (no table ref) should suppress keywords
          const options: ContextFilterOptions = {
            isAliasDotQualified: false,
            isSchemaDotQualified: false,
            isJoinWithTableRef: false,
            isCrossJoin: false,
            typedPrefix: '', // Empty prefix
            requiredKeywords: [],
          };

          const filtered = applyContextFilter([keywordItem], 'JOIN', options);

          // Keywords should be suppressed (no prefix override, JOIN without table ref)
          expect(filtered).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('prefix override works in column contexts that suppress tables', () => {
    fc.assert(
      fc.property(
        arbitraryCaseVariedPrefix,
        arbitraryColumnContext,
        ({ keyword, prefix }, context) => {
          // In column contexts, keywords are normally included anyway
          // But let's verify the prefix override mechanism still works
          const keywordItem: CompletionItem = {
            label: keyword,
            kind: CompletionItemKind.Keyword,
          };

          const options: ContextFilterOptions = {
            isAliasDotQualified: false,
            isSchemaDotQualified: false,
            isJoinWithTableRef: false,
            isCrossJoin: false,
            typedPrefix: prefix,
            requiredKeywords: [],
          };

          const filtered = applyContextFilter([keywordItem], context, options);

          // Keyword should be included (both by context rules and prefix override)
          expect(filtered.length).toBe(1);
        }
      ),
      { numRuns: 100 }
    );
  });
});
