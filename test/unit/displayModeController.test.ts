import { describe, it, expect } from 'vitest';
import { generateResultLabels, resolveActiveTab } from '../../src/displayModeController';

describe('displayModeController', () => {
  describe('generateResultLabels', () => {
    it('single batch: labels are "Result 1", "Result 2", etc.', () => {
      const resultSets = [
        { batchIndex: 1 },
        { batchIndex: 1 },
        { batchIndex: 1 },
      ];

      const labels = generateResultLabels(resultSets, 1);

      expect(labels).toEqual([
        { batchIndex: 1, resultIndex: 1, label: 'Result 1' },
        { batchIndex: 1, resultIndex: 2, label: 'Result 2' },
        { batchIndex: 1, resultIndex: 3, label: 'Result 3' },
      ]);
    });

    it('multiple batches: labels are "Batch N - Result M"', () => {
      const resultSets = [
        { batchIndex: 1 },
        { batchIndex: 1 },
        { batchIndex: 2 },
        { batchIndex: 3 },
        { batchIndex: 3 },
      ];

      const labels = generateResultLabels(resultSets, 3);

      expect(labels).toEqual([
        { batchIndex: 1, resultIndex: 1, label: 'Batch 1 - Result 1' },
        { batchIndex: 1, resultIndex: 2, label: 'Batch 1 - Result 2' },
        { batchIndex: 2, resultIndex: 1, label: 'Batch 2 - Result 1' },
        { batchIndex: 3, resultIndex: 1, label: 'Batch 3 - Result 1' },
        { batchIndex: 3, resultIndex: 2, label: 'Batch 3 - Result 2' },
      ]);
    });

    it('empty result sets returns empty array', () => {
      const labels = generateResultLabels([], 1);
      expect(labels).toEqual([]);
    });

    it('single result set in single batch', () => {
      const labels = generateResultLabels([{ batchIndex: 1 }], 1);
      expect(labels).toEqual([
        { batchIndex: 1, resultIndex: 1, label: 'Result 1' },
      ]);
    });

    it('zero result sets with multiple batches returns empty array', () => {
      const labels = generateResultLabels([], 3);
      expect(labels).toEqual([]);
    });
  });

  describe('resolveActiveTab', () => {
    it('preserves previous tab index when within bounds', () => {
      expect(resolveActiveTab(2, 5)).toBe(2);
    });

    it('falls back to 0 when previous index equals new count', () => {
      expect(resolveActiveTab(3, 3)).toBe(0);
    });

    it('falls back to 0 when previous index exceeds new count', () => {
      expect(resolveActiveTab(5, 3)).toBe(0);
    });

    it('preserves index 0 when there is at least one tab', () => {
      expect(resolveActiveTab(0, 1)).toBe(0);
    });

    it('falls back to 0 when new count is 0', () => {
      expect(resolveActiveTab(0, 0)).toBe(0);
    });
  });
});
