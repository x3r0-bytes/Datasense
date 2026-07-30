import * as mssql from 'mssql';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionConfig, IConnectionManager, normalizeEncryptValue } from './types';

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

const CONNECTION_FILE = '.sql-connections.json';
const CONNECTION_TIMEOUT_MS = 30000;

/**
 * Detects the highest-version ODBC Driver for SQL Server installed on the system (v16+).
 * Queries the Windows registry ODBCINST.INI key for any "ODBC Driver XX for SQL Server"
 * entries, then returns the highest version found.
 * No hardcoded versions — future driver releases (19, 20, etc.) are picked up automatically.
 */
function detectOdbcDriver(): string {
  const { execSync } = require('child_process');

  try {
    // List all registered ODBC drivers from the registry
    const output = execSync(
      'reg query "HKLM\\SOFTWARE\\ODBC\\ODBCINST.INI" /s /f "ODBC Driver" /k',
      { stdio: 'pipe', windowsHide: true, encoding: 'utf-8' }
    ) as string;

    // Match all "ODBC Driver XX for SQL Server" entries
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
    // Registry query failed — fall through to error
  }

  throw new Error(
    'No compatible Microsoft ODBC Driver for SQL Server (v16 or higher) was found. ' +
    'Windows Authentication requires an ODBC Driver to be installed on this machine. ' +
    'Download it from: https://learn.microsoft.com/en-us/sql/connect/odbc/download-odbc-driver-for-sql-server'
  );
}

export class ConnectionManager implements IConnectionManager {
  private activePool: mssql.ConnectionPool | null = null;
  private activeConfig: ConnectionConfig | null = null;
  private connections: ConnectionConfig[] = [];

  private readonly _onConnectionChanged = new vscode.EventEmitter<ConnectionConfig | null>();
  public readonly onConnectionChanged: vscode.Event<ConnectionConfig | null> = this._onConnectionChanged.event;

  /**
   * Reads and parses `.sql-connections.json` from the workspace root.
   * Validates required fields (name, host, database) and excludes invalid entries with a warning.
   * Defaults port to 1433 when not specified.
   */
  loadConnections(): ConnectionConfig[] {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showWarningMessage('No workspace folder open. Cannot load SQL connections.');
      this.connections = [];
      return this.connections;
    }

    const configPath = path.join(workspaceFolders[0].uri.fsPath, CONNECTION_FILE);

    if (!fs.existsSync(configPath)) {
      vscode.window.showWarningMessage(
        `Connection file "${CONNECTION_FILE}" not found at workspace root. No connections available.`
      );
      this.connections = [];
      return this.connections;
    }

    let fileContent: string;
    try {
      fileContent = fs.readFileSync(configPath, 'utf-8');
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to read "${CONNECTION_FILE}": ${err instanceof Error ? err.message : String(err)}`
      );
      this.connections = [];
      return this.connections;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(fileContent);
    } catch (err) {
      vscode.window.showErrorMessage(
        `Invalid JSON in "${CONNECTION_FILE}": ${err instanceof Error ? err.message : String(err)}`
      );
      this.connections = [];
      return this.connections;
    }

    const rawConnections: any[] = parsed.connections;
    if (!Array.isArray(rawConnections)) {
      vscode.window.showErrorMessage(
        `"${CONNECTION_FILE}" must contain a "connections" array.`
      );
      this.connections = [];
      return this.connections;
    }

    const validConnections: ConnectionConfig[] = [];

    for (const entry of rawConnections) {
      const missingFields: string[] = [];

      if (!entry.name || typeof entry.name !== 'string') {
        missingFields.push('name');
      }
      if (!entry.host || typeof entry.host !== 'string') {
        missingFields.push('host');
      }

      if (missingFields.length > 0) {
        const entryName = entry.name || '(unnamed)';
        vscode.window.showWarningMessage(
          `Connection "${entryName}" is missing required fields: ${missingFields.join(', ')}. Skipping.`
        );
        continue;
      }

      const config: ConnectionConfig = {
        name: entry.name,
        host: entry.host,
        port: typeof entry.port === 'number' ? entry.port : 1433,
        database: typeof entry.database === 'string' && entry.database.trim() ? entry.database : 'master',
        user: typeof entry.user === 'string' ? entry.user : undefined,
        password: typeof entry.password === 'string' ? entry.password : undefined,
        encrypt: normalizeEncryptValue(entry.encrypt),
        trustServerCertificate: typeof entry.trustServerCertificate === 'boolean' ? entry.trustServerCertificate : undefined,
        authType: entry.authType === 'sql' || entry.authType === 'windows' ? entry.authType : undefined,
      };

      validConnections.push(config);
    }

    this.connections = validConnections;
    return this.connections;
  }

  /**
   * Creates a new mssql.ConnectionPool and connects to the specified configuration.
   * Supports SQL Server auth (user/password) and Windows Auth (via msnodesqlv8 driver when user is omitted).
   * Connection timeout is 30 seconds.
   */
  async connect(config: ConnectionConfig): Promise<mssql.ConnectionPool> {
    let pool: mssql.ConnectionPool;
    const database = config.database || 'master';

    if (config.user) {
      // SQL Server authentication using default Tedious driver
      // Normalize encrypt value (undefined or unrecognized → treat as 'Optional')
      const encryptMode = config.encrypt ?? 'Optional';

      // Map encrypt mode to mssql options
      let encryptOption: boolean;
      let trustServerCertOption: boolean;

      switch (encryptMode) {
        case 'Mandatory':
          encryptOption = true;
          trustServerCertOption = config.trustServerCertificate ?? false;
          break;
        case 'Strict':
          encryptOption = true;
          trustServerCertOption = false; // Forced false for Strict
          break;
        case 'Optional':
        default:
          encryptOption = false;
          trustServerCertOption = config.trustServerCertificate ?? false;
          break;
      }

      const mssqlConfig: mssql.config = {
        server: config.host,
        port: config.port ?? 1433,
        database,
        user: config.user,
        password: config.password,
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        requestTimeout: CONNECTION_TIMEOUT_MS,
        options: {
          encrypt: encryptOption,
          trustServerCertificate: trustServerCertOption,
        },
      };

      pool = new mssql.ConnectionPool(mssqlConfig);
    } else {
      // Windows Authentication using msnodesqlv8 driver
      const driver = detectOdbcDriver();
      const encryptValue = normalizeEncryptValue(config.encrypt) ?? 'Optional';

      // Map encrypt value to ODBC Encrypt keyword
      let encryptKeyword: string;
      switch (encryptValue) {
        case 'Mandatory':
          encryptKeyword = 'Encrypt=yes';
          break;
        case 'Strict':
          encryptKeyword = 'Encrypt=strict';
          break;
        case 'Optional':
        default:
          encryptKeyword = 'Encrypt=no';
          break;
      }

      const connectionStringParts = [
        `Driver={${driver}}`,
        `Server=${config.host}${config.port && config.port !== 1433 ? ',' + config.port : ''}`,
        `Database=${database}`,
        `Trusted_Connection=Yes`,
        encryptKeyword,
      ];

      // Add TrustServerCertificate for Optional/Mandatory (not for Strict)
      if (encryptValue !== 'Strict') {
        connectionStringParts.push(
          `TrustServerCertificate=${config.trustServerCertificate ? 'yes' : 'no'}`
        );
      }

      const connectionString = connectionStringParts.join(';');

      pool = new (getMssqlNative()).ConnectionPool({
        connectionString,
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        requestTimeout: CONNECTION_TIMEOUT_MS,
      } as any);
    }

    try {
      await pool.connect();
    } catch (err: any) {
      // Let the raw error propagate — ErrorCategoryHandler will categorize it
      throw err;
    }

    this.activePool = pool;
    this.activeConfig = config;

    return pool;
  }

  /**
   * Closes the active connection pool.
   */
  async disconnect(): Promise<void> {
    if (this.activePool) {
      try {
        await this.activePool.close();
      } catch {
        // Ignore errors during disconnect
      }
      this.activePool = null;
      this.activeConfig = null;
    }
  }

  /**
   * Returns the currently active connection pool, or null if not connected.
   */
  getActiveConnection(): mssql.ConnectionPool | null {
    return this.activePool;
  }

  /**
   * Returns the currently active connection configuration, or null if not connected.
   */
  getActiveConfig(): ConnectionConfig | null {
    return this.activeConfig;
  }

  /**
   * Disconnects the current connection, connects to the named configuration,
   * and emits the onConnectionChanged event.
   * If connection fails, retains the previous connection and re-throws the error
   * for the caller to handle with categorized error handling.
   */
  async switchConnection(name: string): Promise<void> {
    const config = this.connections.find(c => c.name === name);
    if (!config) {
      vscode.window.showErrorMessage(`Connection "${name}" not found in configuration.`);
      return;
    }

    const previousPool = this.activePool;
    const previousConfig = this.activeConfig;

    try {
      // Disconnect current connection
      await this.disconnect();

      // Connect to the new configuration
      await this.connect(config);

      // Emit connection changed event
      this._onConnectionChanged.fire(this.activeConfig);
    } catch (err) {
      // Restore previous connection on failure
      this.activePool = previousPool;
      this.activeConfig = previousConfig;

      // Re-throw so caller can use ErrorCategoryHandler
      throw err;
    }
  }

  /**
   * Fires the onConnectionChanged event with the current active config.
   * Used by external callers (e.g., switchDatabase) that modify the connection
   * without going through switchConnection().
   */
  fireConnectionChanged(): void {
    this._onConnectionChanged.fire(this.activeConfig);
  }

  /**
   * Disposes of resources.
   */
  dispose(): void {
    this._onConnectionChanged.dispose();
    if (this.activePool) {
      this.activePool.close().catch(() => {});
      this.activePool = null;
      this.activeConfig = null;
    }
  }
}
