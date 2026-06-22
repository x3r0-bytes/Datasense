// Feature: ui-iteration-v05, Property 2: Table preview identity matching
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { arePreviewIdsEqual } from '../../src/previewQueryBuilder';
import { TablePreviewIdentifier } from '../../src/types';

/**
 * **Validates: Requirements 1.11**
 *
 * Property 2: Table preview identity matching
 *
 * For any two TablePreviewIdentifier objects, arePreviewIdsEqual SHALL return true
 * if and only if all four fields (connectionName, database, schema, objectName)
 * are identical (case-insensitive comparison).
 */

// Generator for a non-empty string suitable for identifier fields
const identifierArb = fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0);

// Generator for a TablePreviewIdentifier
const tablePreviewIdentifierArb: fc.Arbitrary<TablePreviewIdentifier> = fc.record({
  connectionName: identifierArb,
  database: identifierArb,
  schema: identifierArb,
  objectName: identifierArb,
});

describe('Property 2: Table preview identity matching', () => {
  it('arePreviewIdsEqual is reflexive — arePreviewIdsEqual(a, a) is always true', () => {
    fc.assert(
      fc.property(tablePreviewIdentifierArb, (a) => {
        expect(arePreviewIdsEqual(a, a)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('arePreviewIdsEqual returns true if and only if all four fields match case-insensitively', () => {
    fc.assert(
      fc.property(tablePreviewIdentifierArb, tablePreviewIdentifierArb, (a, b) => {
        const expectedEqual =
          a.connectionName.toLowerCase() === b.connectionName.toLowerCase() &&
          a.database.toLowerCase() === b.database.toLowerCase() &&
          a.schema.toLowerCase() === b.schema.toLowerCase() &&
          a.objectName.toLowerCase() === b.objectName.toLowerCase();

        expect(arePreviewIdsEqual(a, b)).toBe(expectedEqual);
      }),
      { numRuns: 100 }
    );
  });

  it('case variations of the same identifier are equal', () => {
    // Generate a base identifier and then create a case-varied copy
    const caseVariation = (s: string): fc.Arbitrary<string> =>
      fc.array(fc.boolean(), { minLength: s.length, maxLength: s.length }).map(flags =>
        s.split('').map((ch, i) => flags[i] ? ch.toUpperCase() : ch.toLowerCase()).join('')
      );

    fc.assert(
      fc.property(tablePreviewIdentifierArb, (base) => {
        // Create a case-varied version of the same identifier
        const varied: TablePreviewIdentifier = {
          connectionName: base.connectionName.toUpperCase(),
          database: base.database.toLowerCase(),
          schema: base.schema.toUpperCase(),
          objectName: base.objectName.toLowerCase(),
        };

        expect(arePreviewIdsEqual(base, varied)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('identifiers differing in any single field are not equal', () => {
    fc.assert(
      fc.property(
        tablePreviewIdentifierArb,
        identifierArb,
        fc.integer({ min: 0, max: 3 }),
        (base, differentValue, fieldIndex) => {
          // Only test when the different value actually differs case-insensitively
          const fields: (keyof TablePreviewIdentifier)[] = ['connectionName', 'database', 'schema', 'objectName'];
          const field = fields[fieldIndex];

          if (differentValue.toLowerCase() === base[field].toLowerCase()) {
            return; // Skip — values are the same case-insensitively
          }

          const modified: TablePreviewIdentifier = { ...base, [field]: differentValue };
          expect(arePreviewIdsEqual(base, modified)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});
