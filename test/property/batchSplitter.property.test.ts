import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { splitBatches } from '../../src/batchSplitter';

/**
 * Property-based tests for batch splitter (Property 11)
 * Feature: sql-server-extension, Property 11: Batch splitting on GO separators
 *
 * Validates: Requirements 3.4
 */

// --- Generators ---

/** Generator: random SQL-like content that does NOT contain standalone GO lines */
const arbitrarySqlContent: fc.Arbitrary<string> = fc.oneof(
  // Simple SELECT statements
  fc.tuple(
    fc.constantFrom('SELECT', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE', 'DECLARE'),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_ ,.*=@'.split('')),
      { minLength: 1, maxLength: 40 }
    )
  ).map(([keyword, rest]) => `${keyword} ${rest.trim() || 'x'}`),
  // Identifiers and assignments
  fc.tuple(
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz_'.split('')),
      { minLength: 1, maxLength: 15 }
    ),
    fc.constantFrom(' = 1', ' INT', ' VARCHAR(50)', ' NOT NULL')
  ).map(([id, suffix]) => `@${id}${suffix}`)
);

/** Generator: a single SQL line that won't be confused with a GO separator */
const arbitrarySqlLine: fc.Arbitrary<string> = arbitrarySqlContent.filter(
  (line) => !/^\s*GO\s*$/i.test(line)
);

/**
 * Generator: a SQL batch (one or more lines of SQL content).
 * Ensures no line within the batch matches the GO separator pattern.
 */
const arbitrarySqlBatch: fc.Arbitrary<string> = fc
  .array(arbitrarySqlLine, { minLength: 1, maxLength: 4 })
  .map((lines) => lines.join('\n'));

/**
 * Generator: arbitrary SQL fragment with N GO separators.
 * Produces SQL text with known number of GO separators on standalone lines,
 * where GO is NOT inside string literals or comments.
 */
const arbitrarySqlFragment: fc.Arbitrary<{ sql: string; goCount: number }> = fc
  .array(arbitrarySqlBatch, { minLength: 1, maxLength: 6 })
  .chain((batches) => {
    // Generate GO variants for separators between batches
    return fc
      .array(
        fc.tuple(
          fc.constantFrom('GO', 'go', 'Go', 'gO'),
          fc.stringOf(fc.constantFrom(' ', '\t'), { minLength: 0, maxLength: 3 }),
          fc.stringOf(fc.constantFrom(' ', '\t'), { minLength: 0, maxLength: 3 })
        ),
        { minLength: batches.length - 1, maxLength: batches.length - 1 }
      )
      .map((goSeparators) => {
        const parts: string[] = [];
        for (let i = 0; i < batches.length; i++) {
          parts.push(batches[i]);
          if (i < goSeparators.length) {
            const [goVariant, leadingWs, trailingWs] = goSeparators[i];
            parts.push(`${leadingWs}${goVariant}${trailingWs}`);
          }
        }
        return {
          sql: parts.join('\n'),
          goCount: batches.length - 1,
        };
      });
  });

/**
 * Generator: SQL text with GO inside a single-quoted string literal.
 * The GO should NOT cause splitting.
 */
const arbitrarySqlWithGoInString: fc.Arbitrary<string> = fc
  .tuple(
    arbitrarySqlLine,
    fc.constantFrom('GO', 'go', 'Go'),
    arbitrarySqlLine
  )
  .map(([before, goVariant, after]) => {
    return `SELECT '${goVariant}' AS val\n${after}`;
  });

/**
 * Generator: SQL text with GO inside a block comment.
 * The GO should NOT cause splitting.
 */
const arbitrarySqlWithGoInBlockComment: fc.Arbitrary<string> = fc
  .tuple(
    arbitrarySqlLine,
    fc.constantFrom('GO', 'go', 'Go')
  )
  .map(([sqlLine, goVariant]) => {
    return `${sqlLine}\n/* comment\n${goVariant}\nend comment */\nSELECT 1`;
  });

/**
 * Generator: SQL text with GO inside a single-line comment.
 * The GO should NOT cause splitting.
 */
const arbitrarySqlWithGoInLineComment: fc.Arbitrary<string> = fc
  .tuple(
    arbitrarySqlLine,
    fc.constantFrom('GO', 'go', 'Go')
  )
  .map(([sqlLine, goVariant]) => {
    return `${sqlLine} -- ${goVariant}\nSELECT 1`;
  });

// --- Tests ---

describe('Batch Splitter Property Tests', () => {
  describe('Property 11: Batch splitting on GO separators', () => {
    /**
     * Validates: Requirements 3.4
     *
     * For any SQL text containing N occurrences of GO on standalone lines
     * (not within string literals or comments), the batch splitter SHALL produce
     * exactly N+1 batches, and concatenating all batches with GO separators
     * SHALL reproduce the original semantic content.
     */

    it('for N standalone GO separators, the splitter produces N+1 non-empty batches', () => {
      fc.assert(
        fc.property(arbitrarySqlFragment, ({ sql, goCount }) => {
          const batches = splitBatches(sql);
          // With N GO separators between non-empty batches, we expect N+1 batches
          // (all batches in our generator are non-empty)
          expect(batches.length).toBe(goCount + 1);
        }),
        { numRuns: 100 }
      );
    });

    it('the content of each batch is preserved correctly (no data loss)', () => {
      fc.assert(
        fc.property(arbitrarySqlFragment, ({ sql, goCount }) => {
          const batches = splitBatches(sql);

          // Reconstruct: joining batches with GO should reproduce the semantic content
          // The original SQL minus the GO separator lines should equal the batches joined
          const originalLines = sql.split('\n');
          const contentLines = originalLines.filter(
            (line) => !/^\s*GO\s*$/i.test(line)
          );
          const expectedContent = contentLines.join('\n');

          const actualContent = batches.join('\n');
          expect(actualContent).toBe(expectedContent);
        }),
        { numRuns: 100 }
      );
    });

    it('GO within string literals does not cause splitting', () => {
      fc.assert(
        fc.property(arbitrarySqlWithGoInString, (sql) => {
          const batches = splitBatches(sql);
          // The GO is inside a string literal, so it should NOT split
          // The entire input should be a single batch
          expect(batches.length).toBe(1);
        }),
        { numRuns: 100 }
      );
    });

    it('GO within block comments does not cause splitting', () => {
      fc.assert(
        fc.property(arbitrarySqlWithGoInBlockComment, (sql) => {
          const batches = splitBatches(sql);
          // The GO is inside a block comment, so it should NOT split
          expect(batches.length).toBe(1);
        }),
        { numRuns: 100 }
      );
    });

    it('GO within single-line comments does not cause splitting', () => {
      fc.assert(
        fc.property(arbitrarySqlWithGoInLineComment, (sql) => {
          const batches = splitBatches(sql);
          // The GO is inside a line comment (on the same line), so it should NOT split
          expect(batches.length).toBe(1);
        }),
        { numRuns: 100 }
      );
    });
  });
});
