// Object Explorer Connection Manager
// Manages server-level connections where the database field is optional.
// Handles persistence to .sql-connections.json, connection pooling, and error recovery.

import * as mssql from 'mssql';
import * as fs from 'fs';
import * as path from 'path';
import { ServerConnectionConfig, ConnectionGroup } from './types';
import { getEffectiveDatabase } from './nodeUtils';

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

export class ObjectExplorerConnectionManager {
  private pools: Map<string, mssql.ConnectionPool> = new Map();
  private connections: ServerConnectionConfig[] = [];
  private groups: ConnectionGroup[] = [];
  private readonly filePath: string;

  constructor(private readonly workspaceRoot: string) {
    this.filePath = path.join(workspaceRoot, CONNECTION_FILE);
  }

  /**
   * Reads `.sql-connections.json` from the workspace root.
   * Skips invalid entries and returns only valid ones.
   * Treats file-not-found as empty state.
   */
  loadConnections(): ServerConnectionConfig[] {
    if (!fs.existsSync(this.filePath)) {
      this.connections = [];
      return [];
    }

    let fileContent: string;
    try {
      fileContent = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      this.connections = [];
      return [];
    }

    let parsed: any;
    try {
      parsed = JSON.parse(fileContent);
    } catch {
      // Invalid JSON — treat as empty
      this.connections = [];
      return [];
    }

    const rawConnections: any[] = parsed?.connections;
    if (!Array.isArray(rawConnections)) {
      this.connections = [];
      return [];
    }

    const validConnections: ServerConnectionConfig[] = [];

    for (const entry of rawConnections) {
      if (!isValidConnectionEntry(entry)) {
        continue;
      }

      const config: ServerConnectionConfig = {
        name: entry.name,
        host: entry.host,
        port: typeof entry.port === 'number' ? entry.port : undefined,
        database: typeof entry.database === 'string' ? entry.database : undefined,
        authType: entry.authType || (entry.user ? 'sql' : 'windows'),
        user: typeof entry.user === 'string' ? entry.user : undefined,
        encrypt: typeof entry.encrypt === 'boolean' ? entry.encrypt : undefined,
        trustServerCertificate: typeof entry.trustServerCertificate === 'boolean' ? entry.trustServerCertificate : undefined,
        color: typeof entry.color === 'string' ? entry.color : undefined,
        group: typeof entry.group === 'string' ? entry.group : undefined,
      };

      validConnections.push(config);
    }

    // Load groups array if present
    const rawGroups: any[] = parsed?.groups;
    if (Array.isArray(rawGroups)) {
      this.groups = rawGroups.filter(
        (g: any) => typeof g === 'object' && g !== null &&
          typeof g.name === 'string' && g.name.trim() !== '' &&
          typeof g.color === 'string' && g.color.trim() !== ''
      ).map((g: any) => ({ name: g.name, color: g.color }));
    } else {
      this.groups = [];
    }

    this.connections = validConnections;
    return validConnections;
  }

  /**
   * Appends a connection to the file, excluding the password field.
   * Creates the file if it does not exist.
   * On file write errors, retains the connection in memory for the current session.
   */
  async saveConnection(config: ServerConnectionConfig): Promise<void> {
    // Add to in-memory list (without password)
    const configWithoutPassword: ServerConnectionConfig = { ...config };
    delete configWithoutPassword.password;
    this.connections.push(configWithoutPassword);

    // Persist to file
    try {
      const fileData: any = {
        connections: this.connections.map(c => serializeConnection(c)),
      };
      if (this.groups.length > 0) {
        fileData.groups = this.groups;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(fileData, null, 2), 'utf-8');
    } catch {
      // File write error — connection retained in memory for current session
    }
  }

  /**
   * Removes a connection by name from the file and in-memory list.
   * On file write errors, still removes from memory.
   */
  async removeConnection(name: string): Promise<void> {
    this.connections = this.connections.filter(c => c.name !== name);

    // Close any pools associated with this connection
    const keysToRemove: string[] = [];
    for (const [key, pool] of this.pools.entries()) {
      if (key === name || key.startsWith(`${name}:`)) {
        try {
          await pool.close();
        } catch {
          // Ignore close errors
        }
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      this.pools.delete(key);
    }

    // Persist to file
    try {
      const fileData: any = {
        connections: this.connections.map(c => serializeConnection(c)),
      };
      if (this.groups.length > 0) {
        fileData.groups = this.groups;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(fileData, null, 2), 'utf-8');
    } catch {
      // File write error — removal still applied in memory
    }
  }

  /**
   * Creates or reuses a connection pool for a server-level connection.
   * Uses the effective database (defaults to "master" when none specified).
   */
  async getPool(connectionName: string): Promise<mssql.ConnectionPool> {
    const poolKey = connectionName;

    const existingPool = this.pools.get(poolKey);
    if (existingPool && existingPool.connected) {
      return existingPool;
    }

    const config = this.connections.find(c => c.name === connectionName);
    if (!config) {
      throw new Error(`Connection "${connectionName}" not found.`);
    }

    const effectiveDb = getEffectiveDatabase(config);
    const pool = await this.createPool(config, effectiveDb);
    this.pools.set(poolKey, pool);
    return pool;
  }

  /**
   * Creates a connection pool targeting a specific database.
   * Pool key includes both connection name and database for reuse.
   */
  async getPoolForDatabase(connectionName: string, database: string): Promise<mssql.ConnectionPool> {
    const poolKey = `${connectionName}:${database}`;

    const existingPool = this.pools.get(poolKey);
    if (existingPool && existingPool.connected) {
      return existingPool;
    }

    const config = this.connections.find(c => c.name === connectionName);
    if (!config) {
      throw new Error(`Connection "${connectionName}" not found.`);
    }

    const pool = await this.createPool(config, database);
    this.pools.set(poolKey, pool);
    return pool;
  }

  /**
   * Closes all connection pools and clears internal state.
   */
  dispose(): void {
    for (const pool of this.pools.values()) {
      try {
        pool.close().catch(() => {});
      } catch {
        // Ignore close errors during dispose
      }
    }
    this.pools.clear();
  }

  /**
   * Returns the current in-memory connections list.
   */
  getConnections(): ServerConnectionConfig[] {
    return [...this.connections];
  }

  /**
   * Retrieves a connection config by name (case-insensitive).
   * Returns undefined if no connection with that name exists.
   */
  getConfigByName(name: string): ServerConnectionConfig | undefined {
    const lower = name.toLowerCase();
    return this.connections.find(c => c.name.toLowerCase() === lower);
  }

  /**
   * Returns the current in-memory connection groups.
   */
  getGroups(): ConnectionGroup[] {
    return [...this.groups];
  }

  /**
   * Adds a new connection group. Persists to file.
   */
  async addGroup(group: ConnectionGroup): Promise<void> {
    this.groups.push(group);
    this.persistToFile();
  }

  /**
   * Removes a connection group by name. Unassigns connections from that group.
   * Persists to file.
   */
  async removeGroup(groupName: string): Promise<void> {
    this.groups = this.groups.filter(g => g.name !== groupName);
    // Unassign connections that belonged to this group
    for (const conn of this.connections) {
      if (conn.group === groupName) {
        delete conn.group;
      }
    }
    this.persistToFile();
  }

  /**
   * Assigns a connection to a group (or removes assignment if groupName is undefined).
   * Persists to file.
   */
  async assignConnectionToGroup(connectionName: string, groupName: string | undefined): Promise<void> {
    const conn = this.connections.find(c => c.name === connectionName);
    if (conn) {
      if (groupName) {
        conn.group = groupName;
      } else {
        delete conn.group;
      }
      this.persistToFile();
    }
  }

  /**
   * Persists current connections and groups state to the .sql-connections.json file.
   */
  private persistToFile(): void {
    try {
      const fileData: any = {
        connections: this.connections.map(c => serializeConnection(c)),
      };
      if (this.groups.length > 0) {
        fileData.groups = this.groups;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(fileData, null, 2), 'utf-8');
    } catch {
      // File write error — state retained in memory
    }
  }

  /**
   * Replaces the connection entry matching oldName with newConfig,
   * persists to .sql-connections.json, and closes any pools associated with the old name.
   */
  async updateConnection(oldName: string, newConfig: ServerConnectionConfig): Promise<void> {
    // Find and replace the entry with matching name
    const index = this.connections.findIndex(c => c.name === oldName);
    if (index === -1) {
      throw new Error(`Connection "${oldName}" not found.`);
    }

    // Replace in-memory entry (without password)
    const configWithoutPassword: ServerConnectionConfig = { ...newConfig };
    delete configWithoutPassword.password;
    this.connections[index] = configWithoutPassword;

    // Close any pools associated with the old name
    const keysToRemove: string[] = [];
    for (const [key, pool] of this.pools.entries()) {
      if (key === oldName || key.startsWith(`${oldName}:`)) {
        try {
          await pool.close();
        } catch {
          // Ignore close errors
        }
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      this.pools.delete(key);
    }

    // Persist to file
    try {
      const fileData: any = {
        connections: this.connections.map(c => serializeConnection(c)),
      };
      if (this.groups.length > 0) {
        fileData.groups = this.groups;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(fileData, null, 2), 'utf-8');
    } catch {
      // File write error — update still applied in memory
    }
  }

  /**
   * Creates a new mssql.ConnectionPool for the given config and database.
   */
  private async createPool(config: ServerConnectionConfig, database: string): Promise<mssql.ConnectionPool> {
    let pool: mssql.ConnectionPool;

    if (config.authType === 'sql' && config.user) {
      // SQL Server authentication using default Tedious driver
      const mssqlConfig: mssql.config = {
        server: config.host,
        port: config.port ?? 1433,
        database,
        user: config.user,
        password: config.password,
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        requestTimeout: CONNECTION_TIMEOUT_MS,
        options: {
          encrypt: config.encrypt ?? false,
          trustServerCertificate: config.trustServerCertificate ?? false,
        },
      };

      pool = new mssql.ConnectionPool(mssqlConfig);
    } else {
      // Windows Authentication using msnodesqlv8 driver
      const serverPart = config.host + (config.port && config.port !== 1433 ? `,${config.port}` : '');
      const driver = detectOdbcDriver();
      const connectionString = [
        `Driver={${driver}}`,
        `Server=${serverPart}`,
        `Database=${database}`,
        `Trusted_Connection=Yes`,
      ].join(';');

      pool = new (getMssqlNative()).ConnectionPool({
        connectionString,
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        requestTimeout: CONNECTION_TIMEOUT_MS,
        options: {
          encrypt: config.encrypt ?? false,
          trustServerCertificate: config.trustServerCertificate ?? false,
        },
      } as any);
    }

    try {
      await pool.connect();
    } catch (err: any) {
      throw err;
    }
    return pool;
  }
}

/**
 * Validates that an entry from the JSON file has the minimum required fields.
 * authType is optional — inferred as 'sql' if user is present, 'windows' otherwise.
 */
function isValidConnectionEntry(entry: any): boolean {
  if (!entry || typeof entry !== 'object') {
    return false;
  }
  if (!entry.name || typeof entry.name !== 'string') {
    return false;
  }
  if (!entry.host || typeof entry.host !== 'string') {
    return false;
  }
  // authType is optional — will be inferred during loading
  if (entry.authType && entry.authType !== 'sql' && entry.authType !== 'windows') {
    return false;
  }
  return true;
}

/**
 * Serializes a connection config for persistence, excluding the password field.
 */
function serializeConnection(config: ServerConnectionConfig): object {
  const { password, ...rest } = config;
  // Remove undefined fields for cleaner JSON
  const serialized: Record<string, any> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) {
      serialized[key] = value;
    }
  }
  return serialized;
}
