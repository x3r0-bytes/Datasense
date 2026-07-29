import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  CompletionItem,
  CompletionParams,
  NotificationType,
  RequestType,
  Location,
  TextDocumentPositionParams,
  TextEdit,
  Range,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import * as mssql from 'mssql';
import { SchemaCache } from './schemaCache';
import { MultiDatabaseCache, PoolFactory } from './multiDatabaseCache';
import { getCompletions } from './completionProvider';
import { getHoverInfo } from './hoverProvider';
import { getExpandStarActions } from './selectExpander';
import { getGroupByCodeActions } from './groupByCodeAction';
import { lintDocument, LinterConfig, LinterContext } from './linter';
import { formatDocument, formatSelection, FormatOptions } from './formatter';
import { resolveObjectName, getObjectDefinition, isExcludedFromDefinition } from './definitionProvider';

// Lazy-load the msnodesqlv8 variant for Windows Authentication.
// Loading eagerly at module scope crashes the entire module if the native
// binary doesn't match the current Electron ABI version.
let _mssqlNative: typeof mssql | null = null;
function getMssqlNative(): typeof mssql {
  if (!_mssqlNative) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      _mssqlNative = require('mssql/msnodesqlv8') as typeof mssql;
    } catch (err: any) {
      throw new Error(
        'Failed to load the Windows Authentication driver (msnodesqlv8). ' +
        'This is usually caused by a Node.js/Electron version mismatch with the native module. ' +
        'Try reinstalling the extension or rebuilding native modules. ' +
        'Error: ' + (err?.message || String(err))
      );
    }
  }
  return _mssqlNative;
}

/**
 * Detects the highest-version ODBC Driver for SQL Server installed on the system (v16+).
 * Queries the Windows registry ODBCINST.INI key for any "ODBC Driver XX for SQL Server"
 * entries, then returns the highest version found.
 */
function detectOdbcDriver(): string {
  const { execSync } = require('child_process');

  try {
    const output = execSync(
      'reg query "HKLM\\SOFTWARE\\ODBC\\ODBCINST.INI" /s /f "ODBC Driver" /k',
      { stdio: 'pipe', windowsHide: true, encoding: 'utf-8' }
    ) as string;

    const driverPattern = /ODBC Driver (\d+) for SQL Server/g;
    let match: RegExpExecArray | null;
    let highestVersion = 0;

    while ((match = driverPattern.exec(output)) !== null) {
      const version = parseInt(match[1], 10);
      if (version >= 16 && version > highestVersion) {
        highestVersion = version;
      }
    }

    if (highestVersion > 0) {
      return `ODBC Driver ${highestVersion} for SQL Server`;
    }
  } catch {
    // Registry query failed
  }

  throw new Error(
    'No compatible Microsoft ODBC Driver for SQL Server (v16 or higher) was found. ' +
    'Windows Authentication requires an ODBC Driver to be installed on this machine. ' +
    'Download it from: https://learn.microsoft.com/en-us/sql/connect/odbc/download-odbc-driver-for-sql-server'
  );
}

// --- Custom LSP message types ---

/**
 * Connection configuration matching the client-side ConnectionConfig interface.
 */
export interface ConnectionConfig {
  name: string;
  host: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  /** Optional 6-digit CSS hex color for connection identification (e.g., "#FF0000") */
  color?: string;
}

/**
 * Parameters for the sqlServer/connectionChanged notification.
 * Sent from client to server when the active connection changes.
 */
export interface ConnectionChangedParams {
  config: ConnectionConfig | null;
}

/**
 * Result returned by the sqlServer/refreshSchema request.
 */
export interface RefreshSchemaResult {
  success: boolean;
  tableCount: number;
  viewCount: number;
  procedureCount: number;
}

// Custom notification: client -> server
const ConnectionChangedNotification = new NotificationType<ConnectionChangedParams>(
  'sqlServer/connectionChanged'
);

// Custom request: client -> server
const RefreshSchemaRequest = new RequestType<void, RefreshSchemaResult, void>(
  'sqlServer/refreshSchema'
);

// --- Server setup ---

// Create LSP connection over stdio
const connection = createConnection(ProposedFeatures.all);

// Create document manager for text document synchronization
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// Schema cache instance
const schemaCache = new SchemaCache();

// Active connection state
let activePool: mssql.ConnectionPool | null = null;
let activeConfig: ConnectionConfig | null = null;

// Multi-database cache for cross-database IntelliSense
let multiDatabaseCache: MultiDatabaseCache | null = null;

// --- Linter state ---

/** Debounce timers per document URI for linting on change */
const lintTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

/** Current linter configuration */
let linterConfig: LinterConfig = { enabled: true };

connection.onInitialize((_params: InitializeParams): InitializeResult => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: ['.', ' '],
      },
      hoverProvider: true,
      codeActionProvider: {
        codeActionKinds: ['refactor.rewrite', 'quickfix'],
      },
      documentFormattingProvider: true,
      documentRangeFormattingProvider: true,
      definitionProvider: true,
    },
  };
});

// Register textDocument/completion handler with context-aware completions
connection.onCompletion((params: CompletionParams): CompletionItem[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }

  const text = document.getText();
  const offset = document.offsetAt(params.position);
  const isConnected = activePool !== null;

  return getCompletions(text, offset, schemaCache, isConnected, multiDatabaseCache);
});

// Register textDocument/hover handler for schema metadata tooltips
connection.onHover((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }
  return getHoverInfo(document, params.position, schemaCache);
});

// Register textDocument/codeAction handler for SELECT * expansion and GROUP BY quick fixes
connection.onCodeAction((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }
  const expandStarActions = getExpandStarActions(document, params.range, schemaCache);
  const documentText = document.getText();
  const groupByActions = getGroupByCodeActions(documentText, params.textDocument.uri);
  return [...expandStarActions, ...groupByActions];
});

// Register textDocument/formatting handler for full document formatting
connection.onDocumentFormatting((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }

  const text = document.getText();
  const formatOptions: FormatOptions = {
    tabSize: params.options.tabSize,
    insertSpaces: params.options.insertSpaces,
    eol: document.getText().includes('\r\n') ? '\r\n' : '\n',
  };

  const result = formatDocument(text, formatOptions);
  if (!result.formatted || result.text === text) {
    return [];
  }

  // Return a single TextEdit replacing the entire document
  const fullRange = Range.create(
    document.positionAt(0),
    document.positionAt(text.length)
  );
  return [TextEdit.replace(fullRange, result.text)];
});

// Register textDocument/rangeFormatting handler for selection formatting
connection.onDocumentRangeFormatting((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }

  const text = document.getText();
  const startOffset = document.offsetAt(params.range.start);
  const endOffset = document.offsetAt(params.range.end);
  const formatOptions: FormatOptions = {
    tabSize: params.options.tabSize,
    insertSpaces: params.options.insertSpaces,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  };

  const result = formatSelection(text, startOffset, endOffset, formatOptions);
  if (!result) {
    return [];
  }

  // Convert SourceRange to LSP Range
  const editRange = Range.create(
    result.range.start.line, result.range.start.column,
    result.range.end.line, result.range.end.column
  );
  return [TextEdit.replace(editRange, result.text)];
});

// Register textDocument/definition handler for Go to Definition (F12)
connection.onDefinition(async (params: TextDocumentPositionParams): Promise<Location | null> => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const offset = document.offsetAt(params.position);
  const resolved = resolveObjectName(document, offset);

  if (!resolved) {
    return null;
  }

  const { schema, name } = resolved;

  // Skip Go to Definition for T-SQL keywords, data types, and variables
  // These are never user-defined objects in sys.objects
  if (isExcludedFromDefinition(name)) {
    return null;
  }

  // Check if we have an active database connection (Requirement 2.10)
  if (!activePool) {
    connection.console.warn(
      `Go to Definition: not connected to a database (object: ${schema}.${name})`
    );
    connection.sendNotification('window/showMessage', {
      type: 3, // MessageType.Info
      message: 'Go to Definition requires a database connection. Please connect to a server first.',
    });
    return null;
  }

  const databaseName = activeConfig?.database || 'master';
  const result = await getObjectDefinition(activePool, schema, name, databaseName);

  if (result.source) {
    // Create a virtual document URI for the definition source
    // Format must match the client's DefinitionContentProvider URI scheme:
    // tsql-definition:schema.name.sql
    const virtualUri = `tsql-definition:${schema}.${name}.sql`;

    // Send the source content to the client BEFORE returning the Location,
    // so the DefinitionContentProvider can serve it when VS Code opens the document
    connection.sendNotification('sqlServer/definitionContent', {
      uri: virtualUri,
      source: result.source,
    });

    return Location.create(virtualUri, {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    });
  }

  // Log the reason for failure and notify the user
  if (result.reason === 'not_found') {
    connection.console.log(
      `Go to Definition: ${schema}.${name} was not found in the connected database`
    );
    connection.sendNotification('window/showMessage', {
      type: 3, // MessageType.Info
      message: `${schema}.${name} could not be located in the connected database.`,
    });
  } else if (result.reason === 'encrypted') {
    connection.console.log(
      `Go to Definition: definition unavailable for ${schema}.${name} — object may be encrypted`
    );
    connection.sendNotification('window/showMessage', {
      type: 3, // MessageType.Info
      message: `Definition unavailable for ${schema}.${name} — object may be encrypted.`,
    });
  } else if (result.reason === 'unsupported_type') {
    // Only log to console — don't show a notification to the user.
    // This fires on implicit definition requests (hover, breadcrumbs, peek)
    // which the user didn't explicitly trigger. Only tables/types hit this path.
    connection.console.log(
      `Go to Definition: unsupported object type for ${schema}.${name} — silently ignored`
    );
  }

  return null;
});

// --- Linter handlers ---

/**
 * Lint a document and publish diagnostics.
 * Wraps the lint call in try/catch — on failure, logs error and clears diagnostics.
 */
function validateDocument(document: TextDocument): void {
  try {
    connection.console.log(`[Linter] validateDocument called for ${document.uri} (enabled=${linterConfig.enabled})`);

    // Build LinterContext from current connection state and schema cache
    const context: LinterContext | undefined = activePool ? {
      schemaCache: schemaCache,
      isConnected: true,
      isRefreshing: schemaCache.isPopulating,
    } : undefined;

    const diagnostics = lintDocument(document.getText(), linterConfig, context);
    connection.console.log(`[Linter] Found ${diagnostics.length} diagnostic(s)`);
    connection.sendDiagnostics({ uri: document.uri, diagnostics });
  } catch (e: any) {
    connection.console.error(`Linter internal error for ${document.uri}: ${e.message}`);
    connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  }
}

// textDocument/didOpen — lint immediately
documents.onDidOpen((event) => {
  connection.console.log(`[DocSync] onDidOpen fired for ${event.document.uri}`);
  validateDocument(event.document);
});

// textDocument/didChangeContent — debounce 500ms
documents.onDidChangeContent((event) => {
  connection.console.log(`[DocSync] onDidChangeContent fired for ${event.document.uri}`);
  const uri = event.document.uri;

  // Clear existing timer for this document
  const existingTimer = lintTimers.get(uri);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Set new 500ms debounce timer
  const timer = setTimeout(() => {
    lintTimers.delete(uri);
    // Re-fetch the document in case it changed during the debounce
    const doc = documents.get(uri);
    if (doc) {
      validateDocument(doc);
    }
  }, 500);

  lintTimers.set(uri, timer);
});

// textDocument/didClose — clear timer and diagnostics
documents.onDidClose((event) => {
  const uri = event.document.uri;

  // Clear any pending debounce timer
  const existingTimer = lintTimers.get(uri);
  if (existingTimer) {
    clearTimeout(existingTimer);
    lintTimers.delete(uri);
  }

  // Clear diagnostics for the closed document
  connection.sendDiagnostics({ uri, diagnostics: [] });
});

// --- Configuration handling ---

connection.onDidChangeConfiguration((change) => {
  const settings = change.settings as any;
  if (settings?.sqlServer?.linting) {
    const enabled = settings.sqlServer.linting.enabled;
    linterConfig = { enabled: enabled !== false };
  }

  // If linting was disabled, clear all diagnostics for open documents
  if (!linterConfig.enabled) {
    documents.all().forEach((doc) => {
      connection.sendDiagnostics({ uri: doc.uri, diagnostics: [] });
    });
  } else {
    // If linting was re-enabled, re-lint all open documents
    documents.all().forEach((doc) => {
      validateDocument(doc);
    });
  }
});

// Register custom notification handler for connection changes
connection.onNotification(ConnectionChangedNotification, async (params: ConnectionChangedParams) => {
  connection.console.log(
    `Connection changed: ${params.config ? params.config.name : 'disconnected'}`
  );

  // Close existing connection if any
  if (activePool) {
    try {
      await activePool.close();
    } catch (e) {
      // Ignore close errors
    }
    activePool = null;
  }

  // Clear old multi-database cache
  if (multiDatabaseCache) {
    multiDatabaseCache.clear();
    multiDatabaseCache = null;
  }

  activeConfig = params.config;

  if (params.config) {
    try {
      const pool = await createPool(params.config);
      activePool = pool;
      // Trigger schema cache refresh
      await schemaCache.refresh(pool);
      connection.console.log(
        `Schema cache refreshed: ${schemaCache.tables.length} tables, ${schemaCache.views.length} views, ${schemaCache.procedures.length} procedures`
      );

      // Create multi-database cache and start background population
      const primaryDatabase = params.config.database || 'master';
      const config = params.config;
      const poolFactory: PoolFactory = (databaseName: string) => {
        return createPool({ ...config, database: databaseName });
      };
      multiDatabaseCache = new MultiDatabaseCache(schemaCache, primaryDatabase, poolFactory);

      // Start background population (don't await — non-blocking)
      multiDatabaseCache.populateSecondaryDatabases(pool).then(() => {
        connection.console.log(
          `[MultiDatabaseCache] Background population complete: ${multiDatabaseCache?.getCachedDatabaseNames().length ?? 0} databases cached`
        );
      }).catch((err: any) => {
        connection.console.error(
          `[MultiDatabaseCache] Background population failed: ${err?.message || String(err)}`
        );
      });
    } catch (e: any) {
      connection.console.error(`Failed to connect or refresh schema: ${e.message}`);
      activePool = null;
    }
  }
});

// Register custom request handler for manual schema refresh
connection.onRequest(RefreshSchemaRequest, async (): Promise<RefreshSchemaResult> => {
  if (!activePool) {
    return {
      success: false,
      tableCount: 0,
      viewCount: 0,
      procedureCount: 0,
    };
  }

  try {
    if (multiDatabaseCache) {
      // Refresh primary + all secondary database caches
      await multiDatabaseCache.refreshAll(activePool);
    } else {
      // Fallback to primary-only refresh
      await schemaCache.refresh(activePool);
    }
    return {
      success: true,
      tableCount: schemaCache.tables.length,
      viewCount: schemaCache.views.length,
      procedureCount: schemaCache.procedures.length,
    };
  } catch (e: any) {
    connection.console.error(`Schema refresh failed: ${e.message}`);
    return {
      success: false,
      tableCount: schemaCache.tables.length,
      viewCount: schemaCache.views.length,
      procedureCount: schemaCache.procedures.length,
    };
  }
});

/**
 * Creates an mssql ConnectionPool from a ConnectionConfig.
 */
function createPool(config: ConnectionConfig): Promise<mssql.ConnectionPool> {
  let pool: mssql.ConnectionPool;
  const database = config.database || 'master';

  if (config.user) {
    // SQL Server authentication using default Tedious driver
    const mssqlConfig: mssql.config = {
      server: config.host,
      port: config.port ?? 1433,
      database,
      user: config.user,
      password: config.password,
      options: {
        encrypt: config.encrypt ?? false,
        trustServerCertificate: config.trustServerCertificate ?? false,
      },
      connectionTimeout: 30000,
    };

    pool = new mssql.ConnectionPool(mssqlConfig);
  } else {
    // Windows Authentication using msnodesqlv8 driver
    const driver = detectOdbcDriver();
    const connectionString = [
      `Driver={${driver}}`,
      `Server=${config.host}${config.port && config.port !== 1433 ? ',' + config.port : ''}`,
      `Database=${database}`,
      `Trusted_Connection=Yes`,
    ].join(';');

    pool = new (getMssqlNative()).ConnectionPool({
      connectionString,
      connectionTimeout: 30000,
      options: {
        encrypt: config.encrypt ?? false,
        trustServerCertificate: config.trustServerCertificate ?? false,
      },
    } as any);
  }

  return pool.connect();
}

// Hook up document manager to the connection
documents.listen(connection);

// Start listening on the connection
connection.listen();
