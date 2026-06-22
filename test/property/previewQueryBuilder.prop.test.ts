import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { buildPreviewQuery } from '../../src/previewQueryBuilder';
import { PreviewQueryParams } from '../../src/types';

// Feature: ui-iteration-v05, Property 1: Preview query generation is well-formed

/**
 * Property-based tests for preview query builder
 * Feature: ui-iteration-v05
 *
 * Property 1: Preview query generation is well-formed
 * Validates: Requirements 1.2, 1.4, 1.5, 1.8
 *
 * For any valid schema name, object name, row limit (1–10000), optional filter text,
 * and optional sort column with direction, buildPreviewQuery SHALL produce a SQL string that:
 * - Starts with SELECT TOP <rowLimit>
 * - Contains FROM [<schema>].[<objectName>] (with bracket escaping applied)
 * - Contains a WHERE clause if and only if filter text is non-empty
 * - Contains an ORDER BY clause if and only if a sort column is specified
 * - Properly brackets the schema and object names
 */

// --- Generators ---

/** Generator: valid SQL identifier characters (letters, digits, underscores, spaces) */
const arbitrarySqlIdentifier: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_ '.split('')
  ),
  { minLength: 1, maxLength: 30 }
).filter((s) => s.trim().length > 0);

/** Generator: SQL identifier that may contain bracket characters (to test escaping) */
const arbitrarySqlIdentifierWithBrackets: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_ []'.split('')
  ),
  { minLength: 1, maxLength: 30 }
).filter((s) => s.trim().length > 0);

/** Generator: row limit in valid range 1–10000 */
const arbitraryRowLimit: fc.Arbitrary<number> = fc.integer({ min: 1, max: 10000 });

/** Generator: non-empty filter text */
const arbitraryFilterText: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 =<>\'"._%'.split('')
  ),
  { minLength: 1, maxLength: 50 }
).filter((s) => s.trim().length > 0);

/** Generator: sort column name */
const arbitrarySortColumn: fc.Arbitrary<string> = arbitrarySqlIdentifier;

/** Generator: sort direction */
const arbitrarySortDirection: fc.Arbitrary<'ASC' | 'DESC'> = fc.constantFrom('ASC' as const, 'DESC' as const);

// --- Tests ---

describe('Preview Query Builder Property Tests', () => {
  describe('Feature: ui-iteration-v05, Property 1: Preview query generation is well-formed', () => {
    it('starts with SELECT TOP <rowLimit> for any valid inputs', () => {
      fc.assert(
        fc.property(
          arbitrarySqlIdentifier,
          arbitrarySqlIdentifier,
          arbitraryRowLimit,
          (schema, objectName, rowLimit) => {
            const params: PreviewQueryParams = { schema, objectName, rowLimit };
            const query = buildPreviewQuery(params);

            expect(query.startsWith(`SELECT TOP ${rowLimit}`)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('contains FROM [<schema>].[<objectName>] with bracket escaping', () => {
      fc.assert(
        fc.property(
          arbitrarySqlIdentifierWithBrackets,
          arbitrarySqlIdentifierWithBrackets,
          arbitraryRowLimit,
          (schema, objectName, rowLimit) => {
            const params: PreviewQueryParams = { schema, objectName, rowLimit };
            const query = buildPreviewQuery(params);

            // The escaped schema replaces ] with ]]
            const escapedSchema = schema.replace(/\]/g, ']]');
            const escapedObject = objectName.replace(/\]/g, ']]');

            expect(query).toContain(`FROM [${escapedSchema}].[${escapedObject}]`);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('contains WHERE clause if and only if filter text is non-empty', () => {
      fc.assert(
        fc.property(
          arbitrarySqlIdentifier,
          arbitrarySqlIdentifier,
          arbitraryRowLimit,
          arbitraryFilterText,
          (schema, objectName, rowLimit, filterText) => {
            // With non-empty filter text: WHERE clause present
            const paramsWithFilter: PreviewQueryParams = { schema, objectName, rowLimit, filterText };
            const queryWithFilter = buildPreviewQuery(paramsWithFilter);
            expect(queryWithFilter).toContain('WHERE');

            // Without filter text: no WHERE clause
            const paramsWithoutFilter: PreviewQueryParams = { schema, objectName, rowLimit };
            const queryWithoutFilter = buildPreviewQuery(paramsWithoutFilter);
            expect(queryWithoutFilter).not.toContain('WHERE');

            // With empty string filter: no WHERE clause
            const paramsEmptyFilter: PreviewQueryParams = { schema, objectName, rowLimit, filterText: '' };
            const queryEmptyFilter = buildPreviewQuery(paramsEmptyFilter);
            expect(queryEmptyFilter).not.toContain('WHERE');

            // With whitespace-only filter: no WHERE clause
            const paramsWhitespaceFilter: PreviewQueryParams = { schema, objectName, rowLimit, filterText: '   ' };
            const queryWhitespaceFilter = buildPreviewQuery(paramsWhitespaceFilter);
            expect(queryWhitespaceFilter).not.toContain('WHERE');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('contains ORDER BY clause if and only if sort column is specified', () => {
      fc.assert(
        fc.property(
          arbitrarySqlIdentifier,
          arbitrarySqlIdentifier,
          arbitraryRowLimit,
          arbitrarySortColumn,
          arbitrarySortDirection,
          (schema, objectName, rowLimit, sortColumn, sortDirection) => {
            // With sort column: ORDER BY clause present
            const paramsWithSort: PreviewQueryParams = { schema, objectName, rowLimit, sortColumn, sortDirection };
            const queryWithSort = buildPreviewQuery(paramsWithSort);
            expect(queryWithSort).toContain('ORDER BY');

            // Without sort column: no ORDER BY clause
            const paramsWithoutSort: PreviewQueryParams = { schema, objectName, rowLimit };
            const queryWithoutSort = buildPreviewQuery(paramsWithoutSort);
            expect(queryWithoutSort).not.toContain('ORDER BY');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('properly brackets schema and object names in the FROM clause', () => {
      fc.assert(
        fc.property(
          arbitrarySqlIdentifierWithBrackets,
          arbitrarySqlIdentifierWithBrackets,
          arbitraryRowLimit,
          (schema, objectName, rowLimit) => {
            const params: PreviewQueryParams = { schema, objectName, rowLimit };
            const query = buildPreviewQuery(params);

            // Extract the FROM clause portion
            const fromIndex = query.indexOf('FROM ');
            expect(fromIndex).toBeGreaterThan(-1);

            const fromClause = query.substring(fromIndex);
            // The FROM clause should start with FROM [
            expect(fromClause.startsWith('FROM [')).toBe(true);

            // Verify the pattern is FROM [escaped_schema].[escaped_object]
            const escapedSchema = schema.replace(/\]/g, ']]');
            const escapedObject = objectName.replace(/\]/g, ']]');
            expect(fromClause).toContain(`[${escapedSchema}].[${escapedObject}]`);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('includes sort direction in ORDER BY clause when sort column is specified', () => {
      fc.assert(
        fc.property(
          arbitrarySqlIdentifier,
          arbitrarySqlIdentifier,
          arbitraryRowLimit,
          arbitrarySortColumn,
          arbitrarySortDirection,
          (schema, objectName, rowLimit, sortColumn, sortDirection) => {
            const params: PreviewQueryParams = { schema, objectName, rowLimit, sortColumn, sortDirection };
            const query = buildPreviewQuery(params);

            expect(query).toContain(`] ${sortDirection}`);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('brackets the sort column name in ORDER BY clause', () => {
      fc.assert(
        fc.property(
          arbitrarySqlIdentifier,
          arbitrarySqlIdentifier,
          arbitraryRowLimit,
          arbitrarySqlIdentifierWithBrackets,
          arbitrarySortDirection,
          (schema, objectName, rowLimit, sortColumn, sortDirection) => {
            const params: PreviewQueryParams = { schema, objectName, rowLimit, sortColumn, sortDirection };
            const query = buildPreviewQuery(params);

            const escapedSortColumn = sortColumn.trim().replace(/\]/g, ']]');
            expect(query).toContain(`ORDER BY [${escapedSortColumn}]`);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
