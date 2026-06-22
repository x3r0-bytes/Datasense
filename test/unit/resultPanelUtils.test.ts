import { describe, it, expect } from 'vitest';
import { sortRows, filterRows, globalFilterRows } from '../../src/resultPanelUtils';

describe('resultPanelUtils', () => {
  describe('sortRows', () => {
    it('sorts numeric values ascending', () => {
      const rows = [[3, 'c'], [1, 'a'], [2, 'b']];
      const result = sortRows(rows, 0, 'asc');
      expect(result).toEqual([[1, 'a'], [2, 'b'], [3, 'c']]);
    });

    it('sorts numeric values descending', () => {
      const rows = [[3, 'c'], [1, 'a'], [2, 'b']];
      const result = sortRows(rows, 0, 'desc');
      expect(result).toEqual([[3, 'c'], [2, 'b'], [1, 'a']]);
    });

    it('sorts string values ascending (case-insensitive)', () => {
      const rows = [['Banana'], ['apple'], ['Cherry']];
      const result = sortRows(rows, 0, 'asc');
      expect(result).toEqual([['apple'], ['Banana'], ['Cherry']]);
    });

    it('sorts string values descending (case-insensitive)', () => {
      const rows = [['Banana'], ['apple'], ['Cherry']];
      const result = sortRows(rows, 0, 'desc');
      expect(result).toEqual([['Cherry'], ['Banana'], ['apple']]);
    });

    it('pushes null values to the end regardless of direction', () => {
      const rows = [[null], [2], [null], [1]];
      const resultAsc = sortRows(rows, 0, 'asc');
      expect(resultAsc).toEqual([[1], [2], [null], [null]]);

      const resultDesc = sortRows(rows, 0, 'desc');
      expect(resultDesc).toEqual([[2], [1], [null], [null]]);
    });

    it('does not mutate the original array', () => {
      const rows = [[3], [1], [2]];
      const original = [...rows];
      sortRows(rows, 0, 'asc');
      expect(rows).toEqual(original);
    });

    it('handles empty rows array', () => {
      const result = sortRows([], 0, 'asc');
      expect(result).toEqual([]);
    });

    it('handles single row', () => {
      const rows = [[42, 'only']];
      const result = sortRows(rows, 0, 'asc');
      expect(result).toEqual([[42, 'only']]);
    });

    it('sorts by a non-first column', () => {
      const rows = [[1, 'z'], [2, 'a'], [3, 'm']];
      const result = sortRows(rows, 1, 'asc');
      expect(result).toEqual([[2, 'a'], [3, 'm'], [1, 'z']]);
    });
  });

  describe('filterRows', () => {
    it('filters rows by case-insensitive substring match', () => {
      const rows = [['Alice', 30], ['Bob', 25], ['Charlie', 35]];
      const result = filterRows(rows, 0, 'ali');
      expect(result).toEqual([['Alice', 30]]);
    });

    it('returns all rows when filter text is empty', () => {
      const rows = [['Alice'], ['Bob']];
      const result = filterRows(rows, 0, '');
      expect(result).toEqual([['Alice'], ['Bob']]);
    });

    it('matches null cells against the string "null"', () => {
      const rows = [[null], ['hello'], [null]];
      const result = filterRows(rows, 0, 'null');
      expect(result).toEqual([[null], [null]]);
    });

    it('filters numeric values by their string representation', () => {
      const rows = [[100], [200], [1001]];
      const result = filterRows(rows, 0, '100');
      expect(result).toEqual([[100], [1001]]);
    });

    it('returns empty array when no rows match', () => {
      const rows = [['Alice'], ['Bob']];
      const result = filterRows(rows, 0, 'xyz');
      expect(result).toEqual([]);
    });

    it('handles empty rows array', () => {
      const result = filterRows([], 0, 'test');
      expect(result).toEqual([]);
    });

    it('is case-insensitive', () => {
      const rows = [['HELLO'], ['hello'], ['Hello']];
      const result = filterRows(rows, 0, 'HELLO');
      expect(result).toEqual([['HELLO'], ['hello'], ['Hello']]);
    });

    it('filters by a specific column index', () => {
      const rows = [['Alice', 'NY'], ['Bob', 'LA'], ['Charlie', 'NY']];
      const result = filterRows(rows, 1, 'ny');
      expect(result).toEqual([['Alice', 'NY'], ['Charlie', 'NY']]);
    });
  });

  describe('globalFilterRows', () => {
    it('returns all rows when filter text is empty', () => {
      const rows = [['Alice', 30], ['Bob', 25], ['Charlie', 35]];
      const result = globalFilterRows(rows, '');
      expect(result).toEqual([['Alice', 30], ['Bob', 25], ['Charlie', 35]]);
    });

    it('filters rows case-insensitively across all columns', () => {
      const rows = [['Alice', 'NY'], ['Bob', 'LA'], ['Charlie', 'NY']];
      // Match in first column
      const result1 = globalFilterRows(rows, 'ali');
      expect(result1).toEqual([['Alice', 'NY']]);
      // Match in second column
      const result2 = globalFilterRows(rows, 'ny');
      expect(result2).toEqual([['Alice', 'NY'], ['Charlie', 'NY']]);
    });

    it('matches null cells against the string "null"', () => {
      const rows = [[null, 'hello'], ['world', null], ['foo', 'bar']];
      const result = globalFilterRows(rows, 'null');
      expect(result).toEqual([[null, 'hello'], ['world', null]]);
    });

    it('returns empty array when no rows match', () => {
      const rows = [['Alice', 'NY'], ['Bob', 'LA']];
      const result = globalFilterRows(rows, 'xyz');
      expect(result).toEqual([]);
    });

    it('matches substring across any column in a row', () => {
      const rows = [[1, 'apple', 'red'], [2, 'banana', 'yellow'], [3, 'grape', 'purple']];
      const result = globalFilterRows(rows, 'ple');
      expect(result).toEqual([[1, 'apple', 'red'], [3, 'grape', 'purple']]);
    });

    it('is case-insensitive regardless of input case', () => {
      const rows = [['HELLO', 'world'], ['foo', 'BAR']];
      const result = globalFilterRows(rows, 'HELLO');
      expect(result).toEqual([['HELLO', 'world']]);
    });

    it('matches numeric values by their string representation', () => {
      const rows = [[100, 'a'], [200, 'b'], [1001, 'c']];
      const result = globalFilterRows(rows, '100');
      expect(result).toEqual([[100, 'a'], [1001, 'c']]);
    });

    it('handles empty rows array', () => {
      const result = globalFilterRows([], 'test');
      expect(result).toEqual([]);
    });
  });
});
