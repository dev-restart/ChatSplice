import type {
  ChatGptTabListResult,
  WorkspaceDetail,
  WorkspaceReference,
} from '@chatsplice/protocol';

import type { ChatSpliceBridge } from '../preload/index.js';
import type { Translate } from './appearance.js';
import { referenceWorkspaceName } from './workspace-view.js';

/**
 * Dependencies injected by App.svelte. Cross-domain side effects (tabs, toast,
 * project-automation flags, workspace detail dialog) stay with their owners;
 * this controller owns only workspace list/reference/selection state.
 */
export interface WorkspaceControllerDeps {
  readonly bridge: ChatSpliceBridge;
  readonly t: () => Translate;
  readonly runAction: (name: string, action: () => Promise<void>) => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly completeProjectAutomation: (workspaceId: string) => Promise<void>;
  readonly applyTabResult: (result: ChatGptTabListResult) => void;
  readonly clearProjectAutomationState: (workspaceId: string) => void;
  readonly clearWorkspaceDetails: (workspaceId: string) => void;
  readonly onNotice: (message: string) => void;
}

export class WorkspaceController {
  workspaces = $state<WorkspaceDetail[]>([]);
  workspaceReferences = $state<WorkspaceReference[]>([]);
  referenceSelectionByWorkspace = $state<Record<string, string>>({});
  selectedWorkspaceId = $state('');

  readonly #deps: WorkspaceControllerDeps;

  constructor(deps: WorkspaceControllerDeps) {
    this.#deps = deps;
  }

  async openWorkspace(): Promise<void> {
    const deps = this.#deps;
    await deps.runAction('workspace', async () => {
      const registeredWorkspaceIds = new Set(
        this.workspaces
          .filter((workspace) => workspace.kind === 'user')
          .map((workspace) => workspace.workspace_id),
      );
      const opened = await deps.bridge.openWorkspace();
      if (opened !== null) {
        this.selectedWorkspaceId = opened.workspace_id;
        await deps.refresh();
        if (!registeredWorkspaceIds.has(opened.workspace_id)) {
          await deps.completeProjectAutomation(opened.workspace_id);
          return;
        }
        deps.onNotice(deps.t()('workspaceAdded', { name: opened.display_name }));
      }
    });
  }

  async removeWorkspace(workspace: WorkspaceDetail): Promise<void> {
    const deps = this.#deps;
    const confirmed = window.confirm(
      deps.t()('removeWorkspaceConfirmation', { name: workspace.display_name }),
    );
    if (!confirmed) return;

    await deps.runAction(`workspace-remove-${workspace.workspace_id}`, async () => {
      const result = await deps.bridge.removeWorkspace({
        workspace_id: workspace.workspace_id,
      });
      this.workspaces = result.workspaces.workspaces;
      this.workspaceReferences = this.workspaceReferences.filter(
        (reference) =>
          reference.source_workspace_id !== workspace.workspace_id &&
          reference.reference_workspace_id !== workspace.workspace_id,
      );
      deps.applyTabResult(result.tabs);
      const remainingUserWorkspaces = result.workspaces.workspaces.filter(
        (candidate) => candidate.kind === 'user',
      );
      if (this.selectedWorkspaceId === workspace.workspace_id) {
        this.selectedWorkspaceId = remainingUserWorkspaces[0]?.workspace_id ?? '';
      }
      deps.clearProjectAutomationState(workspace.workspace_id);
      deps.clearWorkspaceDetails(workspace.workspace_id);
      deps.onNotice(deps.t()('workspaceRemoved', { name: workspace.display_name }));
    });
  }

  async addWorkspaceReference(
    sourceWorkspaceId: string,
    referenceWorkspaceId: string,
  ): Promise<void> {
    if (referenceWorkspaceId === '') return;
    const deps = this.#deps;
    await deps.runAction(`workspace-reference-add-${sourceWorkspaceId}`, async () => {
      const reference = await deps.bridge.addWorkspaceReference({
        source_workspace_id: sourceWorkspaceId,
        reference_workspace_id: referenceWorkspaceId,
      });
      this.workspaceReferences = [
        ...this.workspaceReferences.filter(
          (candidate) =>
            candidate.source_workspace_id !== reference.source_workspace_id ||
            candidate.reference_workspace_id !== reference.reference_workspace_id,
        ),
        reference,
      ];
      this.setReferenceSelection(sourceWorkspaceId, '');
      deps.onNotice(
        deps.t()('referenceAdded', {
          name: referenceWorkspaceName(deps.t(), this.workspaces, referenceWorkspaceId),
        }),
      );
    });
  }

  async removeWorkspaceReference(reference: WorkspaceReference): Promise<void> {
    const deps = this.#deps;
    await deps.runAction(
      `workspace-reference-remove-${reference.source_workspace_id}`,
      async () => {
        const result = await deps.bridge.removeWorkspaceReference({
          source_workspace_id: reference.source_workspace_id,
          reference_workspace_id: reference.reference_workspace_id,
        });
        this.workspaceReferences = result.references;
        deps.onNotice(
          deps.t()('referenceRemoved', {
            name: referenceWorkspaceName(
              deps.t(),
              this.workspaces,
              reference.reference_workspace_id,
            ),
          }),
        );
      },
    );
  }

  async renameWorkspace(workspaceId: string, displayName: string): Promise<void> {
    const deps = this.#deps;
    const current = this.workspaces.find((workspace) => workspace.workspace_id === workspaceId);
    if (displayName === '' || displayName === current?.display_name) return;
    await deps.runAction('workspace-rename', async () => {
      const renamed = await deps.bridge.renameWorkspace({
        workspace_id: workspaceId,
        display_name: displayName,
      });
      this.workspaces = this.workspaces.map((workspace) =>
        workspace.workspace_id === workspaceId
          ? { ...workspace, display_name: renamed.display_name }
          : workspace,
      );
    });
  }

  async changeWorkspaceRootPath(workspaceId: string): Promise<void> {
    const deps = this.#deps;
    await deps.runAction(`workspace-root-path-${workspaceId}`, async () => {
      const updated = await deps.bridge.updateWorkspaceRootPath(workspaceId);
      if (updated === null) return;
      this.workspaces = this.workspaces.map((candidate) =>
        candidate.workspace_id === workspaceId ? updated : candidate,
      );
    });
  }

  setReferenceSelection(workspaceId: string, value: string): void {
    this.referenceSelectionByWorkspace = {
      ...this.referenceSelectionByWorkspace,
      [workspaceId]: value,
    };
  }

  async copyBinding(workspaceId: string): Promise<void> {
    const deps = this.#deps;
    await deps.runAction('binding', async () => {
      await deps.bridge.copyProjectBinding(workspaceId);
      deps.onNotice(deps.t()('bindingCopied'));
    });
  }
}
