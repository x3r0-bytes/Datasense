import { XMLParser } from 'fast-xml-parser';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface PlanStatement {
  /** 1-based statement index within the batch */
  statementIndex: number;
  /** The SQL text of the statement (may be truncated) */
  statementText: string;
  /** Statement type: SELECT, INSERT, UPDATE, DELETE, etc. */
  statementType: string;
  /** Total estimated subtree cost for this statement */
  estimatedTotalCost: number;
  /** Root operator node of the execution tree */
  rootOperator: PlanOperator;
}

export interface PlanOperator {
  /** Physical operation name (e.g., "Clustered Index Seek") */
  physicalOp: string;
  /** Logical operation name (e.g., "Clustered Index Seek") */
  logicalOp: string;
  /** Estimated number of rows produced */
  estimatedRows: number;
  /** Estimated I/O cost */
  estimatedIOCost: number;
  /** Estimated CPU cost */
  estimatedCPUCost: number;
  /** Estimated subtree cost (cumulative) */
  estimatedSubtreeCost: number;
  /** Cost percentage relative to total statement cost (0-100) */
  costPercentage: number;
  /** Output columns list */
  outputColumns: string[];
  /** Operator-specific predicates keyed by type */
  predicates: Record<string, string>;
  /** Child operators (data flows from children to parent) */
  children: PlanOperator[];
  /** Optional: actual rows (only for actual execution plans) */
  actualRows?: number;
  /** Optional: index name for seek/scan operators */
  indexName?: string;
}

export interface MissingIndexSuggestion {
  /** Schema-qualified table name */
  table: string;
  /** Columns for equality predicates */
  equalityColumns: string[];
  /** Columns for inequality predicates */
  inequalityColumns: string[];
  /** Columns to include (non-key) */
  includedColumns: string[];
}

export interface ExecutionPlanResult {
  success: true;
  statements: PlanStatement[];
  missingIndexes: MissingIndexSuggestion[];
}

export interface ExecutionPlanError {
  success: false;
  error: string;
}

export type ParsedExecutionPlan = ExecutionPlanResult | ExecutionPlanError;

// ─── Parser Implementation ──────────────────────────────────────────────────

/**
 * Parses a SHOWPLAN_XML string into a structured execution plan.
 * Pure function: deterministic, no side effects, no exceptions thrown.
 *
 * @param xml - The raw SHOWPLAN_XML string from SQL Server
 * @returns Either a successful parsed plan or an error descriptor
 */
export function parseExecutionPlanXml(xml: string): ParsedExecutionPlan {
  try {
    if (!xml || typeof xml !== 'string' || xml.trim().length === 0) {
      return { success: false, error: 'Input is empty or not a string' };
    }

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      removeNSPrefix: true,
      parseTagValue: true,
      parseAttributeValue: false,
      trimValues: true,
      isArray: (tagName: string) => {
        // These elements can appear multiple times and should always be arrays
        const arrayTags = [
          'StmtSimple', 'StmtCond', 'RelOp', 'ColumnReference',
          'MissingIndexGroup', 'MissingIndex', 'ColumnGroup', 'Column',
          'Batch', 'Statements', 'ScalarOperator'
        ];
        return arrayTags.includes(tagName);
      }
    });

    const parsed = parser.parse(xml);

    // Navigate to the root ShowPlanXML element
    const showPlanXml = parsed.ShowPlanXML;
    if (!showPlanXml) {
      return { success: false, error: 'Missing root ShowPlanXML element' };
    }

    const batchSequence = showPlanXml.BatchSequence;
    if (!batchSequence) {
      return { success: false, error: 'Missing BatchSequence element' };
    }

    // Collect all statements across all batches
    const statements: PlanStatement[] = [];
    const missingIndexes: MissingIndexSuggestion[] = [];
    let statementCounter = 0;

    const batches = ensureArray(batchSequence.Batch);
    for (const batch of batches) {
      const statementsContainer = batch.Statements;
      if (!statementsContainer) { continue; }

      const stmtContainers = ensureArray(statementsContainer);
      for (const stmtContainer of stmtContainers) {
        const stmtSimples = ensureArray(stmtContainer.StmtSimple);
        for (const stmt of stmtSimples) {
          statementCounter++;
          const planStatement = parseStatement(stmt, statementCounter);
          if (planStatement) {
            statements.push(planStatement);
          }

          // Extract missing indexes from each statement
          const stmtMissingIndexes = extractMissingIndexes(stmt);
          missingIndexes.push(...stmtMissingIndexes);
        }
      }
    }

    if (statements.length === 0) {
      return { success: false, error: 'No valid statement plans found in the XML' };
    }

    return {
      success: true,
      statements,
      missingIndexes
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to parse execution plan XML: ${message}` };
  }
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Ensures a value is always an array.
 */
function ensureArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) { return []; }
  return Array.isArray(value) ? value : [value];
}

/**
 * Parses a single StmtSimple element into a PlanStatement.
 */
function parseStatement(stmt: any, index: number): PlanStatement | null {
  const statementText = stmt['@_StatementText'] || '';
  const statementType = stmt['@_StatementType'] || 'UNKNOWN';
  const estimatedTotalCost = parseFloat(stmt['@_StatementSubTreeCost'] || '0') || 0;

  // Find the QueryPlan element which contains the root RelOp
  const queryPlan = stmt.QueryPlan;
  if (!queryPlan) { return null; }

  // The root RelOp is directly under QueryPlan
  const relOps = ensureArray(queryPlan.RelOp);
  if (relOps.length === 0) { return null; }

  // Parse the root operator (first RelOp under QueryPlan)
  const rootOperator = parseRelOp(relOps[0], estimatedTotalCost);

  // Calculate cost percentages for all operators in the tree
  calculateCostPercentages(rootOperator, estimatedTotalCost);

  return {
    statementIndex: index,
    statementText,
    statementType,
    estimatedTotalCost,
    rootOperator
  };
}

/**
 * Recursively parses a RelOp element into a PlanOperator tree.
 */
function parseRelOp(relOp: any, totalStatementCost: number): PlanOperator {
  const physicalOp = relOp['@_PhysicalOp'] || '';
  const logicalOp = relOp['@_LogicalOp'] || '';
  const estimatedRows = parseFloat(relOp['@_EstimateRows'] || '0') || 0;
  const estimatedIOCost = parseFloat(relOp['@_EstimateIO'] || '0') || 0;
  const estimatedCPUCost = parseFloat(relOp['@_EstimateCPU'] || '0') || 0;
  const estimatedSubtreeCost = parseFloat(relOp['@_EstimatedTotalSubtreeCost'] || '0') || 0;
  const actualRows = relOp['@_ActualRows'] !== undefined
    ? parseFloat(relOp['@_ActualRows']) || 0
    : undefined;

  // Extract output columns
  const outputColumns = extractOutputColumns(relOp.OutputList);

  // Extract predicates and index name from operator-specific elements
  const { predicates, indexName } = extractOperatorDetails(relOp, physicalOp);

  // Recursively parse child RelOp elements
  const children = findChildRelOps(relOp);

  return {
    physicalOp,
    logicalOp,
    estimatedRows,
    estimatedIOCost,
    estimatedCPUCost,
    estimatedSubtreeCost,
    costPercentage: 0, // Will be calculated later
    outputColumns,
    predicates,
    children,
    ...(actualRows !== undefined ? { actualRows } : {}),
    ...(indexName ? { indexName } : {})
  };
}

/**
 * Recursively finds child RelOp elements within an operator.
 * Child RelOps are nested inside operator-specific elements (e.g., NestedLoops, Hash, etc.)
 */
function findChildRelOps(relOp: any): PlanOperator[] {
  const children: PlanOperator[] = [];

  // Operator-specific elements that can contain child RelOps
  const operatorElements = [
    'NestedLoops', 'Hash', 'Merge', 'Concat', 'Parallelism',
    'StreamAggregate', 'Sort', 'Filter', 'Top', 'ComputeScalar',
    'IndexScan', 'TableScan', 'ClusteredIndexScan', 'ClusteredIndexSeek',
    'IndexSeek', 'TableValuedFunction', 'Spool', 'RowCountSpool',
    'Segment', 'SequenceProject', 'Window', 'WindowAggregate',
    'Adaptive', 'Assert', 'Bitmap', 'Collapse', 'ConstantScan',
    'DeletedScan', 'ForeignKeyReferencesCheck', 'HashMatch',
    'InsertedScan', 'LogRowScan', 'MergeInterval', 'Nary',
    'ParameterTableScan', 'PrintDataflow', 'Put', 'RemoteQuery',
    'RemoteScan', 'RemoteModify', 'RemoteRange', 'RemoteFetch',
    'RIDLookup', 'RowCountTop', 'ScalarInsert', 'Sequence',
    'SimpleUpdate', 'Split', 'Switch', 'TableMerge', 'TopSort',
    'Update', 'Generic'
  ];

  for (const elemName of operatorElements) {
    const elem = relOp[elemName];
    if (elem) {
      const relOps = ensureArray(elem.RelOp);
      for (const childRelOp of relOps) {
        children.push(parseRelOp(childRelOp, 0));
      }
    }
  }

  // Also check for direct RelOp children (some plans nest differently)
  const directRelOps = ensureArray(relOp.RelOp);
  for (const childRelOp of directRelOps) {
    children.push(parseRelOp(childRelOp, 0));
  }

  return children;
}

/**
 * Extracts output columns from an OutputList element.
 */
function extractOutputColumns(outputList: any): string[] {
  if (!outputList) { return []; }

  const columns: string[] = [];
  const columnRefs = ensureArray(outputList.ColumnReference);

  for (const colRef of columnRefs) {
    const parts: string[] = [];
    if (colRef['@_Database']) { parts.push(colRef['@_Database']); }
    if (colRef['@_Schema']) { parts.push(colRef['@_Schema']); }
    if (colRef['@_Table']) { parts.push(colRef['@_Table']); }
    if (colRef['@_Column']) { parts.push(colRef['@_Column']); }

    columns.push(parts.length > 0 ? parts.join('.') : (colRef['@_Column'] || ''));
  }

  return columns;
}

/**
 * Extracts predicates and index name from operator-specific elements.
 */
function extractOperatorDetails(relOp: any, physicalOp: string): {
  predicates: Record<string, string>;
  indexName: string | undefined;
} {
  const predicates: Record<string, string> = {};
  let indexName: string | undefined;

  // Index operations: IndexScan, IndexSeek, ClusteredIndexScan, ClusteredIndexSeek
  const indexOps = ['IndexScan', 'IndexSeek', 'ClusteredIndexScan', 'ClusteredIndexSeek'];
  for (const opName of indexOps) {
    const op = relOp[opName];
    if (op) {
      // Extract index name from Object element
      if (op.Object) {
        const objects = ensureArray(op.Object);
        if (objects.length > 0) {
          indexName = objects[0]['@_Index'] || objects[0]['@_IndexName'] || undefined;
        }
      }

      // Extract seek predicates
      if (op.SeekPredicates) {
        const seekText = extractPredicateText(op.SeekPredicates);
        if (seekText) { predicates['seekPredicate'] = seekText; }
      }

      // Extract predicates (residual)
      if (op.Predicate) {
        const predText = extractScalarOperatorText(op.Predicate);
        if (predText) { predicates['residual'] = predText; }
      }
    }
  }

  // Hash Match operations
  const hashOp = relOp['Hash'] || relOp['HashMatch'];
  if (hashOp) {
    if (hashOp.HashKeysBuild) {
      const keysText = extractColumnList(hashOp.HashKeysBuild);
      if (keysText) { predicates['hashKeys'] = keysText; }
    }
    if (hashOp.HashKeysProbe) {
      const keysText = extractColumnList(hashOp.HashKeysProbe);
      if (keysText) { predicates['hashKeysProbe'] = keysText; }
    }
    if (hashOp.ProbeResidual) {
      const predText = extractScalarOperatorText(hashOp.ProbeResidual);
      if (predText) { predicates['residual'] = predText; }
    }
    if (hashOp.BuildResidual) {
      const predText = extractScalarOperatorText(hashOp.BuildResidual);
      if (predText) { predicates['buildResidual'] = predText; }
    }
  }

  // Nested Loops
  const nestedLoops = relOp['NestedLoops'];
  if (nestedLoops) {
    if (nestedLoops.Predicate) {
      const predText = extractScalarOperatorText(nestedLoops.Predicate);
      if (predText) { predicates['residual'] = predText; }
    }
    if (nestedLoops.OuterReferences) {
      const refs = extractColumnList(nestedLoops.OuterReferences);
      if (refs) { predicates['outerReferences'] = refs; }
    }
  }

  // Merge join
  const merge = relOp['Merge'];
  if (merge) {
    if (merge.InnerSideJoinColumns) {
      const cols = extractColumnList(merge.InnerSideJoinColumns);
      if (cols) { predicates['innerSideJoinColumns'] = cols; }
    }
    if (merge.OuterSideJoinColumns) {
      const cols = extractColumnList(merge.OuterSideJoinColumns);
      if (cols) { predicates['outerSideJoinColumns'] = cols; }
    }
    if (merge.Residual) {
      const predText = extractScalarOperatorText(merge.Residual);
      if (predText) { predicates['residual'] = predText; }
    }
  }

  // Filter
  const filter = relOp['Filter'];
  if (filter) {
    if (filter.Predicate) {
      const predText = extractScalarOperatorText(filter.Predicate);
      if (predText) { predicates['residual'] = predText; }
    }
  }

  // Sort
  const sort = relOp['Sort'];
  if (sort) {
    if (sort.OrderBy) {
      const orderText = extractOrderByText(sort.OrderBy);
      if (orderText) { predicates['orderBy'] = orderText; }
    }
  }

  return { predicates, indexName };
}

/**
 * Extracts text representation from a SeekPredicates element.
 */
function extractPredicateText(seekPredicates: any): string {
  if (!seekPredicates) { return ''; }

  const parts: string[] = [];
  const seekPredicateList = ensureArray(seekPredicates.SeekPredicate || seekPredicates.SeekPredicateNew);

  for (const seekPred of seekPredicateList) {
    // StartRange
    if (seekPred.StartRange) {
      const rangeColumns = seekPred.StartRange.RangeColumns;
      const rangeExpressions = seekPred.StartRange.RangeExpressions;
      const colText = extractColumnList(rangeColumns);
      const exprText = extractScalarExprList(rangeExpressions);
      if (colText && exprText) {
        parts.push(`${colText} >= ${exprText}`);
      } else if (colText) {
        parts.push(`Start: ${colText}`);
      }
    }

    // EndRange
    if (seekPred.EndRange) {
      const rangeColumns = seekPred.EndRange.RangeColumns;
      const rangeExpressions = seekPred.EndRange.RangeExpressions;
      const colText = extractColumnList(rangeColumns);
      const exprText = extractScalarExprList(rangeExpressions);
      if (colText && exprText) {
        parts.push(`${colText} <= ${exprText}`);
      } else if (colText) {
        parts.push(`End: ${colText}`);
      }
    }

    // Prefix (equality seek)
    if (seekPred.Prefix) {
      const rangeColumns = seekPred.Prefix.RangeColumns;
      const rangeExpressions = seekPred.Prefix.RangeExpressions;
      const colText = extractColumnList(rangeColumns);
      const exprText = extractScalarExprList(rangeExpressions);
      if (colText && exprText) {
        parts.push(`${colText} = ${exprText}`);
      } else if (colText) {
        parts.push(`Seek: ${colText}`);
      }
    }
  }

  return parts.join(' AND ');
}

/**
 * Extracts text from a ScalarOperator element or Predicate container.
 */
function extractScalarOperatorText(predicate: any): string {
  if (!predicate) { return ''; }

  // The predicate may contain a ScalarOperator with a ScalarString attribute
  const scalarOps = ensureArray(predicate.ScalarOperator);
  for (const scalarOp of scalarOps) {
    if (scalarOp['@_ScalarString']) {
      return scalarOp['@_ScalarString'];
    }
  }

  // Fallback: try to extract a direct ScalarString
  if (predicate['@_ScalarString']) {
    return predicate['@_ScalarString'];
  }

  return '';
}

/**
 * Extracts a comma-separated column list from a container with ColumnReference elements.
 */
function extractColumnList(container: any): string {
  if (!container) { return ''; }

  const columnRefs = ensureArray(container.ColumnReference);
  const cols: string[] = [];

  for (const colRef of columnRefs) {
    const parts: string[] = [];
    if (colRef['@_Table']) { parts.push(colRef['@_Table']); }
    if (colRef['@_Column']) { parts.push(colRef['@_Column']); }
    cols.push(parts.length > 0 ? parts.join('.') : '');
  }

  return cols.filter(c => c.length > 0).join(', ');
}

/**
 * Extracts scalar expressions from a RangeExpressions container.
 */
function extractScalarExprList(container: any): string {
  if (!container) { return ''; }

  const scalarOps = ensureArray(container.ScalarOperator);
  const exprs: string[] = [];

  for (const scalarOp of scalarOps) {
    if (scalarOp['@_ScalarString']) {
      exprs.push(scalarOp['@_ScalarString']);
    }
  }

  return exprs.join(', ');
}

/**
 * Extracts OrderBy text from an OrderBy element.
 */
function extractOrderByText(orderBy: any): string {
  if (!orderBy) { return ''; }

  const orderByColumns = ensureArray(orderBy.OrderByColumn);
  const parts: string[] = [];

  for (const obc of orderByColumns) {
    const ascending = obc['@_Ascending'] === 'true' || obc['@_Ascending'] === true;
    const colRef = obc.ColumnReference;
    if (colRef) {
      const colParts: string[] = [];
      if (colRef['@_Table']) { colParts.push(colRef['@_Table']); }
      if (colRef['@_Column']) { colParts.push(colRef['@_Column']); }
      const colName = colParts.join('.');
      parts.push(`${colName} ${ascending ? 'ASC' : 'DESC'}`);
    }
  }

  return parts.join(', ');
}

/**
 * Calculates costPercentage for each operator in the tree.
 * Each operator's cost percentage = (operator's own cost / total statement cost) * 100
 * The "own cost" is the operator's subtree cost minus the sum of its children's subtree costs.
 * All percentages within a statement sum to 100%.
 */
function calculateCostPercentages(operator: PlanOperator, totalStatementCost: number): void {
  if (totalStatementCost <= 0) {
    // Avoid division by zero — assign 0% to all
    assignZeroCosts(operator);
    return;
  }

  // Collect all operators in the tree with their own costs
  const allOperators: { op: PlanOperator; ownCost: number }[] = [];
  collectOperatorCosts(operator, allOperators);

  // Calculate total of all own costs (should equal total statement cost, but normalize to be safe)
  const totalOwnCost = allOperators.reduce((sum, item) => sum + item.ownCost, 0);

  if (totalOwnCost <= 0) {
    // All zero costs — distribute equally or assign 0
    assignZeroCosts(operator);
    return;
  }

  // Assign percentages normalized so they sum to 100%
  for (const item of allOperators) {
    item.op.costPercentage = (item.ownCost / totalOwnCost) * 100;
  }
}

/**
 * Collects all operators in the tree with their "own" costs.
 * Own cost = subtree cost - sum of children's subtree costs.
 */
function collectOperatorCosts(operator: PlanOperator, result: { op: PlanOperator; ownCost: number }[]): void {
  const childrenSubtreeCost = operator.children.reduce((sum, child) => sum + child.estimatedSubtreeCost, 0);
  const ownCost = Math.max(0, operator.estimatedSubtreeCost - childrenSubtreeCost);

  result.push({ op: operator, ownCost });

  for (const child of operator.children) {
    collectOperatorCosts(child, result);
  }
}

/**
 * Sets all operators in a tree to 0% cost.
 */
function assignZeroCosts(operator: PlanOperator): void {
  operator.costPercentage = 0;
  for (const child of operator.children) {
    assignZeroCosts(child);
  }
}

/**
 * Extracts MissingIndex suggestions from a statement element.
 */
function extractMissingIndexes(stmt: any): MissingIndexSuggestion[] {
  const suggestions: MissingIndexSuggestion[] = [];

  // MissingIndexes can be at the QueryPlan level or Statement level
  const queryPlan = stmt.QueryPlan;
  if (!queryPlan) { return suggestions; }

  const missingIndexes = queryPlan.MissingIndexes;
  if (!missingIndexes) { return suggestions; }

  const missingIndexGroups = ensureArray(missingIndexes.MissingIndexGroup);
  for (const group of missingIndexGroups) {
    const indexes = ensureArray(group.MissingIndex);
    for (const idx of indexes) {
      const database = idx['@_Database'] || '';
      const schema = idx['@_Schema'] || '';
      const table = idx['@_Table'] || '';

      // Build schema-qualified table name
      const tableParts: string[] = [];
      if (database) { tableParts.push(database); }
      if (schema) { tableParts.push(schema); }
      if (table) { tableParts.push(table); }
      const qualifiedTable = tableParts.join('.');

      const equalityColumns: string[] = [];
      const inequalityColumns: string[] = [];
      const includedColumns: string[] = [];

      const columnGroups = ensureArray(idx.ColumnGroup);
      for (const colGroup of columnGroups) {
        const usage = (colGroup['@_Usage'] || '').toUpperCase();
        const columns = ensureArray(colGroup.Column);
        const colNames = columns.map((col: any) => col['@_Name'] || '').filter((n: string) => n.length > 0);

        switch (usage) {
          case 'EQUALITY':
            equalityColumns.push(...colNames);
            break;
          case 'INEQUALITY':
            inequalityColumns.push(...colNames);
            break;
          case 'INCLUDE':
            includedColumns.push(...colNames);
            break;
        }
      }

      suggestions.push({
        table: qualifiedTable,
        equalityColumns,
        inequalityColumns,
        includedColumns
      });
    }
  }

  return suggestions;
}
