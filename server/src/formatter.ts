/**
 * T-SQL Formatter — Reformats T-SQL source code with consistent
 * keyword casing, indentation, and clause placement.
 * 
 * Uses a token-based reformatting approach:
 * 1. Parse to check for errors (if errors, return unchanged)
 * 2. Tokenize and reformat using structural rules
 * 3. Handle each GO-delimited batch independently
 */

import { parseDocument, parseBatch, SourceRange, SourcePosition, TSqlNode } from './tsqlParser';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface FormatOptions {
  tabSize: number;
  insertSpaces: boolean;
  eol: string;
}

export interface FormatResult {
  text: string;
  formatted: boolean;
}

// ─── Token Types ──────────────────────────────────────────────────────────────

interface FmtToken {
  type: FmtTokenType;
  value: string;
  upper: string;
}

type FmtTokenType =
  | 'keyword'
  | 'identifier'
  | 'number'
  | 'string'
  | 'operator'
  | 'punctuation'
  | 'comment_line'
  | 'comment_block'
  | 'whitespace'
  | 'newline';

// ─── T-SQL Keywords ───────────────────────────────────────────────────────────

const TSQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL',
  'OUTER', 'CROSS', 'ON', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN',
  'LIKE', 'IS', 'NULL', 'AS', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET',
  'DELETE', 'CREATE', 'ALTER', 'DROP', 'TABLE', 'VIEW', 'PROCEDURE', 'PROC',
  'FUNCTION', 'TRIGGER', 'INDEX', 'SCHEMA', 'DATABASE', 'EXEC', 'EXECUTE',
  'DECLARE', 'IF', 'ELSE', 'WHILE', 'BEGIN', 'END', 'TRY', 'CATCH',
  'THROW', 'RETURN', 'BREAK', 'CONTINUE', 'GOTO', 'PRINT', 'RAISERROR',
  'WITH', 'NOLOCK', 'UNION', 'ALL', 'EXCEPT', 'INTERSECT', 'ORDER', 'BY',
  'GROUP', 'HAVING', 'TOP', 'DISTINCT', 'CASE', 'WHEN', 'THEN',
  'CAST', 'CONVERT', 'COALESCE', 'NULLIF', 'IIF', 'MERGE',
  'USING', 'MATCHED', 'TARGET', 'SOURCE', 'OUTPUT', 'INSERTED', 'DELETED',
  'OVER', 'PARTITION', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE',
  'ASC', 'DESC', 'OFFSET', 'FETCH', 'NEXT', 'ROWS', 'ONLY', 'FIRST',
  'CONSTRAINT', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'UNIQUE',
  'CHECK', 'DEFAULT', 'IDENTITY', 'CLUSTERED', 'NONCLUSTERED',
  'GO', 'USE', 'GRANT', 'REVOKE', 'DENY', 'ROLLBACK', 'COMMIT',
  'TRANSACTION', 'TRAN', 'SAVE', 'SAVEPOINT', 'WAITFOR', 'DELAY',
  'OPENQUERY', 'OPENROWSET', 'PIVOT', 'UNPIVOT', 'APPLY',
  'OPTION', 'RECOMPILE', 'MAXRECURSION', 'CURSOR', 'OPEN', 'CLOSE',
  'DEALLOCATE', 'ABSOLUTE', 'RELATIVE', 'PRIOR',
  'VARCHAR', 'NVARCHAR', 'INT', 'BIGINT', 'SMALLINT', 'TINYINT',
  'DECIMAL', 'NUMERIC', 'FLOAT', 'REAL', 'BIT', 'DATE', 'DATETIME',
  'DATETIME2', 'TIME', 'CHAR', 'NCHAR', 'TEXT', 'NTEXT', 'IMAGE',
  'BINARY', 'VARBINARY', 'UNIQUEIDENTIFIER', 'XML', 'MONEY', 'SMALLMONEY',
  'SMALLDATETIME', 'DATETIMEOFFSET', 'HIERARCHYID', 'GEOGRAPHY', 'GEOMETRY',
  'MAX', 'MIN', 'COUNT', 'SUM', 'AVG', 'STDEV', 'VAR',
  'ABS', 'CEILING', 'FLOOR', 'ROUND', 'POWER', 'SQRT', 'LOG', 'EXP',
  'SIGN', 'RAND', 'NEWID', 'GETDATE', 'GETUTCDATE', 'SYSDATETIME',
  'DATEADD', 'DATEDIFF', 'DATENAME', 'DATEPART', 'YEAR', 'MONTH', 'DAY',
  'LEN', 'LTRIM', 'RTRIM', 'TRIM', 'UPPER', 'LOWER', 'REPLACE',
  'SUBSTRING', 'CHARINDEX', 'PATINDEX', 'STUFF', 'REVERSE', 'REPLICATE',
  'SPACE', 'STR', 'FORMAT', 'CONCAT', 'STRING_AGG',
  'ISNULL', 'SCOPE_IDENTITY', 'IDENT_CURRENT', 'OBJECT_ID',
  'OBJECT_DEFINITION', 'DB_NAME', 'SCHEMA_NAME', 'TYPE_NAME',
  'COLUMNPROPERTY', 'SERVERPROPERTY', 'DATABASEPROPERTYEX',
  'TEMP', 'GLOBAL', 'LOCAL', 'STATIC', 'DYNAMIC', 'FAST_FORWARD',
  'READ_ONLY', 'SCROLL', 'KEYSET', 'OPTIMISTIC', 'TYPE',
  'READONLY', 'VARYING', 'RETURNS', 'EXTERNAL', 'NAME',
  'INCLUDE', 'FILLFACTOR', 'PAD_INDEX', 'STATISTICS_NORECOMPUTE',
  'ALLOW_ROW_LOCKS', 'ALLOW_PAGE_LOCKS', 'ONLINE', 'SORT_IN_TEMPDB',
  'NOCOUNT', 'ANSI_NULLS', 'QUOTED_IDENTIFIER', 'XACT_ABORT',
]);

// ─── Tokenizer ────────────────────────────────────────────────────────────────

function tokenize(text: string): FmtToken[] {
  const tokens: FmtToken[] = [];
  let pos = 0;

  while (pos < text.length) {
    const ch = text[pos];

    // Newlines
    if (ch === '\r' && pos + 1 < text.length && text[pos + 1] === '\n') {
      tokens.push({ type: 'newline', value: '\r\n', upper: '' });
      pos += 2;
      continue;
    }
    if (ch === '\n') {
      tokens.push({ type: 'newline', value: '\n', upper: '' });
      pos++;
      continue;
    }

    // Whitespace (not newlines)
    if (ch === ' ' || ch === '\t') {
      const start = pos;
      while (pos < text.length && (text[pos] === ' ' || text[pos] === '\t')) pos++;
      tokens.push({ type: 'whitespace', value: text.substring(start, pos), upper: '' });
      continue;
    }

    // Line comment
    if (ch === '-' && pos + 1 < text.length && text[pos + 1] === '-') {
      const start = pos;
      pos += 2;
      while (pos < text.length && text[pos] !== '\n' && text[pos] !== '\r') pos++;
      tokens.push({ type: 'comment_line', value: text.substring(start, pos), upper: '' });
      continue;
    }

    // Block comment
    if (ch === '/' && pos + 1 < text.length && text[pos + 1] === '*') {
      const start = pos;
      pos += 2;
      while (pos < text.length) {
        if (text[pos] === '*' && pos + 1 < text.length && text[pos + 1] === '/') {
          pos += 2;
          break;
        }
        pos++;
      }
      tokens.push({ type: 'comment_block', value: text.substring(start, pos), upper: '' });
      continue;
    }

    // String literal
    if (ch === "'") {
      const start = pos;
      pos++;
      while (pos < text.length) {
        if (text[pos] === "'") {
          pos++;
          if (pos < text.length && text[pos] === "'") { pos++; } else { break; }
        } else { pos++; }
      }
      tokens.push({ type: 'string', value: text.substring(start, pos), upper: '' });
      continue;
    }

    // N-prefixed string
    if ((ch === 'N' || ch === 'n') && pos + 1 < text.length && text[pos + 1] === "'") {
      const start = pos;
      pos += 2;
      while (pos < text.length) {
        if (text[pos] === "'") {
          pos++;
          if (pos < text.length && text[pos] === "'") { pos++; } else { break; }
        } else { pos++; }
      }
      tokens.push({ type: 'string', value: text.substring(start, pos), upper: '' });
      continue;
    }

    // Bracket identifier [...]
    if (ch === '[') {
      const start = pos;
      pos++;
      while (pos < text.length && text[pos] !== ']') pos++;
      if (pos < text.length) pos++;
      tokens.push({ type: 'identifier', value: text.substring(start, pos), upper: '' });
      continue;
    }

    // Double-quote identifier "..."
    if (ch === '"') {
      const start = pos;
      pos++;
      while (pos < text.length && text[pos] !== '"') pos++;
      if (pos < text.length) pos++;
      tokens.push({ type: 'identifier', value: text.substring(start, pos), upper: '' });
      continue;
    }

    // Number
    if (/\d/.test(ch)) {
      const start = pos;
      while (pos < text.length && /\d/.test(text[pos])) pos++;
      if (pos < text.length && text[pos] === '.') {
        pos++;
        while (pos < text.length && /\d/.test(text[pos])) pos++;
      }
      tokens.push({ type: 'number', value: text.substring(start, pos), upper: '' });
      continue;
    }

    // Operators
    if ('=<>!+-*/%&|^~'.includes(ch)) {
      const start = pos;
      pos++;
      if (pos < text.length) {
        const two = text.substring(start, pos + 1);
        if (['<=', '>=', '<>', '!=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^='].includes(two)) {
          pos++;
        }
      }
      tokens.push({ type: 'operator', value: text.substring(start, pos), upper: '' });
      continue;
    }

    // Punctuation
    if ('(),.;'.includes(ch)) {
      tokens.push({ type: 'punctuation', value: ch, upper: '' });
      pos++;
      continue;
    }

    // Identifier or keyword
    if (/[a-zA-Z_@#]/.test(ch)) {
      const start = pos;
      while (pos < text.length && /[a-zA-Z0-9_@#$]/.test(text[pos])) pos++;
      const value = text.substring(start, pos);
      const upper = value.toUpperCase();
      const isKw = TSQL_KEYWORDS.has(upper) && !value.startsWith('@') && !value.startsWith('#');
      tokens.push({ type: isKw ? 'keyword' : 'identifier', value, upper });
      continue;
    }

    // Unknown
    tokens.push({ type: 'punctuation', value: ch, upper: '' });
    pos++;
  }

  return tokens;
}

// ─── Significant Token Helpers ────────────────────────────────────────────────

/** Filter tokens to only significant ones (no whitespace/newlines) */
function getSignificantTokens(tokens: FmtToken[]): FmtToken[] {
  return tokens.filter(t =>
    t.type !== 'whitespace' && t.type !== 'newline'
  );
}

/** Check if token at idx in significant tokens starts a JOIN */
function isJoinStartSig(sig: FmtToken[], idx: number): boolean {
  const t = sig[idx];
  if (t.type !== 'keyword') return false;
  if (t.upper === 'JOIN') return true;
  if (['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS'].includes(t.upper)) {
    for (let i = idx + 1; i < sig.length; i++) {
      if (sig[i].type === 'comment_line' || sig[i].type === 'comment_block') continue;
      if (sig[i].type === 'keyword' && sig[i].upper === 'JOIN') return true;
      if (sig[i].type === 'keyword' && sig[i].upper === 'OUTER') continue;
      break;
    }
  }
  return false;
}

// ─── GO Batch Splitting ───────────────────────────────────────────────────────

interface FormatterBatch {
  text: string;
  goLine: string | null;
}

function splitBatches(text: string): FormatterBatch[] {
  const lines = text.split(/\r?\n/);
  const batches: FormatterBatch[] = [];
  let currentLines: string[] = [];
  let inBlockComment = false;
  let inString = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inBlockComment && !inString) {
      if (/^\s*GO\s*$/i.test(line)) {
        batches.push({ text: currentLines.join('\n'), goLine: line });
        currentLines = [];
        continue;
      }
    }

    currentLines.push(line);

    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const next = j + 1 < line.length ? line[j + 1] : '';
      if (inBlockComment) {
        if (ch === '*' && next === '/') { inBlockComment = false; j++; }
      } else if (inString) {
        if (ch === "'") {
          if (next === "'") { j++; } else { inString = false; }
        }
      } else {
        if (ch === '-' && next === '-') break;
        if (ch === '/' && next === '*') { inBlockComment = true; j++; }
        else if (ch === "'") { inString = true; }
      }
    }
  }

  batches.push({ text: currentLines.join('\n'), goLine: null });
  return batches;
}

// ─── Formatting Engine ────────────────────────────────────────────────────────

function getIndent(level: number, options: FormatOptions): string {
  if (level <= 0) return '';
  const unit = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';
  return unit.repeat(level);
}

/**
 * Main formatting function for a single batch.
 * Operates on significant tokens and rebuilds the output with proper formatting.
 */
function formatBatch(text: string, options: FormatOptions): string {
  const trimmed = text.trim();
  if (!trimmed) return '';

  const allTokens = tokenize(trimmed);
  const sig = getSignificantTokens(allTokens);
  if (sig.length === 0) return '';

  const eol = options.eol;
  const parts: string[] = [];
  let indent = 0;
  let i = 0;

  // Track state
  let needsNewline = false;
  let inSelectList = false;
  let selectListParenDepth = 0;
  let parenDepth = 0;

  // Stack for nested structures
  const structStack: Array<'begin' | 'case' | 'subquery'> = [];

  function emit(s: string): void {
    parts.push(s);
  }

  function emitNewline(): void {
    emit(eol);
    emit(getIndent(indent, options));
  }

  function emitToken(t: FmtToken): void {
    if (t.type === 'keyword') {
      emit(t.upper);
    } else {
      emit(t.value);
    }
  }

  function peekSig(offset: number): FmtToken | null {
    const idx = i + offset;
    return idx < sig.length ? sig[idx] : null;
  }

  function isClauseKeyword(idx: number): boolean {
    const t = sig[idx];
    if (t.type !== 'keyword') return false;
    const kw = t.upper;
    if (['SELECT', 'FROM', 'WHERE', 'HAVING'].includes(kw)) return true;
    if (kw === 'GROUP' || kw === 'ORDER') {
      const next = peekFromIdx(idx + 1);
      return next !== null && next.type === 'keyword' && next.upper === 'BY';
    }
    if (isJoinStartSig(sig, idx)) return true;
    return false;
  }

  function peekFromIdx(idx: number): FmtToken | null {
    // Skip comments
    for (let j = idx; j < sig.length; j++) {
      if (sig[j].type !== 'comment_line' && sig[j].type !== 'comment_block') {
        return sig[j];
      }
    }
    return null;
  }

  // First token starts at indent 0
  emit(getIndent(indent, options));

  while (i < sig.length) {
    const token = sig[i];

    // ─── Comments ─────────────────────────────────────────────────────
    if (token.type === 'comment_line') {
      emit(' ');
      emit(token.value);
      if (i + 1 < sig.length) emitNewline();
      i++;
      continue;
    }
    if (token.type === 'comment_block') {
      emit(' ');
      emit(token.value);
      i++;
      continue;
    }

    // ─── SELECT keyword ───────────────────────────────────────────────
    if (token.type === 'keyword' && token.upper === 'SELECT') {
      if (i > 0) emitNewline();
      emitToken(token);
      i++;

      // Handle DISTINCT / TOP
      while (i < sig.length && sig[i].type === 'keyword' &&
             (sig[i].upper === 'DISTINCT' || sig[i].upper === 'TOP')) {
        emit(' ');
        emitToken(sig[i]);
        i++;
        // TOP (n) or TOP n
        if (i < sig.length && sig[i].type === 'punctuation' && sig[i].value === '(') {
          emit('(');
          i++;
          while (i < sig.length && !(sig[i].type === 'punctuation' && sig[i].value === ')')) {
            emitToken(sig[i]);
            i++;
          }
          if (i < sig.length) { emit(')'); i++; }
        } else if (i < sig.length && sig[i].type === 'number') {
          emit(' ');
          emitToken(sig[i]);
          i++;
        }
      }

      // Now format SELECT column list
      inSelectList = true;
      selectListParenDepth = 0;
      indent++;

      // Emit each column on its own line
      let firstCol = true;
      while (i < sig.length && inSelectList) {
        // Check if we've hit a clause boundary at depth 0
        if (selectListParenDepth === 0 && sig[i].type === 'keyword') {
          const kw = sig[i].upper;
          if (['FROM', 'INTO', 'WHERE', 'GROUP', 'HAVING', 'ORDER',
               'UNION', 'EXCEPT', 'INTERSECT', 'FOR', 'OPTION'].includes(kw)) {
            inSelectList = false;
            break;
          }
          if (isJoinStartSig(sig, i)) {
            inSelectList = false;
            break;
          }
          // Also stop at statement-starting keywords
          if (['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP',
               'EXEC', 'EXECUTE', 'DECLARE', 'SET', 'IF', 'WHILE',
               'BEGIN', 'END', 'MERGE', 'WITH', 'RETURN', 'PRINT'].includes(kw)) {
            inSelectList = false;
            break;
          }
        }

        // Start a new column line
        emitNewline();
        firstCol = false;

        // Emit tokens for this column until comma at depth 0
        let colTokenIdx = 0;
        while (i < sig.length) {
          if (selectListParenDepth === 0) {
            // Check for clause boundary
            if (sig[i].type === 'keyword') {
              const kw = sig[i].upper;
              if (['FROM', 'INTO', 'WHERE', 'GROUP', 'HAVING', 'ORDER',
                   'UNION', 'EXCEPT', 'INTERSECT', 'FOR', 'OPTION'].includes(kw)) {
                inSelectList = false;
                break;
              }
              if (isJoinStartSig(sig, i)) {
                inSelectList = false;
                break;
              }
              if (['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP',
                   'EXEC', 'EXECUTE', 'DECLARE', 'SET', 'IF', 'WHILE',
                   'BEGIN', 'END', 'MERGE', 'WITH', 'RETURN', 'PRINT'].includes(kw)) {
                inSelectList = false;
                break;
              }
            }
            // Comma separates columns
            if (sig[i].type === 'punctuation' && sig[i].value === ',') {
              emit(',');
              i++;
              break; // next column
            }
          }

          // Track parens
          if (sig[i].type === 'punctuation' && sig[i].value === '(') {
            selectListParenDepth++;
          }
          if (sig[i].type === 'punctuation' && sig[i].value === ')') {
            selectListParenDepth--;
          }

          // Emit the token with appropriate spacing
          if (colTokenIdx === 0) {
            // First token on the line — no leading space (indent already emitted)
            emitToken(sig[i]);
          } else if (sig[i].type === 'punctuation' && sig[i].value === '(') {
            emitToken(sig[i]);
          } else if (sig[i].type === 'punctuation' && sig[i].value === ')') {
            emitToken(sig[i]);
          } else if (sig[i].type === 'punctuation' && sig[i].value === '.') {
            emitToken(sig[i]);
          } else if (i > 0 && sig[i - 1].type === 'punctuation' && sig[i - 1].value === '.') {
            emitToken(sig[i]);
          } else if (i > 0 && sig[i - 1].type === 'punctuation' && sig[i - 1].value === '(') {
            emitToken(sig[i]);
          } else if (sig[i].type === 'punctuation' && sig[i].value === ',') {
            emitToken(sig[i]);
          } else {
            emit(' ');
            emitToken(sig[i]);
          }
          colTokenIdx++;
          i++;
        }
      }

      indent--;
      continue;
    }

    // ─── FROM keyword ───────────────────────────────────────────────
    if (token.type === 'keyword' && token.upper === 'FROM') {
      emitNewline();
      emitToken(token);
      i++;
      // Emit FROM clause content with spaces
      while (i < sig.length) {
        if (sig[i].type === 'keyword' && isClauseKeyword(i)) break;
        if (sig[i].type === 'keyword' &&
            ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP',
             'EXEC', 'EXECUTE', 'DECLARE', 'SET', 'IF', 'WHILE',
             'BEGIN', 'END', 'MERGE', 'WITH', 'RETURN', 'PRINT',
             'UNION', 'EXCEPT', 'INTERSECT'].includes(sig[i].upper)) break;
        if (sig[i].type === 'punctuation' && sig[i].value === ';') break;
        emitSpacedToken(sig[i], i);
        i++;
      }
      continue;
    }

    // ─── WHERE keyword ──────────────────────────────────────────────
    if (token.type === 'keyword' && token.upper === 'WHERE') {
      emitNewline();
      emitToken(token);
      i++;
      while (i < sig.length) {
        if (sig[i].type === 'keyword' && isClauseKeyword(i)) break;
        if (sig[i].type === 'keyword' &&
            ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP',
             'EXEC', 'EXECUTE', 'DECLARE', 'SET', 'IF', 'WHILE',
             'BEGIN', 'END', 'MERGE', 'WITH', 'RETURN', 'PRINT',
             'UNION', 'EXCEPT', 'INTERSECT'].includes(sig[i].upper)) break;
        if (sig[i].type === 'punctuation' && sig[i].value === ';') break;
        emitSpacedToken(sig[i], i);
        i++;
      }
      continue;
    }

    // ─── HAVING keyword ─────────────────────────────────────────────
    if (token.type === 'keyword' && token.upper === 'HAVING') {
      emitNewline();
      emitToken(token);
      i++;
      while (i < sig.length) {
        if (sig[i].type === 'keyword' && isClauseKeyword(i)) break;
        if (sig[i].type === 'keyword' &&
            ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP',
             'EXEC', 'EXECUTE', 'DECLARE', 'SET', 'IF', 'WHILE',
             'BEGIN', 'END', 'MERGE', 'WITH', 'RETURN', 'PRINT',
             'UNION', 'EXCEPT', 'INTERSECT'].includes(sig[i].upper)) break;
        if (sig[i].type === 'punctuation' && sig[i].value === ';') break;
        emitSpacedToken(sig[i], i);
        i++;
      }
      continue;
    }

    // ─── GROUP BY / ORDER BY ────────────────────────────────────────
    if (token.type === 'keyword' && (token.upper === 'GROUP' || token.upper === 'ORDER')) {
      const next = peekSig(1);
      if (next && next.type === 'keyword' && next.upper === 'BY') {
        emitNewline();
        emitToken(token);
        emit(' ');
        emitToken(sig[i + 1]);
        i += 2;
        while (i < sig.length) {
          if (sig[i].type === 'keyword' && isClauseKeyword(i)) break;
          if (sig[i].type === 'keyword' &&
              ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP',
               'EXEC', 'EXECUTE', 'DECLARE', 'SET', 'IF', 'WHILE',
               'BEGIN', 'END', 'MERGE', 'WITH', 'RETURN', 'PRINT',
               'UNION', 'EXCEPT', 'INTERSECT', 'OPTION', 'OFFSET', 'FETCH'].includes(sig[i].upper)) break;
          if (sig[i].type === 'punctuation' && sig[i].value === ';') break;
          emitSpacedToken(sig[i], i);
          i++;
        }
        continue;
      }
    }

    // ─── JOIN keywords ──────────────────────────────────────────────
    if (isJoinStartSig(sig, i)) {
      emitNewline();
      // Emit all join-type keywords (INNER, LEFT OUTER, etc.)
      while (i < sig.length && sig[i].type === 'keyword' &&
             ['INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'JOIN'].includes(sig[i].upper)) {
        emitToken(sig[i]);
        i++;
        if (i < sig.length && sig[i].type === 'keyword' &&
            ['INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'JOIN'].includes(sig[i].upper)) {
          emit(' ');
        }
      }
      // Emit rest of JOIN clause until next clause
      while (i < sig.length) {
        if (sig[i].type === 'keyword' && isClauseKeyword(i)) break;
        if (sig[i].type === 'keyword' &&
            ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP',
             'EXEC', 'EXECUTE', 'DECLARE', 'SET', 'IF', 'WHILE',
             'BEGIN', 'END', 'MERGE', 'WITH', 'RETURN', 'PRINT',
             'UNION', 'EXCEPT', 'INTERSECT'].includes(sig[i].upper)) break;
        if (sig[i].type === 'punctuation' && sig[i].value === ';') break;
        emitSpacedToken(sig[i], i);
        i++;
      }
      continue;
    }

    // ─── BEGIN keyword ──────────────────────────────────────────────
    if (token.type === 'keyword' && token.upper === 'BEGIN') {
      emitNewline();
      emitToken(token);
      i++;
      // Check for BEGIN TRY / BEGIN CATCH / BEGIN TRANSACTION
      if (i < sig.length && sig[i].type === 'keyword' &&
          (sig[i].upper === 'TRY' || sig[i].upper === 'CATCH')) {
        emit(' ');
        emitToken(sig[i]);
        i++;
        indent++;
        structStack.push('begin');
      } else if (i < sig.length && sig[i].type === 'keyword' &&
                 (sig[i].upper === 'TRANSACTION' || sig[i].upper === 'TRAN')) {
        emit(' ');
        emitToken(sig[i]);
        i++;
        // Optional transaction name
        if (i < sig.length && sig[i].type === 'identifier') {
          emit(' ');
          emitToken(sig[i]);
          i++;
        }
      } else {
        indent++;
        structStack.push('begin');
      }
      continue;
    }

    // ─── END keyword ────────────────────────────────────────────────
    if (token.type === 'keyword' && token.upper === 'END') {
      // Check if this closes a CASE or a BEGIN
      if (structStack.length > 0 && structStack[structStack.length - 1] === 'case') {
        // END for CASE — decrease indent
        indent--;
        structStack.pop();
        emitNewline();
        emitToken(token);
        i++;
      } else {
        // END for BEGIN block
        if (structStack.length > 0 && structStack[structStack.length - 1] === 'begin') {
          indent--;
          structStack.pop();
        }
        emitNewline();
        emitToken(token);
        i++;
        // Check for END TRY / END CATCH
        if (i < sig.length && sig[i].type === 'keyword' &&
            (sig[i].upper === 'TRY' || sig[i].upper === 'CATCH')) {
          emit(' ');
          emitToken(sig[i]);
          i++;
        }
      }
      continue;
    }

    // ─── CASE keyword ───────────────────────────────────────────────
    if (token.type === 'keyword' && token.upper === 'CASE') {
      emit(' ');
      emitToken(token);
      indent++;
      structStack.push('case');
      i++;
      continue;
    }

    // ─── WHEN keyword (inside CASE) ─────────────────────────────────
    if (token.type === 'keyword' && token.upper === 'WHEN' &&
        structStack.length > 0 && structStack[structStack.length - 1] === 'case') {
      emitNewline();
      emitToken(token);
      i++;
      // Emit until THEN
      while (i < sig.length) {
        if (sig[i].type === 'keyword' && sig[i].upper === 'THEN') {
          emit(' ');
          emitToken(sig[i]);
          i++;
          break;
        }
        emitSpacedToken(sig[i], i);
        i++;
      }
      continue;
    }

    // ─── ELSE keyword (inside CASE) ─────────────────────────────────
    if (token.type === 'keyword' && token.upper === 'ELSE' &&
        structStack.length > 0 && structStack[structStack.length - 1] === 'case') {
      emitNewline();
      emitToken(token);
      i++;
      continue;
    }

    // ─── Semicolons ─────────────────────────────────────────────────
    if (token.type === 'punctuation' && token.value === ';') {
      emit(';');
      i++;
      if (i < sig.length) emitNewline();
      continue;
    }

    // ─── UNION / EXCEPT / INTERSECT ─────────────────────────────────
    if (token.type === 'keyword' &&
        ['UNION', 'EXCEPT', 'INTERSECT'].includes(token.upper)) {
      emitNewline();
      emitToken(token);
      i++;
      if (i < sig.length && sig[i].type === 'keyword' && sig[i].upper === 'ALL') {
        emit(' ');
        emitToken(sig[i]);
        i++;
      }
      continue;
    }

    // ─── Other statement-starting keywords ──────────────────────────
    if (token.type === 'keyword' &&
        ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP',
         'EXEC', 'EXECUTE', 'DECLARE', 'SET', 'IF', 'WHILE',
         'MERGE', 'WITH', 'RETURN', 'PRINT', 'RAISERROR', 'THROW',
         'USE', 'GRANT', 'REVOKE', 'DENY', 'WAITFOR',
         'BREAK', 'CONTINUE', 'GOTO', 'ROLLBACK', 'COMMIT'].includes(token.upper)) {
      if (i > 0) emitNewline();
      emitToken(token);
      i++;
      // Emit rest of statement until next statement/clause boundary or semicolon
      let stmtParenDepth = 0;
      while (i < sig.length) {
        // Stop at semicolons at depth 0
        if (stmtParenDepth === 0 && sig[i].type === 'punctuation' && sig[i].value === ';') {
          break;
        }
        // Stop at clause keywords (for UPDATE...SET...FROM...WHERE pattern)
        if (stmtParenDepth === 0 && sig[i].type === 'keyword' && isClauseKeyword(i)) {
          break;
        }
        // Stop at next statement start
        if (stmtParenDepth === 0 && sig[i].type === 'keyword' &&
            ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP',
             'EXEC', 'EXECUTE', 'DECLARE', 'SET', 'IF', 'WHILE',
             'BEGIN', 'END', 'MERGE', 'WITH', 'RETURN', 'PRINT',
             'RAISERROR', 'THROW', 'UNION', 'EXCEPT', 'INTERSECT'].includes(sig[i].upper)) {
          break;
        }
        if (sig[i].type === 'punctuation' && sig[i].value === '(') stmtParenDepth++;
        if (sig[i].type === 'punctuation' && sig[i].value === ')') stmtParenDepth--;
        emitSpacedToken(sig[i], i);
        i++;
      }
      continue;
    }

    // ─── Default: emit with space ───────────────────────────────────
    emitSpacedToken(token, i);
    i++;
  }

  // Helper function for emitting tokens with appropriate spacing
  function emitSpacedToken(t: FmtToken, idx: number): void {
    const prev = idx > 0 ? sig[idx - 1] : null;

    // No space after open paren
    if (prev && prev.type === 'punctuation' && prev.value === '(') {
      emitToken(t);
      return;
    }
    // No space before close paren
    if (t.type === 'punctuation' && t.value === ')') {
      emitToken(t);
      return;
    }
    // No space around dots
    if (t.type === 'punctuation' && t.value === '.') {
      emitToken(t);
      return;
    }
    if (prev && prev.type === 'punctuation' && prev.value === '.') {
      emitToken(t);
      return;
    }
    // No space before comma
    if (t.type === 'punctuation' && t.value === ',') {
      emitToken(t);
      return;
    }
    // No space before open paren for function calls
    if (t.type === 'punctuation' && t.value === '(' &&
        prev && (prev.type === 'keyword' || prev.type === 'identifier')) {
      emitToken(t);
      return;
    }
    // Space before everything else
    emit(' ');
    emitToken(t);
  }

  let result = parts.join('');
  // Trim trailing whitespace from each line
  result = result.split(eol).map(line => line.trimEnd()).join(eol);
  // Remove leading empty line if present
  if (result.startsWith(eol)) {
    result = result.substring(eol.length);
  }
  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Format an entire T-SQL document.
 * Returns original text unchanged if syntax errors are present.
 * Handles GO batch separators by formatting each batch independently.
 */
export function formatDocument(text: string, options: FormatOptions): FormatResult {
  if (!text || text.trim().length === 0) {
    return { text: '', formatted: true };
  }

  // Check for syntax errors — if any, return unchanged
  const parseResults = parseDocument(text);
  for (const result of parseResults) {
    if (result.errors.length > 0) {
      return { text, formatted: false };
    }
  }

  // Split into batches and format each independently
  const batches = splitBatches(text);
  const eol = options.eol;
  const formattedParts: string[] = [];

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const formatted = formatBatch(batch.text, options);
    formattedParts.push(formatted);

    if (batch.goLine !== null) {
      formattedParts.push(eol + 'GO');
    }
  }

  let result = formattedParts.join('');
  // Ensure final newline
  if (result.length > 0 && !result.endsWith(eol)) {
    result += eol;
  }

  return { text: result, formatted: true };
}

/**
 * Format a selection within a T-SQL document.
 * Expands selection to nearest complete statement boundaries.
 * Returns the formatted selection text and the expanded range.
 */
export function formatSelection(
  text: string,
  startOffset: number,
  endOffset: number,
  options: FormatOptions
): { text: string; range: SourceRange } | null {
  if (!text || startOffset >= endOffset) return null;

  // Expand to statement boundaries
  const expanded = expandToStatementBoundaries(text, startOffset, endOffset);
  if (!expanded) return null;

  const selectedText = text.substring(expanded.startOffset, expanded.endOffset);

  // Check for syntax errors in the selection
  const parseResult = parseBatch(selectedText);
  if (parseResult.errors.length > 0) {
    return null;
  }

  // Format the selection
  const formatted = formatBatch(selectedText, options);
  if (!formatted) return null;

  // Calculate the source range
  const range = offsetsToRange(text, expanded.startOffset, expanded.endOffset);

  return { text: formatted, range };
}

/**
 * Format a single AST node into text with the given options.
 * Since the AST doesn't preserve all tokens, this extracts the source text
 * for the node's range and reformats it.
 */
export function formatNode(node: TSqlNode, options: FormatOptions, indentLevel: number): string {
  // formatNode is a simplified interface — in practice, the formatter
  // works on text, not AST nodes directly. This function is provided
  // for API compatibility.
  // Since we don't have the original text here, we return an empty string.
  // The real formatting happens via formatDocument/formatBatch.
  return '';
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Expand a selection to the nearest complete statement boundaries.
 * Looks for semicolons, GO separators, or start/end of text.
 */
function expandToStatementBoundaries(
  text: string,
  startOffset: number,
  endOffset: number
): { startOffset: number; endOffset: number } | null {
  // Expand start backwards to beginning of statement
  let start = startOffset;
  while (start > 0) {
    const ch = text[start - 1];
    if (ch === ';') break;
    // Check for GO on its own line
    const lineStart = text.lastIndexOf('\n', start - 1);
    const lineText = text.substring(lineStart + 1, start);
    if (/^\s*GO\s*$/i.test(lineText)) {
      start = lineStart + 1 + lineText.length;
      break;
    }
    start--;
  }

  // Expand end forwards to end of statement
  let end = endOffset;
  while (end < text.length) {
    const ch = text[end];
    if (ch === ';') {
      end++;
      break;
    }
    // Check for GO on its own line
    const lineEnd = text.indexOf('\n', end);
    const lineText = lineEnd >= 0 ? text.substring(end, lineEnd) : text.substring(end);
    if (/^\s*GO\s*$/i.test(lineText)) {
      break;
    }
    end++;
  }

  // Trim leading/trailing whitespace from the expanded range
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;

  if (start >= end) return null;
  return { startOffset: start, endOffset: end };
}

/**
 * Convert byte offsets to a SourceRange (line/column positions).
 */
function offsetsToRange(text: string, startOffset: number, endOffset: number): SourceRange {
  let line = 0;
  let col = 0;
  let startPos: SourcePosition = { line: 0, column: 0 };
  let endPos: SourcePosition = { line: 0, column: 0 };

  for (let i = 0; i <= endOffset && i < text.length; i++) {
    if (i === startOffset) {
      startPos = { line, column: col };
    }
    if (i === endOffset) {
      endPos = { line, column: col };
      break;
    }
    if (text[i] === '\n') {
      line++;
      col = 0;
    } else {
      col++;
    }
  }

  if (endOffset >= text.length) {
    endPos = { line, column: col };
  }

  return { start: startPos, end: endPos };
}
