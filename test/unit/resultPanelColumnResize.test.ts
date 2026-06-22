import { describe, it, expect } from 'vitest';
import { calculateColumnWidth, calculateAutoFitWidth } from '../../src/resultPanelUtils';

describe('resultPanelColumnResize', () => {
  describe('calculateColumnWidth', () => {
    it('increases width when drag delta is positive', () => {
      const result = calculateColumnWidth(100, 50);
      expect(result).toBe(150);
    });

    it('decreases width when drag delta is negative (clamped at 50)', () => {
      const result = calculateColumnWidth(200, -100);
      expect(result).toBe(100);
    });

    it('clamps to 50px when drag would produce less than 50px', () => {
      const result = calculateColumnWidth(80, -60);
      expect(result).toBe(50);
    });

    it('clamps to 50px when drag delta is extremely negative', () => {
      const result = calculateColumnWidth(100, -500);
      expect(result).toBe(50);
    });

    it('returns exact 50px when result equals minimum', () => {
      const result = calculateColumnWidth(100, -50);
      expect(result).toBe(50);
    });

    it('handles zero drag delta (no change)', () => {
      const result = calculateColumnWidth(120, 0);
      expect(result).toBe(120);
    });
  });

  describe('calculateAutoFitWidth', () => {
    it('uses the single cell length when only one cell exists', () => {
      // "Hello" = 5 chars, charWidth = 8 → 5 * 8 + 16 = 56
      const result = calculateAutoFitWidth(['Hello'], 8);
      expect(result).toBe(56);
    });

    it('returns 50 (minimum) when given an empty array', () => {
      const result = calculateAutoFitWidth([], 8);
      expect(result).toBe(50);
    });

    it('uses header text length when header is longer than data', () => {
      // Header "CustomerName" = 12 chars, data cells are shorter
      // 12 * 8 + 16 = 112
      const result = calculateAutoFitWidth(['CustomerName', 'Alice', 'Bob'], 8);
      expect(result).toBe(112);
    });

    it('uses longest data cell when data is longer than header', () => {
      // Header "ID" = 2 chars, data "12345" = 5 chars
      // 5 * 8 + 16 = 56
      const result = calculateAutoFitWidth(['ID', '12345', '99'], 8);
      expect(result).toBe(56);
    });

    it('clamps to 50px when calculated width would be less than minimum', () => {
      // Single char "A" = 1 char, charWidth = 5 → 1 * 5 + 16 = 21 → clamped to 50
      const result = calculateAutoFitWidth(['A'], 5);
      expect(result).toBe(50);
    });

    it('adds 16px padding to the widest cell content', () => {
      // "Test" = 4 chars, charWidth = 10 → 4 * 10 + 16 = 56
      const result = calculateAutoFitWidth(['Test'], 10);
      expect(result).toBe(56);
    });
  });
});
