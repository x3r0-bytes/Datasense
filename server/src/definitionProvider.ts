import { TextDocument } from 'vscode-languageserver-textdocument';
import * as mssql from 'mssql';

// --- Interfaces ---

export interface ObjectDefinitionResult {
  /** The object's source text, or null if not found/encrypted */
  source: string | null;
  /** The fully qualified name (schema.objectName) */
  qualifiedName: string;
  /** The object type (procedure, view, function) */
  objectType: 'procedure' | 'view' | 'function' | null;
  /** Error reason if source is null */
  reason?: 'not_found' | 'encrypted' | 'not_connected' | 'unsupported_type';
}

// --- Object type mapping ---

/** Maps sys.objects type codes to our ObjectDefinitionResult objectType values */
const TYPE_MAP: Record<string, 'procedure' | 'view' | 'function'> = {
  'P': 'procedure',   // SQL Stored Procedure
  'V': 'view',        // View
  'FN': 'function',   // SQL Scalar Function
  'IF': 'function',   // SQL Inline Table-Valued Function
  'TF': 'function',   // SQL Table-Valued Function
};

// --- T-SQL built-in type and keyword exclusion set ---

/**
 * Set of T-SQL data types, keywords, and built-in names that should NOT
 * trigger a Go to Definition lookup. These are never user-defined objects
 * in sys.objects, so querying for them just produces a confusing
 * "could not be located" message.
 */
const DEFINITION_EXCLUDED_NAMES: Set<string> = new Set([
  // Data types
  'bigint', 'int', 'smallint', 'tinyint', 'bit',
  'decimal', 'numeric', 'money', 'smallmoney',
  'float', 'real',
  'date', 'time', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset',
  'char', 'varchar', 'text', 'nchar', 'nvarchar', 'ntext',
  'binary', 'varbinary', 'image',
  'uniqueidentifier', 'xml', 'sql_variant', 'hierarchyid', 'geometry', 'geography',
  'timestamp', 'rowversion', 'cursor', 'table',
  // Common keywords that resolve as identifiers
  'declare', 'set', 'select', 'from', 'where', 'insert', 'update', 'delete',
  'create', 'alter', 'drop', 'exec', 'execute', 'begin', 'end', 'if', 'else',
  'while', 'return', 'print', 'go', 'use', 'grant', 'revoke', 'deny',
  'join', 'inner', 'left', 'right', 'outer', 'cross', 'on', 'and', 'or', 'not',
  'in', 'exists', 'between', 'like', 'is', 'null', 'as', 'with', 'into',
  'values', 'having', 'group', 'by', 'order', 'asc', 'desc', 'top', 'distinct',
  'union', 'all', 'case', 'when', 'then', 'cast', 'convert', 'coalesce', 'isnull',
  'try', 'catch', 'throw', 'raiserror', 'transaction', 'commit', 'rollback',
  'trigger', 'procedure', 'function', 'view', 'index', 'constraint', 'primary',
  'key', 'foreign', 'references', 'default', 'check', 'unique', 'clustered',
  'nonclustered', 'identity', 'output', 'over', 'partition', 'row_number',
  'rank', 'dense_rank', 'ntile', 'lag', 'lead',
  // Built-in functions that aren't in sys.objects
  'getdate', 'sysdatetime', 'newid', 'scope_identity', 'object_id',
  'len', 'ltrim', 'rtrim', 'trim', 'upper', 'lower', 'replace', 'stuff',
  'substring', 'charindex', 'patindex', 'left', 'right', 'concat',
  'count', 'sum', 'avg', 'min', 'max', 'abs', 'ceiling', 'floor', 'round',
  'year', 'month', 'day', 'dateadd', 'datediff', 'datename', 'datepart',
  'string_agg', 'json_value', 'json_query', 'openjson', 'iif', 'choose',
]);

// --- Helper: word character detection ---

/**
 * Returns true if the character is a valid T-SQL identifier character
 * (letters, digits, underscore, #, @).
 */
function isIdentifierChar(ch: string): boolean {
  return /[a-zA-Z0-9_#@]/.test(ch);
}

/**
 * Returns true if the given name should be excluded from Go to Definition lookups.
 * This includes T-SQL data types, keywords, variables (@name), and temp tables (#name).
 */
export function isExcludedFromDefinition(name: string): boolean {
  // Variables (@var) are local — not database objects
  if (name.startsWith('@')) {
    return true;
  }
  // Check against the exclusion set (case-insensitive)
  return DEFINITION_EXCLUDED_NAMES.has(name.toLowerCase());
}

// --- Public API ---

/**
 * Pure function: resolves an identifier string into schema and name.
 * 
 * - For schema-qualified names (exactly one dot): splits into {schema, name}
 * - For unqualified names (no dot): defaults to {schema: 'dbo', name: identifier}
 * - Handles special characters: # (temp tables), @ (variables)
 * 
 * Returns null if the identifier is not a valid T-SQL identifier.
 */
export function resolveObjectNameFromString(
  identifier: string
): { schema: string; name: string } | null {
  if (!identifier || identifier.trim().length === 0) {
    return null;
  }

  const trimmed = identifier.trim();

  // Check if it contains exactly one dot (schema-qualified)
  const dotIndex = trimmed.indexOf('.');
  if (dotIndex > 0 && dotIndex < trimmed.length - 1) {
    // Ensure there's no second dot (we only handle schema.name, not db.schema.name)
    const secondDotIndex = trimmed.indexOf('.', dotIndex + 1);
    if (secondDotIndex === -1) {
      const schema = trimmed.substring(0, dotIndex);
      const name = trimmed.substring(dotIndex + 1);

      // Validate both parts are valid T-SQL identifiers
      const identifierPattern = /^[a-zA-Z_#@][a-zA-Z0-9_#@]*$/;
      if (identifierPattern.test(schema) && identifierPattern.test(name)) {
        return { schema, name };
      }
    }
  }

  // Unqualified name — default to dbo schema
  if (/^[a-zA-Z_#@][a-zA-Z0-9_#@]*$/.test(trimmed)) {
    return { schema: 'dbo', name: trimmed };
  }

  return null;
}

/**
 * Resolve the object name at the cursor position in a document.
 * Handles schema-qualified (dbo.MyProc) and unqualified (MyProc) names.
 * Defaults unqualified names to dbo schema.
 *
 * Returns null if the cursor is not on a valid identifier.
 */
export function resolveObjectName(
  document: TextDocument,
  offset: number
): { schema: string; name: string } | null {
  const text = document.getText();

  // If offset is out of bounds or not on an identifier character, return null
  if (offset < 0 || offset >= text.length) {
    return null;
  }

  // Check if cursor is on an identifier char or a dot (for schema.name)
  if (!isIdentifierChar(text[offset]) && text[offset] !== '.') {
    return null;
  }

  // Expand left from offset to find the start of the word (including dot for schema qualification)
  let start = offset;
  while (start > 0 && (isIdentifierChar(text[start - 1]) || text[start - 1] === '.')) {
    start--;
  }

  // Expand right from offset to find the end of the word
  let end = offset;
  while (end < text.length && isIdentifierChar(text[end])) {
    end++;
  }

  // If we stopped on a dot going right, also include the part after the dot
  if (end < text.length && text[end] === '.') {
    end++; // skip the dot
    while (end < text.length && isIdentifierChar(text[end])) {
      end++;
    }
  }

  const fullWord = text.substring(start, end).trim();

  if (fullWord.length === 0) {
    return null;
  }

  // Delegate to the pure string-based resolution
  return resolveObjectNameFromString(fullWord);
}

/** Object types that support the three-part name retry strategy */
const RETRYABLE_TYPES = new Set(['P', 'V', 'FN', 'IF', 'TF']);

/**
 * Query the database for an object's definition.
 * Uses sys.objects to determine type, then OBJECT_DEFINITION() for source.
 *
 * Steps:
 * 1. Query sys.objects JOIN sys.schemas to find the object and its type
 * 2. Map the type code (P, V, FN, IF, TF) to our objectType enum
 * 3. If supported type, retrieve source via OBJECT_DEFINITION(OBJECT_ID('schema.objectName'))
 * 4. If NULL returned and type is retryable, retry with three-part name: OBJECT_DEFINITION(OBJECT_ID('database.schema.objectName'))
 * 5. If still NULL after retry, return reason: 'encrypted'
 * 6. If object not found, return not_found reason
 *
 * A 5-second timeout via Promise.race guards the entire operation.
 *
 * @param pool - The active connection pool
 * @param schema - The resolved schema name
 * @param objectName - The object name
 * @param databaseName - The connected database name (for three-part retry)
 */
export async function getObjectDefinition(
  pool: mssql.ConnectionPool,
  schema: string,
  objectName: string,
  databaseName?: string
): Promise<ObjectDefinitionResult> {
  const qualifiedName = `${schema}.${objectName}`;

  // 5-second timeout for definition queries
  const QUERY_TIMEOUT_MS = 5000;

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Go to Definition timed out')), QUERY_TIMEOUT_MS);
  });

  try {
    const work = async (): Promise<ObjectDefinitionResult> => {
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

      // Step 4: First attempt — retrieve definition with two-part name (schema.objectName)
      const defRequest = pool.request();
      defRequest.input('qualifiedName', mssql.NVarChar, `${schema}.${objectName}`);

      const defResult = await defRequest.query(`
        SELECT OBJECT_DEFINITION(OBJECT_ID(@qualifiedName)) AS [definition]
      `);

      const definition = defResult.recordset[0]?.definition;

      if (definition !== null && definition !== undefined) {
        // Success on first attempt
        return {
          source: definition,
          qualifiedName,
          objectType,
        };
      }

      // Step 5: If NULL and type is retryable, retry with three-part name (database.schema.objectName)
      if (RETRYABLE_TYPES.has(typeCode) && databaseName) {
        const retryRequest = pool.request();
        const threePartName = `${databaseName}.${schema}.${objectName}`;
        retryRequest.input('threePartName', mssql.NVarChar, threePartName);

        const retryResult = await retryRequest.query(`
          SELECT OBJECT_DEFINITION(OBJECT_ID(@threePartName)) AS [definition]
        `);

        const retryDefinition = retryResult.recordset[0]?.definition;

        if (retryDefinition !== null && retryDefinition !== undefined) {
          // Success on retry with three-part name
          return {
            source: retryDefinition,
            qualifiedName,
            objectType,
          };
        }
      }

      // Step 6: If still NULL after retry (or no retry possible), object is encrypted
      return {
        source: null,
        qualifiedName,
        objectType,
        reason: 'encrypted',
      };
    };

    return await Promise.race([work(), timeoutPromise]);
  } catch (error: any) {
    // On query failure or timeout, treat as not found
    return {
      source: null,
      qualifiedName,
      objectType: null,
      reason: 'not_found',
    };
  }
}
