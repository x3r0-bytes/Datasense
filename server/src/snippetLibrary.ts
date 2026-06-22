/**
 * T-SQL Snippet/Template Library
 *
 * Defines pre-built T-SQL code templates (MERGE, TRY/CATCH, cursor loop,
 * pagination, dynamic SQL) served as IntelliSense completions with
 * context-aware ranking.
 */

import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
} from 'vscode-languageserver/node';

/**
 * Defines the structure of a snippet template.
 */
export interface SnippetDefinition {
  /** Trigger text (e.g., "merge") */
  prefix: string;
  /** Display label in the completion list */
  label: string;
  /** VS Code snippet syntax with $1, $2, etc. tab stops */
  body: string;
  /** Number of unique tab stops (excluding $0) */
  tabStopCount: number;
  /** Tooltip description */
  description: string;
}

/**
 * All registered snippet definitions.
 */
export const SNIPPET_DEFINITIONS: SnippetDefinition[] = [
  {
    prefix: 'merge',
    label: 'MERGE statement',
    description: 'MERGE statement with MATCHED/NOT MATCHED actions',
    tabStopCount: 5,
    body: [
      'MERGE INTO ${1:TargetTable} AS target',
      'USING ${2:SourceTable} AS source',
      'ON ${3:target.Id = source.Id}',
      'WHEN MATCHED THEN',
      '\tUPDATE SET ${4:target.Column = source.Column}',
      'WHEN NOT MATCHED THEN',
      '\tINSERT (${5:Column1, Column2})',
      '\tVALUES (source.${5:Column1, Column2});',
      '$0',
    ].join('\n'),
  },
  {
    prefix: 'trycatch',
    label: 'TRY/CATCH block',
    description: 'TRY/CATCH block with ERROR_NUMBER, ERROR_MESSAGE, and ERROR_SEVERITY',
    tabStopCount: 2,
    body: [
      'BEGIN TRY',
      '\t${1:-- Try body}',
      'END TRY',
      'BEGIN CATCH',
      '\t${2:SELECT',
      '\t\tERROR_NUMBER() AS ErrorNumber,',
      '\t\tERROR_MESSAGE() AS ErrorMessage,',
      '\t\tERROR_SEVERITY() AS ErrorSeverity;}',
      'END CATCH',
      '$0',
    ].join('\n'),
  },
  {
    prefix: 'cursor',
    label: 'Cursor loop',
    description: 'DECLARE/OPEN/FETCH/CLOSE/DEALLOCATE cursor loop pattern',
    tabStopCount: 3,
    body: [
      'DECLARE ${1:cursor_name} CURSOR FOR',
      '${2:SELECT column FROM table_name};',
      '',
      'OPEN ${1:cursor_name};',
      'FETCH NEXT FROM ${1:cursor_name};',
      '',
      'WHILE @@FETCH_STATUS = 0',
      'BEGIN',
      '\t${3:-- Loop body}',
      '\tFETCH NEXT FROM ${1:cursor_name};',
      'END',
      '',
      'CLOSE ${1:cursor_name};',
      'DEALLOCATE ${1:cursor_name};',
      '$0',
    ].join('\n'),
  },
  {
    prefix: 'paginate',
    label: 'Pagination (OFFSET/FETCH)',
    description: 'Pagination using OFFSET/FETCH NEXT with page number and page size',
    tabStopCount: 3,
    body: [
      'ORDER BY ${1:ColumnName}',
      'OFFSET (${2:@PageNumber} - 1) * ${3:@PageSize} ROWS',
      'FETCH NEXT ${3:@PageSize} ROWS ONLY;',
      '$0',
    ].join('\n'),
  },
  {
    prefix: 'dynamicsql',
    label: 'Dynamic SQL (sp_executesql)',
    description: 'Dynamic SQL execution using sp_executesql with parameters',
    tabStopCount: 3,
    body: [
      'DECLARE @sql NVARCHAR(MAX);',
      'DECLARE @params NVARCHAR(MAX);',
      '',
      "SET @sql = N'${1:SELECT * FROM TableName WHERE Id = @Id}';",
      "SET @params = N'${2:@Id INT}';",
      '',
      'EXEC sp_executesql @sql, @params, ${3:@Id = 1};',
      '$0',
    ].join('\n'),
  },
];

/**
 * Returns all snippets whose prefix starts with the typed text (case-insensitive).
 */
export function getMatchingSnippets(typedPrefix: string): CompletionItem[] {
  const lower = typedPrefix.toLowerCase();
  const matching = SNIPPET_DEFINITIONS.filter((s) =>
    s.prefix.toLowerCase().startsWith(lower)
  );
  return matching.map((s) => toCompletionItem(s, false));
}

/**
 * Detects context triggers in the text before the cursor and returns
 * the set of snippet prefixes that should be elevated in ranking.
 */
export function detectSnippetContext(textBeforeCursor: string): Set<string> {
  const elevated = new Set<string>();

  // INSERT/UPDATE + table reference → elevate "merge"
  if (/\b(?:INSERT|UPDATE)\s+(?:\[?\w+\]?\.?)?\[?\w+\]?\s*$/i.test(textBeforeCursor)) {
    elevated.add('merge');
  }

  // Standalone BEGIN (not preceded by TRAN/TRANSACTION/DISTRIBUTED) → elevate "trycatch"
  if (/\bBEGIN\s*$/i.test(textBeforeCursor) &&
      !/\b(?:TRAN|TRANSACTION|DISTRIBUTED)\s+BEGIN\s*$/i.test(textBeforeCursor)) {
    elevated.add('trycatch');
  }

  // DECLARE + cursor keywords → elevate "cursor"
  if (/\bDECLARE\b/i.test(textBeforeCursor) &&
      /\b(?:CURSOR|OPEN|FETCH|CLOSE|DEALLOCATE)\b/i.test(textBeforeCursor)) {
    elevated.add('cursor');
  }

  // ORDER BY → elevate "paginate"
  if (/\bORDER\s+BY\b/i.test(textBeforeCursor)) {
    elevated.add('paginate');
  }

  return elevated;
}

/**
 * Converts a SnippetDefinition to a CompletionItem with appropriate sortText.
 * Elevated snippets rank at tier 2 (between columns and schema objects).
 * Non-elevated snippets rank at tier 3 (below schema objects).
 */
export function toCompletionItem(
  snippet: SnippetDefinition,
  elevated: boolean
): CompletionItem {
  const sortPrefix = elevated ? '2' : '3';
  return {
    label: snippet.label,
    kind: CompletionItemKind.Snippet,
    detail: 'Snippet',
    documentation: snippet.description,
    insertText: snippet.body,
    insertTextFormat: InsertTextFormat.Snippet,
    sortText: `${sortPrefix}_snippet_${snippet.prefix}`,
    filterText: snippet.prefix,
  };
}
