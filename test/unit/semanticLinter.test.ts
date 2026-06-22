import { describe, it, expect } from 'vitest';
import { semanticLint } from '../../server/src/semanticLinter';

/**
 * Semantic Linter Tests — E002: SELECT * with GROUP BY
 * 
 * Validates the fix for COUNT(*) false positives.
 * The linter should NOT flag COUNT(*), SUM(*), or other aggregate functions
 * as "SELECT *" usage. It should only flag actual bare * in the SELECT list.
 */

describe('semanticLinter', () => {
  describe('E002: SELECT * with GROUP BY', () => {
    // ─── Should NOT flag (no false positives) ───────────────────────────────

    it('should NOT flag COUNT(*) with GROUP BY', () => {
      const sql = `SELECT Category, COUNT(*) FROM Products GROUP BY Category`;
      const diagnostics = semanticLint(sql);
      const e002 = diagnostics.filter(d => d.code === 'E002');
      expect(e002).toHaveLength(0);
    });

    it('should NOT flag COUNT(*) with alias and GROUP BY', () => {
      const sql = `SELECT Department, COUNT(*) AS TotalEmployees FROM Employees GROUP BY Department`;
      const diagnostics = semanticLint(sql);
      const e002 = diagnostics.filter(d => d.code === 'E002');
      expect(e002).toHaveLength(0);
    });

    it('should NOT flag multiple aggregates with GROUP BY', () => {
      const sql = `SELECT Category, COUNT(*), SUM(Price), AVG(Quantity) FROM Products GROUP BY Category`;
      const diagnostics = semanticLint(sql);
      const e002 = diagnostics.filter(d => d.code === 'E002');
      expect(e002).toHaveLength(0);
    });

    it('should NOT flag COUNT(*) in HAVING clause with GROUP BY', () => {
      const sql = `SELECT Category, COUNT(*) AS Cnt FROM Products GROUP BY Category HAVING COUNT(*) > 5`;
      const diagnostics = semanticLint(sql);
      const e002 = diagnostics.filter(d => d.code === 'E002');
      expect(e002).toHaveLength(0);
    });

    it('should NOT flag table.* (qualified star) with GROUP BY', () => {
      const sql = `SELECT p.* FROM Products p GROUP BY p.Category`;
      const diagnostics = semanticLint(sql);
      const e002 = diagnostics.filter(d => d.code === 'E002');
      expect(e002).toHaveLength(0);
    });

    it('should NOT flag COUNT(*) without GROUP BY (not an E002 scenario)', () => {
      const sql = `SELECT COUNT(*) FROM Products`;
      const diagnostics = semanticLint(sql);
      const e002 = diagnostics.filter(d => d.code === 'E002');
      expect(e002).toHaveLength(0);
    });

    it('should NOT flag nested COUNT(*) in CASE with GROUP BY', () => {
      const sql = `SELECT Category, CASE WHEN COUNT(*) > 10 THEN 'High' ELSE 'Low' END AS Volume FROM Products GROUP BY Category`;
      const diagnostics = semanticLint(sql);
      const e002 = diagnostics.filter(d => d.code === 'E002');
      expect(e002).toHaveLength(0);
    });

    it('should NOT flag SUM(*) with GROUP BY', () => {
      const sql = `SELECT Region, SUM(*) FROM Sales GROUP BY Region`;
      const diagnostics = semanticLint(sql);
      const e002 = diagnostics.filter(d => d.code === 'E002');
      expect(e002).toHaveLength(0);
    });

    // ─── Should flag (true positives) ───────────────────────────────────────

    it('should flag bare * with GROUP BY', () => {
      const sql = `SELECT * FROM Products GROUP BY Category`;
      const diagnostics = semanticLint(sql);
      const e002 = diagnostics.filter(d => d.code === 'E002');
      expect(e002).toHaveLength(1);
      expect(e002[0].message).toContain('SELECT *');
    });

    it('should flag bare * with DISTINCT and GROUP BY', () => {
      const sql = `SELECT DISTINCT * FROM Products GROUP BY Category`;
      const diagnostics = semanticLint(sql);
      const e002 = diagnostics.filter(d => d.code === 'E002');
      expect(e002).toHaveLength(1);
    });

    it('should flag bare * with TOP and GROUP BY', () => {
      const sql = `SELECT TOP 10 * FROM Products GROUP BY Category`;
      const diagnostics = semanticLint(sql);
      const e002 = diagnostics.filter(d => d.code === 'E002');
      expect(e002).toHaveLength(1);
    });

    // ─── Edge cases ─────────────────────────────────────────────────────────

    it('should NOT flag SELECT * without GROUP BY', () => {
      const sql = `SELECT * FROM Products`;
      const diagnostics = semanticLint(sql);
      const e002 = diagnostics.filter(d => d.code === 'E002');
      expect(e002).toHaveLength(0);
    });

    it('should NOT flag multiplication operator with GROUP BY', () => {
      const sql = `SELECT Category, Price * Quantity AS Total FROM Products GROUP BY Category, Price, Quantity`;
      const diagnostics = semanticLint(sql);
      const e002 = diagnostics.filter(d => d.code === 'E002');
      expect(e002).toHaveLength(0);
    });

    it('should flag bare * mixed with COUNT(*) and GROUP BY', () => {
      // This is invalid SQL but the linter should still detect the bare *
      const sql = `SELECT *, COUNT(*) FROM Products GROUP BY Category`;
      const diagnostics = semanticLint(sql);
      const e002 = diagnostics.filter(d => d.code === 'E002');
      expect(e002).toHaveLength(1);
    });
  });
});

  // ─── E010: BEGIN/END with CASE expressions ──────────────────────────────────

  describe('E010: BEGIN/END mismatch — CASE...END handling', () => {
    it('should NOT flag CASE...END as a missing BEGIN block', () => {
      const sql = `SELECT CASE WHEN Status = 1 THEN 'Active' ELSE 'Inactive' END AS StatusText FROM Users`;
      const diagnostics = semanticLint(sql);
      const e010 = diagnostics.filter(d => d.code === 'E010');
      expect(e010).toHaveLength(0);
    });

    it('should NOT flag CASE...END in a SELECT column list', () => {
      const sql = `
SELECT DISTINCT
  [cf].[FacilityCode] AS [FacilityCode],
  CASE
    WHEN [Landlord] = 'Ensign' THEN 'SBHI'
    ELSE LEFT([Landlord], 64)
  END AS [Landlord],
  [al].[City] AS [FacilityCity]
FROM [Workflow].[vwConsolidatedFacilities] [cf]
      `.trim();
      const diagnostics = semanticLint(sql);
      const e010 = diagnostics.filter(d => d.code === 'E010');
      expect(e010).toHaveLength(0);
    });

    it('should NOT flag multiple CASE...END expressions in the same query', () => {
      const sql = `
SELECT
  CASE WHEN a = 1 THEN 'X' ELSE 'Y' END AS Col1,
  CASE WHEN b = 2 THEN 'A' ELSE 'B' END AS Col2
FROM MyTable
      `.trim();
      const diagnostics = semanticLint(sql);
      const e010 = diagnostics.filter(d => d.code === 'E010');
      expect(e010).toHaveLength(0);
    });

    it('should NOT flag nested CASE...END expressions', () => {
      const sql = `
SELECT
  CASE
    WHEN Status = 1 THEN
      CASE WHEN SubStatus = 'A' THEN 'Active-A' ELSE 'Active-B' END
    ELSE 'Inactive'
  END AS StatusDetail
FROM Users
      `.trim();
      const diagnostics = semanticLint(sql);
      const e010 = diagnostics.filter(d => d.code === 'E010');
      expect(e010).toHaveLength(0);
    });

    it('should NOT flag CASE...END inside a BEGIN...END block', () => {
      const sql = `
BEGIN
  SELECT CASE WHEN x = 1 THEN 'Yes' ELSE 'No' END AS Answer FROM T
END
      `.trim();
      const diagnostics = semanticLint(sql);
      const e010 = diagnostics.filter(d => d.code === 'E010');
      expect(e010).toHaveLength(0);
    });

    it('should still flag a genuine unmatched END (no BEGIN or CASE)', () => {
      const sql = `SELECT 1\nEND`;
      const diagnostics = semanticLint(sql);
      const e010 = diagnostics.filter(d => d.code === 'E010');
      expect(e010).toHaveLength(1);
      expect(e010[0].message).toContain("Unexpected 'END'");
    });

    it('should still flag a genuine unmatched BEGIN (no END)', () => {
      const sql = `BEGIN\nSELECT 1`;
      const diagnostics = semanticLint(sql);
      const e010 = diagnostics.filter(d => d.code === 'E010');
      expect(e010).toHaveLength(1);
      expect(e010[0].message).toContain('Unclosed BEGIN');
    });

    it('should correctly handle CASE...END alongside BEGIN...END', () => {
      const sql = `
BEGIN
  DECLARE @x INT = CASE WHEN 1=1 THEN 1 ELSE 0 END
  SELECT @x
END
      `.trim();
      const diagnostics = semanticLint(sql);
      const e010 = diagnostics.filter(d => d.code === 'E010');
      expect(e010).toHaveLength(0);
    });
  });
