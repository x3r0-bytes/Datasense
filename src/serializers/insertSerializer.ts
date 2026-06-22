import { ResultSet } from '../types';

/**
 * Escapes single quotes in a string value by doubling them.
 * e.g., "O'Brien" → "O''Brien"
 */
export function escapeSingleQuotes(value: string): string {
    return value.replace(/'/g, "''");
}

/**
 * Formats a single value as a SQL Server literal based on the column's data type.
 * - NULL → NULL (unquoted keyword)
 * - string types (varchar, char, text) → 'value' with single quotes escaped
 * - Unicode string types (nvarchar, nchar, ntext) → N'value' with N prefix
 * - numeric types (int, bigint, decimal, float, real, money, etc.) → unquoted number
 * - bit → 0 or 1
 * - datetime types → '2024-01-15T10:30:00.000' (ISO string in single quotes)
 * - binary types → 0x + hex string
 * - all others → 'value' (single-quoted string as fallback)
 */
export function formatSqlLiteral(value: any, dataType: string): string {
    if (value === null || value === undefined) {
        return 'NULL';
    }

    const dt = dataType.toLowerCase();

    // Unicode string types (must be checked before generic string types)
    if (dt.includes('nvarchar') || dt.includes('nchar') || dt.includes('ntext')) {
        return `N'${escapeSingleQuotes(String(value))}'`;
    }

    // String types (varchar, char, text)
    if (dt.includes('varchar') || dt.includes('char') || dt.includes('text')) {
        return `'${escapeSingleQuotes(String(value))}'`;
    }

    // Bit type
    if (dt === 'bit') {
        return value ? '1' : '0';
    }

    // Numeric types
    if (
        dt.includes('int') ||
        dt.includes('decimal') ||
        dt.includes('numeric') ||
        dt.includes('float') ||
        dt.includes('real') ||
        dt.includes('money') ||
        dt === 'smallmoney'
    ) {
        return String(value);
    }

    // DateTime types
    if (
        dt.includes('datetime') ||
        dt.includes('date') ||
        dt.includes('time') ||
        dt === 'datetimeoffset' ||
        dt === 'smalldatetime'
    ) {
        // If value is a Date object, convert to ISO string
        if (value instanceof Date) {
            return `'${value.toISOString()}'`;
        }
        return `'${escapeSingleQuotes(String(value))}'`;
    }

    // Binary types
    if (dt.includes('binary') || dt === 'image' || dt.includes('varbinary')) {
        if (Buffer.isBuffer(value)) {
            return '0x' + value.toString('hex').toUpperCase();
        }
        if (value instanceof Uint8Array) {
            return '0x' + Buffer.from(value).toString('hex').toUpperCase();
        }
        // If it's already a hex string
        return '0x' + String(value);
    }

    // Fallback: single-quoted string
    return `'${escapeSingleQuotes(String(value))}'`;
}

/**
 * Serializes a ResultSet to INSERT statements (one per row).
 * Uses [TableName] placeholder. Pure function.
 *
 * Format: INSERT INTO [TableName] ([col1], [col2], ...) VALUES (val1, val2, ...);
 *
 * - Zero columns → empty string
 * - Zero rows → empty string (no INSERT statements)
 * - Column names are bracket-quoted in the INSERT
 * - Each INSERT ends with `;` and newline
 */
export function serializeToInsert(resultSet: ResultSet): string {
    if (!resultSet.columns || resultSet.columns.length === 0) {
        return '';
    }

    if (!resultSet.rows || resultSet.rows.length === 0) {
        return '';
    }

    // Build column list: [col1], [col2], ...
    const columnList = resultSet.columns.map(col => `[${col.name}]`).join(', ');

    const lines: string[] = [];

    for (const row of resultSet.rows) {
        // Format each value according to its column's data type
        const values = resultSet.columns.map((col, i) =>
            formatSqlLiteral(row[i], col.dataType)
        );

        const statement = `INSERT INTO [TableName] (${columnList}) VALUES (${values.join(', ')});`;
        lines.push(statement);
    }

    return lines.join('\n') + '\n';
}
