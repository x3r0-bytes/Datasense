import { describe, it, expect } from 'vitest';
import {
  analyzeSelectList,
  buildGroupByColumnList,
  SelectListAnalysis,
} from '../../server/src/groupByAnalyzer';

describe('groupByAnalyzer', () => {
  describe('analyzeSelectList', () => {
    describe('Mixed SELECT: aggregated and non-aggregated columns (Requirement 4.1, 4.2)', () => {
      it('identifies non-aggregated column and aggregate in mixed SELECT', () => {
        const sql = 'SELECT o.CustomerID, COUNT(*) FROM Orders o';
        const result = analyzeSelectList(sql);

        expect(result.hasAggregates).toBe(true);
        expect(result.needsGroupBy).toBe(true);
        expect(result.nonAggregatedExpressions).toContain('o.CustomerID');
        expect(result.columns).toHaveLength(2);

        const customerCol = result.columns.find(c => c.expression === 'o.CustomerID');
        expect(customerCol).toBeDefined();
        expect(customerCol!.isAggregated).toBe(false);

        const countCol = result.columns.find(c => c.expression === 'COUNT(*)');
        expect(countCol).toBeDefined();
        expect(countCol!.isAggregated).toBe(true);
      });
    });

    describe('All-aggregate SELECT: needsGroupBy is false (Requirement 4.5)', () => {
      it('returns needsGroupBy: false when all columns are aggregated', () => {
        const sql = 'SELECT COUNT(*), SUM(Amount) FROM Orders';
        const result = analyzeSelectList(sql);

        expect(result.hasAggregates).toBe(true);
        expect(result.needsGroupBy).toBe(false);
        expect(result.nonAggregatedExpressions).toHaveLength(0);
      });
    });

    describe('Aliased expressions use original reference (Requirement 4.4)', () => {
      it('uses original expression, not alias, in nonAggregatedExpressions', () => {
        const sql = 'SELECT col1 AS Name, SUM(col2) FROM MyTable';
        const result = analyzeSelectList(sql);

        expect(result.hasAggregates).toBe(true);
        expect(result.needsGroupBy).toBe(true);
        expect(result.nonAggregatedExpressions).toContain('col1');
        expect(result.nonAggregatedExpressions).not.toContain('Name');

        const aliasedCol = result.columns.find(c => c.expression === 'col1');
        expect(aliasedCol).toBeDefined();
        expect(aliasedCol!.alias).toBe('Name');
        expect(aliasedCol!.isAggregated).toBe(false);
      });
    });

    describe('Expressions with operators (Requirement 4.3)', () => {
      it('treats expression with operators as non-aggregated', () => {
        const sql = 'SELECT col1 + col2, AVG(col3) FROM MyTable';
        const result = analyzeSelectList(sql);

        expect(result.hasAggregates).toBe(true);
        expect(result.needsGroupBy).toBe(true);
        expect(result.nonAggregatedExpressions).toContain('col1 + col2');
      });
    });

    describe('Multi-table with aliases (Requirement 4.1, 4.2)', () => {
      it('identifies multiple non-aggregated columns from different tables', () => {
        const sql = 'SELECT o.CustomerID, p.Name, SUM(o.Amount) FROM Orders o JOIN Products p ON o.ProductID = p.ID';
        const result = analyzeSelectList(sql);

        expect(result.hasAggregates).toBe(true);
        expect(result.needsGroupBy).toBe(true);
        expect(result.nonAggregatedExpressions).toContain('o.CustomerID');
        expect(result.nonAggregatedExpressions).toContain('p.Name');
        expect(result.nonAggregatedExpressions).toHaveLength(2);
      });
    });

    describe('Edge cases', () => {
      it('returns failure result for empty string', () => {
        const result = analyzeSelectList('');

        expect(result.hasAggregates).toBe(false);
        expect(result.needsGroupBy).toBe(false);
        expect(result.columns).toHaveLength(0);
        expect(result.nonAggregatedExpressions).toHaveLength(0);
      });

      it('skips standalone * in SELECT *', () => {
        const sql = 'SELECT * FROM Orders';
        const result = analyzeSelectList(sql);

        expect(result.hasAggregates).toBe(false);
        expect(result.needsGroupBy).toBe(false);
        expect(result.columns).toHaveLength(0);
      });

      it('returns failure result when no FROM clause is present', () => {
        const sql = 'SELECT COUNT(*), SUM(Amount)';
        const result = analyzeSelectList(sql);

        // No FROM clause means the analyzer cannot determine the select list boundary
        expect(result.hasAggregates).toBe(false);
        expect(result.needsGroupBy).toBe(false);
        expect(result.columns).toHaveLength(0);
      });
    });
  });

  describe('buildGroupByColumnList', () => {
    it('joins expressions with commas preserving order', () => {
      const expressions = ['o.CustomerID', 'o.OrderDate'];
      const result = buildGroupByColumnList(expressions);
      expect(result).toBe('o.CustomerID, o.OrderDate');
    });

    it('preserves alias qualification', () => {
      const expressions = ['o.CustomerID', 'p.Name'];
      const result = buildGroupByColumnList(expressions);
      expect(result).toBe('o.CustomerID, p.Name');
    });

    it('returns empty string for empty array', () => {
      const result = buildGroupByColumnList([]);
      expect(result).toBe('');
    });

    it('returns single expression without trailing comma', () => {
      const result = buildGroupByColumnList(['col1']);
      expect(result).toBe('col1');
    });
  });
});
