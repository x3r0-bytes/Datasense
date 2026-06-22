import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { getCompletions, detectContext, detectJoinContext, extractTableReferences } from '../../server/src/completionProvider';
import { ISchemaCache, TableInfo, ViewInfo, ProcedureInfo, ColumnInfo } from '../../server/src/schemaCache';
import * as mssql from 'mssql';

/**
 * Property-based tests for completion provider (Properties 6-10)
 * Feature: sql-server-extension
 *
 * Validates: Requirements 2.3, 2.4, 2.5, 2.7, 2.8, 2.11
 */

// --- Helpers ---

function createMockSchemaCache(options: {
  tables?: TableInfo[];
  views?: ViewInfo[];
  procedures?: ProcedureInfo[];
  isPopulating?: boolean;
}): ISchemaCache {
  return {
    tables: options.tables ?? [],
    views: options.views ?? [],
    procedures: options.procedures ?? [],
    foreignKeys: [],
    isPopulating: options.isPopulating ?? false,
    refresh: async (_pool: mssql.ConnectionPool) => {},
    getForeignKeysForTable: (_schema: string, _tableName: string) => [],
  };
}

// --- Generators ---

/** Generator: random valid SQL identifier (starts with letter/underscore, alphanumeric) */
const arbitraryIdentifier: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')),
      { minLength: 1, maxLength: 15 }
    )
  )
  .map(([first, rest]) => first + rest)
  // Exclude SQL keywords that would confuse the parser
  .filter((id) => !/^(select|from|where|join|inner|left|right|full|cross|on|order|group|having|exec|execute|insert|update|delete|create|alter|drop|begin|end|if|else|while|return|declare|set|union|all|except|intersect|into|values|as|and|or|not|in|exists|between|like|is|null|case|when|then|distinct|top|with|go|use|print)$/i.test(id));

/** Generator: random schema name */
const arbitrarySchemaName: fc.Arbitrary<string> = fc.constantFrom('dbo', 'sales', 'hr', 'admin', 'app', 'staging');

/** Generator: random SQL data type */
const arbitraryDataType: fc.Arbitrary<string> = fc.constantFrom(
  'int', 'bigint', 'smallint', 'tinyint', 'bit',
  'varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext',
  'decimal', 'numeric', 'float', 'real', 'money',
  'datetime', 'datetime2', 'date', 'time', 'datetimeoffset',
  'uniqueidentifier', 'varbinary', 'xml'
);

/** Generator: random column info */
const arbitraryColumnInfo: fc.Arbitrary<ColumnInfo> = fc.record({
  name: arbitraryIdentifier,
  dataType: arbitraryDataType,
  isNullable: fc.boolean(),
});

/** Generator: random table info with unique column names */
const arbitraryTableInfo: fc.Arbitrary<TableInfo> = fc.record({
  schema: arbitrarySchemaName,
  name: arbitraryIdentifier,
  columns: fc.array(arbitraryColumnInfo, { minLength: 1, maxLength: 6 })
    .map((cols) => {
      // Ensure unique column names within a table
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

/** Generator: random view info with unique column names */
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

/** Generator: random procedure info */
const arbitraryProcedureInfo: fc.Arbitrary<ProcedureInfo> = fc.record({
  schema: arbitrarySchemaName,
  name: arbitraryIdentifier,
});

/** Generator: random schema cache with tables, views, and procedures */
const arbitrarySchemaCache: fc.Arbitrary<ISchemaCache> = fc
  .record({
    tables: fc.array(arbitraryTableInfo, { minLength: 1, maxLength: 5 }),
    views: fc.array(arbitraryViewInfo, { minLength: 0, maxLength: 3 }),
    procedures: fc.array(arbitraryProcedureInfo, { minLength: 1, maxLength: 5 }),
  })
  .map((data) => createMockSchemaCache(data));

/** Generator: random prefix string for filtering tests (lowercase letters only for simplicity) */
const arbitraryPrefix: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
  { minLength: 1, maxLength: 5 }
);

// --- Tests ---

describe('Completion Provider Property Tests', () => {
  describe('Property 6: FROM/JOIN completion context returns tables and views', () => {
    /**
     * Validates: Requirements 2.3, 2.8
     *
     * For any SQL fragment where the cursor is positioned after a FROM or JOIN
     * clause keyword, the completion provider SHALL return all table names and
     * view names from the schema cache with their schema prefixes.
     */

    it('FROM context returns all tables and views with schema prefixes', () => {
      fc.assert(
        fc.property(arbitrarySchemaCache, (schemaCache) => {
          const text = 'SELECT * FROM ';
          const items = getCompletions(text, text.length, schemaCache, true);

          const labels = items.map((i) => i.label as string);

          // Every table should appear as schema.name
          for (const table of schemaCache.tables) {
            const expected = `${table.schema}.${table.name}`;
            expect(labels).toContain(expected);
          }

          // Every view should appear as schema.name
          for (const view of schemaCache.views) {
            const expected = `${view.schema}.${view.name}`;
            expect(labels).toContain(expected);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('JOIN context returns all tables and views with schema prefixes', () => {
      fc.assert(
        fc.property(arbitrarySchemaCache, (schemaCache) => {
          // Use a table from the cache to make a valid FROM clause
          const firstTable = schemaCache.tables[0];
          const text = `SELECT * FROM ${firstTable.schema}.${firstTable.name} t1 JOIN `;
          const items = getCompletions(text, text.length, schemaCache, true);

          const labels = items.map((i) => i.label as string);

          // Every table should appear
          for (const table of schemaCache.tables) {
            const expected = `${table.schema}.${table.name}`;
            expect(labels).toContain(expected);
          }

          // Every view should appear
          for (const view of schemaCache.views) {
            const expected = `${view.schema}.${view.name}`;
            expect(labels).toContain(expected);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('FROM/JOIN context returns tables, views, and contextual keywords (no procedures)', () => {
      fc.assert(
        fc.property(arbitrarySchemaCache, (schemaCache) => {
          const text = 'SELECT * FROM ';
          const items = getCompletions(text, text.length, schemaCache, true);

          // All items should have detail of 'Table', 'View', 'Keyword', or 'Snippet' (contextual keywords + snippets)
          // No procedures should appear in FROM context
          for (const item of items) {
            expect(['Table', 'View', 'Keyword', 'Snippet']).toContain(item.detail);
          }
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 7: Column completions from referenced tables', () => {
    /**
     * Validates: Requirements 2.4
     *
     * For any SQL query containing one or more table references in FROM/JOIN
     * clauses, when the cursor is positioned in a SELECT, WHERE, ORDER BY, or
     * GROUP BY clause, the completion provider SHALL suggest exactly the columns
     * belonging to the referenced tables.
     */

    it('SELECT context returns columns from referenced table', () => {
      fc.assert(
        fc.property(arbitrarySchemaCache, (schemaCache) => {
          const table = schemaCache.tables[0];
          const text = `SELECT  FROM ${table.schema}.${table.name}`;
          // Cursor at position 7 (after "SELECT ")
          const items = getCompletions(text, 7, schemaCache, true);

          const labels = items.map((i) => i.label as string);

          // All columns from the referenced table should be present
          for (const col of table.columns) {
            expect(labels).toContain(col.name);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('WHERE context returns columns from referenced table', () => {
      fc.assert(
        fc.property(arbitrarySchemaCache, (schemaCache) => {
          const table = schemaCache.tables[0];
          const text = `SELECT * FROM ${table.schema}.${table.name} WHERE `;
          const items = getCompletions(text, text.length, schemaCache, true);

          const labels = items.map((i) => i.label as string);

          for (const col of table.columns) {
            expect(labels).toContain(col.name);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('ORDER BY context returns columns from referenced table', () => {
      fc.assert(
        fc.property(arbitrarySchemaCache, (schemaCache) => {
          const table = schemaCache.tables[0];
          const text = `SELECT * FROM ${table.schema}.${table.name} ORDER BY `;
          const items = getCompletions(text, text.length, schemaCache, true);

          const labels = items.map((i) => i.label as string);

          for (const col of table.columns) {
            expect(labels).toContain(col.name);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('GROUP BY context returns columns from referenced table', () => {
      fc.assert(
        fc.property(arbitrarySchemaCache, (schemaCache) => {
          const table = schemaCache.tables[0];
          const text = `SELECT * FROM ${table.schema}.${table.name} GROUP BY `;
          const items = getCompletions(text, text.length, schemaCache, true);

          const labels = items.map((i) => i.label as string);

          for (const col of table.columns) {
            expect(labels).toContain(col.name);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('does not return columns from unreferenced tables', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaCache.filter((sc) => sc.tables.length >= 2),
          (schemaCache) => {
            // Reference only the first table
            const referencedTable = schemaCache.tables[0];
            const text = `SELECT  FROM ${referencedTable.schema}.${referencedTable.name}`;
            const items = getCompletions(text, 7, schemaCache, true);

            const labels = new Set(items.map((i) => i.label as string));

            // Find columns that are ONLY in unreferenced tables (not in the referenced one)
            const referencedColNames = new Set(referencedTable.columns.map((c) => c.name.toLowerCase()));

            for (let i = 1; i < schemaCache.tables.length; i++) {
              const unreferencedTable = schemaCache.tables[i];
              for (const col of unreferencedTable.columns) {
                // Only check columns that don't share a name with the referenced table
                if (!referencedColNames.has(col.name.toLowerCase())) {
                  expect(labels.has(col.name)).toBe(false);
                }
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 8: Column completion detail includes type and nullability', () => {
    /**
     * Validates: Requirements 2.5
     *
     * For any column completion item, the completion detail string SHALL contain
     * the column's data type name and its nullability status (nullable or not nullable).
     */

    it('column completion detail contains data type and nullability', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaName,
          arbitraryIdentifier,
          fc.array(arbitraryColumnInfo, { minLength: 1, maxLength: 5 }).map((cols) => {
            const seen = new Set<string>();
            return cols.filter((c) => {
              const lower = c.name.toLowerCase();
              if (seen.has(lower)) return false;
              seen.add(lower);
              return true;
            });
          }).filter((cols) => cols.length > 0),
          (schema, tableName, columns) => {
            const schemaCache = createMockSchemaCache({
              tables: [{ schema, name: tableName, columns }],
            });

            const text = `SELECT  FROM ${schema}.${tableName}`;
            const items = getCompletions(text, 7, schemaCache, true);

            for (const col of columns) {
              const item = items.find((i) => i.label === col.name);
              expect(item).toBeDefined();
              // Detail should contain the data type
              expect(item!.detail).toContain(col.dataType);
              // Detail should contain nullability info
              if (col.isNullable) {
                expect(item!.detail).toContain('nullable');
              } else {
                expect(item!.detail).toContain('not null');
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('detail format is "dataType (nullability)"', () => {
      fc.assert(
        fc.property(
          arbitraryColumnInfo,
          arbitrarySchemaName,
          arbitraryIdentifier,
          (col, schema, tableName) => {
            const schemaCache = createMockSchemaCache({
              tables: [{ schema, name: tableName, columns: [col] }],
            });

            const text = `SELECT  FROM ${schema}.${tableName}`;
            const items = getCompletions(text, 7, schemaCache, true);

            const item = items.find((i) => i.label === col.name);
            expect(item).toBeDefined();

            const expectedNullability = col.isNullable ? 'nullable' : 'not null';
            expect(item!.detail).toBe(`${col.dataType} (${expectedNullability})`);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 9: EXEC/EXECUTE completion context returns procedures', () => {
    /**
     * Validates: Requirements 2.7
     *
     * For any SQL fragment where the cursor is positioned immediately after an
     * EXEC or EXECUTE keyword, the completion provider SHALL return stored
     * procedure names from the schema cache.
     */

    it('EXEC context returns all stored procedures with schema prefixes', () => {
      fc.assert(
        fc.property(arbitrarySchemaCache, (schemaCache) => {
          const text = 'EXEC ';
          const items = getCompletions(text, text.length, schemaCache, true);

          const labels = items.map((i) => i.label as string);

          for (const proc of schemaCache.procedures) {
            const expected = `${proc.schema}.${proc.name}`;
            expect(labels).toContain(expected);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('EXECUTE context returns all stored procedures with schema prefixes', () => {
      fc.assert(
        fc.property(arbitrarySchemaCache, (schemaCache) => {
          const text = 'EXECUTE ';
          const items = getCompletions(text, text.length, schemaCache, true);

          const labels = items.map((i) => i.label as string);

          for (const proc of schemaCache.procedures) {
            const expected = `${proc.schema}.${proc.name}`;
            expect(labels).toContain(expected);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('EXEC context returns only procedures (no tables, views, or keywords)', () => {
      fc.assert(
        fc.property(arbitrarySchemaCache, (schemaCache) => {
          const text = 'EXEC ';
          const items = getCompletions(text, text.length, schemaCache, true);

          for (const item of items) {
            // Snippets are allowed in all contexts
            if (item.detail === 'Snippet') continue;
            expect(item.detail).toBe('Stored Procedure');
          }
        }),
        { numRuns: 100 }
      );
    });

    it('EXEC context works case-insensitively', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaCache,
          fc.constantFrom('EXEC ', 'exec ', 'Exec ', 'EXECUTE ', 'execute ', 'Execute '),
          (schemaCache, keyword) => {
            const items = getCompletions(keyword, keyword.length, schemaCache, true);

            const labels = items.map((i) => i.label as string);

            for (const proc of schemaCache.procedures) {
              const expected = `${proc.schema}.${proc.name}`;
              expect(labels).toContain(expected);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 10: Prefix filtering correctness', () => {
    /**
     * Validates: Requirements 2.11
     *
     * For any set of completion items and any typed prefix string, the filtered
     * completion list SHALL contain exactly those items whose names start with
     * the prefix (case-insensitive).
     */

    it('FROM context filters tables/views by prefix correctly', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaCache,
          arbitraryPrefix,
          (schemaCache, prefix) => {
            const text = `SELECT * FROM ${prefix}`;
            const items = getCompletions(text, text.length, schemaCache, true);

            const returnedLabels = new Set(items.map((i) => i.label as string));

            // Build expected set: all tables and views whose schema.name starts with prefix
            const allLabels = [
              ...schemaCache.tables.map((t) => `${t.schema}.${t.name}`),
              ...schemaCache.views.map((v) => `${v.schema}.${v.name}`),
            ];

            const lowerPrefix = prefix.toLowerCase();
            for (const label of allLabels) {
              if (label.toLowerCase().startsWith(lowerPrefix)) {
                expect(returnedLabels.has(label)).toBe(true);
              } else {
                expect(returnedLabels.has(label)).toBe(false);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('EXEC context filters procedures by prefix correctly', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaCache,
          arbitraryPrefix,
          (schemaCache, prefix) => {
            const text = `EXEC ${prefix}`;
            const items = getCompletions(text, text.length, schemaCache, true);

            const returnedLabels = new Set(items.map((i) => i.label as string));

            const allLabels = schemaCache.procedures.map((p) => `${p.schema}.${p.name}`);

            const lowerPrefix = prefix.toLowerCase();
            for (const label of allLabels) {
              if (label.toLowerCase().startsWith(lowerPrefix)) {
                expect(returnedLabels.has(label)).toBe(true);
              } else {
                expect(returnedLabels.has(label)).toBe(false);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('empty prefix returns all tables/views plus contextual keywords (no filtering on schema objects)', () => {
      fc.assert(
        fc.property(arbitrarySchemaCache, (schemaCache) => {
          const text = 'SELECT * FROM ';
          const items = getCompletions(text, text.length, schemaCache, true);

          // Schema object count should match tables + views
          const schemaObjectItems = items.filter(i => i.detail === 'Table' || i.detail === 'View');
          const expectedCount = schemaCache.tables.length + schemaCache.views.length;
          expect(schemaObjectItems.length).toBe(expectedCount);
        }),
        { numRuns: 100 }
      );
    });

    it('prefix filtering is case-insensitive', () => {
      fc.assert(
        fc.property(
          arbitrarySchemaCache,
          arbitraryPrefix,
          (schemaCache, prefix) => {
            // Test with lowercase prefix
            const textLower = `SELECT * FROM ${prefix.toLowerCase()}`;
            const itemsLower = getCompletions(textLower, textLower.length, schemaCache, true);

            // Test with uppercase prefix
            const textUpper = `SELECT * FROM ${prefix.toUpperCase()}`;
            const itemsUpper = getCompletions(textUpper, textUpper.length, schemaCache, true);

            // Both should return the same set of labels
            const labelsLower = itemsLower.map((i) => i.label as string).sort();
            const labelsUpper = itemsUpper.map((i) => i.label as string).sort();

            expect(labelsLower).toEqual(labelsUpper);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});


// --- Property 3 & 4 Tests ---

describe('Property 3: JOIN context detection across all JOIN keyword variants', () => {
  /**
   * Validates: Requirements 2.1
   *
   * For any SQL fragment ending with a JOIN keyword variant (INNER JOIN, LEFT JOIN,
   * LEFT OUTER JOIN, RIGHT JOIN, RIGHT OUTER JOIN, FULL JOIN, FULL OUTER JOIN,
   * CROSS JOIN, or plain JOIN), the context detector SHALL identify the context as JOIN.
   */

  // All JOIN keyword variants to test
  const joinVariants = [
    'JOIN',
    'INNER JOIN',
    'LEFT JOIN',
    'LEFT OUTER JOIN',
    'RIGHT JOIN',
    'RIGHT OUTER JOIN',
    'FULL JOIN',
    'FULL OUTER JOIN',
    'CROSS JOIN',
  ];

  /** Generator: random preceding SQL text that could appear before a JOIN keyword */
  const arbitraryPrecedingSql: fc.Arbitrary<string> = fc.oneof(
    fc.constant('SELECT * FROM dbo.Orders o '),
    fc.constant('SELECT a.Id, b.Name FROM schema1.TableA a '),
    fc.constant('SELECT col1 FROM dbo.Users u WHERE u.Active = 1 '),
    fc.constant('SELECT * FROM hr.Employees e INNER JOIN dbo.Departments d ON e.DeptId = d.Id '),
    fc.constant('SELECT t.Id FROM sales.Transactions t '),
    fc.constant(''),
  );

  /** Generator: random whitespace that could appear after the JOIN keyword */
  const arbitraryTrailingWhitespace: fc.Arbitrary<string> = fc.oneof(
    fc.constant(' '),
    fc.constant('  '),
    fc.constant('\t'),
    fc.constant('   '),
    fc.constant(' \t '),
  );

  /** Generator: random case variation for a JOIN keyword */
  function arbitraryCaseVariation(keyword: string): fc.Arbitrary<string> {
    return fc.array(fc.boolean(), { minLength: keyword.length, maxLength: keyword.length })
      .map((bools) => keyword.split('').map((ch, i) => bools[i] ? ch.toUpperCase() : ch.toLowerCase()).join(''));
  }

  /** Generator: random whitespace insertion between words of a multi-word JOIN keyword */
  function arbitraryWhitespaceVariation(keyword: string): fc.Arbitrary<string> {
    const words = keyword.split(' ');
    if (words.length === 1) {
      return arbitraryCaseVariation(keyword);
    }
    // Generate random whitespace between words (1-3 spaces or tabs)
    const whitespaceGen = fc.stringOf(
      fc.constantFrom(' ', ' ', '\t'),
      { minLength: 1, maxLength: 3 }
    );
    return fc.tuple(
      ...words.map(w => arbitraryCaseVariation(w)),
      ...Array(words.length - 1).fill(whitespaceGen)
    ).map((parts) => {
      const wordParts = parts.slice(0, words.length) as string[];
      const wsParts = parts.slice(words.length) as string[];
      let result = wordParts[0];
      for (let i = 1; i < wordParts.length; i++) {
        result += wsParts[i - 1] + wordParts[i];
      }
      return result;
    });
  }

  it('detects JOIN context for all JOIN keyword variants with case variations', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...joinVariants),
        arbitraryPrecedingSql,
        arbitraryTrailingWhitespace,
        (joinKeyword, precedingSql, trailingWs) => {
          // Build SQL fragment ending with the JOIN keyword + trailing whitespace
          const text = `${precedingSql}${joinKeyword}${trailingWs}`;
          const result = detectJoinContext(text);

          expect(result.type).toBe('join');
          expect(result.joinType).toBeDefined();
        }
      ),
      { numRuns: 200 }
    );
  });

  it('detects JOIN context with random case variations of keywords', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...joinVariants).chain(variant => arbitraryCaseVariation(variant)),
        arbitraryPrecedingSql,
        (joinKeyword, precedingSql) => {
          const text = `${precedingSql}${joinKeyword} `;
          const result = detectJoinContext(text);

          expect(result.type).toBe('join');
          expect(result.joinType).toBeDefined();
        }
      ),
      { numRuns: 200 }
    );
  });

  it('normalizes joinType to uppercase with single spaces', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...joinVariants),
        arbitraryPrecedingSql,
        (joinKeyword, precedingSql) => {
          const text = `${precedingSql}${joinKeyword} `;
          const result = detectJoinContext(text);

          expect(result.type).toBe('join');
          // The joinType should be the normalized uppercase version
          expect(result.joinType).toBe(joinKeyword.toUpperCase());
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns default type when text does not end with a JOIN keyword', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'SELECT * FROM dbo.Orders WHERE ',
          'SELECT col1, col2 FROM ',
          'INSERT INTO dbo.Users ',
          'UPDATE dbo.Orders SET ',
          'DELETE FROM dbo.Orders WHERE ',
          'SELECT * FROM dbo.Orders o JOIN dbo.Users u ON o.UserId = u.Id WHERE ',
        ),
        (text) => {
          const result = detectJoinContext(text);
          expect(result.type).toBe('default');
        }
      ),
      { numRuns: 50 }
    );
  });

  it('detects JOIN context with extra whitespace between keyword words', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...joinVariants.filter(v => v.includes(' '))),
        arbitraryPrecedingSql,
        (joinKeyword, precedingSql) => {
          // Insert extra whitespace between words
          const words = joinKeyword.split(' ');
          const withExtraWs = words.join('  '); // double space
          const text = `${precedingSql}${withExtraWs} `;
          const result = detectJoinContext(text);

          expect(result.type).toBe('join');
          expect(result.joinType).toBeDefined();
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 4: Source table extraction from FROM/JOIN clauses', () => {
  /**
   * Validates: Requirements 2.2
   *
   * For any SQL query containing table references in FROM and JOIN clauses,
   * extractTableReferences SHALL return all table references with their schema,
   * name, and alias correctly parsed.
   */

  /** Generator: random valid SQL identifier for table/schema names */
  const arbitraryTableName: fc.Arbitrary<string> = fc
    .tuple(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
      fc.stringOf(
        fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')),
        { minLength: 1, maxLength: 10 }
      )
    )
    .map(([first, rest]) => first + rest)
    // Exclude SQL keywords
    .filter((id) => !/^(select|from|where|join|inner|left|right|full|cross|on|order|group|having|exec|execute|insert|update|delete|create|alter|drop|begin|end|if|else|while|return|declare|set|union|all|except|intersect|into|values|as|and|or|not|in|exists|between|like|is|null|case|when|then|distinct|top|with|go|use|print)$/i.test(id));

  /** Generator: random schema name */
  const arbitrarySchema: fc.Arbitrary<string> = fc.constantFrom('dbo', 'sales', 'hr', 'admin', 'app', 'staging', 'reporting');

  /** Generator: random alias (short lowercase identifier) */
  const arbitraryAlias: fc.Arbitrary<string> = fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    { minLength: 1, maxLength: 4 }
  ).filter((a) => !/^(as|on|in|or|is|if|go|by|set|from|join|into|exec|where|having|union)$/i.test(a));

  /** A table reference with schema, name, and optional alias */
  interface TestTableRef {
    schema: string;
    name: string;
    alias?: string;
    useAs: boolean; // whether to use AS keyword before alias
  }

  /** Generator: a table reference with schema, name, and optional alias */
  const arbitraryTestTableRef: fc.Arbitrary<TestTableRef> = fc.record({
    schema: arbitrarySchema,
    name: arbitraryTableName,
    alias: fc.option(arbitraryAlias, { nil: undefined }),
    useAs: fc.boolean(),
  });

  /** Formats a table reference as SQL text */
  function formatTableRef(ref: TestTableRef): string {
    let text = `${ref.schema}.${ref.name}`;
    if (ref.alias) {
      text += ref.useAs ? ` AS ${ref.alias}` : ` ${ref.alias}`;
    }
    return text;
  }

  it('extracts single table from FROM clause with schema and name', () => {
    fc.assert(
      fc.property(
        arbitrarySchema,
        arbitraryTableName,
        (schema, tableName) => {
          const query = `SELECT * FROM ${schema}.${tableName}`;
          const refs = extractTableReferences(query);

          expect(refs.length).toBeGreaterThanOrEqual(1);
          const match = refs.find(r => r.name === tableName && r.schema === schema);
          expect(match).toBeDefined();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('extracts table with alias (with AS keyword)', () => {
    fc.assert(
      fc.property(
        arbitrarySchema,
        arbitraryTableName,
        arbitraryAlias,
        (schema, tableName, alias) => {
          const query = `SELECT * FROM ${schema}.${tableName} AS ${alias}`;
          const refs = extractTableReferences(query);

          expect(refs.length).toBeGreaterThanOrEqual(1);
          const match = refs.find(r => r.name === tableName && r.schema === schema);
          expect(match).toBeDefined();
          expect(match!.alias).toBe(alias);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('extracts table with alias (without AS keyword)', () => {
    fc.assert(
      fc.property(
        arbitrarySchema,
        arbitraryTableName,
        arbitraryAlias,
        (schema, tableName, alias) => {
          const query = `SELECT * FROM ${schema}.${tableName} ${alias}`;
          const refs = extractTableReferences(query);

          expect(refs.length).toBeGreaterThanOrEqual(1);
          const match = refs.find(r => r.name === tableName && r.schema === schema);
          expect(match).toBeDefined();
          expect(match!.alias).toBe(alias);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('extracts table without schema prefix', () => {
    fc.assert(
      fc.property(
        arbitraryTableName,
        (tableName) => {
          const query = `SELECT * FROM ${tableName}`;
          const refs = extractTableReferences(query);

          expect(refs.length).toBeGreaterThanOrEqual(1);
          const match = refs.find(r => r.name === tableName);
          expect(match).toBeDefined();
          expect(match!.schema).toBeUndefined();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('extracts multiple tables from FROM clause (comma-separated)', () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryTestTableRef, { minLength: 2, maxLength: 4 })
          .filter(refs => {
            // Ensure unique table names to avoid ambiguity
            const names = refs.map(r => `${r.schema}.${r.name}`.toLowerCase());
            return new Set(names).size === names.length;
          }),
        (tableRefs) => {
          const fromClause = tableRefs.map(formatTableRef).join(', ');
          const query = `SELECT * FROM ${fromClause}`;
          const refs = extractTableReferences(query);

          // All tables should be extracted
          for (const expected of tableRefs) {
            const match = refs.find(r =>
              r.name === expected.name && r.schema === expected.schema
            );
            expect(match).toBeDefined();
            if (expected.alias) {
              expect(match!.alias).toBe(expected.alias);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('extracts tables from JOIN clauses', () => {
    fc.assert(
      fc.property(
        arbitraryTestTableRef,
        arbitraryTestTableRef.filter(r => r.alias !== undefined),
        (fromTable, joinTable) => {
          // Ensure different table names
          fc.pre(fromTable.name.toLowerCase() !== joinTable.name.toLowerCase() ||
                 fromTable.schema.toLowerCase() !== joinTable.schema.toLowerCase());

          const fromAlias = fromTable.alias || 'a';
          const joinAlias = joinTable.alias!;
          const query = `SELECT * FROM ${fromTable.schema}.${fromTable.name} ${fromAlias} JOIN ${joinTable.schema}.${joinTable.name} ${joinAlias} ON ${fromAlias}.Id = ${joinAlias}.Id`;
          const refs = extractTableReferences(query);

          // Both tables should be extracted
          const fromMatch = refs.find(r => r.name === fromTable.name && r.schema === fromTable.schema);
          expect(fromMatch).toBeDefined();

          const joinMatch = refs.find(r => r.name === joinTable.name && r.schema === joinTable.schema);
          expect(joinMatch).toBeDefined();
          expect(joinMatch!.alias).toBe(joinAlias);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('extracts tables from multiple JOIN variants', () => {
    const joinKeywords = ['JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN'];

    fc.assert(
      fc.property(
        arbitraryTestTableRef,
        arbitraryTestTableRef,
        fc.constantFrom(...joinKeywords),
        (fromTable, joinTable, joinKeyword) => {
          fc.pre(fromTable.name.toLowerCase() !== joinTable.name.toLowerCase() ||
                 fromTable.schema.toLowerCase() !== joinTable.schema.toLowerCase());

          const query = `SELECT * FROM ${fromTable.schema}.${fromTable.name} ${joinKeyword} ${joinTable.schema}.${joinTable.name}`;
          const refs = extractTableReferences(query);

          const fromMatch = refs.find(r => r.name === fromTable.name && r.schema === fromTable.schema);
          expect(fromMatch).toBeDefined();

          const joinMatch = refs.find(r => r.name === joinTable.name && r.schema === joinTable.schema);
          expect(joinMatch).toBeDefined();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('correctly parses schema, name, and alias for all extracted references', () => {
    fc.assert(
      fc.property(
        arbitraryTestTableRef,
        (tableRef) => {
          const query = `SELECT * FROM ${formatTableRef(tableRef)} WHERE 1=1`;
          const refs = extractTableReferences(query);

          expect(refs.length).toBeGreaterThanOrEqual(1);
          const match = refs.find(r => r.name === tableRef.name);
          expect(match).toBeDefined();
          expect(match!.schema).toBe(tableRef.schema);
          expect(match!.name).toBe(tableRef.name);
          if (tableRef.alias) {
            expect(match!.alias).toBe(tableRef.alias);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
