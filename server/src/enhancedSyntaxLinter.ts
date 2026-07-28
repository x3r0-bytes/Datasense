/**
 * Enhanced Syntax Linter — Detects advanced T-SQL syntax errors and schema-dependent issues.
 *
 * This module implements Phase 4 of the T-SQL linting pipeline, checking:
 * - Invalid keyword sequences (e.g., SELECT immediately followed by FROM) → Error
 * - Invalid data types in CAST/CONVERT expressions → Error
 * - Unrecognized function names (schema-dependent) → Warning
 * - Invalid INSERT column names (schema-dependent) → Warning
 *
 * Syntax-only rules (keyword sequences, data types) always run regardless of connection state.
 * Schema-dependent rules only run when connected and a schema cache is available.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { ISchemaCache } from './schemaCache';

// ─── Public Interfaces ─────────────────────────────────────────────────────────

/**
 * Context passed to the enhanced syntax linter.
 * schemaCache may be null when disconnected; syntax-only rules still run.
 */
export interface EnhancedSyntaxLinterContext {
  schemaCache: ISchemaCache | null;
  isConnected: boolean;
}

// ─── Module-Level Constants ────────────────────────────────────────────────────

/**
 * All 33 recognized T-SQL data types (stored in uppercase for case-insensitive comparison).
 * Used to validate type names in CAST/CONVERT expressions.
 *
 * Exported so property tests can import directly.
 */
export const VALID_DATA_TYPES: Set<string> = new Set<string>([
  'INT',
  'VARCHAR',
  'NVARCHAR',
  'CHAR',
  'NCHAR',
  'DATETIME',
  'DATE',
  'TIME',
  'FLOAT',
  'DECIMAL',
  'NUMERIC',
  'BIT',
  'BIGINT',
  'SMALLINT',
  'TINYINT',
  'MONEY',
  'SMALLMONEY',
  'REAL',
  'TEXT',
  'NTEXT',
  'IMAGE',
  'UNIQUEIDENTIFIER',
  'XML',
  'VARBINARY',
  'BINARY',
  'SQL_VARIANT',
  'DATETIMEOFFSET',
  'DATETIME2',
  'SMALLDATETIME',
  'HIERARCHYID',
  'GEOMETRY',
  'GEOGRAPHY',
]);

/**
 * Comprehensive list of T-SQL built-in functions (~200 aggregate, scalar, ranking, and system functions).
 * Stored in uppercase for case-insensitive comparison.
 *
 * Exported so property tests can import directly.
 */
export const BUILTIN_FUNCTIONS: Set<string> = new Set<string>([
  // ── Aggregate Functions ──────────────────────────────────────────────────────
  'AVG',
  'CHECKSUM_AGG',
  'COUNT',
  'COUNT_BIG',
  'GROUPING',
  'GROUPING_ID',
  'MAX',
  'MIN',
  'STDEV',
  'STDEVP',
  'SUM',
  'VAR',
  'VARP',
  'STRING_AGG',

  // ── Analytic / Window Functions ──────────────────────────────────────────────
  'CUME_DIST',
  'FIRST_VALUE',
  'LAG',
  'LAST_VALUE',
  'LEAD',
  'PERCENTILE_CONT',
  'PERCENTILE_DISC',
  'PERCENT_RANK',

  // ── Ranking Functions ────────────────────────────────────────────────────────
  'DENSE_RANK',
  'NTILE',
  'RANK',
  'ROW_NUMBER',

  // ── String Functions ─────────────────────────────────────────────────────────
  'ASCII',
  'CHAR',
  'CHARINDEX',
  'CONCAT',
  'CONCAT_WS',
  'DIFFERENCE',
  'FORMAT',
  'LEFT',
  'LEN',
  'LOWER',
  'LTRIM',
  'NCHAR',
  'PATINDEX',
  'QUOTENAME',
  'REPLACE',
  'REPLICATE',
  'REVERSE',
  'RIGHT',
  'RTRIM',
  'SOUNDEX',
  'SPACE',
  'STR',
  'STRING_ESCAPE',
  'STRING_SPLIT',
  'STUFF',
  'SUBSTRING',
  'TRANSLATE',
  'TRIM',
  'UNICODE',
  'UPPER',

  // ── Date and Time Functions ──────────────────────────────────────────────────
  'CURRENT_TIMESTAMP',
  'DATEADD',
  'DATEDIFF',
  'DATEDIFF_BIG',
  'DATEFROMPARTS',
  'DATENAME',
  'DATEPART',
  'DATETIME2FROMPARTS',
  'DATETIMEFROMPARTS',
  'DATETIMEOFFSETFROMPARTS',
  'DAY',
  'EOMONTH',
  'GETDATE',
  'GETUTCDATE',
  'ISDATE',
  'MONTH',
  'SMALLDATETIMEFROMPARTS',
  'SWITCHOFFSET',
  'SYSDATETIME',
  'SYSDATETIMEOFFSET',
  'SYSUTCDATETIME',
  'TIMEFROMPARTS',
  'TODATETIMEOFFSET',
  'YEAR',

  // ── Mathematical Functions ───────────────────────────────────────────────────
  'ABS',
  'ACOS',
  'ASIN',
  'ATAN',
  'ATN2',
  'CEILING',
  'COS',
  'COT',
  'DEGREES',
  'EXP',
  'FLOOR',
  'LOG',
  'LOG10',
  'PI',
  'POWER',
  'RADIANS',
  'RAND',
  'ROUND',
  'SIGN',
  'SIN',
  'SQRT',
  'SQUARE',
  'TAN',

  // ── Conversion / Cast Functions ──────────────────────────────────────────────
  'CAST',
  'CONVERT',
  'PARSE',
  'TRY_CAST',
  'TRY_CONVERT',
  'TRY_PARSE',

  // ── Logical / Conditional Functions ─────────────────────────────────────────
  'CHOOSE',
  'COALESCE',
  'IIF',
  'ISNULL',
  'NULLIF',

  // ── Metadata / System Functions ──────────────────────────────────────────────
  'APP_NAME',
  'APPLOCK_MODE',
  'APPLOCK_TEST',
  'ASSEMBLYPROPERTY',
  'COL_LENGTH',
  'COL_NAME',
  'COLUMNPROPERTY',
  'CURRENT_USER',
  'DATABASE_PRINCIPAL_ID',
  'DATABASEPROPERTYEX',
  'DB_ID',
  'DB_NAME',
  'FILE_ID',
  'FILE_IDEX',
  'FILE_NAME',
  'FILEGROUP_ID',
  'FILEGROUP_NAME',
  'FILEGROUPPROPERTY',
  'FILEPROPERTY',
  'FULLTEXTCATALOGPROPERTY',
  'FULLTEXTSERVICEPROPERTY',
  'HOST_ID',
  'HOST_NAME',
  'IDENT_CURRENT',
  'IDENT_INCR',
  'IDENT_SEED',
  'INDEX_COL',
  'INDEXKEY_PROPERTY',
  'INDEXPROPERTY',
  'IS_MEMBER',
  'IS_ROLEMEMBER',
  'IS_SRVROLEMEMBER',
  'ISDATE',
  'ISNUMERIC',
  'LOGINPROPERTY',
  'NEWID',
  'NEWSEQUENTIALID',
  'OBJECT_DEFINITION',
  'OBJECT_ID',
  'OBJECT_NAME',
  'OBJECT_SCHEMA_NAME',
  'OBJECTPROPERTY',
  'OBJECTPROPERTYEX',
  'ORIGINAL_LOGIN',
  'PERMISSIONS',
  'SCHEMA_ID',
  'SCHEMA_NAME',
  'SCOPE_IDENTITY',
  'SERVERPROPERTY',
  'SESSION_USER',
  'STATS_DATE',
  'SUSER_ID',
  'SUSER_NAME',
  'SUSER_SID',
  'SUSER_SNAME',
  'SYSTEM_USER',
  'TYPE_ID',
  'TYPE_NAME',
  'TYPEPROPERTY',
  'USER_ID',
  'USER_NAME',
  'XACT_STATE',

  // ── Cryptographic Functions ──────────────────────────────────────────────────
  'CERTENCODED',
  'CERTPRIVATEKEY',
  'COMPRESS',
  'DECOMPRESS',
  'DECRYPTBYASYMKEY',
  'DECRYPTBYCERT',
  'DECRYPTBYKEY',
  'DECRYPTBYKEYAUTOASYMKEY',
  'DECRYPTBYKEYAUTOCERT',
  'DECRYPTBYPASSPHRASE',
  'ENCRYPTBYASYMKEY',
  'ENCRYPTBYCERT',
  'ENCRYPTBYKEY',
  'ENCRYPTBYPASSPHRASE',
  'HASHBYTES',
  'IS_OBJECTSIGNED',
  'PWDCOMPARE',
  'PWDENCRYPT',
  'SIGNBYASYMKEY',
  'SIGNBYCERT',
  'SYMKEYPROPERTY',
  'VERIFYSIGNEDBYCERT',
  'VERIFYSIGNEDBYASYMKEY',

  // ── JSON Functions ───────────────────────────────────────────────────────────
  'ISJSON',
  'JSON_MODIFY',
  'JSON_QUERY',
  'JSON_VALUE',
  'OPENJSON',

  // ── Full-Text Search Functions ───────────────────────────────────────────────
  'CONTAINSTABLE',
  'FREETEXTTABLE',

  // ── Rowset Functions ─────────────────────────────────────────────────────────
  'OPENDATASOURCE',
  'OPENQUERY',
  'OPENROWSET',
  'OPENXML',

  // ── Cursor Functions ─────────────────────────────────────────────────────────
  'CURSOR_STATUS',

  // ── Error Handling Functions ─────────────────────────────────────────────────
  'ERROR_LINE',
  'ERROR_MESSAGE',
  'ERROR_NUMBER',
  'ERROR_PROCEDURE',
  'ERROR_SEVERITY',
  'ERROR_STATE',
  'FORMATMESSAGE',

  // ── Spatial Functions (representative set) ───────────────────────────────────
  'STR',
  'STGeomFromText',
  'STGeomFromWKB',
  'STPointFromText',

  // ── Miscellaneous ────────────────────────────────────────────────────────────
  'BINARY_CHECKSUM',
  'CHECKSUM',
  'CONNECTIONPROPERTY',
  'CONTEXT_INFO',
  'CURRENT_REQUEST_ID',
  'CURRENT_TRANSACTION_ID',
  'DECOMPRESS',
  'GETANSINULL',
  'MIN_ACTIVE_ROWVERSION',
  'ORIGINAL_DB_NAME',
  'ROWCOUNT_BIG',
  'SESSION_CONTEXT',
  'TRIGGER_NESTLEVEL',
  'VERSION',
]);

/**
 * Known invalid T-SQL keyword sequences.
 * Each entry has a regex pattern (case-insensitive) and an error message.
 *
 * The pattern uses a named capture group `ident` to mark the position of the
 * unexpected token, so diagnostics can pinpoint the right location.
 */
export const INVALID_KEYWORD_SEQUENCES: Array<{ pattern: RegExp; message: string }> = [
  {
    // SELECT immediately followed by FROM — missing column list
    pattern: /\bSELECT\s+(FROM)\b/i,
    message: "Unexpected 'FROM': expected a column list after SELECT.",
  },
  {
    // WHERE immediately followed by ORDER BY — missing condition
    pattern: /\bWHERE\s+(ORDER\s+BY)\b/i,
    message: "Unexpected 'ORDER BY': expected a condition after WHERE.",
  },
  {
    // WHERE immediately followed by GROUP BY — missing condition
    pattern: /\bWHERE\s+(GROUP\s+BY)\b/i,
    message: "Unexpected 'GROUP BY': expected a condition after WHERE.",
  },
  {
    // WHERE immediately followed by HAVING — missing condition
    pattern: /\bWHERE\s+(HAVING)\b/i,
    message: "Unexpected 'HAVING': expected a condition after WHERE.",
  },
  {
    // SELECT immediately followed by WHERE — missing column list
    pattern: /\bSELECT\s+(WHERE)\b/i,
    message: "Unexpected 'WHERE': expected a column list after SELECT.",
  },
  {
    // JOIN without ON or USING — dangling JOIN
    pattern: /\b(?:INNER|LEFT(?:\s+OUTER)?|RIGHT(?:\s+OUTER)?|FULL(?:\s+OUTER)?)\s+JOIN\s+[\w\[\]"]+\s+((?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|;))\b/i,
    message: "Missing ON clause after JOIN.",
  },
  {
    // HAVING without GROUP BY context — stand-alone HAVING
    pattern: /\bHAVING\s+(ORDER\s+BY)\b/i,
    message: "Unexpected 'ORDER BY': expected a condition after HAVING.",
  },
  {
    // GROUP BY immediately followed by ORDER BY with no expressions
    pattern: /\bGROUP\s+BY\s+(ORDER\s+BY)\b/i,
    message: "Unexpected 'ORDER BY': expected column expressions after GROUP BY.",
  },
  {
    // INSERT INTO without column list or VALUES/SELECT
    pattern: /\bINSERT\s+INTO\s+[\w\[\]".]+\s+((?:WHERE|ORDER\s+BY|GROUP\s+BY))\b/i,
    message: "Unexpected keyword after INSERT INTO target: expected a column list, VALUES, or SELECT.",
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strip SQL string literals and single-line/block comments from text,
 * preserving character positions (replaced with spaces so offsets remain valid).
 */
function stripStringsAndComments(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    // Single-line comment
    if (text[i] === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') {
        result += ' ';
        i++;
      }
      continue;
    }
    // Block comment
    if (text[i] === '/' && text[i + 1] === '*') {
      result += ' ';
      i++;
      result += ' ';
      i++;
      while (i < text.length) {
        if (text[i] === '*' && text[i + 1] === '/') {
          result += ' ';
          i++;
          result += ' ';
          i++;
          break;
        }
        result += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }
    // N-prefixed string literal
    if ((text[i] === 'N' || text[i] === 'n') && text[i + 1] === "'") {
      result += ' ';
      i++;
      result += ' ';
      i++;
      while (i < text.length) {
        if (text[i] === "'") {
          result += ' ';
          i++;
          if (i < text.length && text[i] === "'") {
            result += ' ';
            i++;
          } else {
            break;
          }
        } else {
          result += text[i] === '\n' ? '\n' : ' ';
          i++;
        }
      }
      continue;
    }
    // Single-quoted string literal
    if (text[i] === "'") {
      result += ' ';
      i++;
      while (i < text.length) {
        if (text[i] === "'") {
          result += ' ';
          i++;
          if (i < text.length && text[i] === "'") {
            result += ' ';
            i++;
          } else {
            break;
          }
        } else {
          result += text[i] === '\n' ? '\n' : ' ';
          i++;
        }
      }
      continue;
    }
    result += text[i];
    i++;
  }
  return result;
}

/**
 * Get 0-based line and character position from a character offset in text.
 */
function getPosition(text: string, offset: number): { line: number; col: number } {
  let line = 0;
  let col = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      col = 0;
    } else {
      col++;
    }
  }
  return { line, col };
}

/**
 * Strip bracket or double-quote delimiters from an identifier.
 * e.g. [MyTable] → MyTable, "dbo" → dbo
 */
function stripDelimiters(id: string): string {
  if ((id.startsWith('[') && id.endsWith(']')) ||
      (id.startsWith('"') && id.endsWith('"'))) {
    return id.slice(1, -1);
  }
  return id;
}

/**
 * Normalize an identifier: strip delimiters and uppercase (for set lookup).
 */
function normalizeId(id: string): string {
  return stripDelimiters(id).toUpperCase();
}

// ─── Linting Sub-Functions ────────────────────────────────────────────────────

/**
 * Get parenthesis nesting depth at a given offset in text.
 */
function getParenDepthAt(text: string, offset: number): number {
  let depth = 0;
  for (let i = 0; i < offset; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')') depth--;
  }
  return Math.max(0, depth);
}

/**
 * Check for invalid keyword sequences (always runs, Error severity).
 * Only flags matches at top-level (paren depth 0) to avoid false positives
 * inside subqueries and OVER() clauses.
 * Requirement 6.1
 */
function lintKeywordSequences(
  stripped: string,
  batchStartLine: number,
  originalText: string,
  diagnostics: Diagnostic[]
): void {
  for (const rule of INVALID_KEYWORD_SEQUENCES) {
    // Reset lastIndex for global patterns
    rule.pattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    const re = new RegExp(rule.pattern.source, 'gi');
    while ((match = re.exec(stripped)) !== null) {
      // Skip matches inside parentheses (subqueries, OVER clauses, etc.)
      if (getParenDepthAt(stripped, match.index) !== 0) continue;

      // The diagnostic range points at the unexpected token (capture group 1)
      // If capture group 1 exists, use its offset; otherwise use full match
      let tokenOffset = match.index;
      let tokenLen = match[0].length;

      if (match[1]) {
        // Find the offset of the captured unexpected token within the match
        const capturedToken = match[1];
        const capturedOffset = match[0].indexOf(capturedToken);
        if (capturedOffset >= 0) {
          tokenOffset = match.index + capturedOffset;
          tokenLen = capturedToken.length;
        }
      }

      const pos = getPosition(originalText, tokenOffset);
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: {
          start: { line: pos.line + batchStartLine, character: pos.col },
          end: { line: pos.line + batchStartLine, character: pos.col + tokenLen },
        },
        message: rule.message,
        source: 'tsql-lint',
        code: 'ESL001',
      });
    }
  }
}

/**
 * Check for invalid data type names in CAST/CONVERT expressions (always runs, Error severity).
 * Handles: CAST(expr AS typename) and CONVERT(typename, expr) / CONVERT(typename(len), expr)
 * Requirement 6.3
 */
function lintCastConvertDataTypes(
  stripped: string,
  batchStartLine: number,
  originalText: string,
  diagnostics: Diagnostic[]
): void {
  // CAST(... AS typename) — capture the type name after AS
  const castPattern = /\bCAST\s*\([^)]*\bAS\s+([\w]+)(?:\s*\([^)]*\))?\s*\)/gi;
  let match: RegExpExecArray | null;

  while ((match = castPattern.exec(stripped)) !== null) {
    const typeName = match[1];
    const typeUpper = typeName.toUpperCase();

    if (!VALID_DATA_TYPES.has(typeUpper)) {
      // Find the position of the type name token within the match
      const typeOffset = match.index + match[0].lastIndexOf(match[1]);
      // More precise: find the start of match[1] after AS
      const asIdx = match[0].search(/\bAS\s+/i);
      let typeStart = match.index;
      if (asIdx >= 0) {
        const asMatch = /\bAS\s+/i.exec(match[0].substring(asIdx));
        if (asMatch) {
          typeStart = match.index + asIdx + asMatch[0].length;
        }
      }
      const pos = getPosition(originalText, typeStart);
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: {
          start: { line: pos.line + batchStartLine, character: pos.col },
          end: { line: pos.line + batchStartLine, character: pos.col + typeName.length },
        },
        message: `'${typeName}' is not a recognized T-SQL data type. Valid types include INT, VARCHAR, NVARCHAR, DATETIME, etc.`,
        source: 'tsql-lint',
        code: 'ESL002',
      });
    }
  }

  // CONVERT(typename, ...) / CONVERT(typename(len), ...) — capture type as first argument
  const convertPattern = /\bCONVERT\s*\(\s*([\w]+)(?:\s*\([^)]*\))?\s*,/gi;

  while ((match = convertPattern.exec(stripped)) !== null) {
    const typeName = match[1];
    const typeUpper = typeName.toUpperCase();

    if (!VALID_DATA_TYPES.has(typeUpper)) {
      // Find position of the type name: it's the first identifier after the opening paren
      const openParenIdx = match[0].indexOf('(');
      const afterParen = match[0].substring(openParenIdx + 1).trimStart();
      const typeStart = match.index + openParenIdx + 1 + (match[0].substring(openParenIdx + 1).length - afterParen.length);
      const pos = getPosition(originalText, typeStart);
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: {
          start: { line: pos.line + batchStartLine, character: pos.col },
          end: { line: pos.line + batchStartLine, character: pos.col + typeName.length },
        },
        message: `'${typeName}' is not a recognized T-SQL data type. Valid types include INT, VARCHAR, NVARCHAR, DATETIME, etc.`,
        source: 'tsql-lint',
        code: 'ESL002',
      });
    }
  }
}

/**
 * Check for unrecognized function names (schema-dependent, Warning severity).
 * Requirement 6.2
 */
function lintUnrecognizedFunctions(
  stripped: string,
  batchStartLine: number,
  originalText: string,
  schemaCache: ISchemaCache,
  diagnostics: Diagnostic[]
): void {
  // Match identifier immediately followed by '(' — function call syntax
  // Exclude: system functions (@@name), built-in functions, and cache-known procedures/functions
  const funcCallPattern = /\b([\w]+)\s*\(/g;
  let match: RegExpExecArray | null;

  // Build a set of known user-defined functions/procedures from the schema cache
  const cachedFunctionNames = new Set<string>();
  for (const proc of schemaCache.procedures) {
    cachedFunctionNames.add(proc.name.toUpperCase());
  }

  while ((match = funcCallPattern.exec(stripped)) !== null) {
    const funcName = match[1];
    const funcUpper = funcName.toUpperCase();

    // Skip T-SQL keywords that appear before '(' (CAST, CONVERT, IIF, etc. are in BUILTIN_FUNCTIONS)
    if (T_SQL_KEYWORDS_BEFORE_PAREN.has(funcUpper)) continue;

    // Skip system variable-style identifiers
    if (funcName.startsWith('@@')) continue;
    if (funcName.startsWith('@')) continue;

    // Skip numeric literals (shouldn't happen, but be safe)
    if (/^\d/.test(funcName)) continue;

    // Skip if it's a known built-in function
    if (BUILTIN_FUNCTIONS.has(funcUpper)) continue;

    // Skip if it's a known cached function/procedure
    if (cachedFunctionNames.has(funcUpper)) continue;

    // Skip if it's a T-SQL control flow keyword used with parens
    if (T_SQL_CONTROL_FLOW.has(funcUpper)) continue;

    // Skip if it's a valid T-SQL data type (used in DECLARE @var VARCHAR(50), variable assignments, etc.)
    if (VALID_DATA_TYPES.has(funcUpper)) continue;

    // Emit warning for unrecognized function
    const pos = getPosition(originalText, match.index);
    diagnostics.push({
      severity: DiagnosticSeverity.Warning,
      range: {
        start: { line: pos.line + batchStartLine, character: pos.col },
        end: { line: pos.line + batchStartLine, character: pos.col + funcName.length },
      },
      message: `'${funcName}' is not a recognized built-in function or a function/procedure in the schema cache.`,
      source: 'tsql-lint',
      code: 'ESL003',
    });
  }
}

/**
 * Check for invalid INSERT column names against the schema cache (schema-dependent, Warning severity).
 * Skips if the target table is not found in the cache (Requirement 6.6).
 * Requirement 6.4
 */
function lintInsertColumnNames(
  stripped: string,
  batchStartLine: number,
  originalText: string,
  schemaCache: ISchemaCache,
  diagnostics: Diagnostic[]
): void {
  // Match: INSERT [INTO] [schema.]table [(col1, col2, ...)]
  // We need to find INSERT statements with explicit column lists
  const insertPattern = /\bINSERT\s+(?:INTO\s+)?([\w\[\]"]+(?:\.[\w\[\]"]+){0,2})\s*\(/gi;
  let match: RegExpExecArray | null;

  while ((match = insertPattern.exec(stripped)) !== null) {
    const tableRef = match[1];

    // Parse the table reference to extract schema and table name
    const parts = tableRef.split('.').map(p => stripDelimiters(p));
    let schemaName: string;
    let tableName: string;

    if (parts.length >= 3) {
      // database.schema.table — use schema and table
      schemaName = parts[1].toLowerCase();
      tableName = parts[2].toLowerCase();
    } else if (parts.length === 2) {
      // schema.table
      schemaName = parts[0].toLowerCase();
      tableName = parts[1].toLowerCase();
    } else {
      // unqualified — try dbo first, then any schema
      tableName = parts[0].toLowerCase();
      schemaName = '';
    }

    // Find the table in the schema cache
    let cachedTable = schemaCache.tables.find(t => {
      const tNameLower = t.name.toLowerCase();
      const tSchemaLower = t.schema.toLowerCase();
      if (schemaName === '') {
        return tNameLower === tableName;
      }
      return tSchemaLower === schemaName && tNameLower === tableName;
    });

    // If table not in cache, skip (Requirement 6.6)
    if (!cachedTable) continue;

    // Build set of valid column names (lowercased)
    const validColumns = new Set(cachedTable.columns.map(c => c.name.toLowerCase()));

    // Find the column list: the content between the opening and closing paren after the table name
    const afterMatch = stripped.substring(match.index + match[0].length - 1); // starts at '('
    let parenDepth = 0;
    let colListEnd = -1;
    for (let i = 0; i < afterMatch.length; i++) {
      if (afterMatch[i] === '(') parenDepth++;
      if (afterMatch[i] === ')') {
        parenDepth--;
        if (parenDepth === 0) {
          colListEnd = i;
          break;
        }
      }
    }

    if (colListEnd < 0) continue; // malformed, skip

    // Check what comes after the column list paren
    const afterColList = afterMatch.substring(colListEnd + 1).trimStart();
    // If the next token is VALUES or SELECT, this was a column list; otherwise it might be a subquery
    if (!/^(?:VALUES|SELECT)\b/i.test(afterColList)) {
      // Could be a subquery like INSERT INTO t(a, b) SELECT ... — still valid to check
      // Or it might be VALUES — proceed with validation regardless
    }

    const colListText = afterMatch.substring(1, colListEnd); // content between parens
    const colListBase = match.index + match[0].length - 1 + 1; // offset of first char inside parens

    // Split by commas (simple split — doesn't handle nested parens, but column lists won't have them)
    const columnTokens = colListText.split(',');
    let tokenOffset = colListBase;

    for (const token of columnTokens) {
      const trimmedToken = token.trim();
      if (trimmedToken === '') {
        tokenOffset += token.length + 1; // +1 for the comma
        continue;
      }

      const colNameNormalized = normalizeId(trimmedToken).toLowerCase();

      if (!validColumns.has(colNameNormalized)) {
        // Find the actual position of this token in the original stripped text
        const tokenStart = tokenOffset + token.indexOf(trimmedToken);
        const pos = getPosition(originalText, tokenStart);
        const displayName = stripDelimiters(trimmedToken);
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          range: {
            start: { line: pos.line + batchStartLine, character: pos.col },
            end: { line: pos.line + batchStartLine, character: pos.col + trimmedToken.length },
          },
          message: `Column '${displayName}' is not recognized on table '${cachedTable!.schema}.${cachedTable!.name}'.`,
          source: 'tsql-lint',
          code: 'ESL004',
        });
      }

      tokenOffset += token.length + 1; // +1 for the comma
    }
  }
}

// ─── Additional Keyword Sets ───────────────────────────────────────────────────

/**
 * T-SQL keywords that appear before '(' but are not function names.
 * These should not be flagged as unrecognized functions.
 */
const T_SQL_KEYWORDS_BEFORE_PAREN = new Set<string>([
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'ON', 'AND', 'OR', 'NOT', 'IN', 'EXISTS',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AS', 'WITH', 'BEGIN', 'END',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'ALTER',
  'DROP', 'EXEC', 'EXECUTE', 'DECLARE', 'IF', 'WHILE', 'CATCH', 'TRY',
  'OVER', 'PARTITION', 'BY', 'OUTPUT', 'MERGE', 'USING', 'PIVOT', 'UNPIVOT',
  'UNION', 'INTERSECT', 'EXCEPT', 'BETWEEN', 'LIKE', 'IS', 'NULL',
  'PRIMARY', 'FOREIGN', 'CONSTRAINT', 'DEFAULT', 'UNIQUE', 'CHECK',
  'IDENTITY', 'INDEX', 'TABLE', 'VIEW', 'PROCEDURE', 'FUNCTION', 'TRIGGER',
  'DATABASE', 'SCHEMA', 'GRANT', 'REVOKE', 'DENY', 'BACKUP', 'RESTORE',
  'WAITFOR', 'RETURN', 'BREAK', 'CONTINUE', 'PRINT', 'THROW', 'RAISERROR',
  'TRUNCATE', 'BULK', 'OPENROWSET', 'ROLLBACK', 'COMMIT', 'TRANSACTION',
  'SAVE', 'TRAN',
]);

/**
 * T-SQL control-flow constructs that use parentheses but are not functions.
 */
const T_SQL_CONTROL_FLOW = new Set<string>([
  'IF', 'WHILE', 'CASE', 'CATCH', 'TRY',
]);

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Run enhanced syntax linting on a single SQL batch.
 *
 * Always runs (connected or not):
 * - Invalid keyword sequences → Error severity
 * - Invalid data types in CAST/CONVERT → Error severity
 *
 * Runs only when connected and schema cache is available:
 * - Unrecognized function names → Warning severity
 * - Invalid INSERT column names → Warning severity
 *
 * @param text           - The SQL batch text
 * @param batchStartLine - 0-based line number of the first line of this batch in the full document
 * @param context        - Context with connection state and optional schema cache
 * @returns Array of LSP Diagnostic objects
 */
export function lintEnhancedSyntax(
  text: string,
  batchStartLine: number,
  context: EnhancedSyntaxLinterContext
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // Pre-process: strip string literals and comments to avoid false positives
  const stripped = stripStringsAndComments(text);

  // ── Always-run rules ──────────────────────────────────────────────────────

  // Rule 1: Invalid keyword sequences (Requirement 6.1)
  lintKeywordSequences(stripped, batchStartLine, text, diagnostics);

  // Rule 2: Invalid data types in CAST/CONVERT (Requirement 6.3)
  lintCastConvertDataTypes(stripped, batchStartLine, text, diagnostics);

  // ── Schema-dependent rules (skip when disconnected or no cache) ───────────

  if (context.isConnected && context.schemaCache !== null) {
    // Rule 3: Unrecognized function names (Requirement 6.2)
    lintUnrecognizedFunctions(stripped, batchStartLine, text, context.schemaCache, diagnostics);

    // Rule 4: Invalid INSERT column names (Requirement 6.4)
    lintInsertColumnNames(stripped, batchStartLine, text, context.schemaCache, diagnostics);
  }

  return diagnostics;
}
