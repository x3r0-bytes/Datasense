import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';

/**
 * Property-based tests for context menu handler pure functions
 * Feature: ui-overhaul-v2
 */

// Mock vscode module (required because contextMenuHandler.ts imports vscode)
vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
    showTextDocument: vi.fn(),
  },
  workspace: {
    openTextDocument: vi.fn(),
  },
  env: {
    clipboard: {
      writeText: vi.fn(),
    },
  },
  commands: {
    executeCommand: vi.fn(),
  },
}));

import { formatQualifiedName, generateSelectTop100, getCopyText } from '../../src/contextMenuHandler';
import {
  TreeNode,
  ColumnNode,
  FolderNode,
  ServerNode,
  DatabaseNode,
  ErrorNode,
  FolderType,
} from '../../src/objectExplorer/types';

// --- Generators ---

/** Generator: arbitrary non-empty string for schema/object names */
const arbitraryNonEmptyString: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 128 });

// --- Tests ---

describe('Context Menu Handler Property Tests', () => {
  describe('Property 1: Qualified Name Formatting', () => {
    /**
     * Validates: Requirements 2.4
     *
     * For any valid schema name and object name (non-empty strings),
     * formatQualifiedName(schema, objectName) SHALL produce a string
     * in the exact format [schema].[objectName] where both parts are
     * wrapped in square brackets.
     *
     * Feature: ui-overhaul-v2, Property 1: Qualified Name Formatting
     */

    it('produces output starting with [ and ending with ]', () => {
      fc.assert(
        fc.property(arbitraryNonEmptyString, arbitraryNonEmptyString, (schema, objectName) => {
          const result = formatQualifiedName(schema, objectName);
          expect(result.startsWith('[')).toBe(true);
          expect(result.endsWith(']')).toBe(true);
        }),
        { numRuns: 100 }
      );
    });

    it('contains ].[ separator between schema and object name', () => {
      fc.assert(
        fc.property(arbitraryNonEmptyString, arbitraryNonEmptyString, (schema, objectName) => {
          const result = formatQualifiedName(schema, objectName);
          expect(result).toContain('].[');
        }),
        { numRuns: 100 }
      );
    });

    it('wraps schema in brackets as the first part', () => {
      fc.assert(
        fc.property(arbitraryNonEmptyString, arbitraryNonEmptyString, (schema, objectName) => {
          const result = formatQualifiedName(schema, objectName);
          const separatorIndex = result.indexOf('].[');
          const schemaPart = result.substring(0, separatorIndex + 1);
          expect(schemaPart).toBe(`[${schema}]`);
        }),
        { numRuns: 100 }
      );
    });

    it('wraps objectName in brackets as the second part', () => {
      fc.assert(
        fc.property(arbitraryNonEmptyString, arbitraryNonEmptyString, (schema, objectName) => {
          const result = formatQualifiedName(schema, objectName);
          const separatorIndex = result.indexOf('].[');
          const objectPart = result.substring(separatorIndex + 2);
          expect(objectPart).toBe(`[${objectName}]`);
        }),
        { numRuns: 100 }
      );
    });

    it('produces exactly [schema].[objectName] for any non-empty strings', () => {
      fc.assert(
        fc.property(arbitraryNonEmptyString, arbitraryNonEmptyString, (schema, objectName) => {
          const result = formatQualifiedName(schema, objectName);
          expect(result).toBe(`[${schema}].[${objectName}]`);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 2: SELECT TOP 100 SQL Generation', () => {
    /**
     * Validates: Requirements 2.3
     *
     * For any valid schema name and object name (non-empty strings),
     * generateSelectTop100(schema, objectName) SHALL produce a string
     * equal to `SELECT TOP 100 * FROM [schema].[objectName]` using the
     * qualified name format.
     *
     * Feature: ui-overhaul-v2, Property 2: SELECT TOP 100 SQL Generation
     */

    it('produces SELECT TOP 100 * FROM [schema].[objectName] for any non-empty strings', () => {
      fc.assert(
        fc.property(arbitraryNonEmptyString, arbitraryNonEmptyString, (schema, objectName) => {
          const result = generateSelectTop100(schema, objectName);
          expect(result).toBe(`SELECT TOP 100 * FROM [${schema}].[${objectName}]`);
        }),
        { numRuns: 100 }
      );
    });

    it('output always starts with SELECT TOP 100 * FROM', () => {
      fc.assert(
        fc.property(arbitraryNonEmptyString, arbitraryNonEmptyString, (schema, objectName) => {
          const result = generateSelectTop100(schema, objectName);
          expect(result.startsWith('SELECT TOP 100 * FROM ')).toBe(true);
        }),
        { numRuns: 100 }
      );
    });

    it('output contains the qualified name produced by formatQualifiedName', () => {
      fc.assert(
        fc.property(arbitraryNonEmptyString, arbitraryNonEmptyString, (schema, objectName) => {
          const result = generateSelectTop100(schema, objectName);
          const qualifiedName = formatQualifiedName(schema, objectName);
          expect(result).toContain(qualifiedName);
          expect(result).toBe(`SELECT TOP 100 * FROM ${qualifiedName}`);
        }),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Feature: ui-overhaul-v2, Property 4: Context Menu When-Clause Correctness
   *
   * Validates: Requirements 4.1, 5.3
   */
  describe('Property 4: Context Menu When-Clause Correctness', () => {
    /**
     * Validates: Requirements 4.1, 5.3
     *
     * For any contextValue string in the set {table, view, server, database,
     * column, columnPK, columnFK, folder, externalTable, systemView,
     * databaseOffline, error}, the when-clause regex patterns SHALL match as
     * follows:
     * - selectTop100 matches only {table, view}
     * - copyObjectName matches {table, view, column, columnPK, columnFK, folder, externalTable, systemView, databaseOffline}
     * - newQuery matches {table, view, server, database}
     * - refreshNode matches {table, view, server, database}
     * - "error" matches none
     */

    // When-clause regex patterns from package.json
    const WHEN_CLAUSE_PATTERNS = {
      selectTop100: /^(table|view)$/,
      copyObjectName: /^(table|view|column|columnPK|columnFK|folder|externalTable|systemView|databaseOffline)$/,
      newQuery: /^(table|view|server|database)$/,
      refreshNode: /^(table|view|server|database)$/,
    };

    // Expected match sets from the design document
    const EXPECTED_MATCHES: Record<string, Set<string>> = {
      selectTop100: new Set(['table', 'view']),
      copyObjectName: new Set(['table', 'view', 'column', 'columnPK', 'columnFK', 'folder', 'externalTable', 'systemView', 'databaseOffline']),
      newQuery: new Set(['table', 'view', 'server', 'database']),
      refreshNode: new Set(['table', 'view', 'server', 'database']),
    };

    // All valid contextValues in the Object Explorer
    const ALL_CONTEXT_VALUES = [
      'server', 'database', 'databaseOffline', 'table', 'externalTable',
      'view', 'systemView', 'column', 'columnPK', 'columnFK', 'folder', 'error',
    ] as const;

    type ContextValue = (typeof ALL_CONTEXT_VALUES)[number];
    type MenuCommand = keyof typeof WHEN_CLAUSE_PATTERNS;

    // Generators
    const arbitraryContextValue: fc.Arbitrary<ContextValue> = fc.constantFrom(...ALL_CONTEXT_VALUES);
    const arbitraryMenuCommand: fc.Arbitrary<MenuCommand> = fc.constantFrom(
      'selectTop100' as const,
      'copyObjectName' as const,
      'newQuery' as const,
      'refreshNode' as const,
    );

    it('each regex pattern matches exactly the expected set of contextValues', () => {
      fc.assert(
        fc.property(arbitraryContextValue, arbitraryMenuCommand, (contextValue, command) => {
          const pattern = WHEN_CLAUSE_PATTERNS[command];
          const expectedSet = EXPECTED_MATCHES[command];
          const matches = pattern.test(contextValue);
          const shouldMatch = expectedSet.has(contextValue);

          expect(matches).toBe(shouldMatch);
        }),
        { numRuns: 200 }
      );
    });

    it('selectTop100 regex matches only table and view', () => {
      fc.assert(
        fc.property(arbitraryContextValue, (contextValue) => {
          const matches = WHEN_CLAUSE_PATTERNS.selectTop100.test(contextValue);
          const shouldMatch = EXPECTED_MATCHES.selectTop100.has(contextValue);
          expect(matches).toBe(shouldMatch);
        }),
        { numRuns: 100 }
      );
    });

    it('copyObjectName regex matches the correct 9-element set', () => {
      fc.assert(
        fc.property(arbitraryContextValue, (contextValue) => {
          const matches = WHEN_CLAUSE_PATTERNS.copyObjectName.test(contextValue);
          const shouldMatch = EXPECTED_MATCHES.copyObjectName.has(contextValue);
          expect(matches).toBe(shouldMatch);
        }),
        { numRuns: 100 }
      );
    });

    it('newQuery regex matches only table, view, server, and database', () => {
      fc.assert(
        fc.property(arbitraryContextValue, (contextValue) => {
          const matches = WHEN_CLAUSE_PATTERNS.newQuery.test(contextValue);
          const shouldMatch = EXPECTED_MATCHES.newQuery.has(contextValue);
          expect(matches).toBe(shouldMatch);
        }),
        { numRuns: 100 }
      );
    });

    it('refreshNode regex matches only table, view, server, and database', () => {
      fc.assert(
        fc.property(arbitraryContextValue, (contextValue) => {
          const matches = WHEN_CLAUSE_PATTERNS.refreshNode.test(contextValue);
          const shouldMatch = EXPECTED_MATCHES.refreshNode.has(contextValue);
          expect(matches).toBe(shouldMatch);
        }),
        { numRuns: 100 }
      );
    });

    it('error contextValue matches no menu command patterns', () => {
      fc.assert(
        fc.property(arbitraryMenuCommand, (command) => {
          const pattern = WHEN_CLAUSE_PATTERNS[command];
          expect(pattern.test('error')).toBe(false);
        }),
        { numRuns: 100 }
      );
    });

    it('no regex pattern matches arbitrary strings outside the valid contextValue set', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 30 }).filter(
            (s) => !(ALL_CONTEXT_VALUES as readonly string[]).includes(s)
          ),
          arbitraryMenuCommand,
          (randomString, command) => {
            const pattern = WHEN_CLAUSE_PATTERNS[command];
            // Arbitrary strings that are not valid contextValues should never match
            expect(pattern.test(randomString)).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Feature: ui-overhaul-v2, Property 5: Copy Object Name Fallback
   *
   * Validates: Requirements 4.2, 4.3
   */
  describe('Property 5: Copy Object Name Fallback', () => {
    /**
     * Validates: Requirements 4.2, 4.3
     *
     * For any TreeNode that is not of kind `table` or `view`, the getCopyText(node)
     * function SHALL return the node's `label` property for folder/server/database/error
     * nodes, and the `columnName` property for column nodes (including PK and FK columns).
     */

    // --- Generators for non-table/non-view nodes ---

    const folderTypes: FolderType[] = [
      'databases', 'systemDatabases', 'security', 'serverObjects',
      'tables', 'tablesUser', 'tablesExternal', 'views', 'viewsUser',
      'viewsSystem', 'synonyms', 'programmability', 'externalResources',
      'serviceBroker', 'storage', 'dbSecurity', 'columns', 'constraints',
      'triggers', 'indexes', 'statistics',
    ];

    /** Generator: arbitrary FolderNode */
    const arbitraryFolderNode: fc.Arbitrary<FolderNode> = fc.record({
      kind: fc.constant('folder' as const),
      label: fc.string({ minLength: 1, maxLength: 128 }),
      connectionName: fc.string({ minLength: 1, maxLength: 64 }),
      folderType: fc.constantFrom(...folderTypes),
      database: fc.option(fc.string({ minLength: 1, maxLength: 64 }), { nil: undefined }),
      schema: fc.option(fc.string({ minLength: 1, maxLength: 64 }), { nil: undefined }),
      objectName: fc.option(fc.string({ minLength: 1, maxLength: 64 }), { nil: undefined }),
    });

    /** Generator: arbitrary ServerNode */
    const arbitraryServerNode: fc.Arbitrary<ServerNode> = fc.record({
      kind: fc.constant('server' as const),
      label: fc.string({ minLength: 1, maxLength: 128 }),
      connectionName: fc.string({ minLength: 1, maxLength: 64 }),
    });

    /** Generator: arbitrary DatabaseNode (covers both online and offline) */
    const arbitraryDatabaseNode: fc.Arbitrary<DatabaseNode> = fc.record({
      kind: fc.constant('database' as const),
      label: fc.string({ minLength: 1, maxLength: 128 }),
      connectionName: fc.string({ minLength: 1, maxLength: 64 }),
      databaseName: fc.string({ minLength: 1, maxLength: 64 }),
      isSystem: fc.boolean(),
      isOffline: fc.boolean(),
    });

    /** Generator: arbitrary ErrorNode */
    const arbitraryErrorNode: fc.Arbitrary<ErrorNode> = fc.record({
      kind: fc.constant('error' as const),
      label: fc.string({ minLength: 1, maxLength: 128 }),
      connectionName: fc.string({ minLength: 1, maxLength: 64 }),
      message: fc.string({ minLength: 1, maxLength: 256 }),
      retryAction: fc.constant(undefined),
    });

    /** Generator: arbitrary ColumnNode (covers column, columnPK, columnFK contextValues) */
    const arbitraryColumnNode: fc.Arbitrary<ColumnNode> = fc.record({
      kind: fc.constant('column' as const),
      label: fc.string({ minLength: 1, maxLength: 128 }),
      connectionName: fc.string({ minLength: 1, maxLength: 64 }),
      database: fc.string({ minLength: 1, maxLength: 64 }),
      columnName: fc.string({ minLength: 1, maxLength: 128 }),
      dataType: fc.string({ minLength: 1, maxLength: 64 }),
      isPrimaryKey: fc.boolean(),
      isForeignKey: fc.boolean(),
    });

    /** Generator: any node that returns label (folder, server, database, error) */
    const arbitraryLabelNode: fc.Arbitrary<TreeNode> = fc.oneof(
      arbitraryFolderNode,
      arbitraryServerNode,
      arbitraryDatabaseNode,
      arbitraryErrorNode
    );

    it('returns columnName for column nodes regardless of PK/FK status', () => {
      fc.assert(
        fc.property(arbitraryColumnNode, (node) => {
          const result = getCopyText(node);
          expect(result).toBe(node.columnName);
        }),
        { numRuns: 100 }
      );
    });

    it('returns label for folder nodes', () => {
      fc.assert(
        fc.property(arbitraryFolderNode, (node) => {
          const result = getCopyText(node);
          expect(result).toBe(node.label);
        }),
        { numRuns: 100 }
      );
    });

    it('returns label for server nodes', () => {
      fc.assert(
        fc.property(arbitraryServerNode, (node) => {
          const result = getCopyText(node);
          expect(result).toBe(node.label);
        }),
        { numRuns: 100 }
      );
    });

    it('returns label for database nodes (including offline)', () => {
      fc.assert(
        fc.property(arbitraryDatabaseNode, (node) => {
          const result = getCopyText(node);
          expect(result).toBe(node.label);
        }),
        { numRuns: 100 }
      );
    });

    it('returns label for error nodes', () => {
      fc.assert(
        fc.property(arbitraryErrorNode, (node) => {
          const result = getCopyText(node);
          expect(result).toBe(node.label);
        }),
        { numRuns: 100 }
      );
    });

    it('never returns qualified name format for non-table/non-view nodes', () => {
      fc.assert(
        fc.property(arbitraryLabelNode, (node) => {
          const result = getCopyText(node);
          // Should not contain the ].[ pattern that indicates qualified name format
          expect(result).not.toMatch(/\]\.\[/);
        }),
        { numRuns: 100 }
      );
    });

    it('column nodes with isPrimaryKey=true still return columnName', () => {
      fc.assert(
        fc.property(arbitraryColumnNode, (node) => {
          const pkNode: ColumnNode = { ...node, isPrimaryKey: true, isForeignKey: false };
          const result = getCopyText(pkNode);
          expect(result).toBe(pkNode.columnName);
        }),
        { numRuns: 100 }
      );
    });

    it('column nodes with isForeignKey=true still return columnName', () => {
      fc.assert(
        fc.property(arbitraryColumnNode, (node) => {
          const fkNode: ColumnNode = { ...node, isPrimaryKey: false, isForeignKey: true };
          const result = getCopyText(fkNode);
          expect(result).toBe(fkNode.columnName);
        }),
        { numRuns: 100 }
      );
    });
  });
});
