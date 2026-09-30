import type { FsListEntry } from '@chatsplice/protocol';

export const PANEL_ROOT_PATH = '.';

export function joinWorkspacePath(parent: string, child: string): string {
  return parent === PANEL_ROOT_PATH ? child : `${parent}/${child}`;
}

export function parentWorkspacePath(path: string): string | null {
  if (path === PANEL_ROOT_PATH) return null;
  const lastSlash = path.lastIndexOf('/');
  return lastSlash < 0 ? PANEL_ROOT_PATH : path.slice(0, lastSlash) || PANEL_ROOT_PATH;
}

export function isPreviewableFile(entry: FsListEntry): boolean {
  return entry.type === 'file';
}

export function fileRequestIsCurrent(
  requestId: number,
  currentRequestId: number,
  workspaceId: string,
  currentWorkspaceId: string,
  path: string,
  currentPath: string,
): boolean {
  return (
    requestId === currentRequestId && workspaceId === currentWorkspaceId && path === currentPath
  );
}
