// Feature: ui-iteration-v05, Property 6: Result set labeling
// Feature: ui-iteration-v05, Property 7: Tab index preservation on new results
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { generateResultLabels, ResultSetWithBatch, resolveActiveTab } from '../../src/displayModeController';
import { BatchResultLabel } from '../../src/types';

// --- Generators for Property 6 ---

/**
 * Generator: single batch structure.
 * All items have batchIndex = 1, with 1 to 20 result sets.
 */
const arbitrarySingleBatch: fc.Arbitrary<{ resultSets: ResultSetWithBatch[]; batchCount: number }> =
  fc.integer({ min: 1, max: 20 }).map((count) => ({
    resultSets: Array.from({ length: count }, () => ({ batchIndex: 1 })),
    batchCount: 1,
  }));

/**
 * Generator: multiple batch structure.
 * Generates 2 to 10 batches, each with 1 to 10 result sets.
 * Items have varying batchIndex values (1-based).
 */
const arbitraryMultipleBatches: fc.Arbitrary<{ resultSets: ResultSetWithBatch[]; batchCount: number }> =
  fc.array(fc.integer({ min: 1, max: 10 }), { minLength: 2, maxLength: 10 }).map((countsPerBatch) => {
    const resultSets: ResultSetWithBatch[] = [];
    for (let batchIdx = 0; batchIdx < countsPerBatch.length; batchIdx++) {
      for (let r = 0; r < countsPerBatch[batchIdx]; r++) {
        resultSets.push({ batchIndex: batchIdx + 1 });
      }
    }
    return {
      resultSets,
      batchCount: countsPerBatch.length,
    };
  });

/**
 * Generator: any batch structure (single or multiple).
 */
const arbitraryBatchStructure: fc.Arbitrary<{ resultSets: ResultSetWithBatch[]; batchCount: number }> =
  fc.oneof(arbitrarySingleBatch, arbitraryMultipleBatches);

// --- Property 6 Tests ---

/**
 * **Validates: Requirements 5.1, 5.2, 5.3**
 *
 * For any batch execution producing N batches with varying result set counts per batch,
 * generateResultLabels SHALL produce labels where:
 * - If there is exactly 1 batch, labels are "Result 1", "Result 2", etc.
 * - If there are multiple batches, labels are "Batch N - Result M" with 1-based indices
 * - The total label count equals the total number of result sets across all batches
 */
describe('Property 6: Result set labeling', () => {
  it('single batch labels are "Result 1", "Result 2", etc.', () => {
    fc.assert(
      fc.property(arbitrarySingleBatch, ({ resultSets, batchCount }) => {
        const labels = generateResultLabels(resultSets, batchCount);

        for (let i = 0; i < labels.length; i++) {
          expect(labels[i].label).toBe(`Result ${i + 1}`);
          expect(labels[i].batchIndex).toBe(1);
          expect(labels[i].resultIndex).toBe(i + 1);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('multiple batches labels are "Batch N - Result M" with 1-based indices', () => {
    fc.assert(
      fc.property(arbitraryMultipleBatches, ({ resultSets, batchCount }) => {
        const labels = generateResultLabels(resultSets, batchCount);

        // Track per-batch result counter to verify M values
        const batchResultCounters = new Map<number, number>();

        for (let i = 0; i < labels.length; i++) {
          const batchIdx = resultSets[i].batchIndex;
          const currentCount = (batchResultCounters.get(batchIdx) ?? 0) + 1;
          batchResultCounters.set(batchIdx, currentCount);

          expect(labels[i].label).toBe(`Batch ${batchIdx} - Result ${currentCount}`);
          expect(labels[i].batchIndex).toBe(batchIdx);
          expect(labels[i].resultIndex).toBe(currentCount);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('total label count equals total number of result sets across all batches', () => {
    fc.assert(
      fc.property(arbitraryBatchStructure, ({ resultSets, batchCount }) => {
        const labels = generateResultLabels(resultSets, batchCount);

        expect(labels.length).toBe(resultSets.length);
      }),
      { numRuns: 100 }
    );
  });
});

/**
 * **Validates: Requirements 5.6**
 *
 * For any previous active tab index and new result count, resolveActiveTab SHALL return:
 * - The previous tab index if it is less than the new result count (preserved)
 * - 0 (first tab) if the previous tab index is >= the new result count (falls back)
 */
describe('Property 7: Tab index preservation on new results', () => {
  it('preserves tab index when previousTabIndex < newTabCount', () => {
    fc.assert(
      fc.property(
        fc.nat(999),  // previousTabIndex: 0..999
        fc.integer({ min: 1, max: 1000 }),  // newTabCount: 1..1000
        (previousTabIndex, newTabCount) => {
          // Only test cases where previousTabIndex < newTabCount
          fc.pre(previousTabIndex < newTabCount);

          const result = resolveActiveTab(previousTabIndex, newTabCount);
          expect(result).toBe(previousTabIndex);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('falls back to first tab (0) when previousTabIndex >= newTabCount', () => {
    fc.assert(
      fc.property(
        fc.nat(999),  // previousTabIndex: 0..999
        fc.integer({ min: 1, max: 1000 }),  // newTabCount: 1..1000
        (previousTabIndex, newTabCount) => {
          // Only test cases where previousTabIndex >= newTabCount
          fc.pre(previousTabIndex >= newTabCount);

          const result = resolveActiveTab(previousTabIndex, newTabCount);
          expect(result).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('resolveActiveTab always returns a valid index (0 <= result < newTabCount)', () => {
    fc.assert(
      fc.property(
        fc.nat(999),  // previousTabIndex: 0..999
        fc.integer({ min: 1, max: 1000 }),  // newTabCount: 1..1000
        (previousTabIndex, newTabCount) => {
          const result = resolveActiveTab(previousTabIndex, newTabCount);
          expect(result).toBeGreaterThanOrEqual(0);
          expect(result).toBeLessThan(newTabCount);
        }
      ),
      { numRuns: 100 }
    );
  });
});
