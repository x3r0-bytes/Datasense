import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { getExpandStarActions } from '../../server/src/selectExpander';
import { ISchemaCache, ForeignKeyInfo, TableInfo, ViewInfo, ColumnInfo } from '../../server/src/schemaCache';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Range } from 'vscode-languageserver/node';

/**
 * Property-based tests for SelectExpander (Properties 14, 15, 16)
 * Feature: smart-join-generator
 *
 * Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5
 */

// --- Generators ---

/** SQL keywords that cannot be used as unquoted identifiers in FROM/JOIN clauses */
const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'join', 'inner', 'left', 'right', 'full', 'cross',
  'outer', 'on', 'and', 'or', 'not', 'in', 'is', 'null', 'as', 'by', 'order',
  'group', 'having', 'union', 'except', 'intersect', 'into', 'set', 'values',
  'exec', 'execute', 'insert', 'update', 'delete', 'create', 'alter', 'drop',
  'table', 'view', 'index', 'with', 'top', 'distinct', 'all', 'between', 'like',
  'exists', 'case', 'when', 'then', 'else', 'end', 'asc', 'desc', 'limit',
  'offset', 'fetch', 'next', 'rows', 'only',
]);

/** Generator: valid SQL identifier (excludes SQL keywords) */
const arbitraryIdentifier: fc.Arbitrary<string> = fc.tuple(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
  fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')),
    { minLength: 0, maxLength: 12 }
  )
).map(([first, rest]) => first + rest)
  .filter(id => !SQL_KEYWORDS.has(id.toLowerCase()));

/** Generator: schema name (excludes SQL keywords) */
const arbitrarySchema: fc.Arbitrary<string> = fc.oneof(
  fc.constant('dbo'),
  fc.constant('sales'),
  fc.constant('hr'),
  arbitraryIdentifier
).filter(s => !SQL_KEYWORDS.has(s.toLowerCase()));

/** Generator: table name (PascalCase style, excludes SQL keywords) */
const arbitraryTableName: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('Orders', 'Customers', 'Products', 'OrderDetails', 'Employees', 'Invoices', 'Categories', 'Suppliers'),
  fc.tuple(
    fc.constantFrom('Order', 'Customer', 'Product', 'Invoice', 'Employee'),
    fc.constantFrom('Details', 'Items', 'History', 'Log', 'Data')
  ).map(([a, b]) => a + b),
  arbitraryIdentifier
).filter(name => !SQL_KEYWORDS.has(name.toLowerCase()));

/** Generator: column name */
const arbitraryColumnName: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('Id', 'Name', 'CustomerID', 'OrderID', 'ProductID', 'Amount', 'Date', 'Status', 'Email', 'Phone'),
  arbitraryIdentifier
);

/** Generator: data type */
const arbitraryDataType: fc.Arbitrary<string> = fc.constantFrom(
  'int', 'varchar', 'nvarchar', 'datetime', 'bit', 'decimal', 'bigint', 'float', 'uniqueidentifier'
);

/** Generator: ColumnInfo */
const arbitraryColumn: fc.Arbitrary<ColumnInfo> = fc.tuple(
  arbitraryColumnName,
  arbitraryDataType,
  fc.boolean()
).map(([name, dataType, isNullable]) => ({ name, dataType, isNullable }));

/** Generator: array of unique columns (1-6 columns) */
const arbitraryColumns: fc.Arbitrary<ColumnInfo[]> = fc.array(arbitraryColumn, { minLength: 1, maxLength: 6 })
  .map(cols => {
    // Ensure unique column names
    const seen = new Set<string>();
    return cols.filter(c => {
      const lower = c.name.toLowerCase();
      if (seen.has(lower)) return false;
      seen.add(lower);
      return true;
    });
  })
  .filter(cols => cols.length >= 1);

/** Generator: TableInfo with columns */
const arbitraryTableInfo: fc.Arbitrary<TableInfo> = fc.tuple(
  arbitrarySchema,
  arbitraryTableName,
  arbitraryColumns
).map(([schema, name, columns]) => ({ schema, name, columns }));

/** Generator: alias (short lowercase string, excludes SQL keywords) */
const arbitraryAlias: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
  { minLength: 1, maxLength: 4 }
).filter(a => !SQL_KEYWORDS.has(a.toLowerCase()));

// --- Helpers ---

/** Create a mock ISchemaCache */
function createMockSchemaCache(opts: {
  tables?: TableInfo[];
  views?: ViewInfo[];
  foreignKeys?: ForeignKeyInfo[];
  isPopulating?: boolean;
}): ISchemaCache {
  const tables = opts.tables || [];
  const views = opts.views || [];
  const foreignKeys = opts.foreignKeys || [];
  const isPopulating = opts.isPopulating || false;

  const fkIndex = new Map<string, ForeignKeyInfo[]>();
  for (const fk of foreignKeys) {
    const referencingKey = `${fk.referencingSchema}.${fk.referencingTable}`.toLowerCase();
    const referencedKey = `${fk.referencedSchema}.${fk.referencedTable}`.toLowerCase();
    if (!fkIndex.has(referencingKey)) fkIndex.set(referencingKey, []);
    fkIndex.get(referencingKey)!.push(fk);
    if (!fkIndex.has(referencedKey)) fkIndex.set(referencedKey, []);
    fkIndex.get(referencedKey)!.push(fk);
  }

  return {
    tables,
    views,
    procedures: [],
    foreignKeys,
    isPopulating,
    refresh: async () => {},
    getForeignKeysForTable(schema: string, tableName: string): ForeignKeyInfo[] {
      const key = `${schema}.${tableName}`.toLowerCase();
      return fkIndex.get(key) || [];
    },
  };
}

/** Create a TextDocument and Range positioned on the `*` character */
function createDocumentWithStar(sql: string): { document: TextDocument; range: Range } {
  const starIndex = sql.indexOf('*');
  const document = TextDocument.create('file:///test.sql', 'sql', 1, sql);
  const pos = document.positionAt(starIndex);
  const range: Range = { start: pos, end: pos };
  return { document, range };
}

// --- Tests ---

describe('SelectExpander Property Tests', () => {
  describe('Feature: smart-join-generator, Property 14: SELECT * expansion produces correct column list', () => {
    /**
     * Validates: Requirements 10.1, 10.2
     *
     * For any SELECT * query with resolved tables, the expansion SHALL replace `*`
     * with a comma-separated list of all columns from resolved tables in ordinal
     * position order (FROM tables first, then JOIN tables in appearance order),
     * with each column on a separate line.
     */

    it('expansion contains all columns from resolved tables in ordinal order', () => {
      fc.assert(
        fc.property(
          arbitraryTableInfo,
          (tableInfo) => {
            fc.pre(tableInfo.columns.length >= 2);
            // Ensure no column name is a substring of another to avoid indexOf ambiguity
            for (let i = 0; i < tableInfo.columns.length; i++) {
              for (let j = 0; j < tableInfo.columns.length; j++) {
                if (i !== j) {
                  fc.pre(!tableInfo.columns[j].name.includes(tableInfo.columns[i].name));
                }
              }
            }

            const sql = `SELECT * FROM ${tableInfo.schema}.${tableInfo.name}`;
            const { document, range } = createDocumentWithStar(sql);

            const cache = createMockSchemaCache({ tables: [tableInfo] });
            const actions = getExpandStarActions(document, range, cache);

            expect(actions.length).toBe(1);

            const edit = actions[0].edit!;
            const changes = edit.changes!;
            const uri = Object.keys(changes)[0];
            const textEdits = changes[uri];
            const newText = textEdits[0].newText;

            // All columns should appear in the expansion
            for (const col of tableInfo.columns) {
              expect(newText).toContain(col.name);
            }

            // Columns should appear in ordinal order (array order from schema cache)
            // Split by comma to get individual column entries and verify order
            const columnEntries = newText.split(',').map(s => s.trim());
            for (let i = 0; i < tableInfo.columns.length; i++) {
              expect(columnEntries[i]).toBe(tableInfo.columns[i].name);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('FROM tables columns appear before JOIN tables columns', () => {
      fc.assert(
        fc.property(
          arbitraryTableInfo,
          arbitraryTableInfo,
          arbitraryAlias,
          (fromTable, joinTable, joinAlias) => {
            // Ensure distinct tables
            fc.pre(
              fromTable.name.toLowerCase() !== joinTable.name.toLowerCase() ||
              fromTable.schema.toLowerCase() !== joinTable.schema.toLowerCase()
            );
            fc.pre(fromTable.columns.length >= 1);
            fc.pre(joinTable.columns.length >= 1);
            // Ensure distinct aliases from table names
            fc.pre(joinAlias.toLowerCase() !== fromTable.name.toLowerCase());
            fc.pre(joinAlias.toLowerCase() !== joinTable.name.toLowerCase());

            const sql = `SELECT * FROM ${fromTable.schema}.${fromTable.name} JOIN ${joinTable.schema}.${joinTable.name} ${joinAlias} ON 1=1`;
            const { document, range } = createDocumentWithStar(sql);

            const cache = createMockSchemaCache({ tables: [fromTable, joinTable] });
            const actions = getExpandStarActions(document, range, cache);

            expect(actions.length).toBe(1);

            const edit = actions[0].edit!;
            const changes = edit.changes!;
            const uri = Object.keys(changes)[0];
            const textEdits = changes[uri];
            const newText = textEdits[0].newText;

            // With multiple tables, columns are prefixed. Split by comma to get entries.
            const columnEntries = newText.split(',').map(s => s.trim());

            // FROM table columns should come first (count = fromTable.columns.length)
            // JOIN table columns should come after
            const fromCount = fromTable.columns.length;
            const joinCount = joinTable.columns.length;

            expect(columnEntries.length).toBe(fromCount + joinCount);

            // First fromCount entries should be from the FROM table
            for (let i = 0; i < fromCount; i++) {
              // Each entry should contain the FROM table's column name
              expect(columnEntries[i]).toContain(fromTable.columns[i].name);
            }

            // Next joinCount entries should be from the JOIN table
            for (let i = 0; i < joinCount; i++) {
              expect(columnEntries[fromCount + i]).toContain(joinTable.columns[i].name);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('multiple columns are separated by commas with newlines', () => {
      fc.assert(
        fc.property(
          arbitraryTableInfo,
          (tableInfo) => {
            fc.pre(tableInfo.columns.length >= 2);

            const sql = `SELECT * FROM ${tableInfo.schema}.${tableInfo.name}`;
            const { document, range } = createDocumentWithStar(sql);

            const cache = createMockSchemaCache({ tables: [tableInfo] });
            const actions = getExpandStarActions(document, range, cache);

            expect(actions.length).toBe(1);

            const edit = actions[0].edit!;
            const changes = edit.changes!;
            const uri = Object.keys(changes)[0];
            const textEdits = changes[uri];
            const newText = textEdits[0].newText;

            // Multiple columns should be separated by comma+newline
            expect(newText).toContain(',\n');
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Feature: smart-join-generator, Property 15: Column prefixing based on table count', () => {
    /**
     * Validates: Requirements 10.3, 10.4
     *
     * For any SELECT * expansion, when multiple tables are referenced each column
     * SHALL be prefixed with the table alias (or table name if no alias), and when
     * a single table is referenced columns SHALL have no prefix.
     */

    it('single table: columns have no table prefix', () => {
      fc.assert(
        fc.property(
          arbitraryTableInfo,
          (tableInfo) => {
            fc.pre(tableInfo.columns.length >= 1);

            const sql = `SELECT * FROM ${tableInfo.schema}.${tableInfo.name}`;
            const { document, range } = createDocumentWithStar(sql);

            const cache = createMockSchemaCache({ tables: [tableInfo] });
            const actions = getExpandStarActions(document, range, cache);

            expect(actions.length).toBe(1);

            const edit = actions[0].edit!;
            const changes = edit.changes!;
            const uri = Object.keys(changes)[0];
            const textEdits = changes[uri];
            const newText = textEdits[0].newText;

            // Columns should NOT have a table prefix (no dot before column name)
            // Split by comma/newline and check each column entry
            const columnEntries = newText.split(',').map(s => s.trim());
            for (const entry of columnEntries) {
              // Should not contain a dot (no prefix)
              expect(entry).not.toContain('.');
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('multiple tables with aliases: columns prefixed with alias', () => {
      fc.assert(
        fc.property(
          arbitraryTableInfo,
          arbitraryTableInfo,
          arbitraryAlias,
          arbitraryAlias,
          (table1, table2, alias1, alias2) => {
            // Ensure distinct tables
            fc.pre(
              table1.name.toLowerCase() !== table2.name.toLowerCase() ||
              table1.schema.toLowerCase() !== table2.schema.toLowerCase()
            );
            fc.pre(table1.columns.length >= 1);
            fc.pre(table2.columns.length >= 1);
            // Ensure distinct aliases
            fc.pre(alias1.toLowerCase() !== alias2.toLowerCase());

            const sql = `SELECT * FROM ${table1.schema}.${table1.name} ${alias1} JOIN ${table2.schema}.${table2.name} ${alias2} ON 1=1`;
            const { document, range } = createDocumentWithStar(sql);

            const cache = createMockSchemaCache({ tables: [table1, table2] });
            const actions = getExpandStarActions(document, range, cache);

            expect(actions.length).toBe(1);

            const edit = actions[0].edit!;
            const changes = edit.changes!;
            const uri = Object.keys(changes)[0];
            const textEdits = changes[uri];
            const newText = textEdits[0].newText;

            // All column entries should have a dot (prefix.column)
            const columnEntries = newText.split(',').map(s => s.trim());
            for (const entry of columnEntries) {
              expect(entry).toContain('.');
            }

            // Table1 columns should be prefixed with alias1
            for (const col of table1.columns) {
              expect(newText).toContain(`${alias1}.${col.name}`);
            }

            // Table2 columns should be prefixed with alias2
            for (const col of table2.columns) {
              expect(newText).toContain(`${alias2}.${col.name}`);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('multiple tables without aliases: columns prefixed with table name', () => {
      fc.assert(
        fc.property(
          arbitraryTableInfo,
          arbitraryTableInfo,
          (table1, table2) => {
            // Ensure distinct tables
            fc.pre(
              table1.name.toLowerCase() !== table2.name.toLowerCase() ||
              table1.schema.toLowerCase() !== table2.schema.toLowerCase()
            );
            fc.pre(table1.columns.length >= 1);
            fc.pre(table2.columns.length >= 1);
            // Ensure table names are distinct (since no aliases, names are used as prefix)
            fc.pre(table1.name.toLowerCase() !== table2.name.toLowerCase());

            const sql = `SELECT * FROM ${table1.schema}.${table1.name}, ${table2.schema}.${table2.name}`;
            const { document, range } = createDocumentWithStar(sql);

            const cache = createMockSchemaCache({ tables: [table1, table2] });
            const actions = getExpandStarActions(document, range, cache);

            expect(actions.length).toBe(1);

            const edit = actions[0].edit!;
            const changes = edit.changes!;
            const uri = Object.keys(changes)[0];
            const textEdits = changes[uri];
            const newText = textEdits[0].newText;

            // Table1 columns should be prefixed with table1.name
            for (const col of table1.columns) {
              expect(newText).toContain(`${table1.name}.${col.name}`);
            }

            // Table2 columns should be prefixed with table2.name
            for (const col of table2.columns) {
              expect(newText).toContain(`${table2.name}.${col.name}`);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Feature: smart-join-generator, Property 16: Partial table resolution in SELECT * expansion', () => {
    /**
     * Validates: Requirements 10.5
     *
     * For any query where some referenced tables are in the schema cache and some
     * are not, the expansion SHALL include columns only from resolved tables and
     * skip unresolved ones.
     */

    it('only resolved tables columns are included in expansion', () => {
      fc.assert(
        fc.property(
          arbitraryTableInfo,
          arbitraryTableName,
          (resolvedTable, unresolvedName) => {
            fc.pre(resolvedTable.columns.length >= 1);
            // Ensure unresolved table name is different from resolved
            fc.pre(resolvedTable.name.toLowerCase() !== unresolvedName.toLowerCase());

            // Use fixed, non-overlapping aliases to avoid substring issues
            const alias1 = 'res';
            const alias2 = 'unr';

            const sql = `SELECT * FROM ${resolvedTable.schema}.${resolvedTable.name} ${alias1} JOIN dbo.${unresolvedName} ${alias2} ON 1=1`;
            const { document, range } = createDocumentWithStar(sql);

            // Only include the resolved table in the cache
            const cache = createMockSchemaCache({ tables: [resolvedTable] });
            const actions = getExpandStarActions(document, range, cache);

            // Should still offer the code action (at least one table resolved)
            expect(actions.length).toBe(1);

            const edit = actions[0].edit!;
            const changes = edit.changes!;
            const uri = Object.keys(changes)[0];
            const textEdits = changes[uri];
            const newText = textEdits[0].newText;

            // Resolved table columns should be present
            for (const col of resolvedTable.columns) {
              expect(newText).toContain(col.name);
            }

            // Since only one table is resolved, it's treated as single-table expansion
            // (no prefix) OR if the code considers both refs, it uses alias prefix.
            // The key property: unresolved table's alias should NOT appear as a prefix
            // Check that no column entry starts with the unresolved alias
            const columnEntries = newText.split(',').map(s => s.trim());
            for (const entry of columnEntries) {
              expect(entry.startsWith(`${alias2}.`)).toBe(false);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('no code action when all tables are unresolved', () => {
      fc.assert(
        fc.property(
          arbitraryTableName,
          arbitraryTableName,
          (table1, table2) => {
            const sql = `SELECT * FROM dbo.${table1} JOIN dbo.${table2} ON 1=1`;
            const { document, range } = createDocumentWithStar(sql);

            // Empty cache — no tables resolved
            const cache = createMockSchemaCache({ tables: [] });
            const actions = getExpandStarActions(document, range, cache);

            // No code action should be offered
            expect(actions.length).toBe(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('expansion with mix of resolved and unresolved tables only includes resolved columns', () => {
      fc.assert(
        fc.property(
          arbitraryTableInfo,
          arbitraryTableInfo,
          arbitraryTableName,
          (resolved1, resolved2, unresolvedName) => {
            // Ensure all tables are distinct
            fc.pre(
              resolved1.name.toLowerCase() !== resolved2.name.toLowerCase() ||
              resolved1.schema.toLowerCase() !== resolved2.schema.toLowerCase()
            );
            fc.pre(resolved1.name.toLowerCase() !== unresolvedName.toLowerCase());
            fc.pre(resolved2.name.toLowerCase() !== unresolvedName.toLowerCase());
            fc.pre(resolved1.columns.length >= 1);
            fc.pre(resolved2.columns.length >= 1);

            const sql = `SELECT * FROM ${resolved1.schema}.${resolved1.name} JOIN ${resolved2.schema}.${resolved2.name} ON 1=1 JOIN dbo.${unresolvedName} ON 1=1`;
            const { document, range } = createDocumentWithStar(sql);

            const cache = createMockSchemaCache({ tables: [resolved1, resolved2] });
            const actions = getExpandStarActions(document, range, cache);

            expect(actions.length).toBe(1);

            const edit = actions[0].edit!;
            const changes = edit.changes!;
            const uri = Object.keys(changes)[0];
            const textEdits = changes[uri];
            const newText = textEdits[0].newText;

            // Both resolved tables' columns should be present
            for (const col of resolved1.columns) {
              expect(newText).toContain(col.name);
            }
            for (const col of resolved2.columns) {
              expect(newText).toContain(col.name);
            }

            // Total column count should match resolved tables only
            const commaCount = (newText.match(/,/g) || []).length;
            const totalCols = resolved1.columns.length + resolved2.columns.length;
            // commas = totalCols - 1 (for comma-separated list)
            expect(commaCount).toBe(totalCols - 1);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
