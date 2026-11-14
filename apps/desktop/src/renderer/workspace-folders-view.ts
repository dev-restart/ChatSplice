import type { WorkspaceDetail, WorkspaceReference } from '@chatsplice/protocol';
import type { UiTextKey } from './i18n.js';

export type WorkspaceFolderAccessMode = 'read_only' | 'read_write';

export function workspaceFolderAccess(reference: WorkspaceReference): WorkspaceFolderAccessMode {
  return reference.access_mode === 'read_write' ? 'read_write' : 'read_only';
}

export function workspaceFolderPath(
  reference: WorkspaceReference,
  workspaces: WorkspaceDetail[],
): string {
  return (
    workspaces.find((workspace) => workspace.workspace_id === reference.reference_workspace_id)
      ?.root_path ?? ''
  );
}

export function workspaceFolderNeedsReapproval(
  reference: WorkspaceReference,
  workspaces: WorkspaceDetail[],
): boolean {
  if (workspaceFolderAccess(reference) !== 'read_write') return false;
  const sourceRoot = workspaces.find(
    (workspace) => workspace.workspace_id === reference.source_workspace_id,
  )?.root_path;
  const targetRoot = workspaces.find(
    (workspace) => workspace.workspace_id === reference.reference_workspace_id,
  )?.root_path;
  return (
    sourceRoot === undefined ||
    targetRoot === undefined ||
    reference.source_root_path !== sourceRoot ||
    reference.reference_root_path !== targetRoot
  );
}

export function workspaceFolderErrorKey(error: unknown): UiTextKey {
  const message = error instanceof Error ? error.message : '';
  if (/workspace_reference_busy|\bbusy\b|queued|running/iu.test(message))
    return 'workspaceFolderBusy';
  if (message.includes('workspace_reference_source_changed')) return 'workspaceFolderSourceChanged';
  if (message.includes('workspace_reference_refresh_failed')) return 'workspaceFolderRefreshFailed';
  if (message.includes('workspace_reference_missing')) return 'workspaceFolderMissing';
  if (message.includes('workspace_reference_denied')) return 'workspaceFolderDenied';
  return 'workspaceFolderFailed';
}
