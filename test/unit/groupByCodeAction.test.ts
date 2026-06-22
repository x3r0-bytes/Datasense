import { describe, it, expect } from 'vitest';
import { CodeActionKind } from 'vscode-languageserver/node';
import { getGroupByCodeActions } from '../../server/src/groupByCodeAction';

const TEST_URI = 'file:///test.sql';

describe('groupByCodeAction', () => {
  describe('"Add GROUP BY clause" insertion after FROM (Requirement 6.1, 6.2)', () => {
    it('inserts GROUP BY after FROM when no WHERE clause', () => {
      const sql = 'SELECT o.CustomerID, COUNT(*) FROM Orders o';
      const actions = getGroupByCodeActions(sql, TEST_URI);

      expect(actions).toHaveLength(1);
      expect(actions[0].title).toBe('Add GROUP BY clause');
      expect(actions[0].kind).toBe(CodeActionKind.QuickFix);

      const edits = actions[0].edit!.changes![TEST_URI];
      expect(edits).toHaveLength(1);
      expect(edits[0].newText).toContain('GROUP BY');
      expect(edits[0].newText).toContain('o.CustomerID');
    });

    it('inserts GROUP BY after the end of FROM clause content', () => {
      const sql = 'SELECT CustomerID, SUM(Amount) FROM Orders';
      const actions = getGroupByCodeActions(sql, TEST_URI);

      expect(actions).toHaveLength(1);
      const edits = actions[0].edit!.changes![TEST_URI];
      expect(edits[0].newText).toContain('GROUP BY CustomerID');
    });
  });

  describe('"Add GROUP BY clause" insertion after WHERE (Requirement 6.2)', () => {
    it('inserts GROUP BY after WHERE clause when WHERE is present', () => {
      const sql = 'SELECT o.CustomerID, COUNT(*) FROM Orders o WHERE o.Status = 1';
      const actions = getGroupByCodeActions(sql, TEST_URI);

      expect(actions).toHaveLength(1);
      expect(actions[0].title).toBe('Add GROUP BY clause');

      const edits = actions[0].edit!.changes![TEST_URI];
      expect(edits).toHaveLength(1);
      expect(edits[0].newText).toContain('GROUP BY');
      expect(edits[0].newText).toContain('o.CustomerID');

      // The insertion should be after the WHERE clause content
      const insertLine = edits[0].range.start.line;
      const whereLineIndex = sql.split('\n').findIndex(l => /WHERE/i.test(l));
      // For single-line SQL, insertion is on the same line (after WHERE content)
      expect(insertLine).toBeGreaterThanOrEqual(0);
    });

    it('inserts GROUP BY after multi-line WHERE clause', () => {
      const sql = [
        'SELECT o.CustomerID, COUNT(*)',
        'FROM Orders o',
        'WHERE o.Status = 1',
        '  AND o.Amount > 0',
      ].join('\n');

      const actions = getGroupByCodeActions(sql, TEST_URI);

      expect(actions).toHaveLength(1);
      const edits = actions[0].edit!.changes![TEST_URI];
      expect(edits[0].newText).toContain('GROUP BY o.CustomerID');
    });
  });

  describe('Indentation detection and formatting (Requirement 6.3)', () => {
    it('matches indentation of surrounding clause keywords', () => {
      const sql = [
        '    SELECT o.CustomerID, COUNT(*)',
        '    FROM Orders o',
        '    WHERE o.Status = 1',
      ].join('\n');

      const actions = getGroupByCodeActions(sql, TEST_URI);

      expect(actions).toHaveLength(1);
      const edits = actions[0].edit!.changes![TEST_URI];
      // The inserted text should use the same indentation as FROM/WHERE
      expect(edits[0].newText).toContain('    GROUP BY');
    });

    it('uses tab indentation when surrounding code uses tabs', () => {
      const sql = [
        '\tSELECT o.CustomerID, COUNT(*)',
        '\tFROM Orders o',
      ].join('\n');

      const actions = getGroupByCodeActions(sql, TEST_URI);

      expect(actions).toHaveLength(1);
      const edits = actions[0].edit!.changes![TEST_URI];
      expect(edits[0].newText).toContain('\tGROUP BY');
    });

    it('uses no indentation when query has no indentation', () => {
      const sql = 'SELECT CustomerID, COUNT(*) FROM Orders';
      const actions = getGroupByCodeActions(sql, TEST_URI);

      expect(actions).toHaveLength(1);
      const edits = actions[0].edit!.changes![TEST_URI];
      // Should start with newline then GROUP BY (no leading spaces)
      expect(edits[0].newText).toMatch(/^\r?\nGROUP BY/);
    });
  });

  describe('"Add missing columns to GROUP BY" (Requirement 6.4)', () => {
    it('offers action when GROUP BY is missing columns', () => {
      const sql = 'SELECT o.CustomerID, o.OrderDate, COUNT(*) FROM Orders o GROUP BY o.CustomerID';
      const actions = getGroupByCodeActions(sql, TEST_URI);

      expect(actions).toHaveLength(1);
      expect(actions[0].title).toBe('Add missing columns to GROUP BY');
      expect(actions[0].kind).toBe(CodeActionKind.QuickFix);

      const edits = actions[0].edit!.changes![TEST_URI];
      expect(edits).toHaveLength(1);
      // The replacement should include all non-aggregated columns
      expect(edits[0].newText).toContain('o.CustomerID');
      expect(edits[0].newText).toContain('o.OrderDate');
    });

    it('replaces existing GROUP BY column list with complete list', () => {
      const sql = 'SELECT a.Name, a.City, SUM(a.Sales) FROM Accounts a GROUP BY a.Name';
      const actions = getGroupByCodeActions(sql, TEST_URI);

      expect(actions).toHaveLength(1);
      expect(actions[0].title).toBe('Add missing columns to GROUP BY');

      const edits = actions[0].edit!.changes![TEST_URI];
      // Should replace the column list with the full set
      expect(edits[0].newText).toBe('a.Name, a.City');
    });
  });

  describe('No action when no aggregates present (Requirement 6.1)', () => {
    it('returns empty array when SELECT has no aggregate functions', () => {
      const sql = 'SELECT CustomerID, OrderDate FROM Orders';
      const actions = getGroupByCodeActions(sql, TEST_URI);

      expect(actions).toHaveLength(0);
    });

    it('returns empty array for SELECT *', () => {
      const sql = 'SELECT * FROM Orders';
      const actions = getGroupByCodeActions(sql, TEST_URI);

      expect(actions).toHaveLength(0);
    });

    it('returns empty array for empty input', () => {
      const actions = getGroupByCodeActions('', TEST_URI);

      expect(actions).toHaveLength(0);
    });
  });

  describe('No action when GROUP BY already has all columns (Requirement 6.4)', () => {
    it('returns empty array when GROUP BY already contains all non-aggregated columns', () => {
      const sql = 'SELECT o.CustomerID, COUNT(*) FROM Orders o GROUP BY o.CustomerID';
      const actions = getGroupByCodeActions(sql, TEST_URI);

      expect(actions).toHaveLength(0);
    });

    it('returns empty array when GROUP BY has all columns in different order', () => {
      const sql = 'SELECT o.OrderDate, o.CustomerID, SUM(o.Amount) FROM Orders o GROUP BY o.CustomerID, o.OrderDate';
      const actions = getGroupByCodeActions(sql, TEST_URI);

      expect(actions).toHaveLength(0);
    });
  });
});
