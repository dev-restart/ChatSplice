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
  requiresVerification?: boolean;
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
  #navigationRequest = 0;
  #navigationInFlight = false;

  readonly #deps: ProjectAutomationControllerDeps;

  constructor(deps: ProjectAutomationControllerDeps) {
    this.#deps = deps;
  }

  /** A null revision means a navigation request has not settled yet. */
  get navigationRevision(): number | null {
    return this.#navigationInFlight ? null : this.#navigationRequest;
  }

  async #navigate(action: (request: number) => Promise<void>): Promise<void> {
    const request = ++this.#navigationRequest;
    this.#navigationInFlight = true;
    try {
      await action(request);
    } finally {
      if (request === this.#navigationRequest) this.#navigationInFlight = false;
    }
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

  /**
   * An automation failure describes an earlier attempt. Once the main process
   * reports a confirmed project tab for that workspace the failure is stale and
   * must not keep the retry banner or the failed badge alive.
   */
  dropResolvedIssue(tabs: ChatGptTabSummary[]): void {
    const issue = this.projectAutomationIssue;
    if (
      issue !== null &&
      !issue.requiresVerification &&
      findConfirmedProjectTab(tabs, issue.workspaceId) !== undefined
    ) {
      this.projectAutomationIssue = null;
    }
  }

  async repairMislabelledProjectTabs(
    tabs: ChatGptTabSummary[],
    workspaces: WorkspaceDetail[],
  ): Promise<void> {
    const navigationRevision = this.navigationRevision;
    if (navigationRevision === null || this.projectLabelRepairStarted) return;
    this.projectLabelRepairStarted = true;
    try {
      for (const repair of collectMislabelledTabRepairs(tabs, workspaces)) {
        const result = await this.#deps.bridge.updateChatGptTab(repair);
        if (navigationRevision !== this.navigationRevision) return;
        this.#deps.applyTabResult(result);
      }
    } finally {
      this.projectLabelRepairStarted = false;
    }
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
    await this.#navigate(async (request) => {
      await deps.runAction('tab-create', async () => {
        const result = await deps.bridge.createChatGptTab({
          workspace_id: null,
          label: deps.t()('generalChat'),
        });
        if (request !== this.#navigationRequest) return;
        deps.applyTabResult(result);
        deps.workspace.selectedWorkspaceId = '';
        deps.onNotice(deps.t()('chatTabOpened'));
      });
    });
  }

  async createProjectChat(workspaceId: string): Promise<void> {
    const deps = this.#deps;
    const workspace = deps.workspace.workspaces.find(
      (candidate) => candidate.workspace_id === workspaceId,
    );
    if (workspace === undefined) return;
    await this.#navigate(async (request) => {
      await deps.runAction(`project-chat-create-${workspaceId}`, async () => {
        try {
          const openChat = (): Promise<ChatGptTabListResult> =>
            deps.bridge.createChatGptTab({
              workspace_id: workspaceId,
              label: projectTabLabel(workspace),
              project_chat: true,
            });
          let result: ChatGptTabListResult;
          try {
            result = await openChat();
          } catch (cause) {
            // A project connected before its home address was stored can still
            // be located: the main process derives the home from the tab's own
            // Project address and keeps it only if the instructions identity
            // check passes. Anything else keeps the original error.
            const unavailable =
              cause instanceof Error && cause.message.includes('project_chat_url_unavailable');
            if (!unavailable || request !== this.#navigationRequest) throw cause;
            const verified = await deps.bridge.automateProjectInstructionsUpdate({
              workspace_id: workspaceId,
            });
            if (request !== this.#navigationRequest) return;
            deps.applyTabResult(verified.tabs);
            if (verified.automation.status !== 'completed') throw cause;
            result = await openChat();
          }
          if (request !== this.#navigationRequest) return;
          deps.applyTabResult(result);
          deps.workspace.selectedWorkspaceId = workspaceId;
          const panel = await deps.bridge.getPanelState();
          if (request !== this.#navigationRequest) return;
          deps.setPanelState(panel);
          deps.closeWorkspaceDetails();
          this.projectChatRefreshWorkspaceId = '';
          deps.onNotice(deps.t()('projectNewChatOpened', { name: workspace.display_name }));
        } catch (cause) {
          if (request !== this.#navigationRequest) return;
          const message = cause instanceof Error ? cause.message : '';
          deps.onError(
            deps.t()(
              message.includes('project_chat_url_ambiguous')
                ? 'projectNewChatAmbiguous'
                : message.includes('project_chat_url_unavailable')
                  ? 'projectNewChatUnavailable'
                  : 'actionFailed',
            ),
          );
        }
      });
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
    await this.#navigate(async (request) => {
      try {
        const result = await deps.bridge.selectWorkspace(workspaceId);
        if (request !== this.#navigationRequest) return;
        deps.applyTabResult(result);
        deps.workspace.selectedWorkspaceId = workspaceId;
        const panel = await deps.bridge.getPanelState();
        if (request !== this.#navigationRequest) return;
        deps.setPanelState(panel);
      } catch (cause) {
        if (request !== this.#navigationRequest) return;
        const message = cause instanceof Error ? cause.message : '';
        deps.onError(
          deps.t()(
            message.includes('project_chat_url_ambiguous')
              ? 'projectNewChatAmbiguous'
              : message.includes('project_chat_url_unavailable')
                ? 'projectNewChatUnavailable'
                : 'actionFailed',
          ),
        );
        return;
      }
      if (request !== this.#navigationRequest) return;
      const confirmedTab = findConfirmedProjectTab(deps.getTabs(), workspaceId);
      if (confirmedTab === undefined) {
        deps.closeWorkspaceDetails();
        await this.retryProjectAutomation(workspaceId);
        return;
      }
      deps.closeWorkspaceDetails();
      const workspaceName =
        deps.workspace.workspaces.find((workspace) => workspace.workspace_id === workspaceId)
          ?.display_name ?? deps.t()('selectedProject');
      deps.onNotice(deps.t()('projectOpened', { name: workspaceName }));
    });
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
    if (
      this.projectAutomationIssue?.workspaceId === workspaceId &&
      this.projectAutomationIssue.requiresVerification
    ) {
      await this.updateProjectInstructions(workspaceId);
      return;
    }
    const deps = this.#deps;
    await deps.runAction(`project-automation-${workspaceId}`, async () => {
      await this.completeProjectAutomation(workspaceId);
    });
  }

  async synchronizeProjectInstructions(workspaceId: string): Promise<void> {
    const navigationRevision = this.navigationRevision;
    if (
      navigationRevision === null ||
      this.#instructionSyncInFlight ||
      this.#deps.getActiveTab()?.workspace_id !== workspaceId
    )
      return;
    this.#instructionSyncInFlight = true;
    try {
      const result = await this.#deps.bridge.automateProjectInstructionsUpdate({
        workspace_id: workspaceId,
        automatic: true,
      });
      if (
        navigationRevision !== this.navigationRevision ||
        this.#deps.getActiveTab()?.workspace_id !== workspaceId
      )
        return;
      this.#deps.applyTabResult(result.tabs);
      if (result.automation.reason === 'instructions_updated') {
        this.projectChatRefreshWorkspaceId = workspaceId;
        this.projectAutomationIssue = null;
        this.#deps.onNotice(this.#deps.t()('projectInstructionsUpdated'));
      } else if (result.automation.status === 'completed') {
        if (this.projectAutomationIssue?.workspaceId === workspaceId) {
          this.projectAutomationIssue = null;
        }
      } else if (result.automation.reason !== 'automation_deferred') {
        this.projectAutomationIssue = {
          workspaceId,
          message: projectInstructionsUpdateIssueMessage(this.#deps.t(), result.automation.reason),
          requiresVerification: true,
        };
      }
    } catch {
      if (
        navigationRevision === this.navigationRevision &&
        this.#deps.getActiveTab()?.workspace_id === workspaceId
      ) {
        this.projectAutomationIssue = {
          workspaceId,
          message: this.#deps.t()('projectAutomationUiChanged'),
          requiresVerification: true,
        };
      }
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
        this.projectAutomationIssue = null;
        if (this.setupWorkspaceId === workspaceId) this.setupWorkspaceId = '';
        this.projectChatRefreshWorkspaceId = workspaceId;
        deps.onNotice(deps.t()('projectInstructionsUpdated'));
        return;
      }
      if (result.automation.reason !== 'automation_deferred') {
        this.projectAutomationIssue = {
          workspaceId,
          message: projectInstructionsUpdateIssueMessage(deps.t(), result.automation.reason),
          requiresVerification: true,
        };
      }
      deps.onNotice(projectInstructionsUpdateIssueMessage(deps.t(), result.automation.reason));
    });
  }

  async activateChat(chatGptTabId: string): Promise<void> {
    const deps = this.#deps;
    await this.#navigate(async (request) => {
      await deps.runAction('tab-activate', async () => {
        const tab = deps.getTabs().find((candidate) => candidate.chatgpt_tab_id === chatGptTabId);
        const result = await deps.bridge.activateChatGptTab(chatGptTabId);
        if (request !== this.#navigationRequest) return;
        deps.applyTabResult(result);
        deps.workspace.selectedWorkspaceId = tab?.workspace_id ?? '';
      });
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
      const result = await deps.bridge.automateChatGptProject({ workspace_id: workspaceId });
      deps.applyTabResult(result.tabs);
      if (result.automation.status !== 'completed') {
        this.projectAutomationIssue = {
          workspaceId,
          message: projectAutomationIssueMessage(deps.t(), result.automation.reason),
          requiresVerification: true,
        };
        deps.onNotice(deps.t()('projectSetupNeedsManual'));
        return;
      }
      this.setupWorkspaceId = '';
      this.projectChatRefreshWorkspaceId = workspaceId;
      this.projectAutomationIssue = null;
      const workspaceName =
        deps.workspace.workspaces.find((workspace) => workspace.workspace_id === workspaceId)
          ?.display_name ?? deps.t()('selectedProject');
      deps.onNotice(deps.t()('projectSavedInstructionsVerified', { name: workspaceName }));
    });
  }
}
