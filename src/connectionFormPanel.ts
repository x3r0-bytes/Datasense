// Connection Form Panel
// Webview-based connection form for Add, Edit, and Duplicate connection workflows.
// Communicates with the extension host via postMessage protocol.

import * as vscode from 'vscode';
import * as mssql from 'mssql';
import { ServerConnectionConfig } from './objectExplorer/types';
import { ObjectExplorerConnectionManager } from './objectExplorer/objectExplorerConnectionManager';
import { ObjectExplorerProvider } from './objectExplorer/objectExplorerProvider';
import { isDisplayNameUnique, isPortValid } from './objectExplorer/connectionFormValidator';
import { PREDEFINED_COLORS, isValidHexColor } from './connectionColorIndicator';

// Use the msnodesqlv8 variant for Windows Authentication
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mssqlNative = require('mssql/msnodesqlv8') as typeof mssql;

/**
 * Data structure for form submissions from the webview.
 */
export interface ConnectionFormData {
  connectionName: string;
  server: string;
  port: number;
  database: string;
  authType: 'sql' | 'windows';
  username: string;
  password: string;
  color: string;
}

/**
 * Message types sent from the webview to the extension host.
 */
type WebviewMessage =
  | { type: 'submit'; data: ConnectionFormData }
  | { type: 'testConnection'; data: ConnectionFormData }
  | { type: 'cancel' };

/**
 * Validates connection form data and returns a map of field names to error messages.
 * Returns an empty object if all fields are valid.
 *
 * Extracted as a pure function for testability.
 *
 * @param data - The form data to validate
 * @param existingNames - List of existing connection names (for uniqueness check)
 * @param editingConnectionName - If in edit mode, the name of the connection being edited (excluded from uniqueness check)
 */
export function validateConnectionFormData(
  data: ConnectionFormData,
  existingNames: string[],
  editingConnectionName?: string
): Record<string, string> {
  const errors: Record<string, string> = {};

  // Connection Name: required, non-empty
  if (!data.connectionName || data.connectionName.trim().length === 0) {
    errors.connectionName = 'Connection Name is required';
  } else {
    // Connection Name: must be unique (case-insensitive)
    const namesToCheck = editingConnectionName
      ? existingNames.filter(n => n.toLowerCase() !== editingConnectionName.toLowerCase())
      : existingNames;

    if (!isDisplayNameUnique(data.connectionName.trim(), namesToCheck)) {
      errors.connectionName = 'A connection with this name already exists';
    }
  }

  // Server/Host: required, non-empty
  if (!data.server || data.server.trim().length === 0) {
    errors.server = 'Server / Host is required';
  }

  // Port: must be between 1 and 65535
  if (!isPortValid(data.port)) {
    errors.port = 'Port must be an integer between 1 and 65535';
  }

  // Username: required when SQL Auth is selected
  if (data.authType === 'sql') {
    if (!data.username || data.username.trim().length === 0) {
      errors.username = 'Username is required for SQL Authentication';
    }
  }

  // Color: must be valid #RRGGBB format if provided
  if (data.color && data.color.trim().length > 0) {
    if (!isValidHexColor(data.color.trim())) {
      errors.color = 'Color must be a valid hex value in #RRGGBB format';
    }
  }

  return errors;
}

/**
 * Manages a webview panel for adding, editing, or duplicating SQL Server connections.
 * Supports three modes:
 * - Add: blank form for creating a new connection
 * - Edit: pre-populated form for updating an existing connection (password blank)
 * - Prefill (Duplicate): pre-populated form for creating a copy (name suffixed with "(Copy)")
 */
export class ConnectionFormPanel {
  public static readonly viewType = 'sqlServer.connectionForm';
  private panel: vscode.WebviewPanel | undefined;
  private editingConnectionName: string | undefined;

  constructor(
    private extensionUri: vscode.Uri,
    private objectExplorerConnectionManager: ObjectExplorerConnectionManager,
    private objectExplorerProvider: ObjectExplorerProvider
  ) {}

  /**
   * Opens the connection form webview panel.
   * @param editConnection - If provided, opens in Edit mode with pre-populated fields
   * @param prefillData - If provided (without editConnection), opens in Add mode with pre-filled fields (Duplicate)
   */
  public open(editConnection?: ServerConnectionConfig, prefillData?: ServerConnectionConfig): void {
    // Determine mode
    const isEditMode = !!editConnection;
    const isPrefillMode = !isEditMode && !!prefillData;
    this.editingConnectionName = editConnection?.name;

    const title = isEditMode ? 'Edit Connection' : 'Add Connection';
    const iconId = isEditMode ? 'edit' : 'add';

    // Dispose existing panel if open
    if (this.panel) {
      this.panel.dispose();
    }

    this.panel = vscode.window.createWebviewPanel(
      ConnectionFormPanel.viewType,
      title,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [this.extensionUri],
      }
    );

    this.panel.iconPath = new vscode.ThemeIcon(iconId);

    // Determine what data to pre-populate
    const populateData = editConnection || prefillData;
    this.panel.webview.html = this.getFormHtml(populateData, isEditMode, isPrefillMode);

    // Handle messages from the webview
    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this.handleMessage(msg),
      undefined
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.editingConnectionName = undefined;
    });
  }

  /**
   * Handles messages received from the webview form.
   */
  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'submit':
        await this.handleSubmit(msg.data);
        break;
      case 'testConnection':
        await this.handleTestConnection(msg.data);
        break;
      case 'cancel':
        this.panel?.dispose();
        break;
    }
  }

  /**
   * Handles form submission. Validates input and saves/updates the connection.
   */
  private async handleSubmit(data: ConnectionFormData): Promise<void> {
    // Validate form data
    const errors = this.validateFormData(data);
    if (Object.keys(errors).length > 0) {
      this.postMessage({ type: 'validationError', errors });
      return;
    }

    // Build the ServerConnectionConfig from form data
    const config: ServerConnectionConfig = {
      name: data.connectionName,
      host: data.server,
      port: data.port,
      database: data.database || undefined,
      authType: data.authType,
      user: data.authType === 'sql' ? data.username : undefined,
      password: data.authType === 'sql' && data.password ? data.password : undefined,
      color: data.color && data.color.trim().length > 0 ? data.color.trim() : undefined,
    };

    if (this.editingConnectionName) {
      // Edit mode: remove old connection, save updated one
      await this.objectExplorerConnectionManager.removeConnection(this.editingConnectionName);
      await this.objectExplorerConnectionManager.saveConnection(config);
    } else {
      // Add mode: save new connection
      await this.objectExplorerConnectionManager.saveConnection(config);
    }

    // Refresh Object Explorer tree and close the panel
    this.objectExplorerProvider.refresh();
    this.panel?.dispose();
  }

  /**
   * Validates form data and returns a map of field names to error messages.
   * Returns an empty object if all fields are valid.
   * Delegates to the exported `validateConnectionFormData` function.
   */
  private validateFormData(data: ConnectionFormData): Record<string, string> {
    const existingNames = this.objectExplorerConnectionManager
      .getConnections()
      .map(c => c.name);

    return validateConnectionFormData(data, existingNames, this.editingConnectionName);
  }

  /**
   * Handles test connection requests. Creates a temporary pool to verify connectivity.
   */
  private async handleTestConnection(data: ConnectionFormData): Promise<void> {
    let pool: mssql.ConnectionPool | undefined;

    try {
      const database = data.database || 'master';
      const connectionTimeout = 15000;

      if (data.authType === 'sql') {
        // SQL Server authentication using default Tedious driver
        const mssqlConfig: mssql.config = {
          server: data.server,
          port: data.port || 1433,
          database,
          user: data.username,
          password: data.password,
          connectionTimeout,
          requestTimeout: connectionTimeout,
          options: {
            encrypt: false,
            trustServerCertificate: false,
          },
        };

        pool = new mssql.ConnectionPool(mssqlConfig);
      } else {
        // Windows Authentication using msnodesqlv8 driver
        const port = data.port || 1433;
        const serverPart = data.server + (port !== 1433 ? `,${port}` : '');
        const connectionString = [
          `Driver={ODBC Driver 17 for SQL Server}`,
          `Server=${serverPart}`,
          `Database=${database}`,
          `Trusted_Connection=Yes`,
        ].join(';');

        pool = new mssqlNative.ConnectionPool({
          connectionString,
          connectionTimeout,
          requestTimeout: connectionTimeout,
          options: {
            encrypt: false,
            trustServerCertificate: false,
          },
        } as any);
      }

      await pool.connect();
      this.postMessage({ type: 'testResult', success: true, message: 'Connection successful' });
    } catch (err: any) {
      const message = err?.message || 'Unknown connection error';
      this.postMessage({ type: 'testResult', success: false, message });
    } finally {
      // Always close the temporary pool
      if (pool) {
        try {
          await pool.close();
        } catch {
          // Ignore close errors
        }
      }
    }
  }

  /**
   * Posts a message back to the webview.
   */
  public postMessage(message: any): void {
    this.panel?.webview.postMessage(message);
  }

  /**
   * Generates the themed HTML form for the webview panel.
   */
  private getFormHtml(
    populateData: ServerConnectionConfig | undefined,
    isEditMode: boolean,
    isPrefillMode: boolean
  ): string {
    // Determine field values
    const connectionName = isPrefillMode && populateData
      ? `${populateData.name} (Copy)`
      : (populateData?.name || '');
    const server = populateData?.host || '';
    const port = populateData?.port?.toString() || '1433';
    const database = populateData?.database || '';
    const authType = populateData?.authType || 'sql';
    const username = populateData?.user || '';
    const savedColor = populateData?.color || '';
    const passwordPlaceholder = isEditMode
      ? 'Password required at connect time'
      : 'Enter password';

    // Determine which field to focus
    const focusField = isPrefillMode ? 'connectionName' : (isEditMode ? '' : 'connectionName');

    // Generate predefined color swatches HTML
    const swatchesHtml = PREDEFINED_COLORS.map(c => {
      const isSelected = savedColor.toUpperCase() === c.hex.toUpperCase();
      return `<button type="button" class="color-swatch${isSelected ? ' selected' : ''}" data-color="${c.hex}" title="${c.name}" aria-label="${c.name}" style="background-color: ${c.hex};"></button>`;
    }).join('\n            ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${isEditMode ? 'Edit Connection' : 'Add Connection'}</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 20px 40px;
      line-height: 1.6;
    }

    h1 {
      font-size: 1.4em;
      font-weight: 600;
      margin-bottom: 20px;
      color: var(--vscode-foreground);
    }

    .form-group {
      margin-bottom: 16px;
    }

    label {
      display: block;
      margin-bottom: 4px;
      font-weight: 500;
      color: var(--vscode-foreground);
    }

    label .required {
      color: var(--vscode-errorForeground);
      margin-left: 2px;
    }

    input[type="text"],
    input[type="number"],
    input[type="password"] {
      width: 100%;
      max-width: 400px;
      padding: 6px 10px;
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 2px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      outline: none;
    }

    input[type="text"]:focus,
    input[type="number"]:focus,
    input[type="password"]:focus {
      border-color: var(--vscode-focusBorder);
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    .radio-group {
      display: flex;
      gap: 16px;
      margin-top: 4px;
    }

    .radio-group label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: normal;
      cursor: pointer;
    }

    input[type="radio"] {
      accent-color: var(--vscode-focusBorder);
    }

    .sql-auth-fields {
      margin-top: 12px;
      padding-left: 0;
    }

    .hidden {
      display: none;
    }

    .error-message {
      color: var(--vscode-errorForeground);
      font-size: 0.9em;
      margin-top: 4px;
      display: none;
    }

    .error-message.visible {
      display: block;
    }

    .button-row {
      margin-top: 24px;
      display: flex;
      gap: 10px;
      align-items: center;
    }

    button {
      padding: 6px 14px;
      border: none;
      border-radius: 2px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      cursor: pointer;
      outline: none;
    }

    button:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }

    .btn-primary {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .btn-primary:hover {
      background-color: var(--vscode-button-hoverBackground);
    }

    .btn-secondary {
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .btn-secondary:hover {
      background-color: var(--vscode-button-secondaryHoverBackground);
    }

    .test-result {
      margin-top: 12px;
      padding: 8px 12px;
      border-radius: 2px;
      font-size: 0.9em;
      display: none;
    }

    .test-result.success {
      display: block;
      background-color: var(--vscode-inputValidation-infoBackground, rgba(0, 122, 204, 0.1));
      border: 1px solid var(--vscode-inputValidation-infoBorder, #007acc);
      color: var(--vscode-foreground);
    }

    .test-result.failure {
      display: block;
      background-color: var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1));
      border: 1px solid var(--vscode-inputValidation-errorBorder, #f44747);
      color: var(--vscode-errorForeground);
    }

    .separator {
      border: none;
      border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      margin: 20px 0;
    }

    .color-picker-section {
      margin-bottom: 16px;
    }

    .color-swatches {
      display: flex;
      gap: 8px;
      margin-top: 6px;
      margin-bottom: 8px;
      flex-wrap: wrap;
      align-items: center;
    }

    .color-swatch {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: 2px solid transparent;
      cursor: pointer;
      outline: none;
      transition: border-color 0.15s, transform 0.15s;
    }

    .color-swatch:hover {
      transform: scale(1.15);
    }

    .color-swatch:focus {
      outline: 2px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }

    .color-swatch.selected {
      border-color: var(--vscode-foreground);
      transform: scale(1.15);
    }

    .custom-color-row {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-top: 8px;
    }

    .custom-color-row input[type="text"] {
      width: 120px;
      max-width: 120px;
      font-family: var(--vscode-editor-font-family, monospace);
    }

    .color-preview {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      display: none;
    }

    .color-preview.visible {
      display: block;
    }

    .btn-clear-color {
      padding: 4px 10px;
      font-size: 0.85em;
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
    }

    .btn-clear-color:hover {
      background-color: var(--vscode-button-secondaryHoverBackground);
    }
  </style>
</head>
<body>
  <h1>${isEditMode ? 'Edit Connection' : 'Add Connection'}</h1>

  <form id="connectionForm" autocomplete="off">
    <div class="form-group">
      <label for="connectionName">Connection Name<span class="required">*</span></label>
      <input type="text" id="connectionName" name="connectionName" value="${this.escapeHtml(connectionName)}" placeholder="e.g., My Local Server" required tabindex="1" />
      <div class="error-message" id="connectionName-error"></div>
    </div>

    <div class="form-group">
      <label for="server">Server / Host<span class="required">*</span></label>
      <input type="text" id="server" name="server" value="${this.escapeHtml(server)}" placeholder="e.g., localhost or myserver.database.windows.net" required tabindex="2" />
      <div class="error-message" id="server-error"></div>
    </div>

    <div class="form-group">
      <label for="port">Port</label>
      <input type="number" id="port" name="port" value="${this.escapeHtml(port)}" placeholder="1433" min="1" max="65535" tabindex="3" />
      <div class="error-message" id="port-error"></div>
    </div>

    <div class="form-group">
      <label for="database">Database</label>
      <input type="text" id="database" name="database" value="${this.escapeHtml(database)}" placeholder="master" tabindex="4" />
      <div class="error-message" id="database-error"></div>
    </div>

    <hr class="separator" />

    <div class="form-group">
      <label>Authentication Type<span class="required">*</span></label>
      <div class="radio-group">
        <label>
          <input type="radio" name="authType" value="sql" ${authType === 'sql' ? 'checked' : ''} tabindex="5" />
          SQL Authentication
        </label>
        <label>
          <input type="radio" name="authType" value="windows" ${authType === 'windows' ? 'checked' : ''} tabindex="6" />
          Windows Authentication
        </label>
      </div>
    </div>

    <div class="sql-auth-fields ${authType === 'windows' ? 'hidden' : ''}" id="sqlAuthFields">
      <div class="form-group">
        <label for="username">Username<span class="required">*</span></label>
        <input type="text" id="username" name="username" value="${this.escapeHtml(username)}" placeholder="SQL Server username" tabindex="7" />
        <div class="error-message" id="username-error"></div>
      </div>

      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" value="" placeholder="${this.escapeHtml(passwordPlaceholder)}" tabindex="8" />
        <div class="error-message" id="password-error"></div>
      </div>
    </div>

    <hr class="separator" />

    <div class="form-group color-picker-section">
      <label>Connection Color</label>
      <div class="color-swatches">
        ${swatchesHtml}
      </div>
      <div class="custom-color-row">
        <input type="text" id="customColor" name="customColor" value="${this.escapeHtml(savedColor)}" placeholder="#RRGGBB" maxlength="7" tabindex="9" />
        <div class="color-preview" id="colorPreview"></div>
        <button type="button" class="btn-clear-color" id="clearColorBtn" tabindex="10">Clear</button>
      </div>
      <div class="error-message" id="color-error"></div>
    </div>

    <hr class="separator" />

    <div class="button-row">
      <button type="submit" class="btn-primary" tabindex="11">Save</button>
      <button type="button" class="btn-secondary" id="testConnectionBtn" tabindex="12">Test Connection</button>
      <button type="button" class="btn-secondary" id="cancelBtn" tabindex="13">Cancel</button>
    </div>

    <div class="test-result" id="testResult"></div>
  </form>

  <script>
    (function() {
      const vscode = acquireVsCodeApi();

      const form = document.getElementById('connectionForm');
      const authRadios = document.querySelectorAll('input[name="authType"]');
      const sqlAuthFields = document.getElementById('sqlAuthFields');
      const testConnectionBtn = document.getElementById('testConnectionBtn');
      const cancelBtn = document.getElementById('cancelBtn');
      const testResultDiv = document.getElementById('testResult');
      const customColorInput = document.getElementById('customColor');
      const colorPreview = document.getElementById('colorPreview');
      const clearColorBtn = document.getElementById('clearColorBtn');
      const colorSwatches = document.querySelectorAll('.color-swatch');

      // Toggle SQL Auth fields visibility based on auth type selection
      authRadios.forEach(radio => {
        radio.addEventListener('change', function() {
          if (this.value === 'sql') {
            sqlAuthFields.classList.remove('hidden');
          } else {
            sqlAuthFields.classList.add('hidden');
          }
        });
      });

      // --- Color Picker Logic ---
      const hexPattern = /^#[0-9A-Fa-f]{6}$/;

      function selectSwatch(hex) {
        // Deselect all swatches
        colorSwatches.forEach(s => s.classList.remove('selected'));
        // Select the matching swatch if any
        colorSwatches.forEach(s => {
          if (s.dataset.color.toUpperCase() === hex.toUpperCase()) {
            s.classList.add('selected');
          }
        });
        // Update the custom input
        customColorInput.value = hex;
        updateColorPreview(hex);
        // Clear any color error
        const errorEl = document.getElementById('color-error');
        if (errorEl) {
          errorEl.textContent = '';
          errorEl.classList.remove('visible');
        }
      }

      function updateColorPreview(hex) {
        if (hexPattern.test(hex)) {
          colorPreview.style.backgroundColor = hex;
          colorPreview.classList.add('visible');
        } else {
          colorPreview.classList.remove('visible');
        }
      }

      function clearColor() {
        colorSwatches.forEach(s => s.classList.remove('selected'));
        customColorInput.value = '';
        colorPreview.classList.remove('visible');
        const errorEl = document.getElementById('color-error');
        if (errorEl) {
          errorEl.textContent = '';
          errorEl.classList.remove('visible');
        }
      }

      // Handle swatch clicks
      colorSwatches.forEach(swatch => {
        swatch.addEventListener('click', function() {
          selectSwatch(this.dataset.color);
        });
      });

      // Handle custom color input
      customColorInput.addEventListener('input', function() {
        const val = this.value.trim();
        const errorEl = document.getElementById('color-error');
        // Deselect all swatches
        colorSwatches.forEach(s => s.classList.remove('selected'));
        if (val.length === 0) {
          colorPreview.classList.remove('visible');
          if (errorEl) { errorEl.textContent = ''; errorEl.classList.remove('visible'); }
          return;
        }
        if (hexPattern.test(val)) {
          updateColorPreview(val);
          // Check if it matches a predefined swatch
          colorSwatches.forEach(s => {
            if (s.dataset.color.toUpperCase() === val.toUpperCase()) {
              s.classList.add('selected');
            }
          });
          if (errorEl) { errorEl.textContent = ''; errorEl.classList.remove('visible'); }
        } else {
          colorPreview.classList.remove('visible');
          if (errorEl && val.length > 0) {
            errorEl.textContent = 'Color must be a valid hex value in #RRGGBB format';
            errorEl.classList.add('visible');
          }
        }
      });

      // Clear color button
      clearColorBtn.addEventListener('click', clearColor);

      // Initialize color preview on load
      (function() {
        const initialColor = customColorInput.value.trim();
        if (initialColor && hexPattern.test(initialColor)) {
          updateColorPreview(initialColor);
        }
      })();

      // Collect form data
      function getFormData() {
        const authType = document.querySelector('input[name="authType"]:checked').value;
        return {
          connectionName: document.getElementById('connectionName').value.trim(),
          server: document.getElementById('server').value.trim(),
          port: parseInt(document.getElementById('port').value, 10) || 1433,
          database: document.getElementById('database').value.trim(),
          authType: authType,
          username: document.getElementById('username').value.trim(),
          password: document.getElementById('password').value,
          color: document.getElementById('customColor').value.trim(),
        };
      }

      // Clear all error messages
      function clearErrors() {
        document.querySelectorAll('.error-message').forEach(el => {
          el.textContent = '';
          el.classList.remove('visible');
        });
      }

      // Show an error for a specific field
      function showError(field, message) {
        const errorEl = document.getElementById(field + '-error');
        if (errorEl) {
          errorEl.textContent = message;
          errorEl.classList.add('visible');
        }
      }

      // Form submission
      form.addEventListener('submit', function(e) {
        e.preventDefault();
        clearErrors();
        const data = getFormData();
        vscode.postMessage({ type: 'submit', data: data });
      });

      // Test Connection button
      testConnectionBtn.addEventListener('click', function() {
        clearErrors();
        testResultDiv.className = 'test-result';
        testResultDiv.style.display = 'none';
        const data = getFormData();
        vscode.postMessage({ type: 'testConnection', data: data });
      });

      // Cancel button
      cancelBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'cancel' });
      });

      // Keyboard navigation: Escape to cancel
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          vscode.postMessage({ type: 'cancel' });
        }
        // Enter to submit (when not in a textarea or on a button)
        if (e.key === 'Enter' && e.target.tagName !== 'BUTTON' && e.target.type !== 'submit') {
          e.preventDefault();
          form.dispatchEvent(new Event('submit'));
        }
      });

      // Handle messages from the extension host
      window.addEventListener('message', function(event) {
        const msg = event.data;
        switch (msg.type) {
          case 'validationError':
            clearErrors();
            if (msg.errors) {
              for (const [field, message] of Object.entries(msg.errors)) {
                showError(field, message);
              }
            }
            break;
          case 'testResult':
            testResultDiv.textContent = msg.message;
            if (msg.success) {
              testResultDiv.className = 'test-result success';
            } else {
              testResultDiv.className = 'test-result failure';
            }
            testResultDiv.style.display = 'block';
            break;
        }
      });

      // Auto-focus the appropriate field
      const focusField = '${focusField}';
      if (focusField) {
        const el = document.getElementById(focusField);
        if (el) {
          el.focus();
          el.select();
        }
      }
    })();
  </script>
</body>
</html>`;
  }

  /**
   * Escapes HTML special characters to prevent XSS in webview content.
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
