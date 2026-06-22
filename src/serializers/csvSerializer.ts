import { ResultSet } from '../types';

/**
 * Formats a single cell value for CSV output per RFC 4180.
 * - null/undefined → empty string (no quotes)
 * - Values containing commas, double quotes, or newlines → enclosed in double quotes
 *   with internal double quotes doubled
 * - All other values → unquoted String(value)
 */
export function formatCsvCell(value: any): string {
    if (value === null || value === undefined) {
        return '';
    }

    const str = String(value);

    // Check if quoting is needed: commas, double quotes, CR, LF
    if (str.includes(',') || str.includes('"') || str.includes('\r') || str.includes('\n')) {
        // Enclose in double quotes, escape internal double quotes by doubling
        return '"' + str.replace(/"/g, '""') + '"';
    }

    return str;
}

/**
 * Serializes a ResultSet to RFC 4180-compliant CSV.
 * Pure function: same input always produces same output.
 *
 * - Header row uses column names
 * - Line endings: CRLF per RFC 4180
 * - Zero columns → empty string
 * - Zero rows → header row only (with trailing CRLF)
 * - NULL values → empty field (no quotes)
 */
export function serializeToCsv(resultSet: ResultSet): string {
    if (!resultSet.columns || resultSet.columns.length === 0) {
        return '';
    }

    const lines: string[] = [];

    // Header row from column names
    const header = resultSet.columns.map(col => formatCsvCell(col.name)).join(',');
    lines.push(header);

    // Data rows
    for (const row of resultSet.rows) {
        const cells = resultSet.columns.map((_, i) => formatCsvCell(row[i]));
        lines.push(cells.join(','));
    }

    // Join with CRLF, add trailing CRLF per RFC 4180
    return lines.join('\r\n') + '\r\n';
}
