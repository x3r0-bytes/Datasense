import { describe, it, expect } from 'vitest';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { lintObjectReferences, ObjectReferenceLinterContext } from '../../server/src/objectReferenceLinter';
import { ISchemaCache, TableInfo, ViewInfo, ProcedureInfo } from '../../server/src/schemaCache';
import * as mssql from 'mssql';

// ─── Mock helpers ──────────────────────────────────────────────────────────────

function makeColumn(name: string) {
  return { name, dataType: 'nvarchar', isNullable: true };
}

function makeTable(schema: string, name: string, columns: string[]): TableInfo {
  return { schema, name, columns: columns.map(makeColumn) };
}

function makeView(schema: string, name: string, columns: string[]): ViewInfo {
  return { schema, name, columns: columns.map(makeColumn) };
}

function createMockCache(options: {
  tables?: TableInfo[];
  views?: ViewInfo[];
  procedures?: ProcedureInfo[];
  isPopulating?: boolean;
}): ISchemaCache {
  return {
    tables: options.tables ?? [],
    views: options.views ?? [],
    procedures: options.procedures ?? [],
    foreignKeys: [],
    isPopulating: options.isPopulating ?? false,
    refresh: async (_pool: mssql.ConnectionPool) => {},
    getForeignKeysForTable: (_schema: string, _tableName: string) => [],
  };
}

function makeContext(
  cache: ISchemaCache,
  isConnected = true,
  isRefreshing = false
): ObjectReferenceLinterContext {
  return { schemaCache: cache, isConnected, isRefreshing };
}

// ─── Guard conditions ──────────────────────────────────────────────────────────

describe('lintObjectReferences — guard conditions (Requirement 5.5)', () => {
  const cache = createMockCache({
    tables: [makeTable('dbo', 'Users', ['UserId', 'Name'])],
  });

  it('returns [] when isConnected is false', () => {
    const diags = lintObjectReferences(
      'SELECT * FROM UnknownTable',
      0,
      makeContext(cache, false)
    );
    expect(diags).toHaveLength(0);
  });

  it('returns [] when isRefreshing is true', () => {
    const diags = lintObjectReferences(
      'SELECT * FROM UnknownTable',
      0,
      makeContext(cache, true, true)
    );
    expect(diags).toHaveLength(0);
  });

  it('returns [] when cache has no tables and no views', () => {
    const emptyCache = createMockCache({});
    const diags = lintObjectReferences(
      'SELECT * FROM UnknownTable',
      0,
      makeContext(emptyCache)
    );
    expect(diags).toHaveLength(0);
  });
});

// ─── Alias resolution (Requirement 5.6) ───────────────────────────────────────

describe('lintObjectReferences — alias resolution (Requirement 5.6)', () => {
  it('resolves alias to underlying table: SELECT a.col FROM MyTable AS a produces no diagnostic', () => {
    const cache = createMockCache({
      tables: [makeTable('dbo', 'MyTable', ['col', 'id'])],
    });

    const diags = lintObjectReferences(
      'SELECT a.col FROM MyTable AS a',
      0,
      makeContext(cache)
    );

    // No diagnostic: MyTable exists and 'col' is a valid column on it
    const tableDiags = diags.filter(d => d.message.includes('MyTable') && d.code === 'ORL001');
    expect(tableDiags).toHaveLength(0);
  });

  it('produces a column warning when alias is used but column does not exist on the resolved table', () => {
    const cache = createMockCache({
      tables: [makeTable('dbo', 'MyTable', ['id', 'name'])],
    });

    const diags = lintObjectReferences(
      'SELECT a.nonexistent FROM MyTable AS a',
      0,
      makeContext(cache)
    );

    const colDiags = diags.filter(d => d.code === 'ORL002');
    expect(colDiags.length).toBeGreaterThan(0);
    expect(colDiags[0].severity).toBe(DiagnosticSeverity.Warning);
  });
});

// ─── dbo fallback (Requirement 5.1) ───────────────────────────────────────────

describe('lintObjectReferences — dbo fallback (Requirement 5.1)', () => {
  it('unqualified Users resolves to dbo.Users if it exists in cache — no diagnostic', () => {
    const cache = createMockCache({
      tables: [makeTable('dbo', 'Users', ['UserId', 'Name'])],
    });

    const diags = lintObjectReferences(
      'SELECT UserId FROM Users',
      0,
      makeContext(cache)
    );

    const tableDiags = diags.filter(d => d.code === 'ORL001');
    expect(tableDiags).toHaveLength(0);
  });

  it('unqualified name that only exists under a non-dbo schema is still resolved — no diagnostic', () => {
    const cache = createMockCache({
      tables: [makeTable('hr', 'Employees', ['EmpId', 'Name'])],
    });

    const diags = lintObjectReferences(
      'SELECT EmpId FROM Employees',
      0,
      makeContext(cache)
    );

    const tableDiags = diags.filter(d => d.code === 'ORL001');
    expect(tableDiags).toHaveLength(0);
  });

  it('unqualified table not in cache produces a Warning diagnostic', () => {
    const cache = createMockCache({
      tables: [makeTable('dbo', 'Users', ['UserId'])],
    });

    const diags = lintObjectReferences(
      'SELECT * FROM UnknownTable',
      0,
      makeContext(cache)
    );

    const tableDiags = diags.filter(d => d.code === 'ORL001');
    expect(tableDiags).toHaveLength(1);
    expect(tableDiags[0].severity).toBe(DiagnosticSeverity.Warning);
    expect(tableDiags[0].message).toContain('UnknownTable');
  });
});

// ─── Schema-qualified names (Requirement 5.9) ─────────────────────────────────

describe('lintObjectReferences — schema-qualified names (Requirement 5.9)', () => {
  it('hr.Employees validates against hr schema, not dbo — no diagnostic when hr.Employees exists', () => {
    const cache = createMockCache({
      tables: [
        makeTable('dbo', 'Employees', ['EmpId']),
        makeTable('hr', 'Employees', ['EmpId', 'HireDate']),
      ],
    });

    const diags = lintObjectReferences(
      'SELECT EmpId FROM hr.Employees',
      0,
      makeContext(cache)
    );

    const tableDiags = diags.filter(d => d.code === 'ORL001');
    expect(tableDiags).toHaveLength(0);
  });

  it('hr.Employees produces a Warning when only dbo.Employees exists in cache', () => {
    const cache = createMockCache({
      tables: [makeTable('dbo', 'Employees', ['EmpId'])],
    });

    const diags = lintObjectReferences(
      'SELECT EmpId FROM hr.Employees',
      0,
      makeContext(cache)
    );

    const tableDiags = diags.filter(d => d.code === 'ORL001');
    expect(tableDiags).toHaveLength(1);
    expect(tableDiags[0].severity).toBe(DiagnosticSeverity.Warning);
  });
});

// ─── Three-part names (Requirement 5.9) ───────────────────────────────────────

describe('lintObjectReferences — three-part names (Requirement 5.9)', () => {
  it('three-part name with unknown database is silently skipped — no diagnostic', () => {
    // The active cache only knows about the current database.
    // A three-part name like OtherDB.dbo.Users references another database — skip silently.
    const cache = createMockCache({
      tables: [makeTable('dbo', 'Users', ['UserId'])],
    });

    const diags = lintObjectReferences(
      'SELECT UserId FROM OtherDB.dbo.Users',
      0,
      makeContext(cache)
    );

    const tableDiags = diags.filter(d => d.code === 'ORL001');
    expect(tableDiags).toHaveLength(0);
  });

  it('three-part name where schema.table matches active cache is accepted — no diagnostic', () => {
    // If the three-part name's schema.table exists in the cache, it belongs to the active DB
    const cache = createMockCache({
      tables: [makeTable('dbo', 'Orders', ['OrderId', 'CustomerId'])],
    });

    const diags = lintObjectReferences(
      'SELECT OrderId FROM CurrentDB.dbo.Orders',
      0,
      makeContext(cache)
    );

    // Either way (found or not found in active cache), no ORL001 diagnostic for unknown DB
    // The linter treats 3-part names where schema.table is NOT in cache as silent skip
    // For the case where it IS in the cache, it should also produce no table diagnostic
    const tableDiags = diags.filter(d => d.code === 'ORL001');
    expect(tableDiags).toHaveLength(0);
  });
});

// ─── CTE names (Requirement 5.7) ──────────────────────────────────────────────

describe('lintObjectReferences — CTE names (Requirement 5.7)', () => {
  it('CTE name defined with WITH ... AS produces no table diagnostic', () => {
    const cache = createMockCache({
      tables: [makeTable('dbo', 'Orders', ['OrderId', 'CustomerId'])],
    });

    const sql = `
WITH OrderSummary AS (
  SELECT OrderId, CustomerId FROM Orders
)
SELECT * FROM OrderSummary
    `.trim();

    const diags = lintObjectReferences(sql, 0, makeContext(cache));

    // OrderSummary is a CTE — no ORL001 for it
    const cteDiags = diags.filter(
      d => d.code === 'ORL001' && d.message.includes('OrderSummary')
    );
    expect(cteDiags).toHaveLength(0);
  });

  it('query with CTE still produces diagnostic for genuinely unknown tables', () => {
    const cache = createMockCache({
      tables: [makeTable('dbo', 'Orders', ['OrderId'])],
    });

    const sql = `
WITH MyCte AS (
  SELECT OrderId FROM Orders
)
SELECT * FROM MyCte JOIN NonExistentTable ON 1=1
    `.trim();

    const diags = lintObjectReferences(sql, 0, makeContext(cache));

    const unknownDiags = diags.filter(
      d => d.code === 'ORL001' && d.message.includes('NonExistentTable')
    );
    expect(unknownDiags).toHaveLength(1);
    expect(unknownDiags[0].severity).toBe(DiagnosticSeverity.Warning);
  });
});

// ─── Temp tables (Requirement 5.7) ────────────────────────────────────────────

describe('lintObjectReferences — temp tables (Requirement 5.7)', () => {
  it('#TempResult produces no diagnostic', () => {
    const cache = createMockCache({
      tables: [makeTable('dbo', 'Users', ['UserId'])],
    });

    const diags = lintObjectReferences(
      'SELECT UserId INTO #TempResult FROM Users',
      0,
      makeContext(cache)
    );

    const tempDiags = diags.filter(
      d => d.code === 'ORL001' && d.message.toLowerCase().includes('temp')
    );
    expect(tempDiags).toHaveLength(0);
  });

  it('SELECT FROM #TempTable produces no ORL001 diagnostic', () => {
    const cache = createMockCache({
      tables: [makeTable('dbo', 'Products', ['ProductId'])],
    });

    const diags = lintObjectReferences(
      'SELECT * FROM #TempTable',
      0,
      makeContext(cache)
    );

    const tableDiags = diags.filter(d => d.code === 'ORL001');
    expect(tableDiags).toHaveLength(0);
  });
});

// ─── Derived table aliases (Requirement 5.7) ──────────────────────────────────

describe('lintObjectReferences — derived table aliases (Requirement 5.7)', () => {
  it('derived table alias in a subquery produces no table diagnostic', () => {
    const cache = createMockCache({
      tables: [makeTable('dbo', 'Orders', ['OrderId', 'Amount'])],
    });

    const sql =
      'SELECT sub.OrderId FROM (SELECT OrderId, Amount FROM Orders) AS sub';

    const diags = lintObjectReferences(sql, 0, makeContext(cache));

    // 'sub' is a derived alias — should not produce ORL001
    const subDiags = diags.filter(
      d => d.code === 'ORL001' && d.message.includes('sub')
    );
    expect(subDiags).toHaveLength(0);
  });

  it('column reference on a derived alias does not produce ORL002', () => {
    const cache = createMockCache({
      tables: [makeTable('dbo', 'Orders', ['OrderId', 'Amount'])],
    });

    const sql =
      'SELECT sub.OrderId FROM (SELECT OrderId FROM Orders) AS sub';

    const diags = lintObjectReferences(sql, 0, makeContext(cache));

    const colDiags = diags.filter(
      d => d.code === 'ORL002' && d.message.includes('sub')
    );
    expect(colDiags).toHaveLength(0);
  });
});

// ─── Unrecognized table → Warning severity (Requirements 5.2, 5.8) ────────────

describe('lintObjectReferences — unrecognized table severity (Requirements 5.2, 5.8)', () => {
  it('unrecognized table produces a Warning diagnostic, not Error', () => {
    const cache = createMockCache({
      tables: [makeTable('dbo', 'Users', ['UserId'])],
    });

    const diags = lintObjectReferences(
      'SELECT * FROM TypoTable',
      0,
      makeContext(cache)
    );

    expect(diags.length).toBeGreaterThan(0);
    for (const d of diags.filter(x => x.code === 'ORL001')) {
      expect(d.severity).toBe(DiagnosticSeverity.Warning);
      expect(d.severity).not.toBe(DiagnosticSeverity.Error);
    }
  });

  it('unrecognized two-part name produces Warning with source tsql-lint', () => {
    const cache = createMockCache({
      tables: [makeTable('dbo', 'Users', ['UserId'])],
    });

    const diags = lintObjectReferences(
      'SELECT * FROM sales.GhostTable',
      0,
      makeContext(cache)
    );

    const tableDiags = diags.filter(d => d.code === 'ORL001');
    expect(tableDiags.length).toBeGreaterThan(0);
    expect(tableDiags[0].severity).toBe(DiagnosticSeverity.Warning);
    expect(tableDiags[0].source).toBe('tsql-lint');
  });

  it('valid table reference produces no diagnostic', () => {
    const cache = createMockCache({
      tables: [makeTable('dbo', 'Customers', ['CustomerId', 'Name'])],
    });

    const diags = lintObjectReferences(
      'SELECT CustomerId FROM dbo.Customers',
      0,
      makeContext(cache)
    );

    expect(diags.filter(d => d.code === 'ORL001')).toHaveLength(0);
  });
});

// ─── batchStartLine offset (Requirement 5.1) ──────────────────────────────────

describe('lintObjectReferences — batchStartLine line offset', () => {
  it('diagnostic line number is offset by batchStartLine', () => {
    const cache = createMockCache({
      tables: [makeTable('dbo', 'Users', ['UserId'])],
    });

    const diags = lintObjectReferences(
      'SELECT * FROM UnknownTable',
      5,  // batch starts at line 5 in the document
      makeContext(cache)
    );

    const tableDiags = diags.filter(d => d.code === 'ORL001');
    expect(tableDiags).toHaveLength(1);
    // The diagnostic should be on line 5 (0 + 5 offset)
    expect(tableDiags[0].range.start.line).toBe(5);
  });
});

// ─── Views (Requirement 5.1) ───────────────────────────────────────────────────

describe('lintObjectReferences — view references', () => {
  it('view reference that exists in cache produces no diagnostic', () => {
    const cache = createMockCache({
      views: [makeView('dbo', 'vActiveUsers', ['UserId', 'Email'])],
    });

    const diags = lintObjectReferences(
      'SELECT UserId FROM dbo.vActiveUsers',
      0,
      makeContext(cache)
    );

    expect(diags.filter(d => d.code === 'ORL001')).toHaveLength(0);
  });

  it('unrecognized view name produces a Warning diagnostic', () => {
    const cache = createMockCache({
      views: [makeView('dbo', 'vActiveUsers', ['UserId'])],
    });

    const diags = lintObjectReferences(
      'SELECT * FROM dbo.vGhostView',
      0,
      makeContext(cache)
    );

    const viewDiags = diags.filter(d => d.code === 'ORL001');
    expect(viewDiags.length).toBeGreaterThan(0);
    expect(viewDiags[0].severity).toBe(DiagnosticSeverity.Warning);
  });
});

// ─── JOIN clauses (Requirement 5.1) ───────────────────────────────────────────

describe('lintObjectReferences — JOIN clause table validation', () => {
  it('valid JOIN table produces no diagnostic', () => {
    const cache = createMockCache({
      tables: [
        makeTable('dbo', 'Orders', ['OrderId', 'CustomerId']),
        makeTable('dbo', 'Customers', ['CustomerId', 'Name']),
      ],
    });

    const diags = lintObjectReferences(
      'SELECT o.OrderId, c.Name FROM Orders o JOIN Customers c ON o.CustomerId = c.CustomerId',
      0,
      makeContext(cache)
    );

    expect(diags.filter(d => d.code === 'ORL001')).toHaveLength(0);
  });

  it('unknown table in JOIN produces a Warning diagnostic', () => {
    const cache = createMockCache({
      tables: [makeTable('dbo', 'Orders', ['OrderId'])],
    });

    const diags = lintObjectReferences(
      'SELECT * FROM Orders o JOIN GhostTable g ON o.OrderId = g.OrderId',
      0,
      makeContext(cache)
    );

    const joinDiags = diags.filter(d => d.code === 'ORL001');
    expect(joinDiags).toHaveLength(1);
    expect(joinDiags[0].severity).toBe(DiagnosticSeverity.Warning);
    expect(joinDiags[0].message).toContain('GhostTable');
  });
});

// ─── Multiple CTEs (Requirement 5.7) ──────────────────────────────────────────

describe('lintObjectReferences — multiple CTEs', () => {
  it('multiple comma-separated CTEs all produce no diagnostic', () => {
    const cache = createMockCache({
      tables: [
        makeTable('dbo', 'Orders', ['OrderId', 'CustomerId']),
        makeTable('dbo', 'Customers', ['CustomerId', 'Name']),
      ],
    });

    const sql = `
WITH
  CteA AS (SELECT OrderId, CustomerId FROM Orders),
  CteB AS (SELECT CustomerId, Name FROM Customers)
SELECT a.OrderId, b.Name FROM CteA a JOIN CteB b ON a.CustomerId = b.CustomerId
    `.trim();

    const diags = lintObjectReferences(sql, 0, makeContext(cache));

    const cteDiags = diags.filter(
      d =>
        d.code === 'ORL001' &&
        (d.message.includes('CteA') || d.message.includes('CteB'))
    );
    expect(cteDiags).toHaveLength(0);
  });
});

// ─── Column alias detection (AS keyword) — ORL002 false positives ─────────────

describe('lintObjectReferences — SELECT alias detection (AS keyword case-insensitivity)', () => {
  const cache = createMockCache({
    tables: [makeTable('Construction', 'BudgetData', ['BudgetAmount', 'id', 'IncidentStatus', 'ProjectNumber', 'ProjectID'])],
  });

  it('does not flag aliases defined with lowercase "as" (e.g., SUM(x) as TotalBudget)', () => {
    const sql = `
SELECT SUM(BudgetAmount) as TotalBudget,
       COUNT(*) as NumberOfBudgets,
       MAX(id) as MaxBudgetID,
       ProjectID
FROM Construction.BudgetData
WHERE ISNULL(IncidentStatus,'') <> 'Canceled'
AND ProjectNumber = '267-4221'
GROUP BY ProjectID
    `.trim();

    const diags = lintObjectReferences(sql, 0, makeContext(cache));
    const aliasErrors = diags.filter(
      d => d.code === 'ORL002' &&
        (d.message.includes('TotalBudget') ||
         d.message.includes('NumberOfBudgets') ||
         d.message.includes('MaxBudgetID'))
    );
    expect(aliasErrors).toHaveLength(0);
  });

  it('does not flag aliases defined with uppercase "AS" (e.g., SUM(x) AS TotalBudget)', () => {
    const sql = `
SELECT SUM(BudgetAmount) AS TotalBudget,
       COUNT(*) AS NumberOfBudgets,
       MAX(id) AS MaxBudgetID,
       ProjectID
FROM Construction.BudgetData
WHERE ProjectNumber = '267-4221'
GROUP BY ProjectID
    `.trim();

    const diags = lintObjectReferences(sql, 0, makeContext(cache));
    const aliasErrors = diags.filter(
      d => d.code === 'ORL002' &&
        (d.message.includes('TotalBudget') ||
         d.message.includes('NumberOfBudgets') ||
         d.message.includes('MaxBudgetID'))
    );
    expect(aliasErrors).toHaveLength(0);
  });

  it('does not flag aliases defined with mixed case "As" or "aS"', () => {
    const sql = `
SELECT SUM(BudgetAmount) As Total, COUNT(*) aS Cnt
FROM Construction.BudgetData
GROUP BY ProjectID
    `.trim();

    const diags = lintObjectReferences(sql, 0, makeContext(cache));
    const aliasErrors = diags.filter(
      d => d.code === 'ORL002' &&
        (d.message.includes('Total') || d.message.includes('Cnt'))
    );
    expect(aliasErrors).toHaveLength(0);
  });

  it('still flags actual unknown column references in SELECT', () => {
    const sql = `
SELECT NonExistentColumn, ProjectID
FROM Construction.BudgetData
    `.trim();

    const diags = lintObjectReferences(sql, 0, makeContext(cache));
    const colErrors = diags.filter(
      d => d.code === 'ORL002' && d.message.includes('NonExistentColumn')
    );
    expect(colErrors.length).toBeGreaterThan(0);
  });
});

// ─── EXEC statements should not be scanned for column references ──────────────

describe('lintObjectReferences — EXEC statements not treated as column references', () => {
  const cache = createMockCache({
    tables: [
      makeTable('dbo', 'Access_Role_Group', ['ID', 'UserName', 'Application']),
      makeTable('dbo', 'dimFacility', ['FacilityCode', 'FacilityDetail']),
    ],
  });

  it('should NOT flag stored procedure name after EXEC as a column reference', () => {
    const sql = `
DELETE FROM dbo.Access_Role_Group
WHERE ID IN (245198, 245199)
AND UserName = '123'
AND Application = 'Test'

EXEC ult_workflow.cps.usp_add_role_manual_census_edit
'SelRodriguez',
'453'
    `.trim();

    const diags = lintObjectReferences(sql, 0, makeContext(cache));
    const procErrors = diags.filter(
      d => d.code === 'ORL002' && d.message.includes('usp_add_role_manual_census_edit')
    );
    expect(procErrors).toHaveLength(0);
  });

  it('should NOT flag procedure name in EXEC following a SELECT statement', () => {
    const sql = `
SELECT FacilityCode, FacilityDetail
FROM dbo.dimFacility
WHERE FacilityDetail LIKE '%test%'

EXEC ult_workflow.cps.usp_add_role_manual_census_view
'123826157',
'V09'
    `.trim();

    const diags = lintObjectReferences(sql, 0, makeContext(cache));
    const procErrors = diags.filter(
      d => d.code === 'ORL002' && d.message.includes('usp_add_role_manual_census_view')
    );
    expect(procErrors).toHaveLength(0);
  });

  it('should still flag invalid column names in the WHERE clause before EXEC', () => {
    const sql = `
SELECT FacilityCode
FROM dbo.dimFacility
WHERE NonExistentCol = 'x'

EXEC some_proc 'param'
    `.trim();

    const diags = lintObjectReferences(sql, 0, makeContext(cache));
    const colErrors = diags.filter(
      d => d.code === 'ORL002' && d.message.includes('NonExistentCol')
    );
    expect(colErrors.length).toBeGreaterThan(0);
  });
});

// ─── Three-part names (database.schema.table) should not produce column warnings ─

describe('lintObjectReferences — three-part names in clauses', () => {
  const cache = createMockCache({
    tables: [
      makeTable('dbo', 'Users', ['UserId', 'Name', 'Email']),
      makeTable('CPS', 'Access_Role_Group', ['ID', 'UserName', 'Application']),
    ],
  });

  it('should NOT flag three-part table name in FROM clause as unrecognized', () => {
    const sql = `SELECT UserId FROM ult_Workflow.CPS.Access_Role_Group`;
    const diags = lintObjectReferences(sql, 0, makeContext(cache));
    // Three-part names are silently skipped — no ORL001 for unknown databases
    const tableDiags = diags.filter(
      d => d.code === 'ORL001' && d.message.includes('Access_Role_Group')
    );
    expect(tableDiags).toHaveLength(0);
  });

  it('should NOT flag three-part column reference (db.schema.column) as unrecognized column', () => {
    const sql = `
SELECT ult_Workflow.CPS.Access_Role_Group.UserName
FROM ult_Workflow.CPS.Access_Role_Group
    `.trim();
    const diags = lintObjectReferences(sql, 0, makeContext(cache));
    const colDiags = diags.filter(
      d => d.code === 'ORL002' && d.message.includes('UserName')
    );
    expect(colDiags).toHaveLength(0);
  });

  it('should NOT flag EXEC with three-part procedure name as column reference', () => {
    const sql = `
SELECT Name FROM dbo.Users WHERE UserId = 1

EXEC ult_workflow.cps.usp_add_role_manual_census_edit 'param1', 'param2'
    `.trim();
    const diags = lintObjectReferences(sql, 0, makeContext(cache));
    const procDiags = diags.filter(
      d => d.code === 'ORL002' && d.message.includes('usp_add_role_manual_census_edit')
    );
    expect(procDiags).toHaveLength(0);
  });

  it('should NOT flag three-part names in WHERE clause', () => {
    const sql = `
SELECT Name FROM dbo.Users
WHERE ult_Workflow.CPS.Access_Role_Group.UserName = 'test'
    `.trim();
    const diags = lintObjectReferences(sql, 0, makeContext(cache));
    const colDiags = diags.filter(
      d => d.code === 'ORL002' &&
        (d.message.includes('ult_Workflow') ||
         d.message.includes('Access_Role_Group') ||
         d.message.includes('UserName'))
    );
    expect(colDiags).toHaveLength(0);
  });
});
