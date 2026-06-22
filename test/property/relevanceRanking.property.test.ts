import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  applyTieredRanking,
  RANK_TIERS,
  AGGREGATE_FUNCTIONS,
  WINDOW_FUNCTIONS,
} from '../../server/src/completionProvider';
import { CompletionItem, CompletionItemKind } from 'vscode-languageserver/node';

/**
 * Property-based tests for tiered ranking system
 * Feature: intellisense-clause-engine
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.6
 */

// --- Helpers ---

/** Creates a CompletionItem with the given label and kind */
function makeItem(label: string, kind: CompletionItemKind, detail?: string): CompletionItem {
  return { label, kind, detail };
}

/** Extracts the tier prefix from a sortText value (the character before the underscore) */
function getTier(sortText: string | undefined): string {
  if (!sortText) return '';
  return sortText.split('_')[0];
}

// --- Generators ---

/** Generator: random valid SQL identifier */
const arbitraryIdentifier: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')),
      { minLength: 1, maxLength: 10 }
    )
  )
  .map(([first, rest]) => first + rest)
  .filter((id) => !AGGREGATE_FUNCTIONS.has(id.toUpperCase()) && !WINDOW_FUNCTIONS.has(id.toUpperCase()));

/** Generator: random keyword */
const arbitraryKeyword: fc.Arbitrary<string> = fc.constantFrom(
  'WHERE', 'FROM', 'SELECT', 'ORDER BY', 'GROUP BY', 'HAVING', 'JOIN', 'INNER JOIN'
);

/** Generator: a mixed list of CompletionItems for tiered ranking testing */
const arbitraryMixedCompletionItems: fc.Arbitrary<CompletionItem[]> = fc.tuple(
  fc.array(arbitraryIdentifier, { minLength: 1, maxLength: 5 }),
  fc.array(arbitraryIdentifier, { minLength: 0, maxLength: 3 }),
  fc.array(arbitraryIdentifier, { minLength: 0, maxLength: 2 }),
  fc.array(arbitraryKeyword, { minLength: 0, maxLength: 3 }),
).map(([columns, functions, cteNames, keywords]) => {
  const items: CompletionItem[] = [];
  for (const col of columns) items.push(makeItem(col, CompletionItemKind.Field));
  for (const fn of functions) items.push(makeItem(fn, CompletionItemKind.Function));
  for (const cte of cteNames) items.push(makeItem(cte, CompletionItemKind.Module, 'CTE'));
  for (const kw of keywords) items.push(makeItem(kw, CompletionItemKind.Keyword));
  return items;
});

/** Generator: random non-empty prefix string for filtering */
const arbitraryPrefix: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
  { minLength: 1, maxLength: 4 }
);

/** Generator: random subset of keywords to use as required keywords */
const arbitraryRequiredKeywords: fc.Arbitrary<string[]> = fc.subarray(
  ['FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'JOIN', 'INNER JOIN'],
  { minLength: 0, maxLength: 3 }
);

// --- Tests ---

describe('Tiered Ranking Property Tests', () => {
  describe('Property: Required keywords (tier 0) rank above schema objects (tier 3)', () => {
    /**
     * **Validates: Requirements 5.1, 5.2**
     *
     * For any completion list containing both required keywords and schema objects,
     * every required keyword's sortText SHALL have a lexicographically smaller value
     * than every schema object's sortText.
     */

    it('tier 0 items always sort before tier 3 items', () => {
      fc.assert(
        fc.property(arbitraryMixedCompletionItems, arbitraryRequiredKeywords, (items, requiredKeywords) => {
          if (requiredKeywords.length === 0) return; // Skip when no required keywords

          const ranked = applyTieredRanking([...items], requiredKeywords);

          const tier0Items = ranked.filter(i => getTier(i.sortText) === RANK_TIERS.REQUIRED_KEYWORD);
          const tier3Items = ranked.filter(i => getTier(i.sortText) === RANK_TIERS.SCHEMA_OBJECTS);

          // Every tier 0 item should sort before every tier 3 item
          for (const t0 of tier0Items) {
            for (const t3 of tier3Items) {
              expect(t0.sortText! < t3.sortText!).toBe(true);
            }
          }
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Property: Columns/aliases (tier 1) rank between tier 0 and tier 3', () => {
    /**
     * **Validates: Requirements 5.1, 5.2**
     *
     * Column items (tier 1) SHALL have sortText values between tier 0 and tier 3.
     */

    it('tier 1 items sort after tier 0 and before tier 3', () => {
      fc.assert(
        fc.property(arbitraryMixedCompletionItems, arbitraryRequiredKeywords, (items, requiredKeywords) => {
          if (requiredKeywords.length === 0) return;

          const ranked = applyTieredRanking([...items], requiredKeywords);

          const tier0Items = ranked.filter(i => getTier(i.sortText) === RANK_TIERS.REQUIRED_KEYWORD);
          const tier1Items = ranked.filter(i => getTier(i.sortText) === RANK_TIERS.COLUMNS_AND_ALIASES);
          const tier3Items = ranked.filter(i => getTier(i.sortText) === RANK_TIERS.SCHEMA_OBJECTS);

          // Tier 0 < Tier 1
          for (const t0 of tier0Items) {
            for (const t1 of tier1Items) {
              expect(t0.sortText! < t1.sortText!).toBe(true);
            }
          }

          // Tier 1 < Tier 3
          for (const t1 of tier1Items) {
            for (const t3 of tier3Items) {
              expect(t1.sortText! < t3.sortText!).toBe(true);
            }
          }
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Property: Prefix filtering preserves tier ordering', () => {
    /**
     * **Validates: Requirements 5.1**
     *
     * For any non-empty prefix string, the filtered completion list SHALL maintain
     * the same relative tier ordering among the remaining items.
     */

    it('filtered items maintain tier ordering after prefix filtering', () => {
      fc.assert(
        fc.property(
          arbitraryMixedCompletionItems,
          arbitraryRequiredKeywords,
          arbitraryPrefix,
          (items, requiredKeywords, prefix) => {
            // Apply ranking first
            const ranked = applyTieredRanking([...items], requiredKeywords);

            // Simulate prefix filtering (case-insensitive startsWith)
            const lowerPrefix = prefix.toLowerCase();
            const filtered = ranked.filter(item => {
              const label = typeof item.label === 'string' ? item.label : '';
              return label.toLowerCase().startsWith(lowerPrefix);
            });

            // If fewer than 2 items remain, ordering is trivially maintained
            if (filtered.length < 2) return;

            // Group filtered items by tier
            const tiers = new Map<string, CompletionItem[]>();
            for (const item of filtered) {
              const tier = getTier(item.sortText);
              if (!tiers.has(tier)) tiers.set(tier, []);
              tiers.get(tier)!.push(item);
            }

            // Get sorted tier keys that are present
            const presentTiers = Array.from(tiers.keys()).sort();

            // For each pair of present tiers, all items in the lower tier
            // should have sortText less than all items in the higher tier
            for (let i = 0; i < presentTiers.length; i++) {
              for (let j = i + 1; j < presentTiers.length; j++) {
                const lowerTierItems = tiers.get(presentTiers[i])!;
                const higherTierItems = tiers.get(presentTiers[j])!;

                for (const low of lowerTierItems) {
                  for (const high of higherTierItems) {
                    expect(low.sortText! < high.sortText!).toBe(true);
                  }
                }
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property: CTE names get tier 2 (LOCAL_REFERENCES)', () => {
    /**
     * **Validates: Requirements 5.1**
     *
     * CTE name completions (detail="CTE") SHALL be assigned tier 2,
     * which sorts between columns (tier 1) and schema objects (tier 3).
     */

    it('CTE items sort between columns and schema objects', () => {
      fc.assert(
        fc.property(arbitraryMixedCompletionItems, arbitraryRequiredKeywords, (items, requiredKeywords) => {
          const ranked = applyTieredRanking([...items], requiredKeywords);

          const tier1Items = ranked.filter(i => getTier(i.sortText) === RANK_TIERS.COLUMNS_AND_ALIASES);
          const tier2Items = ranked.filter(i => getTier(i.sortText) === RANK_TIERS.LOCAL_REFERENCES);
          const tier3Items = ranked.filter(i => getTier(i.sortText) === RANK_TIERS.SCHEMA_OBJECTS);

          // Tier 1 < Tier 2
          for (const t1 of tier1Items) {
            for (const t2 of tier2Items) {
              expect(t1.sortText! < t2.sortText!).toBe(true);
            }
          }

          // Tier 2 < Tier 3
          for (const t2 of tier2Items) {
            for (const t3 of tier3Items) {
              expect(t2.sortText! < t3.sortText!).toBe(true);
            }
          }
        }),
        { numRuns: 100 }
      );
    });
  });
});
