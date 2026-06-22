import { describe, it, expect } from 'vitest';
import {
  getClausePresenceSet,
  getValidSuccessors,
  filterByPresence,
  TRANSITION_TABLE,
  ClauseState,
  ClausePresenceSet,
} from '../../server/src/clauseStateEngine';

describe('clauseStateEngine', () => {
  // ─── 1. Transition table correctness ───────────────────────────────────────

  describe('TRANSITION_TABLE correctness', () => {
    it('WITH → [SELECT]', () => {
      expect(TRANSITION_TABLE.WITH).toEqual(['SELECT']);
    });

    it('SELECT → [FROM]', () => {
      expect(TRANSITION_TABLE.SELECT).toEqual(['FROM']);
    });

    it('FROM → includes JOIN variants, WHERE, GROUP BY, ORDER BY', () => {
      const from = TRANSITION_TABLE.FROM;
      expect(from).toContain('JOIN');
      expect(from).toContain('INNER JOIN');
      expect(from).toContain('LEFT JOIN');
      expect(from).toContain('RIGHT JOIN');
      expect(from).toContain('FULL JOIN');
      expect(from).toContain('CROSS JOIN');
      expect(from).toContain('WHERE');
      expect(from).toContain('GROUP BY');
      expect(from).toContain('ORDER BY');
    });

    it('JOIN → includes ON, JOIN variants, WHERE, GROUP BY, ORDER BY', () => {
      const join = TRANSITION_TABLE.JOIN;
      expect(join).toContain('ON');
      expect(join).toContain('JOIN');
      expect(join).toContain('INNER JOIN');
      expect(join).toContain('LEFT JOIN');
      expect(join).toContain('RIGHT JOIN');
      expect(join).toContain('FULL JOIN');
      expect(join).toContain('CROSS JOIN');
      expect(join).toContain('WHERE');
      expect(join).toContain('GROUP BY');
      expect(join).toContain('ORDER BY');
    });

    it('WHERE → [GROUP BY, ORDER BY]', () => {
      expect(TRANSITION_TABLE.WHERE).toEqual(['GROUP BY', 'ORDER BY']);
    });

    it('GROUP_BY → [HAVING, ORDER BY]', () => {
      expect(TRANSITION_TABLE.GROUP_BY).toEqual(['HAVING', 'ORDER BY']);
    });

    it('HAVING → [ORDER BY]', () => {
      expect(TRANSITION_TABLE.HAVING).toEqual(['ORDER BY']);
    });

    it('ORDER_BY → []', () => {
      expect(TRANSITION_TABLE.ORDER_BY).toEqual([]);
    });
  });

  // ─── 2. Clause presence detection ─────────────────────────────────────────

  describe('getClausePresenceSet — clause presence detection', () => {
    it('SELECT a, b FROM t WHERE x = 1 → {SELECT, FROM, WHERE}', () => {
      const sql = 'SELECT a, b FROM t WHERE x = 1';
      const result = getClausePresenceSet(sql, sql.length);
      expect(result).toEqual(new Set(['SELECT', 'FROM', 'WHERE']));
    });

    it('SELECT * FROM t INNER JOIN t2 ON t.id = t2.id → {SELECT, FROM, JOIN}', () => {
      const sql = 'SELECT * FROM t INNER JOIN t2 ON t.id = t2.id';
      const result = getClausePresenceSet(sql, sql.length);
      expect(result).toEqual(new Set(['SELECT', 'FROM', 'JOIN']));
    });

    it('SELECT a FROM t GROUP BY a HAVING COUNT(*) > 1 ORDER BY a → {SELECT, FROM, GROUP_BY, HAVING, ORDER_BY}', () => {
      const sql = 'SELECT a FROM t GROUP BY a HAVING COUNT(*) > 1 ORDER BY a';
      const result = getClausePresenceSet(sql, sql.length);
      expect(result).toEqual(new Set(['SELECT', 'FROM', 'GROUP_BY', 'HAVING', 'ORDER_BY']));
    });
  });

  // ─── 3. Keywords in noise contexts ─────────────────────────────────────────

  describe('getClausePresenceSet — keywords in noise contexts', () => {
    it("SELECT N'FROM WHERE' FROM t → {SELECT, FROM} (not WHERE)", () => {
      const sql = "SELECT N'FROM WHERE' FROM t";
      const result = getClausePresenceSet(sql, sql.length);
      expect(result).toEqual(new Set(['SELECT', 'FROM']));
      expect(result.has('WHERE')).toBe(false);
    });

    it('SELECT /* FROM WHERE */ a FROM t → {SELECT, FROM}', () => {
      const sql = 'SELECT /* FROM WHERE */ a FROM t';
      const result = getClausePresenceSet(sql, sql.length);
      expect(result).toEqual(new Set(['SELECT', 'FROM']));
      expect(result.has('WHERE')).toBe(false);
    });

    it('SELECT -- FROM WHERE\\n a FROM t → {SELECT, FROM}', () => {
      const sql = 'SELECT -- FROM WHERE\n a FROM t';
      const result = getClausePresenceSet(sql, sql.length);
      expect(result).toEqual(new Set(['SELECT', 'FROM']));
      expect(result.has('WHERE')).toBe(false);
    });
  });

  // ─── 4. Nested subqueries ─────────────────────────────────────────────────

  describe('getClausePresenceSet — nested subqueries', () => {
    it('cursor inside subquery → only inner scope keywords', () => {
      const sql = 'SELECT a FROM t WHERE x IN (SELECT b FROM s WHERE y = 1';
      // Cursor is at the end, inside the subquery
      const result = getClausePresenceSet(sql, sql.length);
      expect(result).toEqual(new Set(['SELECT', 'FROM', 'WHERE']));
      // These are the inner scope keywords, not the outer ones
    });

    it('3+ levels deep: cursor in innermost subquery', () => {
      const sql = 'SELECT a FROM t WHERE x IN (SELECT b FROM s WHERE y IN (SELECT c FROM u WHERE z = 1';
      const result = getClausePresenceSet(sql, sql.length);
      // Innermost scope: SELECT c FROM u WHERE z = 1
      expect(result).toEqual(new Set(['SELECT', 'FROM', 'WHERE']));
    });

    it('cursor outside subquery → outer scope only', () => {
      const sql = 'SELECT a FROM t WHERE x IN (SELECT b FROM s) ORDER BY a';
      const result = getClausePresenceSet(sql, sql.length);
      // Outer scope: SELECT, FROM, WHERE, ORDER_BY
      expect(result).toEqual(new Set(['SELECT', 'FROM', 'WHERE', 'ORDER_BY']));
    });
  });

  // ─── 5. Incomplete statements ─────────────────────────────────────────────

  describe('getClausePresenceSet — incomplete statements', () => {
    it('SELECT a, b FR → {SELECT} (FR is incomplete, not recognized)', () => {
      const sql = 'SELECT a, b FR';
      const result = getClausePresenceSet(sql, sql.length);
      expect(result).toEqual(new Set(['SELECT']));
      expect(result.has('FROM')).toBe(false);
    });

    it('SELECT a FROM t WH → {SELECT, FROM} (WH is incomplete)', () => {
      const sql = 'SELECT a FROM t WH';
      const result = getClausePresenceSet(sql, sql.length);
      expect(result).toEqual(new Set(['SELECT', 'FROM']));
      expect(result.has('WHERE')).toBe(false);
    });
  });

  // ─── 6. JOIN variants never filtered ───────────────────────────────────────

  describe('filterByPresence — JOIN variants never filtered', () => {
    it('filterByPresence with JOIN in presence set → JOIN variants still included', () => {
      const presenceSet: ClausePresenceSet = new Set(['SELECT', 'FROM', 'JOIN']);
      const successors = ['JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'WHERE', 'GROUP BY', 'ORDER BY'];
      const result = filterByPresence(successors, presenceSet);
      // All JOIN variants should remain
      expect(result).toContain('JOIN');
      expect(result).toContain('INNER JOIN');
      expect(result).toContain('LEFT JOIN');
      expect(result).toContain('RIGHT JOIN');
      expect(result).toContain('FULL JOIN');
      expect(result).toContain('CROSS JOIN');
      // Non-JOIN clauses should also remain (not in presence set)
      expect(result).toContain('WHERE');
      expect(result).toContain('GROUP BY');
      expect(result).toContain('ORDER BY');
    });

    it('getValidSuccessors(FROM, {JOIN}) → still includes all JOIN variants', () => {
      const presenceSet: ClausePresenceSet = new Set(['SELECT', 'FROM', 'JOIN']);
      const result = getValidSuccessors('FROM', presenceSet);
      expect(result).toContain('JOIN');
      expect(result).toContain('INNER JOIN');
      expect(result).toContain('LEFT JOIN');
      expect(result).toContain('RIGHT JOIN');
      expect(result).toContain('FULL JOIN');
      expect(result).toContain('CROSS JOIN');
    });

    it('filterByPresence removes non-JOIN clauses that are present', () => {
      const presenceSet: ClausePresenceSet = new Set(['SELECT', 'FROM', 'WHERE']);
      const successors = ['GROUP BY', 'ORDER BY', 'WHERE'];
      const result = filterByPresence(successors, presenceSet);
      expect(result).toContain('GROUP BY');
      expect(result).toContain('ORDER BY');
      expect(result).not.toContain('WHERE');
    });
  });

  // ─── 7. Multi-word keywords ────────────────────────────────────────────────

  describe('getClausePresenceSet — multi-word keywords', () => {
    it('SELECT a FROM t GROUP BY a → {SELECT, FROM, GROUP_BY}', () => {
      const sql = 'SELECT a FROM t GROUP BY a';
      const result = getClausePresenceSet(sql, sql.length);
      expect(result).toEqual(new Set(['SELECT', 'FROM', 'GROUP_BY']));
    });

    it('SELECT a FROM t ORDER BY a → {SELECT, FROM, ORDER_BY}', () => {
      const sql = 'SELECT a FROM t ORDER BY a';
      const result = getClausePresenceSet(sql, sql.length);
      expect(result).toEqual(new Set(['SELECT', 'FROM', 'ORDER_BY']));
    });

    it('SELECT a FROM t LEFT JOIN t2 ON ... → {SELECT, FROM, JOIN}', () => {
      const sql = 'SELECT a FROM t LEFT JOIN t2 ON t.id = t2.id';
      const result = getClausePresenceSet(sql, sql.length);
      expect(result).toEqual(new Set(['SELECT', 'FROM', 'JOIN']));
    });
  });

  // ─── Additional edge cases ─────────────────────────────────────────────────

  describe('getValidSuccessors', () => {
    it('returns all successors when presence set is empty', () => {
      const presenceSet: ClausePresenceSet = new Set();
      const result = getValidSuccessors('FROM', presenceSet);
      expect(result).toEqual([...TRANSITION_TABLE.FROM]);
    });

    it('ORDER_BY has no successors', () => {
      const presenceSet: ClausePresenceSet = new Set();
      const result = getValidSuccessors('ORDER_BY', presenceSet);
      expect(result).toEqual([]);
    });

    it('WHERE with GROUP_BY already present → only ORDER BY', () => {
      const presenceSet: ClausePresenceSet = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP_BY']);
      const result = getValidSuccessors('WHERE', presenceSet);
      expect(result).not.toContain('GROUP BY');
      expect(result).toContain('ORDER BY');
    });

    it('GROUP_BY with HAVING already present → only ORDER BY', () => {
      const presenceSet: ClausePresenceSet = new Set(['SELECT', 'FROM', 'GROUP_BY', 'HAVING']);
      const result = getValidSuccessors('GROUP_BY', presenceSet);
      expect(result).not.toContain('HAVING');
      expect(result).toContain('ORDER BY');
    });
  });
});
