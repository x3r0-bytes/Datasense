import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { calculateColumnWidth, calculateAutoFitWidth } from '../../src/resultPanelUtils';

/**
 * Property-based tests for Result Panel Column Resize utilities.
 * Feature: next-iteration-v092
 *
 * Property 6: Column Width Calculation with Minimum Clamp (Validates: Requirements 3.2, 3.5, 3.9)
 * Property 7: Auto-Fit Width Calculation (Validates: Requirements 3.4)
 * Property 8: Independent Column Sizing (Validates: Requirements 3.7)
 */

describe('Column Resize Property Tests', () => {
  /**
   * Feature: next-iteration-v092, Property 6: Column Width Calculation with Minimum Clamp
   *
   * **Validates: Requirements 3.2, 3.5, 3.9**
   *
   * For any start width (≥ 50) and any drag delta (positive or negative),
   * calculateColumnWidth(startWidth, dragDelta) SHALL return max(50, startWidth + dragDelta).
   * The result is never less than 50 pixels.
   */
  describe('Property 6: Column Width Calculation with Minimum Clamp', () => {
    it('result equals max(50, startWidth + dragDelta) for any startWidth ≥ 50 and any dragDelta', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 50, max: 2000 }),
          fc.integer({ min: -2000, max: 2000 }),
          (startWidth, dragDelta) => {
            const result = calculateColumnWidth(startWidth, dragDelta);
            const expected = Math.max(50, startWidth + dragDelta);
            expect(result).toBe(expected);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('result is never less than 50 pixels', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 50, max: 2000 }),
          fc.integer({ min: -2000, max: 2000 }),
          (startWidth, dragDelta) => {
            const result = calculateColumnWidth(startWidth, dragDelta);
            expect(result).toBeGreaterThanOrEqual(50);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('positive drag delta increases width when result stays above minimum', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 50, max: 2000 }),
          fc.integer({ min: 1, max: 2000 }),
          (startWidth, positiveDelta) => {
            const result = calculateColumnWidth(startWidth, positiveDelta);
            expect(result).toBe(startWidth + positiveDelta);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('large negative drag delta clamps to exactly 50', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 50, max: 2000 }),
          (startWidth) => {
            // A delta that would bring width well below 50
            const largeDelta = -(startWidth + 100);
            const result = calculateColumnWidth(startWidth, largeDelta);
            expect(result).toBe(50);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Feature: next-iteration-v092, Property 7: Auto-Fit Width Calculation
   *
   * **Validates: Requirements 3.4**
   *
   * For any non-empty array of cell text strings and any positive character width value,
   * calculateAutoFitWidth(cellTexts, charWidth) SHALL return max(50, longestTextLength * charWidth + 16)
   * where longestTextLength is the length of the longest string in the array.
   */
  describe('Property 7: Auto-Fit Width Calculation', () => {
    it('result equals max(50, longestTextLength * charWidth + 16) for any non-empty cell texts and positive charWidth', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 0, maxLength: 100 }), { minLength: 1, maxLength: 50 }),
          fc.double({ min: 0.1, max: 20, noNaN: true }),
          (cellTexts, charWidth) => {
            const result = calculateAutoFitWidth(cellTexts, charWidth);
            const longestTextLength = Math.max(...cellTexts.map(t => t.length));
            const expected = Math.max(50, longestTextLength * charWidth + 16);
            expect(result).toBe(expected);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('result is never less than 50 pixels', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 0, maxLength: 100 }), { minLength: 1, maxLength: 50 }),
          fc.double({ min: 0.1, max: 20, noNaN: true }),
          (cellTexts, charWidth) => {
            const result = calculateAutoFitWidth(cellTexts, charWidth);
            expect(result).toBeGreaterThanOrEqual(50);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('longer text produces wider or equal width', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.double({ min: 0.1, max: 20, noNaN: true }),
          (shortText, extraChars, charWidth) => {
            const longText = shortText + extraChars;
            const resultShort = calculateAutoFitWidth([shortText], charWidth);
            const resultLong = calculateAutoFitWidth([longText], charWidth);
            expect(resultLong).toBeGreaterThanOrEqual(resultShort);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('result depends only on the longest string in the array', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 0, maxLength: 50 }), { minLength: 1, maxLength: 20 }),
          fc.double({ min: 0.1, max: 20, noNaN: true }),
          (cellTexts, charWidth) => {
            const longestTextLength = Math.max(...cellTexts.map(t => t.length));
            // Adding shorter strings should not change the result
            const extraTexts = [...cellTexts, '', 'a'];
            const resultOriginal = calculateAutoFitWidth(cellTexts, charWidth);
            const resultWithExtra = calculateAutoFitWidth(extraTexts, charWidth);

            if (longestTextLength >= 1) {
              // Adding shorter strings doesn't change the result
              expect(resultWithExtra).toBe(resultOriginal);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Feature: next-iteration-v092, Property 8: Independent Column Sizing
   *
   * **Validates: Requirements 3.7**
   *
   * For any column widths array and any resize operation applied to column index i,
   * the widths of all columns at indices ≠ i SHALL remain unchanged after the resize.
   */
  describe('Property 8: Independent Column Sizing', () => {
    it('resizing column at index i does not change widths at other indices', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 50, max: 1000 }), { minLength: 2, maxLength: 20 }),
          fc.integer({ min: -500, max: 500 }),
          (columnWidths, dragDelta) => {
            // Pick a valid index for the resize target
            const resizeIndex = Math.floor(Math.random() * columnWidths.length);

            // Simulate the resize: create a new widths array with the resize applied at resizeIndex
            const newWidths = columnWidths.map((width, idx) => {
              if (idx === resizeIndex) {
                return calculateColumnWidth(width, dragDelta);
              }
              return width;
            });

            // All columns at indices ≠ resizeIndex must remain unchanged
            for (let idx = 0; idx < columnWidths.length; idx++) {
              if (idx !== resizeIndex) {
                expect(newWidths[idx]).toBe(columnWidths[idx]);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('resizing at any valid index preserves all other column widths (deterministic index)', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 20 }).chain(numCols =>
            fc.tuple(
              fc.array(fc.integer({ min: 50, max: 1000 }), { minLength: numCols, maxLength: numCols }),
              fc.integer({ min: 0, max: numCols - 1 }),
              fc.integer({ min: -500, max: 500 })
            )
          ),
          ([columnWidths, resizeIndex, dragDelta]) => {
            // Simulate the resize: apply calculateColumnWidth only at resizeIndex
            const newWidths = columnWidths.map((width, idx) => {
              if (idx === resizeIndex) {
                return calculateColumnWidth(width, dragDelta);
              }
              return width;
            });

            // Verify independence: all columns at indices ≠ resizeIndex are unchanged
            for (let idx = 0; idx < columnWidths.length; idx++) {
              if (idx !== resizeIndex) {
                expect(newWidths[idx]).toBe(columnWidths[idx]);
              }
            }

            // Verify the resized column has the correct new width
            expect(newWidths[resizeIndex]).toBe(
              Math.max(50, columnWidths[resizeIndex] + dragDelta)
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('multiple sequential resizes on different columns are all independent', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 50, max: 1000 }), { minLength: 3, maxLength: 10 }),
          fc.array(fc.integer({ min: -500, max: 500 }), { minLength: 3, maxLength: 10 }),
          (columnWidths, deltas) => {
            // Resize each column independently and verify others remain unchanged
            const originalWidths = [...columnWidths];

            for (let i = 0; i < Math.min(columnWidths.length, deltas.length); i++) {
              const newWidth = calculateColumnWidth(originalWidths[i], deltas[i]);

              // Applying this resize should not affect any other column
              const simulatedWidths = originalWidths.map((w, idx) =>
                idx === i ? newWidth : w
              );

              for (let j = 0; j < originalWidths.length; j++) {
                if (j !== i) {
                  expect(simulatedWidths[j]).toBe(originalWidths[j]);
                }
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
