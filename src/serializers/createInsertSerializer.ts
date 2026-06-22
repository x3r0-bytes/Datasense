import { ResultSet } from '../types';
import { formatSqlLiteral, escapeSingleQuotes } from './insertSerializer';

/**
 * Maps a column's dataType metadata to a SQL Server DDL type string.
 * Unknown/empty types default to NVARCHAR(MAX).
 */
export function inferSqlType(dataType: string): string {
    if (!dataType || dataType.trim() === '') {
        return 'NVARCHAR(MAX)';
    }

    const dt = dataType.toLowerCase().trim();

    // Exact matches for simple types
    switch (dt) {
        case 'int':
            return 'INT';
        case 'bigint':
            return 'BIGINT';
        case 'smallint':
            return 'SMALLINT';
        case 'tinyint':
            return 'TINYINT';
        case 'bit':
            return 'BIT';
        case 'float':
            return 'FLOAT';
        case 'real':
            return 'REAL';
        case 'money':
            return 'MONEY';
        case 'smallmoney':
            return 'SMALLMONEY';
        case 'decimal':
        case 'numeric':
            return 'DECIMAL(18,2)';
        case 'varchar':
            return 'VARCHAR(MAX)';
        case 'nvarchar':
            return 'NVARCHAR(MAX)';
        case 'char':
            return 'CHAR(255)';
        case 'nchar':
            return 'NCHAR(255)';
        case 'text':
            return 'TEXT';
        case 'ntext':
            return 'NTEXT';
        case 'date':
            return 'DATE';
        case 'datetime':
            return 'DATETIME';
        case 'datetime2':
            return 'DATETIME2';
        case 'datetimeoffset':
            return 'DATETIMEOFFSET';
        case 'smalldatetime':
            return 'SMALLDATETIME';
        case 'time':
            return 'TIME';
        case 'binary':
        case 'varbinary':
            return 'VARBINARY(MAX)';
        case 'image':
            return 'IMAGE';
        case 'uniqueidentifier':
            return 'UNIQUEIDENTIFIER';
        case 'xml':
            return 'XML';
        default:
            return 'NVARCHAR(MAX)';
    }
}

/**
 * Serializes a ResultSet to CREATE TABLE + INSERT statements.
 * Infers SQL types from column metadata. All columns NULLable.
 * Uses [TableName] placeholder. Pure function.
 *
 * Output format:
 * CREATE TABLE [TableName] (
 *     [col1] NVARCHAR(MAX) NULL,
 *     [col2] INT NULL
 * );
 *
 * INSERT INTO [TableName] ([col1], [col2]) VALUES (N'value', 1);
 *
 * - Zero columns → empty string
 * - Zero rows → CREATE TABLE only (no INSERT statements)
 */
export function serializeToCreateInsert(resultSet: ResultSet): string {
    if (!resultSet.columns || resultSet.columns.length === 0) {
        return '';
    }

    // Build CREATE TABLE statement
    const columnDefs = resultSet.columns.map(col => {
        const sqlType = inferSqlType(col.dataType);
        return `    [${col.name}] ${sqlType} NULL`;
    });

    const createTable = `CREATE TABLE [TableName] (\n${columnDefs.join(',\n')}\n);\n`;

    // If no rows, return only CREATE TABLE
    if (!resultSet.rows || resultSet.rows.length === 0) {
        return createTable;
    }

    // Build INSERT statements
    const columnList = resultSet.columns.map(col => `[${col.name}]`).join(', ');

    const insertStatements: string[] = [];

    for (const row of resultSet.rows) {
        const values = resultSet.columns.map((col, i) =>
            formatSqlLiteral(row[i], col.dataType)
        );

        const statement = `INSERT INTO [TableName] (${columnList}) VALUES (${values.join(', ')});`;
        insertStatements.push(statement);
    }

    return createTable + '\n' + insertStatements.join('\n') + '\n';
}
