import * as mssql from 'mssql';
import { SchemaCache } from './schemaCache';

// --- Interfaces ---

export interface MultiDatabaseCacheOptions {
  /** Maximum number of secondary databases to cache */
  maxDatabases: number;
  /** Timeout in milliseconds for caching each individual database */
  perDatabaseTimeoutMs: number;
}

export interface DatabaseCacheEntry {
  databaseName: string;
  cache: SchemaCache;
  status: 'ready' | 'loading' | 'failed' | 'timeout';
  lastError?: string;
  lastRefreshed?: Date;
}

/**
 * A factory function that creates a ConnectionPool targeting a specific database.
 * The caller is responsible for implementing this based on the active connection config.
 */
export type PoolFactory = (databaseName: string) => Promise<mssql.ConnectionPool>;

export interface IMultiDatabaseCache {
  /** The primary database cache (current connection) */
  primaryCache: SchemaCache;
  /** The primary database name */
  primaryDatabase: string;

  /** Get the cache for a specific database by name (case-insensitive) */
  getCache(databaseName: string): SchemaCache | undefined;

  /** Get all cached database names */
  getCachedDatabaseNames(): string[];

  /** Check if a database name exists in the cache (case-insensitive) */
  hasDatabase(databaseName: string): boolean;

  /** Populate all secondary caches (background, non-blocking) */
  populateSecondaryDatabases(pool: mssql.ConnectionPool): Promise<void>;

  /** Refresh all caches (primary + secondary) */
  refreshAll(pool: mssql.ConnectionPool): Promise<void>;

  /** Clear all secondary caches */
  clear(): void;
}

// --- Default options ---

const DEFAULT_OPTIONS: MultiDatabaseCacheOptions = {
  maxDatabases: 32,
  perDatabaseTimeoutMs: 30_000,
};

// --- Implementation ---

export class MultiDatabaseCache implements IMultiDatabaseCache {
  private databases: Map<string, DatabaseCacheEntry> = new Map();
  private options: MultiDatabaseCacheOptions;
  private poolFactory: PoolFactory;
  public primaryCache: SchemaCache;
  public primaryDatabase: string;

  constructor(
    primaryCache: SchemaCache,
    primaryDatabase: string,
    poolFactory: PoolFactory,
    options?: Partial<MultiDatabaseCacheOptions>
  ) {
    this.primaryCache = primaryCache;
    this.primaryDatabase = primaryDatabase;
    this.poolFactory = poolFactory;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  getCache(databaseName: string): SchemaCache | undefined {
    const key = databaseName.toLowerCase();

    // Check if requesting the primary database
    if (key === this.primaryDatabase.toLowerCase()) {
      return this.primaryCache;
    }

    const entry = this.databases.get(key);
    if (entry && entry.status === 'ready') {
      return entry.cache;
    }
    return undefined;
  }

  getCachedDatabaseNames(): string[] {
    const names: string[] = [this.primaryDatabase];
    for (const entry of this.databases.values()) {
      if (entry.status === 'ready') {
        names.push(entry.databaseName);
      }
    }
    return names;
  }

  hasDatabase(databaseName: string): boolean {
    const key = databaseName.toLowerCase();

    if (key === this.primaryDatabase.toLowerCase()) {
      return true;
    }

    return this.databases.has(key);
  }

  async populateSecondaryDatabases(pool: mssql.ConnectionPool): Promise<void> {
    // Query sys.databases for accessible, online databases
    let databaseNames: string[];
    try {
      databaseNames = await this.queryAccessibleDatabases(pool);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[MultiDatabaseCache] Failed to query sys.databases: ${message}`);
      return;
    }

    // Filter out primary database and limit to maxDatabases
    const primaryLower = this.primaryDatabase.toLowerCase();
    const secondaryDatabases = databaseNames
      .filter(name => name.toLowerCase() !== primaryLower)
      .slice(0, this.options.maxDatabases);

    // Cache each secondary database independently
    for (const dbName of secondaryDatabases) {
      const key = dbName.toLowerCase();

      // Mark as loading
      const entry: DatabaseCacheEntry = {
        databaseName: dbName,
        cache: new SchemaCache(),
        status: 'loading',
      };
      this.databases.set(key, entry);

      try {
        await this.refreshDatabaseWithTimeout(entry, dbName);
        entry.status = 'ready';
        entry.lastRefreshed = new Date();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        if (message.includes('timed out')) {
          entry.status = 'timeout';
          entry.lastError = `Schema cache timed out after ${this.options.perDatabaseTimeoutMs}ms`;
          console.warn(`[MultiDatabaseCache] Timeout caching database '${dbName}': ${entry.lastError}`);
        } else {
          entry.status = 'failed';
          entry.lastError = message;
          console.warn(`[MultiDatabaseCache] Failed to cache database '${dbName}': ${message}`);
        }
      }
    }
  }

  async refreshAll(pool: mssql.ConnectionPool): Promise<void> {
    // Refresh primary cache
    await this.primaryCache.refresh(pool);

    // Refresh all secondary caches that were previously loaded
    for (const entry of this.databases.values()) {
      if (entry.status === 'ready' || entry.status === 'failed' || entry.status === 'timeout') {
        entry.status = 'loading';
        try {
          await this.refreshDatabaseWithTimeout(entry, entry.databaseName);
          entry.status = 'ready';
          entry.lastRefreshed = new Date();
          entry.lastError = undefined;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes('timed out')) {
            entry.status = 'timeout';
            entry.lastError = `Schema cache timed out after ${this.options.perDatabaseTimeoutMs}ms`;
            console.warn(`[MultiDatabaseCache] Timeout refreshing database '${entry.databaseName}': ${entry.lastError}`);
          } else {
            entry.status = 'failed';
            entry.lastError = message;
            console.warn(`[MultiDatabaseCache] Failed to refresh database '${entry.databaseName}': ${message}`);
          }
        }
      }
    }
  }

  clear(): void {
    this.databases.clear();
  }

  // --- Private helpers ---

  /**
   * Queries sys.databases for online, accessible databases.
   * Returns database names ordered alphabetically, limited to maxDatabases.
   */
  private async queryAccessibleDatabases(pool: mssql.ConnectionPool): Promise<string[]> {
    const request = pool.request();
    const result = await request.query(`
      SELECT TOP (${this.options.maxDatabases + 1}) name
      FROM sys.databases
      WHERE state = 0
        AND HAS_DBACCESS(name) = 1
      ORDER BY name
    `);
    return result.recordset.map((row: { name: string }) => row.name);
  }

  /**
   * Refreshes a database cache entry with a per-database timeout.
   * Uses the pool factory to create a temporary pool targeting the specific database,
   * then calls SchemaCache.refresh().
   */
  private async refreshDatabaseWithTimeout(
    entry: DatabaseCacheEntry,
    databaseName: string
  ): Promise<void> {
    const timeoutMs = this.options.perDatabaseTimeoutMs;

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Schema cache for '${databaseName}' timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    });

    let dbPool: mssql.ConnectionPool | undefined;
    try {
      dbPool = await Promise.race([this.poolFactory(databaseName), timeoutPromise]);
      await Promise.race([entry.cache.refresh(dbPool), timeoutPromise]);
    } finally {
      if (dbPool) {
        try {
          await dbPool.close();
        } catch {
          // Ignore close errors
        }
      }
    }
  }
}
