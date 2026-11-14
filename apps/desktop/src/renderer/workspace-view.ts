import type { WorkspaceDetail, WorkspaceReference } from '@chatsplice/protocol';

import type { Translate } from './appearance.js';

export function selectUserWorkspaces(workspaces: WorkspaceDetail[]): WorkspaceDetail[] {
  return workspaces.filter((workspace) => workspace.kind === 'user');
}

export function selectWorkspaceReferences(
  references: WorkspaceReference[],
  workspaceId: string,
): WorkspaceReference[] {
  return references.filter((reference) => reference.source_workspace_id === workspaceId);
}

export function referenceWorkspaceName(
  t: Translate,
  workspaces: WorkspaceDetail[],
  workspaceId: string,
): string {
  return (
    workspaces.find((workspace) => workspace.workspace_id === workspaceId)?.display_name ??
    t('unregisteredProject')
  );
}

export function selectReferenceCandidates(
  references: WorkspaceReference[],
  userWorkspaces: WorkspaceDetail[],
  workspaceId: string,
): WorkspaceDetail[] {
  const linkedWorkspaceIds = new Set(
    selectWorkspaceReferences(references, workspaceId).map(
      (reference) => reference.reference_workspace_id,
    ),
  );
  return userWorkspaces.filter(
    (workspace) =>
      workspace.workspace_id !== workspaceId && !linkedWorkspaceIds.has(workspace.workspace_id),
  );
}
