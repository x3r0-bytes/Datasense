import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { QueryResult } from './types';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface HistoryRecord {
  id: string;                  // UUID
  sql: string;                 // Truncated to 100,000 chars
  timestamp: string;           // ISO 8601 UTC
  durationMs: number;          // Execution time
  rowCount: number;            // 0 for errors
  connectionName: string;
  databaseName: string;
  serverHost: string;
  success: boolean;
}

export interface IQueryHistoryStore {
  /** All records, most recent first */
  getRecords(): HistoryRecord[];

  /** Add a new record (auto-truncates SQL, auto-evicts oldest if over 500) */
  addRecord(record: Omit<HistoryRecord, 'id'>): void;

  /** Search records by case-insensitive substring (SQL, connection, database) */
  search(filter: string): HistoryRecord[];

  /** Clear all records */
  clear(): void;

  /** Persist current state to disk */
  save(): Promise<void>;

  /** Load from disk */
  load(): Promise<void>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum SQL text length before truncation */
export const MAX_SQL_LENGTH = 100_000;

/** Maximum number of stored history records */
export const MAX_HISTORY_RECORDS = 500;

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Truncates SQL text to the maximum allowed length (100,000 characters).
 * Returns the original string if it's within the limit.
 */
export function truncateSql(sql: string): string {
  if (sql.length <= MAX_SQL_LENGTH) {
    return sql;
  }
  return sql.substring(0, MAX_SQL_LENGTH);
}

/**
 * Creates a HistoryRecord (without id) from a QueryResult and connection metadata.
 * Calculates total row count across all result sets.
 * Uses current UTC time as timestamp.
 */
export function createHistoryRecord(
  sql: string,
  result: QueryResult,
  connectionName: string,
  databaseName: string,
  serverHost: string
): Omit<HistoryRecord, 'id'> {
  const success = !result.error;
  const rowCount = success
    ? result.resultSets.reduce((total, rs) => total + rs.rowCount, 0)
    : 0;

  return {
    sql: truncateSql(sql),
    timestamp: new Date().toISOString(),
    durationMs: result.executionTimeMs,
    rowCount,
    connectionName,
    databaseName,
    serverHost,
    success,
  };
}

// ─── Store Implementation ───────────────────────────────────────────────────

const STORAGE_DIR = '.datasense';
const STORAGE_FILE = 'query-history.json';

export class QueryHistoryStore implements IQueryHistoryStore {
  private records: HistoryRecord[] = [];
  private readonly storagePath: string;
  private readonly storageDir: string;

  constructor(workspaceRoot: string) {
    this.storageDir = path.join(workspaceRoot, STORAGE_DIR);
    this.storagePath = path.join(this.storageDir, STORAGE_FILE);
  }

  /**
   * Returns all records sorted by timestamp descending (most recent first).
   */
  getRecords(): HistoryRecord[] {
    return [...this.records];
  }

  /**
   * Adds a new record to the store.
   * Auto-generates a UUID, truncates SQL to MAX_SQL_LENGTH,
   * and evicts the oldest record(s) if the store exceeds MAX_HISTORY_RECORDS.
   */
  addRecord(record: Omit<HistoryRecord, 'id'>): void {
    const newRecord: HistoryRecord = {
      ...record,
      id: crypto.randomUUID(),
      sql: truncateSql(record.sql),
    };

    // Insert at the beginning (most recent first)
    this.records.unshift(newRecord);

    // Evict oldest records if over the limit
    if (this.records.length > MAX_HISTORY_RECORDS) {
      this.records = this.records.slice(0, MAX_HISTORY_RECORDS);
    }
  }

  /**
   * Searches records by case-insensitive substring match against
   * SQL text, connectionName, or databaseName.
   * Returns matching records in timestamp-descending order.
   */
  search(filter: string): HistoryRecord[] {
    if (!filter) {
      return this.getRecords();
    }

    const lowerFilter = filter.toLowerCase();
    return this.records.filter(record =>
      record.sql.toLowerCase().includes(lowerFilter) ||
      record.connectionName.toLowerCase().includes(lowerFilter) ||
      record.databaseName.toLowerCase().includes(lowerFilter)
    );
  }

  /**
   * Clears all records from the store.
   */
  clear(): void {
    this.records = [];
  }

  /**
   * Persists the current records to disk as JSON.
   * Creates the .datasense/ directory if it doesn't exist.
   * On write errors, logs a warning and retains data in memory.
   */
  async save(): Promise<void> {
    try {
      await fs.promises.mkdir(this.storageDir, { recursive: true });
      const json = JSON.stringify(this.records, null, 2);
      await fs.promises.writeFile(this.storagePath, json, 'utf-8');
    } catch (err) {
      console.warn(
        `[QueryHistory] Failed to save history file: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Loads records from the persistence file on disk.
   * If the file doesn't exist, starts with empty history.
   * If the file is corrupted (invalid JSON), starts empty and logs a warning.
   */
  async load(): Promise<void> {
    try {
      const content = await fs.promises.readFile(this.storagePath, 'utf-8');
      const parsed = JSON.parse(content);

      if (Array.isArray(parsed)) {
        this.records = parsed;
      } else {
        console.warn('[QueryHistory] History file does not contain an array. Starting empty.');
        this.records = [];
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        // File doesn't exist — start empty (no warning needed)
        this.records = [];
      } else {
        // Corrupted file or other read error — start empty, log warning
        console.warn(
          `[QueryHistory] Failed to load history file: ${err instanceof Error ? err.message : String(err)}. Starting with empty history.`
        );
        this.records = [];
      }
    }
  }
}
