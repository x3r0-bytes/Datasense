// Definition Command — Client-side handler for "Go to Definition" from Object Explorer.
// Opens stored procedure, view, or function source in a read-only virtual document.

import * as vscode from 'vscode';
import * as mssql from 'mssql';
import { TreeNode, ViewNode, FolderNode } from './objectExplorer/types';
import { ObjectExplorerConnectionManager } from './objectExplorer/objectExplorerConnectionManager';

// ============================================================================
// Virtual Document Content Provider
// ============================================================================

/**
 * URI scheme for T-SQL definition virtual documents.
 */
export const DEFINITION_SCHEME = 'tsql-definition';

/**
 * In-memory store for definition content, keyed by URI string.
 */
const definitionContentMap = new Map<string, string>();

/**
 * Stores definition content in the map so the DefinitionContentProvider can serve it.
 * Called by the client when receiving a `sqlServer/definitionContent` notification from the server.
 *
 * @param uri - The virtual document URI string
 * @param source - The T-SQL source text to store
 */
export function setDefinitionContent(uri: string, source: string): void {
  definitionContentMap.set(uri, source);
}

/**
 * TextDocumentContentProvider that serves T-SQL definition content
 * for virtual (read-only) documents.
 */
export class DefinitionContentProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return definitionContentMap.get(uri.toString()) || '';
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

// ============================================================================
// Object type mapping (mirrors server/src/definitionProvider.ts)
// ============================================================================

const TYPE_MAP: Record<string, 'procedure' | 'view' | 'function'> = {
  'P': 'procedure',
  'V': 'view',
  'FN': 'function',
  'IF': 'function',
  'TF': 'function',
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Opens the definition of a stored procedure, view, or function
 * from the Object Explorer context menu.
 *
 * Uses the Object Explorer's connection pool for the node's server.
 * Queries the database for the object's source text and opens it
 * in a read-only virtual document with T-SQL syntax highlighting.
 *
 * @param node - The tree node representing the object (view, or folder-based proc/function)
 * @param connectionManager - The Object Explorer connection manager for pool access
 */
export async function goToDefinitionFromExplorer(
  node: TreeNode,
  connectionManager: ObjectExplorerConnectionManager
): Promise<void> {
  // Extract schema, object name, database, and connection name from the node
  const objectInfo = extractObjectInfo(node);
  if (!objectInfo) {
    vscode.window.showInformationMessage('Go to Definition is not supported for this node type.');
    return;
  }

  const { schema, objectName, database, connectionName } = objectInfo;

  try {
    // Get the connection pool for the node's database
    const pool = await connectionManager.getPoolForDatabase(connectionName, database);

    // Query the database for the object definition (with 5s timeout)
    const result = await queryObjectDefinition(pool, schema, objectName);

    if (result.reason === 'not_found') {
      vscode.window.showInformationMessage(
        `${schema}.${objectName} was not found in the connected database.`
      );
      return;
    }

    if (result.reason === 'encrypted') {
      vscode.window.showInformationMessage(
        'Definition unavailable \u2014 object may be encrypted.'
      );
      return;
    }

    if (result.reason === 'unsupported_type') {
      vscode.window.showInformationMessage(
        'Go to Definition is not supported for this object type.'
      );
      return;
    }

    if (result.reason === 'timeout') {
      vscode.window.showErrorMessage('Go to Definition timed out.');
      return;
    }

    if (!result.source) {
      vscode.window.showInformationMessage(
        `${schema}.${objectName} was not found in the connected database.`
      );
      return;
    }

    // Open the definition in a read-only editor tab
    await openDefinitionEditor(result.qualifiedName, result.source);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Go to Definition failed: ${message}`);
  }
}

/**
 * Opens object source in a read-only editor tab using a virtual document.
 * Reuses existing tab if the same object is already open.
 * Title format: schema.objectName
 *
 * @param qualifiedName - The fully qualified object name (schema.objectName)
 * @param source - The T-SQL source text of the object
 */
export async function openDefinitionEditor(
  qualifiedName: string,
  source: string
): Promise<void> {
  // Build the virtual document URI
  const uri = vscode.Uri.parse(`${DEFINITION_SCHEME}:${qualifiedName}.sql`);

  // Check if a tab with this URI is already open — reuse it (Requirement 4.11)
  for (const tabGroup of vscode.window.tabGroups.all) {
    for (const tab of tabGroup.tabs) {
      if (tab.input instanceof vscode.TabInputText) {
        if (tab.input.uri.toString() === uri.toString()) {
          // Tab already open — activate it
          await vscode.window.showTextDocument(
            await vscode.workspace.openTextDocument(uri),
            { preview: false, preserveFocus: false }
          );
          return;
        }
      }
    }
  }

  // Store the content in our map so the content provider can serve it
  definitionContentMap.set(uri.toString(), source);

  // Open the virtual document
  const doc = await vscode.workspace.openTextDocument(uri);

  // Show the document in a non-preview tab with SQL language mode
  await vscode.window.showTextDocument(doc, { preview: false });

  // Set the language to SQL for syntax highlighting
  await vscode.languages.setTextDocumentLanguage(doc, 'sql');
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Result of querying the database for an object's definition.
 */
interface DefinitionQueryResult {
  source: string | null;
  qualifiedName: string;
  objectType: 'procedure' | 'view' | 'function' | null;
  reason?: 'not_found' | 'encrypted' | 'unsupported_type' | 'timeout';
}

/**
 * Extracts schema, object name, database, and connection name from a tree node.
 * Returns null if the node type doesn't support Go to Definition.
 */
function extractObjectInfo(node: TreeNode): {
  schema: string;
  objectName: string;
  database: string;
  connectionName: string;
} | null {
  switch (node.kind) {
    case 'view':
      return {
        schema: node.schema,
        objectName: node.viewName,
        database: node.database,
        connectionName: node.connectionName,
      };
    case 'folder':
      // Folder nodes with schema and objectName represent programmability objects
      if (node.schema && node.objectName && node.database) {
        return {
          schema: node.schema,
          objectName: node.objectName,
          database: node.database,
          connectionName: node.connectionName,
        };
      }
      return null;
    default:
      return null;
  }
}

/**
 * Queries the database for an object's definition using sys.objects and OBJECT_DEFINITION().
 * Includes a 5-second timeout.
 *
 * @param pool - The mssql connection pool
 * @param schema - The schema name
 * @param objectName - The object name
 */
async function queryObjectDefinition(
  pool: mssql.ConnectionPool,
  schema: string,
  objectName: string
): Promise<DefinitionQueryResult> {
  const qualifiedName = `${schema}.${objectName}`;
  const QUERY_TIMEOUT_MS = 5000;

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('TIMEOUT')), QUERY_TIMEOUT_MS);
  });

  try {
    const work = async (): Promise<DefinitionQueryResult> => {
      // Step 1: Query sys.objects to find the object and determine its type
      const typeRequest = pool.request();
      typeRequest.input('schema', mssql.NVarChar, schema);
      typeRequest.input('objectName', mssql.NVarChar, objectName);

      const typeResult = await typeRequest.query(`
        SELECT o.type
        FROM sys.objects o
        JOIN sys.schemas s ON o.schema_id = s.schema_id
        WHERE s.name = @schema AND o.name = @objectName
      `);

      // Step 2: Check if object was found
      if (typeResult.recordset.length === 0) {
        return {
          source: null,
          qualifiedName,
          objectType: null,
          reason: 'not_found',
        };
      }

      const typeCode = typeResult.recordset[0].type.trim();

      // Step 3: Map type code to our objectType
      const objectType = TYPE_MAP[typeCode] || null;

      if (objectType === null) {
        return {
          source: null,
          qualifiedName,
          objectType: null,
          reason: 'unsupported_type',
        };
      }

      // Step 4: Retrieve the object definition source text
      const defRequest = pool.request();
      defRequest.input('qualifiedName', mssql.NVarChar, `${schema}.${objectName}`);

      const defResult = await defRequest.query(`
        SELECT OBJECT_DEFINITION(OBJECT_ID(@qualifiedName)) AS [definition]
      `);

      const definition = defResult.recordset[0]?.definition;

      // Step 5: If definition is NULL, the object is encrypted
      if (definition === null || definition === undefined) {
        return {
          source: null,
          qualifiedName,
          objectType,
          reason: 'encrypted',
        };
      }

      // Success
      return {
        source: definition,
        qualifiedName,
        objectType,
      };
    };

    return await Promise.race([work(), timeoutPromise]);
  } catch (error: any) {
    if (error?.message === 'TIMEOUT') {
      return {
        source: null,
        qualifiedName,
        objectType: null,
        reason: 'timeout',
      };
    }
    // Re-throw other errors to be caught by the caller
    throw error;
  }
}
