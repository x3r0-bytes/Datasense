import * as vscode from 'vscode';
import { ConnectionConfig, ErrorCategory, CategorizedError, ErrorAction } from './types';

const ODBC_DOWNLOAD_URL = 'https://learn.microsoft.com/en-us/sql/connect/odbc/download-odbc-driver-for-sql-server';
const RATE_LIMIT_WINDOW_MS = 5000;

/**
 * Categorizes a connection error into a known category based on the error message
 * and optional error number. This is a pure function with no side effects.
 *
 * Categorization rules:
 * - 'odbc-missing': message contains "Data source name not found" OR "ODBC Driver"
 * - 'invalid-credentials': error has number property === 18456
 * - 'unreachable': message contains "ECONNREFUSED", "ENOTFOUND", or "getaddrinfo"
 * - 'timeout': message contains "ETIMEOUT" or "connect ETIMEDOUT"
 * - 'generic': all other errors
 */
export function categorizeConnectionError(error: Error, config: ConnectionConfig): CategorizedError {
  const message = error.message || '';
  const errorNumber = (error as any).number;
  const host = config.host;
  const port = config.port ?? 1433;

  // Check categories in priority order
  if (message.includes('Data source name not found') || message.includes('ODBC Driver')) {
    return {
      category: 'odbc-missing',
      originalMessage: message,
      displayMessage: 'Microsoft ODBC Driver for SQL Server is not installed. Windows Authentication requires the ODBC driver to be installed on this machine.',
      actions: [
        { label: 'Download Driver', command: 'sqlServer.openOdbcDownload' },
        { label: 'Retry Connection', command: 'sqlServer.retryConnection', args: { config } },
      ],
    };
  }

  if (errorNumber === 18456) {
    return {
      category: 'invalid-credentials',
      originalMessage: message,
      displayMessage: 'Login failed. Please verify your username and password are correct.',
      actions: [
        { label: 'Re-enter Credentials', command: 'sqlServer.reenterCredentials', args: { config } },
      ],
    };
  }

  if (message.includes('ECONNREFUSED') || message.includes('ENOTFOUND') || message.includes('getaddrinfo')) {
    return {
      category: 'unreachable',
      originalMessage: message,
      displayMessage: `Cannot reach server at ${host}:${port}. Please verify the hostname and port are correct and the server is running.`,
      actions: [
        { label: 'Retry Connection', command: 'sqlServer.retryConnection', args: { config } },
      ],
    };
  }

  if (message.includes('ETIMEOUT') || message.includes('connect ETIMEDOUT')) {
    return {
      category: 'timeout',
      originalMessage: message,
      displayMessage: `Connection to ${host}:${port} timed out. The server did not respond within the configured timeout period.`,
      actions: [
        { label: 'Retry with Extended Timeout', command: 'sqlServer.retryWithExtendedTimeout', args: { config } },
        { label: 'Retry Connection', command: 'sqlServer.retryConnection', args: { config } },
      ],
    };
  }

  return {
    category: 'generic',
    originalMessage: message,
    displayMessage: `Connection failed: ${message}`,
    actions: [
      { label: 'Retry Connection', command: 'sqlServer.retryConnection', args: { config } },
    ],
  };
}

/**
 * Handles connection errors by showing appropriate VS Code dialogs with action buttons,
 * logging to the output channel, and rate-limiting repeated notifications.
 */
export class ErrorCategoryHandler {
  private lastNotificationTimestamps: Map<string, number> = new Map();
  private outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  /**
   * Handles a connection error by:
   * 1. Categorizing the error
   * 2. Logging to the output channel
   * 3. Showing a user-facing dialog (unless rate-limited)
   */
  async handleConnectionError(error: Error, config: ConnectionConfig): Promise<void> {
    const categorized = categorizeConnectionError(error, config);

    // Always log to output channel
    this.logError(config, categorized);

    // Check rate limiting — suppress notification if same connection errored within 5 seconds
    if (this.isRateLimited(config.name)) {
      return;
    }

    // Record this notification timestamp
    this.lastNotificationTimestamps.set(config.name, Date.now());

    // Show appropriate dialog
    await this.showErrorDialog(categorized);
  }

  /**
   * Checks whether a notification for this connection name should be suppressed
   * due to rate limiting (5-second window).
   */
  private isRateLimited(connectionName: string): boolean {
    const lastTimestamp = this.lastNotificationTimestamps.get(connectionName);
    if (lastTimestamp === undefined) {
      return false;
    }
    return (Date.now() - lastTimestamp) < RATE_LIMIT_WINDOW_MS;
  }

  /**
   * Logs the error details to the "SQL Server" output channel.
   */
  private logError(config: ConnectionConfig, categorized: CategorizedError): void {
    const port = config.port ?? 1433;
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(
      `[${timestamp}] Connection Error: name="${config.name}", host="${config.host}", port=${port}, category="${categorized.category}", message="${categorized.originalMessage}"`
    );
  }

  /**
   * Shows the appropriate VS Code error dialog based on the error category.
   */
  private async showErrorDialog(categorized: CategorizedError): Promise<void> {
    const actionLabels = categorized.actions.map(a => a.label);

    const selection = await vscode.window.showErrorMessage(
      categorized.displayMessage,
      ...actionLabels
    );

    if (selection) {
      const action = categorized.actions.find(a => a.label === selection);
      if (action) {
        await this.executeAction(action);
      }
    }
  }

  /**
   * Executes the action associated with a dialog button click.
   */
  private async executeAction(action: ErrorAction): Promise<void> {
    switch (action.command) {
      case 'sqlServer.openOdbcDownload':
        await vscode.env.openExternal(vscode.Uri.parse(ODBC_DOWNLOAD_URL));
        break;
      case 'sqlServer.retryConnection':
        if (action.args?.config) {
          await vscode.commands.executeCommand('sqlServer.retryConnection', action.args.config);
        }
        break;
      case 'sqlServer.retryWithExtendedTimeout':
        if (action.args?.config) {
          const extendedConfig = {
            ...action.args.config,
            connectionTimeout: ((action.args.config as any).connectionTimeout || 30000) * 2,
          };
          await vscode.commands.executeCommand('sqlServer.retryConnection', extendedConfig);
        }
        break;
      case 'sqlServer.reenterCredentials':
        if (action.args?.config) {
          await vscode.commands.executeCommand('sqlServer.reenterCredentials', action.args.config);
        }
        break;
      default:
        await vscode.commands.executeCommand(action.command, action.args);
        break;
    }
  }

  /**
   * Disposes of resources.
   */
  dispose(): void {
    this.lastNotificationTimestamps.clear();
  }
}
