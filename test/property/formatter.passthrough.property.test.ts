import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { formatDocument, FormatOptions } from '../../server/src/formatter';
import { parseDocument } from '../../server/src/tsqlParser';

/**
 * Property-based tests for formatter passthrough behavior (Property 12)
 * Feature: next-iteration-features, Property 12: Invalid SQL passthrough
 *
 * **Validates: Requirements 2.9**
 *
 * For any T-SQL document containing syntax errors, the formatter SHALL return
 * the document text unchanged (output === input).
 */

// ─── Generators ───────────────────────────────────────────────────────────────

/** Generator: random FormatOptions combinations */
const arbitraryFormatOptions: fc.Arbitrary<FormatOptions> = fc.record({
  tabSize: fc.constantFrom(2, 4, 8),
  insertSpaces: fc.boolean(),
  eol: fc.constantFrom('\n', '\r\n'),
});

/** Generator: random identifier for use in SQL */
const arbitraryIdentifier: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz_'.split('')),
  { minLength: 1, maxLength: 10 }
);

/**
 * Generator: SQL with unclosed BEGIN blocks (WHILE ... BEGIN without END).
 * The parser reliably detects these as "Expected END to close BEGIN block".
 */
const sqlUnclosedWhileBegin: fc.Arbitrary<string> = fc
  .tuple(
    arbitraryIdentifier,
    fc.constantFrom('> 0', '< 10', '= 1', '<> 0', '>= 1'),
    fc.constantFrom(
      'SELECT 1',
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET x = 1',
      'DELETE FROM t',
      'PRINT @msg'
    )
  )
  .map(([varName, op, body]) => `WHILE @${varName} ${op} BEGIN\n  ${body}`);

/**
 * Generator: SQL with unclosed BEGIN blocks (IF ... BEGIN without END).
 * The parser reliably detects these as "Expected END to close BEGIN block".
 */
const sqlUnclosedIfBegin: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('1=1', '0=1', '@x > 0', '@y IS NOT NULL', 'EXISTS (SELECT 1)'),
    fc.constantFrom(
      'SELECT 1',
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET x = 1',
      'DELETE FROM t WHERE id = 1',
      'EXEC sp_help'
    )
  )
  .map(([condition, body]) => `IF ${condition} BEGIN\n  ${body}`);

/**
 * Generator: SQL with unclosed BEGIN blocks (CREATE PROCEDURE ... BEGIN without END).
 */
const sqlUnclosedProcBegin: fc.Arbitrary<string> = fc
  .tuple(
    arbitraryIdentifier,
    fc.constantFrom(
      'SELECT 1',
      'SELECT @x = 1',
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET col = @val'
    )
  )
  .map(([procName, body]) => `CREATE PROCEDURE ${procName} AS BEGIN\n  ${body}`);

/**
 * Generator: Multi-batch SQL where at least one batch has a syntax error.
 * Combines a valid batch with an invalid batch separated by GO.
 */
const sqlMultiBatchWithError: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(
      'SELECT 1',
      'SELECT * FROM sys.tables',
      'DECLARE @x INT'
    ),
    sqlUnclosedWhileBegin
  )
  .map(([validBatch, invalidBatch]) => `${validBatch}\nGO\n${invalidBatch}`);

/**
 * Generator: SQL with nested unclosed BEGIN blocks.
 */
const sqlNestedUnclosedBegin: fc.Arbitrary<string> = fc
  .tuple(
    arbitraryIdentifier,
    fc.constantFrom('> 0', '< 100', '= 1')
  )
  .map(([varName, op]) =>
    `WHILE @${varName} ${op} BEGIN\n  IF @${varName} ${op} BEGIN\n    SELECT @${varName}`
  );

/**
 * Combined generator: produces various forms of invalid T-SQL that the parser
 * reliably detects as having syntax errors.
 * 
 * We pre-filter to ensure the parser actually reports errors for the generated input.
 */
const arbitraryInvalidSql: fc.Arbitrary<string> = fc.oneof(
  sqlUnclosedWhileBegin,
  sqlUnclosedIfBegin,
  sqlUnclosedProcBegin,
  sqlMultiBatchWithError,
  sqlNestedUnclosedBegin
).filter((sql) => {
  // Ensure the parser actually reports at least one error for this input
  const results = parseDocument(sql);
  return results.some(r => r.errors.length > 0);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Formatter Property Tests — Invalid SQL Passthrough', () => {
  describe('Property 12: Invalid SQL passthrough', () => {
    /**
     * **Validates: Requirements 2.9**
     *
     * For any T-SQL document containing syntax errors, the formatter SHALL
     * return the document text unchanged (output === input).
     */

    it('formatter returns invalid SQL unchanged regardless of format options', () => {
      fc.assert(
        fc.property(arbitraryInvalidSql, arbitraryFormatOptions, (sql, options) => {
          const result = formatDocument(sql, options);

          // The output text must be identical to the input
          expect(result.text).toBe(sql);
          // The formatted flag must be false (formatting was not applied)
          expect(result.formatted).toBe(false);
        }),
        { numRuns: 100 }
      );
    });

    it('formatter returns SQL with unclosed WHILE BEGIN blocks unchanged', () => {
      fc.assert(
        fc.property(sqlUnclosedWhileBegin, arbitraryFormatOptions, (sql, options) => {
          const result = formatDocument(sql, options);
          expect(result.text).toBe(sql);
          expect(result.formatted).toBe(false);
        }),
        { numRuns: 100 }
      );
    });

    it('formatter returns SQL with unclosed IF BEGIN blocks unchanged', () => {
      fc.assert(
        fc.property(sqlUnclosedIfBegin, arbitraryFormatOptions, (sql, options) => {
          const result = formatDocument(sql, options);
          expect(result.text).toBe(sql);
          expect(result.formatted).toBe(false);
        }),
        { numRuns: 100 }
      );
    });
  });
});
