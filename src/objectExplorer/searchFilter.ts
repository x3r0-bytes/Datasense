// Object Explorer Search Filter — Pure functions for filtering tree nodes

import { TreeNode } from './types';

// ============================================================================
// Interfaces
// ============================================================================

/**
 * Represents a flattened tree node with its ancestor path for search indexing.
 */
export interface IndexedNode {
  /** The tree node */
  node: TreeNode;
  /** Ancestor chain from root to parent (inclusive), for context display */
  ancestors: TreeNode[];
  /** The label text used for matching (lowercased for perf) */
  labelLower: string;
}

// ============================================================================
// Public Functions
// ============================================================================

/**
 * Pure function: validates a search term.
 * Returns true if the term is >= 2 characters and <= 128 characters.
 */
export function isValidSearchTerm(term: string): boolean {
  return term.length >= 2 && term.length <= 128;
}

/**
 * Pure function: filters an indexed node list by search term.
 * Returns nodes whose labelLower contains the search term as a case-insensitive substring.
 *
 * @param index - The flat index of all loaded nodes
 * @param searchTerm - The user's search text (minimum 2 chars, max 128)
 * @returns Matching nodes with ancestors for tree reconstruction
 */
export function filterNodes(index: IndexedNode[], searchTerm: string): IndexedNode[] {
  const termLower = searchTerm.toLowerCase();
  return index.filter(entry => entry.labelLower.includes(termLower));
}

/**
 * Pure function: reconstructs a tree structure from matched indexed nodes.
 * Deduplicates ancestor nodes and returns a filtered tree suitable for display.
 * The returned array contains all unique nodes (matches + ancestors) that should
 * be visible in the filtered tree. Root-level nodes appear at the top level;
 * parent-child relationships are preserved via the ancestor chains.
 *
 * @param matches - The matched indexed nodes from filterNodes()
 * @returns A root-level array of TreeNodes forming the filtered tree
 */
export function buildFilteredTree(matches: IndexedNode[]): TreeNode[] {
  if (matches.length === 0) {
    return [];
  }

  // Collect all unique root-level nodes (deduplicated by composite key)
  const rootKeys = new Set<string>();
  const nodeByKey = new Map<string, TreeNode>();

  for (const match of matches) {
    const fullChain = [...match.ancestors, match.node];

    for (const node of fullChain) {
      nodeByKey.set(getNodeKey(node), node);
    }

    // The first element of ancestors (or the match itself if no ancestors) is the root
    if (fullChain.length > 0) {
      rootKeys.add(getNodeKey(fullChain[0]));
    }
  }

  // Return deduplicated root-level nodes
  const roots: TreeNode[] = [];
  for (const key of rootKeys) {
    const node = nodeByKey.get(key);
    if (node) {
      roots.push(node);
    }
  }

  return roots;
}

/**
 * Pure function: returns the deduplicated children of a given parent node
 * within the context of a filtered match set. Used by the provider to
 * traverse the filtered tree structure.
 *
 * @param parent - The parent node to get children for
 * @param matches - The matched indexed nodes from filterNodes()
 * @returns Child nodes that appear under the given parent in the filtered tree
 */
export function getFilteredChildren(parent: TreeNode, matches: IndexedNode[]): TreeNode[] {
  const parentKey = getNodeKey(parent);
  const childKeys = new Set<string>();
  const childByKey = new Map<string, TreeNode>();

  for (const match of matches) {
    const fullChain = [...match.ancestors, match.node];

    for (let i = 0; i < fullChain.length - 1; i++) {
      if (getNodeKey(fullChain[i]) === parentKey) {
        const child = fullChain[i + 1];
        const childKey = getNodeKey(child);
        if (!childKeys.has(childKey)) {
          childKeys.add(childKey);
          childByKey.set(childKey, child);
        }
      }
    }
  }

  return Array.from(childByKey.values());
}

// ============================================================================
// Private Helpers
// ============================================================================

/**
 * Generates a composite key for a TreeNode to allow deduplication.
 * Uses connectionName, kind, and label as the identity.
 */
function getNodeKey(node: TreeNode): string {
  return `${node.connectionName}::${node.kind}::${node.label}`;
}
