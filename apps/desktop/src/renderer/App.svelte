<script lang="ts">
  import { onMount } from 'svelte';

  import type {
    ChatGptTabListResult,
    ChatGptTabSummary,
    DirectMcpActivity,
    DesktopStatus,
    PanelState,
    ProjectExecState,
    ProjectExecSummary,
    TunnelDoctorResult,
    WorkspaceDetail,
    WorkspaceReference,
  } from '@chatsplice/protocol';
  import { isUiLocale, systemUiLocale, UI_LOCALE_STORAGE_KEY, type UiLocale } from './i18n.js';
  import {
    APPEARANCE_STORAGE_KEY,
    applyAppearance,
    isAppearancePreference,
    translator,
    type AppearancePreference,
  } from './appearance.js';
  import {
    activityStateLabel as describeActivityState,
    executionStateLabel as describeExecutionState,
    formatActivityTime as formatActivityTimeForLocale,
    selectLatestExecutionJob,
    selectLatestMcpActivity,
    selectWorkspaceExecutionJobs,
    selectWorkspaceMcpActivities,
    workspaceMcpState as describeWorkspaceMcpState,
  } from './activity-view.js';
  import { findConfirmedProjectTab, selectWorkspaceTabs } from './project-tabs.js';
  import { WorkspaceController } from './workspace-controller.svelte.js';
  import { workspaceProjectState as describeWorkspaceProjectState } from './project-automation.js';
  import { ProjectAutomationController } from './project-automation-controller.svelte.js';
  import { TunnelController } from './tunnel-controller.svelte.js';
  import {
    resolveTunnelState,
    tunnelDoctorErrorLabel as describeTunnelDoctorError,
    tunnelErrorLabel as describeTunnelError,
  } from './tunnel-view.js';
  import {
    referenceWorkspaceName as describeReferenceWorkspace,
    selectReferenceCandidates,
    selectUserWorkspaces,
    selectWorkspaceReferences,
  } from './workspace-view.js';

  const PANEL_DIMENSION_MAX = 10_000;
  const FILES_PANEL_MIN_WIDTH = 220;
  const FILES_PANEL_MAX_WIDTH = 720;
  const CONSOLE_MIN_HEIGHT = 160;
  const CONSOLE_MAX_HEIGHT = 560;
  const SIDEBAR_MIN_WIDTH = 280;
  const SIDEBAR_MAX_WIDTH = 560;
  const surface = new URLSearchParams(window.location.search).get('surface');
  const supportsAutomaticTunnelInstall = navigator.platform.includes('Mac');
  const workbenchBridge = window.chatsplice;
  if (surface !== null) document.documentElement.dataset.surface = surface;

  let status: DesktopStatus | null = null;
  let chatGptTabs: ChatGptTabSummary[] = [];
  let view: 'projects' | 'settings' = 'projects';
  let errorMessage = '';
  let noticeMessage = '';
  let busyAction = '';
  let editingTabId = '';
  let editingTabLabel = '';
  let renamingWorkspaceId = '';
  let renamingWorkspaceLabel = '';
  let appearancePreference: AppearancePreference = 'system';
  let locale: UiLocale = 'en';
  let t = translator(locale);
  let mcpAppNameDraft = '';
  let sidebarWidth = 360;
  let sidebarCollapsed = false;
  let sidebarPreview = false;
  let sidebarPreviewTimer: number | undefined;
  let resizingSidebar = false;
  let sidebarResizeRequestId = 0;
  let panelResizeRequestId = 0;
  let resizingPanel: 'files_width' | 'console_height' | null = null;
  let toastTimer: number | undefined;
  let toastSignature = '';
  let modalOverlayActive = false;
  let helpOpen = false;
  let connectionModalOpen = false;
  let workspaceDetailsId = '';
  let tunnelHelpTopic: 'tunnel_id' | 'organization_id' | 'runtime_key' | null = null;
  let helpDialog: HTMLDialogElement | undefined;
  let workspaceDialog: HTMLDialogElement | undefined;
  let tunnelHelpDialog: HTMLDialogElement | undefined;
  let connectionDialog: HTMLDialogElement | undefined;
  let helpReturnFocus: HTMLElement | null = null;
  let workspaceReturnFocus: HTMLElement | null = null;
  let tunnelHelpReturnFocus: HTMLElement | null = null;
  let connectionReturnFocus: HTMLElement | null = null;
  let userWorkspaceList: WorkspaceDetail[] = [];
  let generalTabs: ChatGptTabSummary[] = [];
  let activeTab: ChatGptTabSummary | undefined;
  let workspaceDetails: WorkspaceDetail | undefined;
  let tunnelStateValue: { label: string; tone: string } = {
    label: 'Connection required',
    tone: 'muted',
  };
  let overallStateValue: { label: string; tone: string } = {
    label: 'Check connection',
    tone: 'warn',
  };
  let panelState: PanelState = {
    workspace_id: null,
    console_open: false,
    files_open: false,
    files_width: 340,
    console_height: 260,
  };
  let panelResizePending = 0;

  const workspaceController = new WorkspaceController({
    bridge: window.chatsplice,
    t: () => t,
    runAction,
    refresh,
    completeProjectAutomation,
    applyTabResult,
    clearProjectAutomationState,
    clearWorkspaceDetails,
    onNotice: (message) => {
      noticeMessage = message;
    },
  });
  let workspaces: WorkspaceDetail[] = [];
  let workspaceReferences: WorkspaceReference[] = [];
  let referenceSelectionByWorkspace: Record<string, string> = {};
  let selectedWorkspaceId = '';
  $: workspaces = workspaceController.workspaces;
  $: workspaceReferences = workspaceController.workspaceReferences;
  $: referenceSelectionByWorkspace = workspaceController.referenceSelectionByWorkspace;
  $: selectedWorkspaceId = workspaceController.selectedWorkspaceId;

  const automationController = new ProjectAutomationController({
    bridge: window.chatsplice,
    workspace: workspaceController,
    t: () => t,
    runAction,
    onNotice: (message) => {
      noticeMessage = message;
    },
    onError: (message) => {
      errorMessage = message;
    },
    getTabs: () => chatGptTabs,
    getActiveTab: () => activeTab,
    applyTabResult,
    setPanelState: (next) => {
      panelState = next;
    },
    closeWorkspaceDetails: () => {
      workspaceDetailsId = '';
    },
    setStatus: (next) => {
      status = next;
    },
  });
  let setupWorkspaceId = '';
  let projectChatRefreshWorkspaceId = '';
  let projectAutomationIssue: { workspaceId: string; message: string } | null = null;
  $: setupWorkspaceId = automationController.setupWorkspaceId;
  $: projectChatRefreshWorkspaceId = automationController.projectChatRefreshWorkspaceId;
  $: projectAutomationIssue = automationController.projectAutomationIssue;

  const tunnelController = new TunnelController({
    bridge: window.chatsplice,
    t: () => t,
    getLocale: () => locale,
    getStatus: () => status,
    setStatus: (next) => {
      status = next;
    },
    runAction,
    onNotice: (message) => {
      noticeMessage = message;
    },
    onError: (message) => {
      errorMessage = message;
    },
    supportsAutomaticTunnelInstall,
  });
  let tunnelDoctorResult: TunnelDoctorResult | null = null;
  $: tunnelDoctorResult = tunnelController.tunnelDoctorResult;

  $: userWorkspaceList = selectUserWorkspaces(workspaceController.workspaces);
  $: mcpAppName = status?.daemon.mcp_app_name ?? 'ChatSplice MCP';
  $: t = translator(locale, mcpAppName);
  $: generalTabs = chatGptTabs.filter((tab) => tab.workspace_id === null);
  $: activeTab = chatGptTabs.find((tab) => tab.active);
  $: workspaceDetails = workspaceController.workspaces.find(
    (workspace) => workspace.workspace_id === workspaceDetailsId,
  );
  $: tunnelStateValue = resolveTunnelState(status, locale);
  $: overallStateValue = !status?.daemon.healthy
    ? { label: t('localServiceDisconnected'), tone: 'bad' }
    : status.daemon.ready && status.daemon.tunnel.ready
      ? { label: t('mcpTunnelReady'), tone: 'ok' }
      : { label: t('mcpTunnelNeedsCheck'), tone: 'warn' };
  $: {
    // Full-window dialogs must expand the local view before the browser centers
    // them; otherwise workspace management is clipped to the sidebar width.
    const nextModalOverlayActive =
      helpOpen || tunnelHelpTopic !== null || workspaceDetailsId !== '' || connectionModalOpen;
    if (nextModalOverlayActive !== modalOverlayActive) {
      modalOverlayActive = nextModalOverlayActive;
      void window.chatsplice.setModalOverlay(modalOverlayActive);
    }
  }
  $: {
    const nextToastSignature = errorMessage
      ? `error:${errorMessage}`
      : noticeMessage
        ? `notice:${noticeMessage}`
        : '';
    if (nextToastSignature !== toastSignature) {
      toastSignature = nextToastSignature;
      if (toastTimer !== undefined) window.clearTimeout(toastTimer);
      toastTimer = undefined;
      if (nextToastSignature !== '') {
        const duration = errorMessage ? 5_500 : noticeMessage.includes(mcpAppName) ? 7_000 : 3_000;
        toastTimer = window.setTimeout(() => {
          toastTimer = undefined;
          toastSignature = '';
          errorMessage = '';
          noticeMessage = '';
        }, duration);
      }
    }
  }

  function setLocale(nextLocale: UiLocale): void {
    locale = nextLocale;
    window.localStorage.setItem(UI_LOCALE_STORAGE_KEY, nextLocale);
  }

  function setAppearance(preference: AppearancePreference): void {
    appearancePreference = preference;
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, preference);
    applyAppearance(preference, window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function workspaceTabs(workspaceId: string): ChatGptTabSummary[] {
    return selectWorkspaceTabs(chatGptTabs, workspaceId);
  }

  function workspaceMcpActivities(workspaceId: string): DirectMcpActivity[] {
    return selectWorkspaceMcpActivities(status?.daemon.latest_mcp_activities, workspaceId);
  }

  function workspaceExecutionJobs(workspaceId: string): ProjectExecSummary[] | undefined {
    return selectWorkspaceExecutionJobs(status?.daemon.execution_jobs, workspaceId);
  }

  function workspaceLatestExecutionJob(workspaceId: string): ProjectExecSummary | undefined {
    return selectLatestExecutionJob(status?.daemon.execution_jobs, workspaceId);
  }

  function executionStateLabel(state: ProjectExecState): string {
    return describeExecutionState(t, state);
  }

  function workspaceReferencesFor(workspaceId: string): WorkspaceReference[] {
    return selectWorkspaceReferences(workspaceController.workspaceReferences, workspaceId);
  }

  function referenceWorkspaceName(workspaceId: string): string {
    return describeReferenceWorkspace(t, workspaceController.workspaces, workspaceId);
  }

  function referenceCandidates(workspaceId: string): WorkspaceDetail[] {
    return selectReferenceCandidates(
      workspaceController.workspaceReferences,
      userWorkspaceList,
      workspaceId,
    );
  }

  function workspaceLatestMcpActivity(workspaceId: string): DirectMcpActivity | undefined {
    return selectLatestMcpActivity(status?.daemon.latest_mcp_activities, workspaceId);
  }

  function formatActivityTime(value: string): string {
    return formatActivityTimeForLocale(locale, value);
  }

  function activityStateLabel(activity: DirectMcpActivity): string {
    return describeActivityState(t, activity);
  }

  function workspaceMcpState(workspaceId: string): {
    label: string;
    shortLabel: string;
    tone: 'running' | 'succeeded' | 'failed';
  } | null {
    return describeWorkspaceMcpState(t, locale, status?.daemon.latest_mcp_activities, workspaceId);
  }

  function workspaceProjectState(workspaceId: string): {
    label: string;
    tone: 'ready' | 'pending' | 'failed';
  } {
    return describeWorkspaceProjectState(t, {
      workspaceId,
      automationIssueWorkspaceId: automationController.projectAutomationIssue?.workspaceId,
      chatRefreshWorkspaceId: automationController.projectChatRefreshWorkspaceId,
      hasConfirmedTab: confirmedProjectTab(workspaceId) !== undefined,
      setupWorkspaceId: automationController.setupWorkspaceId,
    });
  }

  async function repairMislabelledProjectTabs(
    tabs: ChatGptTabSummary[],
    nextWorkspaces: WorkspaceDetail[],
  ): Promise<void> {
    return automationController.repairMislabelledProjectTabs(tabs, nextWorkspaces);
  }

  function confirmedProjectTab(workspaceId: string): ChatGptTabSummary | undefined {
    return findConfirmedProjectTab(chatGptTabs, workspaceId);
  }

  function applyTabResult(result: ChatGptTabListResult): void {
    chatGptTabs = result.tabs;
  }

  function syncTunnelForm(nextStatus: DesktopStatus): void {
    tunnelController.syncTunnelForm(nextStatus);
  }

  async function changeAutoAttach(workspaceId: string, enabled: boolean): Promise<void> {
    return automationController.changeAutoAttach(workspaceId, enabled);
  }

  async function refresh(): Promise<void> {
    try {
      const [nextStatus, listed, listedReferences, listedTabs, nextPanelState] = await Promise.all([
        window.chatsplice.getStatus(),
        window.chatsplice.listWorkspaces(),
        window.chatsplice.listWorkspaceReferences(),
        window.chatsplice.listChatGptTabs(),
        workbenchBridge.getPanelState(),
      ]);
      status = nextStatus;
      workspaceController.workspaces = listed.workspaces;
      workspaceController.workspaceReferences = listedReferences.references;
      applyTabResult(listedTabs);
      panelState = nextPanelState;
      void repairMislabelledProjectTabs(listedTabs.tabs, listed.workspaces);
      syncTunnelForm(nextStatus);
      const activeProject = listedTabs.tabs.find(
        (tab) => tab.chatgpt_tab_id === listedTabs.active_tab_id,
      );
      if (
        !modalOverlayActive &&
        activeProject?.workspace_id &&
        activeProject.project_instructions_confirmed
      ) {
        void automationController.synchronizeProjectInstructions(activeProject.workspace_id);
      }

      const listedUserWorkspaces = listed.workspaces.filter(
        (workspace) => workspace.kind === 'user',
      );
      const panelWorkspaceId = nextPanelState.workspace_id;
      workspaceController.selectedWorkspaceId =
        (panelWorkspaceId !== null &&
        listedUserWorkspaces.some((workspace) => workspace.workspace_id === panelWorkspaceId)
          ? panelWorkspaceId
          : listedUserWorkspaces.some(
                (workspace) => workspace.workspace_id === workspaceController.selectedWorkspaceId,
              )
            ? workspaceController.selectedWorkspaceId
            : listedUserWorkspaces[0]?.workspace_id) ?? '';
      if (errorMessage === t('appStatusUnavailable')) {
        errorMessage = '';
      }
    } catch {
      errorMessage = t('appStatusUnavailable');
    }
  }

  async function refreshStatus(): Promise<void> {
    try {
      status = await window.chatsplice.getStatus();
    } catch {
      // The full refresh remains authoritative for connection errors.
    }
  }

  async function runAction(name: string, action: () => Promise<void>): Promise<void> {
    busyAction = name;
    errorMessage = '';
    noticeMessage = '';
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('credential_unreadable')) {
        errorMessage = t('runtimeKeyUnreadable');
      } else if (message.includes('invalid_runtime_key')) {
        errorMessage = t('invalidRuntimeKey');
      } else if (name.startsWith('local-apply-') && message !== '') {
        errorMessage = message;
      } else {
        errorMessage = t('actionFailed');
      }
    } finally {
      busyAction = '';
    }
  }

  async function saveMcpAppName(name: string): Promise<void> {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 40) {
      errorMessage = t('mcpAppNameInvalid');
      return;
    }
    await runAction('mcp-app-name', async () => {
      try {
        status = await window.chatsplice.setMcpAppName({ name: trimmed });
      } catch {
        errorMessage = t('mcpAppNameInvalid');
        return;
      }
      mcpAppNameDraft = trimmed;
      noticeMessage = t('mcpAppNameSaved');
    });
  }

  async function openWorkspace(): Promise<void> {
    return workspaceController.openWorkspace();
  }

  async function removeWorkspace(workspace: WorkspaceDetail): Promise<void> {
    return workspaceController.removeWorkspace(workspace);
  }

  async function addWorkspaceReference(
    sourceWorkspaceId: string,
    referenceWorkspaceId: string,
  ): Promise<void> {
    return workspaceController.addWorkspaceReference(sourceWorkspaceId, referenceWorkspaceId);
  }

  async function removeWorkspaceReference(reference: WorkspaceReference): Promise<void> {
    return workspaceController.removeWorkspaceReference(reference);
  }

  function setReferenceSelection(workspaceId: string, value: string): void {
    workspaceController.setReferenceSelection(workspaceId, value);
  }

  async function copyBinding(workspaceId: string): Promise<void> {
    return workspaceController.copyBinding(workspaceId);
  }

  function clearProjectAutomationState(workspaceId: string): void {
    automationController.clearForWorkspace(workspaceId);
  }

  function clearWorkspaceDetails(workspaceId: string): void {
    if (workspaceDetailsId === workspaceId) workspaceDetailsId = '';
  }

  async function beginProjectSetup(workspaceId: string): Promise<void> {
    return automationController.beginProjectSetup(workspaceId);
  }

  async function createChat(): Promise<void> {
    return automationController.createChat();
  }

  async function openProjectSetup(workspaceId: string): Promise<void> {
    return automationController.openProjectSetup(workspaceId);
  }

  async function openProject(workspaceId: string): Promise<void> {
    return automationController.openProject(workspaceId);
  }

  async function completeProjectAutomation(workspaceId: string): Promise<void> {
    return automationController.completeProjectAutomation(workspaceId);
  }

  async function retryProjectAutomation(workspaceId: string): Promise<void> {
    return automationController.retryProjectAutomation(workspaceId);
  }

  async function updateProjectInstructions(workspaceId: string): Promise<void> {
    return automationController.updateProjectInstructions(workspaceId);
  }

  async function activateChat(chatGptTabId: string): Promise<void> {
    return automationController.activateChat(chatGptTabId);
  }

  async function confirmProjectInstructions(workspaceId: string): Promise<void> {
    return automationController.confirmProjectInstructions(workspaceId);
  }

  function beginRename(tab: ChatGptTabSummary): void {
    editingTabId = tab.chatgpt_tab_id;
    editingTabLabel = tab.label;
  }

  function cancelRename(): void {
    editingTabId = '';
    editingTabLabel = '';
  }

  function commitRename(chatGptTabId: string): void {
    if (editingTabId !== chatGptTabId) return;
    const label = editingTabLabel.trim();
    cancelRename();
    if (label === '') return;
    void runAction('tab-rename', async () => {
      applyTabResult(
        await window.chatsplice.updateChatGptTab({ chatgpt_tab_id: chatGptTabId, label }),
      );
      noticeMessage = t('chatShortcutRenamed');
    });
  }

  function handleRenameKey(event: KeyboardEvent, chatGptTabId: string): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitRename(chatGptTabId);
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelRename();
    }
  }

  function beginWorkspaceRename(workspace: WorkspaceDetail): void {
    renamingWorkspaceId = workspace.workspace_id;
    renamingWorkspaceLabel = workspace.display_name;
  }

  function cancelWorkspaceRename(): void {
    renamingWorkspaceId = '';
    renamingWorkspaceLabel = '';
  }

  function commitWorkspaceRename(workspaceId: string): void {
    if (renamingWorkspaceId !== workspaceId) return;
    const displayName = renamingWorkspaceLabel.trim();
    cancelWorkspaceRename();
    void workspaceController.renameWorkspace(workspaceId, displayName);
  }

  async function changeWorkspaceRootPath(workspaceId: string): Promise<void> {
    return workspaceController.changeWorkspaceRootPath(workspaceId);
  }

  function handleWorkspaceRenameKey(event: KeyboardEvent, workspaceId: string): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitWorkspaceRename(workspaceId);
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelWorkspaceRename();
    }
  }

  async function closeChat(chatGptTabId: string): Promise<void> {
    await runAction('tab-close', async () => {
      applyTabResult(await window.chatsplice.closeChatGptTab(chatGptTabId));
      noticeMessage = t('localTabClosed');
    });
  }

  async function saveTunnelConfiguration(): Promise<void> {
    return tunnelController.saveTunnelConfiguration();
  }

  async function requestTunnelCredential(): Promise<void> {
    return tunnelController.requestTunnelCredential();
  }

  async function startTunnel(): Promise<void> {
    return tunnelController.startTunnel();
  }

  async function checkTunnel(): Promise<void> {
    return tunnelController.checkTunnel();
  }

  async function stopTunnel(): Promise<void> {
    return tunnelController.stopTunnel();
  }

  async function removeTunnelCredential(): Promise<void> {
    return tunnelController.removeTunnelCredential();
  }

  function tunnelErrorLabel(code: string | null): string {
    return describeTunnelError(t, code);
  }

  function tunnelDoctorErrorLabel(result: TunnelDoctorResult): string {
    return describeTunnelDoctorError(t, result);
  }

  function applySidebarLayout(layout: { width: number; collapsed: boolean }): void {
    sidebarWidth = layout.width;
    sidebarCollapsed = layout.collapsed;
    if (!layout.collapsed) sidebarPreview = false;
  }

  async function toggleSidebar(): Promise<void> {
    if (sidebarPreviewTimer !== undefined) window.clearTimeout(sidebarPreviewTimer);
    sidebarPreviewTimer = undefined;
    applySidebarLayout(await window.chatsplice.toggleSidebar());
    sidebarPreview = false;
  }

  function openSidebarPreview(): void {
    if (sidebarPreviewTimer !== undefined) window.clearTimeout(sidebarPreviewTimer);
    sidebarPreviewTimer = undefined;
    if (!sidebarCollapsed || sidebarPreview) return;
    sidebarPreview = true;
    void window.chatsplice.setSidebarPreview(true);
  }

  function scheduleSidebarPreviewClose(): void {
    if (!sidebarCollapsed || !sidebarPreview) return;
    if (sidebarPreviewTimer !== undefined) window.clearTimeout(sidebarPreviewTimer);
    sidebarPreviewTimer = window.setTimeout(() => {
      sidebarPreviewTimer = undefined;
      sidebarPreview = false;
      void window.chatsplice.setSidebarPreview(false);
    }, 160);
  }

  function closeToast(): void {
    if (toastTimer !== undefined) window.clearTimeout(toastTimer);
    toastTimer = undefined;
    toastSignature = '';
    errorMessage = '';
    noticeMessage = '';
  }

  function openWorkspaceDetails(workspaceId: string): void {
    workspaceReturnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    workspaceController.selectedWorkspaceId = workspaceId;
    workspaceDetailsId = workspaceId;
    void workbenchBridge.setPanelState({ workspace_id: workspaceId }).then((next) => {
      panelState = next;
    });
  }

  async function toggleWorkbenchPanel(panel: 'console_open' | 'files_open'): Promise<void> {
    try {
      panelState = await workbenchBridge.setPanelState({ [panel]: !panelState[panel] });
    } catch {
      errorMessage = t('actionFailed');
    }
  }

  async function openWorkbenchPanel(
    panel: 'console_open' | 'files_open',
    workspaceId: string,
  ): Promise<void> {
    workspaceController.selectedWorkspaceId = workspaceId;
    try {
      panelState = await workbenchBridge.setPanelState({
        workspace_id: workspaceId,
        [panel]: true,
      });
    } catch {
      errorMessage = t('actionFailed');
    }
  }

  function closeWorkspaceDetails(): void {
    if (workspaceDialog?.open) workspaceDialog.close();
    workspaceDetailsId = '';
    const returnTarget = workspaceReturnFocus;
    workspaceReturnFocus = null;
    queueMicrotask(() => {
      if (returnTarget?.isConnected) returnTarget.focus();
    });
  }

  function openHelp(): void {
    helpReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    helpOpen = true;
  }

  function closeHelp(): void {
    if (helpDialog?.open) helpDialog.close();
    helpOpen = false;
    const returnTarget = helpReturnFocus;
    helpReturnFocus = null;
    queueMicrotask(() => {
      if (returnTarget?.isConnected) returnTarget.focus();
    });
  }

  function openTunnelHelp(topic: 'tunnel_id' | 'organization_id' | 'runtime_key'): void {
    tunnelHelpReturnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    tunnelHelpTopic = topic;
  }

  function closeTunnelHelp(): void {
    if (tunnelHelpDialog?.open) tunnelHelpDialog.close();
    tunnelHelpTopic = null;
    const returnTarget = tunnelHelpReturnFocus;
    tunnelHelpReturnFocus = null;
    queueMicrotask(() => {
      if (returnTarget?.isConnected) returnTarget.focus();
    });
  }

  function closeTunnelHelpFromBackdrop(event: MouseEvent): void {
    if (isDialogBackdropClick(event)) closeTunnelHelp();
  }

  function cancelTunnelHelp(event: Event): void {
    event.preventDefault();
    closeTunnelHelp();
  }

  async function openTunnelSetupPage(): Promise<void> {
    if (tunnelHelpTopic === null) return;
    await window.chatsplice.openTunnelSetupHelp(tunnelHelpTopic);
  }

  function openConnectionManagement(): void {
    connectionReturnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    mcpAppNameDraft = mcpAppName;
    connectionModalOpen = true;
  }

  function closeConnectionManagement(): void {
    if (connectionDialog?.open) connectionDialog.close();
    connectionModalOpen = false;
    const returnTarget = connectionReturnFocus;
    connectionReturnFocus = null;
    queueMicrotask(() => {
      if (returnTarget?.isConnected) returnTarget.focus();
    });
  }

  function closeConnectionManagementFromBackdrop(event: MouseEvent): void {
    if (isDialogBackdropClick(event)) closeConnectionManagement();
  }

  function cancelConnectionManagement(event: Event): void {
    event.preventDefault();
    closeConnectionManagement();
  }

  function focusAndSelect(node: HTMLInputElement): void {
    node.focus();
    node.select();
  }

  function mountModal(node: HTMLDialogElement): { destroy: () => void } {
    node.showModal();
    queueMicrotask(() => {
      node.querySelector<HTMLElement>('[data-modal-initial-focus]')?.focus();
    });
    return {
      destroy: () => {
        if (node.open) node.close();
      },
    };
  }

  function isDialogBackdropClick(event: MouseEvent): boolean {
    if (event.target !== event.currentTarget || event.detail === 0) return false;
    const dialog = event.currentTarget as HTMLDialogElement;
    const bounds = dialog.getBoundingClientRect();
    return (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    );
  }

  function closeHelpFromBackdrop(event: MouseEvent): void {
    if (isDialogBackdropClick(event)) closeHelp();
  }

  function closeWorkspaceDetailsFromBackdrop(event: MouseEvent): void {
    if (isDialogBackdropClick(event)) closeWorkspaceDetails();
  }

  function cancelHelp(event: Event): void {
    event.preventDefault();
    closeHelp();
  }

  function cancelWorkspaceDetails(event: Event): void {
    event.preventDefault();
    closeWorkspaceDetails();
  }

  function trapModalFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const dialog = event.currentTarget as HTMLDialogElement;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;

    const activeElement = document.activeElement;
    if (event.shiftKey && (activeElement === first || !dialog.contains(activeElement))) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function openSettingsFromHelp(): void {
    if (helpDialog?.open) helpDialog.close();
    if (workspaceDialog?.open) workspaceDialog.close();
    helpOpen = false;
    workspaceDetailsId = '';
    helpReturnFocus = null;
    workspaceReturnFocus = null;
    view = 'settings';
    queueMicrotask(() => {
      document.querySelector<HTMLButtonElement>('.settings-header .icon-button')?.focus();
    });
  }

  function panelDimension(target: 'files_width' | 'console_height'): number {
    return panelState[target];
  }

  function updatePanelDimension(target: 'files_width' | 'console_height', value: number): void {
    const dimension = Math.max(0, Math.min(PANEL_DIMENSION_MAX, Math.round(value)));
    const patch =
      target === 'files_width' ? { files_width: dimension } : { console_height: dimension };
    const requestId = ++panelResizeRequestId;
    panelResizePending += 1;
    panelState = { ...panelState, ...patch };
    void workbenchBridge
      .setPanelState(patch)
      .then((next) => {
        if (requestId === panelResizeRequestId) panelState = next;
      })
      .catch(() => {
        if (requestId === panelResizeRequestId) errorMessage = t('consolePanelError');
      })
      .finally(() => {
        panelResizePending = Math.max(0, panelResizePending - 1);
      });
  }

  function startPanelResize(target: 'files_width' | 'console_height', event: PointerEvent): void {
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    const startCoordinate = target === 'files_width' ? event.screenX : event.screenY;
    const startSize = panelDimension(target);
    resizingPanel = target;
    handle.setPointerCapture(event.pointerId);
    let stopped = false;

    const move = (moveEvent: PointerEvent): void => {
      const coordinate = target === 'files_width' ? moveEvent.screenX : moveEvent.screenY;
      const delta = coordinate - startCoordinate;
      // Files and console handles sit on their leading edge: moving that edge
      // toward the origin makes the corresponding panel larger.
      updatePanelDimension(target, startSize - delta);
    };
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      resizingPanel = null;
      handle.removeEventListener('lostpointercapture', stop);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('lostpointercapture', stop);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }

  function resizePanelWithKeyboard(
    target: 'files_width' | 'console_height',
    event: KeyboardEvent,
  ): void {
    const delta =
      target === 'files_width'
        ? event.key === 'ArrowLeft'
          ? 16
          : event.key === 'ArrowRight'
            ? -16
            : 0
        : event.key === 'ArrowUp'
          ? 16
          : event.key === 'ArrowDown'
            ? -16
            : 0;
    if (delta === 0) return;
    event.preventDefault();
    updatePanelDimension(target, panelDimension(target) + delta);
  }

  function startSidebarResize(event: PointerEvent): void {
    if (sidebarCollapsed) return;
    event.preventDefault();
    resizingSidebar = true;
    const handle = event.currentTarget as HTMLElement;
    const startCoordinate = event.screenX;
    const startWidth = sidebarWidth;
    handle.setPointerCapture(event.pointerId);
    let stopped = false;
    const move = (moveEvent: PointerEvent): void => {
      requestSidebarWidth(startWidth + moveEvent.screenX - startCoordinate);
    };
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      resizingSidebar = false;
      handle.removeEventListener('lostpointercapture', stop);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('lostpointercapture', stop);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  function requestSidebarWidth(width: number): void {
    const requestId = ++sidebarResizeRequestId;
    const boundedWidth = Math.max(0, Math.min(PANEL_DIMENSION_MAX, Math.round(width)));
    void window.chatsplice
      .setSidebarWidth(boundedWidth)
      .then((layout) => {
        if (requestId === sidebarResizeRequestId) applySidebarLayout(layout);
      })
      .catch(() => {
        if (requestId === sidebarResizeRequestId) errorMessage = t('actionFailed');
      });
  }

  function resizeSidebarWithKeyboard(event: KeyboardEvent): void {
    if (sidebarCollapsed) return;
    const delta = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0;
    if (delta === 0) return;
    event.preventDefault();
    requestSidebarWidth(sidebarWidth + delta);
  }

  onMount(() => {
    const storedLocale = window.localStorage.getItem(UI_LOCALE_STORAGE_KEY);
    locale = isUiLocale(storedLocale) ? storedLocale : systemUiLocale(navigator.language);
    const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
    const storedAppearance = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    appearancePreference = isAppearancePreference(storedAppearance) ? storedAppearance : 'system';
    const syncSystemAppearance = (): void => {
      applyAppearance(appearancePreference, colorScheme.matches);
    };
    const syncStoredAppearance = (event: StorageEvent): void => {
      if (event.key !== APPEARANCE_STORAGE_KEY) return;
      appearancePreference = isAppearancePreference(event.newValue) ? event.newValue : 'system';
      syncSystemAppearance();
    };
    colorScheme.addEventListener('change', syncSystemAppearance);
    window.addEventListener('storage', syncStoredAppearance);
    syncSystemAppearance();

    if (
      surface === 'chrome' ||
      surface === 'edge' ||
      surface === 'console' ||
      surface === 'files' ||
      surface === 'editor'
    ) {
      let panelSurfaceActive = true;
      const syncPanelState = (): void => {
        const syncRequestId = panelResizeRequestId;
        void workbenchBridge
          .getPanelState()
          .then((next) => {
            if (
              panelSurfaceActive &&
              syncRequestId === panelResizeRequestId &&
              panelResizePending === 0 &&
              resizingPanel === null
            ) {
              panelState = next;
            }
          })
          .catch(() => {
            // A closed native panel can finish while the chrome surface is unloading.
          });
      };
      syncPanelState();
      const panelInterval = window.setInterval(syncPanelState, 700);
      if (surface === 'chrome' || surface === 'edge') {
        void window.chatsplice.getSidebarLayout().then(applySidebarLayout);
      }
      return () => {
        panelSurfaceActive = false;
        window.clearInterval(panelInterval);
        colorScheme.removeEventListener('change', syncSystemAppearance);
        window.removeEventListener('storage', syncStoredAppearance);
      };
    }

    void window.chatsplice.getSidebarLayout().then(applySidebarLayout);

    void refresh();
    const interval = window.setInterval(() => void refresh(), 2_000);
    const statusInterval = window.setInterval(() => void refreshStatus(), 400);
    return () => {
      colorScheme.removeEventListener('change', syncSystemAppearance);
      window.removeEventListener('storage', syncStoredAppearance);
      window.clearInterval(interval);
      window.clearInterval(statusInterval);
      if (sidebarPreviewTimer !== undefined) window.clearTimeout(sidebarPreviewTimer);
      if (toastTimer !== undefined) window.clearTimeout(toastTimer);
    };
  });
</script>

{#if surface === 'chrome'}
  <div
    class="chrome-control-surface"
    class:mac-chrome={navigator.platform.includes('Mac')}
    role="presentation"
  >
    <button
      class="icon-button chrome-sidebar-toggle"
      onclick={() => void toggleSidebar()}
      aria-label={sidebarCollapsed ? t('pinSidebar') : t('collapseSidebar')}
      title={sidebarCollapsed ? t('pinSidebar') : t('collapseSidebar')}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"
        ><path d="M4 5h16v14H4zM9 5v14M15 9l-3 3 3 3" /></svg
      >
    </button>
    <div class="chrome-panel-toggles" aria-label={t('panelControls')}>
      <button
        class:active={panelState.console_open}
        class="icon-button chrome-panel-toggle"
        onclick={() => void toggleWorkbenchPanel('console_open')}
        aria-pressed={panelState.console_open}
        aria-label={t('toggleConsolePanel')}
        title={t('toggleConsolePanel')}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 7 4 5-4 5M11 17h8" /></svg>
      </button>
      <button
        class:active={panelState.files_open}
        class="icon-button chrome-panel-toggle"
        onclick={() => void toggleWorkbenchPanel('files_open')}
        aria-pressed={panelState.files_open}
        aria-label={t('toggleFilesPanel')}
        title={t('toggleFilesPanel')}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"
          ><path d="M3.5 6.5h6l2 2h9v9a2 2 0 0 1-2 2h-15v-13Z" /></svg
        >
      </button>
    </div>
  </div>
{:else if surface === 'edge'}
  <div
    class="sidebar-edge-trigger"
    onpointerenter={openSidebarPreview}
    onpointerleave={scheduleSidebarPreviewClose}
    aria-hidden="true"
  ></div>
{:else if surface === 'console'}
  <div class="panel-surface-host" class:panel-resizing={resizingPanel === 'console_height'}>
    <!-- svelte-ignore a11y_no_interactive_element_to_noninteractive_role -->
    <button
      type="button"
      class="panel-resize-handle console-resize-handle"
      role="separator"
      tabindex="0"
      aria-orientation="horizontal"
      aria-valuemin={CONSOLE_MIN_HEIGHT}
      aria-valuemax={CONSOLE_MAX_HEIGHT}
      aria-valuenow={panelState.console_height}
      aria-label={t('resizeConsole')}
      title={t('resizeConsoleWithArrows')}
      onpointerdown={(event) => startPanelResize('console_height', event)}
      onkeydown={(event) => resizePanelWithKeyboard('console_height', event)}
    ></button>
    {#await import('./WorkbenchConsole.svelte') then component}
      <component.default {locale} />
    {:catch}
      <p role="alert">{t('appStatusUnavailable')}</p>
    {/await}
  </div>
{:else if surface === 'files'}
  <div class="panel-surface-host" class:panel-resizing={resizingPanel === 'files_width'}>
    <!-- svelte-ignore a11y_no_interactive_element_to_noninteractive_role -->
    <button
      type="button"
      class="panel-resize-handle files-resize-handle"
      role="separator"
      tabindex="0"
      aria-orientation="vertical"
      aria-valuemin={FILES_PANEL_MIN_WIDTH}
      aria-valuemax={FILES_PANEL_MAX_WIDTH}
      aria-valuenow={panelState.files_width}
      aria-label={t('resizeFiles')}
      title={t('resizeFilesWithArrows')}
      onpointerdown={(event) => startPanelResize('files_width', event)}
      onkeydown={(event) => resizePanelWithKeyboard('files_width', event)}
    ></button>
    {#await import('./WorkbenchFiles.svelte') then component}
      <component.default {locale} />
    {:catch}
      <p role="alert">{t('appStatusUnavailable')}</p>
    {/await}
  </div>
{:else if surface === 'editor'}
  <div class="panel-surface-host">
    {#await import('./WorkbenchEditor.svelte') then component}
      <component.default {locale} />
    {:catch}
      <p role="alert">{t('appStatusUnavailable')}</p>
    {/await}
  </div>
{:else}
  <main
    class:projects-view={view === 'projects'}
    class:sidebar-collapsed={sidebarCollapsed}
    class:sidebar-preview={sidebarPreview}
    class:mac-titlebar={navigator.platform.includes('Mac')}
    class:sidebar-resizing={resizingSidebar}
    class:modal-overlay-active={modalOverlayActive}
    class="shell"
    style={`--sidebar-width: ${sidebarWidth}px`}
    onpointerenter={openSidebarPreview}
    onpointerleave={scheduleSidebarPreviewClose}
    onfocusin={openSidebarPreview}
  >
    {#if view === 'projects'}
      <header class="app-header">
        <div class="app-identity">
          <span class="app-mark" aria-hidden="true">CS</span>
          <span>
            <strong>ChatSplice</strong>
            <small>{t('workspaceControl')}</small>
          </span>
        </div>
        <div class="header-actions">
          <button
            class="icon-button"
            onclick={openHelp}
            aria-label={t('openHelp')}
            title={t('help')}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"
              ><circle cx="12" cy="12" r="9" /><path
                d="M9.75 9a2.25 2.25 0 1 1 3.72 1.7c-.94.78-1.47 1.22-1.47 2.55M12 16.8h.01"
              /></svg
            >
          </button>
        </div>
      </header>

      <button class="new-chat-button" onclick={createChat} disabled={busyAction === 'tab-create'}>
        <svg viewBox="0 0 24 24" aria-hidden="true"
          ><path d="M4 19.5V6.75A2.75 2.75 0 0 1 6.75 4H13M14 4h6m-3-3v6M8 9h8M8 13h5" /></svg
        >
        <span>{t('newChat')}</span>
      </button>

      <div class="navigation-scroll">
        {#if generalTabs.length > 0}
          <details class="sidebar-section recent-chats">
            <summary>
              <span>{t('generalChats')}</span>
              <small>{generalTabs.length}</small>
            </summary>
            <div class="chat-list">
              {#each generalTabs as tab (tab.chatgpt_tab_id)}
                <div class:active={tab.active} class="chat-row">
                  <button class="chat-main" onclick={() => activateChat(tab.chatgpt_tab_id)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"
                      ><path
                        d="M20 15a3 3 0 0 1-3 3H9l-5 3v-6a3 3 0 0 1-1-2.24V7a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3v8Z"
                      /></svg
                    >
                    {#if editingTabId === tab.chatgpt_tab_id}
                      <input
                        class="rename-input"
                        bind:value={editingTabLabel}
                        onclick={(event) => event.stopPropagation()}
                        onblur={() => commitRename(tab.chatgpt_tab_id)}
                        onkeydown={(event) => handleRenameKey(event, tab.chatgpt_tab_id)}
                        aria-label={t('chatName')}
                      />
                    {:else}
                      <span>{tab.label}</span>
                    {/if}
                  </button>
                  <div class="row-actions">
                    <button
                      onclick={() => beginRename(tab)}
                      aria-label={t('renameChat')}
                      title={t('rename')}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true"
                        ><path d="m4 20 4.5-1 10-10-3.5-3.5-10 10L4 20Zm9.5-13 3.5 3.5" /></svg
                      >
                    </button>
                    <button
                      onclick={() => closeChat(tab.chatgpt_tab_id)}
                      aria-label={t('closeChatSpliceTab')}
                      title={t('closeTab')}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true"
                        ><path d="m7 7 10 10M17 7 7 17" /></svg
                      >
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          </details>
        {/if}

        <section class="sidebar-section projects-section" aria-labelledby="projects-title">
          <div class="section-label-row">
            <h2 id="projects-title">{t('projects')}</h2>
            <button
              onclick={openWorkspace}
              aria-label={t('addProjectFolder')}
              title={t('addProjectFolder')}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            </button>
          </div>

          {#if userWorkspaceList.length === 0}
            <div class="empty-state">
              <p>{t('noLocalProjects')}</p>
              <button onclick={openWorkspace}>{t('addFolder')}</button>
            </div>
          {:else}
            <div class="project-list">
              {#each userWorkspaceList as workspace (workspace.workspace_id)}
                {@const projectMcpState = workspaceMcpState(workspace.workspace_id)}
                {@const projectExecutionJob = workspaceLatestExecutionJob(workspace.workspace_id)}
                {@const projectState = workspaceProjectState(workspace.workspace_id)}
                <article
                  class:selected={workspace.workspace_id === selectedWorkspaceId}
                  class="project-group"
                >
                  <div class="project-row">
                    <button
                      class="project-main"
                      onclick={() => openProject(workspace.workspace_id)}
                      aria-label={t('openProject', { name: workspace.display_name })}
                    >
                      <svg class="folder-icon" viewBox="0 0 24 24" aria-hidden="true"
                        ><path
                          d="M3.5 7.5v9.25A2.25 2.25 0 0 0 5.75 19h12.5a2.25 2.25 0 0 0 2.25-2.25V8.5a2 2 0 0 0-2-2h-6l-2-2H5.75A2.25 2.25 0 0 0 3.5 6.75v.75Z"
                        /></svg
                      >
                      <span class="project-copy">
                        <strong>{workspace.display_name}</strong>
                        <small class={projectState.tone}>{projectState.label}</small>
                        {#if projectExecutionJob !== undefined}
                          <small class="project-execution-label {projectExecutionJob.state}">
                            {executionStateLabel(projectExecutionJob.state)}
                          </small>
                        {/if}
                      </span>
                      {#if projectMcpState !== null}
                        <i
                          class="project-task-dot {projectMcpState.tone}"
                          title={projectMcpState.label}
                        ></i>
                        <small class="project-task-label {projectMcpState.tone}">
                          {projectMcpState.shortLabel}
                        </small>
                        <span class="sr-only"> · {projectMcpState.label}</span>
                      {/if}
                    </button>
                    {#if projectExecutionJob !== undefined}
                      <button
                        type="button"
                        class="project-execution-button"
                        onclick={() =>
                          void openWorkbenchPanel('console_open', workspace.workspace_id)}
                        aria-label={t('openExecutions', { name: workspace.display_name })}
                        title={t('recentExecutions')}
                      >
                        <i class="project-task-dot {projectExecutionJob.state}" aria-hidden="true"
                        ></i>
                      </button>
                    {/if}
                    <button
                      class="project-details-button"
                      onclick={() => openWorkspaceDetails(workspace.workspace_id)}
                      aria-label={t('manageProject', { name: workspace.display_name })}
                      title={t('manage')}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true"
                        ><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle
                          cx="19"
                          cy="12"
                          r="1.5"
                        /></svg
                      >
                    </button>
                  </div>
                </article>
              {/each}
            </div>
          {/if}
        </section>
      </div>

      <footer class="runtime-footer">
        <div class="runtime-footer-content">
          {#if status?.daemon.tunnel.configuration === null}
            <button
              type="button"
              class="runtime-footer-status runtime-footer-nudge"
              onclick={openConnectionManagement}
            >
              <i class="runtime-status-dot {overallStateValue.tone}" aria-hidden="true"></i>
              <strong>{t('tunnelSetupNudge')}</strong>
            </button>
          {:else}
            <button
              type="button"
              class="runtime-footer-status runtime-footer-nudge"
              onclick={openConnectionManagement}
              aria-label={t('manageConnection')}
            >
              <i class="runtime-status-dot {overallStateValue.tone}" aria-hidden="true"></i>
              <strong>{overallStateValue.label}</strong>
            </button>
          {/if}
          <div class="runtime-footer-actions">
            {#if status?.daemon.read_only_mode}
              <span class="status-badge warn read-only-badge" title={t('readOnlyModeHelp')}>
                {t('readOnlyModeToggle')}
              </span>
            {/if}
            <button
              class="icon-button"
              onclick={() => (view = 'settings')}
              aria-label={t('openSettings')}
              title={t('settings')}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"
                ><circle cx="12" cy="12" r="3" /><path
                  d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.94 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3v-4h.08A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88L4.2 7l2.83-2.83.06.06A1.7 1.7 0 0 0 8.97 4.6 1.7 1.7 0 0 0 10 3.04V3h4v.08a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06L19.8 7l-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 20.96 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z"
                /></svg
              >
            </button>
          </div>
        </div>
      </footer>
      <!-- svelte-ignore a11y_no_interactive_element_to_noninteractive_role -->
      <button
        class="sidebar-resize-handle"
        onpointerdown={startSidebarResize}
        onkeydown={resizeSidebarWithKeyboard}
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={sidebarWidth}
        aria-label={t('resizeSidebar')}
        title={t('resizeSidebarWithArrows')}
      ></button>
    {:else}
      <header class="settings-header">
        <button
          class="icon-button"
          onclick={() => (view = 'projects')}
          aria-label={t('returnToProjects')}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <h1>{t('settings')}</h1>
      </header>

      <div class="settings-scroll">
        <section class="settings-group appearance-group" aria-labelledby="appearance-heading">
          <div class="settings-title">
            <div>
              <h2 id="appearance-heading">{t('appearance')}</h2>
            </div>
          </div>
          <label class="appearance-setting">
            <span>
              <strong>{t('language')}</strong>
            </span>
            <select
              aria-label={t('language')}
              value={locale}
              onchange={(event) =>
                setLocale((event.currentTarget as HTMLSelectElement).value as UiLocale)}
            >
              <option value="en">{t('english')}</option>
              <option value="ko">{t('korean')}</option>
            </select>
          </label>
          <label class="appearance-setting">
            <span>
              <strong>{t('theme')}</strong>
            </span>
            <select
              aria-label={t('localChatTheme')}
              value={appearancePreference}
              onchange={(event) =>
                setAppearance(
                  (event.currentTarget as HTMLSelectElement).value as AppearancePreference,
                )}
            >
              <option value="system">{t('system')}</option>
              <option value="light">{t('light')}</option>
              <option value="dark">{t('dark')}</option>
            </select>
          </label>
          <button class="text-button settings-connection-link" onclick={openConnectionManagement}>
            {t('manageConnection')}
          </button>
        </section>
      </div>
    {/if}

    {#if connectionModalOpen}
      <dialog
        bind:this={connectionDialog}
        use:mountModal
        class="connection-modal"
        aria-labelledby="connection-modal-title"
        aria-modal="true"
        oncancel={cancelConnectionManagement}
        onclick={closeConnectionManagementFromBackdrop}
        onkeydown={trapModalFocus}
      >
        <header class="modal-header">
          <div>
            <span class="modal-eyebrow">ChatSplice</span>
            <h2 id="connection-modal-title">{t('manageConnection')}</h2>
          </div>
          <button
            class="icon-button"
            data-modal-initial-focus
            onclick={closeConnectionManagement}
            aria-label={t('closeModal')}
            title={t('close')}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </header>

        <div class="modal-scroll connection-modal-scroll">
          <section class="modal-status-card">
            <div class="modal-status-copy">
              <span>{t('localConnection')}</span>
              <strong>{tunnelStateValue.label}</strong>
            </div>
            <i class={tunnelStateValue.tone} aria-hidden="true"></i>
          </section>

          <section class="modal-section connection-settings-section">
            <p>{t('localConnectionHelp')}</p>
            {#if status?.daemon.tunnel.mode === 'external' && status.daemon.tunnel.ready}
              <div class="inline-notice">{t('externalTunnelNotice')}</div>
            {/if}
            {#if status?.daemon.tunnel.error_code}
              <div class="inline-error">{tunnelErrorLabel(status.daemon.tunnel.error_code)}</div>
            {/if}
            {#if tunnelDoctorResult?.state === 'failed'}
              <div class="inline-error">{tunnelDoctorErrorLabel(tunnelDoctorResult)}</div>
            {/if}

            <details class="advanced-settings">
              <summary>{t('advancedTunnelSettings')}</summary>
              <label class="field">
                <span class="field-label-row">
                  {t('tunnelId')}
                  <button
                    type="button"
                    class="help-icon-button"
                    onclick={() => openTunnelHelp('tunnel_id')}
                    aria-label={t('tunnelFieldHelp', { field: t('tunnelId') })}
                  >
                    ?
                  </button>
                </span>
                <input
                  bind:value={tunnelController.tunnelId}
                  placeholder="tunnel_…"
                  autocomplete="off"
                  spellcheck="false"
                />
              </label>
              <label class="field">
                <span class="field-label-row">
                  {t('organizationId')}
                  <button
                    type="button"
                    class="help-icon-button"
                    onclick={() => openTunnelHelp('organization_id')}
                    aria-label={t('tunnelFieldHelp', { field: t('organizationId') })}
                  >
                    ?
                  </button>
                </span>
                <input
                  bind:value={tunnelController.organizationId}
                  placeholder="org-…"
                  autocomplete="off"
                  spellcheck="false"
                />
              </label>
              {#if !supportsAutomaticTunnelInstall}
                <label class="field">
                  <span>{t('tunnelClientPath')}</span>
                  <input
                    bind:value={tunnelController.manualExecutablePath}
                    placeholder="/path/to/tunnel-client"
                    autocomplete="off"
                    spellcheck="false"
                  />
                </label>
              {/if}
            </details>

            <label class="toggle-row">
              <span><strong>{t('startTunnelWithApp')}</strong></span>
              <input type="checkbox" bind:checked={tunnelController.automaticStart} />
            </label>
            <div class="settings-actions">
              <button
                class="secondary-button"
                onclick={checkTunnel}
                disabled={!status?.credential_store.configured ||
                  status.credential_store.error_code !== null ||
                  busyAction === 'tunnel-check'}>{t('runTunnelChecks')}</button
              >
              {#if status?.daemon.tunnel.mode === 'managed' && status.daemon.tunnel.ready}
                <button class="secondary-button" onclick={stopTunnel}>{t('stop')}</button>
              {:else if !status?.daemon.tunnel.ready}
                <button
                  class="secondary-button"
                  onclick={startTunnel}
                  disabled={!status?.credential_store.configured ||
                    status.credential_store.error_code !== null}>{t('start')}</button
                >
              {/if}
              <button
                class="primary-button"
                onclick={saveTunnelConfiguration}
                disabled={busyAction === 'tunnel-save'}>{t('saveChanges')}</button
              >
            </div>
          </section>

          <section class="modal-section" aria-labelledby="mcp-app-name-title">
            <div class="modal-section-heading">
              <div>
                <h3 id="mcp-app-name-title">{t('mcpAppNameTitle')}</h3>
                <p>{t('mcpAppNameHelp')}</p>
              </div>
            </div>
            <label class="field">
              <span class="field-label-row">{t('mcpAppNameLabel')}</span>
              <input
                type="text"
                maxlength="40"
                bind:value={mcpAppNameDraft}
                disabled={busyAction === 'mcp-app-name'}
              />
            </label>
            <div class="modal-actions">
              <button
                class="text-button"
                disabled={busyAction === 'mcp-app-name' ||
                  mcpAppNameDraft.trim() === '' ||
                  mcpAppNameDraft.trim() === mcpAppName}
                onclick={() => void saveMcpAppName(mcpAppNameDraft)}
              >
                {t('mcpAppNameSave')}
              </button>
              <button
                class="text-button"
                disabled={busyAction === 'mcp-app-name' || mcpAppName === 'ChatSplice MCP'}
                onclick={() => void saveMcpAppName('ChatSplice MCP')}
              >
                {t('mcpAppNameUseRecommended')}
              </button>
              <button
                class="text-button"
                disabled={busyAction === 'mcp-app-name' || mcpAppName === 'Local MCP'}
                onclick={() => void saveMcpAppName('Local MCP')}
              >
                {t('mcpAppNameUseLegacy')}
              </button>
            </div>
          </section>

          <section class="modal-section connection-key-section">
            <div class="modal-section-heading">
              <div>
                <span class="field-label-row">
                  <strong class="settings-subheading">{t('runtimeKey')}</strong>
                  <button
                    type="button"
                    class="help-icon-button"
                    onclick={() => openTunnelHelp('runtime_key')}
                    aria-label={t('tunnelFieldHelp', { field: t('runtimeKey') })}
                  >
                    ?
                  </button>
                </span>
                <p>
                  {status?.credential_store.error_code === 'credential_unreadable'
                    ? t('runtimeKeyUnreadable')
                    : status?.credential_store.configured
                      ? t('runtimeKeyProtected')
                      : t('runtimeKeyRequired')}
                </p>
              </div>
              <button
                class="secondary-button"
                onclick={requestTunnelCredential}
                disabled={!status?.credential_store.available || busyAction === 'credential'}
              >
                {status?.credential_store.configured ? t('replace') : t('register')}
              </button>
            </div>
            {#if status?.credential_store.configured}
              <button class="danger-button" onclick={removeTunnelCredential}
                >{t('removeSavedRuntimeKey')}</button
              >
            {/if}
          </section>
        </div>

        <footer class="modal-footer">
          <button class="primary-button" onclick={closeConnectionManagement}>{t('done')}</button>
        </footer>
      </dialog>
    {/if}

    {#if workspaceDetails !== undefined}
      {@const workspace = workspaceDetails}
      {@const projectState = workspaceProjectState(workspace.workspace_id)}
      {@const projectBindingConfirmed = confirmedProjectTab(workspace.workspace_id) !== undefined}
      {@const projectReferences = workspaceReferencesFor(workspace.workspace_id)}
      {@const availableReferenceTargets = referenceCandidates(workspace.workspace_id)}
      <dialog
        bind:this={workspaceDialog}
        use:mountModal
        class="workspace-modal"
        aria-labelledby="workspace-modal-title"
        aria-modal="true"
        oncancel={cancelWorkspaceDetails}
        onclick={closeWorkspaceDetailsFromBackdrop}
        onkeydown={trapModalFocus}
      >
        <header class="modal-header">
          <div>
            <span class="modal-eyebrow">{t('workspaceOverview')}</span>
            {#if renamingWorkspaceId === workspace.workspace_id}
              <input
                class="rename-input modal-title-input"
                use:focusAndSelect
                bind:value={renamingWorkspaceLabel}
                onblur={() => commitWorkspaceRename(workspace.workspace_id)}
                onkeydown={(event) => handleWorkspaceRenameKey(event, workspace.workspace_id)}
                aria-label={t('projectName')}
              />
            {:else}
              <h2 id="workspace-modal-title">
                <span class="modal-title-text">{workspace.display_name}</span>
                <button
                  class="icon-button modal-title-rename"
                  onclick={() => beginWorkspaceRename(workspace)}
                  aria-label={t('renameProject')}
                  title={t('renameProject')}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"
                    ><path d="m4 20 4.5-1 10-10-3.5-3.5-10 10L4 20Zm9.5-13 3.5 3.5" /></svg
                  >
                </button>
              </h2>
            {/if}
          </div>
          <button
            class="icon-button"
            data-modal-initial-focus
            onclick={closeWorkspaceDetails}
            aria-label={t('closeModal')}
            title={t('close')}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </header>

        <div class="modal-scroll">
          <section class="modal-status-card">
            <div class="modal-status-copy">
              <span>{t('chatgptProject')}</span>
              <strong>{projectState.label}</strong>
            </div>
            <i class={projectState.tone} aria-hidden="true"></i>
          </section>

          <section class="modal-section" aria-labelledby="local-folder-title">
            <div class="modal-section-heading">
              <div>
                <h3 id="local-folder-title">{t('localFolder')}</h3>
                <p title={workspace.root_path}>{workspace.root_path}</p>
              </div>
              <button
                class="secondary-button"
                onclick={() => changeWorkspaceRootPath(workspace.workspace_id)}
                disabled={busyAction === `workspace-root-path-${workspace.workspace_id}`}
              >
                {t('changeFolder')}
              </button>
            </div>
          </section>

          <section class="modal-section" aria-labelledby="project-connection-title">
            <div class="modal-section-heading">
              <div>
                <h3 id="project-connection-title">{t('projectConnection')}</h3>
                <p>{t('projectConnectionSummary')}</p>
              </div>
              {#if projectAutomationIssue?.workspaceId === workspace.workspace_id}
                <button
                  class="primary-button"
                  onclick={() => retryProjectAutomation(workspace.workspace_id)}
                  disabled={busyAction === `project-automation-${workspace.workspace_id}`}
                >
                  {t('retryAutomaticSetup')}
                </button>
              {:else if setupWorkspaceId === workspace.workspace_id}
                <button
                  class="secondary-button"
                  onclick={() => openProjectSetup(workspace.workspace_id)}
                >
                  {t('copyInstructionsAgain')}
                </button>
              {:else if projectBindingConfirmed}
                <div class="project-connection-actions">
                  <button
                    class="secondary-button"
                    onclick={() => updateProjectInstructions(workspace.workspace_id)}
                    disabled={busyAction ===
                      `project-instructions-update-${workspace.workspace_id}`}
                  >
                    {t('updateInstructions')}
                  </button>
                  <button
                    class="icon-button"
                    onclick={() => copyBinding(workspace.workspace_id)}
                    aria-label={t('copyInstructionsToClipboard')}
                    title={t('copyInstructionsToClipboard')}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true"
                      ><rect x="8" y="8" width="12" height="12" rx="2" /><path
                        d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"
                      /></svg
                    >
                  </button>
                </div>
              {:else}
                <button
                  class="secondary-button"
                  onclick={() => openProjectSetup(workspace.workspace_id)}
                >
                  {t('connectManually')}
                </button>
              {/if}
            </div>

            {#if projectAutomationIssue?.workspaceId === workspace.workspace_id}
              <div class="project-automation-fallback" role="status">
                <p>{projectAutomationIssue.message}</p>
                <small>{t('retryCreatesProject')}</small>
                <button
                  class="text-button"
                  onclick={() => openProjectSetup(workspace.workspace_id)}
                >
                  {t('connectExistingProject')}
                </button>
              </div>
            {:else if setupWorkspaceId === workspace.workspace_id}
              <section class="project-setup-compact" aria-label={t('projectConnectionGuide')}>
                <p>{t('projectInstructionsPrompt')}</p>
                <div class="setup-actions">
                  <button onclick={() => copyBinding(workspace.workspace_id)}>
                    {t('copyInstructionsAgain')}
                  </button>
                  <button
                    class="setup-primary"
                    onclick={() => confirmProjectInstructions(workspace.workspace_id)}
                    disabled={busyAction === 'project-confirm'}
                  >
                    {t('savedInstructions')}
                  </button>
                </div>
                <small>{t('saveCannotBeVerified')}</small>
              </section>
            {/if}

            {#if projectChatRefreshWorkspaceId === workspace.workspace_id}
              <div class="project-chat-refresh-note" role="status">
                <strong>{t('projectChatRefreshRequired')}</strong>
                <p>{t('projectChatRefreshBody')}</p>
              </div>
            {/if}
          </section>

          <section class="modal-section modal-message-guidance">
            <div>
              <h3>{t('chooseLocalMcpEachMessage')}</h3>
              <p>{t('localMcpSelectionGuide')}</p>
            </div>
            <button class="text-button" onclick={openHelp}>{t('openHelp')}</button>
          </section>

          <section class="modal-section" aria-labelledby="auto-attach-title">
            <div class="modal-section-heading">
              <div>
                <h3 id="auto-attach-title">{t('autoAttachTitle')}</h3>
                <p>{t('autoAttachHelp')}</p>
              </div>
            </div>
            <label class="toggle-row">
              <span><strong>{t('autoAttachToggle')}</strong></span>
              <input
                type="checkbox"
                checked={(status?.daemon.auto_attach_workspace_ids ?? []).includes(
                  workspace.workspace_id,
                )}
                disabled={busyAction === `auto-attach-${workspace.workspace_id}`}
                onchange={(event) =>
                  void changeAutoAttach(
                    workspace.workspace_id,
                    (event.currentTarget as HTMLInputElement).checked,
                  )}
              />
            </label>
          </section>

          {#if projectReferences.length > 0 || availableReferenceTargets.length > 0}
            <section class="modal-section" aria-labelledby="references-title">
              <div class="modal-section-heading">
                <div>
                  <h3 id="references-title">{t('referenceProjects')}</h3>
                  <p>{t('readAndSearchOnly')}</p>
                </div>
              </div>
              <div class="project-reference-content">
                {#each projectReferences as reference (`${reference.source_workspace_id}:${reference.reference_workspace_id}`)}
                  <div class="project-reference-item">
                    <div>
                      <strong>{referenceWorkspaceName(reference.reference_workspace_id)}</strong>
                      <small>{t('readAndSearchOnly')}</small>
                    </div>
                    <button
                      class="secondary-button project-reference-remove"
                      onclick={() => removeWorkspaceReference(reference)}
                      disabled={busyAction ===
                        `workspace-reference-remove-${workspace.workspace_id}`}
                      >{t('remove')}</button
                    >
                  </div>
                {/each}
                {#if availableReferenceTargets.length > 0}
                  <div class="project-reference-add">
                    <select
                      aria-label={t('chooseReadonlyReference')}
                      value={referenceSelectionByWorkspace[workspace.workspace_id] ?? ''}
                      onchange={(event) =>
                        setReferenceSelection(
                          workspace.workspace_id,
                          (event.currentTarget as HTMLSelectElement).value,
                        )}
                    >
                      <option value="">{t('connectAnotherProject')}</option>
                      {#each availableReferenceTargets as target (target.workspace_id)}
                        <option value={target.workspace_id}>{target.display_name}</option>
                      {/each}
                    </select>
                    <button
                      class="secondary-button"
                      onclick={() =>
                        addWorkspaceReference(
                          workspace.workspace_id,
                          referenceSelectionByWorkspace[workspace.workspace_id] ?? '',
                        )}
                      disabled={(referenceSelectionByWorkspace[workspace.workspace_id] ?? '') ===
                        '' || busyAction === `workspace-reference-add-${workspace.workspace_id}`}
                      >{t('connect')}</button
                    >
                  </div>
                {/if}
              </div>
            </section>
          {/if}

          <section class="modal-section modal-danger-section">
            <div>
              <h3>{t('removeFromChatSplice')}</h3>
              <p>{t('removeWorkspaceHelp')}</p>
            </div>
            <button class="danger-button" onclick={() => removeWorkspace(workspace)}>
              {t('remove')}
            </button>
          </section>
        </div>

        <footer class="modal-footer">
          <button class="secondary-button" onclick={closeWorkspaceDetails}>{t('done')}</button>
          <button class="primary-button" onclick={() => openProject(workspace.workspace_id)}>
            {t('openChatGptProject')}
          </button>
        </footer>
      </dialog>
    {/if}

    {#if helpOpen}
      <dialog
        bind:this={helpDialog}
        use:mountModal
        class="help-modal"
        aria-labelledby="help-modal-title"
        aria-modal="true"
        oncancel={cancelHelp}
        onclick={closeHelpFromBackdrop}
        onkeydown={trapModalFocus}
      >
        <header class="modal-header">
          <div>
            <span class="modal-eyebrow">ChatSplice</span>
            <h2 id="help-modal-title">{t('helpTitle')}</h2>
          </div>
          <button
            class="icon-button"
            data-modal-initial-focus
            onclick={closeHelp}
            aria-label={t('closeModal')}
            title={t('close')}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <div class="modal-scroll help-content">
          <p class="help-intro">{t('helpIntroduction')}</p>
          <ol class="help-steps">
            <li>
              <span>1</span>
              <div>
                <strong>{t('helpStepOneTitle')}</strong>
                <p>{t('helpStepOneBody')}</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>{t('helpStepTwoTitle')}</strong>
                <p>{t('helpStepTwoBody')}</p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>{t('helpStepThreeTitle')}</strong>
                <p>{t('helpStepThreeBody')}</p>
              </div>
            </li>
            <li>
              <span>4</span>
              <div>
                <strong>{t('helpStepFourTitle')}</strong>
                <p>{t('helpStepFourBody')}</p>
              </div>
            </li>
          </ol>
          <aside class="help-note">
            <strong>{t('helpStatusTitle')}</strong>
            <p>{t('helpStatusBody')}</p>
          </aside>
        </div>
        <footer class="modal-footer">
          <button class="secondary-button" onclick={openSettingsFromHelp}>
            {t('openSettings')}
          </button>
          <button class="primary-button" onclick={closeHelp}>{t('done')}</button>
        </footer>
      </dialog>
    {/if}

    {#if tunnelHelpTopic !== null}
      <dialog
        bind:this={tunnelHelpDialog}
        use:mountModal
        class="help-modal tunnel-help-modal"
        aria-labelledby="tunnel-help-modal-title"
        aria-modal="true"
        oncancel={cancelTunnelHelp}
        onclick={closeTunnelHelpFromBackdrop}
        onkeydown={trapModalFocus}
      >
        <header class="modal-header">
          <div>
            <span class="modal-eyebrow">OpenAI Platform</span>
            <h2 id="tunnel-help-modal-title">
              {tunnelHelpTopic === 'tunnel_id'
                ? t('tunnelHelpTunnelIdTitle')
                : tunnelHelpTopic === 'organization_id'
                  ? t('tunnelHelpOrganizationIdTitle')
                  : t('tunnelHelpRuntimeKeyTitle')}
            </h2>
          </div>
          <button
            class="icon-button"
            data-modal-initial-focus
            onclick={closeTunnelHelp}
            aria-label={t('closeModal')}
            title={t('close')}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <div class="modal-scroll">
          <section class="modal-section">
            <p>
              {tunnelHelpTopic === 'tunnel_id'
                ? t('tunnelHelpTunnelIdBody')
                : tunnelHelpTopic === 'organization_id'
                  ? t('tunnelHelpOrganizationIdBody')
                  : t('tunnelHelpRuntimeKeyBody')}
            </p>
          </section>
        </div>
        <footer class="modal-footer">
          <button class="secondary-button" onclick={closeTunnelHelp}>{t('done')}</button>
          <button class="primary-button" onclick={openTunnelSetupPage}>
            {t('openInOpenAiPlatform')}
          </button>
        </footer>
      </dialog>
    {/if}

    {#if errorMessage || noticeMessage}
      <div
        class:error={errorMessage !== ''}
        class="toast"
        role={errorMessage !== '' ? 'alert' : 'status'}
        aria-atomic="true"
      >
        <span>{errorMessage || noticeMessage}</span>
        <button onclick={closeToast} aria-label={t('closeMessage')}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </div>
    {/if}
  </main>
{/if}
