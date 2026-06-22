import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

/**
 * Property-based tests for Connection Manager config parsing (Properties 14-15)
 * Validates: Requirements 4.1, 4.2, 4.10
 */

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Mock vscode module
vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [
      { uri: { fsPath: '/test-workspace' } }
    ]
  },
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  EventEmitter: class {
    private listeners: Function[] = [];
    event = (listener: Function) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(data: any) {
      this.listeners.forEach(l => l(data));
    }
    dispose() {}
  }
}));

// Mock mssql module
vi.mock('mssql', () => {
  class MockConnectionPool {
    config: any;
    constructor(config: any) {
      this.config = config;
    }
    async connect() { return this; }
    async close() {}
  }
  return {
    ConnectionPool: MockConnectionPool
  };
});

import * as fs from 'fs';
import * as vscode from 'vscode';
import { ConnectionManager } from '../../src/connectionManager';

const mockedFs = vi.mocked(fs);

// --- Generators ---

/** Generator: valid SQL identifier string (non-empty, alphanumeric + underscore, starts with letter) */
const arbitraryName: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_- '.split('')),
      { minLength: 0, maxLength: 20 }
    )
  )
  .map(([first, rest]) => first + rest);

/** Generator: valid hostname string */
const arbitraryHost: fc.Arbitrary<string> = fc.oneof(
  fc.constant('localhost'),
  fc.domain(),
  fc.ipV4()
);

/** Generator: valid database name */
const arbitraryDatabase: fc.Arbitrary<string> = arbitraryName;

/** Generator: valid port number */
const arbitraryPort: fc.Arbitrary<number> = fc.integer({ min: 1, max: 65535 });

/** Generator: a valid connection config with all required fields and optional fields */
const arbitraryValidConnectionConfig: fc.Arbitrary<{
  name: string;
  host: string;
  database: string;
  port?: number;
  user?: string;
  password?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
}> = fc.record({
  name: arbitraryName,
  host: arbitraryHost,
  database: arbitraryDatabase,
  port: fc.option(arbitraryPort, { nil: undefined }),
  user: fc.option(arbitraryName, { nil: undefined }),
  password: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
  encrypt: fc.option(fc.boolean(), { nil: undefined }),
  trustServerCertificate: fc.option(fc.boolean(), { nil: undefined }),
});

/** Generator: an invalid connection config missing one or more required fields (name or host) */
const arbitraryInvalidConnectionConfig: fc.Arbitrary<Record<string, any>> = fc.oneof(
  // Missing name
  fc.record({
    host: arbitraryHost,
    database: arbitraryDatabase,
    port: fc.option(arbitraryPort, { nil: undefined }),
  }).map(({ host, database, port }) => {
    const obj: Record<string, any> = { host, database };
    if (port !== undefined) obj.port = port;
    return obj;
  }),
  // Missing host
  fc.record({
    name: arbitraryName,
    database: arbitraryDatabase,
    port: fc.option(arbitraryPort, { nil: undefined }),
  }).map(({ name, database, port }) => {
    const obj: Record<string, any> = { name, database };
    if (port !== undefined) obj.port = port;
    return obj;
  }),
  // Missing all required fields
  fc.record({
    port: fc.option(arbitraryPort, { nil: undefined }),
    user: fc.option(arbitraryName, { nil: undefined }),
  }).map(({ port, user }) => {
    const obj: Record<string, any> = {};
    if (port !== undefined) obj.port = port;
    if (user !== undefined) obj.user = user;
    return obj;
  })
);

// --- Tests ---

describe('ConnectionManager Property Tests', () => {
  let manager: ConnectionManager;

  beforeEach(() => {
    manager = new ConnectionManager();
    vi.clearAllMocks();
  });

  describe('Property 14: Connection config parsing with defaults', () => {
    /**
     * Validates: Requirements 4.1, 4.2
     *
     * For any valid JSON connection configuration object containing the required fields
     * (name, host, database) and any combination of optional fields, parsing SHALL produce
     * a ConnectionConfig where: port defaults to 1433 when omitted, and all provided
     * optional fields retain their specified values.
     */
    it('valid configs produce ConnectionConfig with port defaulted to 1433 when not specified and all fields preserved', () => {
      fc.assert(
        fc.property(arbitraryValidConnectionConfig, (config) => {
          const configData = JSON.stringify({
            connections: [config]
          });

          mockedFs.existsSync.mockReturnValue(true);
          mockedFs.readFileSync.mockReturnValue(configData);

          const result = manager.loadConnections();

          expect(result).toHaveLength(1);
          const parsed = result[0];

          // Required fields are preserved
          expect(parsed.name).toBe(config.name);
          expect(parsed.host).toBe(config.host);
          expect(parsed.database).toBe(config.database);

          // Port defaults to 1433 when not specified
          if (config.port !== undefined) {
            expect(parsed.port).toBe(config.port);
          } else {
            expect(parsed.port).toBe(1433);
          }

          // Optional fields retain their specified values
          if (config.user !== undefined) {
            expect(parsed.user).toBe(config.user);
          } else {
            expect(parsed.user).toBeUndefined();
          }

          if (config.password !== undefined) {
            expect(parsed.password).toBe(config.password);
          } else {
            expect(parsed.password).toBeUndefined();
          }

          if (config.encrypt !== undefined) {
            expect(parsed.encrypt).toBe(config.encrypt);
          } else {
            expect(parsed.encrypt).toBeUndefined();
          }

          if (config.trustServerCertificate !== undefined) {
            expect(parsed.trustServerCertificate).toBe(config.trustServerCertificate);
          } else {
            expect(parsed.trustServerCertificate).toBeUndefined();
          }
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 15: Invalid connection config exclusion', () => {
    /**
     * Validates: Requirements 4.10
     *
     * For any connection configuration object missing one or more required fields
     * (name, host, or database), the connection manager SHALL exclude that entry
     * from the available connections list and a warning should be shown.
     */
    it('configs missing required fields are excluded and a warning is shown', () => {
      fc.assert(
        fc.property(arbitraryInvalidConnectionConfig, (invalidConfig) => {
          const configData = JSON.stringify({
            connections: [invalidConfig]
          });

          mockedFs.existsSync.mockReturnValue(true);
          mockedFs.readFileSync.mockReturnValue(configData);

          const result = manager.loadConnections();

          // Invalid entry should be excluded
          expect(result).toHaveLength(0);

          // A warning should be shown
          expect(vscode.window.showWarningMessage).toHaveBeenCalled();
        }),
        { numRuns: 100 }
      );
    });

    it('invalid configs are excluded while valid configs are preserved', () => {
      fc.assert(
        fc.property(
          arbitraryValidConnectionConfig,
          arbitraryInvalidConnectionConfig,
          (validConfig, invalidConfig) => {
            const configData = JSON.stringify({
              connections: [invalidConfig, validConfig]
            });

            mockedFs.existsSync.mockReturnValue(true);
            mockedFs.readFileSync.mockReturnValue(configData);

            const result = manager.loadConnections();

            // Only the valid entry should be in the result
            expect(result).toHaveLength(1);
            expect(result[0].name).toBe(validConfig.name);
            expect(result[0].host).toBe(validConfig.host);
            expect(result[0].database).toBe(validConfig.database);

            // A warning should be shown for the invalid entry
            expect(vscode.window.showWarningMessage).toHaveBeenCalled();
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
