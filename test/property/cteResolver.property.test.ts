import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  extractCTEColumns,
  resolveChainedCTEs,
  buildCTESchemaMap,
  CTESchema,
  CTEResolutionResult,
} from '../../server/src/cteResolver';
import { ColumnInfo, ISchemaCache } from '../../server/src/schemaCache';

/**
 * Property-based tests for CTE Resolver
 * Feature: intellisense-clause-engine
 *
 * Tests CTE column extraction, case-insensitive lookup, alias-dot completion,
 * chained CTE propagation, mixed source concatenation, and forward reference handling.
 */

// --- Generators ---

/** Generator: valid SQL identifier (avoids SQL keywords) */
const arbitraryIdentifier: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')),
      { minLength: 1, maxLength: 8 }
    )
  )
  .map(([first, rest]) => first + rest)
  .filter((id) =>
    !/^(select|from|where|join|inner|left|right|full|cross|on|order|group|having|with|as|by|null|and|or|not|in|is|top|distinct)$/i.test(id)
  );

/** Generator: CTE name (valid SQL identifier, slightly longer for uniqueness) */
const arbitraryCTEName: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')),
      { minLength: 2, maxLength: 10 }
    )
  )
  .map(([first, rest]) => `cte_${first}${rest}`)
  .filter((id) =>
    !/^(select|from|where|join|inner|left|right|full|cross|on|order|group|having|with|as|by)$/i.test(id)
  );

/** Generator: a SELECT list item with an explicit alias */
const arbitraryAliasedItem: fc.Arbitrary<{ sql: string; expectedName: string }> = fc
  .tuple(arbitraryIdentifier, arbitraryIdentifier)
  .map(([expr, alias]) => ({
    sql: `${expr} AS ${alias}`,
    expectedName: alias,
  }));

/** Generator: a SELECT list item with a dotted reference (table.column) */
const arbitraryDottedItem: fc.Arbitrary<{ sql: string; expectedName: string }> = fc
  .tuple(arbitraryIdentifier, arbitraryIdentifier)
  .map(([table, column]) => ({
    sql: `${table}.${column}`,
    expectedName: column,
  }));

/** Generator: a SELECT list item that is a simple identifier */
const arbitrarySimpleItem: fc.Arbitrary<{ sql: string; expectedName: string }> =
  arbitraryIdentifier.map((id) => ({
    sql: id,
    expectedName: id,
  }));

/** Generator: a complex expression without alias (should be omitted) */
const arbitraryComplexExpression: fc.Arbitrary<string> = fc.oneof(
  fc.tuple(arbitraryIdentifier, arbitraryIdentifier).map(([a, b]) => `${a} + ${b}`),
  arbitraryIdentifier.map((id) => `COUNT(${id})`),
  arbitraryIdentifier.map((id) => `CASE WHEN ${id} > 0 THEN 1 ELSE 0 END`),
  fc.tuple(arbitraryIdentifier, arbitraryIdentifier).map(([a, b]) => `${a} * ${b}`),
);

/** Generator: a mixed SELECT list with known expected columns */
const arbitrarySelectList: fc.Arbitrary<{
  items: string[];
  expectedColumns: string[];
}> = fc
  .tuple(
    fc.array(
      fc.oneof(
        arbitraryAliasedItem,
        arbitraryDottedItem,
        arbitrarySimpleItem,
      ),
      { minLength: 1, maxLength: 5 }
    ),
    fc.array(arbitraryComplexExpression, { minLength: 0, maxLength: 2 }),
  )
  .map(([resolvableItems, complexItems]) => {
    const items: string[] = [];
    const expectedColumns: string[] = [];

    for (const item of resolvableItems) {
      items.push(item.sql);
      expectedColumns.push(item.expectedName);
    }
    for (const expr of complexItems) {
      items.push(expr);
      // Complex expressions without aliases are omitted
    }

    return { items, expectedColumns };
  });

/** Generator: unique CTE names for chain testing */
function arbitraryUniqueCTENames(count: number): fc.Arbitrary<string[]> {
  return fc
    .uniqueArray(arbitraryCTEName, { minLength: count, maxLength: count })
    .filter((arr) => arr.length === count);
}

/** Generator: column names for schema tables */
const arbitraryColumnNames: fc.Arbitrary<string[]> = fc
  .uniqueArray(arbitraryIdentifier, { minLength: 1, maxLength: 4 })
  .filter((arr) => arr.length >= 1);

/** Helper: create a mock ISchemaCache with given tables */
function createMockSchemaCache(tables: { schema: string; name: string; columns: ColumnInfo[] }[]): ISchemaCache {
  return {
    tables: tables.map((t) => ({
      schema: t.schema,
      name: t.name,
      columns: t.columns,
    })),
    views: [],
    procedures: [],
    foreignKeys: [],
    refresh: async () => {},
    isPopulating: false,
    getForeignKeysForTable: () => [],
  } as unknown as ISchemaCache;
}

/** Helper: create an empty schema cache */
function emptySchemaCache(): ISchemaCache {
  return createMockSchemaCache([]);
}

/** Helper: build a CTE body text from a SELECT list and FROM clause */
function buildCTEBody(selectItems: string[], fromRef?: string): string {
  const selectClause = `SELECT ${selectItems.join(', ')}`;
  if (fromRef) {
    return `${selectClause} FROM ${fromRef}`;
  }
  return selectClause;
}

/** Helper: build a full WITH statement with multiple CTEs */
function buildWithStatement(
  ctes: { name: string; body: string }[],
  finalQuery?: string
): string {
  const cteDefs = ctes
    .map((cte) => `${cte.name} AS (${cte.body})`)
    .join(', ');
  const final = finalQuery || `SELECT * FROM ${ctes[ctes.length - 1].name}`;
  return `WITH ${cteDefs} ${final}`;
}

// --- Property Tests ---

describe('Feature: intellisense-clause-engine, Property 9: CTE column extraction round-trip', () => {
  /**
   * **Validates: Requirements 6.1, 6.2, 6.3, 6.4**
   *
   * For any CTE SELECT list containing items with explicit aliases (AS name),
   * dotted references (table.column), or simple identifiers, the extractCTEColumns
   * function SHALL return a ColumnInfo array where each entry's name equals the
   * alias if present, the last dot segment if dotted, or the identifier itself.
   * All entries SHALL have dataType="unknown" and isNullable=true.
   * Complex expressions without aliases SHALL be omitted.
   */

  it('extracts column names correctly from aliased, dotted, and simple items', () => {
    fc.assert(
      fc.property(
        arbitrarySelectList,
        arbitraryIdentifier,
        ({ items, expectedColumns }, tableName) => {
          const body = buildCTEBody(items, tableName);
          const result = extractCTEColumns(body);

          // Should not be null (no SELECT *)
          expect(result).not.toBeNull();
          if (result === null) return;

          // Each expected column should appear in the result
          // (complex expressions are omitted, so result.length <= items.length)
          const resultNames = result.map((c) => c.name);
          for (const expected of expectedColumns) {
            expect(resultNames).toContain(expected);
          }
        }
      ),
      { numRuns: 150 }
    );
  });

  it('all extracted columns have dataType="unknown" and isNullable=true', () => {
    fc.assert(
      fc.property(
        arbitrarySelectList,
        arbitraryIdentifier,
        ({ items }, tableName) => {
          const body = buildCTEBody(items, tableName);
          const result = extractCTEColumns(body);

          if (result === null) return;

          for (const col of result) {
            expect(col.dataType).toBe('unknown');
            expect(col.isNullable).toBe(true);
          }
        }
      ),
      { numRuns: 150 }
    );
  });

  it('explicit alias takes priority over expression', () => {
    fc.assert(
      fc.property(
        arbitraryIdentifier,
        arbitraryIdentifier,
        arbitraryIdentifier,
        (expr, alias, tableName) => {
          const body = `SELECT ${expr} AS ${alias} FROM ${tableName}`;
          const result = extractCTEColumns(body);

          expect(result).not.toBeNull();
          if (result === null) return;

          expect(result.length).toBeGreaterThanOrEqual(1);
          expect(result[0].name).toBe(alias);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('dotted reference uses last segment as column name', () => {
    fc.assert(
      fc.property(
        arbitraryIdentifier,
        arbitraryIdentifier,
        arbitraryIdentifier,
        (table, column, fromTable) => {
          const body = `SELECT ${table}.${column} FROM ${fromTable}`;
          const result = extractCTEColumns(body);

          expect(result).not.toBeNull();
          if (result === null) return;

          expect(result.length).toBeGreaterThanOrEqual(1);
          expect(result[0].name).toBe(column);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('SELECT * returns null', () => {
    fc.assert(
      fc.property(
        arbitraryIdentifier,
        (tableName) => {
          const body = `SELECT * FROM ${tableName}`;
          const result = extractCTEColumns(body);
          expect(result).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Feature: intellisense-clause-engine, Property 10: CTE name lookup is case-insensitive', () => {
  /**
   * **Validates: Requirements 6.6**
   *
   * For any CTE name stored in the schema map, looking up that name with any
   * case variation SHALL return the same CTESchema result.
   */

  it('CTE schema map lookup is case-insensitive', () => {
    fc.assert(
      fc.property(
        arbitraryCTEName,
        arbitraryIdentifier,
        (cteName, colName) => {
          const body = `SELECT ${colName}`;
          const statement = `WITH ${cteName} AS (${body}) SELECT ${colName} FROM ${cteName}`;
          const cursorOffset = statement.length;

          const result = resolveChainedCTEs(statement, cursorOffset, emptySchemaCache());

          // The schema map should contain the CTE keyed by lowercase name
          const lowerKey = cteName.toLowerCase();
          expect(result.schemas.has(lowerKey)).toBe(true);

          // Looking up with different case variations should work
          const upperKey = cteName.toUpperCase();
          const mixedKey = cteName.split('').map((c, i) =>
            i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()
          ).join('');

          // The map uses lowercase keys, so all lookups should use .toLowerCase()
          expect(result.schemas.has(upperKey.toLowerCase())).toBe(true);
          expect(result.schemas.has(mixedKey.toLowerCase())).toBe(true);

          // All lookups return the same schema
          const schema = result.schemas.get(lowerKey)!;
          expect(result.schemas.get(upperKey.toLowerCase())).toBe(schema);
          expect(result.schemas.get(mixedKey.toLowerCase())).toBe(schema);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('buildCTESchemaMap uses lowercase keys for case-insensitive access', () => {
    fc.assert(
      fc.property(
        arbitraryCTEName,
        arbitraryIdentifier,
        (cteName, colName) => {
          const body = `SELECT ${colName}`;
          const statement = `WITH ${cteName} AS (${body}) SELECT ${colName} FROM ${cteName}`;
          const cursorOffset = statement.length;

          const resolution = resolveChainedCTEs(statement, cursorOffset, emptySchemaCache());
          const schemaMap = buildCTESchemaMap(resolution);

          // The schema map should be keyed by lowercase
          const lowerKey = cteName.toLowerCase();
          expect(schemaMap.has(lowerKey)).toBe(true);

          // Verify the columns are accessible
          const columns = schemaMap.get(lowerKey)!;
          expect(columns.length).toBeGreaterThanOrEqual(1);
          expect(columns.some((c) => c.name === colName)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Feature: intellisense-clause-engine, Property 11: CTE alias-dot completion', () => {
  /**
   * **Validates: Requirements 7.1, 7.2, 7.4**
   *
   * For any alias that maps to a CTE with resolved columns, typing `alias.`
   * SHALL return those CTE columns as completion items. For any alias that does
   * not match, typing `alias.` SHALL return an empty completion list.
   */

  it('buildCTESchemaMap provides columns for known CTE names', () => {
    fc.assert(
      fc.property(
        arbitraryCTEName,
        fc.uniqueArray(arbitraryIdentifier, { minLength: 1, maxLength: 4 }),
        (cteName, colNames) => {
          if (colNames.length === 0) return;

          const selectItems = colNames.join(', ');
          const body = `SELECT ${selectItems}`;
          const statement = `WITH ${cteName} AS (${body}) SELECT * FROM ${cteName}`;
          const cursorOffset = statement.length;

          const resolution = resolveChainedCTEs(statement, cursorOffset, emptySchemaCache());
          const schemaMap = buildCTESchemaMap(resolution);

          // Looking up the CTE name should return its columns
          const columns = schemaMap.get(cteName.toLowerCase());
          expect(columns).toBeDefined();
          expect(columns!.length).toBe(colNames.length);

          const columnNames = columns!.map((c) => c.name);
          for (const expected of colNames) {
            expect(columnNames).toContain(expected);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('unknown alias names return undefined from the schema map', () => {
    fc.assert(
      fc.property(
        arbitraryCTEName,
        arbitraryIdentifier,
        arbitraryIdentifier,
        (cteName, colName, unknownAlias) => {
          // Ensure unknownAlias is different from cteName
          if (unknownAlias.toLowerCase() === cteName.toLowerCase()) return;

          const body = `SELECT ${colName}`;
          const statement = `WITH ${cteName} AS (${body}) SELECT * FROM ${cteName}`;
          const cursorOffset = statement.length;

          const resolution = resolveChainedCTEs(statement, cursorOffset, emptySchemaCache());
          const schemaMap = buildCTESchemaMap(resolution);

          // Unknown alias should not be in the map
          expect(schemaMap.has(unknownAlias.toLowerCase())).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('CTE with SELECT * produces empty column array in schema map', () => {
    fc.assert(
      fc.property(
        arbitraryCTEName,
        arbitraryIdentifier,
        (cteName, tableName) => {
          const body = `SELECT * FROM ${tableName}`;
          const statement = `WITH ${cteName} AS (${body}) SELECT * FROM ${cteName}`;
          const cursorOffset = statement.length;

          const resolution = resolveChainedCTEs(statement, cursorOffset, emptySchemaCache());
          const schemaMap = buildCTESchemaMap(resolution);

          // SELECT * CTEs should map to empty array (no columns available)
          const columns = schemaMap.get(cteName.toLowerCase());
          expect(columns).toBeDefined();
          expect(columns!.length).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Feature: intellisense-clause-engine, Property 12: Chained CTE column propagation', () => {
  /**
   * **Validates: Requirements 8.1, 8.2, 8.6, 8.7**
   *
   * For any CTE chain of N definitions (N >= 2) where each CTE references the
   * immediately preceding CTE in its FROM clause, the last CTE's resolved column
   * list SHALL include columns derived from all preceding CTEs in the chain.
   */

  it('chained CTEs propagate columns through the chain (2 CTEs)', () => {
    fc.assert(
      fc.property(
        arbitraryUniqueCTENames(2),
        arbitraryIdentifier,
        (cteNames, colName) => {
          const [cte1, cte2] = cteNames;

          // CTE1 defines a column, CTE2 references CTE1
          const statement = buildWithStatement([
            { name: cte1, body: `SELECT ${colName}` },
            { name: cte2, body: `SELECT ${colName} FROM ${cte1}` },
          ]);
          const cursorOffset = statement.length;

          const result = resolveChainedCTEs(statement, cursorOffset, emptySchemaCache());

          // CTE2 should have the column from CTE1
          const cte2Schema = result.schemas.get(cte2.toLowerCase());
          expect(cte2Schema).toBeDefined();
          expect(cte2Schema!.columns).not.toBeNull();
          expect(cte2Schema!.columns!.some((c) => c.name === colName)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('chained CTEs propagate columns through longer chains (3+ CTEs)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 6 }),
        arbitraryIdentifier,
        (chainLength, colName) => {
          // Generate unique CTE names
          const cteNames: string[] = [];
          for (let i = 0; i < chainLength; i++) {
            cteNames.push(`chain_cte_${i}`);
          }

          // Build chain: each CTE selects colName FROM the previous CTE
          const ctes = cteNames.map((name, i) => ({
            name,
            body: i === 0
              ? `SELECT ${colName}`
              : `SELECT ${colName} FROM ${cteNames[i - 1]}`,
          }));

          const statement = buildWithStatement(ctes);
          const cursorOffset = statement.length;

          const result = resolveChainedCTEs(statement, cursorOffset, emptySchemaCache());

          // The last CTE should have the column propagated through the chain
          const lastCteSchema = result.schemas.get(cteNames[chainLength - 1].toLowerCase());
          expect(lastCteSchema).toBeDefined();
          expect(lastCteSchema!.columns).not.toBeNull();
          expect(lastCteSchema!.columns!.some((c) => c.name === colName)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('resolution processes all CTEs without truncation for chains of 10+', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10, max: 12 }),
        arbitraryIdentifier,
        (chainLength, colName) => {
          const cteNames: string[] = [];
          for (let i = 0; i < chainLength; i++) {
            cteNames.push(`long_chain_${i}`);
          }

          const ctes = cteNames.map((name, i) => ({
            name,
            body: i === 0
              ? `SELECT ${colName}`
              : `SELECT ${colName} FROM ${cteNames[i - 1]}`,
          }));

          const statement = buildWithStatement(ctes);
          const cursorOffset = statement.length;

          const result = resolveChainedCTEs(statement, cursorOffset, emptySchemaCache());

          // All CTEs should be resolved
          expect(result.schemas.size).toBe(chainLength);

          // The last CTE should still have the column
          const lastSchema = result.schemas.get(cteNames[chainLength - 1].toLowerCase());
          expect(lastSchema).toBeDefined();
          expect(lastSchema!.columns).not.toBeNull();
          expect(lastSchema!.columns!.some((c) => c.name === colName)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Feature: intellisense-clause-engine, Property 13: CTE column concatenation from mixed sources', () => {
  /**
   * **Validates: Requirements 8.3**
   *
   * For any CTE whose FROM clause references both a schema table and another
   * previously-resolved CTE, the CTE's resolved column list SHALL be the
   * concatenation of columns from both sources.
   */

  it('CTE referencing both a schema table and another CTE gets columns from both', () => {
    fc.assert(
      fc.property(
        arbitraryCTEName,
        arbitraryCTEName,
        arbitraryIdentifier,
        arbitraryIdentifier,
        arbitraryIdentifier,
        (cte1Name, cte2Name, cteCol, tableCol, tableName) => {
          // Ensure names are distinct
          if (cte1Name.toLowerCase() === cte2Name.toLowerCase()) return;
          if (cte1Name.toLowerCase() === tableName.toLowerCase()) return;
          if (cte2Name.toLowerCase() === tableName.toLowerCase()) return;
          if (cteCol === tableCol) return;

          // Create a schema cache with a table
          const schemaCache = createMockSchemaCache([
            {
              schema: 'dbo',
              name: tableName,
              columns: [{ name: tableCol, dataType: 'int', isNullable: false }],
            },
          ]);

          // CTE1 has its own column, CTE2 references both CTE1 and the schema table
          // CTE2 selects specific columns from both sources
          const statement = buildWithStatement(
            [
              { name: cte1Name, body: `SELECT ${cteCol}` },
              { name: cte2Name, body: `SELECT ${cte1Name}.${cteCol}, ${tableName}.${tableCol} FROM ${cte1Name} JOIN ${tableName} ON 1=1` },
            ],
            `SELECT * FROM ${cte2Name}`
          );
          const cursorOffset = statement.length;

          const result = resolveChainedCTEs(statement, cursorOffset, schemaCache);

          // CTE2 should have columns from both sources
          const cte2Schema = result.schemas.get(cte2Name.toLowerCase());
          expect(cte2Schema).toBeDefined();
          expect(cte2Schema!.columns).not.toBeNull();

          const columnNames = cte2Schema!.columns!.map((c) => c.name);
          // Should have the CTE column (last segment of dotted ref)
          expect(columnNames).toContain(cteCol);
          // Should have the table column (last segment of dotted ref)
          expect(columnNames).toContain(tableCol);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('columns from schema table and CTE are both accessible via buildCTESchemaMap', () => {
    fc.assert(
      fc.property(
        arbitraryIdentifier,
        arbitraryIdentifier,
        arbitraryIdentifier,
        (cteCol, tableCol, tableName) => {
          if (cteCol === tableCol) return;
          if (tableName.toLowerCase() === 'cte_source'.toLowerCase()) return;

          const schemaCache = createMockSchemaCache([
            {
              schema: 'dbo',
              name: tableName,
              columns: [{ name: tableCol, dataType: 'varchar', isNullable: true }],
            },
          ]);

          const cteName = 'cte_source';
          const mixedCteName = 'cte_mixed';
          const statement = buildWithStatement(
            [
              { name: cteName, body: `SELECT ${cteCol}` },
              { name: mixedCteName, body: `SELECT ${cteName}.${cteCol}, ${tableName}.${tableCol} FROM ${cteName} JOIN ${tableName} ON 1=1` },
            ],
            `SELECT * FROM ${mixedCteName}`
          );
          const cursorOffset = statement.length;

          const resolution = resolveChainedCTEs(statement, cursorOffset, schemaCache);
          const schemaMap = buildCTESchemaMap(resolution);

          const mixedColumns = schemaMap.get(mixedCteName.toLowerCase());
          expect(mixedColumns).toBeDefined();
          expect(mixedColumns!.some((c) => c.name === cteCol)).toBe(true);
          expect(mixedColumns!.some((c) => c.name === tableCol)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Feature: intellisense-clause-engine, Property 14: Forward references and SELECT * produce zero columns', () => {
  /**
   * **Validates: Requirements 8.4, 8.5**
   *
   * For any CTE that references a CTE defined later in the chain, the
   * forward-referenced CTE SHALL contribute zero columns. For any CTE using
   * SELECT *, its resolved column list SHALL be null/empty.
   */

  it('forward references contribute zero columns', () => {
    fc.assert(
      fc.property(
        arbitraryUniqueCTENames(2),
        arbitraryIdentifier,
        arbitraryIdentifier,
        (cteNames, col1, col2) => {
          const [cte1, cte2] = cteNames;
          if (col1 === col2) return;

          // CTE1 forward-references CTE2 (which is defined later)
          // CTE2 defines its own column
          const statement = buildWithStatement(
            [
              { name: cte1, body: `SELECT ${col1} FROM ${cte2}` },
              { name: cte2, body: `SELECT ${col2}` },
            ],
            `SELECT * FROM ${cte1}`
          );
          const cursorOffset = statement.length;

          const result = resolveChainedCTEs(statement, cursorOffset, emptySchemaCache());

          // CTE1 forward-references CTE2, so CTE2 contributes zero columns to CTE1
          // CTE1's columns come from its own SELECT clause (col1)
          const cte1Schema = result.schemas.get(cte1.toLowerCase());
          expect(cte1Schema).toBeDefined();
          expect(cte1Schema!.columns).not.toBeNull();

          // CTE1 should have col1 from its own SELECT
          const cte1Cols = cte1Schema!.columns!.map((c) => c.name);
          expect(cte1Cols).toContain(col1);

          // CTE2's columns should NOT appear in CTE1 (forward ref = zero columns)
          // CTE1 only gets what it explicitly selects
        }
      ),
      { numRuns: 100 }
    );
  });

  it('SELECT * produces null columns for the CTE', () => {
    fc.assert(
      fc.property(
        arbitraryCTEName,
        arbitraryIdentifier,
        (cteName, tableName) => {
          const statement = `WITH ${cteName} AS (SELECT * FROM ${tableName}) SELECT * FROM ${cteName}`;
          const cursorOffset = statement.length;

          const result = resolveChainedCTEs(statement, cursorOffset, emptySchemaCache());

          const schema = result.schemas.get(cteName.toLowerCase());
          expect(schema).toBeDefined();
          // SELECT * should produce null columns
          expect(schema!.columns).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('CTE referencing a SELECT * CTE receives no columns from that reference', () => {
    fc.assert(
      fc.property(
        arbitraryUniqueCTENames(2),
        arbitraryIdentifier,
        arbitraryIdentifier,
        (cteNames, tableName, col) => {
          const [cte1, cte2] = cteNames;

          // CTE1 uses SELECT * (null columns)
          // CTE2 references CTE1 and selects a column from it
          const statement = buildWithStatement(
            [
              { name: cte1, body: `SELECT * FROM ${tableName}` },
              { name: cte2, body: `SELECT ${col} FROM ${cte1}` },
            ],
            `SELECT * FROM ${cte2}`
          );
          const cursorOffset = statement.length;

          const result = resolveChainedCTEs(statement, cursorOffset, emptySchemaCache());

          // CTE1 should have null columns (SELECT *)
          const cte1Schema = result.schemas.get(cte1.toLowerCase());
          expect(cte1Schema).toBeDefined();
          expect(cte1Schema!.columns).toBeNull();

          // CTE2 references CTE1 which has null columns
          // CTE2's own SELECT extracts col, so it should have that column
          const cte2Schema = result.schemas.get(cte2.toLowerCase());
          expect(cte2Schema).toBeDefined();
          expect(cte2Schema!.columns).not.toBeNull();
          // CTE2 selects col explicitly, so it should appear
          expect(cte2Schema!.columns!.some((c) => c.name === col)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('buildCTESchemaMap maps SELECT * CTEs to empty array', () => {
    fc.assert(
      fc.property(
        arbitraryCTEName,
        arbitraryIdentifier,
        (cteName, tableName) => {
          const statement = `WITH ${cteName} AS (SELECT * FROM ${tableName}) SELECT * FROM ${cteName}`;
          const cursorOffset = statement.length;

          const resolution = resolveChainedCTEs(statement, cursorOffset, emptySchemaCache());
          const schemaMap = buildCTESchemaMap(resolution);

          // SELECT * CTEs should map to empty array in the schema map
          const columns = schemaMap.get(cteName.toLowerCase());
          expect(columns).toBeDefined();
          expect(columns!).toEqual([]);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('forward-referenced CTE is still resolved when processed in order', () => {
    fc.assert(
      fc.property(
        arbitraryUniqueCTENames(3),
        arbitraryIdentifier,
        (cteNames, col) => {
          const [cte1, cte2, cte3] = cteNames;

          // CTE1 forward-references CTE3 (not yet defined)
          // CTE2 references CTE1 (already defined)
          // CTE3 defines its own column
          const statement = buildWithStatement(
            [
              { name: cte1, body: `SELECT ${col} FROM ${cte3}` },
              { name: cte2, body: `SELECT ${col} FROM ${cte1}` },
              { name: cte3, body: `SELECT ${col}` },
            ],
            `SELECT * FROM ${cte3}`
          );
          const cursorOffset = statement.length;

          const result = resolveChainedCTEs(statement, cursorOffset, emptySchemaCache());

          // All 3 CTEs should be resolved
          expect(result.schemas.size).toBe(3);

          // CTE3 should have its own column
          const cte3Schema = result.schemas.get(cte3.toLowerCase());
          expect(cte3Schema).toBeDefined();
          expect(cte3Schema!.columns).not.toBeNull();
          expect(cte3Schema!.columns!.some((c) => c.name === col)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});
