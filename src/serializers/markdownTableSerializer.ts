import { ResultSet } from '../types';

/**
 * Formats a single cell value for markdown table display.
 * NULL → "NULL", pipes escaped to avoid breaking table structure.
 */
export function formatMarkdownCell(value: any): string {
    if (value === null || value === undefined) {
        return 'NULL';
    }
    // Escape pipe characters and newlines that would break the table
    return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ').replace(/\r/g, '');
}

/**
 * Serializes a ResultSet to a GitHub-flavored Markdown table for clipboard.
 * Pure function: same input always produces same output.
 *
 * Format:
 *   | Name  | Age | City        |
 *   |-------|-----|-------------|
 *   | Alice | 30  | New York    |
 *   | Bob   | 25  | Los Angeles |
 *
 * - Pipe-delimited columns with header and separator rows
 * - NULL values displayed as "NULL"
 * - Pipe characters in data are escaped as \|
 * - Newlines in data are replaced with spaces
 * - Zero columns → empty string
 * - No trailing newline after last row
 */
export function serializeToMarkdownTable(resultSet: ResultSet): string {
    if (!resultSet.columns || resultSet.columns.length === 0) {
        return '';
    }

    // Header row
    const headers = resultSet.columns.map(col => ` ${formatMarkdownCell(col.name)} `);
    const headerLine = `|${headers.join('|')}|`;

    // Separator row (at least 3 dashes per column for valid GFM)
    const separatorCells = resultSet.columns.map(col => {
        const width = Math.max(col.name.length, 3);
        return '-'.repeat(width + 2); // +2 for the spaces around cell content
    });
    const separatorLine = `|${separatorCells.join('|')}|`;

    // Data rows
    const dataLines: string[] = [];
    for (const row of resultSet.rows) {
        const cells = resultSet.columns.map((_, i) => {
            const cellStr = formatMarkdownCell(row[i]);
            return ` ${cellStr} `;
        });
        dataLines.push(`|${cells.join('|')}|`);
    }

    const parts = [headerLine, separatorLine, ...dataLines];
    return parts.join('\n');
}
