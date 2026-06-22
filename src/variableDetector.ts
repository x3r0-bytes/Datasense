/**
 * Variable Detector — Scans T-SQL query text for undeclared @variable references.
 *
 * Pure functions: no side effects, deterministic output for identical input.
 * Runs in the extension host as a pre-execution hook before QueryExecutor.execute().
 */

import { ISchemaCache } from './types';
import { splitBatches } from './batchSplitter';

/** Maximum number of undeclared variables to report */
const MAX_UNDECLARED_VARIABLES = 20;

export interface UndeclaredVariable {
  /** Variable name without @ prefix */
  name: string;
  /** Full variable reference as it appears in the query (e.g., "@UserID") */
  reference: string;
  /** Inferred SQL Server data type (e.g., "INT", "NVARCHAR(MAX)") */
  inferredType: string;
  /** 0-based character offset of first occurrence in the batch */
  firstOffset: number;
}

export interface VariableDetectionResult {
  /** List of undeclared variables in first-occurrence order */
  undeclaredVariables: UndeclaredVariable[];
  /** The batch index (0-based) where each variable was found */
  batchIndex: number;
}

/**
 * Represents a region of text classified by its syntactic role.
 */
interface TextRegion {
  start: number;
  end: number;
  type: 'code' | 'line-comment' | 'block-comment' | 'string';
}

/**
 * Scans a single GO-separated batch for undeclared @variable references.
 * Pure function: no side effects, deterministic output for identical input.
 *
 * @param batchText - The SQL text of a single batch (no GO separators)
 * @param schemaCache - Optional schema cache for type inference (unused in this task; defaults to NVARCHAR(MAX))
 * @returns Array of undeclared variable descriptors
 */
export function detectUndeclaredVariables(
  batchText: string,
  schemaCache?: ISchemaCache
): UndeclaredVariable[] {
  if (!batchText || batchText.trim().length === 0) {
    return [];
  }

  // Step 1: Classify text into code vs comment vs string regions
  const regions = classifyRegions(batchText);

  // Step 2: Find all @variable references in code regions
  const references = findVariableReferences(batchText, regions);

  // Step 3: Find all DECLARE and SET declarations in code regions
  const declared = findDeclaredVariables(batchText, regions);

  // Step 4: Find EXEC parameter targets in code regions
  const execParams = findExecParameterTargets(batchText, regions);

  // Step 5: Compute set difference (referenced - declared - execParams), case-insensitive
  const undeclared: UndeclaredVariable[] = [];
  const seen = new Set<string>();

  for (const ref of references) {
    const normalizedName = ref.name.toLowerCase();

    // Skip system variables (@@)
    if (ref.isSystem) {
      continue;
    }

    // Skip declared variables
    if (declared.has(normalizedName)) {
      continue;
    }

    // Skip EXEC parameter targets
    if (execParams.has(normalizedName)) {
      continue;
    }

    // Skip duplicates (case-insensitive)
    if (seen.has(normalizedName)) {
      continue;
    }

    seen.add(normalizedName);
    undeclared.push({
      name: ref.name,
      reference: ref.reference,
      inferredType: schemaCache
        ? inferVariableType(ref.reference, batchText, regions, schemaCache)
        : 'NVARCHAR(MAX)',
      firstOffset: ref.offset,
    });

    // Cap at maximum
    if (undeclared.length >= MAX_UNDECLARED_VARIABLES) {
      break;
    }
  }

  return undeclared;
}

/**
 * Scans full query text (potentially multi-batch) for undeclared variables.
 * Splits on GO separators, analyzes each batch independently.
 */
export function detectAllUndeclaredVariables(
  queryText: string,
  schemaCache?: ISchemaCache
): VariableDetectionResult[] {
  if (!queryText || queryText.trim().length === 0) {
    return [];
  }

  const batches = splitBatches(queryText);
  const results: VariableDetectionResult[] = [];

  for (let i = 0; i < batches.length; i++) {
    const undeclared = detectUndeclaredVariables(batches[i], schemaCache);
    if (undeclared.length > 0) {
      results.push({
        undeclaredVariables: undeclared,
        batchIndex: i,
      });
    }
  }

  return results;
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Classifies the batch text into code, comment, and string regions.
 * This allows downstream functions to only process code regions.
 */
function classifyRegions(text: string): TextRegion[] {
  const regions: TextRegion[] = [];
  let i = 0;
  let codeStart = 0;

  while (i < text.length) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';

    // Single-line comment: -- to end of line
    if (ch === '-' && next === '-') {
      // Close current code region
      if (i > codeStart) {
        regions.push({ start: codeStart, end: i, type: 'code' });
      }
      const commentStart = i;
      // Find end of line
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      regions.push({ start: commentStart, end: i, type: 'line-comment' });
      codeStart = i;
      continue;
    }

    // Block comment: /* ... */
    if (ch === '/' && next === '*') {
      // Close current code region
      if (i > codeStart) {
        regions.push({ start: codeStart, end: i, type: 'code' });
      }
      const commentStart = i;
      i += 2; // skip /*
      while (i < text.length) {
        if (text[i] === '*' && i + 1 < text.length && text[i + 1] === '/') {
          i += 2; // skip */
          break;
        }
        i++;
      }
      regions.push({ start: commentStart, end: i, type: 'block-comment' });
      codeStart = i;
      continue;
    }

    // String literal: '...'
    if (ch === "'") {
      // Close current code region
      if (i > codeStart) {
        regions.push({ start: codeStart, end: i, type: 'code' });
      }
      const stringStart = i;
      i++; // skip opening quote
      while (i < text.length) {
        if (text[i] === "'") {
          // Check for escaped quote ''
          if (i + 1 < text.length && text[i + 1] === "'") {
            i += 2; // skip ''
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          i++;
        }
      }
      regions.push({ start: stringStart, end: i, type: 'string' });
      codeStart = i;
      continue;
    }

    i++;
  }

  // Close final code region
  if (codeStart < text.length) {
    regions.push({ start: codeStart, end: text.length, type: 'code' });
  }

  return regions;
}

/**
 * Represents a variable reference found in code.
 */
interface VariableRef {
  name: string;       // Name without @ prefix (unquoted if bracket-quoted)
  reference: string;  // Full reference as it appears (e.g., "@UserID", "@[My Var]")
  offset: number;     // 0-based character offset in the batch
  isSystem: boolean;  // true if @@ prefix
}

/**
 * Finds all @variable references within code regions.
 * Handles both standard (@Name) and bracket-quoted (@[Name]) forms.
 * Identifies @@ system variables.
 */
function findVariableReferences(text: string, regions: TextRegion[]): VariableRef[] {
  const refs: VariableRef[] = [];

  for (const region of regions) {
    if (region.type !== 'code') {
      continue;
    }

    const segment = text.substring(region.start, region.end);
    // Match @variable patterns: @ followed by word chars, or @[...], or @@...
    const varPattern = /@(@?)(\[([^\]]*)\]|[a-zA-Z_]\w*)/g;
    let match: RegExpExecArray | null;

    while ((match = varPattern.exec(segment)) !== null) {
      const fullMatch = match[0];
      const isSystem = match[1] === '@';
      const bracketContent = match[3]; // Content inside [...] if bracket-quoted
      const name = bracketContent !== undefined ? bracketContent : match[2];
      const offset = region.start + match.index;

      refs.push({
        name,
        reference: fullMatch,
        offset,
        isSystem,
      });
    }
  }

  return refs;
}

/**
 * Finds all declared variable names via DECLARE and SET @name = statements.
 * Returns a set of lowercase variable names (without @ prefix).
 */
function findDeclaredVariables(text: string, regions: TextRegion[]): Set<string> {
  const declared = new Set<string>();

  for (const region of regions) {
    if (region.type !== 'code') {
      continue;
    }

    const segment = text.substring(region.start, region.end);

    // Match DECLARE statements:
    // DECLARE @name type [= value] [, @name2 type2 [= value2]]...
    // DECLARE @name TABLE(...)
    // Also handles bracket-quoted: DECLARE @[My Var] type
    const declarePattern = /\bDECLARE\b/gi;
    let declMatch: RegExpExecArray | null;

    while ((declMatch = declarePattern.exec(segment)) !== null) {
      // After DECLARE, find all @variable names in the declaration list
      const afterDeclare = segment.substring(declMatch.index + declMatch[0].length);
      extractDeclareVariables(afterDeclare, declared);
    }

    // Match SET @name = ... assignments
    const setPattern = /\bSET\s+@(\[([^\]]*)\]|[a-zA-Z_]\w*)\s*=/gi;
    let setMatch: RegExpExecArray | null;

    while ((setMatch = setPattern.exec(segment)) !== null) {
      const bracketContent = setMatch[2];
      const name = bracketContent !== undefined ? bracketContent : setMatch[1];
      declared.add(name.toLowerCase());
    }
  }

  return declared;
}

/**
 * Extracts variable names from the text following a DECLARE keyword.
 * Handles multi-variable declarations and TABLE declarations.
 */
function extractDeclareVariables(afterDeclare: string, declared: Set<string>): void {
  // We need to parse the variable list after DECLARE
  // Pattern: @name type [= value], @name2 type2 [= value2], ...
  // Or: @name TABLE(...)
  // Stop at statement boundary (semicolon, or a keyword that starts a new statement)

  let pos = 0;
  const len = afterDeclare.length;

  while (pos < len) {
    // Skip whitespace
    while (pos < len && /\s/.test(afterDeclare[pos])) {
      pos++;
    }

    if (pos >= len) {
      break;
    }

    // Expect @ to start a variable
    if (afterDeclare[pos] !== '@') {
      break;
    }

    pos++; // skip @

    // Read variable name (may be bracket-quoted)
    let varName: string;
    if (pos < len && afterDeclare[pos] === '[') {
      // Bracket-quoted name
      pos++; // skip [
      const nameStart = pos;
      while (pos < len && afterDeclare[pos] !== ']') {
        pos++;
      }
      varName = afterDeclare.substring(nameStart, pos);
      if (pos < len) {
        pos++; // skip ]
      }
    } else {
      // Standard name
      const nameStart = pos;
      while (pos < len && /[a-zA-Z0-9_]/.test(afterDeclare[pos])) {
        pos++;
      }
      varName = afterDeclare.substring(nameStart, pos);
    }

    if (varName.length === 0) {
      break;
    }

    declared.add(varName.toLowerCase());

    // Skip whitespace
    while (pos < len && /\s/.test(afterDeclare[pos])) {
      pos++;
    }

    // Now we need to skip the type and optional = value, until we hit a comma or end
    // Handle TABLE(...) specially — skip the parenthesized definition
    const remainingUpper = afterDeclare.substring(pos).toUpperCase();
    if (remainingUpper.startsWith('TABLE')) {
      pos += 5; // skip TABLE
      // Skip whitespace
      while (pos < len && /\s/.test(afterDeclare[pos])) {
        pos++;
      }
      // Skip parenthesized table definition (handling nested parens)
      if (pos < len && afterDeclare[pos] === '(') {
        pos = skipParenthesized(afterDeclare, pos);
      }
    } else {
      // Skip type definition and optional = value until comma or end
      pos = skipTypeAndValue(afterDeclare, pos);
    }

    // Skip whitespace
    while (pos < len && /\s/.test(afterDeclare[pos])) {
      pos++;
    }

    // Check for comma (another variable in the list)
    if (pos < len && afterDeclare[pos] === ',') {
      pos++; // skip comma
      continue;
    }

    // Otherwise, we're done with this DECLARE statement
    break;
  }
}

/**
 * Skips a parenthesized expression, handling nested parentheses.
 * Returns the position after the closing parenthesis.
 */
function skipParenthesized(text: string, startPos: number): number {
  let pos = startPos;
  if (text[pos] !== '(') {
    return pos;
  }

  let depth = 0;
  while (pos < text.length) {
    if (text[pos] === '(') {
      depth++;
    } else if (text[pos] === ')') {
      depth--;
      if (depth === 0) {
        pos++;
        break;
      }
    } else if (text[pos] === "'") {
      // Skip string literals inside parens
      pos++;
      while (pos < text.length) {
        if (text[pos] === "'") {
          if (pos + 1 < text.length && text[pos + 1] === "'") {
            pos += 2;
          } else {
            pos++;
            break;
          }
        } else {
          pos++;
        }
      }
      continue;
    }
    pos++;
  }
  return pos;
}

/**
 * Skips a type definition and optional = value in a DECLARE list.
 * Stops before a comma (next variable) or at a statement boundary.
 */
function skipTypeAndValue(text: string, startPos: number): number {
  let pos = startPos;
  const len = text.length;

  // Skip until comma (at paren depth 0) or statement-ending keyword/semicolon
  let parenDepth = 0;

  while (pos < len) {
    const ch = text[pos];

    if (ch === '(') {
      parenDepth++;
    } else if (ch === ')') {
      if (parenDepth > 0) {
        parenDepth--;
      } else {
        break;
      }
    } else if (ch === ',' && parenDepth === 0) {
      // Found the comma separator — don't consume it, let the caller handle it
      break;
    } else if (ch === ';') {
      break;
    } else if (ch === "'") {
      // Skip string literal
      pos++;
      while (pos < len) {
        if (text[pos] === "'") {
          if (pos + 1 < len && text[pos + 1] === "'") {
            pos += 2;
          } else {
            pos++;
            break;
          }
        } else {
          pos++;
        }
      }
      continue;
    }

    // Check for statement-boundary keywords (at word boundary, paren depth 0)
    if (parenDepth === 0 && /[a-zA-Z]/.test(ch)) {
      const word = text.substring(pos).match(/^[a-zA-Z]+/)?.[0]?.toUpperCase();
      if (word && isStatementBoundary(word) && (pos === 0 || /\s/.test(text[pos - 1]))) {
        break;
      }
    }

    pos++;
  }

  return pos;
}

/**
 * Returns true if the word is a T-SQL keyword that indicates a new statement.
 */
function isStatementBoundary(word: string): boolean {
  const boundaries = new Set([
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'EXEC', 'EXECUTE',
    'IF', 'WHILE', 'BEGIN', 'END', 'RETURN', 'PRINT',
    'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'MERGE',
  ]);
  return boundaries.has(word);
}

// ─── Type Inference ──────────────────────────────────────────────────────────

/**
 * Infers the SQL Server data type for a variable based on its usage context.
 * Strategy:
 * 1. Column comparison: @var = Column or Column = @var → use column's type from schema cache
 * 2. IN subquery: @var IN (SELECT Column ...) → use column's type
 * 3. Arithmetic expression: @var in +, -, *, / context → INT
 * 4. Fallback → NVARCHAR(MAX)
 *
 * Best-effort: if parsing is too complex, falls back to NVARCHAR(MAX).
 */
function inferVariableType(
  variableReference: string,
  batchText: string,
  codeRegions: TextRegion[],
  schemaCache: ISchemaCache
): string {
  // Build the code-only text for pattern matching
  const codeText = extractCodeText(batchText, codeRegions);

  // Escape the variable reference for use in regex
  const escapedRef = escapeRegex(variableReference);

  // Strategy 1: Column comparison — @var = Column or Column = @var
  const comparisonType = inferFromComparison(escapedRef, codeText, schemaCache);
  if (comparisonType) {
    return comparisonType;
  }

  // Strategy 2: IN subquery — @var IN (SELECT Column ...)
  const inSubqueryType = inferFromInSubquery(escapedRef, codeText, schemaCache);
  if (inSubqueryType) {
    return inSubqueryType;
  }

  // Strategy 3: Arithmetic expression — @var appears with +, -, *, /
  if (isInArithmeticExpression(escapedRef, codeText)) {
    return 'INT';
  }

  // Fallback
  return 'NVARCHAR(MAX)';
}

/**
 * Extracts only the code portions from the batch text (excluding comments and strings).
 * Preserves original positions by replacing non-code with spaces.
 */
function extractCodeText(batchText: string, codeRegions: TextRegion[]): string {
  // Build a string where non-code regions are replaced with spaces
  // This preserves character positions for pattern matching
  const chars = new Array(batchText.length).fill(' ');
  for (const region of codeRegions) {
    if (region.type === 'code') {
      for (let i = region.start; i < region.end; i++) {
        chars[i] = batchText[i];
      }
    }
  }
  return chars.join('');
}

/**
 * Escapes a string for use in a regular expression.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Infers type from comparison patterns like @var = ColumnName or ColumnName = @var.
 * Also handles operators: =, !=, <>, <, >, <=, >=
 */
function inferFromComparison(
  escapedRef: string,
  codeText: string,
  schemaCache: ISchemaCache
): string | null {
  // Pattern: @var <op> identifier  or  identifier <op> @var
  // Identifiers can be: Column, alias.Column, [Column], alias.[Column]
  const compOps = '(?:=|!=|<>|<=|>=|<|>)';

  // Pattern 1: @var = Column (variable on left side)
  const leftPattern = new RegExp(
    escapedRef + '\\s*' + compOps + '\\s*' +
    '(?:(?:[a-zA-Z_]\\w*|\\[[^\\]]+\\])\\.)?([a-zA-Z_]\\w*|\\[[^\\]]+\\])',
    'gi'
  );

  // Pattern 2: Column = @var (variable on right side)
  const rightPattern = new RegExp(
    '(?:(?:[a-zA-Z_]\\w*|\\[[^\\]]+\\])\\.)?([a-zA-Z_]\\w*|\\[[^\\]]+\\])' +
    '\\s*' + compOps + '\\s*' + escapedRef,
    'gi'
  );

  // Try left pattern
  let match = leftPattern.exec(codeText);
  if (match) {
    const columnName = unquoteBrackets(match[1]);
    const type = lookupColumnType(columnName, schemaCache);
    if (type) {
      return type;
    }
  }

  // Try right pattern
  match = rightPattern.exec(codeText);
  if (match) {
    const columnName = unquoteBrackets(match[1]);
    const type = lookupColumnType(columnName, schemaCache);
    if (type) {
      return type;
    }
  }

  return null;
}

/**
 * Infers type from @var IN (SELECT Column ...) patterns.
 */
function inferFromInSubquery(
  escapedRef: string,
  codeText: string,
  schemaCache: ISchemaCache
): string | null {
  // Pattern: @var IN (SELECT Column ...)
  // We look for: @var <whitespace> IN <whitespace> ( <whitespace> SELECT <whitespace> <column>
  const inPattern = new RegExp(
    escapedRef + '\\s+IN\\s*\\(\\s*SELECT\\s+(?:(?:TOP\\s+\\d+|DISTINCT|ALL)\\s+)?(?:(?:[a-zA-Z_]\\w*|\\[[^\\]]+\\])\\.)?([a-zA-Z_]\\w*|\\[[^\\]]+\\])',
    'gi'
  );

  const match = inPattern.exec(codeText);
  if (match) {
    const columnName = unquoteBrackets(match[1]);
    const type = lookupColumnType(columnName, schemaCache);
    if (type) {
      return type;
    }
  }

  return null;
}

/**
 * Checks if the variable appears in an arithmetic expression (+, -, *, /).
 * Looks for patterns like: @var + ..., ... + @var, @var * ..., etc.
 */
function isInArithmeticExpression(escapedRef: string, codeText: string): boolean {
  // Pattern: @var followed by arithmetic operator, or preceded by arithmetic operator
  const arithmeticOps = '[+\\-*/]';

  // @var <op> (something)
  const afterPattern = new RegExp(escapedRef + '\\s*' + arithmeticOps, 'gi');
  if (afterPattern.test(codeText)) {
    return true;
  }

  // (something) <op> @var
  const beforePattern = new RegExp(arithmeticOps + '\\s*' + escapedRef, 'gi');
  if (beforePattern.test(codeText)) {
    return true;
  }

  return false;
}

/**
 * Removes bracket-quoting from an identifier: [Name] → Name
 */
function unquoteBrackets(identifier: string): string {
  if (identifier.startsWith('[') && identifier.endsWith(']')) {
    return identifier.substring(1, identifier.length - 1);
  }
  return identifier;
}

/**
 * Looks up a column name in the schema cache and returns its data type.
 * Searches across all tables and views. Case-insensitive match.
 * Returns null if not found.
 */
function lookupColumnType(columnName: string, schemaCache: ISchemaCache): string | null {
  const lowerName = columnName.toLowerCase();

  // Search tables
  for (const table of schemaCache.tables) {
    for (const col of table.columns) {
      if (col.name.toLowerCase() === lowerName) {
        return col.dataType;
      }
    }
  }

  // Search views
  for (const view of schemaCache.views) {
    for (const col of view.columns) {
      if (col.name.toLowerCase() === lowerName) {
        return col.dataType;
      }
    }
  }

  return null;
}

/**
 * Finds variables that appear as named parameter targets in EXEC/EXECUTE calls.
 * Pattern: EXEC[UTE] sp_name @param = value or @param OUTPUT
 * Returns a set of lowercase parameter names (without @ prefix).
 */
function findExecParameterTargets(text: string, regions: TextRegion[]): Set<string> {
  const params = new Set<string>();

  for (const region of regions) {
    if (region.type !== 'code') {
      continue;
    }

    const segment = text.substring(region.start, region.end);

    // Find EXEC/EXECUTE calls and extract named parameters
    // Pattern: EXEC[UTE] [schema.]proc_name @param1 = val1, @param2 = val2 [OUTPUT]
    const execPattern = /\b(?:EXEC|EXECUTE)\s+(?:@\w+\s*=\s*)?(?:[\w.\[\]]+)\s+([\s\S]*?)(?=;|\bGO\b|\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bEXEC\b|\bEXECUTE\b|\bIF\b|\bWHILE\b|\bBEGIN\b|\bDECLARE\b|\bSET\b|\bPRINT\b|$)/gi;
    let execMatch: RegExpExecArray | null;

    while ((execMatch = execPattern.exec(segment)) !== null) {
      const paramList = execMatch[1];
      // Find named parameters: @name = value or @name OUTPUT/OUT
      const paramPattern = /@(\[([^\]]*)\]|[a-zA-Z_]\w*)\s*(?:=|(?:OUT(?:PUT)?))/gi;
      let paramMatch: RegExpExecArray | null;

      while ((paramMatch = paramPattern.exec(paramList)) !== null) {
        const bracketContent = paramMatch[2];
        const name = bracketContent !== undefined ? bracketContent : paramMatch[1];
        params.add(name.toLowerCase());
      }
    }
  }

  return params;
}
