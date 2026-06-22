import * as path from 'path';
import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';
import { ConnectionConfig } from './types';

/**
 * Result returned by the sqlServer/refreshSchema request.
 */
export interface RefreshSchemaResult {
  success: boolean;
  tableCount: number;
  viewCount: number;
  procedureCount: number;
}

/**
 * Creates and configures the Language Client for the SQL Server language server.
 *
 * The server communicates over stdio and provides completion capabilities
 * for SQL files. It auto-restarts on crash (default LSP client behavior).
 *
 * @param context - The extension context used to resolve the server module path
 * @returns A configured LanguageClient instance (not yet started)
 */
export function createLanguageClient(context: vscode.ExtensionContext): LanguageClient {
  // Path to the compiled server module
  const serverModule = context.asAbsolutePath(path.join('out', 'server', 'server.js'));

  // Server options: run and debug configurations
  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.stdio,
    },
    debug: {
      module: serverModule,
      transport: TransportKind.stdio,
      options: {
        execArgv: ['--nolazy', '--inspect=6009'],
      },
    },
  };

  // Client options: document selector and file synchronization
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'sql' }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.sql'),
    },
  };

  // Create the language client (auto-restarts on crash by default)
  const client = new LanguageClient(
    'sqlServerLanguageServer',
    'SQL Server Language Server',
    serverOptions,
    clientOptions
  );

  return client;
}

/**
 * Sends a `sqlServer/connectionChanged` notification to the language server.
 * This notifies the server that the active connection has changed so it can
 * refresh its schema cache.
 *
 * @param client - The active LanguageClient instance
 * @param config - The new connection config, or null if disconnected
 */
export function sendConnectionChanged(
  client: LanguageClient,
  config: ConnectionConfig | null
): void {
  client.sendNotification('sqlServer/connectionChanged', { config });
}

/**
 * Sends a `sqlServer/refreshSchema` request to the language server.
 * Returns schema refresh results including counts of tables, views, and procedures.
 *
 * @param client - The active LanguageClient instance
 * @returns The refresh schema result with success status and object counts
 */
export async function requestRefreshSchema(
  client: LanguageClient
): Promise<RefreshSchemaResult> {
  return client.sendRequest<RefreshSchemaResult>('sqlServer/refreshSchema');
}
