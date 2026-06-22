import { describe, it, expect } from 'vitest';
import { CompletionItemKind } from 'vscode-languageserver/node';
import { getGroupByCompletion, CompletionContext } from '../../server/src/completionProvider';

describe('getGroupByCompletion', () => {
  describe('Basic case: SELECT with aggregate + non-aggregated column (Requirement 5.1)', () => {
    it('offers GROUP BY col1 when SELECT has col1 and COUNT(*)', () => {
      const sql = 'SELECT col1, COUNT(*) FROM t';
      const context: CompletionContext = 'FROM';
      const result = getGroupByCompletion(sql, context);

      expect(result).not.toBeNull();
      expect(result!.label).toBe('GROUP BY col1');
      expect(result!.insertText).toBe('GROUP BY col1');
      expect(result!.kind).toBe(CompletionItemKind.Snippet);
      expect(result!.detail).toBe('Add GROUP BY for non-aggregated columns');
    });

    it('offers GROUP BY with multiple non-aggregated columns', () => {
      const sql = 'SELECT col1, col2, SUM(col3) FROM t';
      const context: CompletionContext = 'FROM';
      const result = getGroupByCompletion(sql, context);

      expect(result).not.toBeNull();
      expect(result!.label).toBe('GROUP BY col1, col2');
      expect(result!.insertText).toBe('GROUP BY col1, col2');
    });
  });

  describe('With aliases: preserves table alias qualification (Requirement 5.5)', () => {
    it('offers GROUP BY o.CustomerID when SELECT uses alias-qualified columns', () => {
      const sql = 'SELECT o.CustomerID, SUM(o.Amount) FROM Orders o';
      const context: CompletionContext = 'FROM';
      const result = getGroupByCompletion(sql, context);

      expect(result).not.toBeNull();
      expect(result!.label).toBe('GROUP BY o.CustomerID');
      expect(result!.insertText).toBe('GROUP BY o.CustomerID');
    });

    it('offers GROUP BY with multiple alias-qualified columns from different tables', () => {
      const sql = 'SELECT o.CustomerID, p.Name, SUM(o.Amount) FROM Orders o JOIN Products p ON o.ProductID = p.ID';
      const context: CompletionContext = 'FROM';
      const result = getGroupByCompletion(sql, context);

      expect(result).not.toBeNull();
      expect(result!.label).toBe('GROUP BY o.CustomerID, p.Name');
      expect(result!.insertText).toBe('GROUP BY o.CustomerID, p.Name');
    });
  });

  describe('Suppression: GROUP BY already present (Requirement 5.4)', () => {
    it('returns null when GROUP BY already exists in the statement', () => {
      const sql = 'SELECT col1, COUNT(*) FROM t GROUP BY col1';
      const context: CompletionContext = 'GROUP_BY';
      const result = getGroupByCompletion(sql, context);

      expect(result).toBeNull();
    });

    it('returns null when GROUP BY exists (case-insensitive)', () => {
      const sql = 'SELECT col1, COUNT(*) FROM t group by col1';
      const context: CompletionContext = 'GROUP_BY';
      const result = getGroupByCompletion(sql, context);

      expect(result).toBeNull();
    });
  });

  describe('Prefix matching: sortText starts with 0_ (Requirement 5.3)', () => {
    it('ranks the suggestion at top with sortText starting with 0_', () => {
      const sql = 'SELECT col1, COUNT(*) FROM t';
      const context: CompletionContext = 'FROM';
      const result = getGroupByCompletion(sql, context);

      expect(result).not.toBeNull();
      expect(result!.sortText).toBeDefined();
      expect(result!.sortText!.startsWith('0_')).toBe(true);
    });

    it('sortText is 0_group by for consistent ranking', () => {
      const sql = 'SELECT col1, COUNT(*) FROM t';
      const context: CompletionContext = 'NONE';
      const result = getGroupByCompletion(sql, context);

      expect(result).not.toBeNull();
      expect(result!.sortText).toBe('0_group by');
    });
  });

  describe('No aggregates: no GROUP BY offered (Requirement 4.5, 5.1)', () => {
    it('returns null when SELECT has no aggregate functions', () => {
      const sql = 'SELECT col1, col2 FROM t';
      const context: CompletionContext = 'FROM';
      const result = getGroupByCompletion(sql, context);

      expect(result).toBeNull();
    });

    it('returns null when SELECT has only aggregates (no non-aggregated columns)', () => {
      const sql = 'SELECT COUNT(*), SUM(Amount) FROM Orders';
      const context: CompletionContext = 'FROM';
      const result = getGroupByCompletion(sql, context);

      expect(result).toBeNull();
    });
  });

  describe('Context suppression: invalid contexts return null', () => {
    it('returns null when context is SELECT', () => {
      const sql = 'SELECT col1, COUNT(*) FROM t';
      const result = getGroupByCompletion(sql, 'SELECT');

      expect(result).toBeNull();
    });

    it('returns null when context is EXEC', () => {
      const sql = 'SELECT col1, COUNT(*) FROM t';
      const result = getGroupByCompletion(sql, 'EXEC');

      expect(result).toBeNull();
    });

    it('returns null when context is CTE', () => {
      const sql = 'SELECT col1, COUNT(*) FROM t';
      const result = getGroupByCompletion(sql, 'CTE');

      expect(result).toBeNull();
    });

    it('returns null when context is UPDATE', () => {
      const sql = 'SELECT col1, COUNT(*) FROM t';
      const result = getGroupByCompletion(sql, 'UPDATE');

      expect(result).toBeNull();
    });

    it('returns null when context is DECLARE', () => {
      const sql = 'SELECT col1, COUNT(*) FROM t';
      const result = getGroupByCompletion(sql, 'DECLARE');

      expect(result).toBeNull();
    });
  });

  describe('Valid contexts: completion offered in appropriate contexts', () => {
    it('offers completion when context is WHERE', () => {
      const sql = 'SELECT col1, COUNT(*) FROM t WHERE col1 > 0';
      const context: CompletionContext = 'WHERE';
      const result = getGroupByCompletion(sql, context);

      expect(result).not.toBeNull();
      expect(result!.insertText).toBe('GROUP BY col1');
    });

    it('offers completion when context is NONE', () => {
      const sql = 'SELECT col1, COUNT(*) FROM t';
      const context: CompletionContext = 'NONE';
      const result = getGroupByCompletion(sql, context);

      expect(result).not.toBeNull();
      expect(result!.insertText).toBe('GROUP BY col1');
    });

    it('offers completion when context is JOIN', () => {
      const sql = 'SELECT o.CustomerID, SUM(o.Amount) FROM Orders o JOIN Customers c ON o.CustomerID = c.ID';
      const context: CompletionContext = 'JOIN';
      const result = getGroupByCompletion(sql, context);

      expect(result).not.toBeNull();
      expect(result!.insertText).toBe('GROUP BY o.CustomerID');
    });
  });
});
