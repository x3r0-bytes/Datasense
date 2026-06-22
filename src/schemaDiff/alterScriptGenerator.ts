/**
 * ALTER Script Generator
 *
 * Transforms schema diff results into executable T-SQL DDL statements.
 * Pure function — no side effects, no database connections.
 *
 * Statement ordering: DROPs → CREATE TABLEs → ALTER TABLEs → CREATE INDEXes
 * Each statement separated by GO batch separator on its own line.
 */

import {
  SchemaDiff,
  TableSnapshot,
  ColumnSnapshot,
  IndexSnapshot,
  ColumnDiff,
  IndexDiff,
  TableDiff
} from './schemaDiffTypes';

export interface AlterScriptOptions {
  includeDropStatements: boolean;
}

/** Categories used for statement ordering */
enum StatementCategory {
  Drop = 0,
  CreateTable = 1,
  AlterTable = 2,
  CreateIndex = 3
}

interface CategorizedStatement {
  category: StatementCategory;
  sql: string;
}

export class AlterScriptGenerator {
  /**
   * Generate T-SQL ALTER/CREATE/DROP script from diff results.
   * Pure function — no side effects.
   *
   * All generated DDL uses the TARGET schema name so the script is directly
   * executable against the target database without manual schema name edits.
   *
   * Algorithm:
   * 1. Collect all statements into arrays by category
   * 2. If includeDropStatements: generate DROPs for target-only tables, removed columns, removed indexes
   * 3. Generate CREATE TABLE for source-only tables (using target schema name)
   * 4. For modified tables: ADD COLUMN, ALTER COLUMN (with mayLoseData warning)
   * 5. Generate CREATE INDEX for added indexes
   * 6. Order statements: DROPs → CREATE TABLEs → ALTER TABLEs → CREATE INDEXes
   * 7. Join with GO separators
   */
  generate(diff: SchemaDiff, options: AlterScriptOptions): string {
    const statements: CategorizedStatement[] = [];
    const targetSchema = diff.target.schemaName;

    // DROP statements (only when opted in)
    if (options.includeDropStatements) {
      // Drop tables only in target (use their own schema since they exist in target)
      for (const table of diff.tablesOnlyInTarget) {
        statements.push({
          category: StatementCategory.Drop,
          sql: this.generateDropTable(targetSchema, table.name)
        });
      }

      // Drop removed columns and indexes from modified tables
      for (const tableDiff of diff.modifiedTables) {
        for (const colDiff of tableDiff.columnDiffs) {
          if (colDiff.type === 'removed') {
            statements.push({
              category: StatementCategory.Drop,
              sql: this.generateDropColumn(targetSchema, tableDiff.name, colDiff.columnName)
            });
          }
        }

        for (const idxDiff of tableDiff.indexDiffs) {
          if (idxDiff.type === 'removed') {
            statements.push({
              category: StatementCategory.Drop,
              sql: this.generateDropIndex(targetSchema, tableDiff.name, idxDiff.indexName)
            });
          }
        }
      }
    }

    // CREATE TABLE for tables only in source (using target schema name)
    for (const table of diff.tablesOnlyInSource) {
      statements.push({
        category: StatementCategory.CreateTable,
        sql: this.generateCreateTable({ ...table, schema: targetSchema })
      });
    }

    // ALTER TABLE for modified tables (using target schema name)
    for (const tableDiff of diff.modifiedTables) {
      // Added columns
      for (const colDiff of tableDiff.columnDiffs) {
        if (colDiff.type === 'added' && colDiff.source) {
          statements.push({
            category: StatementCategory.AlterTable,
            sql: this.generateAddColumn(targetSchema, tableDiff.name, colDiff.source)
          });
        }
      }

      // Modified columns
      for (const colDiff of tableDiff.columnDiffs) {
        if (colDiff.type === 'modified' && colDiff.source) {
          let sql = '';
          // Check for data loss risk
          if (colDiff.target && this.mayLoseData(colDiff.source, colDiff.target)) {
            sql += '-- WARNING: This alteration may cause data loss\n';
          }
          sql += this.generateAlterColumn(targetSchema, tableDiff.name, colDiff.source);
          statements.push({
            category: StatementCategory.AlterTable,
            sql
          });
        }
      }

      // Added indexes
      for (const idxDiff of tableDiff.indexDiffs) {
        if (idxDiff.type === 'added' && idxDiff.source) {
          statements.push({
            category: StatementCategory.CreateIndex,
            sql: this.generateCreateIndex(targetSchema, tableDiff.name, idxDiff.source)
          });
        }
      }
    }

    // Order and join
    const ordered = this.orderStatements(statements.map(s => s.sql));
    return ordered.join('\nGO\n');
  }

  /**
   * Generate CREATE TABLE statement for a table only in source.
   * Includes all columns with data types, nullability, defaults, PKs, and indexes.
   */
  generateCreateTable(table: TableSnapshot): string {
    const qualifiedName = `[${table.schema}].[${table.name}]`;
    const lines: string[] = [];

    lines.push(`CREATE TABLE ${qualifiedName} (`);

    // Find primary key constraint to mark PK columns inline
    const pkConstraint = table.constraints.find(c => c.type === 'PRIMARY KEY');
    const pkColumns = pkConstraint ? pkConstraint.columns.map(c => c.toLowerCase()) : [];

    // Column definitions
    const columnDefs: string[] = [];
    for (const col of table.columns) {
      let colDef = `    [${col.name}] ${col.dataType}`;

      // Identity
      if (col.isIdentity) {
        const seed = col.identitySeed ?? 1;
        const increment = col.identityIncrement ?? 1;
        colDef += ` IDENTITY(${seed},${increment})`;
      }

      // Nullability
      colDef += col.isNullable ? ' NULL' : ' NOT NULL';

      // Default value
      if (col.defaultValue !== null) {
        colDef += ` DEFAULT ${col.defaultValue}`;
      }

      columnDefs.push(colDef);
    }

    // Primary key constraint
    if (pkConstraint) {
      const pkCols = pkConstraint.columns.map(c => `[${c}]`).join(', ');
      columnDefs.push(`    CONSTRAINT [${pkConstraint.name}] PRIMARY KEY (${pkCols})`);
    }

    lines.push(columnDefs.join(',\n'));
    lines.push(');');

    // Generate CREATE INDEX statements for each index on the table
    const indexStatements: string[] = [];
    for (const index of table.indexes) {
      indexStatements.push(this.generateCreateIndex(table.schema, table.name, index));
    }

    let result = lines.join('\n');
    if (indexStatements.length > 0) {
      result += '\nGO\n' + indexStatements.join('\nGO\n');
    }

    return result;
  }

  /**
   * Generate ALTER TABLE ADD COLUMN statement.
   */
  generateAddColumn(schema: string, table: string, column: ColumnSnapshot): string {
    const qualifiedTable = `[${schema}].[${table}]`;
    let colDef = `[${column.name}] ${column.dataType}`;

    // Nullability
    colDef += column.isNullable ? ' NULL' : ' NOT NULL';

    // Default value
    if (column.defaultValue !== null) {
      colDef += ` DEFAULT ${column.defaultValue}`;
    }

    return `ALTER TABLE ${qualifiedTable} ADD ${colDef};`;
  }

  /**
   * Generate ALTER TABLE ALTER COLUMN statement.
   */
  generateAlterColumn(schema: string, table: string, column: ColumnSnapshot): string {
    const qualifiedTable = `[${schema}].[${table}]`;
    let colDef = `[${column.name}] ${column.dataType}`;

    // Nullability
    colDef += column.isNullable ? ' NULL' : ' NOT NULL';

    return `ALTER TABLE ${qualifiedTable} ALTER COLUMN ${colDef};`;
  }

  /**
   * Generate CREATE INDEX statement.
   */
  generateCreateIndex(schema: string, table: string, index: IndexSnapshot): string {
    const qualifiedTable = `[${schema}].[${table}]`;
    const indexType = index.isUnique ? 'UNIQUE ' : '';
    const clustered = index.type.includes('CLUSTERED') && !index.type.includes('NONCLUSTERED')
      ? 'CLUSTERED '
      : 'NONCLUSTERED ';

    const keyCols = index.columns.map(c => `[${c}]`).join(', ');

    let sql = `CREATE ${indexType}${clustered}INDEX [${index.name}] ON ${qualifiedTable} (${keyCols})`;

    if (index.includedColumns.length > 0) {
      const includeCols = index.includedColumns.map(c => `[${c}]`).join(', ');
      sql += ` INCLUDE (${includeCols})`;
    }

    sql += ';';
    return sql;
  }

  /**
   * Generate DROP TABLE statement.
   */
  generateDropTable(schema: string, table: string): string {
    return `DROP TABLE [${schema}].[${table}];`;
  }

  /**
   * Generate DROP INDEX statement.
   */
  generateDropIndex(schema: string, table: string, indexName: string): string {
    return `DROP INDEX [${indexName}] ON [${schema}].[${table}];`;
  }

  /**
   * Generate ALTER TABLE DROP COLUMN statement.
   */
  generateDropColumn(schema: string, table: string, columnName: string): string {
    return `ALTER TABLE [${schema}].[${table}] DROP COLUMN [${columnName}];`;
  }

  /**
   * Determine if a column modification may cause data loss.
   *
   * Returns true for:
   * - Shortened VARCHAR/NVARCHAR (source length < target length means target has more data)
   * - Reduced DECIMAL/NUMERIC precision
   * - Incompatible type changes (completely different base types)
   *
   * Note: "source" is what we want the column to become, "target" is what it currently is.
   * Data loss occurs when the new type (source) cannot hold all values from the current type (target).
   */
  mayLoseData(source: ColumnSnapshot, target: ColumnSnapshot): boolean {
    const sourceType = source.dataType.toLowerCase();
    const targetType = target.dataType.toLowerCase();

    // Extract base types
    const sourceBase = this.extractBaseType(sourceType);
    const targetBase = this.extractBaseType(targetType);

    // If base types are completely different → data loss risk
    if (sourceBase !== targetBase) {
      // Allow compatible type families
      if (this.areCompatibleTypes(sourceBase, targetBase)) {
        return false;
      }
      return true;
    }

    // Check VARCHAR/NVARCHAR length reduction
    if (sourceBase === 'varchar' || sourceBase === 'nvarchar' || sourceBase === 'char' || sourceBase === 'nchar') {
      const sourceLength = this.extractLength(sourceType);
      const targetLength = this.extractLength(targetType);

      // 'max' is treated as the largest possible value
      if (targetLength === -1) { // target is MAX
        if (sourceLength !== -1) {
          return true; // reducing from MAX to a fixed length
        }
        return false;
      }

      if (sourceLength !== -1 && targetLength !== -1) {
        if (sourceLength < targetLength) {
          return true; // shortening the length
        }
      }
    }

    // Check DECIMAL/NUMERIC precision reduction
    if (sourceBase === 'decimal' || sourceBase === 'numeric') {
      const sourcePrecision = this.extractPrecision(sourceType);
      const targetPrecision = this.extractPrecision(targetType);

      if (sourcePrecision.precision < targetPrecision.precision) {
        return true;
      }
      if (sourcePrecision.scale < targetPrecision.scale) {
        return true;
      }
    }

    return false;
  }

  /**
   * Order all statements: DROPs first, then CREATEs, then ALTERs, then CREATE INDEXes.
   *
   * Detection heuristic:
   * - Starts with "DROP" → Drop category
   * - Starts with "CREATE TABLE" → CreateTable category
   * - Starts with "ALTER TABLE" → AlterTable category
   * - Starts with "CREATE" (index) → CreateIndex category
   * - Contains warning comment → uses the statement after the comment for categorization
   */
  orderStatements(statements: string[]): string[] {
    const categorized: CategorizedStatement[] = statements.map(sql => ({
      category: this.categorizeStatement(sql),
      sql
    }));

    categorized.sort((a, b) => a.category - b.category);

    return categorized.map(s => s.sql);
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  private categorizeStatement(sql: string): StatementCategory {
    // Strip leading comment lines for categorization
    const lines = sql.split('\n');
    let firstStatementLine = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('--')) {
        firstStatementLine = trimmed.toUpperCase();
        break;
      }
    }

    if (firstStatementLine.startsWith('DROP')) {
      return StatementCategory.Drop;
    }
    if (firstStatementLine.startsWith('CREATE TABLE')) {
      return StatementCategory.CreateTable;
    }
    if (firstStatementLine.startsWith('ALTER TABLE')) {
      return StatementCategory.AlterTable;
    }
    if (firstStatementLine.startsWith('CREATE')) {
      // CREATE INDEX, CREATE UNIQUE INDEX, etc.
      return StatementCategory.CreateIndex;
    }

    // Default to AlterTable for unrecognized
    return StatementCategory.AlterTable;
  }

  private extractBaseType(dataType: string): string {
    const match = dataType.match(/^([a-z]+)/);
    return match ? match[1] : dataType;
  }

  private extractLength(dataType: string): number {
    const match = dataType.match(/\((\w+)\)/);
    if (!match) { return 0; }
    if (match[1].toLowerCase() === 'max') { return -1; }
    return parseInt(match[1], 10) || 0;
  }

  private extractPrecision(dataType: string): { precision: number; scale: number } {
    const match = dataType.match(/\((\d+)(?:,\s*(\d+))?\)/);
    if (!match) { return { precision: 18, scale: 0 }; }
    return {
      precision: parseInt(match[1], 10),
      scale: match[2] ? parseInt(match[2], 10) : 0
    };
  }

  private areCompatibleTypes(type1: string, type2: string): boolean {
    // Define groups of compatible types
    const compatibleGroups: string[][] = [
      ['int', 'bigint', 'smallint', 'tinyint'],
      ['decimal', 'numeric'],
      ['float', 'real'],
      ['varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext'],
      ['datetime', 'datetime2', 'smalldatetime', 'date'],
      ['money', 'smallmoney'],
    ];

    for (const group of compatibleGroups) {
      if (group.includes(type1) && group.includes(type2)) {
        return true;
      }
    }

    return false;
  }
}
