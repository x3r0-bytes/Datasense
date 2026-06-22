/**
 * JoinGenerator — Produces FK-based JOIN completion items with auto-generated ON clauses.
 *
 * Given a set of source tables (from FROM/JOIN clauses) and the schema cache,
 * this module suggests target tables that share foreign key relationships with
 * the source tables, ordered with FK-related items before unrelated items.
 *
 * Each completion item includes:
 * - The schema-qualified table name as the label
 * - Relationship direction and FK column names in the detail text
 * - One item per distinct FK constraint
 *
 * Fallback behavior:
 * - Schema cache populating → return empty result (caller handles keyword-only)
 * - No FROM clause (no source tables) → return all tables/views without ON clause
 * - No FK relationships for source tables → return all tables/views without ON clause
 * - Non-FK completions: insert table name + alias with $0 after alias for manual ON clause
 */

import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
} from 'vscode-languageserver/node';

import { ISchemaCache, ForeignKeyInfo } from './schemaCache';
import { TableReference } from './completionProvider';
import { generateAlias } from './aliasGenerator';

/**
 * Context for generating JOIN completions.
 */
export interface JoinCompletionContext {
  /** Tables already referenced in FROM/JOIN clauses */
  sourceTableRefs: TableReference[];
  /** Aliases already in use in the current query */
  existingAliases: string[];
  /** Characters typed after the JOIN keyword (for prefix filtering) */
  prefix: string;
}

/**
 * Result of JOIN completion generation.
 */
export interface JoinCompletionResult {
  items: CompletionItem[];
}

/**
 * Generates JOIN completion items based on foreign key relationships.
 *
 * - If schema cache is populating, returns empty result (caller handles keyword-only)
 * - If no source tables (no FROM clause), returns all tables/views without ON clause
 * - If no FK relationships exist for source tables, returns all tables/views without ON clause
 * - Queries the schema cache for FK relationships involving the source tables
 * - Returns one completion item per distinct FK constraint
 * - FK-related items appear before unrelated table completions
 * - Filters by prefix when the user has typed characters after the JOIN keyword
 *
 * @param context - The JOIN completion context with source tables, existing aliases, and prefix
 * @param schemaCache - The schema cache containing tables, views, and FK data
 * @returns A JoinCompletionResult with filtered, ordered completion items
 */
export function getJoinCompletions(
  context: JoinCompletionContext,
  schemaCache: ISchemaCache
): JoinCompletionResult {
  const { sourceTableRefs, existingAliases, prefix } = context;

  // Graceful degradation: schema cache is still populating → return empty result
  // The caller (CompletionProvider) will handle returning keyword-only completions.
  // (Requirements 2.6, 8.3)
  if (schemaCache.isPopulating) {
    return { items: [] };
  }

  // Fallback: no FROM clause (no source tables) → return all tables/views without ON clause
  // (Requirements 2.5, 8.1)
  if (sourceTableRefs.length === 0) {
    const allItems = buildAllTablesWithoutOnClause(schemaCache, existingAliases);
    const filtered = filterByJoinPrefix(allItems, prefix);
    return { items: filtered };
  }

  // Collect FK-related completion items, consolidating by target table.
  // When multiple source tables produce FK items targeting the same table,
  // we merge them into a single completion item with all ON conditions joined by AND.
  // (Requirements 8.1, 8.2 — never comma-delimit column references)

  interface FkTargetEntry {
    targetSchema: string;
    targetTable: string;
    /** Each FK relationship contributing to this target's ON clause */
    relationships: {
      fk: ForeignKeyInfo;
      sourceRef: TableReference;
      sourceKey: string;
      direction: string;
    }[];
  }

  const fkItems: CompletionItem[] = [];
  const seenConstraints = new Set<string>();
  /** Map from lowercase "schema.table" key to consolidated target entry */
  const targetMap = new Map<string, FkTargetEntry>();

  for (const sourceRef of sourceTableRefs) {
    const schema = sourceRef.schema || 'dbo';
    const fks = schemaCache.getForeignKeysForTable(schema, sourceRef.name);

    for (const fk of fks) {
      // Skip if we've already processed this constraint
      if (seenConstraints.has(fk.constraintName)) {
        continue;
      }
      seenConstraints.add(fk.constraintName);

      // Determine the target table (the "other" side of the FK relationship)
      const sourceKey = `${schema}.${sourceRef.name}`.toLowerCase();
      const referencingKey = `${fk.referencingSchema}.${fk.referencingTable}`.toLowerCase();
      const referencedKey = `${fk.referencedSchema}.${fk.referencedTable}`.toLowerCase();

      let targetSchema: string;
      let targetTable: string;
      let direction: string;

      if (referencingKey === sourceKey) {
        // Source is the referencing table → target is the referenced table
        targetSchema = fk.referencedSchema;
        targetTable = fk.referencedTable;
        direction = 'referenced';
      } else if (referencedKey === sourceKey) {
        // Source is the referenced table → target is the referencing table
        targetSchema = fk.referencingSchema;
        targetTable = fk.referencingTable;
        direction = 'referencing';
      } else {
        // FK doesn't directly involve this source table at the expected key
        continue;
      }

      const targetKey = `${targetSchema}.${targetTable}`.toLowerCase();

      // Consolidate FK relationships by target table
      if (!targetMap.has(targetKey)) {
        targetMap.set(targetKey, {
          targetSchema,
          targetTable,
          relationships: [],
        });
      }
      targetMap.get(targetKey)!.relationships.push({
        fk,
        sourceRef,
        sourceKey,
        direction,
      });
    }
  }

  // Build one completion item per target table, merging all FK ON conditions with AND
  for (const [, entry] of targetMap) {
    const { targetSchema, targetTable, relationships } = entry;

    // Apply schema qualification rules (Requirement 7.1, 7.2)
    const displayName = formatTargetTableName(targetSchema, targetTable);
    const label = `${targetSchema}.${targetTable}`;

    // Build detail text from all relationships
    const detailParts = relationships.map(rel => {
      const columnNames = rel.fk.columnPairs
        .map(cp => `${cp.referencingColumn} → ${cp.referencedColumn}`)
        .join(', ');
      return `FK (${rel.direction}): ${columnNames}`;
    });
    const detail = detailParts.join(' | ');

    // Generate alias for the target table
    const targetAlias = generateAlias(targetTable, existingAliases);

    // Build consolidated ON clause: merge all FK relationships into AND-separated conditions
    const onClauseParts: string[] = [];
    for (const rel of relationships) {
      const partialOnClause = buildOnClause(rel.fk, rel.sourceRef, rel.sourceKey, targetAlias);
      onClauseParts.push(partialOnClause);
    }
    const onClause = onClauseParts.join(' AND ');

    // FK completion: TableName ${1:alias} ON source.col = ${1:alias}.col AND ...$0
    const insertText = `${displayName} \${1:${targetAlias}} ON ${onClause}$0`;

    fkItems.push({
      label,
      kind: CompletionItemKind.Module,
      detail,
      sortText: `0_${label}`, // Sort FK items first (prefix '0_')
      insertText,
      insertTextFormat: InsertTextFormat.Snippet,
    });
  }

  // Fallback: no FK relationships found for any source table → return all tables/views without ON clause
  // (Requirements 2.4, 3.6, 8.1)
  if (fkItems.length === 0) {
    const allItems = buildAllTablesWithoutOnClause(schemaCache, existingAliases);
    const filtered = filterByJoinPrefix(allItems, prefix);
    return { items: filtered };
  }

  // Collect unrelated table/view completions (all tables/views not already in FK items)
  const fkLabels = new Set(fkItems.map(item => (item.label as string).toLowerCase()));
  const unrelatedItems: CompletionItem[] = [];

  for (const table of schemaCache.tables) {
    const label = `${table.schema}.${table.name}`;
    if (!fkLabels.has(label.toLowerCase())) {
      // Non-FK completion: TableName ${1:alias}$0 (no ON clause, cursor after alias)
      // (Requirement 4.7)
      const displayName = formatTargetTableName(table.schema, table.name);
      const alias = generateAlias(table.name, existingAliases);
      const insertText = `${displayName} \${1:${alias}}$0`;

      unrelatedItems.push({
        label,
        kind: CompletionItemKind.Module,
        detail: 'Table',
        sortText: `1_${label}`, // Sort unrelated items after FK items (prefix '1_')
        insertText,
        insertTextFormat: InsertTextFormat.Snippet,
      });
    }
  }

  for (const view of schemaCache.views) {
    const label = `${view.schema}.${view.name}`;
    if (!fkLabels.has(label.toLowerCase())) {
      // Non-FK completion: ViewName ${1:alias}$0 (no ON clause, cursor after alias)
      const displayName = formatTargetTableName(view.schema, view.name);
      const alias = generateAlias(view.name, existingAliases);
      const insertText = `${displayName} \${1:${alias}}$0`;

      unrelatedItems.push({
        label,
        kind: CompletionItemKind.Module,
        detail: 'View',
        sortText: `1_${label}`, // Sort unrelated items after FK items (prefix '1_')
        insertText,
        insertTextFormat: InsertTextFormat.Snippet,
      });
    }
  }

  // Combine FK items first, then unrelated items
  const allItems = [...fkItems, ...unrelatedItems];

  // Apply prefix filtering
  const filtered = filterByJoinPrefix(allItems, prefix);

  return { items: filtered };
}

/**
 * Formats the target table name for insertion, applying schema qualification rules.
 *
 * - Omits schema prefix when schema is 'dbo' (case-insensitive) (Requirement 7.1)
 * - Includes schema prefix when schema is not 'dbo' (Requirement 7.2)
 */
export function formatTargetTableName(schema: string, tableName: string): string {
  if (schema.toLowerCase() === 'dbo') {
    return tableName;
  }
  return `${schema}.${tableName}`;
}

/**
 * Formats the source table reference for use in the ON clause.
 *
 * - Uses alias when present (Requirement 4.4, 7.4)
 * - Uses schema-qualified name when no alias (Requirement 4.5, 7.3)
 */
export function formatSourceReference(sourceRef: TableReference): string {
  if (sourceRef.alias) {
    return sourceRef.alias;
  }
  const schema = sourceRef.schema || 'dbo';
  return `${schema}.${sourceRef.name}`;
}

/**
 * Builds the ON clause for a FK-based join completion.
 *
 * - Single-column FK: `source.col = ${1:alias}.col`
 * - Composite FK: `source.col1 = ${1:alias}.col1 AND source.col2 = ${1:alias}.col2`
 * - Column pairs are in ordinal order (Requirement 4.3)
 *
 * @param fk - The foreign key info
 * @param sourceRef - The source table reference (for alias/name resolution)
 * @param sourceKey - The lowercased "schema.tableName" key for the source table
 * @param targetAlias - The generated alias for the target table (used as $1 tab stop)
 */
export function buildOnClause(
  fk: ForeignKeyInfo,
  sourceRef: TableReference,
  sourceKey: string,
  targetAlias: string
): string {
  const sourcePrefix = formatSourceReference(sourceRef);
  const referencingKey = `${fk.referencingSchema}.${fk.referencingTable}`.toLowerCase();

  // Determine which columns belong to source and which to target
  const pairs = fk.columnPairs.map(cp => {
    if (referencingKey === sourceKey) {
      // Source is referencing → source has referencingColumn, target has referencedColumn
      return {
        sourceCol: cp.referencingColumn,
        targetCol: cp.referencedColumn,
      };
    } else {
      // Source is referenced → source has referencedColumn, target has referencingColumn
      return {
        sourceCol: cp.referencedColumn,
        targetCol: cp.referencingColumn,
      };
    }
  });

  return pairs
    .map(p => `${sourcePrefix}.${p.sourceCol} = \${1:${targetAlias}}.${p.targetCol}`)
    .join(' AND ');
}

/**
 * Builds completion items for all tables and views without ON clause generation.
 * Used as fallback when no FK relationships exist or no FROM clause is present.
 *
 * Each item uses snippet format: `TableName ${1:alias}$0`
 * This gives the user a tab stop on the alias and places cursor after for manual ON clause.
 * (Requirements 2.4, 2.5, 4.7, 8.1)
 */
function buildAllTablesWithoutOnClause(
  schemaCache: ISchemaCache,
  existingAliases: string[]
): CompletionItem[] {
  const items: CompletionItem[] = [];

  for (const table of schemaCache.tables) {
    const label = `${table.schema}.${table.name}`;
    const displayName = formatTargetTableName(table.schema, table.name);
    const alias = generateAlias(table.name, existingAliases);
    const insertText = `${displayName} \${1:${alias}}$0`;

    items.push({
      label,
      kind: CompletionItemKind.Module,
      detail: 'Table',
      sortText: `1_${label}`,
      insertText,
      insertTextFormat: InsertTextFormat.Snippet,
    });
  }

  for (const view of schemaCache.views) {
    const label = `${view.schema}.${view.name}`;
    const displayName = formatTargetTableName(view.schema, view.name);
    const alias = generateAlias(view.name, existingAliases);
    const insertText = `${displayName} \${1:${alias}}$0`;

    items.push({
      label,
      kind: CompletionItemKind.Module,
      detail: 'View',
      sortText: `1_${label}`,
      insertText,
      insertTextFormat: InsertTextFormat.Snippet,
    });
  }

  return items;
}

/**
 * Filters completion items by case-insensitive prefix match.
 *
 * If the prefix is empty or whitespace-only, returns all items (no filtering).
 * Otherwise, filters items where:
 * - The full label (schema-qualified name, e.g., "dbo.Orders") starts with the prefix, OR
 * - The table name portion (after the dot) starts with the prefix
 *
 * This allows matching "O" against "dbo.Orders" (matches the table name "Orders")
 * as well as "dbo.O" against "dbo.Orders" (matches the full label).
 *
 * @param items - The completion items to filter
 * @param prefix - The typed prefix to filter by
 * @returns Filtered items preserving original order (FK items before unrelated)
 */
export function filterByJoinPrefix(
  items: CompletionItem[],
  prefix: string
): CompletionItem[] {
  // If prefix is empty or whitespace-only, return all items
  if (!prefix || prefix.trim().length === 0) {
    return items;
  }

  const lowerPrefix = prefix.toLowerCase();

  return items.filter(item => {
    const label = (item.label as string).toLowerCase();

    // Match against full schema-qualified label (e.g., "dbo.Orders")
    if (label.startsWith(lowerPrefix)) {
      return true;
    }

    // Match against just the table name (part after the dot)
    const dotIndex = label.indexOf('.');
    if (dotIndex >= 0) {
      const tableName = label.substring(dotIndex + 1);
      if (tableName.startsWith(lowerPrefix)) {
        return true;
      }
    }

    return false;
  });
}
