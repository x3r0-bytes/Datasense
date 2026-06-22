// src/sqlSearchService.ts

import * as mssql from 'mssql';
import { ObjectExplorerConnectionManager } from './objectExplorer/objectExplorerConnectionManager';

export interface SearchRequest {
  searchTerm: string;
  objectTypes: ObjectTypeFilter;
  scope: SearchScope;
  includeSystemDatabases: boolean;
}

export interface ObjectTypeFilter {
  procedures: boolean;
  views: boolean;
  functions: boolean;
  tables: boolean;
  triggers: boolean;
}

export interface SearchScope {
  type: 'all' | 'server' | 'database' | 'schema';
  connectionName?: string;
  database?: string;
  schema?: string;
}

export interface SearchResultItem {
  connectionName: string;
  database: string;
  schema: string;
  objectName: string;
  objectType: 'procedure' | 'view' | 'function' | 'table' | 'trigger';
  matchLine: number;         // 1-based line number
  matchContext: string;      // Truncated snippet (max 100 chars each side)
  matchStartIndex: number;   // Start of match within matchContext
  matchLength: number;       // Length of matched text in context
}

export interface SearchResult {
  items: SearchResultItem[];
  totalCount: number;
  truncated: boolean;           // true if 500-match limit was reached
  databasesSearched: number;
  databasesTotal: number;
  durationMs: number;
  warnings: SearchWarning[];
  cancelled: boolean;
}

export interface SearchWarning {
  database: string;
  connectionName: string;
  reason: 'timeout' | 'unreachable' | 'offline' | 'auth_required';
  message: string;
}

export interface SearchProgress {
  databasesCompleted: number;
  databasesTotal: number;
  currentDatabase: string;
}

export type ProgressCallback = (progress: SearchProgress) => void;

export interface MatchInfo {
  matchLine: number;       // 1-based line number
  matchContext: string;    // Truncated snippet
  matchStartIndex: number; // Start of match within matchContext
  matchLength: number;     // Length of matched text
}

/**
 * Extract all non-overlapping match contexts from a definition string.
 * Performs case-insensitive search but preserves original casing in context.
 */
export function extractMatchContexts(
  definition: string,
  searchTerm: string
): MatchInfo[] {
  if (!searchTerm || searchTerm.length === 0) {
    return [];
  }

  const definitionLower = definition.toLowerCase();
  const searchTermLower = searchTerm.toLowerCase();
  const results: MatchInfo[] = [];

  let searchFrom = 0;
  while (searchFrom <= definition.length - searchTermLower.length) {
    const pos = definitionLower.indexOf(searchTermLower, searchFrom);
    if (pos === -1) {
      break;
    }

    // 1. Line number: count \n characters before the match position, add 1
    const textBeforeMatch = definition.substring(0, pos);
    const matchLine = textBeforeMatch.split('\n').length;

    // 2. Context extraction: max 100 chars on each side of the matched term
    const contextStart = Math.max(0, pos - 100);
    const contextEnd = Math.min(definition.length, pos + searchTerm.length + 100);
    const matchContext = definition.substring(contextStart, contextEnd);

    // 3. Track match position within the truncated context
    const matchStartIndex = pos - contextStart;
    const matchLength = searchTerm.length;

    results.push({
      matchLine,
      matchContext,
      matchStartIndex,
      matchLength,
    });

    // Move past this occurrence to find non-overlapping matches
    searchFrom = pos + searchTermLower.length;
  }

  return results;
}

export function validateSearchTerm(term: string): { valid: boolean; message?: string } {
  const nonWhitespaceCount = term.replace(/\s/g, '').length;

  if (nonWhitespaceCount < 2) {
    return { valid: false, message: 'Search term must contain at least 2 non-whitespace characters.' };
  }

  if (term.length > 128) {
    return { valid: false, message: 'Search term must not exceed 128 characters.' };
  }

  return { valid: true };
}

export class SqlSearchService {
  private cache: Map<string, SearchResult>;
  private activeAbortController: AbortController | null;

  constructor(
    private readonly connectionManager: ObjectExplorerConnectionManager,
    private readonly maxConcurrency: number = 4,
    private readonly perDatabaseTimeoutMs: number = 30000,
    private readonly maxResults: number = 500,
    private readonly maxCacheSize: number = 50
  ) {
    this.cache = new Map();
    this.activeAbortController = null;
  }

  /** Execute a search across databases in scope */
  async search(request: SearchRequest, onProgress: ProgressCallback): Promise<SearchResult> {
    const startTime = Date.now();

    // 1. Check cache first
    const cacheKey = this.buildCacheKey(request);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      // LRU: move to end (delete and re-set)
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return cached;
    }

    // 2. Setup abort controller
    this.activeAbortController = new AbortController();
    const signal = this.activeAbortController.signal;

    // 3. Resolve databases
    const databases = await this.resolveDatabases(request.scope, request.includeSystemDatabases);
    const totalDbs = databases.length;

    // 4. Build LIKE pattern
    const likePattern = this.buildLikePattern(request.searchTerm);

    // 5. Execute in parallel with concurrency limit
    const allItems: SearchResultItem[] = [];
    const warnings: SearchWarning[] = [];
    let databasesSearched = 0;
    let cancelled = false;
    let truncated = false;

    // Parallel-with-limit execution
    const executing: Set<Promise<void>> = new Set();

    for (const db of databases) {
      if (signal.aborted) {
        cancelled = true;
        break;
      }

      if (allItems.length >= this.maxResults) {
        truncated = true;
        break;
      }

      const task = (async () => {
        try {
          const items = await this.searchDatabase(
            db.connectionName,
            db.database,
            likePattern,
            request.objectTypes,
            request.scope.type === 'schema' ? request.scope.schema : undefined,
            signal
          );
          allItems.push(...items);
        } catch (err: any) {
          const reason = err.message?.includes('timeout') ? 'timeout' : 'unreachable';
          warnings.push({
            database: db.database,
            connectionName: db.connectionName,
            reason,
            message: err.message || 'Unknown error',
          });
        } finally {
          databasesSearched++;
          onProgress({
            databasesCompleted: databasesSearched,
            databasesTotal: totalDbs,
            currentDatabase: db.database,
          });
        }
      })();

      executing.add(task);
      task.finally(() => executing.delete(task));

      // Enforce concurrency limit
      if (executing.size >= this.maxConcurrency) {
        await Promise.race(executing);
      }
    }

    // Wait for all remaining tasks
    await Promise.all(executing);

    // Check cancellation
    if (signal.aborted) {
      cancelled = true;
    }

    // 6. Trim to maxResults and set truncated flag
    if (allItems.length > this.maxResults) {
      truncated = true;
      allItems.length = this.maxResults;
    }

    const result: SearchResult = {
      items: allItems,
      totalCount: allItems.length,
      truncated,
      databasesSearched,
      databasesTotal: totalDbs,
      durationMs: Date.now() - startTime,
      warnings,
      cancelled,
    };

    // 7. Cache result (LRU eviction)
    if (!cancelled) {
      this.cache.set(cacheKey, result);
      // Evict oldest if over capacity
      if (this.cache.size > this.maxCacheSize) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey !== undefined) {
          this.cache.delete(firstKey);
        }
      }
    }

    // 8. Clear abort controller
    this.activeAbortController = null;

    return result;
  }

  /** Cancel the currently executing search */
  cancel(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
    }
  }

  /** Invalidate cache entries for a specific connection */
  invalidateConnection(connectionName: string): void {
    for (const [key, result] of this.cache.entries()) {
      // Check if cache key references this connection in the scope portion
      if (key.includes(`:${connectionName}:`)) {
        this.cache.delete(key);
        continue;
      }
      // Check if any result items reference this connection (e.g., "all" scope searches)
      if (result.items.some(item => item.connectionName === connectionName)) {
        this.cache.delete(key);
      }
    }
  }

  /** Clear the entire cache */
  clearCache(): void {
    this.cache.clear();
  }

  /** Build a LIKE pattern from a search term with proper escaping */
  buildLikePattern(searchTerm: string): string {
    // Escaping order is critical to avoid double-escaping:
    // 1. [ → [[] (must be first — escaping [ uses brackets)
    // 2. % → [%]
    // 3. _ → [_]
    let escaped = searchTerm.replace(/\[/g, '[[]');
    escaped = escaped.replace(/%/g, '[%]');
    escaped = escaped.replace(/_/g, '[_]');

    // Wrap in wildcards for substring matching
    return '%' + escaped + '%';
  }

  /** Resolve the list of databases to search based on scope and filters */
  async resolveDatabases(
    scope: SearchScope,
    includeSystemDatabases: boolean
  ): Promise<Array<{ connectionName: string; database: string }>> {
    const systemDatabases = ['master', 'model', 'msdb', 'tempdb'];

    // Scope type: database or schema — return just the one specified database
    if (scope.type === 'database' || scope.type === 'schema') {
      if (scope.connectionName && scope.database) {
        return [{ connectionName: scope.connectionName, database: scope.database }];
      }
      return [];
    }

    // Scope type: server — query databases from the single connection
    if (scope.type === 'server') {
      if (!scope.connectionName) {
        return [];
      }
      return this.queryDatabasesForConnection(scope.connectionName, includeSystemDatabases, systemDatabases);
    }

    // Scope type: all — query databases from every connection
    const connections = this.connectionManager.getConnections();
    const results: Array<{ connectionName: string; database: string }> = [];

    for (const conn of connections) {
      const databases = await this.queryDatabasesForConnection(conn.name, includeSystemDatabases, systemDatabases);
      results.push(...databases);
    }

    return results;
  }

  /** Query available databases for a single connection, handling failures gracefully */
  private async queryDatabasesForConnection(
    connectionName: string,
    includeSystemDatabases: boolean,
    systemDatabases: string[]
  ): Promise<Array<{ connectionName: string; database: string }>> {
    try {
      const pool = await this.connectionManager.getPool(connectionName);
      const result = await pool.request().query<{ name: string }>(
        `SELECT name FROM sys.databases WHERE state_desc = 'ONLINE'`
      );

      let databases = result.recordset.map(row => row.name);

      if (!includeSystemDatabases) {
        databases = databases.filter(
          db => !systemDatabases.includes(db.toLowerCase())
        );
      }

      return databases.map(db => ({ connectionName, database: db }));
    } catch {
      // Connection failure — skip this server gracefully
      return [];
    }
  }

  /** Execute search for a single database */
  private async searchDatabase(
    connectionName: string,
    database: string,
    likePattern: string,
    objectTypes: ObjectTypeFilter,
    schema: string | undefined,
    signal: AbortSignal
  ): Promise<SearchResultItem[]> {
    // Check if already aborted before starting
    if (signal.aborted) {
      return [];
    }

    // Acquire connection pool for this database
    const pool = await this.connectionManager.getPoolForDatabase(connectionName, database);

    // Build the list of SQL Server type codes based on objectTypes filter
    const typeFilters: string[] = [];
    if (objectTypes.procedures) {
      typeFilters.push('P', 'PC');
    }
    if (objectTypes.views) {
      typeFilters.push('V');
    }
    if (objectTypes.functions) {
      typeFilters.push('FN', 'IF', 'TF', 'FS', 'FT');
    }
    if (objectTypes.triggers) {
      typeFilters.push('TR');
    }

    const hasDefinitionTypes = typeFilters.length > 0;
    const hasTableSearch = objectTypes.tables;

    // If nothing to search, return early
    if (!hasDefinitionTypes && !hasTableSearch) {
      return [];
    }

    // Wrap the actual work in a promise that we can race against a timeout
    const doSearch = async (): Promise<SearchResultItem[]> => {
      const results: SearchResultItem[] = [];

      // Execute definition search if any definition types are requested
      if (hasDefinitionTypes) {
        if (signal.aborted) {
          return results;
        }
        const definitionResults = await this.searchDefinitions(
          pool, connectionName, database, likePattern, typeFilters, schema
        );
        results.push(...definitionResults);
      }

      // Execute table column search if tables is requested
      if (hasTableSearch) {
        if (signal.aborted) {
          return results;
        }
        const tableResults = await this.searchTableColumns(
          pool, connectionName, database, likePattern, schema
        );
        results.push(...tableResults);
      }

      return results;
    };

    // Create a timeout promise that rejects after perDatabaseTimeoutMs
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Database query timeout after ${this.perDatabaseTimeoutMs}ms`));
      }, this.perDatabaseTimeoutMs);
      // Ensure the timer doesn't prevent Node from exiting
      if (timer.unref) {
        timer.unref();
      }
    });

    // Race the actual work against the timeout
    const results = await Promise.race([doSearch(), timeoutPromise]);

    return results;
  }

  /** Run definition search query (sys.sql_modules) */
  private async searchDefinitions(
    pool: mssql.ConnectionPool,
    connectionName: string,
    database: string,
    likePattern: string,
    typeFilters: string[],
    schema: string | undefined
  ): Promise<SearchResultItem[]> {
    if (typeFilters.length === 0) {
      return [];
    }

    // Build parameterized IN clause since mssql doesn't support array params in IN
    const typeParams = typeFilters.map((_, i) => `@type${i}`).join(', ');

    const sql = `
      SELECT
        s.name AS [schema],
        o.name AS objectName,
        o.type AS objectType,
        m.definition
      FROM sys.sql_modules m
      JOIN sys.objects o ON m.object_id = o.object_id
      JOIN sys.schemas s ON o.schema_id = s.schema_id
      WHERE o.type IN (${typeParams})
        AND m.definition LIKE @searchPattern
        AND (@schema IS NULL OR s.name = @schema)
      ORDER BY s.name, o.name
    `;

    const request = pool.request();
    request.input('searchPattern', mssql.NVarChar, likePattern);
    request.input('schema', mssql.NVarChar, schema ?? null);

    for (let i = 0; i < typeFilters.length; i++) {
      request.input(`type${i}`, mssql.NVarChar, typeFilters[i]);
    }

    const result = await request.query<{
      schema: string;
      objectName: string;
      objectType: string;
      definition: string | null;
    }>(sql);

    const results: SearchResultItem[] = [];

    // Derive the original search term from the LIKE pattern for match finding
    const searchTerm = this.extractSearchTermFromLikePattern(likePattern);

    for (const row of result.recordset) {
      // Skip encrypted objects (NULL definition)
      if (row.definition === null || row.definition === undefined) {
        continue;
      }

      const objectType = this.mapObjectType(row.objectType.trim());
      if (!objectType) {
        continue;
      }

      // Find all case-insensitive matches of the search term in the definition
      const matches = this.findAllMatches(row.definition, searchTerm);

      for (const match of matches) {
        const lineNumber = this.computeLineNumber(row.definition, match.offset);
        const context = this.extractMatchContext(row.definition, match.offset, match.length);

        results.push({
          connectionName,
          database,
          schema: row.schema,
          objectName: row.objectName,
          objectType,
          matchLine: lineNumber,
          matchContext: context.text,
          matchStartIndex: context.matchStartIndex,
          matchLength: match.length,
        });
      }
    }

    return results;
  }

  /** Extract the original search term from the LIKE pattern by stripping wrapping % and unescaping */
  private extractSearchTermFromLikePattern(likePattern: string): string {
    // Strip leading and trailing %
    let term = likePattern;
    if (term.startsWith('%')) {
      term = term.slice(1);
    }
    if (term.endsWith('%')) {
      term = term.slice(0, -1);
    }

    // Unescape LIKE special characters: [[] → [, [%] → %, [_] → _
    term = term.replace(/\[\[\]/g, '[');
    term = term.replace(/\[%\]/g, '%');
    term = term.replace(/\[_\]/g, '_');

    return term;
  }

  /** Map SQL Server object type codes to friendly type names */
  private mapObjectType(typeCode: string): SearchResultItem['objectType'] | null {
    switch (typeCode) {
      case 'P':
      case 'PC':
        return 'procedure';
      case 'V':
        return 'view';
      case 'FN':
      case 'IF':
      case 'TF':
      case 'FS':
      case 'FT':
        return 'function';
      case 'TR':
        return 'trigger';
      default:
        return null;
    }
  }

  /** Find all case-insensitive occurrences of a search term in the text */
  private findAllMatches(text: string, searchTerm: string): Array<{ offset: number; length: number }> {
    const matches: Array<{ offset: number; length: number }> = [];
    if (!searchTerm) {
      return matches;
    }

    const lowerText = text.toLowerCase();
    const lowerTerm = searchTerm.toLowerCase();
    let startIndex = 0;

    while (startIndex < lowerText.length) {
      const idx = lowerText.indexOf(lowerTerm, startIndex);
      if (idx === -1) {
        break;
      }
      matches.push({ offset: idx, length: searchTerm.length });
      startIndex = idx + 1; // Move past this match to find overlapping matches
    }

    return matches;
  }

  /** Compute 1-based line number from a character offset */
  private computeLineNumber(text: string, offset: number): number {
    let lineCount = 1;
    for (let i = 0; i < offset && i < text.length; i++) {
      if (text[i] === '\n') {
        lineCount++;
      }
    }
    return lineCount;
  }

  /** Extract match context with up to 100 chars on each side */
  private extractMatchContext(
    text: string,
    matchOffset: number,
    matchLength: number
  ): { text: string; matchStartIndex: number } {
    const contextBefore = 100;
    const contextAfter = 100;

    const start = Math.max(0, matchOffset - contextBefore);
    const end = Math.min(text.length, matchOffset + matchLength + contextAfter);

    const contextText = text.slice(start, end);
    const matchStartIndex = matchOffset - start;

    return {
      text: contextText,
      matchStartIndex,
    };
  }

  /** Run table column search query (sys.columns + sys.tables) */
  private async searchTableColumns(
    pool: mssql.ConnectionPool,
    connectionName: string,
    database: string,
    likePattern: string,
    schema: string | undefined
  ): Promise<SearchResultItem[]> {
    const query = `
      SELECT
        s.name AS [schema],
        t.name AS tableName,
        c.name AS columnName
      FROM sys.columns c
      JOIN sys.tables t ON c.object_id = t.object_id
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE c.name LIKE @searchPattern
        AND (@schema IS NULL OR s.name = @schema)
      ORDER BY s.name, t.name, c.name
    `;

    const result = await pool.request()
      .input('searchPattern', mssql.NVarChar, likePattern)
      .input('schema', mssql.NVarChar, schema || null)
      .query<{ schema: string; tableName: string; columnName: string }>(query);

    // Extract the raw search term from the LIKE pattern (strip leading/trailing %)
    const rawTerm = likePattern.slice(1, -1)
      .replace(/\[%\]/g, '%')
      .replace(/\[_\]/g, '_')
      .replace(/\[\[\]/g, '[');

    const items: SearchResultItem[] = [];

    for (const row of result.recordset) {
      // Find the position of the search term within the column name (case-insensitive)
      const columnNameLower = row.columnName.toLowerCase();
      const searchTermLower = rawTerm.toLowerCase();
      const matchIndex = columnNameLower.indexOf(searchTermLower);

      items.push({
        connectionName,
        database,
        schema: row.schema,
        objectName: row.tableName,
        objectType: 'table',
        matchLine: 1,
        matchContext: row.columnName,
        matchStartIndex: matchIndex >= 0 ? matchIndex : 0,
        matchLength: matchIndex >= 0 ? rawTerm.length : row.columnName.length,
      });
    }

    return items;
  }

  /** Build cache key from request parameters */
  private buildCacheKey(request: SearchRequest): string {
    const { searchTerm, scope, objectTypes, includeSystemDatabases } = request;
    return `${searchTerm}|${scope.type}:${scope.connectionName || ''}:${scope.database || ''}:${scope.schema || ''}|${objectTypes.procedures}:${objectTypes.views}:${objectTypes.functions}:${objectTypes.tables}:${objectTypes.triggers}|${includeSystemDatabases}`;
  }
}
