import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { formatColumnLabel, formatTableLabel, sortNodes } from '../../src/objectExplorer/nodeUtils';
import { TreeNode, TreeNodeKind } from '../../src/objectExplorer/types';

/**
 * Property-based tests for node formatting utilities
 * Feature: object-explorer-panel, Property 7: Column labels include name and qualified data type
 *
 * Validates: Requirements 9.2, 10.5
 */

// --- Generators ---

/** Generator: arbitrary non-empty column name */
const arbitraryColumnName: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')
  ),
  { minLength: 1, maxLength: 128 }
);

/** Generator: arbitrary non-empty data type string (including qualifiers like length/precision/scale) */
const arbitraryDataType: fc.Arbitrary<string> = fc.oneof(
  // Simple types: int, bigint, bit, etc.
  fc.constantFrom('int', 'bigint', 'smallint', 'tinyint', 'bit', 'float', 'real', 'date', 'datetime', 'uniqueidentifier', 'xml', 'text', 'ntext', 'image'),
  // Types with length qualifier: varchar(N), nvarchar(N), char(N), nchar(N), binary(N), varbinary(N)
  fc.tuple(
    fc.constantFrom('varchar', 'nvarchar', 'char', 'nchar', 'binary', 'varbinary'),
    fc.oneof(
      fc.integer({ min: 1, max: 8000 }).map(n => `(${n})`),
      fc.constant('(max)')
    )
  ).map(([type, qualifier]) => `${type}${qualifier}`),
  // Types with precision and scale: decimal(P,S), numeric(P,S)
  fc.tuple(
    fc.constantFrom('decimal', 'numeric'),
    fc.integer({ min: 1, max: 38 }),
    fc.integer({ min: 0, max: 18 })
  ).map(([type, precision, scale]) => `${type}(${precision},${scale})`)
);

// --- Tests ---

describe('Node Formatting Property Tests', () => {
  describe('Property 7: Column labels include name and qualified data type', () => {
    /**
     * Validates: Requirements 9.2, 10.5
     *
     * For any ColumnMetadata object with name c and data type t (including
     * length/precision/scale qualifiers), the corresponding leaf node label
     * SHALL be exactly "${c} (${t})".
     */

    it('formatColumnLabel produces exactly "${name} (${dataType})" for any column name and data type', () => {
      fc.assert(
        fc.property(arbitraryColumnName, arbitraryDataType, (name, dataType) => {
          const result = formatColumnLabel(name, dataType);
          expect(result).toBe(`${name} (${dataType})`);
        }),
        { numRuns: 100 }
      );
    });

    it('the label always contains the column name as a prefix', () => {
      fc.assert(
        fc.property(arbitraryColumnName, arbitraryDataType, (name, dataType) => {
          const result = formatColumnLabel(name, dataType);
          expect(result.startsWith(name)).toBe(true);
        }),
        { numRuns: 100 }
      );
    });

    it('the label always contains the data type enclosed in parentheses', () => {
      fc.assert(
        fc.property(arbitraryColumnName, arbitraryDataType, (name, dataType) => {
          const result = formatColumnLabel(name, dataType);
          expect(result.endsWith(`(${dataType})`)).toBe(true);
        }),
        { numRuns: 100 }
      );
    });

    it('the label has exactly one space separating name from the parenthesized data type', () => {
      fc.assert(
        fc.property(arbitraryColumnName, arbitraryDataType, (name, dataType) => {
          const result = formatColumnLabel(name, dataType);
          // The format is "name (dataType)" — one space between name and opening paren
          const expectedSeparator = ' ';
          const separatorIndex = name.length;
          expect(result[separatorIndex]).toBe(expectedSeparator);
          expect(result[separatorIndex + 1]).toBe('(');
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 6: Table and view labels use schema-qualified format', () => {
    /**
     * Validates: Requirements 8.2, 8.3, 10.2, 10.3
     *
     * For any TableMetadata or ViewMetadata object with schema s and name n,
     * the corresponding tree node label SHALL be exactly "${s}.${n}".
     */

    /** Generator: non-empty alphanumeric strings for schema and table/view names */
    const arbitraryIdentifier: fc.Arbitrary<string> = fc.stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')
      ),
      { minLength: 1, maxLength: 50 }
    );

    it('formatTableLabel returns exactly "${schema}.${name}" for any schema and name', () => {
      fc.assert(
        fc.property(arbitraryIdentifier, arbitraryIdentifier, (schema, name) => {
          const result = formatTableLabel(schema, name);
          expect(result).toBe(`${schema}.${name}`);
        }),
        { numRuns: 100 }
      );
    });

    it('the label always contains exactly one dot separating schema and name', () => {
      fc.assert(
        fc.property(arbitraryIdentifier, arbitraryIdentifier, (schema, name) => {
          const result = formatTableLabel(schema, name);
          const dotIndex = result.indexOf('.');
          // There is exactly one dot
          expect(dotIndex).toBeGreaterThan(0);
          expect(result.indexOf('.', dotIndex + 1)).toBe(-1);
          // The part before the dot is the schema
          expect(result.substring(0, dotIndex)).toBe(schema);
          // The part after the dot is the name
          expect(result.substring(dotIndex + 1)).toBe(name);
        }),
        { numRuns: 100 }
      );
    });

    it('the label length equals schema.length + 1 + name.length', () => {
      fc.assert(
        fc.property(arbitraryIdentifier, arbitraryIdentifier, (schema, name) => {
          const result = formatTableLabel(schema, name);
          expect(result.length).toBe(schema.length + 1 + name.length);
        }),
        { numRuns: 100 }
      );
    });
  });
});


// --- Property 5 Generators ---

/** Generator: a random non-empty label string for tree nodes */
const arbitraryNodeLabel: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.- '.split('')
  ),
  { minLength: 1, maxLength: 30 }
);

/** Generator: a random connection name */
const arbitraryConnectionName: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  { minLength: 1, maxLength: 15 }
);

/** Generator: a valid TreeNodeKind for node generation */
const arbitraryNodeKind: fc.Arbitrary<TreeNodeKind> = fc.constantFrom(
  'server' as const,
  'database' as const,
  'table' as const,
  'view' as const,
  'folder' as const
);

/**
 * Generator: a TreeNode with a random label.
 * Creates various node kinds to ensure sortNodes works across all types.
 */
const arbitraryTreeNode: fc.Arbitrary<TreeNode> = fc
  .tuple(arbitraryNodeKind, arbitraryNodeLabel, arbitraryConnectionName)
  .map(([kind, label, connectionName]): TreeNode => {
    switch (kind) {
      case 'server':
        return { kind: 'server', label, connectionName };
      case 'database':
        return { kind: 'database', label, connectionName, databaseName: label, isSystem: false, isOffline: false };
      case 'table':
        return { kind: 'table', label, connectionName, database: 'db', schema: 'dbo', tableName: label, isExternal: false };
      case 'view':
        return { kind: 'view', label, connectionName, database: 'db', schema: 'dbo', viewName: label, isSystem: false };
      case 'folder':
        return { kind: 'folder', label, connectionName, folderType: 'databases' };
      default:
        return { kind: 'server', label, connectionName };
    }
  });

/** Generator: an array of TreeNodes with random labels */
const arbitraryTreeNodeArray: fc.Arbitrary<TreeNode[]> = fc.array(arbitraryTreeNode, {
  minLength: 0,
  maxLength: 20,
});

// --- Property 5 Tests ---

/**
 * Feature: object-explorer-panel, Property 5: Sibling nodes are sorted in case-insensitive alphabetical order
 *
 * Validates: Requirements 5.1, 6.3, 11.5
 */
describe('Property 5: Sibling nodes are sorted in case-insensitive alphabetical order', () => {
  /**
   * Validates: Requirements 5.1, 6.3, 11.5
   *
   * For any list of sibling TreeNode objects returned by sortNodes(),
   * the labels SHALL be in case-insensitive alphabetical order
   * (each label.toLowerCase() <= next label.toLowerCase() using localeCompare).
   */

  it('sortNodes() produces labels in case-insensitive alphabetical order', () => {
    fc.assert(
      fc.property(arbitraryTreeNodeArray, (nodes) => {
        const sorted = sortNodes(nodes);

        // Verify each consecutive pair is in case-insensitive order
        for (let i = 0; i < sorted.length - 1; i++) {
          const cmp = sorted[i].label.localeCompare(sorted[i + 1].label, undefined, { sensitivity: 'base' });
          expect(cmp).toBeLessThanOrEqual(0);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('sortNodes() preserves all original elements (no additions or removals)', () => {
    fc.assert(
      fc.property(arbitraryTreeNodeArray, (nodes) => {
        const sorted = sortNodes(nodes);

        // Same length
        expect(sorted.length).toBe(nodes.length);

        // Every element in the sorted array exists in the original
        // (sort is a permutation, not a filter)
        const originalLabels = nodes.map((n) => n.label).sort();
        const sortedLabels = sorted.map((n) => n.label).sort();
        expect(sortedLabels).toEqual(originalLabels);
      }),
      { numRuns: 100 }
    );
  });

  it('sortNodes() is idempotent (sorting an already sorted array produces the same result)', () => {
    fc.assert(
      fc.property(arbitraryTreeNodeArray, (nodes) => {
        const sorted = sortNodes(nodes);
        const sortedAgain = sortNodes(sorted);

        expect(sortedAgain.map((n) => n.label)).toEqual(sorted.map((n) => n.label));
      }),
      { numRuns: 100 }
    );
  });

  it('sortNodes() does not mutate the original array', () => {
    fc.assert(
      fc.property(arbitraryTreeNodeArray, (nodes) => {
        const originalLabels = nodes.map((n) => n.label);
        sortNodes(nodes);

        // Original array should be unchanged
        expect(nodes.map((n) => n.label)).toEqual(originalLabels);
      }),
      { numRuns: 100 }
    );
  });
});
