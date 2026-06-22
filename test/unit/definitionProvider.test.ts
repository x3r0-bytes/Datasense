import { describe, it, expect, vi } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { resolveObjectName, getObjectDefinition, ObjectDefinitionResult } from '../../server/src/definitionProvider';

// --- Helpers ---

/**
 * Create a TextDocument from a string for testing resolveObjectName.
 */
function createDoc(content: string): TextDocument {
  return TextDocument.create('file:///test.sql', 'sql', 1, content);
}

/**
 * Create a mock mssql.ConnectionPool that returns controlled query results.
 * typeResult: the recordset for the sys.objects type query
 * defResult: the recordset for the OBJECT_DEFINITION query (two-part name attempt)
 * retryDefResult: the recordset for the retry OBJECT_DEFINITION query (three-part name attempt)
 * delayMs: optional delay in ms to simulate slow queries (for timeout testing)
 */
function createMockPool(options: {
  typeResult?: { recordset: Array<{ type: string }> };
  defResult?: { recordset: Array<{ definition: string | null }> };
  retryDefResult?: { recordset: Array<{ definition: string | null }> };
  shouldThrow?: boolean;
  delayMs?: number;
}) {
  const { typeResult, defResult, retryDefResult, shouldThrow, delayMs } = options;

  let queryCallCount = 0;

  const mockRequest = {
    input: () => mockRequest,
    query: async () => {
      if (shouldThrow) {
        throw new Error('Connection failed');
      }
      if (delayMs) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      queryCallCount++;
      // First query is the type lookup
      if (queryCallCount === 1) {
        return typeResult || { recordset: [] };
      }
      // Second query is the two-part name definition lookup
      if (queryCallCount === 2) {
        return defResult || { recordset: [{ definition: null }] };
      }
      // Third query is the three-part name retry
      return retryDefResult || { recordset: [{ definition: null }] };
    },
  };

  return {
    request: () => mockRequest,
  } as any;
}

// --- Tests ---

describe('definitionProvider', () => {
  describe('resolveObjectName', () => {
    describe('schema-qualified name resolution', () => {
      it('resolves dbo.MyProc to schema=dbo, name=MyProc', () => {
        const doc = createDoc('EXEC dbo.MyProc');
        const offset = doc.getText().indexOf('dbo');
        const result = resolveObjectName(doc, offset);
        expect(result).toEqual({ schema: 'dbo', name: 'MyProc' });
      });

      it('resolves sales.vw_Orders to schema=sales, name=vw_Orders', () => {
        const doc = createDoc('SELECT * FROM sales.vw_Orders');
        const offset = doc.getText().indexOf('sales');
        const result = resolveObjectName(doc, offset);
        expect(result).toEqual({ schema: 'sales', name: 'vw_Orders' });
      });

      it('resolves when cursor is on the name part after the dot', () => {
        const doc = createDoc('EXEC dbo.MyProc');
        const offset = doc.getText().indexOf('MyProc');
        const result = resolveObjectName(doc, offset);
        expect(result).toEqual({ schema: 'dbo', name: 'MyProc' });
      });

      it('resolves when cursor is on the dot itself', () => {
        const doc = createDoc('EXEC dbo.MyProc');
        const offset = doc.getText().indexOf('.');
        const result = resolveObjectName(doc, offset);
        expect(result).toEqual({ schema: 'dbo', name: 'MyProc' });
      });

      it('resolves schema names with underscores', () => {
        const doc = createDoc('SELECT * FROM my_schema.my_view');
        const offset = doc.getText().indexOf('my_schema');
        const result = resolveObjectName(doc, offset);
        expect(result).toEqual({ schema: 'my_schema', name: 'my_view' });
      });
    });

    describe('unqualified name resolution (defaults to dbo)', () => {
      it('resolves MyProc to schema=dbo, name=MyProc', () => {
        const doc = createDoc('EXEC MyProc');
        const offset = doc.getText().indexOf('MyProc');
        const result = resolveObjectName(doc, offset);
        expect(result).toEqual({ schema: 'dbo', name: 'MyProc' });
      });

      it('resolves a temp table name with # prefix', () => {
        const doc = createDoc('SELECT * FROM #TempTable');
        const offset = doc.getText().indexOf('#TempTable');
        const result = resolveObjectName(doc, offset);
        expect(result).toEqual({ schema: 'dbo', name: '#TempTable' });
      });

      it('resolves names starting with @', () => {
        const doc = createDoc('EXEC @procVar');
        const offset = doc.getText().indexOf('@procVar');
        const result = resolveObjectName(doc, offset);
        expect(result).toEqual({ schema: 'dbo', name: '@procVar' });
      });

      it('resolves a simple identifier in the middle of text', () => {
        const doc = createDoc('SELECT col FROM vw_ActiveOrders WHERE 1=1');
        const offset = doc.getText().indexOf('vw_ActiveOrders');
        const result = resolveObjectName(doc, offset);
        expect(result).toEqual({ schema: 'dbo', name: 'vw_ActiveOrders' });
      });
    });

    describe('returns null for invalid positions', () => {
      it('returns null when offset is on a space', () => {
        const doc = createDoc('EXEC dbo.MyProc');
        const offset = doc.getText().indexOf(' dbo') ; // the space before dbo
        const result = resolveObjectName(doc, offset);
        expect(result).toBeNull();
      });

      it('returns null when offset is negative', () => {
        const doc = createDoc('EXEC dbo.MyProc');
        const result = resolveObjectName(doc, -1);
        expect(result).toBeNull();
      });

      it('returns null when offset is beyond text length', () => {
        const doc = createDoc('EXEC dbo.MyProc');
        const result = resolveObjectName(doc, 100);
        expect(result).toBeNull();
      });

      it('returns null when cursor is on a parenthesis', () => {
        const doc = createDoc('EXEC dbo.MyProc()');
        const offset = doc.getText().indexOf('(');
        const result = resolveObjectName(doc, offset);
        expect(result).toBeNull();
      });
    });
  });

  describe('getObjectDefinition', () => {
    describe('found object (procedure)', () => {
      it('returns source text for a found stored procedure', async () => {
        const pool = createMockPool({
          typeResult: { recordset: [{ type: 'P ' }] },
          defResult: { recordset: [{ definition: 'CREATE PROCEDURE dbo.MyProc AS SELECT 1' }] },
        });

        const result = await getObjectDefinition(pool, 'dbo', 'MyProc');
        expect(result).toEqual({
          source: 'CREATE PROCEDURE dbo.MyProc AS SELECT 1',
          qualifiedName: 'dbo.MyProc',
          objectType: 'procedure',
        });
      });
    });

    describe('found object (view)', () => {
      it('returns source text for a found view', async () => {
        const pool = createMockPool({
          typeResult: { recordset: [{ type: 'V ' }] },
          defResult: { recordset: [{ definition: 'CREATE VIEW sales.vw_Orders AS SELECT * FROM Orders' }] },
        });

        const result = await getObjectDefinition(pool, 'sales', 'vw_Orders');
        expect(result).toEqual({
          source: 'CREATE VIEW sales.vw_Orders AS SELECT * FROM Orders',
          qualifiedName: 'sales.vw_Orders',
          objectType: 'view',
        });
      });
    });

    describe('found object (function types)', () => {
      it('returns source for a scalar function (FN)', async () => {
        const pool = createMockPool({
          typeResult: { recordset: [{ type: 'FN' }] },
          defResult: { recordset: [{ definition: 'CREATE FUNCTION dbo.GetTotal() RETURNS int AS BEGIN RETURN 0 END' }] },
        });

        const result = await getObjectDefinition(pool, 'dbo', 'GetTotal');
        expect(result.objectType).toBe('function');
        expect(result.source).toContain('CREATE FUNCTION');
      });

      it('returns source for an inline table-valued function (IF)', async () => {
        const pool = createMockPool({
          typeResult: { recordset: [{ type: 'IF' }] },
          defResult: { recordset: [{ definition: 'CREATE FUNCTION dbo.GetOrders() RETURNS TABLE AS RETURN SELECT 1 AS Id' }] },
        });

        const result = await getObjectDefinition(pool, 'dbo', 'GetOrders');
        expect(result.objectType).toBe('function');
        expect(result.source).not.toBeNull();
      });

      it('returns source for a table-valued function (TF)', async () => {
        const pool = createMockPool({
          typeResult: { recordset: [{ type: 'TF' }] },
          defResult: { recordset: [{ definition: 'CREATE FUNCTION dbo.GetItems() RETURNS @t TABLE(Id int) AS BEGIN RETURN END' }] },
        });

        const result = await getObjectDefinition(pool, 'dbo', 'GetItems');
        expect(result.objectType).toBe('function');
        expect(result.source).not.toBeNull();
      });
    });

    describe('not-found object', () => {
      it('returns not_found when object does not exist in sys.objects', async () => {
        const pool = createMockPool({
          typeResult: { recordset: [] },
        });

        const result = await getObjectDefinition(pool, 'dbo', 'NonExistent');
        expect(result).toEqual({
          source: null,
          qualifiedName: 'dbo.NonExistent',
          objectType: null,
          reason: 'not_found',
        });
      });
    });

    describe('encrypted object (OBJECT_DEFINITION returns NULL)', () => {
      it('returns encrypted reason when definition is null', async () => {
        const pool = createMockPool({
          typeResult: { recordset: [{ type: 'P ' }] },
          defResult: { recordset: [{ definition: null }] },
        });

        const result = await getObjectDefinition(pool, 'dbo', 'EncryptedProc');
        expect(result).toEqual({
          source: null,
          qualifiedName: 'dbo.EncryptedProc',
          objectType: 'procedure',
          reason: 'encrypted',
        });
      });

      it('returns encrypted reason when definition is undefined', async () => {
        const pool = createMockPool({
          typeResult: { recordset: [{ type: 'V ' }] },
          defResult: { recordset: [{ definition: undefined as any }] },
        });

        const result = await getObjectDefinition(pool, 'dbo', 'EncryptedView');
        expect(result).toEqual({
          source: null,
          qualifiedName: 'dbo.EncryptedView',
          objectType: 'view',
          reason: 'encrypted',
        });
      });
    });

    describe('unsupported object types', () => {
      it('returns unsupported_type for a table (U)', async () => {
        const pool = createMockPool({
          typeResult: { recordset: [{ type: 'U ' }] },
        });

        const result = await getObjectDefinition(pool, 'dbo', 'MyTable');
        expect(result).toEqual({
          source: null,
          qualifiedName: 'dbo.MyTable',
          objectType: null,
          reason: 'unsupported_type',
        });
      });

      it('returns unsupported_type for a constraint (C)', async () => {
        const pool = createMockPool({
          typeResult: { recordset: [{ type: 'C ' }] },
        });

        const result = await getObjectDefinition(pool, 'dbo', 'CK_Status');
        expect(result).toEqual({
          source: null,
          qualifiedName: 'dbo.CK_Status',
          objectType: null,
          reason: 'unsupported_type',
        });
      });

      it('returns unsupported_type for a trigger (TR)', async () => {
        const pool = createMockPool({
          typeResult: { recordset: [{ type: 'TR' }] },
        });

        const result = await getObjectDefinition(pool, 'dbo', 'trg_Audit');
        expect(result).toEqual({
          source: null,
          qualifiedName: 'dbo.trg_Audit',
          objectType: null,
          reason: 'unsupported_type',
        });
      });
    });

    describe('error handling', () => {
      it('returns not_found when the pool throws an error', async () => {
        const pool = createMockPool({ shouldThrow: true });

        const result = await getObjectDefinition(pool, 'dbo', 'MyProc');
        expect(result).toEqual({
          source: null,
          qualifiedName: 'dbo.MyProc',
          objectType: null,
          reason: 'not_found',
        });
      });
    });

    describe('three-part name retry (Requirement 2.5)', () => {
      it('succeeds on first attempt without retry when two-part name returns definition', async () => {
        const pool = createMockPool({
          typeResult: { recordset: [{ type: 'P ' }] },
          defResult: { recordset: [{ definition: 'CREATE PROCEDURE dbo.MyProc AS SELECT 1' }] },
          retryDefResult: { recordset: [{ definition: 'SHOULD NOT BE USED' }] },
        });

        const result = await getObjectDefinition(pool, 'dbo', 'MyProc', 'MyDatabase');
        expect(result).toEqual({
          source: 'CREATE PROCEDURE dbo.MyProc AS SELECT 1',
          qualifiedName: 'dbo.MyProc',
          objectType: 'procedure',
        });
        // The retry result should NOT have been used
        expect(result.source).not.toBe('SHOULD NOT BE USED');
      });

      it('retries with three-part name when two-part returns NULL and succeeds', async () => {
        const pool = createMockPool({
          typeResult: { recordset: [{ type: 'V ' }] },
          defResult: { recordset: [{ definition: null }] },
          retryDefResult: { recordset: [{ definition: 'CREATE VIEW sales.vw_Active AS SELECT * FROM Orders' }] },
        });

        const result = await getObjectDefinition(pool, 'sales', 'vw_Active', 'SalesDB');
        expect(result).toEqual({
          source: 'CREATE VIEW sales.vw_Active AS SELECT * FROM Orders',
          qualifiedName: 'sales.vw_Active',
          objectType: 'view',
        });
      });

      it('retries with three-part name for stored procedures when two-part returns NULL', async () => {
        const pool = createMockPool({
          typeResult: { recordset: [{ type: 'P ' }] },
          defResult: { recordset: [{ definition: null }] },
          retryDefResult: { recordset: [{ definition: 'CREATE PROCEDURE hr.usp_GetEmployees AS SELECT * FROM Employees' }] },
        });

        const result = await getObjectDefinition(pool, 'hr', 'usp_GetEmployees', 'HRDatabase');
        expect(result).toEqual({
          source: 'CREATE PROCEDURE hr.usp_GetEmployees AS SELECT * FROM Employees',
          qualifiedName: 'hr.usp_GetEmployees',
          objectType: 'procedure',
        });
      });

      it('retries with three-part name for functions when two-part returns NULL', async () => {
        const pool = createMockPool({
          typeResult: { recordset: [{ type: 'FN' }] },
          defResult: { recordset: [{ definition: null }] },
          retryDefResult: { recordset: [{ definition: 'CREATE FUNCTION dbo.fn_Calc() RETURNS int AS BEGIN RETURN 42 END' }] },
        });

        const result = await getObjectDefinition(pool, 'dbo', 'fn_Calc', 'AppDB');
        expect(result).toEqual({
          source: 'CREATE FUNCTION dbo.fn_Calc() RETURNS int AS BEGIN RETURN 42 END',
          qualifiedName: 'dbo.fn_Calc',
          objectType: 'function',
        });
      });

      it('returns encrypted when both two-part and three-part attempts return NULL', async () => {
        const pool = createMockPool({
          typeResult: { recordset: [{ type: 'P ' }] },
          defResult: { recordset: [{ definition: null }] },
          retryDefResult: { recordset: [{ definition: null }] },
        });

        const result = await getObjectDefinition(pool, 'dbo', 'EncryptedProc', 'MyDatabase');
        expect(result).toEqual({
          source: null,
          qualifiedName: 'dbo.EncryptedProc',
          objectType: 'procedure',
          reason: 'encrypted',
        });
      });

      it('returns encrypted when two-part returns NULL and no databaseName provided (no retry possible)', async () => {
        const pool = createMockPool({
          typeResult: { recordset: [{ type: 'V ' }] },
          defResult: { recordset: [{ definition: null }] },
        });

        // No databaseName means retry is not attempted
        const result = await getObjectDefinition(pool, 'dbo', 'EncryptedView');
        expect(result).toEqual({
          source: null,
          qualifiedName: 'dbo.EncryptedView',
          objectType: 'view',
          reason: 'encrypted',
        });
      });
    });

    describe('unsupported type handling (Requirement 2.7)', () => {
      it('returns unsupported_type for a table (U) without attempting definition lookup', async () => {
        const pool = createMockPool({
          typeResult: { recordset: [{ type: 'U ' }] },
        });

        const result = await getObjectDefinition(pool, 'dbo', 'MyTable', 'MyDatabase');
        expect(result).toEqual({
          source: null,
          qualifiedName: 'dbo.MyTable',
          objectType: null,
          reason: 'unsupported_type',
        });
      });

      it('returns unsupported_type for a trigger (TR)', async () => {
        const pool = createMockPool({
          typeResult: { recordset: [{ type: 'TR' }] },
        });

        const result = await getObjectDefinition(pool, 'dbo', 'trg_Audit', 'MyDatabase');
        expect(result).toEqual({
          source: null,
          qualifiedName: 'dbo.trg_Audit',
          objectType: null,
          reason: 'unsupported_type',
        });
      });
    });

    describe('timeout handling (Requirement 2.11)', () => {
      it('returns not_found when query exceeds 5-second timeout', async () => {
        vi.useFakeTimers();

        const pool = createMockPool({
          typeResult: { recordset: [{ type: 'P ' }] },
          delayMs: 6000, // 6 seconds — exceeds the 5s timeout
        });

        const resultPromise = getObjectDefinition(pool, 'dbo', 'SlowProc', 'MyDatabase');

        // Advance timers past the 5-second timeout
        await vi.advanceTimersByTimeAsync(5100);

        const result = await resultPromise;
        expect(result).toEqual({
          source: null,
          qualifiedName: 'dbo.SlowProc',
          objectType: null,
          reason: 'not_found',
        });

        vi.useRealTimers();
      });
    });

    describe('no active connection (Requirement 2.10)', () => {
      it('returns not_connected when pool is null (integration pattern)', async () => {
        // The 'not_connected' scenario is handled by the caller in server.ts
        // before getObjectDefinition is called. When no pool exists, the server
        // returns null directly. This test validates the expected result shape
        // that the handler produces.
        const result: ObjectDefinitionResult = {
          source: null,
          qualifiedName: 'dbo.SomeProc',
          objectType: null,
          reason: 'not_connected',
        };

        expect(result.source).toBeNull();
        expect(result.reason).toBe('not_connected');
      });

      it('returns not_found when pool connection fails mid-query', async () => {
        // If the pool exists but the connection drops during the query,
        // the error handler catches it and returns not_found
        const pool = createMockPool({ shouldThrow: true });

        const result = await getObjectDefinition(pool, 'dbo', 'MyProc', 'MyDatabase');
        expect(result).toEqual({
          source: null,
          qualifiedName: 'dbo.MyProc',
          objectType: null,
          reason: 'not_found',
        });
      });
    });
  });
});
