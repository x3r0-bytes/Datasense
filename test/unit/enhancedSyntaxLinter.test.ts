/**
 * Unit tests for the Enhanced Syntax Linter (server/src/enhancedSyntaxLinter.ts)
 *
 * Task 9.3 — Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import { describe, it, expect } from 'vitest';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import {
  lintEnhancedSyntax,
  EnhancedSyntaxLinterContext,
  VALID_DATA_TYPES,
  BUILTIN_FUNCTIONS,
} from '../../server/src/enhancedSyntaxLinter';
import { ISchemaCache, TableInfo, ProcedureInfo } from '../../server/src/schemaCache';
import * as mssql from 'mssql';

// ─── Mock helpers ──────────────────────────────────────────────────────────────

function makeColumn(name: string) {
  return { name, dataType: 'nvarchar', isNullable: true };
}

function makeTable(schema: string, name: string, columns: string[]): TableInfo {
  return { schema, name, columns: columns.map(makeColumn) };
}

function makeProc(schema: string, name: string): ProcedureInfo {
  return { schema, name };
}

function createMockCache(options: {
  tables?: TableInfo[];
  procedures?: ProcedureInfo[];
}): ISchemaCache {
  return {
    tables: options.tables ?? [],
    views: [],
    procedures: options.procedures ?? [],
    foreignKeys: [],
    isPopulating: false,
    refresh: async (_pool: mssql.ConnectionPool) => {},
    getForeignKeysForTable: (_schema: string, _tableName: string) => [],
  };
}

function makeConnectedContext(cache: ISchemaCache): EnhancedSyntaxLinterContext {
  return { schemaCache: cache, isConnected: true };
}

function makeDisconnectedContext(): EnhancedSyntaxLinterContext {
  return { schemaCache: null, isConnected: false };
}

// ─── ESL001: Invalid keyword sequences (Requirement 6.1) ──────────────────────

describe('ESL001 — invalid keyword sequences (Requirement 6.1)', () => {
  it('SELECT FROM (no column list) produces an Error diagnostic', () => {
    const diags = lintEnhancedSyntax(
      'SELECT FROM dbo.Users',
      0,
      makeDisconnectedContext()
    );

    const esl001 = diags.filter(d => d.code === 'ESL001');
    expect(esl001).toHaveLength(1);
    expect(esl001[0].severity).toBe(DiagnosticSeverity.Error);
    expect(esl001[0].message).toContain('FROM');
  });

  it('WHERE ORDER BY (missing condition) produces an Error diagnostic', () => {
    const diags = lintEnhancedSyntax(
      'SELECT id FROM Users WHERE ORDER BY id',
      0,
      makeDisconnectedContext()
    );

    const esl001 = diags.filter(d => d.code === 'ESL001');
    expect(esl001).toHaveLength(1);
    expect(esl001[0].severity).toBe(DiagnosticSeverity.Error);
    expect(esl001[0].message).toContain('ORDER BY');
  });

  it('valid SELECT with column list produces no ESL001 diagnostic', () => {
    const diags = lintEnhancedSyntax(
      'SELECT id, name FROM Users WHERE id = 1 ORDER BY name',
      0,
      makeDisconnectedContext()
    );

    expect(diags.filter(d => d.code === 'ESL001')).toHaveLength(0);
  });

  it('WHERE GROUP BY produces an ESL001 Error diagnostic', () => {
    const diags = lintEnhancedSyntax(
      'SELECT id FROM Users WHERE GROUP BY id',
      0,
      makeDisconnectedContext()
    );

    const esl001 = diags.filter(d => d.code === 'ESL001');
    expect(esl001).toHaveLength(1);
    expect(esl001[0].severity).toBe(DiagnosticSeverity.Error);
  });

  it('diagnostic source is tsql-lint', () => {
    const diags = lintEnhancedSyntax(
      'SELECT FROM Users',
      0,
      makeDisconnectedContext()
    );

    const esl001 = diags.filter(d => d.code === 'ESL001');
    expect(esl001).toHaveLength(1);
    expect(esl001[0].source).toBe('tsql-lint');
  });

  it('diagnostic range points at the unexpected token, not the start of SELECT', () => {
    const sql = 'SELECT FROM dbo.Users';
    const diags = lintEnhancedSyntax(sql, 0, makeDisconnectedContext());

    const esl001 = diags.filter(d => d.code === 'ESL001');
    expect(esl001).toHaveLength(1);
    // The range should start at "FROM" which is at character 7
    expect(esl001[0].range.start.character).toBe(7);
  });
});

// ─── ESL002: Invalid data types in CAST/CONVERT (Requirement 6.3) ─────────────

describe('ESL002 — invalid data type in CAST/CONVERT (Requirement 6.3)', () => {
  it('CAST(x AS INTEG) — misspelled type — produces an Error diagnostic', () => {
    const diags = lintEnhancedSyntax(
      'SELECT CAST(myCol AS INTEG) FROM dbo.t',
      0,
      makeDisconnectedContext()
    );

    const esl002 = diags.filter(d => d.code === 'ESL002');
    expect(esl002).toHaveLength(1);
    expect(esl002[0].severity).toBe(DiagnosticSeverity.Error);
    expect(esl002[0].message).toContain('INTEG');
  });

  it('CAST(x AS INT) — valid type — produces no diagnostic', () => {
    const diags = lintEnhancedSyntax(
      'SELECT CAST(myCol AS INT) FROM dbo.t',
      0,
      makeDisconnectedContext()
    );

    expect(diags.filter(d => d.code === 'ESL002')).toHaveLength(0);
  });

  it('CONVERT(VARCHARR, x) — misspelled type — produces an Error diagnostic', () => {
    const diags = lintEnhancedSyntax(
      'SELECT CONVERT(VARCHARR, myCol) FROM dbo.t',
      0,
      makeDisconnectedContext()
    );

    const esl002 = diags.filter(d => d.code === 'ESL002');
    expect(esl002).toHaveLength(1);
    expect(esl002[0].severity).toBe(DiagnosticSeverity.Error);
    expect(esl002[0].message).toContain('VARCHARR');
  });

  it('CONVERT(VARCHAR(50), x) — valid type with length — produces no diagnostic', () => {
    const diags = lintEnhancedSyntax(
      'SELECT CONVERT(VARCHAR(50), myCol) FROM dbo.t',
      0,
      makeDisconnectedContext()
    );

    expect(diags.filter(d => d.code === 'ESL002')).toHaveLength(0);
  });

  it('ESL002 diagnostic source is tsql-lint', () => {
    const diags = lintEnhancedSyntax(
      'SELECT CAST(x AS NUMB) FROM t',
      0,
      makeDisconnectedContext()
    );

    const esl002 = diags.filter(d => d.code === 'ESL002');
    expect(esl002).toHaveLength(1);
    expect(esl002[0].source).toBe('tsql-lint');
  });
});

// ─── All 33 valid data types produce no ESL002 (Requirement 6.3) ──────────────

describe('ESL002 — all 33 valid data types produce no diagnostic in CAST/CONVERT (Requirement 6.3)', () => {
  // The 33 valid types from VALID_DATA_TYPES
  const validTypes = [...VALID_DATA_TYPES];

  it('VALID_DATA_TYPES set contains 32 types (the full recognized T-SQL type list)', () => {
    // The design doc mentions 33, but the actual list in the spec has 32 unique types.
    // This test validates the actual implementation count matches the source list.
    expect(VALID_DATA_TYPES.size).toBe(32);
  });

  it.each(validTypes)('CAST(x AS %s) in any casing produces no ESL002 diagnostic', (typeName) => {
    // Test uppercase
    const upperDiags = lintEnhancedSyntax(
      `SELECT CAST(myCol AS ${typeName.toUpperCase()}) FROM t`,
      0,
      makeDisconnectedContext()
    );
    expect(upperDiags.filter(d => d.code === 'ESL002')).toHaveLength(0);

    // Test lowercase
    const lowerDiags = lintEnhancedSyntax(
      `SELECT CAST(myCol AS ${typeName.toLowerCase()}) FROM t`,
      0,
      makeDisconnectedContext()
    );
    expect(lowerDiags.filter(d => d.code === 'ESL002')).toHaveLength(0);

    // Test mixed case: first char upper, rest lower
    const mixedCase = typeName[0].toUpperCase() + typeName.slice(1).toLowerCase();
    const mixedDiags = lintEnhancedSyntax(
      `SELECT CAST(myCol AS ${mixedCase}) FROM t`,
      0,
      makeDisconnectedContext()
    );
    expect(mixedDiags.filter(d => d.code === 'ESL002')).toHaveLength(0);
  });

  it.each(validTypes)('CONVERT(%s, x) in any casing produces no ESL002 diagnostic', (typeName) => {
    const upperDiags = lintEnhancedSyntax(
      `SELECT CONVERT(${typeName.toUpperCase()}, myCol) FROM t`,
      0,
      makeDisconnectedContext()
    );
    expect(upperDiags.filter(d => d.code === 'ESL002')).toHaveLength(0);

    const lowerDiags = lintEnhancedSyntax(
      `SELECT CONVERT(${typeName.toLowerCase()}, myCol) FROM t`,
      0,
      makeDisconnectedContext()
    );
    expect(lowerDiags.filter(d => d.code === 'ESL002')).toHaveLength(0);
  });
});

// ─── ESL003: Unrecognized function (Requirement 6.2) ──────────────────────────

describe('ESL003 — unrecognized function (Requirement 6.2)', () => {
  const connectedCache = createMockCache({ tables: [], procedures: [] });

  it('unrecognized function FOOBAR(x) produces a Warning diagnostic when connected', () => {
    const diags = lintEnhancedSyntax(
      'SELECT FOOBAR(myCol) FROM dbo.t',
      0,
      makeConnectedContext(connectedCache)
    );

    const esl003 = diags.filter(d => d.code === 'ESL003');
    expect(esl003).toHaveLength(1);
    expect(esl003[0].severity).toBe(DiagnosticSeverity.Warning);
    expect(esl003[0].message).toContain('FOOBAR');
  });

  it('built-in function LEN(x) produces no ESL003 diagnostic', () => {
    const diags = lintEnhancedSyntax(
      'SELECT LEN(myCol) FROM dbo.t',
      0,
      makeConnectedContext(connectedCache)
    );

    expect(diags.filter(d => d.code === 'ESL003')).toHaveLength(0);
  });

  it('user-defined procedure in schema cache produces no ESL003 diagnostic', () => {
    const cacheWithProc = createMockCache({
      procedures: [makeProc('dbo', 'MYUDF')],
    });

    const diags = lintEnhancedSyntax(
      'SELECT MYUDF(myCol) FROM dbo.t',
      0,
      makeConnectedContext(cacheWithProc)
    );

    expect(diags.filter(d => d.code === 'ESL003')).toHaveLength(0);
  });

  it('unrecognized function produces Warning (not Error)', () => {
    const diags = lintEnhancedSyntax(
      'SELECT WEIRDFUNCTION(x) FROM t',
      0,
      makeConnectedContext(connectedCache)
    );

    const esl003 = diags.filter(d => d.code === 'ESL003');
    expect(esl003.length).toBeGreaterThan(0);
    for (const d of esl003) {
      expect(d.severity).toBe(DiagnosticSeverity.Warning);
      expect(d.severity).not.toBe(DiagnosticSeverity.Error);
    }
  });

  it('ESL003 diagnostic source is tsql-lint', () => {
    const diags = lintEnhancedSyntax(
      'SELECT FOOBAR(x) FROM t',
      0,
      makeConnectedContext(connectedCache)
    );

    const esl003 = diags.filter(d => d.code === 'ESL003');
    expect(esl003.length).toBeGreaterThan(0);
    expect(esl003[0].source).toBe('tsql-lint');
  });

  it('built-in function SUM(x) produces no ESL003 diagnostic', () => {
    const diags = lintEnhancedSyntax(
      'SELECT SUM(amount) FROM dbo.Sales',
      0,
      makeConnectedContext(connectedCache)
    );

    expect(diags.filter(d => d.code === 'ESL003')).toHaveLength(0);
  });

  it('built-in function GETDATE() produces no ESL003 diagnostic', () => {
    const diags = lintEnhancedSyntax(
      'SELECT GETDATE()',
      0,
      makeConnectedContext(connectedCache)
    );

    expect(diags.filter(d => d.code === 'ESL003')).toHaveLength(0);
  });

  it('BUILTIN_FUNCTIONS contains LEN', () => {
    expect(BUILTIN_FUNCTIONS.has('LEN')).toBe(true);
  });
});

// ─── ESL004: Invalid INSERT column names (Requirement 6.4) ────────────────────

describe('ESL004 — INSERT with invalid column names (Requirement 6.4)', () => {
  const tableWithCols = makeTable('dbo', 'Products', ['ProductId', 'Name', 'Price']);

  it('INSERT with an invalid column name produces a Warning diagnostic', () => {
    const cache = createMockCache({ tables: [tableWithCols] });

    const diags = lintEnhancedSyntax(
      'INSERT INTO dbo.Products (ProductId, BadColumn) VALUES (1, \'x\')',
      0,
      makeConnectedContext(cache)
    );

    const esl004 = diags.filter(d => d.code === 'ESL004');
    expect(esl004).toHaveLength(1);
    expect(esl004[0].severity).toBe(DiagnosticSeverity.Warning);
    expect(esl004[0].message).toContain('BadColumn');
  });

  it('INSERT with valid columns produces no ESL004 diagnostic', () => {
    const cache = createMockCache({ tables: [tableWithCols] });

    const diags = lintEnhancedSyntax(
      'INSERT INTO dbo.Products (ProductId, Name, Price) VALUES (1, \'widget\', 9.99)',
      0,
      makeConnectedContext(cache)
    );

    expect(diags.filter(d => d.code === 'ESL004')).toHaveLength(0);
  });

  it('INSERT column validation is case-insensitive', () => {
    const cache = createMockCache({ tables: [tableWithCols] });

    const diags = lintEnhancedSyntax(
      'INSERT INTO dbo.Products (productid, NAME, PRICE) VALUES (1, \'widget\', 9.99)',
      0,
      makeConnectedContext(cache)
    );

    expect(diags.filter(d => d.code === 'ESL004')).toHaveLength(0);
  });

  it('INSERT targeting a table not in cache produces no ESL004 diagnostic (Requirement 6.6)', () => {
    const cache = createMockCache({ tables: [] }); // empty cache

    const diags = lintEnhancedSyntax(
      'INSERT INTO dbo.UnknownTable (col1, col2) VALUES (1, 2)',
      0,
      makeConnectedContext(cache)
    );

    expect(diags.filter(d => d.code === 'ESL004')).toHaveLength(0);
  });

  it('INSERT with multiple invalid columns produces a diagnostic for each', () => {
    const cache = createMockCache({ tables: [tableWithCols] });

    const diags = lintEnhancedSyntax(
      'INSERT INTO dbo.Products (BadCol1, BadCol2) VALUES (1, 2)',
      0,
      makeConnectedContext(cache)
    );

    const esl004 = diags.filter(d => d.code === 'ESL004');
    expect(esl004.length).toBeGreaterThanOrEqual(2);
    expect(esl004.every(d => d.severity === DiagnosticSeverity.Warning)).toBe(true);
  });

  it('ESL004 diagnostic source is tsql-lint', () => {
    const cache = createMockCache({ tables: [tableWithCols] });

    const diags = lintEnhancedSyntax(
      'INSERT INTO dbo.Products (ProductId, GhostColumn) VALUES (1, \'x\')',
      0,
      makeConnectedContext(cache)
    );

    const esl004 = diags.filter(d => d.code === 'ESL004');
    expect(esl004.length).toBeGreaterThan(0);
    expect(esl004[0].source).toBe('tsql-lint');
  });
});

// ─── Disconnected context — schema-independent rules still fire (Requirement 6.5) ─

describe('disconnected context — syntax rules still fire (Requirement 6.5)', () => {
  it('ESL001 fires when disconnected: SELECT FROM', () => {
    const diags = lintEnhancedSyntax(
      'SELECT FROM Users',
      0,
      makeDisconnectedContext()
    );

    expect(diags.filter(d => d.code === 'ESL001')).toHaveLength(1);
    expect(diags.filter(d => d.code === 'ESL001')[0].severity).toBe(DiagnosticSeverity.Error);
  });

  it('ESL001 fires when disconnected: WHERE ORDER BY', () => {
    const diags = lintEnhancedSyntax(
      'SELECT id FROM t WHERE ORDER BY id',
      0,
      makeDisconnectedContext()
    );

    expect(diags.filter(d => d.code === 'ESL001')).toHaveLength(1);
  });

  it('ESL002 fires when disconnected: invalid data type in CAST', () => {
    const diags = lintEnhancedSyntax(
      'SELECT CAST(x AS NUMB) FROM t',
      0,
      makeDisconnectedContext()
    );

    expect(diags.filter(d => d.code === 'ESL002')).toHaveLength(1);
    expect(diags.filter(d => d.code === 'ESL002')[0].severity).toBe(DiagnosticSeverity.Error);
  });
});

// ─── Disconnected context — schema-dependent rules do NOT fire (Requirement 6.5) ─

describe('disconnected context — schema-dependent rules suppressed (Requirement 6.5)', () => {
  it('ESL003 (unknown function) is not produced when disconnected', () => {
    const diags = lintEnhancedSyntax(
      'SELECT FOOBAR(x) FROM t',
      0,
      makeDisconnectedContext()
    );

    expect(diags.filter(d => d.code === 'ESL003')).toHaveLength(0);
  });

  it('ESL004 (invalid INSERT column) is not produced when disconnected', () => {
    const diags = lintEnhancedSyntax(
      'INSERT INTO dbo.Products (BadColumn) VALUES (1)',
      0,
      makeDisconnectedContext()
    );

    expect(diags.filter(d => d.code === 'ESL004')).toHaveLength(0);
  });

  it('connected context with null cache behaves like disconnected', () => {
    const ctx: EnhancedSyntaxLinterContext = { schemaCache: null, isConnected: true };

    const diags = lintEnhancedSyntax('SELECT FOOBAR(x) FROM t', 0, ctx);

    expect(diags.filter(d => d.code === 'ESL003')).toHaveLength(0);
  });
});

// ─── batchStartLine line offset ────────────────────────────────────────────────

describe('batchStartLine — line offset applied to diagnostics', () => {
  it('ESL001 range.start.line is offset by batchStartLine', () => {
    const diags = lintEnhancedSyntax(
      'SELECT FROM Users',
      10,
      makeDisconnectedContext()
    );

    const esl001 = diags.filter(d => d.code === 'ESL001');
    expect(esl001).toHaveLength(1);
    expect(esl001[0].range.start.line).toBe(10);
  });

  it('ESL002 range.start.line is offset by batchStartLine', () => {
    const diags = lintEnhancedSyntax(
      'SELECT CAST(x AS NUMB) FROM t',
      5,
      makeDisconnectedContext()
    );

    const esl002 = diags.filter(d => d.code === 'ESL002');
    expect(esl002).toHaveLength(1);
    expect(esl002[0].range.start.line).toBe(5);
  });
});

// ─── Multi-line SQL — ranges span correct lines ────────────────────────────────

describe('multi-line SQL — diagnostic line numbers', () => {
  it('SELECT FROM on second line of batch gets line 1 (+ batchStartLine)', () => {
    const sql = 'SELECT id FROM t\nSELECT FROM AnotherTable';

    const diags = lintEnhancedSyntax(sql, 0, makeDisconnectedContext());

    const esl001 = diags.filter(d => d.code === 'ESL001');
    expect(esl001).toHaveLength(1);
    // "FROM" in "SELECT FROM AnotherTable" is on line index 1
    expect(esl001[0].range.start.line).toBe(1);
  });
});

// ─── Comments and string literals don't trigger false positives ───────────────

describe('comments and string literals — no false positives', () => {
  it('SELECT FROM inside a comment does not produce ESL001', () => {
    const sql = '-- SELECT FROM\nSELECT id FROM Users';

    const diags = lintEnhancedSyntax(sql, 0, makeDisconnectedContext());

    expect(diags.filter(d => d.code === 'ESL001')).toHaveLength(0);
  });

  it('misspelled type inside a string literal does not produce ESL002', () => {
    const sql = "SELECT 'CAST(x AS INTEG)' AS note FROM t";

    const diags = lintEnhancedSyntax(sql, 0, makeDisconnectedContext());

    expect(diags.filter(d => d.code === 'ESL002')).toHaveLength(0);
  });

  it('function name inside block comment does not produce ESL003 when connected', () => {
    const cache = createMockCache({});
    const sql = '/* FOOBAR(x) is a bad function */ SELECT LEN(col) FROM t';

    const diags = lintEnhancedSyntax(sql, 0, makeConnectedContext(cache));

    expect(diags.filter(d => d.code === 'ESL003')).toHaveLength(0);
  });
});
