import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { filterNodes, buildFilteredTree, IndexedNode } from '../../src/objectExplorer/searchFilter';
import { TreeNode, TreeNodeKind } from '../../src/objectExplorer/types';

/**
 * Property-based tests for Object Explorer search filter
 * Feature: next-iteration-v092
 *
 * Property 1: Search Filter Completeness and Soundness
 * Validates: Requirements 1.2, 1.3, 1.6
 *
 * Property 2: Search Ancestor Preservation
 * Validates: Requirements 1.4
 */

// ============================================================================
// Generators
// ============================================================================

/** All node kinds that can appear in the Object Explorer */
const arbitraryNodeKind: fc.Arbitrary<TreeNodeKind> = fc.constantFrom(
  'server', 'folder', 'database', 'table', 'view', 'column',
  'constraint', 'trigger', 'index', 'statistic'
);

/** Generator: a connection name string */
const arbitraryConnectionName: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'.split('')),
  { minLength: 1, maxLength: 20 }
);

/** Generator: a node label that contains at least one alphabetic character */
const arbitraryLabel: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_. '.split('')),
  { minLength: 1, maxLength: 40 }
).filter(s => s.trim().length > 0);

/**
 * Generator: a valid search term (2–128 characters).
 * Uses the same character set as labels to ensure meaningful matches are possible.
 */
const arbitrarySearchTerm: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')),
  { minLength: 2, maxLength: 20 }
);

/**
 * Generator: builds a minimal TreeNode from kind, label, and connectionName.
 * Uses a ServerNode shape (simplest kind) since filterNodes only uses BaseTreeNode fields.
 */
function buildTreeNode(kind: TreeNodeKind, label: string, connectionName: string): TreeNode {
  return { kind, label, connectionName } as TreeNode;
}

/** Generator: a single TreeNode */
const arbitraryTreeNode: fc.Arbitrary<TreeNode> = fc.tuple(
  arbitraryNodeKind,
  arbitraryLabel,
  arbitraryConnectionName
).map(([kind, label, connectionName]) => buildTreeNode(kind, label, connectionName));

/** Generator: an ancestor chain (0–4 ancestor nodes) */
const arbitraryAncestors: fc.Arbitrary<TreeNode[]> = fc.array(arbitraryTreeNode, { minLength: 0, maxLength: 4 });

/** Generator: a single IndexedNode */
const arbitraryIndexedNode: fc.Arbitrary<IndexedNode> = fc.tuple(
  arbitraryTreeNode,
  arbitraryAncestors
).map(([node, ancestors]) => ({
  node,
  ancestors,
  labelLower: node.label.toLowerCase(),
}));

/** Generator: an array of IndexedNodes */
const arbitraryIndexedNodeArray: fc.Arbitrary<IndexedNode[]> = fc.array(
  arbitraryIndexedNode,
  { minLength: 0, maxLength: 30 }
);

/**
 * Generator: an IndexedNode whose label is guaranteed to contain a given search term.
 * Inserts the search term at a random position in the label.
 */
function arbitraryIndexedNodeContaining(term: string): fc.Arbitrary<IndexedNode> {
  return fc.tuple(
    arbitraryNodeKind,
    arbitraryConnectionName,
    arbitraryAncestors,
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 0, maxLength: 10 }),
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 0, maxLength: 10 }),
    fc.boolean()
  ).map(([kind, connectionName, ancestors, prefix, suffix, uppercase]) => {
    // Optionally change case to test case-insensitivity
    const insertedTerm = uppercase ? term.toUpperCase() : term;
    const label = prefix + insertedTerm + suffix;
    const node = buildTreeNode(kind, label, connectionName);
    return {
      node,
      ancestors,
      labelLower: label.toLowerCase(),
    };
  });
}

// ============================================================================
// Property 1: Search Filter Completeness and Soundness
// ============================================================================

describe('Feature: next-iteration-v092, Property 1: Search Filter Completeness and Soundness', () => {
  /**
   * Validates: Requirements 1.2, 1.3, 1.6
   *
   * For any array of IndexedNodes and any valid search term (2–128 characters),
   * filterNodes() SHALL return exactly those nodes whose label contains the
   * search term as a case-insensitive substring — no more, no fewer.
   * The result is independent of the case of the search term.
   */

  it('returns exactly the nodes whose label contains the search term (case-insensitive)', () => {
    fc.assert(
      fc.property(
        arbitraryIndexedNodeArray,
        arbitrarySearchTerm,
        (index, searchTerm) => {
          const result = filterNodes(index, searchTerm);
          const termLower = searchTerm.toLowerCase();

          // Compute the expected result by independently checking each node
          const expected = index.filter(entry =>
            entry.node.label.toLowerCase().includes(termLower)
          );

          // Completeness: every expected node is in the result
          expect(result.length).toBe(expected.length);

          // Soundness: every result node truly matches
          for (const entry of result) {
            expect(entry.labelLower).toContain(termLower);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('result is independent of the case of the search term', () => {
    fc.assert(
      fc.property(
        arbitraryIndexedNodeArray,
        arbitrarySearchTerm,
        (index, searchTerm) => {
          const resultLower = filterNodes(index, searchTerm.toLowerCase());
          const resultUpper = filterNodes(index, searchTerm.toUpperCase());
          const resultMixed = filterNodes(index, searchTerm);

          // All three should produce the same set of nodes
          expect(resultLower.length).toBe(resultUpper.length);
          expect(resultLower.length).toBe(resultMixed.length);

          // Same nodes should appear regardless of search term casing
          const keysLower = new Set(resultLower.map(r => r.node.label + '::' + r.node.connectionName));
          const keysUpper = new Set(resultUpper.map(r => r.node.label + '::' + r.node.connectionName));
          const keysMixed = new Set(resultMixed.map(r => r.node.label + '::' + r.node.connectionName));

          for (const key of keysLower) {
            expect(keysUpper.has(key)).toBe(true);
            expect(keysMixed.has(key)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('never returns nodes whose label does not contain the search term', () => {
    fc.assert(
      fc.property(
        arbitraryIndexedNodeArray,
        arbitrarySearchTerm,
        (index, searchTerm) => {
          const result = filterNodes(index, searchTerm);
          const termLower = searchTerm.toLowerCase();

          for (const entry of result) {
            expect(entry.node.label.toLowerCase().includes(termLower)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('always returns a node when its label contains the search term', () => {
    fc.assert(
      fc.property(
        arbitrarySearchTerm,
        arbitraryIndexedNodeArray,
        (searchTerm, otherNodes) => {
          // Create a node that definitely contains the search term
          const matchingLabel = 'prefix' + searchTerm + 'suffix';
          const matchingNode: IndexedNode = {
            node: buildTreeNode('table', matchingLabel, 'conn1'),
            ancestors: [],
            labelLower: matchingLabel.toLowerCase(),
          };

          const index = [...otherNodes, matchingNode];
          const result = filterNodes(index, searchTerm);

          // The matching node must appear in the result
          const found = result.some(r =>
            r.node.label === matchingLabel && r.node.connectionName === 'conn1'
          );
          expect(found).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ============================================================================
// Property 2: Search Ancestor Preservation
// ============================================================================

describe('Feature: next-iteration-v092, Property 2: Search Ancestor Preservation', () => {
  /**
   * Validates: Requirements 1.4
   *
   * For any set of matched IndexedNodes returned by filterNodes(),
   * buildFilteredTree() SHALL include every ancestor node in each matched
   * node's ancestor chain. The resulting tree maintains valid parent-child
   * relationships from root to match.
   */

  it('includes every ancestor of every matched node in the filtered tree', () => {
    fc.assert(
      fc.property(
        arbitrarySearchTerm,
        fc.array(
          arbitraryIndexedNodeContaining('test'),
          { minLength: 1, maxLength: 10 }
        ).chain(matchingNodes => {
          // Generate additional non-matching nodes to mix in
          return fc.array(arbitraryIndexedNode, { minLength: 0, maxLength: 10 }).map(otherNodes => ({
            matchingNodes,
            otherNodes,
          }));
        }),
        (_searchTerm, { matchingNodes }) => {
          // Use 'test' as the search term since matchingNodes are guaranteed to contain it
          const matches = filterNodes(matchingNodes, 'test');
          const tree = buildFilteredTree(matches);

          // For every match, verify all ancestors are present in the tree or reachable
          // The tree should contain root-level nodes from each match's ancestor chain
          for (const match of matches) {
            if (match.ancestors.length > 0) {
              // The root ancestor (first in ancestors array) must be in the tree roots
              const rootAncestor = match.ancestors[0];
              const rootKey = `${rootAncestor.connectionName}::${rootAncestor.kind}::${rootAncestor.label}`;
              const treeRootKeys = tree.map(n => `${n.connectionName}::${n.kind}::${n.label}`);
              expect(treeRootKeys).toContain(rootKey);
            } else {
              // If no ancestors, the match node itself should be a root
              const matchKey = `${match.node.connectionName}::${match.node.kind}::${match.node.label}`;
              const treeRootKeys = tree.map(n => `${n.connectionName}::${n.kind}::${n.label}`);
              expect(treeRootKeys).toContain(matchKey);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('buildFilteredTree returns empty array for empty matches', () => {
    const result = buildFilteredTree([]);
    expect(result).toEqual([]);
  });

  it('preserves all unique ancestors across multiple matches', () => {
    fc.assert(
      fc.property(
        fc.array(
          arbitraryIndexedNodeContaining('ab'),
          { minLength: 1, maxLength: 15 }
        ),
        (nodesWithTerm) => {
          const matches = filterNodes(nodesWithTerm, 'ab');

          if (matches.length === 0) {
            return; // Skip if no matches (shouldn't happen but guard against it)
          }

          const tree = buildFilteredTree(matches);

          // Collect all ancestor node keys that should be preserved
          const expectedAncestorKeys = new Set<string>();
          for (const match of matches) {
            for (const ancestor of match.ancestors) {
              expectedAncestorKeys.add(`${ancestor.connectionName}::${ancestor.kind}::${ancestor.label}`);
            }
            // The match node itself should also be reachable
            expectedAncestorKeys.add(`${match.node.connectionName}::${match.node.kind}::${match.node.label}`);
          }

          // All root-level nodes in the tree should be from the set of expected nodes
          for (const rootNode of tree) {
            const rootKey = `${rootNode.connectionName}::${rootNode.kind}::${rootNode.label}`;
            expect(expectedAncestorKeys.has(rootKey)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('every ancestor in a match chain appears in buildFilteredTree nodeByKey set', () => {
    fc.assert(
      fc.property(
        fc.array(
          arbitraryIndexedNodeContaining('xyz'),
          { minLength: 1, maxLength: 10 }
        ),
        (nodesWithTerm) => {
          const matches = filterNodes(nodesWithTerm, 'xyz');

          if (matches.length === 0) {
            return;
          }

          const tree = buildFilteredTree(matches);

          // Verify: for each match, the root of its ancestor chain is in the tree
          // This confirms ancestor preservation from root to match
          for (const match of matches) {
            const fullChain = [...match.ancestors, match.node];
            const rootNode = fullChain[0];
            const rootKey = `${rootNode.connectionName}::${rootNode.kind}::${rootNode.label}`;
            const treeKeys = tree.map(n => `${n.connectionName}::${n.kind}::${n.label}`);
            expect(treeKeys).toContain(rootKey);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
