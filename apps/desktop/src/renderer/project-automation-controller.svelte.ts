import type {
  ChatGptTabListResult,
  ChatGptTabSummary,
  DesktopStatus,
  PanelState,
  WorkspaceDetail,
} from '@chatsplice/protocol';

import type { ChatSpliceBridge } from '../preload/index.js';
import type { Translate } from './appearance.js';
import {
  projectAutomationIssueMessage,
  projectInstructionsUpdateIssueMessage,
} from './project-automation.js';
import {
  collectMislabelledTabRepairs,
  findConfirmedProjectTab,
  findProjectLauncherTab,
  projectTabLabel,
} from './project-tabs.js';
import type { WorkspaceController } from './workspace-controller.svelte.js';

export interface ProjectAutomationIssue {
  workspaceId: string;
  message: string;
}

/**
 * Injected dependencies. Tab/panel/dialog state stays with App.svelte and the
 * workspace list with WorkspaceController; this controller owns only project
 * setup/automation progress state and its flows.
 */
export interface ProjectAutomationControllerDeps {
  readonly bridge: ChatSpliceBridge;
  readonly workspace: WorkspaceController;
  readonly t: () => Translate;
  readonly runAction: (name: string, action: () => Promise<void>) => Promise<void>;
  readonly onNotice: (message: string) => void;
  readonly onError: (message: string) => void;
  readonly getTabs: () => ChatGptTabSummary[];
  readonly getActiveTab: () => ChatGptTabSummary | undefined;
  readonly applyTabResult: (result: ChatGptTabListResult) => void;
  readonly setPanelState: (next: PanelState) => void;
  readonly closeWorkspaceDetails: () => void;
  readonly setStatus: (next: DesktopStatus) => void;
}

export class ProjectAutomationController {
  setupWorkspaceId = $state('');
  projectChatRefreshWorkspaceId = $state('');
  projectAutomationIssue = $state<ProjectAutomationIssue | null>(null);
  projectLabelRepairStarted = $state(false);

  #instructionSyncInFlight = false;

  readonly #deps: ProjectAutomationControllerDeps;

  constructor(deps: ProjectAutomationControllerDeps) {
    this.#deps = deps;
  }

  /** Drops all automation progress tied to a removed workspace. */
  clearForWorkspace(workspaceId: string): void {
    if (this.setupWorkspaceId === workspaceId) this.setupWorkspaceId = '';
    if (this.projectChatRefreshWorkspaceId === workspaceId) {
      this.projectChatRefreshWorkspaceId = '';
    }
    if (this.projectAutomationIssue?.workspaceId === workspaceId) {
      this.projectAutomationIssue = null;
    }
  }

  async repairMislabelledProjectTabs(
    tabs: ChatGptTabSummary[],
    workspaces: WorkspaceDetail[],
  ): Promise<void> {
    if (this.projectLabelRepairStarted) return;
    this.projectLabelRepairStarted = true;
    try {
      for (const repair of collectMislabelledTabRepairs(tabs, workspaces)) {
        this.#deps.applyTabResult(await this.#deps.bridge.updateChatGptTab(repair));
      }
    } finally {
      this.projectLabelRepairStarted = false;
    }
  }

  async changeAutoAttach(workspaceId: string, enabled: boolean): Promise<void> {
    const deps = this.#deps;
    await deps.runAction(`auto-attach-${workspaceId}`, async () => {
      deps.setStatus(await deps.bridge.setAutoAttach({ workspace_id: workspaceId, enabled }));
    });
  }

  async beginProjectSetup(workspaceId: string): Promise<void> {
    this.setupWorkspaceId = workspaceId;
    this.#deps.workspace.selectedWorkspaceId = workspaceId;
    if (this.projectAutomationIssue?.workspaceId === workspaceId) {
      this.projectAutomationIssue = null;
    }
    await this.#deps.workspace.copyBinding(workspaceId);
  }

  async createChat(): Promise<void> {
    const deps = this.#deps;
    await deps.runAction('tab-create', async () => {
      deps.applyTabResult(
        await deps.bridge.createChatGptTab({
          workspace_id: null,
          label: deps.t()('generalChat'),
        }),
      );
      deps.onNotice(deps.t()('chatTabOpened'));
    });
  }

  async openProjectSetup(workspaceId: string): Promise<void> {
    const deps = this.#deps;
    const workspace = deps.workspace.workspaces.find(
      (candidate) => candidate.workspace_id === workspaceId,
    );
    if (workspace === undefined) return;
    const existingTab = findProjectLauncherTab(deps.getTabs(), workspaceId);
    if (existingTab === undefined) {
      await deps.runAction('project-launcher', async () => {
        deps.applyTabResult(
          await deps.bridge.createChatGptTab({
            workspace_id: workspaceId,
            label: projectTabLabel(workspace),
          }),
        );
      });
    } else {
      await this.activateChat(existingTab.chatgpt_tab_id);
    }
    await this.beginProjectSetup(workspaceId);
  }

  async openProject(workspaceId: string): Promise<void> {
    const deps = this.#deps;
    deps.workspace.selectedWorkspaceId = workspaceId;
    let restoredEditorFile = false;
    try {
      deps.applyTabResult(await deps.bridge.selectWorkspace(workspaceId));
      deps.setPanelState(await deps.bridge.getPanelState());
      if (findConfirmedProjectTab(deps.getTabs(), workspaceId) === undefined) {
        const editorState = await deps.bridge.getEditorState();
        restoredEditorFile =
          editorState.workspace_id === workspaceId && editorState.active_editor_tab_id !== null;
      }
    } catch {
      deps.onError(deps.t()('actionFailed'));
      return;
    }
    const confirmedTab = findConfirmedProjectTab(deps.getTabs(), workspaceId);
    if (confirmedTab === undefined && !restoredEditorFile) {
      await this.openProjectSetup(workspaceId);
      return;
    }
    deps.closeWorkspaceDetails();
    const workspaceName =
      deps.workspace.workspaces.find((workspace) => workspace.workspace_id === workspaceId)
        ?.display_name ?? deps.t()('selectedProject');
    deps.onNotice(deps.t()('projectOpened', { name: workspaceName }));
  }

  async completeProjectAutomation(workspaceId: string): Promise<void> {
    const deps = this.#deps;
    const result = await deps.bridge.automateChatGptProject({ workspace_id: workspaceId });
    deps.applyTabResult(result.tabs);
    deps.workspace.selectedWorkspaceId = workspaceId;
    if (result.automation.status === 'completed') {
      this.setupWorkspaceId = '';
      this.projectAutomationIssue = null;
      deps.onNotice(deps.t()('projectCreatedAndBound'));
      return;
    }
    this.setupWorkspaceId = workspaceId;
    this.projectAutomationIssue = {
      workspaceId,
      message: projectAutomationIssueMessage(deps.t(), result.automation.reason),
    };
    deps.onNotice(deps.t()('projectSetupNeedsManual'));
  }

  async retryProjectAutomation(workspaceId: string): Promise<void> {
    const deps = this.#deps;
    await deps.runAction(`project-automation-${workspaceId}`, async () => {
      await this.completeProjectAutomation(workspaceId);
    });
  }

  async synchronizeProjectInstructions(workspaceId: string): Promise<void> {
    if (
      this.#instructionSyncInFlight ||
      this.#deps.getActiveTab()?.workspace_id !== workspaceId ||
      !this.#deps.getActiveTab()?.project_instructions_confirmed
    )
      return;
    this.#instructionSyncInFlight = true;
    try {
      const result = await this.#deps.bridge.automateProjectInstructionsUpdate({
        workspace_id: workspaceId,
        automatic: true,
      });
      if (this.#deps.getActiveTab()?.workspace_id !== workspaceId) return;
      this.#deps.applyTabResult(result.tabs);
      if (result.automation.reason === 'instructions_updated') {
        this.projectChatRefreshWorkspaceId = workspaceId;
        this.projectAutomationIssue = null;
        this.#deps.onNotice(this.#deps.t()('projectInstructionsUpdated'));
      } else if (result.automation.reason === 'needs_manual_merge') {
        this.projectAutomationIssue = {
          workspaceId,
          message: projectInstructionsUpdateIssueMessage(this.#deps.t(), result.automation.reason),
        };
      }
    } catch {
      // Connection errors are surfaced by the normal status refresh; keep the retained tab intact.
    } finally {
      this.#instructionSyncInFlight = false;
    }
  }

  async updateProjectInstructions(workspaceId: string): Promise<void> {
    const deps = this.#deps;
    await deps.runAction(`project-instructions-update-${workspaceId}`, async () => {
      const result = await deps.bridge.automateProjectInstructionsUpdate({
        workspace_id: workspaceId,
      });
      deps.applyTabResult(result.tabs);
      deps.workspace.selectedWorkspaceId = workspaceId;
      if (result.automation.status === 'completed') {
        this.projectChatRefreshWorkspaceId = workspaceId;
        deps.onNotice(deps.t()('projectInstructionsUpdated'));
        return;
      }
      deps.onNotice(projectInstructionsUpdateIssueMessage(deps.t(), result.automation.reason));
      await this.openProjectSetup(workspaceId);
    });
  }

  async activateChat(chatGptTabId: string): Promise<void> {
    const deps = this.#deps;
    await deps.runAction('tab-activate', async () => {
      const tab = deps.getTabs().find((candidate) => candidate.chatgpt_tab_id === chatGptTabId);
      deps.applyTabResult(await deps.bridge.activateChatGptTab(chatGptTabId));
      if (tab?.workspace_id !== null && tab?.workspace_id !== undefined) {
        deps.workspace.selectedWorkspaceId = tab.workspace_id;
      }
    });
  }

  async confirmProjectInstructions(workspaceId: string): Promise<void> {
    const deps = this.#deps;
    const activeTab = deps.getActiveTab();
    if (activeTab?.workspace_id !== workspaceId) {
      deps.onError(deps.t()('projectTabRequired'));
      return;
    }
    await deps.runAction('project-confirm', async () => {
      deps.applyTabResult(
        await deps.bridge.updateChatGptTab({
          chatgpt_tab_id: activeTab!.chatgpt_tab_id,
          project_instructions_confirmed: true,
        }),
      );
      this.setupWorkspaceId = '';
      this.projectChatRefreshWorkspaceId = workspaceId;
      this.projectAutomationIssue = null;
      const workspaceName =
        deps.workspace.workspaces.find((workspace) => workspace.workspace_id === workspaceId)
          ?.display_name ?? deps.t()('selectedProject');
      deps.onNotice(deps.t()('projectMarkedConnected', { name: workspaceName }));
    });
  }
}
