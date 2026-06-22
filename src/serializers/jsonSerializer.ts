import { ResultSet } from '../types';

/**
 * Numeric SQL Server data types that should map to JavaScript numbers.
 */
const NUMERIC_TYPES = new Set([
    'int', 'bigint', 'decimal', 'float', 'real',
    'money', 'smallmoney', 'numeric', 'smallint', 'tinyint'
]);

/**
 * Date/datetime SQL Server data types that should map to ISO 8601 strings.
 */
const DATETIME_TYPES = new Set([
    'date', 'datetime', 'datetime2', 'datetimeoffset', 'smalldatetime', 'time'
]);

/**
 * Binary SQL Server data types that should map to base64-encoded strings.
 */
const BINARY_TYPES = new Set([
    'binary', 'varbinary', 'image'
]);

/**
 * Maps a SQL value to the appropriate JSON type based on column dataType.
 * - NULL → null
 * - numeric types (int, bigint, decimal, float, real, money, smallmoney, numeric, smallint, tinyint) → number
 * - bit → boolean (truthy → true, falsy → false)
 * - date/datetime types (date, datetime, datetime2, datetimeoffset, smalldatetime, time) → ISO 8601 string
 * - binary types (binary, varbinary, image) → base64 string
 * - all others → string
 */
export function mapSqlValueToJson(value: any, dataType: string): any {
    // NULL handling takes priority
    if (value === null || value === undefined) {
        return null;
    }

    const normalizedType = dataType.toLowerCase();

    // Numeric types → number
    if (NUMERIC_TYPES.has(normalizedType)) {
        return Number(value);
    }

    // Bit → boolean
    if (normalizedType === 'bit') {
        return value ? true : false;
    }

    // Date/datetime types → ISO 8601 string
    if (DATETIME_TYPES.has(normalizedType)) {
        if (value instanceof Date) {
            return value.toISOString();
        }
        return String(value);
    }

    // Binary types → base64 string
    if (BINARY_TYPES.has(normalizedType)) {
        return Buffer.from(value).toString('base64');
    }

    // All others → string
    return String(value);
}

/**
 * Serializes a ResultSet to a JSON array of objects with 2-space indentation.
 * Pure function: same input always produces same output.
 *
 * - Zero columns → empty string
 * - Zero rows → "[]"
 * - Each row becomes an object with column names as keys
 * - Values are type-mapped using mapSqlValueToJson based on column dataType
 */
export function serializeToJson(resultSet: ResultSet): string {
    if (!resultSet.columns || resultSet.columns.length === 0) {
        return '';
    }

    if (!resultSet.rows || resultSet.rows.length === 0) {
        return '[]';
    }

    const objects = resultSet.rows.map(row => {
        const obj: Record<string, any> = {};
        resultSet.columns.forEach((col, i) => {
            obj[col.name] = mapSqlValueToJson(row[i], col.dataType);
        });
        return obj;
    });

    return JSON.stringify(objects, null, 2);
}
