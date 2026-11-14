import type { FsListEntry } from '@chatsplice/protocol';

/** The owner file endpoint returns at most 200 direct children per request. */
export const FILE_TREE_PAGE_SIZE = 200;

/** Keep the local view within the same discovery depth bound as fs.list. */
export const FILE_TREE_MAX_DEPTH = 12;

/** Bound the number of rows retained by the renderer, even after many expands. */
export const FILE_TREE_MAX_NODES = 2_000;

export const PREVIEW_CACHE_MAX_FILES = 20;
export const PREVIEW_CACHE_MAX_BYTES = 1_048_576;

export type FileTreeNodeType = FsListEntry['type'];

export type FileTreeNodeState = {
  path: string;
  name: string;
  type: FileTreeNodeType;
  depth: number;
  expanded: boolean;
  children: FileTreeNodeState[];
  childrenLoaded: boolean;
  childrenLoading: boolean;
  childrenHasMore: boolean;
  childrenNextOffset: number | null;
};

export type FileTreeSearchMode = 'name' | 'content';

export type FlattenedFileTree = {
  nodes: FileTreeNodeState[];
  truncated: boolean;
};

export type BoundedChildrenMerge = {
  children: FileTreeNodeState[];
  truncated: boolean;
};

export function cachePreviewContent(
  cache: ReadonlyMap<string, string>,
  path: string,
  content: string,
  maxFiles = PREVIEW_CACHE_MAX_FILES,
  maxBytes = PREVIEW_CACHE_MAX_BYTES,
): Map<string, string> {
  const next = new Map(cache);
  next.delete(path);
  next.set(path, content);
  const encoder = new TextEncoder();
  let totalBytes = 0;
  for (const cachedContent of next.values()) {
    totalBytes += encoder.encode(cachedContent).byteLength;
  }
  while (next.size > maxFiles || totalBytes > maxBytes) {
    const oldest = next.entries().next().value as [string, string] | undefined;
    if (oldest === undefined) break;
    next.delete(oldest[0]);
    totalBytes -= encoder.encode(oldest[1]).byteLength;
  }
  return next;
}

function entryName(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash < 0 ? path : path.slice(lastSlash + 1);
}

export function treeDomKey(path: string): string {
  return encodeURIComponent(path);
}

export function isDirectoryNode(node: FileTreeNodeState): boolean {
  return node.type === 'directory';
}

export function canExpandNode(node: FileTreeNodeState): boolean {
  return isDirectoryNode(node) && node.depth < FILE_TREE_MAX_DEPTH;
}

export function createFileTreeNode(
  entry: FsListEntry,
  parentDepth: number | null = null,
): FileTreeNodeState {
  const depth = parentDepth === null ? 0 : parentDepth + 1;
  return {
    path: entry.path,
    name: entryName(entry.path),
    type: entry.type,
    depth,
    expanded: false,
    children: [],
    childrenLoaded: entry.type !== 'directory',
    childrenLoading: false,
    childrenHasMore: false,
    childrenNextOffset: null,
  };
}

export function sortFileTreeNodes(nodes: FileTreeNodeState[]): FileTreeNodeState[] {
  return nodes.slice().sort((left, right) => {
    if (left.type === 'directory' && right.type !== 'directory') return -1;
    if (left.type !== 'directory' && right.type === 'directory') return 1;
    return left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

/** Merge one bounded page while retaining expansion state for paths already loaded. */
export function mergeFileTreeChildren(
  existing: FileTreeNodeState[],
  entries: FsListEntry[],
  parentDepth: number | null,
): FileTreeNodeState[] {
  const currentByPath = new Map(existing.map((node) => [node.path, node]));
  for (const entry of entries) {
    const current = currentByPath.get(entry.path);
    if (current === undefined) {
      currentByPath.set(entry.path, createFileTreeNode(entry, parentDepth));
      continue;
    }
    // The owner listing is authoritative for type, while already loaded children
    // belong to the same path and must survive a root refresh page merge.
    current.type = entry.type;
    current.name = entryName(entry.path);
    if (entry.type !== 'directory') {
      current.children = [];
      current.childrenLoaded = true;
      current.childrenHasMore = false;
      current.childrenNextOffset = null;
    }
  }
  return sortFileTreeNodes(Array.from(currentByPath.values()));
}

/**
 * Merge a direct page without allowing already-loaded descendants to push the
 * retained tree past the caller's total-node budget.
 */
export function mergeFileTreeChildrenBounded(
  existing: FileTreeNodeState[],
  entries: FsListEntry[],
  parentDepth: number | null,
  maxNodes: number,
): BoundedChildrenMerge {
  const existingPaths = new Set(existing.map((node) => node.path));
  const merged = mergeFileTreeChildren(existing, entries, parentDepth);
  const retainedExisting = merged.filter((node) => existingPaths.has(node.path));
  let retainedCount = countFileTreeNodes(retainedExisting);
  const children: FileTreeNodeState[] = [];
  let truncated = false;

  for (const node of merged) {
    if (existingPaths.has(node.path)) {
      children.push(node);
      continue;
    }
    const nodeCount = countFileTreeNodes([node]);
    if (retainedCount + nodeCount > maxNodes) {
      truncated = true;
      continue;
    }
    children.push(node);
    retainedCount += nodeCount;
  }
  return { children: sortFileTreeNodes(children), truncated };
}

export function findFileTreeNode(
  nodes: FileTreeNodeState[],
  path: string,
): FileTreeNodeState | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    const child = findFileTreeNode(node.children, path);
    if (child !== undefined) return child;
  }
  return undefined;
}

function matchesNode(
  node: FileTreeNodeState,
  query: string,
  mode: FileTreeSearchMode,
  previewByPath: ReadonlyMap<string, string>,
): boolean {
  if (query === '') return true;
  if (mode === 'name') return node.name.toLocaleLowerCase().includes(query);
  const content = previewByPath.get(node.path);
  return (
    node.type === 'file' && content !== undefined && content.toLocaleLowerCase().includes(query)
  );
}

/**
 * Flatten only visible or already loaded matches. Search intentionally does not
 * walk the filesystem: the owner surface has no search IPC and this keeps the
 * renderer within the bounded lazy tree it has actually received.
 */
export function flattenFileTree(
  roots: FileTreeNodeState[],
  query = '',
  mode: FileTreeSearchMode = 'name',
  previewByPath: ReadonlyMap<string, string> = new Map(),
  maxNodes = FILE_TREE_MAX_NODES,
): FlattenedFileTree {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const nodes: FileTreeNodeState[] = [];
  let truncated = false;

  function visitExpanded(node: FileTreeNodeState): void {
    if (nodes.length >= maxNodes) {
      truncated = true;
      return;
    }
    nodes.push(node);
    if (node.expanded && node.childrenLoaded) {
      for (const child of node.children) {
        visitExpanded(child);
        if (nodes.length >= maxNodes) break;
      }
    }
  }

  function searchBranch(node: FileTreeNodeState): {
    matched: boolean;
    nodes: FileTreeNodeState[];
  } {
    const matchingSelf = matchesNode(node, normalizedQuery, mode, previewByPath);
    const descendants: FileTreeNodeState[] = [];
    let descendantMatch = false;
    if (node.type === 'directory' && node.childrenLoaded) {
      for (const child of node.children) {
        const result = searchBranch(child);
        descendantMatch = descendantMatch || result.matched;
        if (result.matched) descendants.push(...result.nodes);
      }
    }
    return {
      matched: matchingSelf || descendantMatch,
      nodes: matchingSelf || descendantMatch ? [node, ...descendants] : [],
    };
  }

  for (const root of sortFileTreeNodes(roots)) {
    if (normalizedQuery === '') {
      visitExpanded(root);
    } else {
      const branch = searchBranch(root);
      for (const node of branch.nodes) {
        if (nodes.length >= maxNodes) {
          truncated = true;
          break;
        }
        nodes.push(node);
      }
    }
    if (nodes.length >= maxNodes) break;
  }
  return { nodes, truncated };
}

export function countFileTreeNodes(nodes: FileTreeNodeState[]): number {
  return nodes.reduce((count, node) => count + 1 + countFileTreeNodes(node.children), 0);
}
