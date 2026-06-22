import { BatchResultLabel, ResultSet } from './types';

/**
 * Input item for label generation. Each item represents a result set
 * with its batch assignment.
 */
export interface ResultSetWithBatch {
  batchIndex: number; // 1-based batch number
}

/**
 * Generates display labels for result sets based on batch structure.
 *
 * - Single batch (batchCount === 1): labels are "Result 1", "Result 2", etc.
 * - Multiple batches (batchCount > 1): labels are "Batch N - Result M" with 1-based indices.
 *
 * @param resultSets - Array of items with batchIndex indicating which batch each result set belongs to
 * @param batchCount - Total number of batches in the execution
 * @returns Array of BatchResultLabel objects with display labels
 */
export function generateResultLabels(
  resultSets: ResultSetWithBatch[],
  batchCount: number
): BatchResultLabel[] {
  if (batchCount === 1) {
    // Single batch: labels are "Result 1", "Result 2", etc.
    return resultSets.map((_, index) => ({
      batchIndex: 1,
      resultIndex: index + 1,
      label: `Result ${index + 1}`,
    }));
  }

  // Multiple batches: track per-batch result index
  const batchResultCounters = new Map<number, number>();

  return resultSets.map((rs) => {
    const currentCount = (batchResultCounters.get(rs.batchIndex) ?? 0) + 1;
    batchResultCounters.set(rs.batchIndex, currentCount);

    return {
      batchIndex: rs.batchIndex,
      resultIndex: currentCount,
      label: `Batch ${rs.batchIndex} - Result ${currentCount}`,
    };
  });
}

/**
 * Resolves which tab should be active after new results arrive.
 *
 * Preserves the previous tab index if it's still valid (within bounds),
 * otherwise falls back to the first tab (index 0).
 *
 * @param previousTabIndex - The previously active tab index (0-based)
 * @param newTabCount - The number of tabs in the new result set
 * @returns The tab index to activate (0-based)
 */
export function resolveActiveTab(previousTabIndex: number, newTabCount: number): number {
  if (previousTabIndex < newTabCount) {
    return previousTabIndex;
  }
  return 0;
}
