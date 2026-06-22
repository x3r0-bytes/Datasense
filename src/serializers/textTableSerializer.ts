import { ColumnMetadata, ResultSet } from '../types';

/** Maximum column width before truncation */
const MAX_COLUMN_WIDTH = 50;

/** Width at which truncation replaces the tail with "..." */
const TRUNCATION_SUFFIX = '...';
const TRUNCATION_BODY_LENGTH = MAX_COLUMN_WIDTH - TRUNCATION_SUFFIX.length; // 47

/**
 * Formats a single cell value for text table display.
 * NULL → "NULL" (4 chars, uppercase), other values → String(value).
 */
export function formatTextCell(value: any): string {
    if (value === null || value === undefined) {
        return 'NULL';
    }
    return String(value);
}

/**
 * Truncates a string to maxLength characters.
 * If the string exceeds maxLength, it is truncated to (maxLength - 3) characters
 * followed by "..." so that the total displayed width equals maxLength.
 * If maxLength <= 3, returns the first maxLength characters (no room for suffix).
 */
export function truncateCell(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
        return value;
    }
    if (maxLength <= 3) {
        return value.slice(0, maxLength);
    }
    return value.slice(0, maxLength - 3) + '...';
}

/**
 * Calculates column widths from headers and data.
 * Each width = max(header length, longest cell string value), capped at 50.
 */
export function calculateColumnWidths(columns: ColumnMetadata[], rows: any[][]): number[] {
    const widths: number[] = columns.map(col => col.name.length);

    for (const row of rows) {
        for (let i = 0; i < columns.length; i++) {
            const cellStr = formatTextCell(row[i]);
            if (cellStr.length > widths[i]) {
                widths[i] = cellStr.length;
            }
        }
    }

    // Cap each width at MAX_COLUMN_WIDTH
    return widths.map(w => Math.min(w, MAX_COLUMN_WIDTH));
}

/**
 * Serializes a ResultSet to a fixed-width text table for clipboard.
 * Pure function: same input always produces same output.
 *
 * Format:
 *   Name       Age  City
 *   ---------  ---  ----------
 *   Alice      30   New York
 *   Bob        25   Los Angeles
 *
 * - Column widths = max(header length, longest cell string), capped at 50 chars
 * - Values exceeding 50 chars truncated to 47 + "..."
 * - NULL values displayed as "NULL"
 * - Columns separated by two spaces ("  ")
 * - Separator row: dashes matching column width, separated by two spaces
 * - Zero columns → empty string
 * - No trailing newline after last row
 */
export function serializeToTextTable(resultSet: ResultSet): string {
    if (!resultSet.columns || resultSet.columns.length === 0) {
        return '';
    }

    const widths = calculateColumnWidths(resultSet.columns, resultSet.rows);
    const separator = '  '; // two spaces between columns

    // Header row: column names padded to width
    const headerCells = resultSet.columns.map((col, i) => {
        const truncated = truncateCell(col.name, widths[i]);
        return truncated.padEnd(widths[i]);
    });
    const headerLine = headerCells.join(separator);

    // Separator row: dashes matching each column width
    const separatorCells = widths.map(w => '-'.repeat(w));
    const separatorLine = separatorCells.join(separator);

    // Data rows
    const dataLines: string[] = [];
    for (const row of resultSet.rows) {
        const cells = resultSet.columns.map((_, i) => {
            const cellStr = formatTextCell(row[i]);
            const truncated = truncateCell(cellStr, widths[i]);
            return truncated.padEnd(widths[i]);
        });
        dataLines.push(cells.join(separator));
    }

    // Combine: header + separator + data rows, joined with newlines
    const parts = [headerLine, separatorLine, ...dataLines];
    return parts.join('\n');
}
