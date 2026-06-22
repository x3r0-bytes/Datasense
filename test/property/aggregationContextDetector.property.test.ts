import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  detectAggregationContext,
  FULL_AGGREGATE_FUNCTIONS,
  WILDCARD_AGGREGATE_FUNCTIONS,
  NUMERIC_AGGREGATE_FUNCTIONS,
} from '../../server/src/aggregationContextDetector';

/**
 * Property-based tests for Aggregation Context Detector
 * Feature: aggregation-group-by, Property 5: Aggregation context detection with nested parentheses
 *
 * **Validates: Requirements 3.1, 3.2**
 *
 * For any aggregate function name and any nesting depth of parentheses (0 to N)
 * inside the aggregate's argument, `detectAggregationContext` SHALL return
 * `inAggregate: true` with the correct `functionName` when the cursor is
 * positioned inside the aggregate's parentheses.
 */

// --- Constants ---

/** All recognized aggregate function names */
const ALL_AGGREGATE_FUNCTIONS = [...FULL_AGGREGATE_FUNCTIONS];

// --- Generators ---

/** Generator: random aggregate function name from the full set */
const arbAggregateFunction: fc.Arbitrary<string> = fc.constantFrom(...ALL_AGGREGATE_FUNCTIONS);

/** Generator: random valid SQL identifier */
const arbIdentifier: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')),
      { minLength: 0, maxLength: 8 }
    )
  )
  .map(([first, rest]) => first + rest);

/** Generator: nesting depth (0 means just inside the aggregate parens, N means N levels of nested parens) */
const arbNestingDepth: fc.Arbitrary<number> = fc.integer({ min: 0, max: 5 });

/**
 * Generator: builds text before cursor that places the cursor inside an aggregate
 * function at a given nesting depth.
 *
 * Example outputs:
 * - depth 0: "SUM("
 * - depth 1: "SUM(CASE WHEN ("
 * - depth 2: "SUM(CASE WHEN (ISNULL("
 */
const arbAggregateTextWithNesting: fc.Arbitrary<{
  text: string;
  functionName: string;
  depth: number;
}> = fc.tuple(arbAggregateFunction, arbNestingDepth, arbIdentifier).map(
  ([funcName, depth, colName]) => {
    let text = `SELECT ${funcName}(`;

    // Add nested parentheses with realistic SQL content between them
    for (let i = 0; i < depth; i++) {
      // Add some content before the next nested paren to make it realistic
      if (i === 0) {
        text += 'CASE WHEN (';
      } else {
        text += `ISNULL(`;
      }
    }

    // Add a column name as content at the deepest level (cursor is after this)
    text += colName;

    return { text, functionName: funcName, depth };
  }
);

/**
 * Generator: builds text with a prefix before the aggregate function
 * (e.g., "SELECT col1, " before "SUM(") to test that prefix content
 * doesn't interfere with detection.
 */
const arbAggregateWithPrefix: fc.Arbitrary<{
  text: string;
  functionName: string;
}> = fc.tuple(
  arbAggregateFunction,
  arbIdentifier,
  fc.constantFrom('SELECT ', 'SELECT col1, ', 'SELECT a, b, ')
).map(([funcName, colName, prefix]) => {
  const text = `${prefix}${funcName}(${colName}`;
  return { text, functionName: funcName };
});

/**
 * Generator: builds text with mixed case aggregate function names
 * to verify case-insensitive detection.
 */
const arbMixedCaseAggregate: fc.Arbitrary<{
  text: string;
  functionName: string;
}> = fc.tuple(arbAggregateFunction, arbIdentifier).chain(([funcName, colName]) => {
  // Generate a random casing of the function name
  return fc.array(fc.boolean(), { minLength: funcName.length, maxLength: funcName.length }).map(
    (upperFlags) => {
      const mixedCase = funcName
        .split('')
        .map((ch, i) => (upperFlags[i] ? ch.toUpperCase() : ch.toLowerCase()))
        .join('');
      const text = `SELECT ${mixedCase}(${colName}`;
      return { text, functionName: funcName }; // Expected result is always uppercase
    }
  );
});

// --- Property Tests ---

describe('Feature: aggregation-group-by, Property 5: Aggregation context detection with nested parentheses', () => {
  it('detects aggregation context at any nesting depth inside aggregate parentheses', () => {
    fc.assert(
      fc.property(
        arbAggregateTextWithNesting,
        ({ text, functionName }) => {
          const result = detectAggregationContext(text);

          expect(result.inAggregate).toBe(true);
          expect(result.functionName).toBe(functionName);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('returns correct functionName for all aggregate functions with no nesting', () => {
    fc.assert(
      fc.property(
        arbAggregateFunction,
        arbIdentifier,
        (funcName, colName) => {
          const text = `SELECT ${funcName}(${colName}`;
          const result = detectAggregationContext(text);

          expect(result.inAggregate).toBe(true);
          expect(result.functionName).toBe(funcName);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('correctly sets supportsWildcard flag based on function name', () => {
    fc.assert(
      fc.property(
        arbAggregateFunction,
        arbIdentifier,
        (funcName, colName) => {
          const text = `SELECT ${funcName}(${colName}`;
          const result = detectAggregationContext(text);

          expect(result.inAggregate).toBe(true);
          expect(result.supportsWildcard).toBe(WILDCARD_AGGREGATE_FUNCTIONS.has(funcName));
        }
      ),
      { numRuns: 200 }
    );
  });

  it('correctly sets prefersNumeric flag based on function name', () => {
    fc.assert(
      fc.property(
        arbAggregateFunction,
        arbIdentifier,
        (funcName, colName) => {
          const text = `SELECT ${funcName}(${colName}`;
          const result = detectAggregationContext(text);

          expect(result.inAggregate).toBe(true);
          expect(result.prefersNumeric).toBe(NUMERIC_AGGREGATE_FUNCTIONS.has(funcName));
        }
      ),
      { numRuns: 200 }
    );
  });

  it('detects aggregation context with prefix content before the aggregate', () => {
    fc.assert(
      fc.property(
        arbAggregateWithPrefix,
        ({ text, functionName }) => {
          const result = detectAggregationContext(text);

          expect(result.inAggregate).toBe(true);
          expect(result.functionName).toBe(functionName);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('detects aggregation context with mixed-case function names', () => {
    fc.assert(
      fc.property(
        arbMixedCaseAggregate,
        ({ text, functionName }) => {
          const result = detectAggregationContext(text);

          expect(result.inAggregate).toBe(true);
          expect(result.functionName).toBe(functionName);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('returns inAggregate: false when cursor is outside aggregate parentheses', () => {
    fc.assert(
      fc.property(
        arbIdentifier,
        arbIdentifier,
        (col1, col2) => {
          // Cursor after a closed aggregate — not inside it
          const text = `SELECT SUM(${col1}), ${col2}`;
          const result = detectAggregationContext(text);

          expect(result.inAggregate).toBe(false);
          expect(result.functionName).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns inAggregate: false for non-aggregate function parentheses', () => {
    fc.assert(
      fc.property(
        arbIdentifier,
        arbIdentifier,
        (funcName, colName) => {
          // Use a non-aggregate function name (filter out aggregate names)
          fc.pre(!FULL_AGGREGATE_FUNCTIONS.has(funcName.toUpperCase()));

          const text = `SELECT ${funcName}(${colName}`;
          const result = detectAggregationContext(text);

          expect(result.inAggregate).toBe(false);
          expect(result.functionName).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns inAggregate: false for empty or whitespace-only input', () => {
    fc.assert(
      fc.property(
        fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 0, maxLength: 10 }),
        (whitespace) => {
          const result = detectAggregationContext(whitespace);

          expect(result.inAggregate).toBe(false);
          expect(result.functionName).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });
});
