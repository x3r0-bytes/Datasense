import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// Feature: ui-iteration-v05, Property 8: Statement boundary parsing

/**
 * Property-based tests for StatementParser
 * Property 8: Statement boundary parsing
 *
 * Validates: Requirements 7.1, 7.10, 7.11
 *
 * For any SQL document text containing GO separators, semicolons, string literals,
 * block comments, and single-line comments, parseStatements SHALL:
 * - Split on GO lines first (GO on its own line, not inside strings/comments)
 * - Split each batch on semicolons not inside string literals, block comments, or single-line comments
 * - Treat trailing non-whitespace text after the last semicolon as a statement
 * - Produce boundaries where every non-whitespace character in the document belongs to exactly one statement
 *   (or is part of a GO separator line)
 * - Assign correct batchIndex (1-based) and statementIndex (1-based within batch) values
 * - Produce non-overlapping boundaries (no two boundaries share a line)
 */

import { parseStatements, findStatementAtCursor } from '../../src/statementParser';
import { StatementBoundary } from '../../src/types';

// --- Generators ---

/** Simple SQL statements that don't contain semicolons, GO, or comment/string syntax */
const simpleStatements: fc.Arbitrary<string> = fc.oneof(
  fc.constant('SELECT 1'),
  fc.constant('SELECT * FROM dbo.Users'),
  fc.constant('INSERT INTO t VALUES(1)'),
  fc.constant('UPDATE t SET x = 1'),
  fc.constant('DELETE FROM t WHERE id = 1'),
  fc.constant('DECLARE @x INT = 5'),
  fc.constant('PRINT @msg'),
  fc.constant('EXEC sp_help'),
  fc.constant('CREATE TABLE #tmp (id INT)'),
  fc.constant('DROP TABLE #tmp')
);

/** String literals (single-quoted, may contain escaped quotes) */
const stringLiterals: fc.Arbitrary<string> = fc.oneof(
  fc.constant("'hello world'"),
  fc.constant("'it''s a test'"),
  fc.constant("'semi;colon inside'"),
  fc.constant("'GO inside string'"),
  fc.constant("'multi\nline\nstring'"),
  fc.constant("''") // empty string
);

/** Block comments (may contain semicolons and GO) */
const blockComments: fc.Arbitrary<string> = fc.oneof(
  fc.constant('/* comment */'),
  fc.constant('/* semi;colon */'),
  fc.constant('/* GO */'),
  fc.constant('/* multi\nline\ncomment */'),
  fc.constant('/* nested -- comment */')
);

/** Single-line comments */
const singleLineComments: fc.Arbitrary<string> = fc.oneof(
  fc.constant('-- this is a comment'),
  fc.constant('-- semi;colon in comment'),
  fc.constant('-- GO in comment'),
  fc.constant('-- end')
);

/** GO separator (on its own line) */
const goSeparator: fc.Arbitrary<string> = fc.oneof(
  fc.constant('GO'),
  fc.constant('go'),
  fc.constant('Go'),
  fc.constant('  GO'),
  fc.constant('GO  ')
);

/** A SQL fragment that forms part of a statement (no semicolons or GO on own line) */
const statementFragment: fc.Arbitrary<string> = fc.oneof(
  simpleStatements,
  fc.tuple(simpleStatements, stringLiterals).map(([stmt, str]) => `SELECT ${str}`),
  fc.tuple(simpleStatements, blockComments).map(([stmt, cmt]) => `${stmt} ${cmt}`),
  fc.tuple(simpleStatements, singleLineComments).map(([stmt, cmt]) => `${stmt} ${cmt}`)
);

/**
 * Generator: Build a SQL document from building blocks.
 * Structure: multiple batches separated by GO, each batch containing
 * multiple statements separated by semicolons.
 */
const arbitrarySqlDocument: fc.Arbitrary<string> = fc.record({
  batches: fc.array(
    fc.record({
      statements: fc.array(statementFragment, { minLength: 1, maxLength: 4 }),
      trailingComment: fc.option(singleLineComments, { nil: undefined }),
    }),
    { minLength: 1, maxLength: 4 }
  ),
}).map(({ batches }) => {
  const batchTexts: string[] = [];
  for (const batch of batches) {
    // Join statements with semicolons, last one may or may not have a trailing semicolon
    const stmtText = batch.statements.join(';\n');
    const fullBatch = batch.trailingComment
      ? `${stmtText}\n${batch.trailingComment}`
      : stmtText;
    batchTexts.push(fullBatch);
  }
  return batchTexts.join('\nGO\n');
});

/**
 * Generator: A simpler document with known structure for verifying batch/statement indices.
 * Generates N batches, each with M statements, separated by GO.
 */
const arbitraryStructuredDocument: fc.Arbitrary<{
  text: string;
  expectedBatchCount: number;
  expectedStatementsPerBatch: number[];
}> = fc.record({
  batchCount: fc.integer({ min: 1, max: 5 }),
  statementsPerBatch: fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 5 }),
}).map(({ batchCount, statementsPerBatch }) => {
  // Ensure we have the right number of batch specs
  const specs = statementsPerBatch.slice(0, batchCount);
  while (specs.length < batchCount) {
    specs.push(1);
  }

  const batchTexts: string[] = [];
  for (let b = 0; b < batchCount; b++) {
    const stmts: string[] = [];
    for (let s = 0; s < specs[b]; s++) {
      stmts.push(`SELECT ${b + 1}${s + 1}`);
    }
    batchTexts.push(stmts.join(';\n'));
  }

  return {
    text: batchTexts.join('\nGO\n'),
    expectedBatchCount: batchCount,
    expectedStatementsPerBatch: specs,
  };
});

// --- Tests ---

describe('StatementParser Property Tests', () => {
  // Feature: ui-iteration-v05, Property 8: Statement boundary parsing

  describe('Property 8: Statement boundary parsing', () => {
    /**
     * Validates: Requirements 7.1, 7.10, 7.11
     */

    it('produces non-overlapping boundaries for any generated SQL document', () => {
      fc.assert(
        fc.property(arbitrarySqlDocument, (docText) => {
          const boundaries = parseStatements(docText);

          // Verify non-overlapping: no two boundaries share a line
          for (let i = 0; i < boundaries.length - 1; i++) {
            expect(boundaries[i].endLine).toBeLessThan(boundaries[i + 1].startLine);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('assigns correct 1-based batchIndex values', () => {
      fc.assert(
        fc.property(arbitrarySqlDocument, (docText) => {
          const boundaries = parseStatements(docText);

          if (boundaries.length === 0) return;

          // batchIndex should be 1-based and non-decreasing
          let prevBatchIndex = 0;
          for (const b of boundaries) {
            expect(b.batchIndex).toBeGreaterThanOrEqual(1);
            expect(b.batchIndex).toBeGreaterThanOrEqual(prevBatchIndex);
            prevBatchIndex = b.batchIndex;
          }
        }),
        { numRuns: 100 }
      );
    });

    it('assigns correct 1-based statementIndex values within each batch', () => {
      fc.assert(
        fc.property(arbitrarySqlDocument, (docText) => {
          const boundaries = parseStatements(docText);

          if (boundaries.length === 0) return;

          // Group by batchIndex and verify statementIndex is sequential 1-based
          const batches = new Map<number, StatementBoundary[]>();
          for (const b of boundaries) {
            if (!batches.has(b.batchIndex)) {
              batches.set(b.batchIndex, []);
            }
            batches.get(b.batchIndex)!.push(b);
          }

          for (const [, stmts] of batches) {
            for (let i = 0; i < stmts.length; i++) {
              expect(stmts[i].statementIndex).toBe(i + 1);
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    it('every non-whitespace character belongs to exactly one statement or GO separator', () => {
      fc.assert(
        fc.property(arbitrarySqlDocument, (docText) => {
          const boundaries = parseStatements(docText);
          const lines = docText.split(/\r?\n/);

          // Build a set of lines that are GO separators
          const goLines = new Set<number>();
          for (let i = 0; i < lines.length; i++) {
            if (/^\s*GO\s*$/i.test(lines[i])) {
              goLines.add(i);
            }
          }

          // Build a coverage map: for each line, track which boundary covers it
          const lineCoverage = new Array(lines.length).fill(-1);
          for (let bIdx = 0; bIdx < boundaries.length; bIdx++) {
            const b = boundaries[bIdx];
            for (let line = b.startLine; line <= b.endLine; line++) {
              // A line should not be covered by multiple boundaries
              if (lineCoverage[line] !== -1) {
                // Overlapping boundaries - this is a failure
                expect(lineCoverage[line]).toBe(-1);
              }
              lineCoverage[line] = bIdx;
            }
          }

          // Every line with non-whitespace content should be covered by a boundary or be a GO line
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim().length > 0 && !goLines.has(i)) {
              expect(lineCoverage[i]).toBeGreaterThanOrEqual(0);
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    it('splits on GO lines first (GO on its own line, not inside strings/comments)', () => {
      fc.assert(
        fc.property(arbitrarySqlDocument, (docText) => {
          const boundaries = parseStatements(docText);
          const lines = docText.split(/\r?\n/);

          // Find GO separator lines (standalone GO, not inside strings/comments)
          const goLineIndices: number[] = [];
          for (let i = 0; i < lines.length; i++) {
            if (/^\s*GO\s*$/i.test(lines[i])) {
              goLineIndices.push(i);
            }
          }

          // No boundary should span across a GO line
          for (const b of boundaries) {
            for (const goLine of goLineIndices) {
              if (goLine > b.startLine && goLine < b.endLine) {
                // A GO line should not be inside a statement boundary
                // (it can be equal to startLine or endLine only if it's not a real GO separator)
                expect(goLine).not.toBeGreaterThan(b.startLine);
              }
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    it('treats trailing non-whitespace text after last semicolon as a statement', () => {
      fc.assert(
        fc.property(
          fc.tuple(simpleStatements, simpleStatements),
          ([stmt1, stmt2]) => {
            // Build a document with a semicolon-terminated statement followed by trailing text
            const docText = `${stmt1};\n${stmt2}`;
            const boundaries = parseStatements(docText);

            // Should produce at least 2 statements
            expect(boundaries.length).toBeGreaterThanOrEqual(2);

            // The last boundary should contain the trailing statement text
            const lastBoundary = boundaries[boundaries.length - 1];
            expect(lastBoundary.text.trim()).toBe(stmt2.trim());
          }
        ),
        { numRuns: 100 }
      );
    });

    it('does not split on semicolons inside string literals', () => {
      fc.assert(
        fc.property(simpleStatements, (stmt) => {
          // A statement containing a string literal with a semicolon
          const docText = `SELECT 'hello;world';\n${stmt}`;
          const boundaries = parseStatements(docText);

          // Should produce exactly 2 statements (the SELECT with string, and the trailing stmt)
          expect(boundaries.length).toBe(2);

          // First statement should contain the full string literal
          expect(boundaries[0].text).toContain("'hello;world'");
        }),
        { numRuns: 100 }
      );
    });

    it('does not split on semicolons inside block comments', () => {
      fc.assert(
        fc.property(simpleStatements, (stmt) => {
          // A statement with a block comment containing a semicolon
          const docText = `SELECT 1 /* semi;colon */;\n${stmt}`;
          const boundaries = parseStatements(docText);

          // Should produce exactly 2 statements
          expect(boundaries.length).toBe(2);

          // First statement should contain the block comment
          expect(boundaries[0].text).toContain('/* semi;colon */');
        }),
        { numRuns: 100 }
      );
    });

    it('does not split on semicolons inside single-line comments', () => {
      fc.assert(
        fc.property(simpleStatements, (stmt) => {
          // A statement with a single-line comment containing a semicolon
          const docText = `SELECT 1 -- semi;colon\n;\n${stmt}`;
          const boundaries = parseStatements(docText);

          // The semicolon on its own line should split, producing 2 statements
          // (the SELECT with comment, and the trailing stmt)
          expect(boundaries.length).toBe(2);

          // First statement should contain the single-line comment
          expect(boundaries[0].text).toContain('-- semi;colon');
        }),
        { numRuns: 100 }
      );
    });

    it('produces correct batchIndex and statementIndex for structured documents', () => {
      fc.assert(
        fc.property(arbitraryStructuredDocument, ({ text, expectedBatchCount, expectedStatementsPerBatch }) => {
          const boundaries = parseStatements(text);

          // Group boundaries by batchIndex
          const batches = new Map<number, StatementBoundary[]>();
          for (const b of boundaries) {
            if (!batches.has(b.batchIndex)) {
              batches.set(b.batchIndex, []);
            }
            batches.get(b.batchIndex)!.push(b);
          }

          // Verify batch count
          expect(batches.size).toBe(expectedBatchCount);

          // Verify statement count per batch
          for (let b = 0; b < expectedBatchCount; b++) {
            const batchStmts = batches.get(b + 1);
            expect(batchStmts).toBeDefined();
            expect(batchStmts!.length).toBe(expectedStatementsPerBatch[b]);

            // Verify statementIndex is sequential 1-based
            for (let s = 0; s < batchStmts!.length; s++) {
              expect(batchStmts![s].statementIndex).toBe(s + 1);
              expect(batchStmts![s].batchIndex).toBe(b + 1);
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    it('startLine and endLine are valid 0-based line indices', () => {
      fc.assert(
        fc.property(arbitrarySqlDocument, (docText) => {
          const boundaries = parseStatements(docText);
          const lineCount = docText.split(/\r?\n/).length;

          for (const b of boundaries) {
            expect(b.startLine).toBeGreaterThanOrEqual(0);
            expect(b.endLine).toBeGreaterThanOrEqual(b.startLine);
            expect(b.endLine).toBeLessThan(lineCount);
          }
        }),
        { numRuns: 100 }
      );
    });
  });

  // Feature: ui-iteration-v05, Property 9: Cursor-to-statement mapping

  describe('Property 9: Cursor-to-statement mapping', () => {
    /**
     * Validates: Requirements 7.2
     *
     * For any array of non-overlapping StatementBoundary objects and a cursor line number,
     * findStatementAtCursor SHALL return:
     * - The boundary whose [startLine, endLine] range contains the cursor line, if one exists
     * - null if the cursor is on a line not covered by any statement boundary
     */

    // --- Generators for Property 9 ---

    /**
     * Generator: creates an array of non-overlapping StatementBoundary objects sorted by startLine.
     * Each boundary is separated by a gap of 0–3 lines (gap of 0 means adjacent with no uncovered lines).
     */
    const arbitraryBoundaryArray: fc.Arbitrary<StatementBoundary[]> = fc.array(
      fc.record({
        span: fc.nat({ max: 5 }),   // how many extra lines this statement spans (0 = single line)
        gap: fc.nat({ max: 3 }),    // gap after this statement before the next one
      }),
      { minLength: 0, maxLength: 20 }
    ).map((specs) => {
      const boundaries: StatementBoundary[] = [];
      let currentLine = 0;

      for (let i = 0; i < specs.length; i++) {
        const { span, gap } = specs[i];
        const startLine = currentLine;
        const endLine = startLine + span;

        boundaries.push({
          startLine,
          endLine,
          text: `SELECT statement_${i + 1}`,
          batchIndex: 1,
          statementIndex: i + 1,
        });

        // Next statement starts after this one's endLine + gap + 1
        currentLine = endLine + 1 + gap;
      }

      return boundaries;
    });

    /**
     * Generator: a cursor line number within a reasonable range based on boundaries.
     */
    function arbitraryCursorLine(boundaries: StatementBoundary[]): fc.Arbitrary<number> {
      if (boundaries.length === 0) {
        return fc.nat({ max: 50 });
      }
      const maxLine = boundaries[boundaries.length - 1].endLine + 10;
      return fc.nat({ max: maxLine });
    }

    /**
     * Model: reference implementation for finding the boundary at a cursor line.
     */
    function modelFindStatementAtCursor(
      boundaries: StatementBoundary[],
      cursorLine: number
    ): StatementBoundary | null {
      for (const b of boundaries) {
        if (cursorLine >= b.startLine && cursorLine <= b.endLine) {
          return b;
        }
      }
      return null;
    }

    it('returns the correct boundary when cursor is within a statement range', () => {
      fc.assert(
        fc.property(arbitraryBoundaryArray, (boundaries) => {
          // For each boundary, pick a cursor line within its range and verify
          for (const boundary of boundaries) {
            const cursorLine = boundary.startLine + Math.floor((boundary.endLine - boundary.startLine) / 2);
            const result = findStatementAtCursor(boundaries, cursorLine);
            expect(result).not.toBeNull();
            expect(result!.startLine).toBe(boundary.startLine);
            expect(result!.endLine).toBe(boundary.endLine);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('returns null when cursor is on a line not covered by any boundary', () => {
      fc.assert(
        fc.property(arbitraryBoundaryArray, (boundaries) => {
          if (boundaries.length === 0) {
            // Any cursor line should return null
            const result = findStatementAtCursor(boundaries, 0);
            expect(result).toBeNull();
            return;
          }

          // Check a line beyond the last boundary
          const beyondLine = boundaries[boundaries.length - 1].endLine + 1;
          const result = findStatementAtCursor(boundaries, beyondLine);
          expect(result).toBeNull();

          // Check gap lines between boundaries
          for (let i = 0; i < boundaries.length - 1; i++) {
            const gapStart = boundaries[i].endLine + 1;
            const gapEnd = boundaries[i + 1].startLine - 1;
            if (gapStart <= gapEnd) {
              const gapResult = findStatementAtCursor(boundaries, gapStart);
              expect(gapResult).toBeNull();
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    it('matches the model reference implementation for any cursor position', () => {
      fc.assert(
        fc.property(
          arbitraryBoundaryArray.chain((boundaries) =>
            arbitraryCursorLine(boundaries).map((cursor) => ({ boundaries, cursor }))
          ),
          ({ boundaries, cursor }) => {
            const actual = findStatementAtCursor(boundaries, cursor);
            const expected = modelFindStatementAtCursor(boundaries, cursor);

            if (expected === null) {
              expect(actual).toBeNull();
            } else {
              expect(actual).not.toBeNull();
              expect(actual!.startLine).toBe(expected.startLine);
              expect(actual!.endLine).toBe(expected.endLine);
              expect(actual!.text).toBe(expected.text);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('returns null for negative cursor lines', () => {
      fc.assert(
        fc.property(arbitraryBoundaryArray, (boundaries) => {
          const result = findStatementAtCursor(boundaries, -1);
          expect(result).toBeNull();
        }),
        { numRuns: 100 }
      );
    });

    it('returns the boundary at startLine when cursor equals startLine', () => {
      fc.assert(
        fc.property(arbitraryBoundaryArray, (boundaries) => {
          for (const boundary of boundaries) {
            const result = findStatementAtCursor(boundaries, boundary.startLine);
            expect(result).not.toBeNull();
            expect(result!.startLine).toBe(boundary.startLine);
            expect(result!.endLine).toBe(boundary.endLine);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('returns the boundary at endLine when cursor equals endLine', () => {
      fc.assert(
        fc.property(arbitraryBoundaryArray, (boundaries) => {
          for (const boundary of boundaries) {
            const result = findStatementAtCursor(boundaries, boundary.endLine);
            expect(result).not.toBeNull();
            expect(result!.startLine).toBe(boundary.startLine);
            expect(result!.endLine).toBe(boundary.endLine);
          }
        }),
        { numRuns: 100 }
      );
    });
  });
});
