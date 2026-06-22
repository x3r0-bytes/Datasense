// src/sqlSearchProtocol.ts
// Message type definitions for communication between
// the SQL Search webview and the extension host.

// ─── Webview → Extension Host ───────────────────────────────────────────────

export interface SearchExecuteMessage {
  type: 'search';
  searchTerm: string;
  objectTypes: {
    procedures: boolean;
    views: boolean;
    functions: boolean;
    tables: boolean;
    triggers: boolean;
  };
  scope: {
    type: 'all' | 'server' | 'database' | 'schema';
    connectionName?: string;
    database?: string;
    schema?: string;
  };
  includeSystemDatabases: boolean;
}

export interface SearchCancelMessage {
  type: 'cancel';
}

export interface OpenDefinitionMessage {
  type: 'openDefinition';
  connectionName: string;
  database: string;
  schema: string;
  objectName: string;
  objectType: 'procedure' | 'view' | 'function' | 'table' | 'trigger';
}

export interface GetConnectionsMessage {
  type: 'getConnections';
}

export interface GetDatabasesMessage {
  type: 'getDatabases';
  connectionName: string;
}

export interface GetSchemasMessage {
  type: 'getSchemas';
  connectionName: string;
  database: string;
}

export interface FilterChangedMessage {
  type: 'filterChanged';
  objectTypes: {
    procedures: boolean;
    views: boolean;
    functions: boolean;
    tables: boolean;
    triggers: boolean;
  };
}

export interface ScopeChangedMessage {
  type: 'scopeChanged';
  scope: {
    type: 'all' | 'server' | 'database' | 'schema';
    connectionName?: string;
    database?: string;
    schema?: string;
  };
}

export interface SystemDbChangedMessage {
  type: 'systemDbChanged';
  includeSystemDatabases: boolean;
}

export type SearchWebviewToExtensionMessage =
  | SearchExecuteMessage
  | SearchCancelMessage
  | OpenDefinitionMessage
  | GetConnectionsMessage
  | GetDatabasesMessage
  | GetSchemasMessage
  | FilterChangedMessage
  | ScopeChangedMessage
  | SystemDbChangedMessage;

// ─── Extension Host → Webview ───────────────────────────────────────────────

export interface SearchResultsMessage {
  type: 'results';
  result: import('./sqlSearchService').SearchResult;
  searchTerm: string;
}

export interface SearchProgressMessage {
  type: 'progress';
  databasesCompleted: number;
  databasesTotal: number;
  currentDatabase: string;
}

export interface SearchErrorMessage {
  type: 'error';
  message: string;
}

export interface ConnectionsListMessage {
  type: 'connectionsList';
  connections: Array<{ name: string; host: string }>;
}

export interface DatabasesListMessage {
  type: 'databasesList';
  databases: string[];
}

export interface SchemasListMessage {
  type: 'schemasList';
  schemas: string[];
}

export interface ValidationErrorMessage {
  type: 'validationError';
  message: string;
}

export interface RestoreStateMessage {
  type: 'restoreState';
  objectTypes: {
    procedures: boolean;
    views: boolean;
    functions: boolean;
    tables: boolean;
    triggers: boolean;
  };
  scope: {
    type: 'all' | 'server' | 'database' | 'schema';
    connectionName?: string;
    database?: string;
    schema?: string;
  };
  includeSystemDatabases: boolean;
}

export type SearchExtensionToWebviewMessage =
  | SearchResultsMessage
  | SearchProgressMessage
  | SearchErrorMessage
  | ConnectionsListMessage
  | DatabasesListMessage
  | SchemasListMessage
  | ValidationErrorMessage
  | RestoreStateMessage;
