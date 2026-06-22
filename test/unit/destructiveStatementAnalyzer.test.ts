import { describe, it, expect } from 'vitest';
import { stripCommentsAndStrings, parseStatements, classifyStatement, hasTopLevelWhere, analyze } from '../../src/destructiveStatementAnalyzer';

describe('stripCommentsAndStrings', () => {
  describe('single-line comments', () => {
    it('should replace -- comment with spaces of same length', () => {
      const input = 'SELECT 1 -- this is a comment';
      const result = stripCommentsAndStrings(input);
      expect(result.length).toBe(input.length);
      // Only 'SELECT 1 ' should remain, rest is spaces
      expect(result.substring(0, 9)).toBe('SELECT 1 ');
      expect(result.substring(9).trim()).toBe('');
    });

    it('should preserve newline after single-line comment', () => {
      const input = 'SELECT 1 -- comment\nSELECT 2';
      const result = stripCommentsAndStrings(input);
      expect(result.length).toBe(input.length);
      expect(result).toBe('SELECT 1           \nSELECT 2');
    });
  });

  describe('block comments', () => {
    it('should replace /* comment */ with spaces of same length', () => {
      const input = 'SELECT /* comment */ 1';
      const result = stripCommentsAndStrings(input);
      expect(result.length).toBe(input.length);
      // 'SELECT ' prefix and ' 1' suffix should remain, comment area is spaces
      expect(result.startsWith('SELECT ')).toBe(true);
      expect(result.endsWith(' 1')).toBe(true);
      // The comment portion (between SELECT and 1) should be only spaces
      const commentArea = result.substring(7, result.length - 2);
      expect(commentArea.trim()).toBe('');
    });

    it('should handle nested block comments', () => {
      const input = '/* outer /* inner */ still comment */SELECT 1';
      const result = stripCommentsAndStrings(input);
      expect(result.length).toBe(input.length);
      // Everything inside the outermost /* ... */ should be replaced
      expect(result.startsWith('SELECT 1')).toBe(false);
      // The SELECT 1 at end should remain
      expect(result.endsWith('SELECT 1')).toBe(true);
      // All of the comment should be spaces
      const commentPortion = result.substring(0, input.indexOf('SELECT 1'));
      expect(commentPortion.trim()).toBe('');
    });

    it('should preserve newlines within block comments', () => {
      const input = '/* line1\nline2\nline3 */SELECT 1';
      const result = stripCommentsAndStrings(input);
      expect(result.length).toBe(input.length);
      // Newlines should be preserved
      expect(result.indexOf('\n')).toBe(input.indexOf('\n'));
      const lines = result.split('\n');
      expect(lines.length).toBe(3);
    });
  });

  describe('unclosed block comment', () => {
    it('should treat all text from /* to end as comment when no closing */', () => {
      const input = 'SELECT 1 /* unclosed block comment DELETE FROM t';
      const result = stripCommentsAndStrings(input);
      expect(result.length).toBe(input.length);
      // Text before /* remains, everything after is spaces
      expect(result.startsWith('SELECT 1 ')).toBe(true);
      const afterComment = result.substring('SELECT 1 '.length);
      expect(afterComment.trim()).toBe('');
    });
  });

  describe('string literals', () => {
    it('should replace string literal with spaces of same length', () => {
      const input = "SELECT 'hello' AS greeting";
      const result = stripCommentsAndStrings(input);
      expect(result.length).toBe(input.length);
      expect(result).toBe('SELECT         AS greeting');
    });

    it('should handle escaped quotes within string literals', () => {
      const input = "SELECT 'it''s' AS val";
      const result = stripCommentsAndStrings(input);
      expect(result.length).toBe(input.length);
      // 'it''s' is 6 chars (quote, i, t, quote, quote, s, quote) = 7 chars total including delimiters
      // Everything from opening ' to closing ' should be spaces
      expect(result.startsWith('SELECT ')).toBe(true);
      expect(result.endsWith(' AS val')).toBe(true);
      const stringArea = result.substring(7, result.length - 7);
      expect(stringArea.trim()).toBe('');
    });

    it('should preserve newlines within string literals', () => {
      const input = "SELECT 'line1\nline2' AS val";
      const result = stripCommentsAndStrings(input);
      expect(result.length).toBe(input.length);
      const lines = result.split('\n');
      expect(lines.length).toBe(2);
    });
  });

  describe('unclosed string literal', () => {
    it('should treat all text from opening quote to end as string when no closing quote', () => {
      const input = "SELECT 'unclosed string DELETE FROM t";
      const result = stripCommentsAndStrings(input);
      expect(result.length).toBe(input.length);
      // Text before the quote remains
      expect(result.startsWith('SELECT ')).toBe(true);
      const afterQuote = result.substring('SELECT '.length);
      expect(afterQuote.trim()).toBe('');
    });
  });

  describe('line position preservation', () => {
    it('should produce output of same length as input for all types', () => {
      const inputs = [
        '-- comment',
        '/* block */',
        "'string'",
        "/* multi\nline */",
        "'multi\nline'",
        'no comments or strings',
        '/* unclosed',
        "'unclosed",
      ];

      for (const input of inputs) {
        const result = stripCommentsAndStrings(input);
        expect(result.length).toBe(input.length);
      }
    });

    it('should preserve newlines in all cases so line numbers stay aligned', () => {
      const input = "SELECT 1\n-- comment\n/* block\ncomment */\nSELECT 'val\nue'";
      const result = stripCommentsAndStrings(input);
      expect(result.length).toBe(input.length);
      // Same number of lines
      expect(result.split('\n').length).toBe(input.split('\n').length);
    });
  });

  describe('mixed SQL with comments and strings', () => {
    it('should strip only comments and strings, leaving executable SQL intact', () => {
      const input = "UPDATE t SET col = 'value' -- set the value\nFROM Table t WHERE t.id = 1";
      const result = stripCommentsAndStrings(input);
      expect(result.length).toBe(input.length);
      // The UPDATE, SET, FROM, WHERE keywords should remain visible
      expect(result).toContain('UPDATE');
      expect(result).toContain('SET');
      expect(result).toContain('FROM');
      expect(result).toContain('WHERE');
      // The string 'value' and comment should be gone
      expect(result).not.toContain('value');
      expect(result).not.toContain('set the');
    });
  });

  describe('destructive keywords inside comments and strings are hidden', () => {
    it('should hide DELETE keyword inside a single-line comment', () => {
      const input = 'SELECT 1 -- DELETE FROM Table';
      const result = stripCommentsAndStrings(input);
      expect(result).not.toContain('DELETE');
    });

    it('should hide DROP TABLE keyword inside a block comment', () => {
      const input = 'SELECT 1 /* DROP TABLE MyTable */';
      const result = stripCommentsAndStrings(input);
      expect(result).not.toContain('DROP');
      expect(result).not.toContain('TABLE');
    });

    it('should hide TRUNCATE TABLE keyword inside a string literal', () => {
      const input = "SELECT 'TRUNCATE TABLE foo' AS cmd";
      const result = stripCommentsAndStrings(input);
      expect(result).not.toContain('TRUNCATE');
      // 'TABLE' appears outside the string in this context, let's use a better check
      expect(result).not.toContain('TRUNCATE TABLE');
    });

    it('should hide UPDATE keyword inside a nested block comment', () => {
      const input = 'SELECT 1 /* outer /* UPDATE t SET x = 1 */ end */';
      const result = stripCommentsAndStrings(input);
      expect(result).not.toContain('UPDATE');
    });
  });
});

describe('parseStatements', () => {
  describe('semicolon splitting', () => {
    it('should treat a single statement without semicolon as implicit end-of-batch', () => {
      const input = 'SELECT 1';
      const result = parseStatements(input);
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('SELECT 1');
      expect(result[0].startLine).toBe(0);
    });

    it('should split two statements separated by a semicolon', () => {
      const input = 'SELECT 1;SELECT 2';
      const result = parseStatements(input);
      expect(result).toHaveLength(2);
      expect(result[0].text).toBe('SELECT 1');
      expect(result[0].startLine).toBe(0);
      expect(result[1].text).toBe('SELECT 2');
      expect(result[1].startLine).toBe(0);
    });

    it('should track start line for multi-line statements', () => {
      const input = 'SELECT 1;\nSELECT 2;\nSELECT 3';
      const result = parseStatements(input);
      expect(result).toHaveLength(3);
      expect(result[0].startLine).toBe(0);
      expect(result[1].startLine).toBe(1);
      expect(result[2].startLine).toBe(2);
    });

    it('should handle final statement without trailing semicolon', () => {
      const input = 'SELECT 1;\nSELECT 2';
      const result = parseStatements(input);
      expect(result).toHaveLength(2);
      expect(result[0].text).toBe('SELECT 1');
      expect(result[1].text).toBe('\nSELECT 2');
      expect(result[1].startLine).toBe(1);
    });
  });

  describe('GO batch separators', () => {
    it('should split on a standalone GO line', () => {
      const input = 'SELECT 1\nGO\nSELECT 2';
      const result = parseStatements(input);
      expect(result).toHaveLength(2);
      expect(result[0].text).toBe('SELECT 1');
      expect(result[0].startLine).toBe(0);
      expect(result[1].text).toBe('SELECT 2');
      expect(result[1].startLine).toBe(2);
    });

    it('should handle GO case-insensitively (go, Go, gO)', () => {
      const variations = ['go', 'Go', 'gO', 'GO'];
      for (const goVariant of variations) {
        const input = `SELECT 1\n${goVariant}\nSELECT 2`;
        const result = parseStatements(input);
        expect(result).toHaveLength(2);
        expect(result[0].text).toBe('SELECT 1');
        expect(result[1].text).toBe('SELECT 2');
      }
    });

    it('should handle GO with leading/trailing whitespace on the line', () => {
      const input = 'SELECT 1\n  GO  \nSELECT 2';
      const result = parseStatements(input);
      expect(result).toHaveLength(2);
      expect(result[0].text).toBe('SELECT 1');
      expect(result[0].startLine).toBe(0);
      expect(result[1].text).toBe('SELECT 2');
      expect(result[1].startLine).toBe(2);
    });

    it('should NOT treat GO inside a longer word as a separator', () => {
      const input = 'SELECT GOPHER FROM animals';
      const result = parseStatements(input);
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('SELECT GOPHER FROM animals');
    });
  });

  describe('skip empty and whitespace-only segments', () => {
    it('should skip empty segments between semicolons (e.g., ;;)', () => {
      const input = 'SELECT 1;;SELECT 2';
      const result = parseStatements(input);
      expect(result).toHaveLength(2);
      expect(result[0].text).toBe('SELECT 1');
      expect(result[1].text).toBe('SELECT 2');
    });

    it('should skip whitespace-only segments', () => {
      const input = 'SELECT 1;   ;SELECT 2';
      const result = parseStatements(input);
      expect(result).toHaveLength(2);
      expect(result[0].text).toBe('SELECT 1');
      expect(result[1].text).toBe('SELECT 2');
    });

    it('should return empty array for empty input', () => {
      const result = parseStatements('');
      expect(result).toHaveLength(0);
    });

    it('should return empty array for whitespace-only input', () => {
      const result = parseStatements('   \n  \n  ');
      expect(result).toHaveLength(0);
    });

    it('should skip empty batch after GO at end of input', () => {
      const input = 'SELECT 1\nGO';
      const result = parseStatements(input);
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('SELECT 1');
    });
  });

  describe('mixed semicolons and GO', () => {
    it('should handle batches with semicolons and GO separators', () => {
      const input = 'SELECT 1;SELECT 2\nGO\nSELECT 3;SELECT 4';
      const result = parseStatements(input);
      expect(result).toHaveLength(4);
      expect(result[0].startLine).toBe(0);
      expect(result[1].startLine).toBe(0);
      expect(result[2].startLine).toBe(2);
      expect(result[3].startLine).toBe(2);
    });

    it('should correctly track lines across multiple GO batches with semicolons', () => {
      const input = 'INSERT INTO t VALUES(1);\nINSERT INTO t VALUES(2)\nGO\nDELETE FROM t;\nUPDATE t SET x = 1';
      const result = parseStatements(input);
      expect(result).toHaveLength(4);
      expect(result[0].startLine).toBe(0);
      expect(result[1].startLine).toBe(1);
      expect(result[2].startLine).toBe(3);
      expect(result[3].startLine).toBe(4);
    });
  });

  describe('0-based start line tracking', () => {
    it('should track correct start line for multi-line statements', () => {
      const input = 'UPDATE t\nSET col = 1\nFROM Table t;\nDELETE FROM foo';
      const result = parseStatements(input);
      expect(result).toHaveLength(2);
      expect(result[0].startLine).toBe(0);
      expect(result[1].startLine).toBe(3);
    });

    it('should track correct start lines with GO batches', () => {
      const input = 'SELECT 1\nGO\nUPDATE t\nSET x = 1\nGO\nDELETE FROM foo';
      const result = parseStatements(input);
      expect(result).toHaveLength(3);
      expect(result[0].startLine).toBe(0);
      expect(result[1].startLine).toBe(2);
      expect(result[2].startLine).toBe(5);
    });

    it('should use line of first non-whitespace content for multi-line statements', () => {
      // Segment starts with blank lines before actual content
      const input = 'SELECT 1;\n\n\nSELECT 2';
      const result = parseStatements(input);
      expect(result).toHaveLength(2);
      expect(result[0].startLine).toBe(0);
      // The second statement's first non-whitespace is on line 3
      expect(result[1].startLine).toBe(3);
    });

    it('should handle segment starting with blank lines in a GO batch', () => {
      const input = 'SELECT 1\nGO\n\n\nSELECT 2';
      const result = parseStatements(input);
      expect(result).toHaveLength(2);
      expect(result[0].startLine).toBe(0);
      // After GO on line 1, batch starts at line 2. Lines 2-3 are blank, content starts on line 4
      expect(result[1].startLine).toBe(4);
    });

    it('should handle statement with leading whitespace on same line', () => {
      const input = '  SELECT 1;\n  SELECT 2';
      const result = parseStatements(input);
      expect(result).toHaveLength(2);
      expect(result[0].startLine).toBe(0);
      expect(result[1].startLine).toBe(1);
    });
  });
});


describe('hasTopLevelWhere', () => {
  it('should return true for simple SELECT with WHERE', () => {
    expect(hasTopLevelWhere('SELECT * FROM t WHERE id = 1')).toBe(true);
  });

  it('should return true for UPDATE with top-level WHERE after FROM clause', () => {
    expect(hasTopLevelWhere('UPDATE t SET x = 1 FROM Table t WHERE t.id = 1')).toBe(true);
  });

  it('should return false for UPDATE without WHERE', () => {
    expect(hasTopLevelWhere('UPDATE t SET x = 1 FROM Table t')).toBe(false);
  });

  it('should return false when WHERE only exists inside a subquery', () => {
    expect(hasTopLevelWhere('UPDATE t SET x = (SELECT 1 FROM y WHERE y.id = 1) FROM Table t')).toBe(false);
  });

  it('should return true when WHERE exists at top level even with subqueries', () => {
    expect(hasTopLevelWhere('DELETE FROM t WHERE id IN (SELECT id FROM y)')).toBe(true);
  });

  it('should return true for mixed case WHERE keyword', () => {
    expect(hasTopLevelWhere('UPDATE t SET x = 1 FROM Table t where t.id = 1')).toBe(true);
  });
});

describe('classifyStatement', () => {
  describe('UPDATE patterns', () => {
    it('should classify UPDATE without WHERE as destructive', () => {
      expect(classifyStatement('UPDATE MyTable SET col = 1')).toBe('UPDATE_WITHOUT_WHERE');
    });

    it('should classify aliased UPDATE without WHERE as destructive', () => {
      expect(classifyStatement('UPDATE t SET col = 1 FROM MyTable t')).toBe('UPDATE_WITHOUT_WHERE');
    });

    it('should classify UPDATE with WHERE as safe', () => {
      expect(classifyStatement('UPDATE MyTable SET col = 1 WHERE id = 1')).toBeNull();
    });

    it('should classify aliased UPDATE with WHERE as safe', () => {
      expect(classifyStatement('UPDATE t SET col = 1 FROM MyTable t WHERE t.id = 1')).toBeNull();
    });

    it('should classify UPDATE with WHERE only in subquery as destructive', () => {
      expect(classifyStatement('UPDATE t SET col = (SELECT x FROM y WHERE y.id = 1) FROM Table t')).toBe('UPDATE_WITHOUT_WHERE');
    });
  });

  describe('DELETE patterns', () => {
    it('should classify DELETE without WHERE as destructive', () => {
      expect(classifyStatement('DELETE FROM MyTable')).toBe('DELETE_WITHOUT_WHERE');
    });

    it('should classify DELETE with WHERE as safe', () => {
      expect(classifyStatement('DELETE FROM MyTable WHERE id = 1')).toBeNull();
    });

    it('should classify aliased DELETE without WHERE as destructive', () => {
      expect(classifyStatement('DELETE t FROM MyTable t')).toBe('DELETE_WITHOUT_WHERE');
    });

    it('should classify aliased DELETE with WHERE as safe', () => {
      expect(classifyStatement('DELETE t FROM MyTable t WHERE t.id = 1')).toBeNull();
    });

    it('should classify DELETE TOP(n) without WHERE as destructive', () => {
      expect(classifyStatement('DELETE TOP(10) FROM MyTable')).toBe('DELETE_WITHOUT_WHERE');
    });

    it('should classify multi-table JOIN DELETE without WHERE as destructive', () => {
      expect(classifyStatement('DELETE t FROM Table1 t JOIN Table2 t2 ON t.id = t2.id')).toBe('DELETE_WITHOUT_WHERE');
    });
  });

  describe('TRUNCATE patterns', () => {
    it('should classify TRUNCATE TABLE as destructive', () => {
      expect(classifyStatement('TRUNCATE TABLE MyTable')).toBe('TRUNCATE_TABLE');
    });

    it('should classify TRUNCATE TABLE with bracket-quoted name as destructive', () => {
      expect(classifyStatement('TRUNCATE TABLE [dbo].[MyTable]')).toBe('TRUNCATE_TABLE');
    });

    it('should classify TRUNCATE TABLE with schema-qualified name as destructive', () => {
      expect(classifyStatement('TRUNCATE TABLE dbo.MyTable')).toBe('TRUNCATE_TABLE');
    });

    it('should NOT classify bare TRUNCATE without TABLE keyword', () => {
      expect(classifyStatement('TRUNCATE')).toBeNull();
    });
  });

  describe('DROP TABLE patterns', () => {
    it('should classify DROP TABLE as destructive', () => {
      expect(classifyStatement('DROP TABLE MyTable')).toBe('DROP_TABLE');
    });

    it('should classify DROP TABLE IF EXISTS as destructive', () => {
      expect(classifyStatement('DROP TABLE IF EXISTS MyTable')).toBe('DROP_TABLE');
    });

    it('should classify DROP TABLE with bracket-quoted name as destructive', () => {
      expect(classifyStatement('DROP TABLE [dbo].[MyTable]')).toBe('DROP_TABLE');
    });

    it('should classify DROP TABLE with multi-table list as destructive', () => {
      expect(classifyStatement('DROP TABLE dbo.A, [schema].[B]')).toBe('DROP_TABLE');
    });
  });

  describe('DROP DATABASE patterns', () => {
    it('should classify DROP DATABASE as destructive', () => {
      expect(classifyStatement('DROP DATABASE MyDb')).toBe('DROP_DATABASE');
    });

    it('should classify DROP DATABASE IF EXISTS as destructive', () => {
      expect(classifyStatement('DROP DATABASE IF EXISTS MyDb')).toBe('DROP_DATABASE');
    });
  });

  describe('safe DROP patterns (not flagged)', () => {
    it('should NOT classify DROP VIEW as destructive', () => {
      expect(classifyStatement('DROP VIEW MyView')).toBeNull();
    });

    it('should NOT classify DROP PROCEDURE as destructive', () => {
      expect(classifyStatement('DROP PROCEDURE MyProc')).toBeNull();
    });

    it('should NOT classify DROP INDEX as destructive', () => {
      expect(classifyStatement('DROP INDEX IX_MyIndex ON MyTable')).toBeNull();
    });

    it('should NOT classify DROP FUNCTION as destructive', () => {
      expect(classifyStatement('DROP FUNCTION dbo.MyFunc')).toBeNull();
    });
  });

  describe('case insensitivity', () => {
    it('should classify lowercase update without WHERE as destructive', () => {
      expect(classifyStatement('update mytable set col = 1')).toBe('UPDATE_WITHOUT_WHERE');
    });

    it('should classify mixed-case DELETE without WHERE as destructive', () => {
      expect(classifyStatement('DeLeTe FROM Table')).toBe('DELETE_WITHOUT_WHERE');
    });

    it('should classify mixed-case TRUNCATE TABLE as destructive', () => {
      expect(classifyStatement('truncate TABLE foo')).toBe('TRUNCATE_TABLE');
    });

    it('should classify lowercase drop table as destructive', () => {
      expect(classifyStatement('drop table bar')).toBe('DROP_TABLE');
    });
  });

  describe('safe statements (not flagged)', () => {
    it('should NOT classify SELECT as destructive', () => {
      expect(classifyStatement('SELECT * FROM MyTable')).toBeNull();
    });

    it('should NOT classify INSERT as destructive', () => {
      expect(classifyStatement('INSERT INTO MyTable VALUES (1)')).toBeNull();
    });

    it('should NOT classify CREATE TABLE as destructive', () => {
      expect(classifyStatement('CREATE TABLE NewTable (id INT)')).toBeNull();
    });
  });
});


describe('analyze', () => {
  describe('empty and whitespace-only input', () => {
    it('should return empty result for empty input', () => {
      const result = analyze('');
      expect(result).toEqual({ statements: [] });
    });

    it('should return empty result for whitespace-only input', () => {
      const result = analyze('   \n  ');
      expect(result).toEqual({ statements: [] });
    });
  });

  describe('single statements', () => {
    it('should return empty result for a single safe statement', () => {
      const result = analyze('SELECT * FROM t WHERE id = 1');
      expect(result).toEqual({ statements: [] });
    });

    it('should detect a single destructive statement', () => {
      const result = analyze('DELETE FROM MyTable');
      expect(result.statements).toHaveLength(1);
      expect(result.statements[0].lineNumber).toBe(1);
      expect(result.statements[0].reason).toBe('DELETE_WITHOUT_WHERE');
    });
  });

  describe('multi-statement batch with mixed safe and destructive', () => {
    it('should detect only destructive statements in a mixed batch', () => {
      const sql = 'SELECT 1;\nDELETE FROM t;\nUPDATE t SET x = 1 WHERE id = 1;\nDROP TABLE foo';
      const result = analyze(sql);
      expect(result.statements).toHaveLength(2);
      expect(result.statements[0].lineNumber).toBe(2);
      expect(result.statements[0].reason).toBe('DELETE_WITHOUT_WHERE');
      expect(result.statements[1].lineNumber).toBe(4);
      expect(result.statements[1].reason).toBe('DROP_TABLE');
    });
  });

  describe('documentStartLine offset', () => {
    it('should apply documentStartLine offset to line numbers', () => {
      const result = analyze('DELETE FROM t', 10);
      expect(result.statements).toHaveLength(1);
      expect(result.statements[0].lineNumber).toBe(11);
    });

    it('should apply offset in selection mode with UPDATE', () => {
      const result = analyze('UPDATE t SET x = 1', 5);
      expect(result.statements).toHaveLength(1);
      expect(result.statements[0].lineNumber).toBe(6);
    });
  });

  describe('destructive keywords inside comments not flagged', () => {
    it('should not flag destructive keywords inside single-line comment', () => {
      const result = analyze('-- DELETE FROM t\nSELECT 1');
      expect(result).toEqual({ statements: [] });
    });

    it('should not flag destructive keywords inside block comment', () => {
      const result = analyze('/* DELETE FROM t */ SELECT 1');
      expect(result).toEqual({ statements: [] });
    });
  });

  describe('destructive keywords inside strings not flagged', () => {
    it('should not flag destructive keywords inside a string literal', () => {
      const result = analyze("SELECT 'DROP TABLE foo' AS cmd");
      expect(result).toEqual({ statements: [] });
    });
  });

  describe('multiple destructive statements ordered by line number', () => {
    it('should return statements ordered by lineNumber ascending', () => {
      const sql = 'DROP TABLE foo;\nDELETE FROM bar;\nTRUNCATE TABLE baz';
      const result = analyze(sql);
      expect(result.statements).toHaveLength(3);
      expect(result.statements[0].lineNumber).toBe(1);
      expect(result.statements[0].reason).toBe('DROP_TABLE');
      expect(result.statements[1].lineNumber).toBe(2);
      expect(result.statements[1].reason).toBe('DELETE_WITHOUT_WHERE');
      expect(result.statements[2].lineNumber).toBe(3);
      expect(result.statements[2].reason).toBe('TRUNCATE_TABLE');
    });
  });

  describe('original text preserved', () => {
    it('should preserve original text including string literals', () => {
      const result = analyze("UPDATE t SET col = 'val'");
      expect(result.statements).toHaveLength(1);
      expect(result.statements[0].text).toContain("'val'");
    });
  });

  describe('GO batch separator with destructive statements', () => {
    it('should detect destructive statement in a separate GO batch', () => {
      const sql = 'SELECT 1\nGO\nDELETE FROM t';
      const result = analyze(sql);
      expect(result.statements).toHaveLength(1);
      expect(result.statements[0].lineNumber).toBe(3);
      expect(result.statements[0].reason).toBe('DELETE_WITHOUT_WHERE');
    });
  });
});
