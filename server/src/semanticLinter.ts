/**
 * Semantic T-SQL Linter — Detects common errors and warnings beyond syntax.
 * 
 * These rules catch mistakes that the recursive-descent parser won't flag because
 * they're structurally valid T-SQL but semantically wrong or dangerous.
 * 
 * Rules:
 *  E001 - UPDATE/DELETE without WHERE clause (warning)
 *  E002 - SELECT * with GROUP BY (error)
 *  E003 - HAVING without GROUP BY (error)
 *  E004 - ORDER BY in subquery without TOP/OFFSET (error)
 *  E005 - Mismatched parentheses (error)
 *  E006 - Unclosed string literal (error)
 *  E007 - INSERT column/value count mismatch (error)
 *  E008 - Duplicate column alias in SELECT (warning)
 *  E009 - UNION/EXCEPT/INTERSECT column count mismatch (warning)
 *  E010 - Mismatched BEGIN/END (error)
 *  E011 - INSERT without column list (warning - fragile)
 *  E012 - TOP without ORDER BY (warning)
 *  E013 - Comparison with NULL using = or <> instead of IS (warning)
 */

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';

/**
 * Represents a range in the source document (0-based lines/columns).
 */
interface LintRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

/**
 * A single lint rule result.
 */
interface LintResult {
  code: string;
  message: string;
  severity: DiagnosticSeverity;
  range: LintRange;
}

/**
 * Run all semantic lint rules against a single batch of T-SQL text.
 * The batchStartLine offset adjusts ranges for multi-batch documents.
 */
export function semanticLint(text: string, batchStartLine: number = 0): Diagnostic[] {
  const results: LintResult[] = [];

  results.push(...checkMissingWhere(text));
  results.push(...checkSelectStarWithGroupBy(text));
  results.push(...checkHavingWithoutGroupBy(text));
  results.push(...checkOrderByInSubquery(text));
  results.push(...checkMismatchedParentheses(text));
  results.push(...checkUnclosedStrings(text));
  results.push(...checkInsertColumnValueMismatch(text));
  results.push(...checkDuplicateAliases(text));
  results.push(...checkMismatchedBeginEnd(text));
  results.push(...checkTopWithoutOrderBy(text));
  results.push(...checkNullComparison(text));

  return results.map(r => ({
    severity: r.severity,
    range: {
      start: { line: r.range.startLine + batchStartLine, character: r.range.startCol },
      end: { line: r.range.endLine + batchStartLine, character: r.range.endCol },
    },
    message: r.message,
    source: 'tsql-lint',
    code: r.code,
  }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Remove string literals and comments from text for analysis, preserving positions */
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
    // N-prefixed string
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
    // String literal
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

/** Get line and column from a character offset in text */
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

/** Find all top-level statement matches (not inside subqueries) using a regex-on-stripped-text approach */
function findTopLevelStatements(stripped: string, pattern: RegExp): RegExpExecArray[] {
  const results: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  while ((match = re.exec(stripped)) !== null) {
    // Check if we're inside parentheses (subquery)
    const depth = getParenDepthAt(stripped, match.index);
    if (depth === 0) {
      results.push(match);
    }
  }
  return results;
}

/** Get parenthesis nesting depth at a position in stripped text */
function getParenDepthAt(text: string, offset: number): number {
  let depth = 0;
  for (let i = 0; i < offset; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')') depth--;
  }
  return depth;
}

// ─── E001: UPDATE/DELETE without WHERE ────────────────────────────────────────

function checkMissingWhere(text: string): LintResult[] {
  const results: LintResult[] = [];
  const stripped = stripStringsAndComments(text);

  // Match UPDATE ... SET ... (no WHERE before next statement or end)
  const updatePattern = /\bUPDATE\b/gi;
  let match: RegExpExecArray | null;
  while ((match = updatePattern.exec(stripped)) !== null) {
    if (getParenDepthAt(stripped, match.index) !== 0) continue;

    const afterUpdate = stripped.substring(match.index);
    // Find SET keyword
    const setMatch = /\bSET\b/i.exec(afterUpdate);
    if (!setMatch) continue;

    // Find the end of this statement (next top-level statement keyword or end)
    const stmtEnd = findStatementEnd(stripped, match.index);
    const stmtText = stripped.substring(match.index, stmtEnd);

    // Check if WHERE exists in this statement (at same or lower paren depth)
    if (!hasWhereClause(stmtText)) {
      const pos = getPosition(text, match.index);
      results.push({
        code: 'E001',
        message: 'UPDATE without WHERE clause will affect all rows in the table.',
        severity: DiagnosticSeverity.Warning,
        range: {
          startLine: pos.line,
          startCol: pos.col,
          endLine: pos.line,
          endCol: pos.col + 6,
        },
      });
    }
  }

  // Match DELETE ... (no WHERE before next statement or end)
  const deletePattern = /\bDELETE\b/gi;
  while ((match = deletePattern.exec(stripped)) !== null) {
    if (getParenDepthAt(stripped, match.index) !== 0) continue;

    const stmtEnd = findStatementEnd(stripped, match.index + 6);
    const stmtText = stripped.substring(match.index, stmtEnd);

    // Skip if it's a DELETE inside MERGE (WHEN MATCHED THEN DELETE)
    const beforeDelete = stripped.substring(Math.max(0, match.index - 50), match.index);
    if (/\bTHEN\s*$/i.test(beforeDelete)) continue;

    if (!hasWhereClause(stmtText)) {
      const pos = getPosition(text, match.index);
      results.push({
        code: 'E001',
        message: 'DELETE without WHERE clause will remove all rows from the table.',
        severity: DiagnosticSeverity.Warning,
        range: {
          startLine: pos.line,
          startCol: pos.col,
          endLine: pos.line,
          endCol: pos.col + 6,
        },
      });
    }
  }

  return results;
}

function hasWhereClause(stmtText: string): boolean {
  // Find WHERE that's not inside parentheses within this statement
  let depth = 0;
  const whereRe = /\bWHERE\b/gi;
  let m: RegExpExecArray | null;
  while ((m = whereRe.exec(stmtText)) !== null) {
    depth = 0;
    for (let i = 0; i < m.index; i++) {
      if (stmtText[i] === '(') depth++;
      if (stmtText[i] === ')') depth--;
    }
    if (depth === 0) return true;
  }
  return false;
}

function findStatementEnd(stripped: string, startAfter: number): number {
  const stmtKeywords = /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|EXEC|EXECUTE|DECLARE|IF|WHILE|BEGIN|MERGE|WITH|RETURN|PRINT|RAISERROR|THROW|USE|GRANT|REVOKE|DENY)\b/gi;
  stmtKeywords.lastIndex = startAfter;
  let match: RegExpExecArray | null;
  while ((match = stmtKeywords.exec(stripped)) !== null) {
    if (match.index <= startAfter) continue;
    if (getParenDepthAt(stripped, match.index) === 0) {
      return match.index;
    }
  }
  return stripped.length;
}

// ─── E002: SELECT * with GROUP BY ────────────────────────────────────────────

function checkSelectStarWithGroupBy(text: string): LintResult[] {
  const results: LintResult[] = [];
  const stripped = stripStringsAndComments(text);

  const selectPattern = /\bSELECT\b/gi;
  let match: RegExpExecArray | null;
  while ((match = selectPattern.exec(stripped)) !== null) {
    if (getParenDepthAt(stripped, match.index) !== 0) continue;

    const stmtEnd = findStatementEnd(stripped, match.index + 6);
    const stmtText = stripped.substring(match.index, stmtEnd);

    // Check if SELECT uses * (not table.*)
    const selectToFrom = stmtText.match(/^SELECT\s+(?:DISTINCT\s+|TOP\s+\(?\d+\)?\s+)?(.*?)(?:\bFROM\b|$)/is);
    if (!selectToFrom) continue;

    const columnList = selectToFrom[1].trim();
    // Check for bare * (not alias.* or table.* or inside function parens like COUNT(*))
    if (!hasBareStarInColumnList(columnList)) continue;

    // Check if there's a GROUP BY in this statement
    if (/\bGROUP\s+BY\b/i.test(stmtText)) {
      const pos = getPosition(text, match.index);
      results.push({
        code: 'E002',
        message: 'SELECT * is not valid with GROUP BY. Specify explicit columns.',
        severity: DiagnosticSeverity.Error,
        range: {
          startLine: pos.line,
          startCol: pos.col,
          endLine: pos.line,
          endCol: pos.col + 6,
        },
      });
    }
  }

  return results;
}

/**
 * Checks if a column list contains a bare * (SELECT *) as opposed to:
 * - table.* (qualified star)
 * - COUNT(*), SUM(*), etc. (star inside function parentheses)
 * - Price * Quantity (multiplication operator between identifiers)
 *
 * Walks the column list tracking parenthesis depth; a bare * is one that:
 * 1. Is at paren depth 0 (not inside a function call)
 * 2. Is not preceded by a dot (not table-qualified)
 * 3. Is not a multiplication operator (not between two identifiers/numbers)
 *
 * A standalone * appears either:
 * - At the very start of the column list (after optional whitespace)
 * - After a comma (as a separate column expression)
 */
function hasBareStarInColumnList(columnList: string): boolean {
  // Split into top-level column expressions (respecting parentheses)
  const columns = splitColumnsAtTopLevel(columnList);

  for (const col of columns) {
    const trimmed = col.trim();
    // A bare * is exactly "*" as the entire column expression
    if (trimmed === '*') {
      return true;
    }
  }
  return false;
}

/**
 * Splits a column list by commas at parenthesis depth 0.
 */
function splitColumnsAtTopLevel(columnList: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < columnList.length; i++) {
    const ch = columnList[i];
    if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) {
    parts.push(current);
  }
  return parts;
}

// ─── E003: HAVING without GROUP BY ───────────────────────────────────────────

function checkHavingWithoutGroupBy(text: string): LintResult[] {
  const results: LintResult[] = [];
  const stripped = stripStringsAndComments(text);

  const selectPattern = /\bSELECT\b/gi;
  let match: RegExpExecArray | null;
  while ((match = selectPattern.exec(stripped)) !== null) {
    if (getParenDepthAt(stripped, match.index) !== 0) continue;

    const stmtEnd = findStatementEnd(stripped, match.index + 6);
    const stmtText = stripped.substring(match.index, stmtEnd);

    // Find HAVING at top level within this statement
    const havingMatch = /\bHAVING\b/gi;
    let h: RegExpExecArray | null;
    while ((h = havingMatch.exec(stmtText)) !== null) {
      // Check paren depth relative to statement start
      let depth = 0;
      for (let i = 0; i < h.index; i++) {
        if (stmtText[i] === '(') depth++;
        if (stmtText[i] === ')') depth--;
      }
      if (depth !== 0) continue;

      // Check if GROUP BY exists at top level
      let hasGroupBy = false;
      const gbMatch = /\bGROUP\s+BY\b/gi;
      let gb: RegExpExecArray | null;
      while ((gb = gbMatch.exec(stmtText)) !== null) {
        let d = 0;
        for (let i = 0; i < gb.index; i++) {
          if (stmtText[i] === '(') d++;
          if (stmtText[i] === ')') d--;
        }
        if (d === 0) { hasGroupBy = true; break; }
      }

      if (!hasGroupBy) {
        const absOffset = match.index + h.index;
        const pos = getPosition(text, absOffset);
        results.push({
          code: 'E003',
          message: 'HAVING clause without GROUP BY. Use WHERE to filter rows or add GROUP BY.',
          severity: DiagnosticSeverity.Error,
          range: {
            startLine: pos.line,
            startCol: pos.col,
            endLine: pos.line,
            endCol: pos.col + 6,
          },
        });
      }
    }
  }

  return results;
}

// ─── E004: ORDER BY in subquery without TOP/OFFSET ───────────────────────────

function checkOrderByInSubquery(text: string): LintResult[] {
  const results: LintResult[] = [];
  const stripped = stripStringsAndComments(text);

  const orderByPattern = /\bORDER\s+BY\b/gi;
  let match: RegExpExecArray | null;
  while ((match = orderByPattern.exec(stripped)) !== null) {
    const depth = getParenDepthAt(stripped, match.index);
    if (depth === 0) continue; // Top-level ORDER BY is fine

    // Check if this ORDER BY is inside an OVER() clause — that's valid (window functions)
    if (isInsideOverClause(stripped, match.index)) continue;

    // We're inside parentheses — check if this SELECT has TOP or OFFSET
    // Find the enclosing SELECT at the same paren depth
    const selectIdx = findEnclosingSelect(stripped, match.index);
    if (selectIdx === -1) continue;

    // Check the SELECT context (from SELECT to ORDER BY)
    const selectToOrderBy = stripped.substring(selectIdx, match.index);

    // If it has TOP or OFFSET...FETCH, it's valid
    if (/\bTOP\b/i.test(selectToOrderBy)) continue;
    if (/\bOFFSET\b/i.test(selectToOrderBy)) continue;

    // Also check after ORDER BY for OFFSET (OFFSET comes after ORDER BY)
    const afterOrderBy = stripped.substring(match.index, match.index + 200);
    if (/\bOFFSET\b/i.test(afterOrderBy.split(/\b(?:SELECT|INSERT|UPDATE|DELETE|FROM)\b/i)[0] || '')) continue;

    const pos = getPosition(text, match.index);
    results.push({
      code: 'E004',
      message: 'ORDER BY in a subquery is not allowed without TOP or OFFSET...FETCH.',
      severity: DiagnosticSeverity.Error,
      range: {
        startLine: pos.line,
        startCol: pos.col,
        endLine: pos.line,
        endCol: pos.col + 8,
      },
    });
  }

  return results;
}

/**
 * Check if an ORDER BY at the given offset is inside an OVER() clause.
 * Scans backward from the ORDER BY to find the opening '(' and checks if
 * it's preceded by the OVER keyword.
 */
function isInsideOverClause(text: string, orderByOffset: number): boolean {
  // Find the innermost opening paren that contains this ORDER BY
  let depth = 0;
  for (let i = orderByOffset - 1; i >= 0; i--) {
    if (text[i] === ')') {
      depth++;
    } else if (text[i] === '(') {
      if (depth === 0) {
        // This is the opening paren that directly contains our ORDER BY
        // Check if it's preceded by OVER (possibly with whitespace)
        const before = text.substring(Math.max(0, i - 10), i).trimEnd();
        if (/\bOVER$/i.test(before)) {
          return true;
        }
        return false;
      }
      depth--;
    }
  }
  return false;
}

/**
 * Find the enclosing SELECT statement for an ORDER BY at the given offset.
 * Searches backward for a SELECT keyword that's at the same paren depth.
 */
function findEnclosingSelect(text: string, orderByOffset: number): number {
  const targetDepth = getParenDepthAt(text, orderByOffset);
  const selectPattern = /\bSELECT\b/gi;
  let lastMatch = -1;
  let m: RegExpExecArray | null;
  while ((m = selectPattern.exec(text)) !== null) {
    if (m.index >= orderByOffset) break;
    if (getParenDepthAt(text, m.index) === targetDepth) {
      lastMatch = m.index;
    }
  }
  return lastMatch;
}

// ─── E005: Mismatched parentheses ────────────────────────────────────────────

function checkMismatchedParentheses(text: string): LintResult[] {
  const results: LintResult[] = [];
  const stripped = stripStringsAndComments(text);

  const openStack: number[] = [];
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === '(') {
      openStack.push(i);
    } else if (stripped[i] === ')') {
      if (openStack.length === 0) {
        const pos = getPosition(text, i);
        results.push({
          code: 'E005',
          message: "Unexpected ')' — no matching opening parenthesis.",
          severity: DiagnosticSeverity.Error,
          range: {
            startLine: pos.line,
            startCol: pos.col,
            endLine: pos.line,
            endCol: pos.col + 1,
          },
        });
      } else {
        openStack.pop();
      }
    }
  }

  // Unclosed opening parentheses
  for (const offset of openStack) {
    const pos = getPosition(text, offset);
    results.push({
      code: 'E005',
      message: "Unclosed '(' — missing closing parenthesis.",
      severity: DiagnosticSeverity.Error,
      range: {
        startLine: pos.line,
        startCol: pos.col,
        endLine: pos.line,
        endCol: pos.col + 1,
      },
    });
  }

  return results;
}

// ─── E006: Unclosed string literal ───────────────────────────────────────────

function checkUnclosedStrings(text: string): LintResult[] {
  const results: LintResult[] = [];
  let i = 0;

  while (i < text.length) {
    // Skip line comments
    if (text[i] === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    // Skip block comments
    if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length) {
        if (text[i] === '*' && text[i + 1] === '/') { i += 2; break; }
        i++;
      }
      continue;
    }
    // N-string prefix
    if ((text[i] === 'N' || text[i] === 'n') && text[i + 1] === "'") {
      i++; // skip N, fall through to string check
    }
    // String literal
    if (text[i] === "'") {
      const startOffset = i;
      i++; // skip opening quote
      let closed = false;
      while (i < text.length) {
        if (text[i] === "'") {
          i++;
          if (i < text.length && text[i] === "'") {
            i++; // escaped quote, continue
          } else {
            closed = true;
            break;
          }
        } else {
          i++;
        }
      }
      if (!closed) {
        const pos = getPosition(text, startOffset);
        results.push({
          code: 'E006',
          message: 'Unclosed string literal — missing closing quote.',
          severity: DiagnosticSeverity.Error,
          range: {
            startLine: pos.line,
            startCol: pos.col,
            endLine: pos.line,
            endCol: pos.col + 1,
          },
        });
      }
      continue;
    }
    i++;
  }

  return results;
}

// ─── E007: INSERT column/value count mismatch ────────────────────────────────

function checkInsertColumnValueMismatch(text: string): LintResult[] {
  const results: LintResult[] = [];
  const stripped = stripStringsAndComments(text);

  // Pattern: INSERT [INTO] table (col1, col2, ...) VALUES (val1, val2, ...)
  const insertPattern = /\bINSERT\s+(?:INTO\s+)?[\w.\[\]"]+\s*\(([^)]*)\)\s*(?:OUTPUT\s+[^)]*?\s+)?VALUES\s*\(([^)]*)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = insertPattern.exec(stripped)) !== null) {
    if (getParenDepthAt(stripped, match.index) !== 0) continue;

    const cols = countCommaItems(match[1]);
    const vals = countCommaItems(match[2]);

    if (cols > 0 && vals > 0 && cols !== vals) {
      const pos = getPosition(text, match.index);
      results.push({
        code: 'E007',
        message: `INSERT column count (${cols}) does not match VALUES count (${vals}).`,
        severity: DiagnosticSeverity.Error,
        range: {
          startLine: pos.line,
          startCol: pos.col,
          endLine: pos.line,
          endCol: pos.col + 6,
        },
      });
    }
  }

  return results;
}

function countCommaItems(text: string): number {
  if (!text.trim()) return 0;
  // Count items separated by commas, respecting nested parentheses
  let count = 1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')') depth--;
    if (text[i] === ',' && depth === 0) count++;
  }
  return count;
}

// ─── E008: Duplicate column alias ────────────────────────────────────────────

function checkDuplicateAliases(text: string): LintResult[] {
  const results: LintResult[] = [];
  const stripped = stripStringsAndComments(text);

  const selectPattern = /\bSELECT\b/gi;
  let match: RegExpExecArray | null;
  while ((match = selectPattern.exec(stripped)) !== null) {
    if (getParenDepthAt(stripped, match.index) !== 0) continue;

    // Extract column list (from SELECT to FROM/WHERE/GROUP/ORDER/UNION or end)
    const afterSelect = stripped.substring(match.index + 6);
    const clauseEnd = afterSelect.search(/\b(?:FROM|WHERE|GROUP|HAVING|ORDER|UNION|EXCEPT|INTERSECT|INTO)\b/i);
    const columnListText = clauseEnd >= 0 ? afterSelect.substring(0, clauseEnd) : afterSelect;

    // Split by commas at depth 0
    const columns = splitAtTopLevelCommas(columnListText);
    const aliases = new Map<string, number[]>();

    for (let i = 0; i < columns.length; i++) {
      const col = columns[i].trim();
      // Look for AS alias or trailing identifier alias
      const asMatch = col.match(/\bAS\s+([\w\[\]"]+)\s*$/i);
      if (asMatch) {
        const alias = normalizeIdentifier(asMatch[1]);
        if (!aliases.has(alias)) aliases.set(alias, []);
        aliases.get(alias)!.push(i);
      }
    }

    for (const [alias, indices] of aliases) {
      if (indices.length > 1) {
        const pos = getPosition(text, match.index);
        results.push({
          code: 'E008',
          message: `Duplicate column alias '${alias}' in SELECT list.`,
          severity: DiagnosticSeverity.Warning,
          range: {
            startLine: pos.line,
            startCol: pos.col,
            endLine: pos.line,
            endCol: pos.col + 6,
          },
        });
      }
    }
  }

  return results;
}

function splitAtTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')') depth--;
    if (text[i] === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += text[i];
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function normalizeIdentifier(id: string): string {
  // Remove brackets and quotes, lowercase
  return id.replace(/^\[|\]$/g, '').replace(/^"|"$/g, '').toLowerCase();
}

// ─── E010: Mismatched BEGIN/END ──────────────────────────────────────────────

function checkMismatchedBeginEnd(text: string): LintResult[] {
  const results: LintResult[] = [];
  const stripped = stripStringsAndComments(text);

  const beginStack: number[] = [];
  let caseDepth = 0; // Track CASE...END nesting (these don't require BEGIN)

  // Find BEGIN, END, and CASE keywords
  const tokenPattern = /\b(BEGIN|END|CASE)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(stripped)) !== null) {
    const kw = match[1].toUpperCase();
    const afterKw = stripped.substring(match.index + match[0].length).trimStart();

    if (kw === 'CASE') {
      // CASE starts a CASE...END block (not a BEGIN...END block)
      caseDepth++;
    } else if (kw === 'BEGIN') {
      // Skip BEGIN TRANSACTION / BEGIN TRAN
      if (/^(?:TRANSACTION|TRAN)\b/i.test(afterKw)) continue;
      beginStack.push(match.index);
    } else {
      // END — first check if it's closing a CASE expression
      if (caseDepth > 0) {
        caseDepth--;
        continue;
      }

      // END TRY or END CATCH still pops a BEGIN
      if (beginStack.length === 0) {
        const pos = getPosition(text, match.index);
        results.push({
          code: 'E010',
          message: "Unexpected 'END' — no matching BEGIN block.",
          severity: DiagnosticSeverity.Error,
          range: {
            startLine: pos.line,
            startCol: pos.col,
            endLine: pos.line,
            endCol: pos.col + 3,
          },
        });
      } else {
        beginStack.pop();
      }
    }
  }

  // Any remaining unclosed BEGINs
  for (const offset of beginStack) {
    const pos = getPosition(text, offset);
    results.push({
      code: 'E010',
      message: "Unclosed BEGIN block — missing END.",
      severity: DiagnosticSeverity.Error,
      range: {
        startLine: pos.line,
        startCol: pos.col,
        endLine: pos.line,
        endCol: pos.col + 5,
      },
    });
  }

  return results;
}

// ─── E012: TOP without ORDER BY ──────────────────────────────────────────────

function checkTopWithoutOrderBy(text: string): LintResult[] {
  const results: LintResult[] = [];
  const stripped = stripStringsAndComments(text);

  // Find SELECT TOP at top-level
  const topPattern = /\bSELECT\s+(?:DISTINCT\s+)?TOP\b/gi;
  let match: RegExpExecArray | null;
  while ((match = topPattern.exec(stripped)) !== null) {
    if (getParenDepthAt(stripped, match.index) !== 0) continue;

    const stmtEnd = findStatementEnd(stripped, match.index + match[0].length);
    const stmtText = stripped.substring(match.index, stmtEnd);

    // Check for ORDER BY at top level of this statement
    let hasOrderBy = false;
    const obMatch = /\bORDER\s+BY\b/gi;
    let ob: RegExpExecArray | null;
    while ((ob = obMatch.exec(stmtText)) !== null) {
      let d = 0;
      for (let i = 0; i < ob.index; i++) {
        if (stmtText[i] === '(') d++;
        if (stmtText[i] === ')') d--;
      }
      if (d === 0) { hasOrderBy = true; break; }
    }

    if (!hasOrderBy) {
      // Find the TOP keyword offset for the warning position
      const topIdx = stripped.indexOf('TOP', match.index);
      const pos = getPosition(text, topIdx >= 0 ? topIdx : match.index);
      results.push({
        code: 'E012',
        message: 'TOP without ORDER BY returns arbitrary rows. Add ORDER BY for deterministic results.',
        severity: DiagnosticSeverity.Warning,
        range: {
          startLine: pos.line,
          startCol: pos.col,
          endLine: pos.line,
          endCol: pos.col + 3,
        },
      });
    }
  }

  return results;
}

// ─── E013: NULL comparison with = or <> ──────────────────────────────────────

function checkNullComparison(text: string): LintResult[] {
  const results: LintResult[] = [];
  const stripped = stripStringsAndComments(text);

  // Match = NULL or <> NULL or != NULL
  const nullCompPattern = /(?:=|<>|!=)\s*NULL\b/gi;
  let match: RegExpExecArray | null;
  while ((match = nullCompPattern.exec(stripped)) !== null) {
    const pos = getPosition(text, match.index);
    results.push({
      code: 'E013',
      message: "Use 'IS NULL' or 'IS NOT NULL' instead of '= NULL' or '<> NULL'. Comparison operators with NULL always return UNKNOWN.",
      severity: DiagnosticSeverity.Warning,
      range: {
        startLine: pos.line,
        startCol: pos.col,
        endLine: pos.line,
        endCol: pos.col + match[0].length,
      },
    });
  }

  // Also check NULL = something and NULL <> something  
  const nullLeadPattern = /\bNULL\s*(?:=|<>|!=)/gi;
  while ((match = nullLeadPattern.exec(stripped)) !== null) {
    const pos = getPosition(text, match.index);
    results.push({
      code: 'E013',
      message: "Use 'IS NULL' or 'IS NOT NULL' instead of comparing with NULL. Comparison operators with NULL always return UNKNOWN.",
      severity: DiagnosticSeverity.Warning,
      range: {
        startLine: pos.line,
        startCol: pos.col,
        endLine: pos.line,
        endCol: pos.col + match[0].length,
      },
    });
  }

  return results;
}
