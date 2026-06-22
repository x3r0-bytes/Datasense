import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { getHoverInfo } from '../../server/src/hoverProvider';
import { ISchemaCache, TableInfo, ViewInfo, ProcedureInfo, ColumnInfo, ForeignKeyInfo, ForeignKeyColumnPair } from '../../server/src/schemaCache';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Position } from 'vscode-languageserver/node';
import * as mssql from 'mssql';

/**
 * Property-based tests for HoverProvider (Properties 17, 18, 19, 20, 21)
 * Feature: sql-server-extension
 *
 * Validates: Requirements 11.1, 11.2, 12.1, 12.2, 12.3, 12.4, 13.1, 13.3
 */

// --- Helpers ---

function createTextDocument(content: string): TextDocument {
  return TextDocument.create('file:///test.sql', 'sql', 1, content);
}

function createMockSchemaCache(options: {
  tables?: TableInfo[];
  views?: ViewInfo[];
  procedures?: ProcedureInfo[];
  foreignKeys?: ForeignKeyInfo[];
  isPopulating?: boolean;
}): ISchemaCache {
  const foreignKeys = options.foreignKeys ?? [];

  // Build FK index
  const fkIndex = new Map<string, ForeignKeyInfo[]>();
  for (const fk of foreignKeys) {
    const referencingKey = `${fk.referencingSchema}.${fk.referencingTable}`.toLowerCase();
    const referencedKey = `${fk.referencedSchema}.${fk.referencedTable}`.toLowerCase();

    if (!fkIndex.has(referencingKey)) {
      fkIndex.set(referencingKey, []);
    }
    fkIndex.get(referencingKey)!.push(fk);

    if (!fkIndex.has(referencedKey)) {
      fkIndex.set(referencedKey, []);
    }
    fkIndex.get(referencedKey)!.push(fk);
  }

  return {
    tables: options.tables ?? [],
    views: options.views ?? [],
    procedures: options.procedures ?? [],
    foreignKeys,
    isPopulating: options.isPopulating ?? false,
    refresh: async (_pool: mssql.ConnectionPool) => {},
    getForeignKeysForTable: (schema: string, tableName: string) => {
      const key = `${schema}.${tableName}`.toLowerCase();
      return fkIndex.get(key) || [];
    },
  };
}

/**
 * Gets the position of a word in a single-line document.
 * Returns the Position pointing to the middle of the word.
 */
function getPositionOfWord(text: string, word: string): Position {
  const idx = text.toLowerCase().indexOf(word.toLowerCase());
  if (idx === -1) {
    return { line: 0, character: 0 };
  }
  return { line: 0, character: idx + Math.floor(word.length / 2) };
}

// --- Generators ---

/** Generator: random valid SQL identifier (starts with letter, alphanumeric + underscore) */
const arbitraryIdentifier: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')),
      { minLength: 2, maxLength: 12 }
    )
  )
  .map(([first, rest]) => first + rest)
  // Exclude SQL keywords that would confuse the parser
  .filter((id) => !/^(select|from|where|join|inner|left|right|full|cross|on|order|group|having|exec|execute|insert|update|delete|create|alter|drop|begin|end|if|else|while|return|declare|set|union|all|except|intersect|into|values|as|and|or|not|in|exists|between|like|is|null|case|when|then|distinct|top|with|go|use|print|table|view|column|index|primary|foreign|key|constraint|references)$/i.test(id));

/** Generator: random schema name */
const arbitrarySchemaName: fc.Arbitrary<string> = fc.constantFrom('dbo', 'sales', 'hr', 'admin', 'app', 'staging');

/** Generator: random SQL data type */
const arbitraryDataType: fc.Arbitrary<string> = fc.constantFrom(
  'int', 'bigint', 'smallint', 'tinyint', 'bit',
  'varchar', 'nvarchar', 'char', 'nchar', 'text',
  'decimal', 'numeric', 'float', 'real', 'money',
  'datetime', 'datetime2', 'date', 'time',
  'uniqueidentifier', 'varbinary', 'xml'
);

/** Generator: random column info */
const arbitraryColumnInfo: fc.Arbitrary<ColumnInfo> = fc.record({
  name: arbitraryIdentifier,
  dataType: arbitraryDataType,
  isNullable: fc.boolean(),
});

/** Generator: random table info with unique column names and at least 1 column */
const arbitraryTableInfo: fc.Arbitrary<TableInfo> = fc.record({
  schema: arbitrarySchemaName,
  name: arbitraryIdentifier,
  columns: fc.array(arbitraryColumnInfo, { minLength: 1, maxLength: 6 })
    .map((cols) => {
      const seen = new Set<string>();
      return cols.filter((c) => {
        const lower = c.name.toLowerCase();
        if (seen.has(lower)) return false;
        seen.add(lower);
        return true;
      });
    })
    .filter((cols) => cols.length > 0),
});

/** Generator: random view info with unique column names and at least 1 column */
const arbitraryViewInfo: fc.Arbitrary<ViewInfo> = fc.record({
  schema: arbitrarySchemaName,
  name: arbitraryIdentifier,
  columns: fc.array(arbitraryColumnInfo, { minLength: 1, maxLength: 6 })
    .map((cols) => {
      const seen = new Set<string>();
      return cols.filter((c) => {
        const lower = c.name.toLowerCase();
        if (seen.has(lower)) return false;
        seen.add(lower);
        return true;
      });
    })
    .filter((cols) => cols.length > 0),
});

// --- Tests ---

describe('HoverProvider Property Tests', () => {
  describe('Property 17: Table hover content completeness', () => {
    /**
     * Validates: Requirements 11.1
     *
     * For any table resolved in the schema cache with one or more columns,
     * the hover tooltip SHALL contain the schema name, table name, column count,
     * and all column names with their data types.
     */

    it('table hover contains schema name, table name, column count, and all columns with types', () => {
      fc.assert(
        fc.property(arbitraryTableInfo, (table) => {
          const schemaCache = createMockSchemaCache({ tables: [table] });

          // Create a SQL document with the table name
          const text = `SELECT * FROM ${table.schema}.${table.name}`;
          const document = createTextDocument(text);

          // Position cursor on the table name (after schema.)
          const schemaPrefix = `SELECT * FROM ${table.schema}.`;
          const position: Position = { line: 0, character: schemaPrefix.length + 1 };

          const hover = getHoverInfo(document, position, schemaCache);

          // Should return a hover since table has 1+ columns
          expect(hover).not.toBeNull();
          const content = (hover!.contents as { value: string }).value;

          // Must contain schema name
          expect(content).toContain(table.schema);

          // Must contain table name
          expect(content).toContain(table.name);

          // Must contain column count
          expect(content).toContain(`${table.columns.length}`);

          // Must contain all column names with their data types
          for (const col of table.columns) {
            expect(content).toContain(col.name);
            expect(content).toContain(col.dataType);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('table hover returns null for tables with zero columns', () => {
      fc.assert(
        fc.property(arbitrarySchemaName, arbitraryIdentifier, (schema, name) => {
          const table: TableInfo = { schema, name, columns: [] };
          const schemaCache = createMockSchemaCache({ tables: [table] });

          const text = `SELECT * FROM ${schema}.${name}`;
          const document = createTextDocument(text);

          const schemaPrefix = `SELECT * FROM ${schema}.`;
          const position: Position = { line: 0, character: schemaPrefix.length + 1 };

          const hover = getHoverInfo(document, position, schemaCache);
          expect(hover).toBeNull();
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 18: FK information in table hover', () => {
    /**
     * Validates: Requirements 11.2
     *
     * For any table with foreign key relationships, the hover tooltip SHALL
     * include the FK constraint names and referenced tables.
     */

    it('table hover includes FK constraint names and referenced tables', () => {
      fc.assert(
        fc.property(
          arbitraryTableInfo,
          arbitraryTableInfo,
          arbitraryIdentifier,
          (sourceTable, targetTable, constraintName) => {
            // Ensure tables have different names to avoid collision
            if (sourceTable.name.toLowerCase() === targetTable.name.toLowerCase() &&
                sourceTable.schema.toLowerCase() === targetTable.schema.toLowerCase()) {
              return; // skip this case
            }

            // Ensure source table has at least one column to use as FK column
            const fkColumn = sourceTable.columns[0];
            const referencedColumn = targetTable.columns[0];

            const fk: ForeignKeyInfo = {
              constraintName: `FK_${constraintName}`,
              referencingSchema: sourceTable.schema,
              referencingTable: sourceTable.name,
              referencedSchema: targetTable.schema,
              referencedTable: targetTable.name,
              columnPairs: [{
                referencingColumn: fkColumn.name,
                referencedColumn: referencedColumn.name,
                ordinalPosition: 1,
              }],
            };

            const schemaCache = createMockSchemaCache({
              tables: [sourceTable, targetTable],
              foreignKeys: [fk],
            });

            // Hover over the source table (which has the FK)
            const text = `SELECT * FROM ${sourceTable.schema}.${sourceTable.name}`;
            const document = createTextDocument(text);

            const schemaPrefix = `SELECT * FROM ${sourceTable.schema}.`;
            const position: Position = { line: 0, character: schemaPrefix.length + 1 };

            const hover = getHoverInfo(document, position, schemaCache);

            expect(hover).not.toBeNull();
            const content = (hover!.contents as { value: string }).value;

            // Must contain the FK constraint name
            expect(content).toContain(`FK_${constraintName}`);

            // Must contain the referenced table
            expect(content).toContain(targetTable.name);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('table hover includes FK info when table is the referenced table', () => {
      fc.assert(
        fc.property(
          arbitraryTableInfo,
          arbitraryTableInfo,
          arbitraryIdentifier,
          (sourceTable, targetTable, constraintName) => {
            if (sourceTable.name.toLowerCase() === targetTable.name.toLowerCase() &&
                sourceTable.schema.toLowerCase() === targetTable.schema.toLowerCase()) {
              return;
            }

            const fkColumn = sourceTable.columns[0];
            const referencedColumn = targetTable.columns[0];

            const fk: ForeignKeyInfo = {
              constraintName: `FK_${constraintName}`,
              referencingSchema: sourceTable.schema,
              referencingTable: sourceTable.name,
              referencedSchema: targetTable.schema,
              referencedTable: targetTable.name,
              columnPairs: [{
                referencingColumn: fkColumn.name,
                referencedColumn: referencedColumn.name,
                ordinalPosition: 1,
              }],
            };

            const schemaCache = createMockSchemaCache({
              tables: [sourceTable, targetTable],
              foreignKeys: [fk],
            });

            // Hover over the referenced (target) table
            const text = `SELECT * FROM ${targetTable.schema}.${targetTable.name}`;
            const document = createTextDocument(text);

            const schemaPrefix = `SELECT * FROM ${targetTable.schema}.`;
            const position: Position = { line: 0, character: schemaPrefix.length + 1 };

            const hover = getHoverInfo(document, position, schemaCache);

            expect(hover).not.toBeNull();
            const content = (hover!.contents as { value: string }).value;

            // Must contain the FK constraint name
            expect(content).toContain(`FK_${constraintName}`);

            // Must contain the referencing table (source)
            expect(content).toContain(sourceTable.name);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 19: Column hover content completeness', () => {
    /**
     * Validates: Requirements 12.1, 12.2, 12.3
     *
     * For any column that can be resolved to a table in the schema cache,
     * the hover tooltip SHALL contain the data type, nullability status,
     * owning table's schema-qualified name, and constraint indicators
     * (Primary Key / Foreign Key with referenced table) when applicable.
     */

    it('column hover contains data type, nullability, and owning table', () => {
      fc.assert(
        fc.property(arbitraryTableInfo, (table) => {
          const schemaCache = createMockSchemaCache({ tables: [table] });

          // Use the first column with a qualified reference (table.column)
          const col = table.columns[0];
          const text = `SELECT ${table.name}.${col.name} FROM ${table.schema}.${table.name}`;
          const document = createTextDocument(text);

          // Position cursor on the column name (after "table.")
          const prefix = `SELECT ${table.name}.`;
          const position: Position = { line: 0, character: prefix.length + 1 };

          const hover = getHoverInfo(document, position, schemaCache);

          expect(hover).not.toBeNull();
          const content = (hover!.contents as { value: string }).value;

          // Must contain data type
          expect(content).toContain(col.dataType);

          // Must contain nullability
          const expectedNullability = col.isNullable ? 'nullable' : 'not null';
          expect(content).toContain(expectedNullability);

          // Must contain owning table's schema-qualified name
          expect(content).toContain(`${table.schema}.${table.name}`);
        }),
        { numRuns: 100 }
      );
    });

    it('column hover shows Foreign Key indicator with referenced table when column is FK', () => {
      fc.assert(
        fc.property(
          arbitraryTableInfo,
          arbitraryTableInfo,
          arbitraryIdentifier,
          (sourceTable, targetTable, constraintName) => {
            if (sourceTable.name.toLowerCase() === targetTable.name.toLowerCase() &&
                sourceTable.schema.toLowerCase() === targetTable.schema.toLowerCase()) {
              return;
            }

            const fkColumn = sourceTable.columns[0];
            const referencedColumn = targetTable.columns[0];

            const fk: ForeignKeyInfo = {
              constraintName: `FK_${constraintName}`,
              referencingSchema: sourceTable.schema,
              referencingTable: sourceTable.name,
              referencedSchema: targetTable.schema,
              referencedTable: targetTable.name,
              columnPairs: [{
                referencingColumn: fkColumn.name,
                referencedColumn: referencedColumn.name,
                ordinalPosition: 1,
              }],
            };

            const schemaCache = createMockSchemaCache({
              tables: [sourceTable, targetTable],
              foreignKeys: [fk],
            });

            // Hover over the FK column with qualified reference
            const text = `SELECT ${sourceTable.name}.${fkColumn.name} FROM ${sourceTable.schema}.${sourceTable.name}`;
            const document = createTextDocument(text);

            const prefix = `SELECT ${sourceTable.name}.`;
            const position: Position = { line: 0, character: prefix.length + 1 };

            const hover = getHoverInfo(document, position, schemaCache);

            expect(hover).not.toBeNull();
            const content = (hover!.contents as { value: string }).value;

            // Must contain "Foreign Key" indicator
            expect(content).toContain('Foreign Key');

            // Must contain the referenced table
            expect(content).toContain(targetTable.name);

            // Must contain the referenced column
            expect(content).toContain(referencedColumn.name);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('column hover does not show FK indicator when column is not a FK', () => {
      fc.assert(
        fc.property(arbitraryTableInfo, (table) => {
          // No foreign keys in the cache
          const schemaCache = createMockSchemaCache({ tables: [table], foreignKeys: [] });

          const col = table.columns[0];
          const text = `SELECT ${table.name}.${col.name} FROM ${table.schema}.${table.name}`;
          const document = createTextDocument(text);

          const prefix = `SELECT ${table.name}.`;
          const position: Position = { line: 0, character: prefix.length + 1 };

          const hover = getHoverInfo(document, position, schemaCache);

          expect(hover).not.toBeNull();
          const content = (hover!.contents as { value: string }).value;

          // Should NOT contain "Foreign Key" indicator
          expect(content).not.toContain('Foreign Key');
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 20: Ambiguous column hover shows all matches', () => {
    /**
     * Validates: Requirements 12.4
     *
     * For any column name that exists in multiple referenced tables without
     * a table prefix, the hover tooltip SHALL display metadata for all
     * matching columns grouped by table.
     */

    it('ambiguous column hover shows all matching columns grouped by table', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          arbitraryIdentifier,
          arbitraryIdentifier,
          arbitraryDataType,
          arbitraryDataType,
          fc.boolean(),
          fc.boolean(),
          (schema, table1Name, table2Name, dataType1, dataType2, nullable1, nullable2) => {
            // Ensure table names are different
            if (table1Name.toLowerCase() === table2Name.toLowerCase()) {
              return;
            }

            // Use a shared column name that exists in both tables
            const sharedColumnName = 'SharedCol';

            const table1: TableInfo = {
              schema,
              name: table1Name,
              columns: [{ name: sharedColumnName, dataType: dataType1, isNullable: nullable1 }],
            };

            const table2: TableInfo = {
              schema,
              name: table2Name,
              columns: [{ name: sharedColumnName, dataType: dataType2, isNullable: nullable2 }],
            };

            const schemaCache = createMockSchemaCache({ tables: [table1, table2] });

            // Query references both tables, hover over unqualified shared column
            const text = `SELECT ${sharedColumnName} FROM ${schema}.${table1Name} JOIN ${schema}.${table2Name} ON 1=1`;
            const document = createTextDocument(text);

            // Position cursor on the shared column name
            const position = getPositionOfWord(text, sharedColumnName);

            const hover = getHoverInfo(document, position, schemaCache);

            expect(hover).not.toBeNull();
            const content = (hover!.contents as { value: string }).value;

            // Must contain both table names (grouped by table)
            expect(content).toContain(table1Name);
            expect(content).toContain(table2Name);

            // Must contain both data types
            expect(content).toContain(dataType1);
            expect(content).toContain(dataType2);

            // Must indicate ambiguity
            expect(content.toLowerCase()).toContain('ambiguous');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('ambiguous column hover shows nullability for each match', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          arbitraryIdentifier,
          arbitraryIdentifier,
          arbitraryDataType,
          (schema, table1Name, table2Name, dataType) => {
            if (table1Name.toLowerCase() === table2Name.toLowerCase()) {
              return;
            }

            const sharedColumnName = 'StatusCol';

            // One nullable, one not null
            const table1: TableInfo = {
              schema,
              name: table1Name,
              columns: [{ name: sharedColumnName, dataType, isNullable: true }],
            };

            const table2: TableInfo = {
              schema,
              name: table2Name,
              columns: [{ name: sharedColumnName, dataType, isNullable: false }],
            };

            const schemaCache = createMockSchemaCache({ tables: [table1, table2] });

            const text = `SELECT ${sharedColumnName} FROM ${schema}.${table1Name} JOIN ${schema}.${table2Name} ON 1=1`;
            const document = createTextDocument(text);

            const position = getPositionOfWord(text, sharedColumnName);

            const hover = getHoverInfo(document, position, schemaCache);

            expect(hover).not.toBeNull();
            const content = (hover!.contents as { value: string }).value;

            // Must contain both nullability indicators
            expect(content).toContain('nullable');
            expect(content).toContain('not null');
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 21: View hover content completeness', () => {
    /**
     * Validates: Requirements 13.1, 13.3
     *
     * For any view resolved in the schema cache, the hover tooltip SHALL
     * contain the schema name, view name, and all column names with their
     * data types, using case-insensitive name matching.
     */

    it('view hover contains schema name, view name, and all columns with types', () => {
      fc.assert(
        fc.property(arbitraryViewInfo, (view) => {
          const schemaCache = createMockSchemaCache({ views: [view] });

          // Create a SQL document with the view name
          const text = `SELECT * FROM ${view.schema}.${view.name}`;
          const document = createTextDocument(text);

          // Position cursor on the view name (after schema.)
          const schemaPrefix = `SELECT * FROM ${view.schema}.`;
          const position: Position = { line: 0, character: schemaPrefix.length + 1 };

          const hover = getHoverInfo(document, position, schemaCache);

          // Should return a hover since view has columns
          expect(hover).not.toBeNull();
          const content = (hover!.contents as { value: string }).value;

          // Must contain schema name
          expect(content).toContain(view.schema);

          // Must contain view name
          expect(content).toContain(view.name);

          // Must contain all column names with their data types
          for (const col of view.columns) {
            expect(content).toContain(col.name);
            expect(content).toContain(col.dataType);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('view hover uses case-insensitive matching', () => {
      fc.assert(
        fc.property(arbitraryViewInfo, (view) => {
          const schemaCache = createMockSchemaCache({ views: [view] });

          // Use different case for the view name in the query
          const viewNameUpper = view.name.toUpperCase();
          const schemaUpper = view.schema.toUpperCase();
          const text = `SELECT * FROM ${schemaUpper}.${viewNameUpper}`;
          const document = createTextDocument(text);

          const schemaPrefix = `SELECT * FROM ${schemaUpper}.`;
          const position: Position = { line: 0, character: schemaPrefix.length + 1 };

          const hover = getHoverInfo(document, position, schemaCache);

          // Should still resolve via case-insensitive matching
          expect(hover).not.toBeNull();
          const content = (hover!.contents as { value: string }).value;

          // Must contain the original view name (from cache)
          expect(content).toContain(view.name);
        }),
        { numRuns: 100 }
      );
    });
  });
});
