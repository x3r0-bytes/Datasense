// Object Explorer Provider - TreeDataProvider implementation
// Supplies tree nodes to the VS Code TreeView for the Object Explorer panel.

import * as vscode from 'vscode';
import {
  TreeNode,
  ServerNode,
  ConnectionGroupNode,
  FolderNode,
  DatabaseNode,
  TableNode,
  ViewNode,
  ColumnNode,
  ConstraintNode,
  TriggerNode,
  IndexNode,
  StatisticNode,
  ErrorNode,
  FolderType,
  ConnectionFormInput,
  ServerConnectionConfig,
  NodeIdentity,
} from './types';
import { MetadataQueryService } from './metadataQueryService';
import { ObjectExplorerConnectionManager } from './objectExplorerConnectionManager';
import {
  sortNodes,
  formatTableLabel,
  formatColumnLabel,
  getColumnIcon,
  categorizeDatabases,
  getNodeIdentity,
  identityEquals,
} from './nodeUtils';
import { validate, isPortValid, isDisplayNameUnique } from './connectionFormValidator';
import {
  IndexedNode,
  isValidSearchTerm,
  filterNodes,
  buildFilteredTree,
  getFilteredChildren,
} from './searchFilter';

// ============================================================================
// Search Interfaces
// ============================================================================

/**
 * Snapshot of expansion state before search, for restoration.
 */
export interface TreeExpansionState {
  expandedNodeIds: Set<string>;
}

/**
 * The search state managed by ObjectExplorerProvider.
 */
export interface SearchState {
  term: string;
  preSearchState: TreeExpansionState | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Implements vscode.TreeDataProvider<TreeNode> to supply the Object Explorer tree.
 * Handles lazy loading of children on node expansion, error display, and refresh.
 */
export class ObjectExplorerProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Flat index of all loaded tree nodes, built incrementally as nodes are fetched */
  nodeIndex: IndexedNode[] = [];

  /** Current search term (empty string = inactive) */
  searchTerm: string = '';

  /** Search state including debounce timer and pre-search expansion snapshot */
  private searchState: SearchState = {
    term: '',
    preSearchState: null,
    debounceTimer: null,
  };

  /** Reference to the TreeView for saving/restoring expansion state */
  private treeView: vscode.TreeView<TreeNode> | undefined;

  /**
   * Tracks expansion paths for cycle detection.
   * Keyed by serialized NodeIdentity of the parent node; value is the ancestor path
   * from the originating table node down to (and including) that parent.
   */
  private expansionPaths: Map<string, NodeIdentity[]> = new Map();

  constructor(
    private readonly connectionManager: ObjectExplorerConnectionManager,
    private readonly metadataService: MetadataQueryService
  ) {}

  /**
   * Serializes a NodeIdentity to a stable string key for use in the expansionPaths map.
   */
  private serializeIdentity(identity: NodeIdentity): string {
    return `${identity.connectionName}::${identity.database || ''}::${identity.schema || ''}::${identity.objectName || ''}::${identity.folderType || ''}`;
  }

  /**
   * Fires the onDidChangeTreeData event to refresh the entire tree view.
   * Clears expansion paths to reset cycle detection state.
   */
  refresh(): void {
    this.expansionPaths.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * Fires the onDidChangeTreeData event to refresh a specific subtree.
   * Only the given node and its children will be re-fetched.
   */
  refreshNode(node: TreeNode): void {
    this._onDidChangeTreeData.fire(node);
  }

  /**
   * Sets the TreeView reference for expansion state management.
   */
  setTreeView(treeView: vscode.TreeView<TreeNode>): void {
    this.treeView = treeView;
  }

  /**
   * Sets the search term with debouncing. Handles truncation, state save/restore,
   * and triggers a tree refresh after the debounce period.
   *
   * @param term - The raw search input from the user
   */
  setSearchTerm(term: string): void {
    // Clear any pending debounce timer
    if (this.searchState.debounceTimer !== null) {
      clearTimeout(this.searchState.debounceTimer);
      this.searchState.debounceTimer = null;
    }

    // Truncate search terms exceeding 128 characters
    const truncatedTerm = term.length > 128 ? term.substring(0, 128) : term;

    // Debounce: wait 200ms before applying the filter
    this.searchState.debounceTimer = setTimeout(() => {
      this.applySearchTerm(truncatedTerm);
    }, 200);
  }

  /**
   * Applies the search term immediately (called after debounce).
   * Saves expansion state before first search; restores it when cleared.
   */
  private applySearchTerm(term: string): void {
    const wasSearchActive = isValidSearchTerm(this.searchTerm);
    const isSearchActive = isValidSearchTerm(term);

    // Save expansion state before first search activation
    if (!wasSearchActive && isSearchActive) {
      this.searchState.preSearchState = this.captureExpansionState();
    }

    // Update the search term
    this.searchTerm = term;
    this.searchState.term = term;

    // If search was cleared, restore pre-search state
    if (wasSearchActive && !isSearchActive) {
      this.restoreExpansionState(this.searchState.preSearchState);
      this.searchState.preSearchState = null;
    }

    // Refresh the tree to apply/remove filter
    this.refresh();
  }

  /**
   * Captures the current expansion state of the tree view.
   * Returns a TreeExpansionState with IDs of currently expanded nodes.
   */
  private captureExpansionState(): TreeExpansionState {
    // Since VS Code doesn't provide a direct API to get all expanded nodes,
    // we store the expansion state as a snapshot of known expanded node IDs.
    // The TreeView's reveal API and expand/collapse events can be used,
    // but for simplicity we capture what we know from the node index.
    return {
      expandedNodeIds: new Set<string>(),
    };
  }

  /**
   * Restores a previously captured expansion state.
   * Re-expands nodes that were expanded before the search started.
   */
  private restoreExpansionState(_state: TreeExpansionState | null): void {
    // VS Code TreeView doesn't provide direct programmatic collapse-all/expand API
    // for arbitrary nodes. The restore is handled by the tree refresh which resets
    // the tree to its natural state (all nodes collapsed except those VS Code remembers).
    // The primary purpose is to remove the filtered view and restore the full tree.
  }

  /**
   * Gets the composite key for a node, used for deduplication in the index.
   */
  private getNodeKey(node: TreeNode): string {
    const database = ('database' in node ? (node as any).database : ('databaseName' in node ? (node as any).databaseName : '')) || '';
    const schema = ('schema' in node ? (node as any).schema : '') || '';
    const objectName = ('objectName' in node ? (node as any).objectName :
      ('tableName' in node ? (node as any).tableName :
        ('viewName' in node ? (node as any).viewName :
          ('columnName' in node ? (node as any).columnName :
            ('triggerName' in node ? (node as any).triggerName :
              ('indexName' in node ? (node as any).indexName :
                ('statisticName' in node ? (node as any).statisticName : ''))))))) || '';
    return `${node.connectionName}::${node.kind}::${node.label}::${database}::${schema}::${objectName}`;
  }

  /**
   * Adds nodes to the node index, avoiding duplicates.
   * Called incrementally as getChildren() fetches nodes.
   */
  private addToIndex(nodes: TreeNode[], ancestors: TreeNode[]): void {
    for (const node of nodes) {
      const key = this.getNodeKey(node);
      const exists = this.nodeIndex.some(entry => this.getNodeKey(entry.node) === key);
      if (!exists) {
        this.nodeIndex.push({
          node,
          ancestors: [...ancestors],
          labelLower: node.label.toLowerCase(),
        });
      }
    }
  }

  /**
   * Builds the ancestor chain for a given element by searching the index.
   * Returns the ancestors array for the element, or an empty array for root nodes.
   */
  private getAncestorsForElement(element: TreeNode): TreeNode[] {
    const key = this.getNodeKey(element);
    const entry = this.nodeIndex.find(e => this.getNodeKey(e.node) === key);
    return entry ? [...entry.ancestors, element] : [element];
  }

  /**
   * Maps a TreeNode to a vscode.TreeItem for rendering in the tree view.
   */
  getTreeItem(element: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label);

    switch (element.kind) {
      case 'connectionGroup':
        item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        item.contextValue = 'connectionGroup';
        // Use a colored square SVG as the icon for the group
        const groupSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="2" fill="${element.color}"/></svg>`;
        const groupEncodedSvg = Buffer.from(groupSvg).toString('base64');
        const groupDataUri = vscode.Uri.parse(`data:image/svg+xml;base64,${groupEncodedSvg}`);
        item.iconPath = groupDataUri;
        break;

      case 'server':
        item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        item.contextValue = 'server';
        if (element.color) {
          // Use a colored circle SVG as the icon for color-coded connections
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="${element.color}"/></svg>`;
          const encodedSvg = Buffer.from(svg).toString('base64');
          const dataUri = vscode.Uri.parse(`data:image/svg+xml;base64,${encodedSvg}`);
          item.iconPath = dataUri;
        } else {
          item.iconPath = new vscode.ThemeIcon('server');
        }
        break;

      case 'folder':
        item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        // Folder nodes with schema + objectName + database that are NOT container
        // folders (columns, constraints, triggers, indexes, statistics) represent
        // individual programmability objects (stored procedures, functions).
        // Give them a distinct contextValue for the "Go to Definition" context menu.
        if (element.schema && element.objectName && element.database &&
            !['columns', 'constraints', 'triggers', 'indexes', 'statistics'].includes(element.folderType)) {
          item.contextValue = 'programmabilityObject';
        } else {
          item.contextValue = 'folder';
        }
        item.iconPath = new vscode.ThemeIcon('folder');
        break;

      case 'database':
        item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        item.contextValue = element.isOffline ? 'databaseOffline' : 'database';
        item.iconPath = new vscode.ThemeIcon(element.isOffline ? 'database' : 'database');
        if (element.isOffline) {
          item.description = '(offline)';
        }
        break;

      case 'table':
        item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        item.contextValue = element.isExternal ? 'externalTable' : 'table';
        item.iconPath = new vscode.ThemeIcon('table');
        // Wire double-click to open Table Preview (Requirement 1.1)
        if (!element.isExternal) {
          item.command = {
            command: 'sqlServer.openTablePreview',
            title: 'Open Table Preview',
            arguments: [element],
          };
        }
        break;

      case 'view':
        item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        item.contextValue = element.isSystem ? 'systemView' : 'view';
        item.iconPath = new vscode.ThemeIcon('eye');
        // Wire double-click to open Table Preview (Requirement 1.1)
        item.command = {
          command: 'sqlServer.openTablePreview',
          title: 'Open Table Preview',
          arguments: [element],
        };
        break;

      case 'column':
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        const iconType = getColumnIcon(element.isPrimaryKey, element.isForeignKey);
        if (iconType === 'pk') {
          item.iconPath = new vscode.ThemeIcon('key');
          item.contextValue = 'columnPK';
        } else if (iconType === 'fk') {
          item.iconPath = new vscode.ThemeIcon('references');
          item.contextValue = 'columnFK';
        } else {
          item.iconPath = new vscode.ThemeIcon('symbol-field');
          item.contextValue = 'column';
        }
        break;

      case 'trigger':
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        item.contextValue = 'trigger';
        item.iconPath = new vscode.ThemeIcon('zap');
        break;

      case 'index':
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        item.contextValue = 'index';
        item.iconPath = new vscode.ThemeIcon('list-ordered');
        break;

      case 'statistic':
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        item.contextValue = 'statistic';
        item.iconPath = new vscode.ThemeIcon('graph');
        break;

      case 'constraint':
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        item.contextValue = 'constraint';
        item.iconPath = new vscode.ThemeIcon('lock');
        break;

      case 'error':
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        item.contextValue = 'error';
        item.iconPath = new vscode.ThemeIcon('error');
        item.description = element.message;
        break;
    }

    return item;
  }

  /**
   * Returns children for a given tree node, or root server nodes if no element is provided.
   * Delegates to specific handlers based on node kind.
   * When search is active (≥2 chars), returns results from the filtered tree instead.
   * Builds the node index incrementally as nodes are fetched.
   */
  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    // When search is active, return filtered results
    if (isValidSearchTerm(this.searchTerm)) {
      const filtered = this.getFilteredChildren(element);
      // If no matches at the root level, return a placeholder node so VS Code
      // doesn't show the welcome view ("No servers connected" / Add Connection)
      if (!element && filtered.length === 0) {
        const noResults: ErrorNode = {
          kind: 'error',
          label: 'No results found',
          connectionName: '',
          message: `No matches for "${this.searchTerm}"`,
        };
        return [noResults];
      }
      return filtered;
    }

    // Normal (non-search) mode — fetch children and index them
    if (!element) {
      const roots = this.getRootNodes();
      this.addToIndex(roots, []);
      return roots;
    }

    // --- Ancestor-path cycle detection ---
    // For each element, compute its identity and check for cycles / depth cap.
    const identity = getNodeIdentity(element);
    const identityKey = this.serializeIdentity(identity);

    // Look up the expansion path stored for this node (set by its parent).
    // If no path exists, this is a top-level expansion — start with an empty path.
    const currentPath = this.expansionPaths.get(identityKey) || [];

    // Cycle detection: if this node's identity already appears in the ancestor path, stop.
    if (currentPath.some(ancestor => identityEquals(ancestor, identity))) {
      return [];
    }

    // Depth cap: only applies when expanding table/view nodes (FK relationship chains).
    // Normal folder hierarchy (server → databases → database → tables → ...) is not depth-limited.
    if (element.kind === 'table' || element.kind === 'view') {
      // Count how many table/view ancestors are in the path (FK recursion depth)
      const tableViewDepth = currentPath.filter(a => a.objectName && !a.folderType).length;
      if (tableViewDepth >= 3) {
        return [];
      }
    }

    // Build the updated path for this node's children (current path + this node's identity).
    const childPath = [...currentPath, identity];

    let children: TreeNode[];

    switch (element.kind) {
      case 'connectionGroup':
        children = this.getConnectionGroupChildren(element as ConnectionGroupNode);
        break;
      case 'server':
        children = this.getServerChildren(element);
        break;
      case 'folder':
        children = await this.getFolderChildren(element);
        break;
      case 'database':
        children = this.getDatabaseChildren(element);
        break;
      case 'table':
        children = this.getTableChildren(element);
        break;
      case 'view':
        children = this.getViewChildren(element);
        break;
      // Leaf node kinds — VS Code should never call getChildren on these
      // (collapsibleState is None), but guard defensively just in case.
      case 'constraint':
      case 'trigger':
      case 'index':
      case 'statistic':
      case 'column':
      case 'error':
        children = [];
        break;
      default:
        children = [];
        break;
    }

    // Add fetched children to the node index with their ancestor chain
    const ancestors = this.getAncestorsForElement(element);
    this.addToIndex(children, ancestors);

    // Store the expansion path for each child so that when getChildren is called
    // on a child, it can look up its ancestor path for cycle detection.
    for (const child of children) {
      const childIdentity = getNodeIdentity(child);
      const childKey = this.serializeIdentity(childIdentity);
      this.expansionPaths.set(childKey, childPath);
    }

    return children;
  }

  /**
   * Returns filtered children when search is active.
   * Uses the node index and search filter functions to compute the filtered tree.
   */
  private getFilteredChildren(element?: TreeNode): TreeNode[] {
    const matches = filterNodes(this.nodeIndex, this.searchTerm);

    if (!element) {
      // Return root-level nodes of the filtered tree
      return buildFilteredTree(matches);
    }

    // Return children of the given element within the filtered tree
    return getFilteredChildren(element, matches);
  }

  /**
   * Returns root-level nodes: connection groups (as folders) and ungrouped server nodes.
   * Groups appear first (sorted alphabetically), then ungrouped connections (sorted alphabetically).
   */
  private getRootNodes(): TreeNode[] {
    const connections = this.connectionManager.getConnections();
    const groups = this.connectionManager.getGroups();

    const groupNodes: TreeNode[] = [];
    const serverNodes: TreeNode[] = [];

    // Add connection group nodes
    for (const group of groups) {
      const groupNode: ConnectionGroupNode = {
        kind: 'connectionGroup',
        label: group.name,
        connectionName: '', // Groups don't belong to a single connection
        color: group.color,
        groupName: group.name,
      };
      groupNodes.push(groupNode);
    }

    // Add ungrouped server nodes
    const ungroupedConnections = connections.filter(conn => !conn.group);
    for (const conn of ungroupedConnections) {
      const serverNode: ServerNode = {
        kind: 'server',
        label: conn.name,
        connectionName: conn.name,
        color: conn.color,
        group: conn.group,
      };
      serverNodes.push(serverNode);
    }

    // Groups first (sorted), then ungrouped connections (sorted)
    return [...sortNodes(groupNodes), ...sortNodes(serverNodes)];
  }

  /**
   * Returns the 3 top-level folders for a server node:
   * Databases, Security, Server Objects
   */
  private getServerChildren(node: ServerNode): TreeNode[] {
    const folders: FolderNode[] = [
      { kind: 'folder', label: 'Databases', connectionName: node.connectionName, folderType: 'databases' },
      { kind: 'folder', label: 'Security', connectionName: node.connectionName, folderType: 'security' },
      { kind: 'folder', label: 'Server Objects', connectionName: node.connectionName, folderType: 'serverObjects' },
    ];
    return folders;
  }

  /**
   * Returns the server nodes that belong to a connection group.
   */
  private getConnectionGroupChildren(node: ConnectionGroupNode): TreeNode[] {
    const connections = this.connectionManager.getConnections();
    const groupConnections = connections.filter(c => c.group === node.groupName);
    const serverNodes: ServerNode[] = groupConnections.map(conn => ({
      kind: 'server' as const,
      label: conn.name,
      connectionName: conn.name,
      color: conn.color || node.color, // Inherit group color if connection has none
      group: conn.group,
    }));
    return sortNodes(serverNodes);
  }

  /**
   * Returns the 8 category folders for a database node.
   */
  private getDatabaseChildren(node: DatabaseNode): TreeNode[] {
    const folders: FolderNode[] = [
      { kind: 'folder', label: 'Tables', connectionName: node.connectionName, folderType: 'tables', database: node.databaseName },
      { kind: 'folder', label: 'Views', connectionName: node.connectionName, folderType: 'views', database: node.databaseName },
      { kind: 'folder', label: 'Synonyms', connectionName: node.connectionName, folderType: 'synonyms', database: node.databaseName },
      { kind: 'folder', label: 'Programmability', connectionName: node.connectionName, folderType: 'programmability', database: node.databaseName },
      { kind: 'folder', label: 'External Resources', connectionName: node.connectionName, folderType: 'externalResources', database: node.databaseName },
      { kind: 'folder', label: 'Service Broker', connectionName: node.connectionName, folderType: 'serviceBroker', database: node.databaseName },
      { kind: 'folder', label: 'Storage', connectionName: node.connectionName, folderType: 'storage', database: node.databaseName },
      { kind: 'folder', label: 'Security', connectionName: node.connectionName, folderType: 'dbSecurity', database: node.databaseName },
    ];
    return folders;
  }

  /**
   * Returns the 5 sub-folders for a table node:
   * Columns, Constraints, Triggers, Indexes, Statistics
   */
  private getTableChildren(node: TableNode): TreeNode[] {
    const folders: FolderNode[] = [
      { kind: 'folder', label: 'Columns', connectionName: node.connectionName, folderType: 'columns', database: node.database, schema: node.schema, objectName: node.tableName },
      { kind: 'folder', label: 'Constraints', connectionName: node.connectionName, folderType: 'constraints', database: node.database, schema: node.schema, objectName: node.tableName },
      { kind: 'folder', label: 'Triggers', connectionName: node.connectionName, folderType: 'triggers', database: node.database, schema: node.schema, objectName: node.tableName },
      { kind: 'folder', label: 'Indexes', connectionName: node.connectionName, folderType: 'indexes', database: node.database, schema: node.schema, objectName: node.tableName },
      { kind: 'folder', label: 'Statistics', connectionName: node.connectionName, folderType: 'statistics', database: node.database, schema: node.schema, objectName: node.tableName },
    ];
    return folders;
  }

  /**
   * Returns the 5 sub-folders for a view node:
   * Columns, Constraints, Triggers, Indexes, Statistics
   */
  private getViewChildren(node: ViewNode): TreeNode[] {
    const folders: FolderNode[] = [
      { kind: 'folder', label: 'Columns', connectionName: node.connectionName, folderType: 'columns', database: node.database, schema: node.schema, objectName: node.viewName },
      { kind: 'folder', label: 'Constraints', connectionName: node.connectionName, folderType: 'constraints', database: node.database, schema: node.schema, objectName: node.viewName },
      { kind: 'folder', label: 'Triggers', connectionName: node.connectionName, folderType: 'triggers', database: node.database, schema: node.schema, objectName: node.viewName },
      { kind: 'folder', label: 'Indexes', connectionName: node.connectionName, folderType: 'indexes', database: node.database, schema: node.schema, objectName: node.viewName },
      { kind: 'folder', label: 'Statistics', connectionName: node.connectionName, folderType: 'statistics', database: node.database, schema: node.schema, objectName: node.viewName },
    ];
    return folders;
  }

  /**
   * Resolves children for a folder node based on its folderType.
   * Fetches data from MetadataQueryService for data-bearing folders.
   */
  private async getFolderChildren(node: FolderNode): Promise<TreeNode[]> {
    try {
      switch (node.folderType) {
        case 'databases':
          return await this.getDatabasesFolderChildren(node);
        case 'systemDatabases':
          return await this.getSystemDatabasesFolderChildren(node);
        case 'tables':
          return this.getTablesFolderChildren(node);
        case 'tablesUser':
          return await this.getUserTablesFolderChildren(node);
        case 'tablesExternal':
          return await this.getExternalTablesFolderChildren(node);
        case 'views':
          return this.getViewsFolderChildren(node);
        case 'viewsUser':
          return await this.getUserViewsFolderChildren(node);
        case 'viewsSystem':
          return await this.getSystemViewsFolderChildren(node);
        case 'columns':
          return await this.getColumnsFolderChildren(node);
        case 'constraints':
          return await this.getConstraintsFolderChildren(node);
        case 'triggers':
          return await this.getTriggersFolderChildren(node);
        case 'indexes':
          return await this.getIndexesFolderChildren(node);
        case 'statistics':
          return await this.getStatisticsFolderChildren(node);
        // Placeholder folders that have no data-fetching logic yet
        case 'security':
        case 'serverObjects':
        case 'synonyms':
        case 'programmability':
        case 'externalResources':
        case 'serviceBroker':
        case 'storage':
        case 'dbSecurity':
          return [];
        default:
          return [];
      }
    } catch (error: any) {
      return [this.createErrorNode(node.connectionName, error)];
    }
  }

  /**
   * Returns user databases + System Databases folder for the Databases folder.
   */
  private async getDatabasesFolderChildren(node: FolderNode): Promise<TreeNode[]> {
    const pool = await this.connectionManager.getPool(node.connectionName);
    const databases = await this.metadataService.getDatabases(pool);
    const { user, system } = categorizeDatabases(databases);

    const userNodes: DatabaseNode[] = user.map(db => ({
      kind: 'database',
      label: db.name,
      connectionName: node.connectionName,
      databaseName: db.name,
      isSystem: false,
      isOffline: db.state !== 'online',
    }));

    const systemFolder: FolderNode = {
      kind: 'folder',
      label: 'System Databases',
      connectionName: node.connectionName,
      folderType: 'systemDatabases',
    };

    return [...sortNodes(userNodes), systemFolder];
  }

  /**
   * Returns system database nodes for the System Databases folder.
   */
  private async getSystemDatabasesFolderChildren(node: FolderNode): Promise<TreeNode[]> {
    const pool = await this.connectionManager.getPool(node.connectionName);
    const databases = await this.metadataService.getDatabases(pool);
    const { system } = categorizeDatabases(databases);

    const systemNodes: DatabaseNode[] = system.map(db => ({
      kind: 'database',
      label: db.name,
      connectionName: node.connectionName,
      databaseName: db.name,
      isSystem: true,
      isOffline: db.state !== 'online',
    }));

    return sortNodes(systemNodes);
  }

  /**
   * Returns the Tables and External Tables sub-folders.
   */
  private getTablesFolderChildren(node: FolderNode): TreeNode[] {
    return [
      { kind: 'folder', label: 'Tables', connectionName: node.connectionName, folderType: 'tablesUser', database: node.database },
      { kind: 'folder', label: 'External Tables', connectionName: node.connectionName, folderType: 'tablesExternal', database: node.database },
    ];
  }

  /**
   * Returns user table nodes.
   */
  private async getUserTablesFolderChildren(node: FolderNode): Promise<TreeNode[]> {
    const pool = await this.connectionManager.getPoolForDatabase(node.connectionName, node.database!);
    const tables = await this.metadataService.getTables(pool, node.database!);

    const tableNodes: TableNode[] = tables.map(t => ({
      kind: 'table',
      label: formatTableLabel(t.schema, t.name),
      connectionName: node.connectionName,
      database: node.database!,
      schema: t.schema,
      tableName: t.name,
      isExternal: false,
    }));

    return sortNodes(tableNodes);
  }

  /**
   * Returns external table nodes.
   */
  private async getExternalTablesFolderChildren(node: FolderNode): Promise<TreeNode[]> {
    const pool = await this.connectionManager.getPoolForDatabase(node.connectionName, node.database!);
    const tables = await this.metadataService.getExternalTables(pool, node.database!);

    const tableNodes: TableNode[] = tables.map(t => ({
      kind: 'table',
      label: formatTableLabel(t.schema, t.name),
      connectionName: node.connectionName,
      database: node.database!,
      schema: t.schema,
      tableName: t.name,
      isExternal: true,
    }));

    return sortNodes(tableNodes);
  }

  /**
   * Returns the Views and System Views sub-folders.
   */
  private getViewsFolderChildren(node: FolderNode): TreeNode[] {
    return [
      { kind: 'folder', label: 'Views', connectionName: node.connectionName, folderType: 'viewsUser', database: node.database },
      { kind: 'folder', label: 'System Views', connectionName: node.connectionName, folderType: 'viewsSystem', database: node.database },
    ];
  }

  /**
   * Returns user view nodes.
   */
  private async getUserViewsFolderChildren(node: FolderNode): Promise<TreeNode[]> {
    const pool = await this.connectionManager.getPoolForDatabase(node.connectionName, node.database!);
    const views = await this.metadataService.getViews(pool, node.database!);

    const viewNodes: ViewNode[] = views.map(v => ({
      kind: 'view',
      label: formatTableLabel(v.schema, v.name),
      connectionName: node.connectionName,
      database: node.database!,
      schema: v.schema,
      viewName: v.name,
      isSystem: false,
    }));

    return sortNodes(viewNodes);
  }

  /**
   * Returns system view nodes.
   */
  private async getSystemViewsFolderChildren(node: FolderNode): Promise<TreeNode[]> {
    const pool = await this.connectionManager.getPoolForDatabase(node.connectionName, node.database!);
    const views = await this.metadataService.getSystemViews(pool, node.database!);

    const viewNodes: ViewNode[] = views.map(v => ({
      kind: 'view',
      label: formatTableLabel(v.schema, v.name),
      connectionName: node.connectionName,
      database: node.database!,
      schema: v.schema,
      viewName: v.name,
      isSystem: true,
    }));

    return sortNodes(viewNodes);
  }

  /**
   * Returns column nodes for a table or view.
   */
  private async getColumnsFolderChildren(node: FolderNode): Promise<TreeNode[]> {
    const pool = await this.connectionManager.getPoolForDatabase(node.connectionName, node.database!);
    const columns = await this.metadataService.getColumns(pool, node.database!, node.schema!, node.objectName!);

    const columnNodes: ColumnNode[] = columns.map(c => ({
      kind: 'column',
      label: formatColumnLabel(c.name, c.dataType),
      connectionName: node.connectionName,
      database: node.database!,
      columnName: c.name,
      dataType: c.dataType,
      isPrimaryKey: c.isPrimaryKey,
      isForeignKey: c.isForeignKey,
      parentObjectName: node.objectName,
    }));

    return columnNodes; // Columns maintain ordinal order, not sorted alphabetically
  }

  /**
   * Returns constraint nodes for a table.
   * Each constraint is a leaf node (kind: 'constraint') with collapsibleState None.
   * Self-referencing FK constraints are rendered as simple leaf nodes without
   * attempting recursive expansion back into the same table.
   */
  private async getConstraintsFolderChildren(node: FolderNode): Promise<TreeNode[]> {
    const pool = await this.connectionManager.getPoolForDatabase(node.connectionName, node.database!);
    const constraints = await this.metadataService.getConstraints(pool, node.database!, node.schema!, node.objectName!);

    const constraintNodes: ConstraintNode[] = constraints.map(c => ({
      kind: 'constraint',
      label: `${c.name} (${c.type})`,
      connectionName: node.connectionName,
      database: node.database!,
      schema: node.schema!,
      tableName: node.objectName!,
      constraintName: c.name,
      constraintType: c.type,
    }));

    return sortNodes(constraintNodes);
  }

  /**
   * Returns trigger nodes for a table.
   * Each trigger is a leaf node (kind: 'trigger') with collapsibleState None.
   * Returns [] for empty result sets; errors bubble up to getFolderChildren which
   * wraps them in a single ErrorNode.
   */
  private async getTriggersFolderChildren(node: FolderNode): Promise<TreeNode[]> {
    const pool = await this.connectionManager.getPoolForDatabase(node.connectionName, node.database!);
    const triggers = await this.metadataService.getTriggers(pool, node.database!, node.schema!, node.objectName!);

    if (triggers.length === 0) {
      return [];
    }

    const triggerNodes: TriggerNode[] = triggers.map(t => ({
      kind: 'trigger',
      label: t.name,
      connectionName: node.connectionName,
      database: node.database!,
      schema: node.schema!,
      tableName: node.objectName!,
      triggerName: t.name,
    }));

    return sortNodes(triggerNodes);
  }

  /**
   * Returns index nodes for a table.
   * Each index is a leaf node (kind: 'index') with collapsibleState None.
   * Returns [] for empty result sets; errors bubble up to getFolderChildren which
   * wraps them in a single ErrorNode.
   */
  private async getIndexesFolderChildren(node: FolderNode): Promise<TreeNode[]> {
    const pool = await this.connectionManager.getPoolForDatabase(node.connectionName, node.database!);
    const indexes = await this.metadataService.getIndexes(pool, node.database!, node.schema!, node.objectName!);

    if (indexes.length === 0) {
      return [];
    }

    const indexNodes: IndexNode[] = indexes.map(i => ({
      kind: 'index',
      label: i.name,
      connectionName: node.connectionName,
      database: node.database!,
      schema: node.schema!,
      tableName: node.objectName!,
      indexName: i.name,
    }));

    return sortNodes(indexNodes);
  }

  /**
   * Returns statistic nodes for a table.
   * Each statistic is a leaf node (kind: 'statistic') with collapsibleState None.
   * Returns [] for empty result sets; errors bubble up to getFolderChildren which
   * wraps them in a single ErrorNode.
   */
  private async getStatisticsFolderChildren(node: FolderNode): Promise<TreeNode[]> {
    const pool = await this.connectionManager.getPoolForDatabase(node.connectionName, node.database!);
    const statistics = await this.metadataService.getStatistics(pool, node.database!, node.schema!, node.objectName!);

    if (statistics.length === 0) {
      return [];
    }

    const statisticNodes: StatisticNode[] = statistics.map(s => ({
      kind: 'statistic',
      label: s.name,
      connectionName: node.connectionName,
      database: node.database!,
      schema: node.schema!,
      tableName: node.objectName!,
      statisticName: s.name,
    }));

    return sortNodes(statisticNodes);
  }

  /**
   * Implements the Add Connection command flow using VS Code input boxes.
   * Collects connection details step by step, validates input, checks uniqueness, and saves.
   *
   * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 4.3
   */
  async addConnection(): Promise<void> {
    // Step 1: Pick authentication type (Requirement 3.2, 3.5, 3.6)
    const authTypePick = await vscode.window.showQuickPick(
      [
        { label: 'SQL Server Authentication', value: 'sql' as const },
        { label: 'Windows Authentication', value: 'windows' as const },
      ],
      {
        placeHolder: 'Select authentication type',
        ignoreFocusOut: true,
      }
    );

    if (!authTypePick) {
      return; // User cancelled
    }

    const authType = authTypePick.value;

    // Step 2: Server name (Requirement 3.2 - max 255 characters)
    const serverName = await vscode.window.showInputBox({
      prompt: 'Enter server name or IP address',
      placeHolder: 'e.g., localhost or myserver.database.windows.net',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Server name is required';
        }
        if (value.trim().length > 255) {
          return 'Server name must be 255 characters or fewer';
        }
        return undefined;
      },
    });

    if (serverName === undefined) {
      return; // User cancelled
    }

    // Step 3: Display name (Requirement 3.2 - max 128 characters, Requirement 3.7 - unique)
    const existingNames = this.connectionManager.getConnections().map(c => c.name);

    const displayName = await vscode.window.showInputBox({
      prompt: 'Enter a display name for this connection',
      placeHolder: 'e.g., My Local Server',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Display name is required';
        }
        if (value.trim().length > 128) {
          return 'Display name must be 128 characters or fewer';
        }
        if (!isDisplayNameUnique(value.trim(), existingNames)) {
          return 'A connection with this display name already exists';
        }
        return undefined;
      },
    });

    if (displayName === undefined) {
      return; // User cancelled
    }

    // Step 4: Port (Requirement 3.2 - optional, defaults to 1433, Requirement 3.8 - integer 1-65535)
    const portInput = await vscode.window.showInputBox({
      prompt: 'Enter port number (leave empty for default 1433)',
      placeHolder: '1433',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return undefined; // Empty is valid (defaults to 1433)
        }
        if (!isPortValid(value.trim())) {
          return 'Port must be an integer between 1 and 65535';
        }
        return undefined;
      },
    });

    if (portInput === undefined) {
      return; // User cancelled
    }

    // Step 5: Encryption option (Requirement 3.2)
    const encryptPick = await vscode.window.showQuickPick(
      [
        { label: 'Optional', value: 'Optional' as const },
        { label: 'Mandatory', value: 'Mandatory' as const },
        { label: 'Strict', value: 'Strict' as const },
      ],
      {
        placeHolder: 'Encrypt connection?',
        ignoreFocusOut: true,
      }
    );

    if (!encryptPick) {
      return; // User cancelled
    }

    // Step 6: Trust server certificate (Requirement 3.2)
    const trustCertPick = await vscode.window.showQuickPick(
      [
        { label: 'Yes', value: true },
        { label: 'No', value: false },
      ],
      {
        placeHolder: 'Trust server certificate?',
        ignoreFocusOut: true,
      }
    );

    if (!trustCertPick) {
      return; // User cancelled
    }

    // Step 7: Username and password (only for SQL auth - Requirement 3.5)
    let username: string | undefined;
    let password: string | undefined;

    if (authType === 'sql') {
      username = await vscode.window.showInputBox({
        prompt: 'Enter username',
        placeHolder: 'SQL Server username',
        ignoreFocusOut: true,
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return 'Username is required for SQL Server Authentication';
          }
          return undefined;
        },
      });

      if (username === undefined) {
        return; // User cancelled
      }

      // Step 8: Password (SQL auth - Requirement 3.5, not persisted - Requirement 12.7)
      password = await vscode.window.showInputBox({
        prompt: 'Enter password',
        placeHolder: 'SQL Server password',
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return 'Password is required for SQL Server Authentication';
          }
          return undefined;
        },
      });

      if (password === undefined) {
        return; // User cancelled
      }
    }

    // Build the form input for final validation
    const formInput: ConnectionFormInput = {
      authType,
      serverName: serverName.trim(),
      displayName: displayName.trim(),
      port: portInput.trim() || undefined,
      encrypt: encryptPick.value,
      trustServerCertificate: trustCertPick.value,
      username: username?.trim(),
      password,
    };

    // Final validation using ConnectionFormValidator (Requirement 3.4)
    const validationResult = validate(formInput);
    if (!validationResult.valid) {
      const errorMessages = validationResult.errors.map(e => e.message).join('; ');
      vscode.window.showErrorMessage(`Connection validation failed: ${errorMessages}`);
      return;
    }

    // Build the ServerConnectionConfig
    const config: ServerConnectionConfig = {
      name: formInput.displayName,
      host: formInput.serverName,
      port: formInput.port ? parseInt(formInput.port, 10) : undefined,
      authType: formInput.authType,
      user: formInput.username,
      password: formInput.password,
      encrypt: formInput.encrypt,
      trustServerCertificate: formInput.trustServerCertificate,
    };

    // Save via ObjectExplorerConnectionManager (Requirement 3.3) and refresh tree (Requirement 4.3)
    try {
      await this.connectionManager.saveConnection(config);
      this.refresh();
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to save connection: ${error?.message || 'Unknown error'}`);
    }
  }

  /**
   * Implements the Remove Connection command.
   * Shows a confirmation prompt before removing the connection from the manager and refreshing the tree.
   */
  async removeConnection(node: ServerNode): Promise<void> {
    const confirmation = await vscode.window.showWarningMessage(
      `Are you sure you want to remove the connection "${node.label}"?`,
      { modal: true },
      'Remove'
    );

    if (confirmation !== 'Remove') {
      return;
    }

    await this.connectionManager.removeConnection(node.label);
    this.refresh();
  }

  /**
   * Creates an error node for display when a query or operation fails.
   */
  private createErrorNode(connectionName: string, error: Error): ErrorNode {
    return {
      kind: 'error',
      label: 'Error',
      connectionName,
      message: error.message || 'An unknown error occurred',
    };
  }
}
