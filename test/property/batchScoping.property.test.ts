import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { extractCurrentBatch, extractTableReferences, getCompletions } from '../../server/src/completionProvider';
import { ISchemaCache, TableInfo, ViewInfo, ProcedureInfo, ForeignKeyInfo, ColumnInfo } from '../../server/src/schemaCache';

/**
 * Property-based tests for batch scoping (Property 1)
 * Feature: query-scoped-intellisense, Property 1: Batch-scoped table reference extraction
 *
 * Validates: Requirements 1.1, 1.2, 1.3
 */

// --- Generators ---

/** Generator: random valid SQL identifier (starts with letter/underscore, alphanumeric) */
const arbitraryIdentifier: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')),
      { minLength: 1, maxLength: 10 }
    )
  )
  .map(([first, rest]) => first + rest)
  // Exclude SQL keywords that would confuse the parser
  .filter((id) => !/^(select|from|where|join|inner|left|right|full|cross|on|order|group|having|exec|execute|insert|update|delete|create|alter|drop|begin|end|if|else|while|return|declare|set|union|all|except|intersect|into|values|as|and|or|not|in|exists|between|like|is|null|case|when|then|distinct|top|with|go|use|print)$/i.test(id));

/** Generator: random schema name */
const arbitrarySchemaName: fc.Arbitrary<string> = fc.constantFrom('dbo', 'sales', 'hr', 'admin', 'app');

/** Generator: a table reference string like "schema.TableName" */
const arbitraryTableRef: fc.Arbitrary<{ schema: string; name: string; refText: string }> = fc
  .tuple(arbitrarySchemaName, arbitraryIdentifier)
  .map(([schema, name]) => ({
    schema,
    name,
    refText: `${schema}.${name}`,
  }));

/** Generator: optional alias for a table reference */
const arbitraryAlias: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    { minLength: 1, maxLength: 3 }
  ).filter((a) => !/^(as|on|in|or|is|if|go|by)$/i.test(a))
);

/**
 * Generator: a single SQL batch containing a SELECT with a FROM clause
 * referencing one or more tables. Returns the batch text and the table
 * references that should be extractable from it.
 */
const arbitrarySqlBatch: fc.Arbitrary<{ text: string; tables: Array<{ schema: string; name: string }> }> = fc
  .tuple(
    fc.array(
      fc.tuple(arbitraryTableRef, arbitraryAlias),
      { minLength: 1, maxLength: 3 }
    ),
    fc.constantFrom('SELECT *', 'SELECT col1', 'SELECT a, b, c')
  )
  .map(([tableRefs, selectClause]) => {
    const fromParts = tableRefs.map(([ref, alias]) => {
      return alias ? `${ref.refText} ${alias}` : ref.refText;
    });
    const text = `${selectClause} FROM ${fromParts.join(', ')}`;
    const tables = tableRefs.map(([ref]) => ({ schema: ref.schema, name: ref.name }));
    return { text, tables };
  });

/**
 * Generator: a SQL batch that does NOT contain any FROM/JOIN clause
 * (so extractTableReferences returns empty). Used as filler batches.
 */
const arbitraryNonFromBatch: fc.Arbitrary<string> = fc.oneof(
  fc.constant('DECLARE @x INT = 1'),
  fc.constant('PRINT \'hello\''),
  fc.constant('SET NOCOUNT ON'),
  fc.tuple(arbitraryIdentifier).map(([id]) => `DECLARE @${id} INT`),
  fc.constant('SELECT 1 + 1 AS result'),
);

/** Generator: GO separator with optional case variation and whitespace */
const arbitraryGoSeparator: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('GO', 'go', 'Go', 'gO'),
    fc.stringOf(fc.constantFrom(' ', '\t'), { minLength: 0, maxLength: 2 }),
    fc.stringOf(fc.constantFrom(' ', '\t'), { minLength: 0, maxLength: 2 })
  )
  .map(([goVariant, leading, trailing]) => `${leading}${goVariant}${trailing}`);

/**
 * Generator: a multi-batch SQL document with GO separators.
 * Returns the full document text, the batch index where the cursor should be placed,
 * and the expected table references for that batch.
 *
 * Structure: [filler batches] + [target batch with tables] + [other batches with different tables]
 * separated by GO lines.
 */
const arbitraryMultiBatchDocument: fc.Arbitrary<{
  documentText: string;
  cursorOffset: number;
  expectedTables: Array<{ schema: string; name: string }>;
  otherTables: Array<{ schema: string; name: string }>;
}> = fc
  .tuple(
    // Batches before the target batch (0-2 batches with their own tables or no tables)
    fc.array(
      fc.oneof(
        arbitrarySqlBatch.map((b) => ({ text: b.text, tables: b.tables })),
        arbitraryNonFromBatch.map((text) => ({ text, tables: [] as Array<{ schema: string; name: string }> }))
      ),
      { minLength: 1, maxLength: 2 }
    ),
    // The target batch (the one where the cursor will be)
    arbitrarySqlBatch,
    // Batches after the target batch (0-2 batches with their own tables or no tables)
    fc.array(
      fc.oneof(
        arbitrarySqlBatch.map((b) => ({ text: b.text, tables: b.tables })),
        arbitraryNonFromBatch.map((text) => ({ text, tables: [] as Array<{ schema: string; name: string }> }))
      ),
      { minLength: 1, maxLength: 2 }
    ),
    // GO separators
    arbitraryGoSeparator
  )
  .map(([beforeBatches, targetBatch, afterBatches, goSep]) => {
    const allBatchTexts: string[] = [];
    const otherTables: Array<{ schema: string; name: string }> = [];

    // Add before batches
    for (const batch of beforeBatches) {
      allBatchTexts.push(batch.text);
      otherTables.push(...batch.tables);
    }

    // Add target batch
    const targetIndex = allBatchTexts.length;
    allBatchTexts.push(targetBatch.text);

    // Add after batches
    for (const batch of afterBatches) {
      allBatchTexts.push(batch.text);
      otherTables.push(...batch.tables);
    }

    // Join with GO separators
    const documentText = allBatchTexts.join('\n' + goSep + '\n');

    // Calculate cursor offset: position within the target batch
    // Find the start of the target batch in the document
    let offset = 0;
    for (let i = 0; i < targetIndex; i++) {
      offset += allBatchTexts[i].length + 1 + goSep.length + 1; // batch + \n + GO + \n
    }
    // Place cursor somewhere within the target batch (e.g., at the end)
    const cursorOffset = offset + targetBatch.text.length;

    return {
      documentText,
      cursorOffset,
      expectedTables: targetBatch.tables,
      otherTables,
    };
  });

// --- Tests ---

describe('Batch Scoping Property Tests', () => {
  describe('Property 1: Batch-scoped table reference extraction', () => {
    /**
     * Validates: Requirements 1.1, 1.2, 1.3
     *
     * For any multi-batch SQL document (containing one or more GO separators)
     * and for any cursor position within a batch, extractCurrentBatch() followed
     * by extractTableReferences() SHALL return only table references that appear
     * in FROM/JOIN clauses within the batch containing the cursor, and SHALL NOT
     * return table references from any other batch.
     */

    it('extractCurrentBatch + extractTableReferences returns only table references from the cursor batch', () => {
      fc.assert(
        fc.property(arbitraryMultiBatchDocument, ({ documentText, cursorOffset, expectedTables, otherTables }) => {
          // Extract the current batch
          const batchScope = extractCurrentBatch(documentText, cursorOffset);

          // Extract table references from the batch
          const tableRefs = extractTableReferences(batchScope.text);

          // All expected tables from the cursor's batch should be present
          for (const expected of expectedTables) {
            const found = tableRefs.some(
              (ref) =>
                ref.name.toLowerCase() === expected.name.toLowerCase() &&
                (ref.schema?.toLowerCase() === expected.schema.toLowerCase() || !ref.schema)
            );
            expect(found).toBe(true);
          }

          // No table references from other batches should be present
          // (only check tables that are uniquely in other batches, not also in the target batch)
          const expectedSet = new Set(
            expectedTables.map((t) => `${t.schema.toLowerCase()}.${t.name.toLowerCase()}`)
          );
          for (const other of otherTables) {
            const otherKey = `${other.schema.toLowerCase()}.${other.name.toLowerCase()}`;
            if (expectedSet.has(otherKey)) continue; // Skip if also in target batch

            const found = tableRefs.some(
              (ref) =>
                ref.name.toLowerCase() === other.name.toLowerCase() &&
                ref.schema?.toLowerCase() === other.schema.toLowerCase()
            );
            expect(found).toBe(false);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('cursor in first batch (before any GO) returns only first batch table references', () => {
      fc.assert(
        fc.property(
          arbitrarySqlBatch,
          arbitrarySqlBatch,
          arbitraryGoSeparator,
          (firstBatch, secondBatch, goSep) => {
            const documentText = `${firstBatch.text}\n${goSep}\n${secondBatch.text}`;
            // Cursor at end of first batch
            const cursorOffset = firstBatch.text.length;

            const batchScope = extractCurrentBatch(documentText, cursorOffset);
            const tableRefs = extractTableReferences(batchScope.text);

            // Should contain first batch tables
            for (const expected of firstBatch.tables) {
              const found = tableRefs.some(
                (ref) =>
                  ref.name.toLowerCase() === expected.name.toLowerCase() &&
                  (ref.schema?.toLowerCase() === expected.schema.toLowerCase() || !ref.schema)
              );
              expect(found).toBe(true);
            }

            // Should NOT contain second batch tables (unless they happen to share names)
            const firstBatchSet = new Set(
              firstBatch.tables.map((t) => `${t.schema.toLowerCase()}.${t.name.toLowerCase()}`)
            );
            for (const other of secondBatch.tables) {
              const otherKey = `${other.schema.toLowerCase()}.${other.name.toLowerCase()}`;
              if (firstBatchSet.has(otherKey)) continue;

              const found = tableRefs.some(
                (ref) =>
                  ref.name.toLowerCase() === other.name.toLowerCase() &&
                  ref.schema?.toLowerCase() === other.schema.toLowerCase()
              );
              expect(found).toBe(false);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('cursor in last batch (after final GO) returns only last batch table references', () => {
      fc.assert(
        fc.property(
          arbitrarySqlBatch,
          arbitrarySqlBatch,
          arbitraryGoSeparator,
          (firstBatch, lastBatch, goSep) => {
            const documentText = `${firstBatch.text}\n${goSep}\n${lastBatch.text}`;
            // Cursor at end of last batch (end of document)
            const cursorOffset = documentText.length;

            const batchScope = extractCurrentBatch(documentText, cursorOffset);
            const tableRefs = extractTableReferences(batchScope.text);

            // Should contain last batch tables
            for (const expected of lastBatch.tables) {
              const found = tableRefs.some(
                (ref) =>
                  ref.name.toLowerCase() === expected.name.toLowerCase() &&
                  (ref.schema?.toLowerCase() === expected.schema.toLowerCase() || !ref.schema)
              );
              expect(found).toBe(true);
            }

            // Should NOT contain first batch tables (unless they share names)
            const lastBatchSet = new Set(
              lastBatch.tables.map((t) => `${t.schema.toLowerCase()}.${t.name.toLowerCase()}`)
            );
            for (const other of firstBatch.tables) {
              const otherKey = `${other.schema.toLowerCase()}.${other.name.toLowerCase()}`;
              if (lastBatchSet.has(otherKey)) continue;

              const found = tableRefs.some(
                (ref) =>
                  ref.name.toLowerCase() === other.name.toLowerCase() &&
                  ref.schema?.toLowerCase() === other.schema.toLowerCase()
              );
              expect(found).toBe(false);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});


/**
 * Property-based tests for batch-scoped column suggestions (Property 3)
 * Feature: query-scoped-intellisense, Property 3: Batch-scoped column suggestions
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4
 */

// --- Property 3 Generators ---

/** Generator: a column with a name and data type */
const arbitraryColumn: fc.Arbitrary<ColumnInfo> = fc
  .tuple(
    arbitraryIdentifier,
    fc.constantFrom('int', 'varchar', 'datetime', 'bit', 'decimal', 'nvarchar'),
    fc.boolean()
  )
  .map(([name, dataType, isNullable]) => ({ name, dataType, isNullable }));

/** Generator: a table with schema, name, and 1-4 columns */
const arbitraryTableWithColumns: fc.Arbitrary<TableInfo> = fc
  .tuple(
    arbitrarySchemaName,
    arbitraryIdentifier,
    fc.array(arbitraryColumn, { minLength: 1, maxLength: 4 })
  )
  .map(([schema, name, columns]) => {
    // Ensure column names are unique within the table
    const seen = new Set<string>();
    const uniqueColumns = columns.filter((col) => {
      const key = col.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { schema, name, columns: uniqueColumns };
  });

/** SQL clause contexts to test cursor placement in */
type ClauseType = 'SELECT' | 'WHERE' | 'ORDER_BY' | 'GROUP_BY';

/** Generator: a clause type for cursor placement */
const arbitraryClauseType: fc.Arbitrary<ClauseType> = fc.constantFrom(
  'SELECT' as ClauseType,
  'WHERE' as ClauseType,
  'ORDER_BY' as ClauseType,
  'GROUP_BY' as ClauseType
);

/**
 * Builds a SQL batch text with the cursor positioned in the specified clause.
 * Returns the batch text and the cursor offset within the batch where
 * completions should be triggered.
 */
function buildBatchWithCursorInClause(
  tables: TableInfo[],
  clauseType: ClauseType
): { batchText: string; cursorOffsetInBatch: number } {
  const fromParts = tables.map((t) => `${t.schema}.${t.name}`).join(', ');

  let batchText: string;
  let cursorOffsetInBatch: number;

  switch (clauseType) {
    case 'SELECT':
      // Place cursor after "SELECT " so context is SELECT with FROM present
      batchText = `SELECT  FROM ${fromParts}`;
      cursorOffsetInBatch = 'SELECT '.length;
      break;
    case 'WHERE':
      batchText = `SELECT * FROM ${fromParts} WHERE `;
      cursorOffsetInBatch = batchText.length;
      break;
    case 'ORDER_BY':
      batchText = `SELECT * FROM ${fromParts} ORDER BY `;
      cursorOffsetInBatch = batchText.length;
      break;
    case 'GROUP_BY':
      batchText = `SELECT * FROM ${fromParts} GROUP BY `;
      cursorOffsetInBatch = batchText.length;
      break;
  }

  return { batchText, cursorOffsetInBatch };
}

/**
 * Creates a mock ISchemaCache containing the specified tables.
 */
function createMockSchemaCache(tables: TableInfo[]): ISchemaCache {
  return {
    tables,
    views: [] as ViewInfo[],
    procedures: [] as ProcedureInfo[],
    foreignKeys: [] as ForeignKeyInfo[],
    isPopulating: false,
    refresh: async () => {},
    getForeignKeysForTable: () => [],
  };
}

/**
 * Generator: a multi-batch document for Property 3 testing.
 * Produces two sets of tables (target batch and other batch) with distinct columns,
 * a full document text with GO separators, and the cursor offset positioned in
 * a specific clause within the target batch.
 */
const arbitraryProperty3Document: fc.Arbitrary<{
  documentText: string;
  cursorOffset: number;
  targetTables: TableInfo[];
  otherTables: TableInfo[];
  clauseType: ClauseType;
}> = fc
  .tuple(
    // Tables for the target batch (1-2 tables)
    fc.array(arbitraryTableWithColumns, { minLength: 1, maxLength: 2 }),
    // Tables for the other batch (1-2 tables, different from target)
    fc.array(arbitraryTableWithColumns, { minLength: 1, maxLength: 2 }),
    // Clause type for cursor placement
    arbitraryClauseType,
    // GO separator variant
    arbitraryGoSeparator
  )
  .map(([targetTables, otherTables, clauseType, goSep]) => {
    // Ensure other tables have different names from target tables
    const targetNames = new Set(targetTables.map((t) => `${t.schema}.${t.name}`.toLowerCase()));
    const filteredOtherTables = otherTables.filter(
      (t) => !targetNames.has(`${t.schema}.${t.name}`.toLowerCase())
    );

    // If all other tables were filtered out, create a fallback table
    const effectiveOtherTables = filteredOtherTables.length > 0
      ? filteredOtherTables
      : [{ schema: 'other', name: 'fallback_tbl', columns: [{ name: 'other_col', dataType: 'int', isNullable: false }] }];

    // Build the target batch with cursor in the specified clause
    const { batchText: targetBatchText, cursorOffsetInBatch } = buildBatchWithCursorInClause(targetTables, clauseType);

    // Build the other batch (a simple SELECT FROM with the other tables)
    const otherFromParts = effectiveOtherTables.map((t) => `${t.schema}.${t.name}`).join(', ');
    const otherBatchText = `SELECT * FROM ${otherFromParts}`;

    // Assemble the full document: other batch first, then GO, then target batch
    const documentText = `${otherBatchText}\n${goSep}\n${targetBatchText}`;

    // Calculate cursor offset in the full document
    const targetBatchStart = otherBatchText.length + 1 + goSep.length + 1; // other + \n + GO + \n
    const cursorOffset = targetBatchStart + cursorOffsetInBatch;

    return {
      documentText,
      cursorOffset,
      targetTables,
      otherTables: effectiveOtherTables,
      clauseType,
    };
  });

// --- Property 3 Tests ---

describe('Property 3: Batch-scoped column suggestions', () => {
  /**
   * Validates: Requirements 2.1, 2.2, 2.3, 2.4
   *
   * For any multi-batch SQL document and for any cursor position in a SELECT,
   * WHERE, ORDER BY, or GROUP BY clause, the column completions returned SHALL
   * include only columns from tables referenced in FROM/JOIN clauses within the
   * cursor's batch, and SHALL NOT include columns from tables referenced
   * exclusively in other batches.
   */

  it('getCompletions returns only columns from the cursor batch tables, not from other batches', () => {
    fc.assert(
      fc.property(arbitraryProperty3Document, ({ documentText, cursorOffset, targetTables, otherTables, clauseType }) => {
        // Create a schema cache containing ALL tables (both target and other batch)
        const allTables = [...targetTables, ...otherTables];
        const schemaCache = createMockSchemaCache(allTables);

        // Get completions at the cursor position
        const completions = getCompletions(documentText, cursorOffset, schemaCache, true);

        // Extract column completions (kind === Field)
        const columnCompletions = completions.filter((c) => c.kind === 5); // CompletionItemKind.Field = 5

        // Collect all column names from the target batch's tables
        const targetColumnNames = new Set(
          targetTables.flatMap((t) => t.columns.map((c) => c.name.toLowerCase()))
        );

        // Collect column names that are ONLY in other batch tables (not in target)
        const otherOnlyColumnNames = new Set(
          otherTables
            .flatMap((t) => t.columns.map((c) => c.name.toLowerCase()))
            .filter((name) => !targetColumnNames.has(name))
        );

        // Assert: all column completions should be from target batch tables
        for (const completion of columnCompletions) {
          const label = (completion.label as string).toLowerCase();
          // Column should NOT be exclusively from other batch tables
          expect(otherOnlyColumnNames.has(label)).toBe(false);
        }

        // Assert: columns from target batch tables should be present in completions
        // (at least one column from target tables should appear)
        if (targetTables.length > 0 && targetTables.some((t) => t.columns.length > 0)) {
          const completionLabels = new Set(
            columnCompletions.map((c) => (c.label as string).toLowerCase())
          );
          const hasAtLeastOneTargetColumn = targetTables.some((t) =>
            t.columns.some((col) => completionLabels.has(col.name.toLowerCase()))
          );
          expect(hasAtLeastOneTargetColumn).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('columns from tables referenced exclusively in other batches are never suggested', () => {
    fc.assert(
      fc.property(arbitraryProperty3Document, ({ documentText, cursorOffset, targetTables, otherTables }) => {
        const allTables = [...targetTables, ...otherTables];
        const schemaCache = createMockSchemaCache(allTables);

        const completions = getCompletions(documentText, cursorOffset, schemaCache, true);
        const columnCompletions = completions.filter((c) => c.kind === 5); // CompletionItemKind.Field = 5

        // Build set of column names that exist ONLY in other batch tables
        const targetColumnNames = new Set(
          targetTables.flatMap((t) => t.columns.map((c) => c.name.toLowerCase()))
        );
        const exclusiveOtherColumns = otherTables
          .flatMap((t) => t.columns)
          .filter((col) => !targetColumnNames.has(col.name.toLowerCase()));

        // None of the exclusive other-batch columns should appear in completions
        const completionLabels = new Set(
          columnCompletions.map((c) => (c.label as string).toLowerCase())
        );
        for (const col of exclusiveOtherColumns) {
          expect(completionLabels.has(col.name.toLowerCase())).toBe(false);
        }
      }),
      { numRuns: 100 }
    );
  });
});
