import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { QueryResult } from '../../src/types';

// Mock vscode module
const mockWebview = {
  options: {} as any,
  html: '',
  postMessage: vi.fn().mockResolvedValue(true),
  onDidReceiveMessage: vi.fn(),
  cspSource: '',
  asWebviewUri: vi.fn((uri: any) => uri),
};

const mockWebviewView = {
  webview: mockWebview,
  show: vi.fn(),
  onDidDispose: vi.fn(),
  visible: true,
  viewType: 'sqlServerResults',
};

vi.mock('vscode', () => ({
  Uri: {
    file: (path: string) => ({ fsPath: path, scheme: 'file' }),
    joinPath: (...args: any[]) => ({ fsPath: args.join('/') }),
  },
  window: {
    showErrorMessage: vi.fn(),
  },
  ViewColumn: { Beside: 2 },
  commands: {
    executeCommand: vi.fn(),
  },
  workspace: {
    openTextDocument: vi.fn().mockResolvedValue({}),
  },
}));

import { ResultPanelProvider } from '../../src/resultPanelProvider';
import { QueryExecutor } from '../../src/queryExecutor';

describe('ResultPanelProvider — Pagination', () => {
  let provider: ResultPanelProvider;
  let messageHandler: (msg: any) => void;
  const mockExtensionUri = { fsPath: '/test/extension', scheme: 'file' } as any;

  // Mock pool for pagination
  const mockCountRecordset = [{ total: 25000 }];
  const mockCountResult = { recordset: mockCountRecordset };
  const mockRequest = { query: vi.fn().mockResolvedValue(mockCountResult) };
  const mockPool = { request: vi.fn().mockReturnValue(mockRequest) } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWebview.html = '';
    mockWebview.postMessage.mockResolvedValue(true);
    mockWebviewView.onDidDispose.mockImplementation(() => {});
    mockWebview.onDidReceiveMessage.mockImplementation((handler: any) => {
      messageHandler = handler;
    });
    mockRequest.query.mockResolvedValue(mockCountResult);
    mockPool.request.mockReturnValue(mockRequest);

    provider = new ResultPanelProvider(mockExtensionUri);
    provider.resolveWebviewView(
      mockWebviewView as any,
      {} as any,
      {} as any
    );
    // Clear postMessage calls from resolveWebviewView
    mockWebview.postMessage.mockClear();
  });

  describe('showWithPagination — Show More button visibility (Req 1.2)', () => {
    it('should set totalRowsAvailable on result set when rows > 10,000', async () => {
      const result: QueryResult = {
        resultSets: [{
          columns: [{ name: 'id', dataType: 'int' }],
          rows: new Array(10000).fill([1]),
          rowCount: 10000,
        }],
        rowsAffected: 0,
        executionTimeMs: 100,
      };

      await provider.showWithPagination(result, 'SELECT id FROM large_table', mockPool);

      // The posted message should have totalRowsAvailable set
      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'data',
          result: expect.objectContaining({
            resultSets: expect.arrayContaining([
              expect.objectContaining({ totalRowsAvailable: 25000 }),
            ]),
          }),
        })
      );
    });

    it('should NOT set pagination state when result has < 10,000 rows', async () => {
      const result: QueryResult = {
        resultSets: [{
          columns: [{ name: 'id', dataType: 'int' }],
          rows: new Array(500).fill([1]),
          rowCount: 500,
        }],
        rowsAffected: 0,
        executionTimeMs: 50,
      };

      await provider.showWithPagination(result, 'SELECT id FROM small_table', mockPool);

      // Pool should not be queried for count when rows < 10000
      expect(mockPool.request).not.toHaveBeenCalled();

      // The result should be posted without totalRowsAvailable
      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'data',
          result: expect.objectContaining({
            resultSets: expect.arrayContaining([
              expect.not.objectContaining({ totalRowsAvailable: expect.anything() }),
            ]),
          }),
        })
      );
    });

    it('should NOT set pagination when COUNT returns <= 10,000', async () => {
      const mockCountSmall = { recordset: [{ total: 10000 }] };
      mockRequest.query.mockResolvedValue(mockCountSmall);

      const result: QueryResult = {
        resultSets: [{
          columns: [{ name: 'id', dataType: 'int' }],
          rows: new Array(10000).fill([1]),
          rowCount: 10000,
        }],
        rowsAffected: 0,
        executionTimeMs: 100,
      };

      await provider.showWithPagination(result, 'SELECT id FROM exact_10k', mockPool);

      // totalRowsAvailable should NOT be set when total == 10000
      const postedMsg = mockWebview.postMessage.mock.calls[0][0];
      expect(postedMsg.result.resultSets[0].totalRowsAvailable).toBeUndefined();
    });
  });

  describe('handleRequestBatchMessage — fetchBatch call (Req 1.3)', () => {
    it('should call fetchBatch on QueryExecutor when requestBatch message is received', async () => {
      // Set up pagination state first
      const result: QueryResult = {
        resultSets: [{
          columns: [{ name: 'id', dataType: 'int' }],
          rows: new Array(10000).fill([1]),
          rowCount: 10000,
        }],
        rowsAffected: 0,
        executionTimeMs: 100,
      };

      await provider.showWithPagination(result, 'SELECT id FROM big_table', mockPool);
      mockWebview.postMessage.mockClear();

      // Capture the state at call time via a custom mock
      let capturedLoadedRows: number | undefined;
      const mockExecutor = {
        fetchBatch: vi.fn().mockImplementation((state: any) => {
          capturedLoadedRows = state.loadedRows;
          return Promise.resolve({
            rows: new Array(10000).fill([2]),
            columns: [{ name: 'id', dataType: 'int' }],
          });
        }),
      } as unknown as QueryExecutor;
      provider.setQueryExecutor(mockExecutor);

      // Trigger requestBatch from webview
      await messageHandler({ type: 'requestBatch', resultSetIndex: 0 });

      // Verify fetchBatch was called
      expect(mockExecutor.fetchBatch).toHaveBeenCalledTimes(1);

      // Verify the state at call time had the correct loadedRows (before mutation)
      expect(capturedLoadedRows).toBe(10000);

      // Verify the other state properties (these don't mutate)
      const callArg = (mockExecutor.fetchBatch as any).mock.calls[0][0];
      expect(callArg.originalSql).toBe('SELECT id FROM big_table');
      expect(callArg.pool).toBe(mockPool);
      expect(callArg.totalRowsAvailable).toBe(25000);
      expect(callArg.batchSize).toBe(10000);
      expect(callArg.resultSetIndex).toBe(0);
    });

    it('should post appendBatch message with new rows after successful fetch', async () => {
      const result: QueryResult = {
        resultSets: [{
          columns: [{ name: 'id', dataType: 'int' }],
          rows: new Array(10000).fill([1]),
          rowCount: 10000,
        }],
        rowsAffected: 0,
        executionTimeMs: 100,
      };

      await provider.showWithPagination(result, 'SELECT id FROM big_table', mockPool);
      mockWebview.postMessage.mockClear();

      const batchRows = new Array(10000).fill([2]);
      const mockExecutor = {
        fetchBatch: vi.fn().mockResolvedValue({
          rows: batchRows,
          columns: [{ name: 'id', dataType: 'int' }],
        }),
      } as unknown as QueryExecutor;
      provider.setQueryExecutor(mockExecutor);

      await messageHandler({ type: 'requestBatch', resultSetIndex: 0 });

      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'appendBatch',
          rows: batchRows,
          totalRowsAvailable: 25000,
          loadedSoFar: 20000,
        })
      );
    });

    it('should post batchError when no query executor is set', async () => {
      // Set up pagination state but don't set queryExecutor
      const result: QueryResult = {
        resultSets: [{
          columns: [{ name: 'id', dataType: 'int' }],
          rows: new Array(10000).fill([1]),
          rowCount: 10000,
        }],
        rowsAffected: 0,
        executionTimeMs: 100,
      };

      await provider.showWithPagination(result, 'SELECT id FROM big_table', mockPool);
      mockWebview.postMessage.mockClear();

      await messageHandler({ type: 'requestBatch', resultSetIndex: 0 });

      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'batchError',
          message: 'No query executor available.',
        })
      );
    });
  });

  describe('loading state — button disabled during fetch (Req 1.7)', () => {
    it('should set isFetchingBatch flag during active fetch', async () => {
      const result: QueryResult = {
        resultSets: [{
          columns: [{ name: 'id', dataType: 'int' }],
          rows: new Array(10000).fill([1]),
          rowCount: 10000,
        }],
        rowsAffected: 0,
        executionTimeMs: 100,
      };

      await provider.showWithPagination(result, 'SELECT id FROM big_table', mockPool);
      mockWebview.postMessage.mockClear();

      // Use a deferred promise to control when fetchBatch resolves
      let resolveFetch!: (value: any) => void;
      const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });

      const mockExecutor = {
        fetchBatch: vi.fn().mockReturnValue(fetchPromise),
      } as unknown as QueryExecutor;
      provider.setQueryExecutor(mockExecutor);

      // Start the fetch (don't await it yet)
      const fetchCall = messageHandler({ type: 'requestBatch', resultSetIndex: 0 });

      // While fetch is in progress, a second request should be silently ignored
      await messageHandler({ type: 'requestBatch', resultSetIndex: 0 });

      // fetchBatch should only have been called once
      expect(mockExecutor.fetchBatch).toHaveBeenCalledTimes(1);

      // Resolve the fetch
      resolveFetch({ rows: [[1]], columns: [{ name: 'id', dataType: 'int' }] });
      await fetchCall;
    });
  });

  describe('duplicate click ignored during active fetch (Req 1.10)', () => {
    it('should reject duplicate requestBatch while fetch is in progress', async () => {
      const result: QueryResult = {
        resultSets: [{
          columns: [{ name: 'id', dataType: 'int' }],
          rows: new Array(10000).fill([1]),
          rowCount: 10000,
        }],
        rowsAffected: 0,
        executionTimeMs: 100,
      };

      await provider.showWithPagination(result, 'SELECT id FROM big_table', mockPool);
      mockWebview.postMessage.mockClear();

      let resolveFetch!: (value: any) => void;
      const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });

      const mockExecutor = {
        fetchBatch: vi.fn().mockReturnValue(fetchPromise),
      } as unknown as QueryExecutor;
      provider.setQueryExecutor(mockExecutor);

      // First request starts fetching
      const firstCall = messageHandler({ type: 'requestBatch', resultSetIndex: 0 });

      // Second request while first is in-flight should be silently ignored
      await messageHandler({ type: 'requestBatch', resultSetIndex: 0 });

      // Third request also ignored
      await messageHandler({ type: 'requestBatch', resultSetIndex: 0 });

      // fetchBatch should only be called once
      expect(mockExecutor.fetchBatch).toHaveBeenCalledTimes(1);

      // No error messages should be posted for duplicate clicks
      expect(mockWebview.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'batchError' })
      );

      // Complete the fetch
      resolveFetch({ rows: [[1]], columns: [{ name: 'id', dataType: 'int' }] });
      await firstCall;
    });

    it('should allow new request after previous fetch completes', async () => {
      const result: QueryResult = {
        resultSets: [{
          columns: [{ name: 'id', dataType: 'int' }],
          rows: new Array(10000).fill([1]),
          rowCount: 10000,
        }],
        rowsAffected: 0,
        executionTimeMs: 100,
      };

      await provider.showWithPagination(result, 'SELECT id FROM big_table', mockPool);
      mockWebview.postMessage.mockClear();

      const mockExecutor = {
        fetchBatch: vi.fn().mockResolvedValue({
          rows: new Array(5000).fill([2]),
          columns: [{ name: 'id', dataType: 'int' }],
        }),
      } as unknown as QueryExecutor;
      provider.setQueryExecutor(mockExecutor);

      // First request completes normally
      await messageHandler({ type: 'requestBatch', resultSetIndex: 0 });

      // Second request should also be accepted (first completed)
      await messageHandler({ type: 'requestBatch', resultSetIndex: 0 });

      // fetchBatch should have been called twice
      expect(mockExecutor.fetchBatch).toHaveBeenCalledTimes(2);
    });
  });

  describe('connection error retains previously loaded data (Req 1.8)', () => {
    it('should post batchError and retain pagination state on connection failure', async () => {
      const result: QueryResult = {
        resultSets: [{
          columns: [{ name: 'id', dataType: 'int' }],
          rows: new Array(10000).fill([1]),
          rowCount: 10000,
        }],
        rowsAffected: 0,
        executionTimeMs: 100,
      };

      await provider.showWithPagination(result, 'SELECT id FROM big_table', mockPool);
      mockWebview.postMessage.mockClear();

      const mockExecutor = {
        fetchBatch: vi.fn().mockResolvedValue({ error: 'Connection lost - network error' }),
      } as unknown as QueryExecutor;
      provider.setQueryExecutor(mockExecutor);

      await messageHandler({ type: 'requestBatch', resultSetIndex: 0 });

      // Should post a batchError message
      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'batchError',
          message: 'Connection lost - network error',
        })
      );

      // Should NOT have posted appendBatch
      expect(mockWebview.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'appendBatch' })
      );
    });

    it('should allow retry after connection error (pagination state preserved)', async () => {
      const result: QueryResult = {
        resultSets: [{
          columns: [{ name: 'id', dataType: 'int' }],
          rows: new Array(10000).fill([1]),
          rowCount: 10000,
        }],
        rowsAffected: 0,
        executionTimeMs: 100,
      };

      await provider.showWithPagination(result, 'SELECT id FROM big_table', mockPool);
      mockWebview.postMessage.mockClear();

      const mockExecutor = {
        fetchBatch: vi.fn()
          // First call fails
          .mockResolvedValueOnce({ error: 'Connection timeout' })
          // Second call succeeds (retry)
          .mockResolvedValueOnce({
            rows: new Array(10000).fill([2]),
            columns: [{ name: 'id', dataType: 'int' }],
          }),
      } as unknown as QueryExecutor;
      provider.setQueryExecutor(mockExecutor);

      // First attempt fails
      await messageHandler({ type: 'requestBatch', resultSetIndex: 0 });

      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'batchError' })
      );

      mockWebview.postMessage.mockClear();

      // Retry succeeds — pagination state was preserved so fetchBatch can be called again
      await messageHandler({ type: 'requestBatch', resultSetIndex: 0 });

      expect(mockExecutor.fetchBatch).toHaveBeenCalledTimes(2);
      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'appendBatch',
          loadedSoFar: 20000,
        })
      );
    });

    it('should post batchError when fetchBatch throws an unexpected exception', async () => {
      const result: QueryResult = {
        resultSets: [{
          columns: [{ name: 'id', dataType: 'int' }],
          rows: new Array(10000).fill([1]),
          rowCount: 10000,
        }],
        rowsAffected: 0,
        executionTimeMs: 100,
      };

      await provider.showWithPagination(result, 'SELECT id FROM big_table', mockPool);
      mockWebview.postMessage.mockClear();

      const mockExecutor = {
        fetchBatch: vi.fn().mockRejectedValue(new Error('Unexpected pool closed')),
      } as unknown as QueryExecutor;
      provider.setQueryExecutor(mockExecutor);

      await messageHandler({ type: 'requestBatch', resultSetIndex: 0 });

      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'batchError',
          message: 'Unexpected pool closed',
        })
      );
    });
  });
});
