import * as mssql from 'mssql';
import { IQueryExecutor, QueryResult, ResultSet, ColumnMetadata, SqlError } from './types';
import { splitBatches } from './batchSplitter';
import { IQueryHistoryStore, createHistoryRecord } from './queryHistoryStore';
import { PaginatedQueryState } from './webviewProtocol';

const MAX_ROWS_PER_RESULT_SET = 10000;

/** Connection metadata needed for history recording */
export interface ConnectionMeta {
  connectionName: string;
  databaseName: string;
  serverHost: string;
}

export class QueryExecutor implements IQueryExecutor {
  private _isExecuting = false;
  private _isCancelled = false;
  private currentRequest: mssql.Request | null = null;
  private _historyStore: IQueryHistoryStore | undefined;

  get isExecuting(): boolean {
    return this._isExecuting;
  }

  /**
   * Sets an optional history store for persisting executed queries.
   * When set, all completed queries (success or error) are recorded.
   */
  setHistoryStore(store: IQueryHistoryStore): void {
    this._historyStore = store;
  }

  /**
   * Executes SQL text against the provided connection pool.
   * Splits input on GO batch separators, executes batches sequentially,
   * stops on first error, limits result sets to 10,000 rows, and tracks execution time.
   * When a historyStore is set, records the query result with connection metadata.
   */
  async execute(sql: string, pool: mssql.ConnectionPool, connectionMeta?: ConnectionMeta): Promise<QueryResult> {
    this._isExecuting = true;
    this._isCancelled = false;
    const startTime = Date.now();

    const result: QueryResult = {
      resultSets: [],
      rowsAffected: 0,
      executionTimeMs: 0,
    };

    try {
      const batches = splitBatches(sql);

      for (const batch of batches) {
        // If cancelled between batches, stop immediately
        if (this._isCancelled) {
          result.cancelled = true;
          result.cancelMessage = 'Query cancelled';
          break;
        }

        const batchResult = await this.executeBatch(batch, pool);

        // If batch was cancelled, propagate cancellation result
        if (batchResult.cancelled) {
          result.cancelled = true;
          result.cancelMessage = 'Query cancelled';
          break;
        }

        // Accumulate result sets
        result.resultSets.push(...batchResult.resultSets);

        // Accumulate rows affected
        result.rowsAffected += batchResult.rowsAffected;

        // If this batch had an error, stop execution
        if (batchResult.error) {
          result.error = batchResult.error;
          break;
        }
      }
    } catch (err) {
      // Handle unexpected errors not caught at the batch level
      if (this._isCancelled || (err instanceof mssql.RequestError && (err as any).code === 'ECANCEL')) {
        result.cancelled = true;
        result.cancelMessage = 'Query cancelled';
      } else if (err instanceof mssql.RequestError) {
        result.error = {
          number: (err as any).number ?? 0,
          severity: (err as any).class ?? 0,
          message: err.message,
        };
      } else {
        result.error = {
          number: 0,
          severity: 0,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    } finally {
      result.executionTimeMs = Date.now() - startTime;
      this.currentRequest = null;
      this._isExecuting = false;
    }

    // Record query in history (non-blocking, errors swallowed) — skip for cancelled queries
    if (!result.cancelled) {
      await this.recordHistory(sql, result, connectionMeta);
    }

    return result;
  }

  /**
   * Cancels the currently executing request.
   * Sets _isExecuting = false and currentRequest = null immediately to unblock the connection.
   * The pending request.query() promise will reject with ECANCEL, which is caught
   * and converted to a cancellation-specific result.
   */
  cancel(): void {
    if (this.currentRequest) {
      this._isCancelled = true;
      this.currentRequest.cancel();
      this._isExecuting = false;
      this.currentRequest = null;
    }
  }

  /**
   * Fetches the next batch of rows for a paginated query.
   * Wraps the original SQL in a CTE with OFFSET/FETCH NEXT to retrieve
   * the next batch starting at state.loadedRows.
   *
   * On success, returns the rows and column metadata.
   * On failure (connection error, timeout, etc.), returns an error string.
   */
  async fetchBatch(state: PaginatedQueryState): Promise<{ rows: any[][]; columns: ColumnMetadata[] } | { error: string }> {
    const paginatedSql = `;WITH __paginated_cte AS (\n${state.originalSql}\n)\nSELECT * FROM __paginated_cte\nORDER BY (SELECT NULL)\nOFFSET ${state.loadedRows} ROWS\nFETCH NEXT ${state.batchSize} ROWS ONLY`;

    try {
      const request = state.pool.request();
      const response = await request.query(paginatedSql);

      const recordset = response.recordset as mssql.IRecordSet<any>;
      const columns = this.extractColumns(recordset);
      const rows = this.extractRows(recordset, columns);

      return { rows, columns };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: message };
    }
  }

  /**
   * Records a completed query in the history store.
   * Catches and logs any errors without interrupting execution flow.
   */
  private async recordHistory(sql: string, result: QueryResult, connectionMeta?: ConnectionMeta): Promise<void> {
    if (!this._historyStore || !connectionMeta) {
      return;
    }

    try {
      const record = createHistoryRecord(
        sql,
        result,
        connectionMeta.connectionName,
        connectionMeta.databaseName,
        connectionMeta.serverHost
      );
      this._historyStore.addRecord(record);
      await this._historyStore.save();
    } catch (err) {
      // File write errors must not interrupt execution (Requirement 3.6)
      console.warn(
        `[QueryHistory] Failed to record query history: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Executes a single batch and returns its result sets, rows affected, and any error.
   * Detects cancellation (ECANCEL) and returns a cancelled flag instead of a generic error.
   */
  private async executeBatch(
    batch: string,
    pool: mssql.ConnectionPool
  ): Promise<{ resultSets: ResultSet[]; rowsAffected: number; error?: SqlError; cancelled?: boolean }> {
    const request = pool.request();
    this.currentRequest = request;

    // Enable multiple result sets
    request.multiple = true;

    try {
      const response = await request.query(batch);

      const resultSets: ResultSet[] = [];
      let rowsAffected = 0;

      // mssql returns rowsAffected as an array (one per statement)
      if (response.rowsAffected && Array.isArray(response.rowsAffected)) {
        for (const count of response.rowsAffected) {
          if (count >= 0) {
            rowsAffected += count;
          }
        }
      }

      // Process record sets - response.recordsets contains arrays of result sets
      const recordsets = response.recordsets as mssql.IRecordSet<any>[];
      if (recordsets && recordsets.length > 0) {
        for (let i = 0; i < recordsets.length; i++) {
          const recordset = recordsets[i];
          const columns = this.extractColumns(recordset);
          const rows = this.extractRows(recordset, columns);

          resultSets.push({
            columns,
            rows,
            rowCount: rows.length,
          });
        }
      }

      return { resultSets, rowsAffected };
    } catch (err) {
      // Detect cancellation: mssql rejects with code 'ECANCEL' when request.cancel() is called
      if (this._isCancelled || (err instanceof mssql.RequestError && (err as any).code === 'ECANCEL')) {
        return { resultSets: [], rowsAffected: 0, cancelled: true };
      }

      if (err instanceof mssql.RequestError) {
        return {
          resultSets: [],
          rowsAffected: 0,
          error: {
            number: (err as any).number ?? 0,
            severity: (err as any).class ?? 0,
            message: err.message,
          },
        };
      }

      return {
        resultSets: [],
        rowsAffected: 0,
        error: {
          number: 0,
          severity: 0,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  /**
   * Extracts column metadata from a recordset.
   */
  private extractColumns(recordset: mssql.IRecordSet<any>): ColumnMetadata[] {
    const columns: ColumnMetadata[] = [];

    if (recordset.columns) {
      for (const [name, col] of Object.entries(recordset.columns)) {
        columns.push({
          name,
          dataType: (col as any).type?.declaration ?? (col as any).type?.name ?? 'unknown',
        });
      }
    }

    return columns;
  }

  /**
   * Extracts row data from a recordset, limiting to MAX_ROWS_PER_RESULT_SET rows.
   * Rows are returned as arrays of values (preserving column order).
   */
  private extractRows(recordset: mssql.IRecordSet<any>, columns: ColumnMetadata[]): any[][] {
    const rows: any[][] = [];
    const limit = Math.min(recordset.length, MAX_ROWS_PER_RESULT_SET);

    for (let i = 0; i < limit; i++) {
      const record = recordset[i];
      const row: any[] = columns.map(col => record[col.name]);
      rows.push(row);
    }

    return rows;
  }
}
