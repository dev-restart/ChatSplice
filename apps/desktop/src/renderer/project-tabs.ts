import type { ChatGptTabSummary, WorkspaceDetail } from '@chatsplice/protocol';

export function selectWorkspaceTabs(
  tabs: ChatGptTabSummary[],
  workspaceId: string,
): ChatGptTabSummary[] {
  return tabs.filter((tab) => tab.workspace_id === workspaceId);
}

export function projectTabLabel(workspace: WorkspaceDetail): string {
  return `${workspace.display_name.slice(0, 60)} · ChatGPT Project`;
}

export function legacyProjectTabLabel(workspace: WorkspaceDetail): string {
  return `${workspace.display_name} 대화`;
}

export function findConfirmedProjectTab(
  tabs: ChatGptTabSummary[],
  workspaceId: string,
): ChatGptTabSummary | undefined {
  return tabs.find((tab) => tab.workspace_id === workspaceId && tab.project_instructions_confirmed);
}

export function findProjectLauncherTab(
  tabs: ChatGptTabSummary[],
  workspaceId: string,
): ChatGptTabSummary | undefined {
  return findConfirmedProjectTab(tabs, workspaceId) ?? selectWorkspaceTabs(tabs, workspaceId)[0];
}

export interface MislabelledTabRepair {
  chatgpt_tab_id: string;
  label: string;
}

/**
 * Decides which ChatGPT tabs still carry a stale generated project label and
 * what label each should be renamed to. A tab is repaired only when its label
 * provably came from ChatSplice itself (it matches another workspace's
 * generated label or its own workspace's legacy label); user-renamed labels
 * are never touched.
 */
export function collectMislabelledTabRepairs(
  tabs: ChatGptTabSummary[],
  workspaces: WorkspaceDetail[],
): MislabelledTabRepair[] {
  const repairs: MislabelledTabRepair[] = [];
  for (const tab of tabs) {
    if (tab.workspace_id === null) continue;
    const workspace = workspaces.find(
      (candidate) => candidate.workspace_id === tab.workspace_id && candidate.kind === 'user',
    );
    if (workspace === undefined || tab.label === projectTabLabel(workspace)) continue;

    const matchesAnotherGeneratedLabel = workspaces.some(
      (candidate) =>
        candidate.workspace_id !== workspace.workspace_id &&
        candidate.kind === 'user' &&
        (tab.label === projectTabLabel(candidate) ||
          tab.label === legacyProjectTabLabel(candidate)),
    );
    const isOwnLegacyLabel = tab.label === legacyProjectTabLabel(workspace);
    if (!matchesAnotherGeneratedLabel && !isOwnLegacyLabel) continue;

    repairs.push({ chatgpt_tab_id: tab.chatgpt_tab_id, label: projectTabLabel(workspace) });
  }
  return repairs;
}
