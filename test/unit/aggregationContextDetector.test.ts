import { describe, it, expect } from 'vitest';
import {
  detectAggregationContext,
  AggregationContextResult,
  FULL_AGGREGATE_FUNCTIONS,
  NUMERIC_AGGREGATE_FUNCTIONS,
  WILDCARD_AGGREGATE_FUNCTIONS,
} from '../../server/src/aggregationContextDetector';

describe('aggregationContextDetector', () => {
  describe('basic detection (Req 3.1)', () => {
    it('detects SUM( cursor', () => {
      const result = detectAggregationContext('SELECT SUM(');
      expect(result.inAggregate).toBe(true);
      expect(result.functionName).toBe('SUM');
      expect(result.prefersNumeric).toBe(true);
      expect(result.supportsWildcard).toBe(false);
    });

    it('detects COUNT( cursor', () => {
      const result = detectAggregationContext('SELECT COUNT(');
      expect(result.inAggregate).toBe(true);
      expect(result.functionName).toBe('COUNT');
      expect(result.prefersNumeric).toBe(false);
      expect(result.supportsWildcard).toBe(true);
    });

    it('detects AVG( cursor', () => {
      const result = detectAggregationContext('SELECT AVG(');
      expect(result.inAggregate).toBe(true);
      expect(result.functionName).toBe('AVG');
      expect(result.prefersNumeric).toBe(true);
      expect(result.supportsWildcard).toBe(false);
    });

    it('detects MIN( cursor', () => {
      const result = detectAggregationContext('SELECT MIN(');
      expect(result.inAggregate).toBe(true);
      expect(result.functionName).toBe('MIN');
      expect(result.prefersNumeric).toBe(false);
      expect(result.supportsWildcard).toBe(false);
    });

    it('detects MAX( cursor', () => {
      const result = detectAggregationContext('SELECT MAX(');
      expect(result.inAggregate).toBe(true);
      expect(result.functionName).toBe('MAX');
      expect(result.prefersNumeric).toBe(false);
      expect(result.supportsWildcard).toBe(false);
    });

    it('detects COUNT_BIG( cursor', () => {
      const result = detectAggregationContext('SELECT COUNT_BIG(');
      expect(result.inAggregate).toBe(true);
      expect(result.functionName).toBe('COUNT_BIG');
      expect(result.supportsWildcard).toBe(true);
    });

    it('detects STDEV( cursor', () => {
      const result = detectAggregationContext('SELECT STDEV(');
      expect(result.inAggregate).toBe(true);
      expect(result.functionName).toBe('STDEV');
      expect(result.prefersNumeric).toBe(true);
    });

    it('detects aggregate with text already inside parens', () => {
      const result = detectAggregationContext('SELECT SUM(col');
      expect(result.inAggregate).toBe(true);
      expect(result.functionName).toBe('SUM');
    });

    it('detects aggregate function case-insensitively', () => {
      const result = detectAggregationContext('SELECT sum(');
      expect(result.inAggregate).toBe(true);
      expect(result.functionName).toBe('SUM');
    });

    it('detects aggregate with space before paren', () => {
      const result = detectAggregationContext('SELECT SUM (');
      expect(result.inAggregate).toBe(true);
      expect(result.functionName).toBe('SUM');
    });
  });

  describe('nested parentheses (Req 3.2)', () => {
    it('detects SUM(CASE WHEN x > 0 THEN cursor', () => {
      const result = detectAggregationContext('SELECT SUM(CASE WHEN x > 0 THEN ');
      expect(result.inAggregate).toBe(true);
      expect(result.functionName).toBe('SUM');
    });

    it('detects aggregate with nested function call', () => {
      const result = detectAggregationContext('SELECT SUM(ISNULL(col1, 0) + ');
      expect(result.inAggregate).toBe(true);
      expect(result.functionName).toBe('SUM');
    });

    it('detects aggregate with multiple nested parens', () => {
      const result = detectAggregationContext('SELECT AVG(CASE WHEN (x > 0) THEN (y + z) ELSE ');
      expect(result.inAggregate).toBe(true);
      expect(result.functionName).toBe('AVG');
    });

    it('detects aggregate with deeply nested parens', () => {
      const result = detectAggregationContext('SELECT COUNT(CASE WHEN (a AND (b OR c)) THEN ');
      expect(result.inAggregate).toBe(true);
      expect(result.functionName).toBe('COUNT');
    });
  });

  describe('non-aggregate parentheses (Req 3.1, 3.3)', () => {
    it('WHERE ( cursor returns inAggregate: false', () => {
      const result = detectAggregationContext('SELECT col FROM t WHERE (');
      expect(result.inAggregate).toBe(false);
      expect(result.functionName).toBeNull();
    });

    it('non-aggregate function paren returns inAggregate: false', () => {
      const result = detectAggregationContext('SELECT ISNULL(');
      expect(result.inAggregate).toBe(false);
      expect(result.functionName).toBeNull();
    });

    it('subquery paren returns inAggregate: false', () => {
      const result = detectAggregationContext('SELECT * FROM (');
      expect(result.inAggregate).toBe(false);
      expect(result.functionName).toBeNull();
    });

    it('JOIN condition paren returns inAggregate: false', () => {
      const result = detectAggregationContext('SELECT * FROM t1 JOIN t2 ON (');
      expect(result.inAggregate).toBe(false);
      expect(result.functionName).toBeNull();
    });

    it('CASE expression without aggregate returns inAggregate: false', () => {
      const result = detectAggregationContext('SELECT CASE WHEN (');
      expect(result.inAggregate).toBe(false);
      expect(result.functionName).toBeNull();
    });
  });

  describe('edge cases (Req 3.4)', () => {
    it('empty text returns inAggregate: false', () => {
      const result = detectAggregationContext('');
      expect(result.inAggregate).toBe(false);
      expect(result.functionName).toBeNull();
      expect(result.supportsWildcard).toBe(false);
      expect(result.prefersNumeric).toBe(false);
    });

    it('whitespace-only text returns inAggregate: false', () => {
      const result = detectAggregationContext('   ');
      expect(result.inAggregate).toBe(false);
      expect(result.functionName).toBeNull();
    });

    it('no parentheses returns inAggregate: false', () => {
      const result = detectAggregationContext('SELECT col1, col2 FROM table1');
      expect(result.inAggregate).toBe(false);
      expect(result.functionName).toBeNull();
    });

    it('all parens balanced returns inAggregate: false', () => {
      const result = detectAggregationContext('SELECT SUM(col1) + AVG(col2)');
      expect(result.inAggregate).toBe(false);
      expect(result.functionName).toBeNull();
    });

    it('syntax error inside aggregate still detects context', () => {
      const result = detectAggregationContext('SELECT SUM(col1 +++ ');
      expect(result.inAggregate).toBe(true);
      expect(result.functionName).toBe('SUM');
    });

    it('string literal inside aggregate is handled', () => {
      const result = detectAggregationContext("SELECT COUNT(CASE WHEN status = 'active' THEN ");
      expect(result.inAggregate).toBe(true);
      expect(result.functionName).toBe('COUNT');
    });

    it('comment inside aggregate is handled', () => {
      const result = detectAggregationContext('SELECT SUM(/* total */ ');
      expect(result.inAggregate).toBe(true);
      expect(result.functionName).toBe('SUM');
    });

    it('line comment before cursor is handled', () => {
      const result = detectAggregationContext('SELECT SUM(-- comment\n');
      expect(result.inAggregate).toBe(true);
      expect(result.functionName).toBe('SUM');
    });

    it('string with parens inside aggregate does not confuse depth', () => {
      const result = detectAggregationContext("SELECT COUNT(CASE WHEN name = '(test)' THEN ");
      expect(result.inAggregate).toBe(true);
      expect(result.functionName).toBe('COUNT');
    });
  });

  describe('constant sets', () => {
    it('FULL_AGGREGATE_FUNCTIONS contains all expected functions', () => {
      const expected = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COUNT_BIG', 'STDEV', 'STDEVP', 'VAR', 'VARP', 'STRING_AGG', 'CHECKSUM_AGG'];
      for (const fn of expected) {
        expect(FULL_AGGREGATE_FUNCTIONS.has(fn)).toBe(true);
      }
      expect(FULL_AGGREGATE_FUNCTIONS.size).toBe(expected.length);
    });

    it('NUMERIC_AGGREGATE_FUNCTIONS is a subset of FULL_AGGREGATE_FUNCTIONS', () => {
      for (const fn of NUMERIC_AGGREGATE_FUNCTIONS) {
        expect(FULL_AGGREGATE_FUNCTIONS.has(fn)).toBe(true);
      }
    });

    it('WILDCARD_AGGREGATE_FUNCTIONS is a subset of FULL_AGGREGATE_FUNCTIONS', () => {
      for (const fn of WILDCARD_AGGREGATE_FUNCTIONS) {
        expect(FULL_AGGREGATE_FUNCTIONS.has(fn)).toBe(true);
      }
    });

    it('WILDCARD_AGGREGATE_FUNCTIONS contains COUNT and COUNT_BIG', () => {
      expect(WILDCARD_AGGREGATE_FUNCTIONS.has('COUNT')).toBe(true);
      expect(WILDCARD_AGGREGATE_FUNCTIONS.has('COUNT_BIG')).toBe(true);
    });

    it('NUMERIC_AGGREGATE_FUNCTIONS contains SUM, AVG, STDEV, STDEVP, VAR, VARP', () => {
      expect(NUMERIC_AGGREGATE_FUNCTIONS.has('SUM')).toBe(true);
      expect(NUMERIC_AGGREGATE_FUNCTIONS.has('AVG')).toBe(true);
      expect(NUMERIC_AGGREGATE_FUNCTIONS.has('STDEV')).toBe(true);
      expect(NUMERIC_AGGREGATE_FUNCTIONS.has('STDEVP')).toBe(true);
      expect(NUMERIC_AGGREGATE_FUNCTIONS.has('VAR')).toBe(true);
      expect(NUMERIC_AGGREGATE_FUNCTIONS.has('VARP')).toBe(true);
    });
  });
});
