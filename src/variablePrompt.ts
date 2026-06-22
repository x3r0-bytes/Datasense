/**
 * Variable Prompt — Displays VS Code input UI for undeclared variables and
 * generates DECLARE statements from user-provided values.
 *
 * Pure function `generateDeclareStatements()` is separated for testability.
 * `promptForVariableValues()` depends on vscode API for UI.
 */

import * as vscode from 'vscode';
import { UndeclaredVariable } from './variableDetector';

/** Maximum number of variables to prompt for */
const MAX_PROMPT_VARIABLES = 20;

/** Numeric SQL Server types that require numeric validation */
const NUMERIC_TYPES = new Set([
  'INT',
  'BIGINT',
  'SMALLINT',
  'TINYINT',
  'DECIMAL',
  'NUMERIC',
  'FLOAT',
  'REAL',
  'MONEY',
  'SMALLMONEY',
]);

/** String types that require single-quote wrapping */
const STRING_TYPES = new Set([
  'VARCHAR',
  'NVARCHAR',
  'CHAR',
  'NCHAR',
  'TEXT',
  'NTEXT',
]);

/** Date/time types that require single-quote wrapping */
const DATE_TYPES = new Set([
  'DATE',
  'DATETIME',
  'DATETIME2',
  'SMALLDATETIME',
  'TIME',
  'DATETIMEOFFSET',
]);

export interface VariableValue {
  name: string;
  type: string;
  value: string | null; // null means user left empty → NULL
}

/**
 * Validates whether a string represents a valid numeric value.
 * Exported for testing.
 */
export function isValidNumericValue(value: string): boolean {
  if (value.trim().length === 0) {
    return false;
  }
  const trimmed = value.trim();
  // Allow optional leading sign, digits, optional decimal point, optional digits
  // Also allow scientific notation (e.g., 1.5e10)
  const num = Number(trimmed);
  return !isNaN(num) && isFinite(num);
}

/**
 * Determines if a SQL type is a numeric type that requires numeric validation.
 * Exported for testing.
 */
export function isNumericType(type: string): boolean {
  // Normalize: strip parenthesized precision/scale (e.g., DECIMAL(10,2) → DECIMAL)
  const baseType = type.replace(/\(.*\)/, '').trim().toUpperCase();
  return NUMERIC_TYPES.has(baseType);
}

/**
 * Determines if a SQL type is a string type that requires single-quote wrapping.
 */
function isStringType(type: string): boolean {
  const baseType = type.replace(/\(.*\)/, '').trim().toUpperCase();
  return STRING_TYPES.has(baseType);
}

/**
 * Determines if a SQL type is a date/time type that requires single-quote wrapping.
 */
function isDateType(type: string): boolean {
  const baseType = type.replace(/\(.*\)/, '').trim().toUpperCase();
  return DATE_TYPES.has(baseType);
}

/**
 * Displays a VS Code input dialog for undeclared variables.
 * Shows each variable one at a time using showInputBox with type as placeholder.
 * Returns user-provided values, or undefined if cancelled.
 */
export async function promptForVariableValues(
  variables: UndeclaredVariable[]
): Promise<VariableValue[] | undefined> {
  // Cap at maximum
  const toPrompt = variables.slice(0, MAX_PROMPT_VARIABLES);
  const results: VariableValue[] = [];

  for (let i = 0; i < toPrompt.length; i++) {
    const variable = toPrompt[i];
    const stepLabel = `(${i + 1}/${toPrompt.length})`;

    const value = await vscode.window.showInputBox({
      title: `${stepLabel} Enter value for @${variable.name}`,
      prompt: `Type: ${variable.inferredType}`,
      placeHolder: variable.inferredType,
      validateInput: (input: string) => {
        // Allow empty (will be treated as NULL)
        if (input.trim().length === 0) {
          return null;
        }
        // Validate numeric types
        if (isNumericType(variable.inferredType)) {
          if (!isValidNumericValue(input)) {
            return `Invalid value for ${variable.inferredType}: expected a numeric value`;
          }
        }
        return null;
      },
    });

    // User pressed Escape / cancelled
    if (value === undefined) {
      return undefined;
    }

    results.push({
      name: variable.name,
      type: variable.inferredType,
      value: value.trim().length === 0 ? null : value.trim(),
    });
  }

  return results;
}

/**
 * Generates DECLARE statement text from variable values.
 * Pure function for testability.
 *
 * Rules:
 * - One DECLARE per variable in first-occurrence order
 * - Empty/blank values → `DECLARE @name type = NULL;`
 * - Non-empty values → `DECLARE @name type = value;` with appropriate quoting
 *   - Numeric types: insert value as-is (no quotes)
 *   - String types: wrap in single quotes, escape internal single quotes by doubling
 *   - Date/time types: wrap in single quotes
 *   - Other types: wrap in single quotes (safe default)
 */
export function generateDeclareStatements(values: VariableValue[]): string {
  const lines: string[] = [];

  for (const v of values) {
    if (v.value === null) {
      lines.push(`DECLARE @${v.name} ${v.type} = NULL;`);
    } else {
      const formattedValue = formatValueForType(v.value, v.type);
      lines.push(`DECLARE @${v.name} ${v.type} = ${formattedValue};`);
    }
  }

  return lines.join('\n');
}

/**
 * Formats a value for insertion into a DECLARE statement based on its SQL type.
 */
function formatValueForType(value: string, type: string): string {
  if (isNumericType(type)) {
    // Numeric values are inserted as-is (no quotes)
    return value;
  }

  if (isStringType(type) || isDateType(type)) {
    // String and date values are wrapped in single quotes with escaping
    return `'${escapeQuotes(value)}'`;
  }

  // Default: wrap in single quotes (safe for UNIQUEIDENTIFIER, BIT with string values, etc.)
  // BIT type with 0/1 can go unquoted, but wrapping in quotes is still valid SQL
  return `'${escapeQuotes(value)}'`;
}

/**
 * Escapes single quotes in a string by doubling them.
 */
function escapeQuotes(value: string): string {
  return value.replace(/'/g, "''");
}
