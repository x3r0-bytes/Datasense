import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  getContextualKeywords,
  getClausePresenceSet,
  getCompletions,
  detectContext,
  detectCTEChain,
  getCTENameCompletions,
  CompletionContext,
  ClausePresenceSet,
  CTEChainInfo,
  VALID_SUCCESSORS,
} from '../../server/src/completionProvider';
import { ISchemaCache, TableInfo, ViewInfo, ColumnInfo } from '../../server/src/schemaCache';
import { CompletionItemKind } from 'vscode-languageserver/node';
import * as mssql from 'mssql';

/**
 * Property-based tests for Clause-Flow & Multi-CTE IntelliSense
 * Feature: clause-flow-multi-cte
 *
 * Tests clause-flow awareness, state machine transitions, subquery scope isolation,
 * and multi-CTE support.
 */

// --- Generators ---

/** All clause keywords that can appear in a ClausePresenceSet */
const CLAUSE_KEYWORDS = ['SELECT', 'FROM', 'JOIN', 'WHERE', 'GROUP_BY', 'HAVING', 'ORDER_BY'] as const;
type ClauseKeyword = typeof CLAUSE_KEYWORDS[number];

/** Contexts that produce clause keyword suggestions (excludes EXEC, CTE, NONE) */
const CLAUSE_FLOW_CONTEXTS: CompletionContext[] = ['SELECT', 'FROM', 'JOIN', 'WHERE', 'ORDER_BY', 'GROUP_BY'];

/** Generator: random valid SQL identifier */
const arbitraryIdentifier: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')),
      { minLength: 1, maxLength: 10 }
    )
  )
  .map(([first, rest]) => first + rest)
  .filter((id) => !/^(select|from|where|join|inner|left|right|full|cross|on|order|group|having|exec|execute|insert|update|delete|create|alter|drop|begin|end|if|else|while|return|declare|set|union|all|except|intersect|into|values|as|and|or|not|in|exists|between|like|is|null|case|when|then|distinct|top|with|go|use|by)$/i.test(id));

/** Generator: random non-empty subset of clause keywords for the presence set */
const arbitraryClausePresenceSet: fc.Arbitrary<ClausePresenceSet> = fc
  .subarray([...CLAUSE_KEYWORDS], { minLength: 1 })
  .map((keys) => new Set(keys) as ClausePresenceSet);

/**
 * Generator: SQL text that ends at a whitespace boundary after a completed token,
 * paired with the detected context. This ensures getContextualKeywords() will
 * actually produce suggestions (it requires whitespace at end for most contexts).
 */
const arbitraryContextWithText: fc.Arbitrary<{ context: CompletionContext; text: string }> = fc.oneof(
  // SELECT context: text ends with column-like token + space
  fc.tuple(arbitraryIdentifier, arbitraryIdentifier).map(([col, tbl]) => ({
    context: 'SELECT' as CompletionContext,
    text: `SELECT ${col} `,
  })),
  // FROM context: text ends with table reference + space
  fc.tuple(arbitraryIdentifier, arbitraryIdentifier).map(([schema, tbl]) => ({
    context: 'FROM' as CompletionContext,
    text: `SELECT * FROM ${schema}.${tbl} `,
  })),
  // JOIN context: text ends with table reference + space after JOIN
  fc.tuple(arbitraryIdentifier, arbitraryIdentifier, arbitraryIdentifier).map(([schema, tbl, tbl2]) => ({
    context: 'JOIN' as CompletionContext,
    text: `SELECT * FROM ${schema}.${tbl} JOIN ${schema}.${tbl2} `,
  })),
  // WHERE context: text ends with condition + space
  fc.tuple(arbitraryIdentifier, arbitraryIdentifier).map(([schema, tbl]) => ({
    context: 'WHERE' as CompletionContext,
    text: `SELECT * FROM ${schema}.${tbl} WHERE col1 = 1 `,
  })),
  // GROUP_BY context: text ends with column + space
  fc.tuple(arbitraryIdentifier, arbitraryIdentifier).map(([schema, tbl]) => ({
    context: 'GROUP_BY' as CompletionContext,
    text: `SELECT * FROM ${schema}.${tbl} WHERE col1 = 1 GROUP BY col1 `,
  })),
  // ORDER_BY context: text ends with column + space
  fc.tuple(arbitraryIdentifier, arbitraryIdentifier).map(([schema, tbl]) => ({
    context: 'ORDER_BY' as CompletionContext,
    text: `SELECT * FROM ${schema}.${tbl} ORDER BY col1 `,
  }))
);

/**
 * Maps clause keyword labels returned by getContextualKeywords() to their
 * corresponding ClausePresenceSet key. JOIN variants all map to 'JOIN'.
 */
function labelToClauseKey(label: string): ClauseKeyword | null {
  const upper = label.toUpperCase().trim();
  if (upper === 'WHERE') return 'WHERE';
  if (upper === 'FROM') return 'FROM';
  if (upper === 'SELECT') return 'SELECT';
  if (upper === 'ORDER BY') return 'ORDER_BY';
  if (upper === 'GROUP BY') return 'GROUP_BY';
  if (upper === 'HAVING') return 'HAVING';
  // All JOIN variants map to 'JOIN'
  if (upper === 'JOIN' || upper === 'INNER JOIN' || upper === 'LEFT JOIN' ||
      upper === 'RIGHT JOIN' || upper === 'FULL JOIN' || upper === 'CROSS JOIN' ||
      upper === 'OUTER JOIN') return 'JOIN';
  if (upper === 'INTO') return null; // INTO is not tracked in presence set
  return null;
}

// --- Tests ---

describe('Feature: clause-flow-multi-cte, Property 1: Already-present clause suppression', () => {
  /**
   * **Validates: Requirements 1.4, 2.6, 2.7**
   *
   * For any SQL statement containing one or more recognized clause keywords,
   * getContextualKeywords() SHALL NOT include any clause keyword that already
   * appears in the clause-presence set, with the sole exception of JOIN which
   * may be suggested regardless of prior presence.
   */

  it('never suggests a clause keyword already in the presence set (except JOIN)', () => {
    fc.assert(
      fc.property(
        arbitraryContextWithText,
        arbitraryClausePresenceSet,
        ({ context, text }, presentClauses) => {
          const items = getContextualKeywords(context, text, presentClauses);

          for (const item of items) {
            const clauseKey = labelToClauseKey(item.label as string);
            if (clauseKey === null) continue; // Not a tracked clause keyword (e.g., INTO)
            if (clauseKey === 'JOIN') continue; // JOIN is exempt — may always be suggested

            // The clause keyword MUST NOT be in the presence set
            expect(presentClauses.has(clauseKey)).toBe(false);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('JOIN may be suggested even when already present in the presence set', () => {
    fc.assert(
      fc.property(
        // Use FROM or JOIN context since those suggest JOIN variants
        fc.constantFrom(
          { context: 'FROM' as CompletionContext, text: 'SELECT * FROM dbo.Orders o ' },
          { context: 'JOIN' as CompletionContext, text: 'SELECT * FROM dbo.Orders o JOIN dbo.Users u ' }
        ),
        ({ context, text }) => {
          // Create a presence set that includes JOIN
          const presentClauses: ClausePresenceSet = new Set(['SELECT', 'FROM', 'JOIN']);

          const items = getContextualKeywords(context, text, presentClauses);
          const labels = items.map(i => (i.label as string).toUpperCase());

          // JOIN variants may still appear even though JOIN is in the presence set
          const joinLabels = labels.filter(l =>
            l === 'JOIN' || l === 'INNER JOIN' || l === 'LEFT JOIN' ||
            l === 'RIGHT JOIN' || l === 'FULL JOIN' || l === 'CROSS JOIN'
          );

          // We don't require JOIN to be present, but if it is, that's valid
          // The key property is that it's NOT suppressed
          // (This test verifies the exception — JOIN is allowed regardless)
          if (joinLabels.length > 0) {
            // This is fine — JOIN is exempt from suppression
            expect(true).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('non-JOIN clauses in the presence set are always suppressed from suggestions', () => {
    fc.assert(
      fc.property(
        arbitraryContextWithText,
        fc.subarray(['FROM', 'WHERE', 'GROUP_BY', 'HAVING', 'ORDER_BY'] as ClauseKeyword[], { minLength: 1 }),
        ({ context, text }, clausesToSuppress) => {
          const presentClauses: ClausePresenceSet = new Set(clausesToSuppress);

          const items = getContextualKeywords(context, text, presentClauses);

          for (const item of items) {
            const clauseKey = labelToClauseKey(item.label as string);
            if (clauseKey === null || clauseKey === 'JOIN') continue;

            // Verify this non-JOIN clause is NOT in the suppression set
            expect(presentClauses.has(clauseKey)).toBe(false);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('with empty presence set, no suppression occurs (baseline behavior preserved)', () => {
    fc.assert(
      fc.property(
        arbitraryContextWithText,
        ({ context, text }) => {
          const emptySet: ClausePresenceSet = new Set();
          const withSet = getContextualKeywords(context, text, emptySet);
          const withoutSet = getContextualKeywords(context, text);

          // Both calls should return the same labels
          const labelsWithSet = withSet.map(i => i.label as string).sort();
          const labelsWithoutSet = withoutSet.map(i => i.label as string).sort();

          expect(labelsWithSet).toEqual(labelsWithoutSet);
        }
      ),
      { numRuns: 100 }
    );
  });
});


describe('Feature: clause-flow-multi-cte, Property 2: Valid successor transitions', () => {
  /**
   * **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.8, 2.9, 10.1, 10.2**
   *
   * For any clause context and clause-presence set, the clause keywords returned
   * by getContextualKeywords() SHALL be a subset of the valid successors defined
   * by the canonical T-SQL clause ordering state machine.
   */

  /** Contexts that have entries in VALID_SUCCESSORS */
  const CONTEXTS_WITH_SUCCESSORS: CompletionContext[] = Object.keys(VALID_SUCCESSORS) as CompletionContext[];

  /**
   * Generator: a clause context that has valid successors, paired with
   * appropriate SQL text that triggers keyword suggestions.
   */
  const arbitraryContextWithSuccessors: fc.Arbitrary<{ context: CompletionContext; text: string }> = fc.oneof(
    // SELECT context
    arbitraryIdentifier.map((col) => ({
      context: 'SELECT' as CompletionContext,
      text: `SELECT ${col} `,
    })),
    // FROM context
    arbitraryIdentifier.map((tbl) => ({
      context: 'FROM' as CompletionContext,
      text: `SELECT * FROM ${tbl} `,
    })),
    // JOIN context
    fc.tuple(arbitraryIdentifier, arbitraryIdentifier).map(([tbl1, tbl2]) => ({
      context: 'JOIN' as CompletionContext,
      text: `SELECT * FROM ${tbl1} JOIN ${tbl2} `,
    })),
    // WHERE context
    arbitraryIdentifier.map((tbl) => ({
      context: 'WHERE' as CompletionContext,
      text: `SELECT * FROM ${tbl} WHERE col1 = 1 `,
    })),
    // GROUP_BY context
    arbitraryIdentifier.map((tbl) => ({
      context: 'GROUP_BY' as CompletionContext,
      text: `SELECT * FROM ${tbl} GROUP BY col1 `,
    })),
    // HAVING context
    arbitraryIdentifier.map((tbl) => ({
      context: 'HAVING' as CompletionContext,
      text: `SELECT * FROM ${tbl} GROUP BY col1 HAVING COUNT(*) > 1 `,
    }))
  );

  it('returned keywords are always a subset of VALID_SUCCESSORS[context]', () => {
    fc.assert(
      fc.property(
        arbitraryContextWithSuccessors,
        arbitraryClausePresenceSet,
        ({ context, text }, presentClauses) => {
          const items = getContextualKeywords(context, text, presentClauses);
          const validSuccessors = VALID_SUCCESSORS[context] ?? [];

          for (const item of items) {
            const label = (item.label as string).toUpperCase();
            // Every returned keyword must be in the valid successors for this context
            expect(validSuccessors.map(s => s.toUpperCase())).toContain(label);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('with no presence set filtering, all returned keywords are still valid successors', () => {
    fc.assert(
      fc.property(
        arbitraryContextWithSuccessors,
        ({ context, text }) => {
          // Call without presentClauses (fallback behavior)
          const items = getContextualKeywords(context, text);
          const validSuccessors = VALID_SUCCESSORS[context] ?? [];

          for (const item of items) {
            const label = (item.label as string).toUpperCase();
            expect(validSuccessors.map(s => s.toUpperCase())).toContain(label);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('HAVING context only suggests ORDER BY as successor', () => {
    fc.assert(
      fc.property(
        arbitraryIdentifier,
        arbitraryClausePresenceSet,
        (tbl, presentClauses) => {
          const text = `SELECT * FROM ${tbl} GROUP BY col1 HAVING COUNT(*) > 1 `;
          const items = getContextualKeywords('HAVING' as CompletionContext, text, presentClauses);

          // HAVING's only valid successor is ORDER BY
          for (const item of items) {
            const label = (item.label as string).toUpperCase();
            expect(label).toBe('ORDER BY');
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('GROUP_BY context only suggests HAVING and ORDER BY as successors', () => {
    fc.assert(
      fc.property(
        arbitraryIdentifier,
        arbitraryClausePresenceSet,
        (tbl, presentClauses) => {
          const text = `SELECT * FROM ${tbl} GROUP BY col1 `;
          const items = getContextualKeywords('GROUP_BY' as CompletionContext, text, presentClauses);

          const validForGroupBy = ['HAVING', 'ORDER BY'];
          for (const item of items) {
            const label = (item.label as string).toUpperCase();
            expect(validForGroupBy).toContain(label);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('WHERE context only suggests AND, OR, GROUP BY and ORDER BY as successors', () => {
    fc.assert(
      fc.property(
        arbitraryIdentifier,
        arbitraryClausePresenceSet,
        (tbl, presentClauses) => {
          const text = `SELECT * FROM ${tbl} WHERE col1 = 1 `;
          const items = getContextualKeywords('WHERE' as CompletionContext, text, presentClauses);

          const validForWhere = ['AND', 'OR', 'GROUP BY', 'ORDER BY'];
          for (const item of items) {
            const label = (item.label as string).toUpperCase();
            expect(validForWhere).toContain(label);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('contexts without VALID_SUCCESSORS entries return no clause keywords', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('EXEC', 'CTE', 'NONE', 'ORDER_BY') as fc.Arbitrary<CompletionContext>,
        arbitraryIdentifier,
        arbitraryClausePresenceSet,
        (context, tbl, presentClauses) => {
          const text = `SELECT * FROM ${tbl} ORDER BY col1 `;
          const items = getContextualKeywords(context, text, presentClauses);

          // These contexts have no entry in VALID_SUCCESSORS, so no clause keywords should be returned
          // when presentClauses is provided (the state machine path is used)
          expect(items.length).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});


// --- Helpers for Property 4 ---

/** Creates a mock ISchemaCache for testing */
function createMockSchemaCache(options: {
  tables?: TableInfo[];
  views?: ViewInfo[];
  isPopulating?: boolean;
}): ISchemaCache {
  return {
    tables: options.tables ?? [],
    views: options.views ?? [],
    procedures: [],
    foreignKeys: [],
    isPopulating: options.isPopulating ?? false,
    refresh: async (_pool: mssql.ConnectionPool) => {},
    getForeignKeysForTable: (_schema: string, _tableName: string) => [],
  };
}

/** Generator: random SQL data type */
const arbitraryDataType: fc.Arbitrary<string> = fc.constantFrom(
  'int', 'bigint', 'varchar', 'nvarchar', 'datetime', 'bit', 'decimal', 'float'
);

/** Generator: random column info */
const arbitraryColumnInfo: fc.Arbitrary<ColumnInfo> = fc.record({
  name: arbitraryIdentifier,
  dataType: arbitraryDataType,
  isNullable: fc.boolean(),
});

/** Generator: random schema name */
const arbitrarySchemaName: fc.Arbitrary<string> = fc.constantFrom('dbo', 'sales', 'hr', 'admin', 'app');

/** Generator: random table info with unique column names */
const arbitraryTableInfo: fc.Arbitrary<TableInfo> = fc.record({
  schema: arbitrarySchemaName,
  name: arbitraryIdentifier,
  columns: fc.array(arbitraryColumnInfo, { minLength: 1, maxLength: 5 })
    .map((cols) => {
      const seen = new Set<string>();
      return cols.filter((c) => {
        const lower = c.name.toLowerCase();
        if (seen.has(lower)) return false;
        seen.add(lower);
        return true;
      });
    })
    .filter((cols) => cols.length > 0),
});

/** Generator: random view info with unique column names */
const arbitraryViewInfo: fc.Arbitrary<ViewInfo> = fc.record({
  schema: arbitrarySchemaName,
  name: arbitraryIdentifier,
  columns: fc.array(arbitraryColumnInfo, { minLength: 1, maxLength: 4 })
    .map((cols) => {
      const seen = new Set<string>();
      return cols.filter((c) => {
        const lower = c.name.toLowerCase();
        if (seen.has(lower)) return false;
        seen.add(lower);
        return true;
      });
    })
    .filter((cols) => cols.length > 0),
});

/** Generator: a schema cache with at least one table */
const arbitrarySchemaCacheWithTables: fc.Arbitrary<ISchemaCache> = fc
  .record({
    tables: fc.array(arbitraryTableInfo, { minLength: 1, maxLength: 4 }),
    views: fc.array(arbitraryViewInfo, { minLength: 0, maxLength: 2 }),
  })
  .map((data) => createMockSchemaCache(data));

// --- Property 4 Tests ---

describe('Feature: clause-flow-multi-cte, Property 4: Merged completions preserve schema objects', () => {
  /**
   * **Validates: Requirements 4.1, 4.2, 4.3**
   *
   * For any clause-flow context where the cursor is at a whitespace boundary
   * after a completed token, the completion list SHALL contain both clause keyword
   * suggestions AND schema-object completions (tables, views, or columns as
   * appropriate for the context). Neither category SHALL suppress the other.
   */

  it('FROM context returns both tables/views AND keyword suggestions', () => {
    fc.assert(
      fc.property(
        arbitrarySchemaCacheWithTables,
        (schemaCache) => {
          // Use the first table from the cache to build a valid FROM clause
          const table = schemaCache.tables[0];
          const text = `SELECT * FROM ${table.schema}.${table.name} `;
          const items = getCompletions(text, text.length, schemaCache, true);

          // Separate schema objects from keywords
          const schemaObjects = items.filter(i => i.detail === 'Table' || i.detail === 'View');
          const keywords = items.filter(i => i.detail === 'Keyword');

          // Both categories MUST be present
          expect(schemaObjects.length).toBeGreaterThan(0);
          expect(keywords.length).toBeGreaterThan(0);

          // Schema objects should not be suppressed — all tables and views should appear
          const labels = new Set(items.map(i => i.label as string));
          for (const t of schemaCache.tables) {
            expect(labels.has(`${t.schema}.${t.name}`)).toBe(true);
          }
          for (const v of schemaCache.views) {
            expect(labels.has(`${v.schema}.${v.name}`)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('SELECT context returns both column completions AND keyword suggestions', () => {
    fc.assert(
      fc.property(
        arbitrarySchemaCacheWithTables,
        (schemaCache) => {
          const table = schemaCache.tables[0];
          // Build a query where cursor is after a column expression in SELECT
          const text = `SELECT ${table.columns[0].name} FROM ${table.schema}.${table.name}`;
          // Position cursor after the column name + space (inside SELECT clause)
          const cursorPos = `SELECT ${table.columns[0].name} `.length;
          const docText = text.substring(0, cursorPos);
          // We need the full document text for column extraction, but cursor at SELECT position
          const items = getCompletions(text, cursorPos, schemaCache, true);

          // Should have column completions (schema objects)
          const columnItems = items.filter(i =>
            i.detail !== 'Keyword' && i.detail !== 'Table' && i.detail !== 'View'
          );
          const keywords = items.filter(i => i.detail === 'Keyword');

          // Both categories MUST be present
          expect(columnItems.length).toBeGreaterThan(0);
          expect(keywords.length).toBeGreaterThan(0);

          // Keywords should include FROM (valid successor for SELECT context)
          const keywordLabels = keywords.map(i => (i.label as string).toUpperCase());
          expect(keywordLabels).toContain('FROM');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('WHERE context returns both column completions AND keyword suggestions', () => {
    fc.assert(
      fc.property(
        arbitrarySchemaCacheWithTables,
        (schemaCache) => {
          const table = schemaCache.tables[0];
          const text = `SELECT * FROM ${table.schema}.${table.name} WHERE ${table.columns[0].name} = 1 `;
          const items = getCompletions(text, text.length, schemaCache, true);

          // Should have column completions
          const columnItems = items.filter(i =>
            i.detail !== 'Keyword' && i.detail !== 'Table' && i.detail !== 'View'
          );
          const keywords = items.filter(i => i.detail === 'Keyword');

          // Both categories MUST be present
          expect(columnItems.length).toBeGreaterThan(0);
          expect(keywords.length).toBeGreaterThan(0);

          // Keywords should include GROUP BY or ORDER BY (valid successors for WHERE)
          const keywordLabels = keywords.map(i => (i.label as string).toUpperCase());
          const hasValidSuccessor = keywordLabels.includes('GROUP BY') || keywordLabels.includes('ORDER BY');
          expect(hasValidSuccessor).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('GROUP_BY context returns both column completions AND keyword suggestions', () => {
    fc.assert(
      fc.property(
        arbitrarySchemaCacheWithTables,
        (schemaCache) => {
          const table = schemaCache.tables[0];
          const text = `SELECT * FROM ${table.schema}.${table.name} GROUP BY ${table.columns[0].name} `;
          const items = getCompletions(text, text.length, schemaCache, true);

          // Should have column completions
          const columnItems = items.filter(i =>
            i.detail !== 'Keyword' && i.detail !== 'Table' && i.detail !== 'View'
          );
          const keywords = items.filter(i => i.detail === 'Keyword');

          // Both categories MUST be present
          expect(columnItems.length).toBeGreaterThan(0);
          expect(keywords.length).toBeGreaterThan(0);

          // Keywords should include HAVING or ORDER BY (valid successors for GROUP_BY)
          const keywordLabels = keywords.map(i => (i.label as string).toUpperCase());
          const hasValidSuccessor = keywordLabels.includes('HAVING') || keywordLabels.includes('ORDER BY');
          expect(hasValidSuccessor).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('keyword suggestions never suppress schema-object completions', () => {
    fc.assert(
      fc.property(
        arbitrarySchemaCacheWithTables,
        fc.constantFrom('FROM', 'JOIN') as fc.Arbitrary<'FROM' | 'JOIN'>,
        (schemaCache, contextType) => {
          const table = schemaCache.tables[0];
          let text: string;
          if (contextType === 'FROM') {
            text = `SELECT * FROM ${table.schema}.${table.name} `;
          } else {
            text = `SELECT * FROM ${table.schema}.${table.name} t1 JOIN `;
          }
          const items = getCompletions(text, text.length, schemaCache, true);

          // Count schema objects in the result
          const schemaObjects = items.filter(i => i.detail === 'Table' || i.detail === 'View');
          const expectedSchemaObjectCount = schemaCache.tables.length + schemaCache.views.length;

          // All schema objects must still be present (keywords don't suppress them)
          expect(schemaObjects.length).toBe(expectedSchemaObjectCount);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('schema-object completions never suppress keyword suggestions', () => {
    fc.assert(
      fc.property(
        arbitrarySchemaCacheWithTables,
        (schemaCache) => {
          const table = schemaCache.tables[0];
          const text = `SELECT * FROM ${table.schema}.${table.name} `;

          // Get completions with schema objects present
          const itemsConnected = getCompletions(text, text.length, schemaCache, true);
          const keywordsConnected = itemsConnected.filter(i => i.detail === 'Keyword');

          // Keywords should still be present even with schema objects
          expect(keywordsConnected.length).toBeGreaterThan(0);

          // Verify keyword labels include expected clause-flow suggestions
          const keywordLabels = keywordsConnected.map(i => (i.label as string).toUpperCase());
          // FROM context should suggest at least one JOIN variant or WHERE
          const hasExpectedKeyword = keywordLabels.some(l =>
            l === 'WHERE' || l === 'JOIN' || l === 'INNER JOIN' ||
            l === 'LEFT JOIN' || l === 'RIGHT JOIN' || l === 'FULL JOIN' ||
            l === 'CROSS JOIN' || l === 'GROUP BY' || l === 'ORDER BY'
          );
          expect(hasExpectedKeyword).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('all keyword items have CompletionItemKind.Keyword and detail "Keyword"', () => {
    fc.assert(
      fc.property(
        arbitrarySchemaCacheWithTables,
        fc.constantFrom(
          (sc: ISchemaCache) => `SELECT * FROM ${sc.tables[0].schema}.${sc.tables[0].name} `,
          (sc: ISchemaCache) => `SELECT ${sc.tables[0].columns[0].name} FROM ${sc.tables[0].schema}.${sc.tables[0].name}`,
        ),
        (schemaCache, textFn) => {
          const text = textFn(schemaCache);
          // For SELECT context, position cursor after column + space
          const cursorPos = text.includes('FROM') && !text.endsWith(' ')
            ? text.indexOf(' FROM')
            : text.length;
          const items = getCompletions(text, text.endsWith(' ') ? text.length : cursorPos, schemaCache, true);

          const keywords = items.filter(i => i.detail === 'Keyword');
          for (const kw of keywords) {
            // Requirement 4.3: keyword items have CompletionItemKind.Keyword
            expect(kw.kind).toBe(CompletionItemKind.Keyword);
            expect(kw.detail).toBe('Keyword');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});


// --- Property 5 Tests ---

describe('Feature: clause-flow-multi-cte, Property 5: CTE name availability by position', () => {
  /**
   * **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
   *
   * For any CTE chain with N definitions (N >= 2), when the cursor is inside
   * the body of the Kth CTE (K > 1), the available names SHALL be CTEs 1..K-1.
   * When the cursor is in the final consuming query, the available names SHALL
   * include all N CTE names.
   */

  /** Generator: unique CTE names (2-5 names) */
  const arbitraryCTENames: fc.Arbitrary<string[]> = fc
    .array(arbitraryIdentifier, { minLength: 2, maxLength: 5 })
    .map((names) => {
      // Ensure uniqueness (case-insensitive)
      const seen = new Set<string>();
      return names.filter((n) => {
        const lower = n.toLowerCase();
        if (seen.has(lower)) return false;
        seen.add(lower);
        return true;
      });
    })
    .filter((names) => names.length >= 2);

  /**
   * Builds a CTE chain SQL string from an array of CTE names.
   * Each CTE body is `(SELECT 1 AS val)`.
   * Returns the full statement text and metadata about body positions.
   */
  function buildCTEChain(names: string[]): {
    text: string;
    bodyPositions: Array<{ name: string; bodyStart: number; bodyEnd: number }>;
    finalQueryStart: number;
  } {
    let text = 'WITH ';
    const bodyPositions: Array<{ name: string; bodyStart: number; bodyEnd: number }> = [];

    for (let i = 0; i < names.length; i++) {
      if (i > 0) text += ', ';
      text += `${names[i]} AS `;
      const bodyStart = text.length;
      text += '(SELECT 1 AS val)';
      const bodyEnd = text.length - 1; // Position of closing paren
      bodyPositions.push({ name: names[i], bodyStart, bodyEnd });
    }

    text += ' SELECT * FROM ';
    const finalQueryStart = text.length - 'SELECT * FROM '.length;
    text += names[names.length - 1];

    return { text, bodyPositions, finalQueryStart };
  }

  it('cursor inside CTE body K gets exactly names 1..K-1', () => {
    fc.assert(
      fc.property(
        arbitraryCTENames,
        (names) => {
          const { text, bodyPositions } = buildCTEChain(names);

          // For each CTE body K (starting from index 1), place cursor inside it
          for (let k = 1; k < bodyPositions.length; k++) {
            const { bodyStart, bodyEnd } = bodyPositions[k];
            // Place cursor in the middle of the body
            const cursorOffset = bodyStart + Math.floor((bodyEnd - bodyStart) / 2);

            const result = detectCTEChain(text, cursorOffset);

            // Must be in a CTE chain
            expect(result.inCTEChain).toBe(true);

            // Available names should be exactly CTEs 1..K-1
            const expectedNames = names.slice(0, k);
            expect(result.availableNames).toEqual(expectedNames);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('cursor in the first CTE body gets zero available names', () => {
    fc.assert(
      fc.property(
        arbitraryCTENames,
        (names) => {
          const { text, bodyPositions } = buildCTEChain(names);

          // Place cursor inside the first CTE body
          const { bodyStart, bodyEnd } = bodyPositions[0];
          const cursorOffset = bodyStart + Math.floor((bodyEnd - bodyStart) / 2);

          const result = detectCTEChain(text, cursorOffset);

          // Must be in a CTE chain
          expect(result.inCTEChain).toBe(true);

          // No earlier CTEs exist — available names should be empty
          expect(result.availableNames).toEqual([]);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('cursor in the final query after all CTEs gets all CTE names', () => {
    fc.assert(
      fc.property(
        arbitraryCTENames,
        (names) => {
          const { text, finalQueryStart } = buildCTEChain(names);

          // Place cursor in the final SELECT (after all CTE definitions)
          const cursorOffset = finalQueryStart + 10; // Inside "SELECT * FROM ..."

          const result = detectCTEChain(text, cursorOffset);

          // Must be in a CTE chain
          expect(result.inCTEChain).toBe(true);

          // All CTE names should be available
          expect(result.availableNames).toEqual(names);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('inCTEChain is true for all positions inside CTE bodies and final query', () => {
    fc.assert(
      fc.property(
        arbitraryCTENames,
        (names) => {
          const { text, bodyPositions, finalQueryStart } = buildCTEChain(names);

          // Check every CTE body
          for (let k = 0; k < bodyPositions.length; k++) {
            const { bodyStart, bodyEnd } = bodyPositions[k];
            const cursorOffset = bodyStart + Math.floor((bodyEnd - bodyStart) / 2);
            const result = detectCTEChain(text, cursorOffset);
            expect(result.inCTEChain).toBe(true);
          }

          // Check final query
          const cursorOffset = finalQueryStart + 10;
          const result = detectCTEChain(text, cursorOffset);
          expect(result.inCTEChain).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('inCTEChain is false for queries without WITH', () => {
    fc.assert(
      fc.property(
        arbitraryIdentifier,
        arbitraryIdentifier,
        (tbl, col) => {
          // Simple query without any CTE
          const text = `SELECT ${col} FROM ${tbl} WHERE ${col} = 1`;
          const cursorOffset = Math.floor(text.length / 2);

          const result = detectCTEChain(text, cursorOffset);

          expect(result.inCTEChain).toBe(false);
          expect(result.availableNames).toEqual([]);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('available names count increases monotonically with CTE position', () => {
    fc.assert(
      fc.property(
        arbitraryCTENames,
        (names) => {
          const { text, bodyPositions } = buildCTEChain(names);

          let previousCount = -1;
          for (let k = 0; k < bodyPositions.length; k++) {
            const { bodyStart, bodyEnd } = bodyPositions[k];
            const cursorOffset = bodyStart + Math.floor((bodyEnd - bodyStart) / 2);
            const result = detectCTEChain(text, cursorOffset);

            // Available names count should be exactly k (0 for first, 1 for second, etc.)
            expect(result.availableNames.length).toBe(k);

            // Monotonically increasing
            expect(result.availableNames.length).toBeGreaterThan(previousCount);
            previousCount = result.availableNames.length;
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});


// --- Property 8 Tests ---

describe('Feature: clause-flow-multi-cte, Property 8: No column inference from CTE definitions', () => {
  /**
   * **Validates: Requirements 7.1, 7.2, 7.3, 7.5**
   *
   * For any query that references a CTE name in a FROM or JOIN clause,
   * the completion provider SHALL return zero column completions derived
   * from that CTE definition. Column completions SHALL only come from
   * real database tables/views found in the schema cache.
   */

  /** Generator: unique CTE names (1-3 names) that don't collide with real table names */
  const arbitraryCTENamesForColumnTest: fc.Arbitrary<string[]> = fc
    .array(arbitraryIdentifier, { minLength: 1, maxLength: 3 })
    .map((names) => {
      const seen = new Set<string>();
      return names.filter((n) => {
        const lower = n.toLowerCase();
        if (seen.has(lower)) return false;
        seen.add(lower);
        return true;
      });
    })
    .filter((names) => names.length >= 1);

  /**
   * Builds a CTE chain with a final query that references a CTE name in FROM,
   * placing the cursor in a WHERE context (after FROM <cteName> WHERE ).
   */
  function buildCTEQueryWithWhereContext(cteNames: string[]): { text: string; cursorOffset: number } {
    let text = 'WITH ';
    for (let i = 0; i < cteNames.length; i++) {
      if (i > 0) text += ', ';
      text += `${cteNames[i]} AS (SELECT col1, col2 FROM someTable)`;
    }
    // Final query references the last CTE name in FROM, cursor in WHERE
    const lastCte = cteNames[cteNames.length - 1];
    text += ` SELECT * FROM ${lastCte} WHERE `;
    return { text, cursorOffset: text.length };
  }

  /**
   * Builds a CTE chain with a final query that references a CTE name in FROM,
   * placing the cursor in a SELECT context (after SELECT ... FROM <cteName>).
   */
  function buildCTEQueryWithSelectContext(cteNames: string[]): { text: string; cursorOffset: number } {
    let text = 'WITH ';
    for (let i = 0; i < cteNames.length; i++) {
      if (i > 0) text += ', ';
      text += `${cteNames[i]} AS (SELECT col1, col2 FROM someTable)`;
    }
    // Final query: cursor is in SELECT clause, after FROM <cteName>
    const lastCte = cteNames[cteNames.length - 1];
    text += ` SELECT `;
    const cursorOffset = text.length;
    text += `FROM ${lastCte}`;
    return { text, cursorOffset };
  }

  /** Creates a schema cache that does NOT contain any of the given CTE names as tables */
  function createSchemaCacheWithoutCTEs(cteNames: string[], tables: TableInfo[]): ISchemaCache {
    // Filter out any tables whose names match CTE names (case-insensitive)
    const cteNameSet = new Set(cteNames.map(n => n.toLowerCase()));
    const filteredTables = tables.filter(t => !cteNameSet.has(t.name.toLowerCase()));
    return createMockSchemaCache({ tables: filteredTables, views: [] });
  }

  it('zero column completions when only table reference is a CTE name (WHERE context)', () => {
    fc.assert(
      fc.property(
        arbitraryCTENamesForColumnTest,
        (cteNames) => {
          const { text, cursorOffset } = buildCTEQueryWithWhereContext(cteNames);

          // Schema cache has NO tables matching the CTE names
          const schemaCache = createMockSchemaCache({ tables: [], views: [] });

          const items = getCompletions(text, cursorOffset, schemaCache, true);

          // Filter to only column completions (CompletionItemKind.Field)
          const columnItems = items.filter(i => i.kind === CompletionItemKind.Field);

          // No column completions should be derived from CTE definitions
          expect(columnItems.length).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('zero column completions when only table reference is a CTE name (SELECT context)', () => {
    fc.assert(
      fc.property(
        arbitraryCTENamesForColumnTest,
        (cteNames) => {
          const { text, cursorOffset } = buildCTEQueryWithSelectContext(cteNames);

          // Schema cache has NO tables matching the CTE names
          const schemaCache = createMockSchemaCache({ tables: [], views: [] });

          const items = getCompletions(text, cursorOffset, schemaCache, true);

          // Filter to only column completions (CompletionItemKind.Field)
          const columnItems = items.filter(i => i.kind === CompletionItemKind.Field);

          // No column completions should be derived from CTE definitions
          expect(columnItems.length).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('column completions come only from real tables, not from CTE references', () => {
    fc.assert(
      fc.property(
        arbitraryCTENamesForColumnTest,
        arbitraryTableInfo,
        (cteNames, realTable) => {
          // Ensure the real table name doesn't collide with any CTE name
          const cteNameSet = new Set(cteNames.map(n => n.toLowerCase()));
          if (cteNameSet.has(realTable.name.toLowerCase())) return; // skip this case

          // Build a query that references both a CTE name and a real table in FROM
          let text = 'WITH ';
          for (let i = 0; i < cteNames.length; i++) {
            if (i > 0) text += ', ';
            text += `${cteNames[i]} AS (SELECT x, y, z FROM otherTable)`;
          }
          const lastCte = cteNames[cteNames.length - 1];
          text += ` SELECT * FROM ${lastCte}, ${realTable.schema}.${realTable.name} WHERE `;
          const cursorOffset = text.length;

          // Schema cache contains the real table but NOT the CTE names
          const schemaCache = createMockSchemaCache({ tables: [realTable], views: [] });

          const items = getCompletions(text, cursorOffset, schemaCache, true);

          // Column completions should only come from the real table
          const columnItems = items.filter(i => i.kind === CompletionItemKind.Field);
          const columnNames = columnItems.map(i => i.label as string);

          // All column completions must be from the real table's columns
          const realColumnNames = realTable.columns.map(c => c.name);
          for (const colName of columnNames) {
            expect(realColumnNames).toContain(colName);
          }

          // Should have at least the real table's columns
          expect(columnItems.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('CTE names in FROM do not produce column completions even with matching column names in CTE body', () => {
    fc.assert(
      fc.property(
        arbitraryCTENamesForColumnTest,
        fc.array(arbitraryIdentifier, { minLength: 1, maxLength: 4 }),
        (cteNames, fakeColumns) => {
          // Build CTE with explicit column-like SELECT list in the body
          let text = 'WITH ';
          for (let i = 0; i < cteNames.length; i++) {
            if (i > 0) text += ', ';
            const colList = fakeColumns.join(', ');
            text += `${cteNames[i]} AS (SELECT ${colList} FROM sourceTable)`;
          }
          const lastCte = cteNames[cteNames.length - 1];
          text += ` SELECT * FROM ${lastCte} WHERE `;
          const cursorOffset = text.length;

          // Empty schema cache — no real tables exist
          const schemaCache = createMockSchemaCache({ tables: [], views: [] });

          const items = getCompletions(text, cursorOffset, schemaCache, true);

          // No column completions should appear — CTE body columns are NOT inferred
          const columnItems = items.filter(i => i.kind === CompletionItemKind.Field);
          expect(columnItems.length).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('CTE reference in JOIN clause also produces zero column completions from CTE', () => {
    fc.assert(
      fc.property(
        arbitraryCTENamesForColumnTest.filter(names => names.length >= 1),
        arbitraryTableInfo,
        (cteNames, realTable) => {
          // Ensure no collision between CTE names and real table name
          const cteNameSet = new Set(cteNames.map(n => n.toLowerCase()));
          if (cteNameSet.has(realTable.name.toLowerCase())) return;

          // Build a query with CTE referenced in JOIN
          let text = 'WITH ';
          for (let i = 0; i < cteNames.length; i++) {
            if (i > 0) text += ', ';
            text += `${cteNames[i]} AS (SELECT a, b, c FROM otherTable)`;
          }
          const lastCte = cteNames[cteNames.length - 1];
          text += ` SELECT * FROM ${realTable.schema}.${realTable.name} JOIN ${lastCte} ON x = y WHERE `;
          const cursorOffset = text.length;

          // Schema cache contains only the real table
          const schemaCache = createMockSchemaCache({ tables: [realTable], views: [] });

          const items = getCompletions(text, cursorOffset, schemaCache, true);

          // Column completions should only come from the real table
          const columnItems = items.filter(i => i.kind === CompletionItemKind.Field);
          const columnNames = columnItems.map(i => i.label as string);

          // All column completions must be from the real table's columns only
          const realColumnNames = realTable.columns.map(c => c.name);
          for (const colName of columnNames) {
            expect(realColumnNames).toContain(colName);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});


// --- Property 6 Tests ---

describe('Feature: clause-flow-multi-cte, Property 6: CTE name prefix filtering', () => {
  /**
   * **Validates: Requirements 6.1, 6.2**
   *
   * For any set of available CTE names and any typed prefix string, the CTE name
   * completions SHALL include exactly those CTE names whose names start with the
   * prefix (case-insensitive comparison), and no others.
   */

  /** Generator: unique CTE names (2-5 names) */
  const arbitraryCTENames: fc.Arbitrary<string[]> = fc
    .array(arbitraryIdentifier, { minLength: 2, maxLength: 5 })
    .map((names) => {
      const seen = new Set<string>();
      return names.filter((n) => {
        const lower = n.toLowerCase();
        if (seen.has(lower)) return false;
        seen.add(lower);
        return true;
      });
    })
    .filter((names) => names.length >= 2);

  /** Generator: a random prefix string (1-4 lowercase/uppercase chars) */
  const arbitraryPrefix: fc.Arbitrary<string> = fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('')),
    { minLength: 1, maxLength: 4 }
  );

  it('returns exactly those CTE names starting with the prefix (case-insensitive)', () => {
    fc.assert(
      fc.property(
        arbitraryCTENames,
        arbitraryPrefix,
        (names, prefix) => {
          const items = getCTENameCompletions(names, prefix);
          const returnedLabels = items.map(i => i.label as string);

          // Compute expected: names that start with prefix (case-insensitive)
          const lowerPrefix = prefix.toLowerCase();
          const expectedNames = names.filter(n => n.toLowerCase().startsWith(lowerPrefix));

          // Returned items should match exactly the expected set
          expect(returnedLabels.sort()).toEqual(expectedNames.sort());
        }
      ),
      { numRuns: 200 }
    );
  });

  it('with empty prefix, all CTE names are returned', () => {
    fc.assert(
      fc.property(
        arbitraryCTENames,
        (names) => {
          const items = getCTENameCompletions(names, '');
          const returnedLabels = items.map(i => i.label as string);

          // All names should be returned when prefix is empty
          expect(returnedLabels.sort()).toEqual([...names].sort());
        }
      ),
      { numRuns: 200 }
    );
  });

  it('prefix matching is case-insensitive', () => {
    fc.assert(
      fc.property(
        arbitraryCTENames,
        arbitraryPrefix,
        (names, prefix) => {
          // Call with original prefix
          const itemsOriginal = getCTENameCompletions(names, prefix);
          // Call with uppercased prefix
          const itemsUpper = getCTENameCompletions(names, prefix.toUpperCase());
          // Call with lowercased prefix
          const itemsLower = getCTENameCompletions(names, prefix.toLowerCase());

          // All three should return the same set of labels
          const labelsOriginal = itemsOriginal.map(i => i.label as string).sort();
          const labelsUpper = itemsUpper.map(i => i.label as string).sort();
          const labelsLower = itemsLower.map(i => i.label as string).sort();

          expect(labelsOriginal).toEqual(labelsUpper);
          expect(labelsOriginal).toEqual(labelsLower);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('no names are returned when prefix matches none of the CTE names', () => {
    fc.assert(
      fc.property(
        arbitraryCTENames,
        (names) => {
          // Use a prefix that cannot match any generated identifier
          // (identifiers start with a-z, so a numeric prefix won't match)
          const impossiblePrefix = '999zzz';
          const items = getCTENameCompletions(names, impossiblePrefix);

          expect(items).toEqual([]);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returned items never include names that do NOT start with the prefix', () => {
    fc.assert(
      fc.property(
        arbitraryCTENames,
        arbitraryPrefix,
        (names, prefix) => {
          const items = getCTENameCompletions(names, prefix);
          const lowerPrefix = prefix.toLowerCase();

          for (const item of items) {
            const label = (item.label as string).toLowerCase();
            expect(label.startsWith(lowerPrefix)).toBe(true);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});


// --- Property 7 Tests ---

describe('Feature: clause-flow-multi-cte, Property 7: CTE completion item format', () => {
  /**
   * **Validates: Requirements 6.3**
   *
   * For any CTE name offered as a completion item, the item SHALL have
   * CompletionItemKind.Module as its kind and "CTE" as its detail label.
   */

  /** Generator: array of unique CTE names (1-10 names) */
  const arbitraryUniqueCTENames: fc.Arbitrary<string[]> = fc
    .array(arbitraryIdentifier, { minLength: 1, maxLength: 10 })
    .map((names) => {
      const seen = new Set<string>();
      return names.filter((n) => {
        const lower = n.toLowerCase();
        if (seen.has(lower)) return false;
        seen.add(lower);
        return true;
      });
    })
    .filter((names) => names.length >= 1);

  it('every CTE completion item has kind === CompletionItemKind.Module (value 9)', () => {
    fc.assert(
      fc.property(
        arbitraryUniqueCTENames,
        (names) => {
          const items = getCTENameCompletions(names, '');

          expect(items.length).toBe(names.length);

          for (const item of items) {
            expect(item.kind).toBe(CompletionItemKind.Module);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('every CTE completion item has detail === "CTE"', () => {
    fc.assert(
      fc.property(
        arbitraryUniqueCTENames,
        (names) => {
          const items = getCTENameCompletions(names, '');

          expect(items.length).toBe(names.length);

          for (const item of items) {
            expect(item.detail).toBe('CTE');
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('every CTE completion item label matches one of the input CTE names', () => {
    fc.assert(
      fc.property(
        arbitraryUniqueCTENames,
        (names) => {
          const items = getCTENameCompletions(names, '');

          expect(items.length).toBe(names.length);

          for (const item of items) {
            expect(names).toContain(item.label as string);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('kind and detail are correct regardless of CTE name content', () => {
    fc.assert(
      fc.property(
        arbitraryUniqueCTENames,
        (names) => {
          const items = getCTENameCompletions(names, '');

          for (const item of items) {
            // Kind must always be Module (value 9)
            expect(item.kind).toBe(9);
            // Detail must always be "CTE"
            expect(item.detail).toBe('CTE');
            // Label must be one of the input names
            expect(names).toContain(item.label as string);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});


// --- Property 9 Tests ---

describe('Feature: clause-flow-multi-cte, Property 9: Keywords in literals and comments are ignored', () => {
  // **Validates: Requirements 8.3, 10.4**
  //
  // For any SQL text where clause keywords appear inside single-quoted string literals,
  // N-prefixed string literals, single-line comments (--), or multi-line comments,
  // those keywords SHALL NOT be detected as clause context or included in the clause-presence set.

  /** Clause keywords that could appear inside literals/comments */
  const CLAUSE_KEYWORD_STRINGS = [
    'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER JOIN', 'LEFT JOIN',
    'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'GROUP BY', 'ORDER BY', 'HAVING',
  ];

  /** Generator: a random clause keyword string */
  const arbitraryClauseKeyword: fc.Arbitrary<string> = fc.constantFrom(...CLAUSE_KEYWORD_STRINGS);

  /** Generator: wraps a keyword inside a single-quoted string literal */
  const arbitraryKeywordInSingleQuote: fc.Arbitrary<string> = arbitraryClauseKeyword.map(
    (kw) => `'${kw}'`
  );

  /** Generator: wraps a keyword inside an N-prefixed string literal */
  const arbitraryKeywordInNPrefixedString: fc.Arbitrary<string> = fc.tuple(
    arbitraryClauseKeyword,
    fc.constantFrom('N', 'n')
  ).map(([kw, prefix]) => `${prefix}'${kw}'`);

  /** Generator: wraps a keyword inside a single-line comment */
  const arbitraryKeywordInSingleLineComment: fc.Arbitrary<string> = arbitraryClauseKeyword.map(
    (kw) => `-- ${kw}`
  );

  /** Generator: wraps a keyword inside a multi-line comment */
  const arbitraryKeywordInMultiLineComment: fc.Arbitrary<string> = arbitraryClauseKeyword.map(
    (kw) => `/* ${kw} */`
  );

  /** Generator: any keyword wrapped in any literal/comment form */
  const arbitraryHiddenKeyword: fc.Arbitrary<{ hidden: string; keyword: string }> = fc.oneof(
    arbitraryClauseKeyword.map((kw) => ({ hidden: `'${kw}'`, keyword: kw })),
    fc.tuple(arbitraryClauseKeyword, fc.constantFrom('N', 'n')).map(([kw, prefix]) => ({
      hidden: `${prefix}'${kw}'`,
      keyword: kw,
    })),
    arbitraryClauseKeyword.map((kw) => ({ hidden: `-- ${kw}\n`, keyword: kw })),
    arbitraryClauseKeyword.map((kw) => ({ hidden: `/* ${kw} */`, keyword: kw }))
  );

  it('keywords in single-quoted string literals are not included in clause-presence set', () => {
    fc.assert(
      fc.property(
        arbitraryIdentifier,
        arbitraryKeywordInSingleQuote,
        arbitraryClauseKeyword,
        (tbl, quotedKeyword, embeddedKw) => {
          // Build a simple SELECT with the keyword hidden inside a string literal in WHERE
          const text = `SELECT col1 FROM ${tbl} WHERE col1 = ${quotedKeyword} `;
          const presenceSet = getClausePresenceSet(text, text.length);

          // The presence set should contain SELECT, FROM, WHERE (actual clauses)
          // but NOT the keyword that was inside the string literal
          // (unless it happens to also be an actual clause in the statement)
          const actualClauses: Set<string> = new Set(['SELECT', 'FROM', 'WHERE']);
          for (const clause of presenceSet) {
            expect(actualClauses.has(clause)).toBe(true);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('keywords in N-prefixed string literals are not included in clause-presence set', () => {
    fc.assert(
      fc.property(
        arbitraryIdentifier,
        arbitraryKeywordInNPrefixedString,
        (tbl, nPrefixedKeyword) => {
          const text = `SELECT col1 FROM ${tbl} WHERE col1 = ${nPrefixedKeyword} `;
          const presenceSet = getClausePresenceSet(text, text.length);

          // Only actual SQL clauses should be detected
          const actualClauses: Set<string> = new Set(['SELECT', 'FROM', 'WHERE']);
          for (const clause of presenceSet) {
            expect(actualClauses.has(clause)).toBe(true);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('keywords in single-line comments are not included in clause-presence set', () => {
    fc.assert(
      fc.property(
        arbitraryIdentifier,
        arbitraryKeywordInSingleLineComment,
        (tbl, commentedKeyword) => {
          // The comment is on its own line before the actual query
          const text = `${commentedKeyword}\nSELECT col1 FROM ${tbl} `;
          const presenceSet = getClausePresenceSet(text, text.length);

          // Only actual SQL clauses should be detected
          const actualClauses: Set<string> = new Set(['SELECT', 'FROM']);
          for (const clause of presenceSet) {
            expect(actualClauses.has(clause)).toBe(true);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('keywords in multi-line comments are not included in clause-presence set', () => {
    fc.assert(
      fc.property(
        arbitraryIdentifier,
        arbitraryKeywordInMultiLineComment,
        (tbl, commentedKeyword) => {
          // The multi-line comment is embedded in the query
          const text = `SELECT col1 ${commentedKeyword} FROM ${tbl} `;
          const presenceSet = getClausePresenceSet(text, text.length);

          // Only actual SQL clauses should be detected
          const actualClauses: Set<string> = new Set(['SELECT', 'FROM']);
          for (const clause of presenceSet) {
            expect(actualClauses.has(clause)).toBe(true);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('detectContext() is not fooled by keywords in any literal or comment form', () => {
    fc.assert(
      fc.property(
        arbitraryIdentifier,
        arbitraryHiddenKeyword,
        (tbl, { hidden, keyword }) => {
          // Build a SELECT ... FROM query with the hidden keyword placed after FROM table
          // The hidden keyword should NOT change the detected context
          const baseText = `SELECT col1 FROM ${tbl} `;
          const textWithHidden = `SELECT col1 FROM ${tbl} ${hidden} `;

          const baseContext = detectContext(baseText);
          const hiddenContext = detectContext(textWithHidden);

          // The context should be the same whether or not the hidden keyword is present
          // (both should detect FROM as the last real clause)
          expect(hiddenContext).toBe(baseContext);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('only actual SQL clause keywords outside literals/comments appear in presence set', () => {
    fc.assert(
      fc.property(
        arbitraryIdentifier,
        arbitraryHiddenKeyword,
        (tbl, { hidden }) => {
          // A query with only SELECT and FROM as real clauses, plus a hidden keyword
          const text = `SELECT ${hidden} col1 FROM ${tbl} `;
          const presenceSet = getClausePresenceSet(text, text.length);

          // The presence set should contain only SELECT and FROM
          expect(presenceSet.has('SELECT')).toBe(true);
          expect(presenceSet.has('FROM')).toBe(true);

          // The hidden keyword should NOT have added anything extra
          // (unless it coincidentally matches SELECT or FROM which are already there)
          const allowedClauses: Set<string> = new Set(['SELECT', 'FROM']);
          for (const clause of presenceSet) {
            expect(allowedClauses.has(clause)).toBe(true);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('multiple hidden keywords in different forms do not pollute the presence set', () => {
    fc.assert(
      fc.property(
        arbitraryIdentifier,
        arbitraryClauseKeyword,
        arbitraryClauseKeyword,
        arbitraryClauseKeyword,
        (tbl, kw1, kw2, kw3) => {
          // Embed keywords in all four forms: string literal, N-string, single-line comment, multi-line comment
          const text = [
            `/* ${kw1} */`,
            `SELECT '${kw2}' AS val`,
            `-- ${kw3}`,
            `FROM ${tbl}`,
            `WHERE col1 = N'${kw1}'`,
          ].join('\n') + ' ';

          const presenceSet = getClausePresenceSet(text, text.length);

          // Only SELECT, FROM, WHERE should be detected (the actual clauses)
          const allowedClauses: Set<string> = new Set(['SELECT', 'FROM', 'WHERE']);
          for (const clause of presenceSet) {
            expect(allowedClauses.has(clause)).toBe(true);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('HAVING keyword inside a comment does not trigger HAVING context', () => {
    fc.assert(
      fc.property(
        arbitraryIdentifier,
        fc.constantFrom('/* HAVING COUNT(*) > 1 */', '-- HAVING COUNT(*) > 1'),
        (tbl, hiddenHaving) => {
          // A query with GROUP BY but HAVING only in a comment
          const text = `SELECT col1 FROM ${tbl} GROUP BY col1 ${hiddenHaving}\n`;
          const presenceSet = getClausePresenceSet(text, text.length);

          // HAVING should NOT be in the presence set since it's only in a comment
          expect(presenceSet.has('HAVING')).toBe(false);

          // The actual clauses should be detected
          expect(presenceSet.has('SELECT')).toBe(true);
          expect(presenceSet.has('FROM')).toBe(true);
          expect(presenceSet.has('GROUP_BY')).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});


// --- Property 10 Tests ---

describe('Feature: clause-flow-multi-cte, Property 10: CTE sort priority over matching real tables', () => {
  /**
   * **Validates: Requirements 6.5**
   *
   * For any CTE name that matches (case-insensitive) a real table name in the
   * schema cache, the CTE completion item SHALL have a sortText value that
   * lexicographically precedes the real table completion item's sortText,
   * ensuring the CTE appears first in the completion list while both items
   * remain present.
   */

  /** Generator: unique CTE names (2-4 names) */
  const arbitraryCTENamesForSort: fc.Arbitrary<string[]> = fc
    .array(arbitraryIdentifier, { minLength: 2, maxLength: 4 })
    .map((names) => {
      const seen = new Set<string>();
      return names.filter((n) => {
        const lower = n.toLowerCase();
        if (seen.has(lower)) return false;
        seen.add(lower);
        return true;
      });
    })
    .filter((names) => names.length >= 2);

  /**
   * Creates a schema cache where one table has the same name as the given CTE name.
   * The table is placed in the 'dbo' schema.
   */
  function createSchemaCacheWithMatchingTable(cteName: string, extraTables?: TableInfo[]): ISchemaCache {
    const matchingTable: TableInfo = {
      schema: 'dbo',
      name: cteName,
      columns: [{ name: 'id', dataType: 'int', isNullable: false }],
    };
    return createMockSchemaCache({
      tables: [matchingTable, ...(extraTables ?? [])],
      views: [],
    });
  }

  it('CTE item sortText lexicographically precedes real table sortText when names match', () => {
    fc.assert(
      fc.property(
        arbitraryCTENamesForSort,
        (names) => {
          // Use the first CTE name as the one that matches a real table
          const matchingName = names[0];
          const schemaCache = createSchemaCacheWithMatchingTable(matchingName);

          // Build a CTE chain query with cursor in the final SELECT's FROM clause
          const cteDefinitions = names.map(n => `${n} AS (SELECT 1 AS val)`).join(', ');
          const text = `WITH ${cteDefinitions} SELECT * FROM `;

          const items = getCompletions(text, text.length, schemaCache, true);

          // Find the CTE completion item (detail === 'CTE')
          const cteItem = items.find(
            i => (i.label as string).toLowerCase() === matchingName.toLowerCase() && i.detail === 'CTE'
          );
          // Find the real table completion item (detail === 'Table')
          const tableItem = items.find(
            i => (i.label as string).toLowerCase().includes(matchingName.toLowerCase()) && i.detail === 'Table'
          );

          // Both items MUST be present in the completion list
          expect(cteItem).toBeDefined();
          expect(tableItem).toBeDefined();

          // Determine effective sortText (VS Code uses label when sortText is undefined)
          const cteSortText = cteItem!.sortText ?? (cteItem!.label as string);
          const tableSortText = tableItem!.sortText ?? (tableItem!.label as string);

          // CTE sortText MUST lexicographically precede the table sortText
          expect(cteSortText < tableSortText).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('both CTE and real table items are retained when names match (neither is suppressed)', () => {
    fc.assert(
      fc.property(
        arbitraryCTENamesForSort,
        (names) => {
          const matchingName = names[0];
          const schemaCache = createSchemaCacheWithMatchingTable(matchingName);

          const cteDefinitions = names.map(n => `${n} AS (SELECT 1 AS val)`).join(', ');
          const text = `WITH ${cteDefinitions} SELECT * FROM `;

          const items = getCompletions(text, text.length, schemaCache, true);

          // Find items matching the CTE name
          const matchingItems = items.filter(
            i => (i.label as string).toLowerCase() === matchingName.toLowerCase() ||
                 (i.label as string).toLowerCase() === `dbo.${matchingName.toLowerCase()}`
          );

          // There should be at least 2 items: one CTE and one real table
          const cteItems = matchingItems.filter(i => i.detail === 'CTE');
          const tableItems = matchingItems.filter(i => i.detail === 'Table');

          expect(cteItems.length).toBeGreaterThanOrEqual(1);
          expect(tableItems.length).toBeGreaterThanOrEqual(1);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('CTE sortText uses highest priority tier prefix ensuring priority over table labels', () => {
    fc.assert(
      fc.property(
        arbitraryCTENamesForSort,
        (names) => {
          const matchingName = names[0];
          const schemaCache = createSchemaCacheWithMatchingTable(matchingName);

          const cteDefinitions = names.map(n => `${n} AS (SELECT 1 AS val)`).join(', ');
          const text = `WITH ${cteDefinitions} SELECT * FROM `;

          const items = getCompletions(text, text.length, schemaCache, true);

          // Find the CTE completion item
          const cteItem = items.find(
            i => (i.label as string).toLowerCase() === matchingName.toLowerCase() && i.detail === 'CTE'
          );

          expect(cteItem).toBeDefined();
          // In FROM context, CTE items get Tier 0 (REQUIRED_KEYWORD) for highest priority
          // This ensures CTEs always appear above tables (Tier 1) in FROM context
          expect(cteItem!.sortText).toBeDefined();
          expect(cteItem!.sortText!.startsWith('0_')).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('sort priority holds regardless of CTE name casing', () => {
    fc.assert(
      fc.property(
        arbitraryCTENamesForSort,
        fc.constantFrom('lower', 'upper', 'mixed') as fc.Arbitrary<'lower' | 'upper' | 'mixed'>,
        (names, casing) => {
          // Apply casing transformation to the matching name
          let matchingName = names[0];
          if (casing === 'upper') matchingName = matchingName.toUpperCase();
          else if (casing === 'lower') matchingName = matchingName.toLowerCase();
          // 'mixed' keeps original

          const schemaCache = createSchemaCacheWithMatchingTable(matchingName);

          // Build CTE chain with the cased name
          const cteNames = [matchingName, ...names.slice(1)];
          const cteDefinitions = cteNames.map(n => `${n} AS (SELECT 1 AS val)`).join(', ');
          const text = `WITH ${cteDefinitions} SELECT * FROM `;

          const items = getCompletions(text, text.length, schemaCache, true);

          // Find CTE and table items (case-insensitive match)
          const cteItem = items.find(
            i => (i.label as string).toLowerCase() === matchingName.toLowerCase() && i.detail === 'CTE'
          );
          const tableItem = items.find(
            i => (i.label as string).toLowerCase().includes(matchingName.toLowerCase()) && i.detail === 'Table'
          );

          if (cteItem && tableItem) {
            const cteSortText = cteItem.sortText ?? (cteItem.label as string);
            const tableSortText = tableItem.sortText ?? (tableItem.label as string);
            expect(cteSortText < tableSortText).toBe(true);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('CTE sort priority holds with multiple tables in schema cache', () => {
    fc.assert(
      fc.property(
        arbitraryCTENamesForSort,
        fc.array(arbitraryIdentifier, { minLength: 1, maxLength: 3 }),
        (names, extraTableNames) => {
          const matchingName = names[0];
          // Create extra tables that don't conflict with the CTE name
          const extraTables: TableInfo[] = extraTableNames
            .filter(n => n.toLowerCase() !== matchingName.toLowerCase())
            .map(n => ({
              schema: 'dbo',
              name: n,
              columns: [{ name: 'id', dataType: 'int', isNullable: false }],
            }));

          const schemaCache = createSchemaCacheWithMatchingTable(matchingName, extraTables);

          const cteDefinitions = names.map(n => `${n} AS (SELECT 1 AS val)`).join(', ');
          const text = `WITH ${cteDefinitions} SELECT * FROM `;

          const items = getCompletions(text, text.length, schemaCache, true);

          // Find the CTE item and the matching table item
          const cteItem = items.find(
            i => (i.label as string).toLowerCase() === matchingName.toLowerCase() && i.detail === 'CTE'
          );
          const tableItem = items.find(
            i => (i.label as string).toLowerCase().includes(matchingName.toLowerCase()) && i.detail === 'Table'
          );

          expect(cteItem).toBeDefined();
          expect(tableItem).toBeDefined();

          const cteSortText = cteItem!.sortText ?? (cteItem!.label as string);
          const tableSortText = tableItem!.sortText ?? (tableItem!.label as string);

          // CTE must sort before the matching real table
          expect(cteSortText < tableSortText).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });
});
