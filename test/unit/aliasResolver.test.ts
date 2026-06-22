import { describe, it, expect } from 'vitest';
import { resolveAlias, extractCTEColumns, filterColumnsByPrefix, AliasResolution } from '../../server/src/aliasResolver';
import { TableReference } from '../../server/src/completionProvider';
import { ISchemaCache, ColumnInfo, TableInfo, ViewInfo } from '../../server/src/schemaCache';

// --- Test Helpers ---

function makeColumn(name: string, dataType = 'int', isNullable = false): ColumnInfo {
  return { name, dataType, isNullable };
}

function makeTable(schema: string, name: string, columns: ColumnInfo[]): TableInfo {
  return { schema, name, columns };
}

function makeView(schema: string, name: string, columns: ColumnInfo[]): ViewInfo {
  return { schema, name, columns };
}

function makeSchemaCache(tables: TableInfo[] = [], views: ViewInfo[] = []): ISchemaCache {
  return {
    tables,
    views,
    procedures: [],
    foreignKeys: [],
    isPopulating: false,
    refresh: async () => {},
    getForeignKeysForTable: () => [],
  };
}

// --- Tests ---

describe('aliasResolver', () => {
  describe('resolveAlias', () => {
    describe('multi-join queries with multiple aliases (Req 3.1, 3.2, 3.4)', () => {
      const usersColumns = [makeColumn('UserId', 'int'), makeColumn('UserName', 'nvarchar'), makeColumn('Email', 'nvarchar', true)];
      const ordersColumns = [makeColumn('OrderId', 'int'), makeColumn('UserId', 'int'), makeColumn('OrderDate', 'datetime')];
      const productsColumns = [makeColumn('ProductId', 'int'), makeColumn('ProductName', 'nvarchar'), makeColumn('Price', 'decimal')];

      const schemaCache = makeSchemaCache([
        makeTable('dbo', 'Users', usersColumns),
        makeTable('dbo', 'Orders', ordersColumns),
        makeTable('dbo', 'Products', productsColumns),
      ]);

      const tableRefs: TableReference[] = [
        { schema: 'dbo', name: 'Users', alias: 'u' },
        { schema: 'dbo', name: 'Orders', alias: 'o' },
        { schema: 'dbo', name: 'Products', alias: 'p' },
      ];

      it('resolves first alias to its table columns', () => {
        const result = resolveAlias('u', tableRefs, new Map(), schemaCache);
        expect(result.found).toBe(true);
        expect(result.isSchemaName).toBe(false);
        expect(result.columns).toEqual(usersColumns);
      });

      it('resolves second alias to its table columns', () => {
        const result = resolveAlias('o', tableRefs, new Map(), schemaCache);
        expect(result.found).toBe(true);
        expect(result.columns).toEqual(ordersColumns);
      });

      it('resolves third alias to its table columns', () => {
        const result = resolveAlias('p', tableRefs, new Map(), schemaCache);
        expect(result.found).toBe(true);
        expect(result.columns).toEqual(productsColumns);
      });

      it('returns only the columns for the specific alias, not other tables', () => {
        const result = resolveAlias('u', tableRefs, new Map(), schemaCache);
        expect(result.columns).not.toContainEqual(expect.objectContaining({ name: 'OrderId' }));
        expect(result.columns).not.toContainEqual(expect.objectContaining({ name: 'ProductId' }));
      });

      it('resolves aliases case-insensitively', () => {
        const result = resolveAlias('U', tableRefs, new Map(), schemaCache);
        expect(result.found).toBe(true);
        expect(result.columns).toEqual(usersColumns);
      });

      it('supports AS keyword aliases (same structure as implicit)', () => {
        // AS keyword vs implicit alias both produce the same TableReference shape
        const refsWithAs: TableReference[] = [
          { schema: 'dbo', name: 'Users', alias: 'usr' },
          { schema: 'dbo', name: 'Orders', alias: 'ord' },
        ];
        const result = resolveAlias('usr', refsWithAs, new Map(), schemaCache);
        expect(result.found).toBe(true);
        expect(result.columns).toEqual(usersColumns);
      });
    });

    describe('self-joins (same table, different aliases) (Req 3.1, 3.2)', () => {
      const employeeColumns = [
        makeColumn('EmployeeId', 'int'),
        makeColumn('Name', 'nvarchar'),
        makeColumn('ManagerId', 'int', true),
      ];

      const schemaCache = makeSchemaCache([
        makeTable('dbo', 'Employees', employeeColumns),
      ]);

      const selfJoinRefs: TableReference[] = [
        { schema: 'dbo', name: 'Employees', alias: 'e' },
        { schema: 'dbo', name: 'Employees', alias: 'mgr' },
      ];

      it('resolves first alias of self-join to the table columns', () => {
        const result = resolveAlias('e', selfJoinRefs, new Map(), schemaCache);
        expect(result.found).toBe(true);
        expect(result.columns).toEqual(employeeColumns);
      });

      it('resolves second alias of self-join to the same table columns', () => {
        const result = resolveAlias('mgr', selfJoinRefs, new Map(), schemaCache);
        expect(result.found).toBe(true);
        expect(result.columns).toEqual(employeeColumns);
      });

      it('both aliases resolve independently to the same column set', () => {
        const resultE = resolveAlias('e', selfJoinRefs, new Map(), schemaCache);
        const resultMgr = resolveAlias('mgr', selfJoinRefs, new Map(), schemaCache);
        expect(resultE.columns).toEqual(resultMgr.columns);
      });
    });

    describe('CTE references (Req 3.7)', () => {
      const schemaCache = makeSchemaCache();

      it('resolves CTE alias with explicit column list', () => {
        const cteColumns = new Map<string, ColumnInfo[]>();
        cteColumns.set('activecustomers', [
          makeColumn('CustomerId', 'int'),
          makeColumn('FullName', 'nvarchar'),
        ]);

        const result = resolveAlias('ActiveCustomers', [], cteColumns, schemaCache);
        expect(result.found).toBe(true);
        expect(result.isSchemaName).toBe(false);
        expect(result.columns).toHaveLength(2);
        expect(result.columns[0].name).toBe('CustomerId');
        expect(result.columns[1].name).toBe('FullName');
      });

      it('resolves CTE alias case-insensitively', () => {
        const cteColumns = new Map<string, ColumnInfo[]>();
        cteColumns.set('mycte', [makeColumn('Id', 'int')]);

        const result = resolveAlias('MyCTE', [], cteColumns, schemaCache);
        expect(result.found).toBe(true);
        expect(result.columns).toHaveLength(1);
      });

      it('returns empty columns for CTE with SELECT * (stored as empty array)', () => {
        const cteColumns = new Map<string, ColumnInfo[]>();
        cteColumns.set('alldata', []);

        const result = resolveAlias('alldata', [], cteColumns, schemaCache);
        expect(result.found).toBe(true);
        expect(result.columns).toEqual([]);
      });

      it('table alias takes priority over CTE name when both match', () => {
        const cteColumns = new Map<string, ColumnInfo[]>();
        cteColumns.set('u', [makeColumn('CteCol', 'int')]);

        const usersColumns = [makeColumn('UserId', 'int')];
        const cache = makeSchemaCache([makeTable('dbo', 'Users', usersColumns)]);
        const refs: TableReference[] = [{ schema: 'dbo', name: 'Users', alias: 'u' }];

        const result = resolveAlias('u', refs, cteColumns, cache);
        expect(result.found).toBe(true);
        // Table alias takes priority (step 1 before step 2)
        expect(result.columns).toEqual(usersColumns);
      });
    });

    describe('CTE alias resolution via FROM/JOIN (Req 7.1, 7.2, 7.6)', () => {
      it('resolves alias pointing to a CTE name (FROM my_cte c → c.)', () => {
        const cteColumns = new Map<string, ColumnInfo[]>();
        cteColumns.set('my_cte', [makeColumn('Id', 'int'), makeColumn('Name', 'nvarchar')]);

        const cache = makeSchemaCache(); // empty cache — CTE not in schema
        const refs: TableReference[] = [{ name: 'my_cte', alias: 'c' }];

        const result = resolveAlias('c', refs, cteColumns, cache);
        expect(result.found).toBe(true);
        expect(result.isSchemaName).toBe(false);
        expect(result.columns).toHaveLength(2);
        expect(result.columns[0].name).toBe('Id');
        expect(result.columns[1].name).toBe('Name');
      });

      it('resolves CTE alias case-insensitively for the CTE name lookup', () => {
        const cteColumns = new Map<string, ColumnInfo[]>();
        cteColumns.set('activecustomers', [makeColumn('CustomerId', 'int')]);

        const cache = makeSchemaCache();
        const refs: TableReference[] = [{ name: 'ActiveCustomers', alias: 'ac' }];

        const result = resolveAlias('ac', refs, cteColumns, cache);
        expect(result.found).toBe(true);
        expect(result.columns).toHaveLength(1);
        expect(result.columns[0].name).toBe('CustomerId');
      });

      it('table alias to real table takes priority over CTE alias (Req 7.6)', () => {
        // Both a real table and a CTE have the same name
        const cteColumns = new Map<string, ColumnInfo[]>();
        cteColumns.set('users', [makeColumn('CteCol', 'int')]);

        const usersColumns = [makeColumn('UserId', 'int'), makeColumn('Email', 'nvarchar')];
        const cache = makeSchemaCache([makeTable('dbo', 'Users', usersColumns)]);
        // Alias 'u' points to 'Users' which exists in both schema cache and CTE map
        const refs: TableReference[] = [{ schema: 'dbo', name: 'Users', alias: 'u' }];

        const result = resolveAlias('u', refs, cteColumns, cache);
        expect(result.found).toBe(true);
        // Schema cache columns win because the table was found in the cache
        expect(result.columns).toEqual(usersColumns);
      });

      it('returns empty columns when CTE alias points to SELECT * CTE', () => {
        const cteColumns = new Map<string, ColumnInfo[]>();
        cteColumns.set('alldata', []); // SELECT * → empty array

        const cache = makeSchemaCache();
        const refs: TableReference[] = [{ name: 'alldata', alias: 'a' }];

        const result = resolveAlias('a', refs, cteColumns, cache);
        expect(result.found).toBe(true);
        expect(result.columns).toEqual([]);
      });

      it('direct CTE name match still works without alias (Step 3)', () => {
        const cteColumns = new Map<string, ColumnInfo[]>();
        cteColumns.set('my_cte', [makeColumn('Val', 'int')]);

        const cache = makeSchemaCache();
        // No table references — user typed the CTE name directly
        const result = resolveAlias('my_cte', [], cteColumns, cache);
        expect(result.found).toBe(true);
        expect(result.columns).toHaveLength(1);
        expect(result.columns[0].name).toBe('Val');
      });

      it('table alias takes priority over direct CTE name match (Req 7.6)', () => {
        // CTE named 'orders' exists, but there's also a table alias 'orders'
        const cteColumns = new Map<string, ColumnInfo[]>();
        cteColumns.set('orders', [makeColumn('CteOrderId', 'int')]);

        const ordersColumns = [makeColumn('OrderId', 'int'), makeColumn('Amount', 'decimal')];
        const cache = makeSchemaCache([makeTable('dbo', 'Orders', ordersColumns)]);
        const refs: TableReference[] = [{ schema: 'dbo', name: 'Orders', alias: 'orders' }];

        const result = resolveAlias('orders', refs, cteColumns, cache);
        expect(result.found).toBe(true);
        // Table alias resolves from schema cache, takes priority over direct CTE name
        expect(result.columns).toEqual(ordersColumns);
      });
    });

    describe('disconnected state / empty schema cache (Req 3.6)', () => {
      it('returns empty when schema cache has no tables and alias not found', () => {
        const emptyCache = makeSchemaCache();
        const refs: TableReference[] = [{ schema: 'dbo', name: 'Users', alias: 'u' }];

        // The alias is found in refs, but the table is not in the cache
        const result = resolveAlias('u', refs, new Map(), emptyCache);
        expect(result.found).toBe(true);
        expect(result.columns).toEqual([]); // Table not in cache → no columns
      });

      it('returns not found for unknown alias with empty cache', () => {
        const emptyCache = makeSchemaCache();
        const result = resolveAlias('x', [], new Map(), emptyCache);
        expect(result.found).toBe(false);
        expect(result.isSchemaName).toBe(false);
        expect(result.columns).toEqual([]);
      });

      it('returns empty for empty alias string', () => {
        const cache = makeSchemaCache([makeTable('dbo', 'Users', [makeColumn('Id', 'int')])]);
        const result = resolveAlias('', [], new Map(), cache);
        expect(result.found).toBe(false);
        expect(result.columns).toEqual([]);
      });

      it('returns not found when no table references and no CTEs exist', () => {
        const cache = makeSchemaCache([makeTable('dbo', 'Users', [makeColumn('Id', 'int')])]);
        const result = resolveAlias('u', [], new Map(), cache);
        expect(result.found).toBe(false);
        expect(result.columns).toEqual([]);
      });
    });

    describe('schema name fallthrough (Req 3.9)', () => {
      it('detects schema name and sets isSchemaName flag', () => {
        const cache = makeSchemaCache([makeTable('sales', 'Orders', [makeColumn('Id', 'int')])]);
        const result = resolveAlias('sales', [], new Map(), cache);
        expect(result.found).toBe(false);
        expect(result.isSchemaName).toBe(true);
        expect(result.columns).toEqual([]);
      });

      it('alias takes priority over schema name', () => {
        const cache = makeSchemaCache([
          makeTable('dbo', 'Users', [makeColumn('Id', 'int')]),
          makeTable('dbo', 'SalesTable', [makeColumn('Amount', 'decimal')]),
        ]);
        // 'dbo' is a schema name, but if it's also an alias, alias wins
        const refs: TableReference[] = [{ schema: 'dbo', name: 'Users', alias: 'dbo' }];
        const result = resolveAlias('dbo', refs, new Map(), cache);
        expect(result.found).toBe(true);
        expect(result.isSchemaName).toBe(false);
      });
    });

    describe('view resolution', () => {
      it('resolves alias pointing to a view', () => {
        const viewColumns = [makeColumn('OrderId', 'int'), makeColumn('Total', 'money')];
        const cache = makeSchemaCache([], [makeView('dbo', 'vw_OrderSummary', viewColumns)]);
        const refs: TableReference[] = [{ schema: 'dbo', name: 'vw_OrderSummary', alias: 'os' }];

        const result = resolveAlias('os', refs, new Map(), cache);
        expect(result.found).toBe(true);
        expect(result.columns).toEqual(viewColumns);
      });
    });

    describe('unqualified table references', () => {
      it('resolves alias for table without schema (defaults to dbo)', () => {
        const columns = [makeColumn('Id', 'int'), makeColumn('Name', 'nvarchar')];
        const cache = makeSchemaCache([makeTable('dbo', 'Categories', columns)]);
        const refs: TableReference[] = [{ name: 'Categories', alias: 'c' }];

        const result = resolveAlias('c', refs, new Map(), cache);
        expect(result.found).toBe(true);
        expect(result.columns).toEqual(columns);
      });
    });
  });

  describe('extractCTEColumns', () => {
    it('extracts simple column names from SELECT list', () => {
      const body = 'SELECT Id, Name, Email FROM Users WHERE Active = 1';
      const result = extractCTEColumns(body);
      expect(result).not.toBeNull();
      expect(result!.map(c => c.name)).toEqual(['Id', 'Name', 'Email']);
    });

    it('extracts aliased columns (AS keyword)', () => {
      const body = 'SELECT u.UserId AS Id, u.UserName AS Name FROM Users u';
      const result = extractCTEColumns(body);
      expect(result).not.toBeNull();
      expect(result!.map(c => c.name)).toEqual(['Id', 'Name']);
    });

    it('returns null for SELECT *', () => {
      const body = 'SELECT * FROM Users';
      const result = extractCTEColumns(body);
      expect(result).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(extractCTEColumns('')).toBeNull();
      expect(extractCTEColumns('   ')).toBeNull();
    });

    it('returns null for input without SELECT', () => {
      expect(extractCTEColumns('INSERT INTO Users VALUES (1)')).toBeNull();
    });

    it('handles DISTINCT keyword before columns', () => {
      const body = 'SELECT DISTINCT CustomerId, OrderDate FROM Orders';
      const result = extractCTEColumns(body);
      expect(result).not.toBeNull();
      expect(result!.map(c => c.name)).toEqual(['CustomerId', 'OrderDate']);
    });

    it('handles TOP N before columns', () => {
      const body = 'SELECT TOP 10 Id, Name FROM Users';
      const result = extractCTEColumns(body);
      expect(result).not.toBeNull();
      expect(result!.map(c => c.name)).toEqual(['Id', 'Name']);
    });

    it('extracts dotted column references (takes last part)', () => {
      const body = 'SELECT u.UserId, u.UserName FROM Users u';
      const result = extractCTEColumns(body);
      expect(result).not.toBeNull();
      expect(result!.map(c => c.name)).toEqual(['UserId', 'UserName']);
    });

    it('handles function calls in SELECT list', () => {
      const body = 'SELECT COUNT(*) AS Total, MAX(Price) AS MaxPrice FROM Products';
      const result = extractCTEColumns(body);
      expect(result).not.toBeNull();
      expect(result!.map(c => c.name)).toEqual(['Total', 'MaxPrice']);
    });

    it('ignores comments in CTE body', () => {
      const body = `SELECT 
        -- this is a comment
        Id, Name 
        FROM Users`;
      const result = extractCTEColumns(body);
      expect(result).not.toBeNull();
      expect(result!.map(c => c.name)).toEqual(['Id', 'Name']);
    });

    it('sets dataType to unknown for extracted columns', () => {
      const body = 'SELECT Id, Name FROM Users';
      const result = extractCTEColumns(body);
      expect(result).not.toBeNull();
      for (const col of result!) {
        expect(col.dataType).toBe('unknown');
      }
    });

    it('sets isNullable to true for extracted columns', () => {
      const body = 'SELECT Id, Name FROM Users';
      const result = extractCTEColumns(body);
      expect(result).not.toBeNull();
      for (const col of result!) {
        expect(col.isNullable).toBe(true);
      }
    });
  });

  describe('filterColumnsByPrefix', () => {
    const columns: ColumnInfo[] = [
      makeColumn('UserId', 'int'),
      makeColumn('UserName', 'nvarchar'),
      makeColumn('Email', 'nvarchar'),
      makeColumn('UpdatedAt', 'datetime'),
    ];

    it('returns all columns when prefix is empty', () => {
      expect(filterColumnsByPrefix(columns, '')).toEqual(columns);
    });

    it('filters columns by prefix (case-insensitive)', () => {
      const result = filterColumnsByPrefix(columns, 'user');
      expect(result).toHaveLength(2);
      expect(result.map(c => c.name)).toEqual(['UserId', 'UserName']);
    });

    it('filters with uppercase prefix', () => {
      const result = filterColumnsByPrefix(columns, 'USER');
      expect(result).toHaveLength(2);
      expect(result.map(c => c.name)).toEqual(['UserId', 'UserName']);
    });

    it('returns single match for unique prefix', () => {
      const result = filterColumnsByPrefix(columns, 'Em');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Email');
    });

    it('returns empty array when no columns match prefix', () => {
      const result = filterColumnsByPrefix(columns, 'xyz');
      expect(result).toHaveLength(0);
    });

    it('returns empty array for empty column list', () => {
      const result = filterColumnsByPrefix([], 'user');
      expect(result).toHaveLength(0);
    });

    it('matches prefix "U" to all columns starting with U', () => {
      const result = filterColumnsByPrefix(columns, 'U');
      expect(result).toHaveLength(3); // UserId, UserName, UpdatedAt
    });
  });
});
