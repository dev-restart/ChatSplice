import { contextBridge, ipcRenderer } from 'electron';

import { IPC_CHANNELS } from '@chatsplice/protocol';
import type {
  AutoAttachInput,
  McpAppNameInput,
  AutomateChatGptProjectResult,
  ChatGptTabListResult,
  CreateChatGptTabInput,
  DesktopStatus,
  FsListResult,
  FsReadResult,
  RemoveWorkspaceResult,
  RenameWorkspaceInput,
  TunnelClientInstallResult,
  TunnelConfiguration,
  TunnelDoctorResult,
  TunnelSetupHelpTopic,
  WorkspaceDetail,
  WorkspaceDetailListResult,
  WorkspaceSummary,
  UpdateChatGptTabInput,
  UiLocale,
  SidebarLayout,
  WorkspaceReference,
  WorkspaceReferenceListResult,
  WorkspaceReferenceMutationInput,
  ProjectExecJob,
  ProjectExecSubmitInput,
  ProjectExecSummary,
  ProjectExecTarget,
  PanelState,
  PanelStatePatch,
  ActivateEditorTabInput,
  CreateTerminalSessionInput,
  EditorDocument,
  EditorDocumentTarget,
  EditorState,
  OpenEditorFileInput,
  ReadTerminalSessionInput,
  ResizeTerminalSessionInput,
  UpdateEditorDocumentInput,
  TerminalSessionSnapshot,
  TerminalSessionSummaryList,
  TerminalSessionTarget,
  WriteTerminalSessionInput,
  WorkspaceFileListInput,
  WorkspaceFileReadInput,
} from '@chatsplice/protocol';

export interface ChatSpliceBridge {
  getStatus(): Promise<DesktopStatus>;
  getExecutionJob(target: ProjectExecTarget): Promise<ProjectExecJob>;
  cancelExecutionJob(target: ProjectExecTarget): Promise<ProjectExecJob>;
  submitProjectExec(input: ProjectExecSubmitInput): Promise<ProjectExecSummary>;
  listWorkspaces(): Promise<WorkspaceDetailListResult>;
  listWorkspaceFiles(input: WorkspaceFileListInput): Promise<FsListResult>;
  readWorkspaceFile(input: WorkspaceFileReadInput): Promise<FsReadResult>;
  openWorkspaceTerminal(workspaceId: string): Promise<{ opened: true }>;
  openWorkspaceFinder(workspaceId: string): Promise<{ opened: true }>;
  listWorkspaceReferences(): Promise<WorkspaceReferenceListResult>;
  addWorkspaceReference(input: WorkspaceReferenceMutationInput): Promise<WorkspaceReference>;
  removeWorkspaceReference(
    input: WorkspaceReferenceMutationInput,
  ): Promise<WorkspaceReferenceListResult>;
  openWorkspace(): Promise<WorkspaceSummary | null>;
  renameWorkspace(input: RenameWorkspaceInput): Promise<WorkspaceSummary>;
  updateWorkspaceRootPath(workspaceId: string): Promise<WorkspaceDetail | null>;
  removeWorkspace(input: { workspace_id: string }): Promise<RemoveWorkspaceResult>;
  copyProjectBinding(workspaceId: string): Promise<{ copied: true }>;
  automateChatGptProject(input: { workspace_id: string }): Promise<AutomateChatGptProjectResult>;
  automateProjectInstructionsUpdate(input: {
    workspace_id: string;
    automatic?: boolean;
  }): Promise<AutomateChatGptProjectResult>;
  listChatGptTabs(): Promise<ChatGptTabListResult>;
  createChatGptTab(input: CreateChatGptTabInput): Promise<ChatGptTabListResult>;
  activateChatGptTab(chatGptTabId: string): Promise<ChatGptTabListResult>;
  updateChatGptTab(input: UpdateChatGptTabInput): Promise<ChatGptTabListResult>;
  closeChatGptTab(chatGptTabId: string): Promise<ChatGptTabListResult>;
  configureTunnel(input: TunnelConfiguration): Promise<DesktopStatus>;
  setAutoAttach(input: AutoAttachInput): Promise<DesktopStatus>;
  setMcpAppName(input: McpAppNameInput): Promise<DesktopStatus>;
  listTerminalSessions(workspaceId: string): Promise<TerminalSessionSummaryList>;
  createTerminalSession(input: CreateTerminalSessionInput): Promise<TerminalSessionSnapshot>;
  readTerminalSession(input: ReadTerminalSessionInput): Promise<TerminalSessionSnapshot>;
  writeTerminalSession(input: WriteTerminalSessionInput): Promise<void>;
  resizeTerminalSession(input: ResizeTerminalSessionInput): Promise<void>;
  closeTerminalSession(input: TerminalSessionTarget): Promise<void>;
  requestTunnelCredential(locale: UiLocale): Promise<{
    saved: boolean;
    error_code: 'invalid_runtime_key' | null;
    status: DesktopStatus;
  }>;
  checkTunnel(): Promise<TunnelDoctorResult>;
  startTunnel(): Promise<DesktopStatus>;
  stopTunnel(): Promise<DesktopStatus>;
  installTunnelClient(): Promise<TunnelClientInstallResult>;
  openTunnelSetupHelp(topic: TunnelSetupHelpTopic): Promise<void>;
  removeTunnelCredential(): Promise<DesktopStatus>;
  getSidebarLayout(): Promise<SidebarLayout>;
  setSidebarWidth(width: number): Promise<SidebarLayout>;
  toggleSidebar(): Promise<SidebarLayout>;
  setSidebarPreview(open: boolean): Promise<SidebarLayout>;
  setModalOverlay(open: boolean): Promise<void>;
  getPanelState(): Promise<PanelState>;
  setPanelState(patch: PanelStatePatch): Promise<PanelState>;
  getEditorState(): Promise<EditorState>;
  getEditorDocument(input: EditorDocumentTarget): Promise<EditorDocument>;
  openEditorFile(input: OpenEditorFileInput): Promise<EditorState>;
  activateEditorTab(input: ActivateEditorTabInput): Promise<EditorState>;
  updateEditorDocument(input: UpdateEditorDocumentInput): Promise<EditorDocument>;
  saveEditorDocument(input: EditorDocumentTarget): Promise<EditorDocument>;
  reloadEditorDocument(input: EditorDocumentTarget): Promise<EditorDocument>;
  closeEditorTab(input: EditorDocumentTarget): Promise<EditorState>;
  selectWorkspace(workspaceId: string): Promise<ChatGptTabListResult>;
}

const bridge: ChatSpliceBridge = Object.freeze({
  getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getStatus) as Promise<DesktopStatus>,
  getExecutionJob: (target: ProjectExecTarget) =>
    ipcRenderer.invoke(IPC_CHANNELS.getExecutionJob, target) as Promise<ProjectExecJob>,
  cancelExecutionJob: (target: ProjectExecTarget) =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelExecutionJob, target) as Promise<ProjectExecJob>,
  submitProjectExec: (input: ProjectExecSubmitInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.submitProjectExec, input) as Promise<ProjectExecSummary>,
  listWorkspaces: () =>
    ipcRenderer.invoke(IPC_CHANNELS.listWorkspaces) as Promise<WorkspaceDetailListResult>,
  listWorkspaceFiles: (input: WorkspaceFileListInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.listWorkspaceFiles, input) as Promise<FsListResult>,
  readWorkspaceFile: (input: WorkspaceFileReadInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.readWorkspaceFile, input) as Promise<FsReadResult>,
  openWorkspaceTerminal: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.openWorkspaceTerminal, workspaceId) as Promise<{
      opened: true;
    }>,
  openWorkspaceFinder: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.openWorkspaceFinder, workspaceId) as Promise<{ opened: true }>,
  listWorkspaceReferences: () =>
    ipcRenderer.invoke(
      IPC_CHANNELS.listWorkspaceReferences,
    ) as Promise<WorkspaceReferenceListResult>,
  addWorkspaceReference: (input: WorkspaceReferenceMutationInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.addWorkspaceReference, input) as Promise<WorkspaceReference>,
  removeWorkspaceReference: (input: WorkspaceReferenceMutationInput) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.removeWorkspaceReference,
      input,
    ) as Promise<WorkspaceReferenceListResult>,
  openWorkspace: () =>
    ipcRenderer.invoke(IPC_CHANNELS.openWorkspace) as Promise<WorkspaceSummary | null>,
  renameWorkspace: (input: RenameWorkspaceInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.renameWorkspace, input) as Promise<WorkspaceSummary>,
  updateWorkspaceRootPath: (workspaceId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.updateWorkspaceRootPath,
      workspaceId,
    ) as Promise<WorkspaceDetail | null>,
  removeWorkspace: (input: { workspace_id: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.removeWorkspace, input) as Promise<RemoveWorkspaceResult>,
  copyProjectBinding: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.copyProjectBinding, workspaceId) as Promise<{ copied: true }>,
  automateChatGptProject: (input: { workspace_id: string }) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.automateChatGptProject,
      input,
    ) as Promise<AutomateChatGptProjectResult>,
  automateProjectInstructionsUpdate: (input: { workspace_id: string; automatic?: boolean }) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.automateProjectInstructionsUpdate,
      input,
    ) as Promise<AutomateChatGptProjectResult>,
  listChatGptTabs: () =>
    ipcRenderer.invoke(IPC_CHANNELS.listChatGptTabs) as Promise<ChatGptTabListResult>,
  createChatGptTab: (input: CreateChatGptTabInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.createChatGptTab, input) as Promise<ChatGptTabListResult>,
  activateChatGptTab: (chatGptTabId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.activateChatGptTab,
      chatGptTabId,
    ) as Promise<ChatGptTabListResult>,
  updateChatGptTab: (input: UpdateChatGptTabInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateChatGptTab, input) as Promise<ChatGptTabListResult>,
  closeChatGptTab: (chatGptTabId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.closeChatGptTab, chatGptTabId) as Promise<ChatGptTabListResult>,
  configureTunnel: (input: TunnelConfiguration) =>
    ipcRenderer.invoke(IPC_CHANNELS.configureTunnel, input) as Promise<DesktopStatus>,
  requestTunnelCredential: (locale: UiLocale) =>
    ipcRenderer.invoke(IPC_CHANNELS.requestTunnelCredential, locale) as Promise<{
      saved: boolean;
      error_code: 'invalid_runtime_key' | null;
      status: DesktopStatus;
    }>,
  checkTunnel: () => ipcRenderer.invoke(IPC_CHANNELS.checkTunnel) as Promise<TunnelDoctorResult>,
  startTunnel: () => ipcRenderer.invoke(IPC_CHANNELS.startTunnel) as Promise<DesktopStatus>,
  stopTunnel: () => ipcRenderer.invoke(IPC_CHANNELS.stopTunnel) as Promise<DesktopStatus>,
  installTunnelClient: () =>
    ipcRenderer.invoke(IPC_CHANNELS.installTunnelClient) as Promise<TunnelClientInstallResult>,
  openTunnelSetupHelp: (topic: TunnelSetupHelpTopic) =>
    ipcRenderer.invoke(IPC_CHANNELS.openTunnelSetupHelp, topic) as Promise<void>,
  removeTunnelCredential: () =>
    ipcRenderer.invoke(IPC_CHANNELS.removeTunnelCredential) as Promise<DesktopStatus>,
  setAutoAttach: (input: AutoAttachInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.setAutoAttach, input) as Promise<DesktopStatus>,
  setMcpAppName: (input: McpAppNameInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.setMcpAppName, input) as Promise<DesktopStatus>,
  listTerminalSessions: (workspaceId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.listTerminalSessions,
      workspaceId,
    ) as Promise<TerminalSessionSummaryList>,
  createTerminalSession: (input: CreateTerminalSessionInput) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.createTerminalSession,
      input,
    ) as Promise<TerminalSessionSnapshot>,
  readTerminalSession: (input: ReadTerminalSessionInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.readTerminalSession, input) as Promise<TerminalSessionSnapshot>,
  writeTerminalSession: (input: WriteTerminalSessionInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.writeTerminalSession, input) as Promise<void>,
  resizeTerminalSession: (input: ResizeTerminalSessionInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.resizeTerminalSession, input) as Promise<void>,
  closeTerminalSession: (input: TerminalSessionTarget) =>
    ipcRenderer.invoke(IPC_CHANNELS.closeTerminalSession, input) as Promise<void>,
  getSidebarLayout: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getSidebarLayout) as Promise<SidebarLayout>,
  setSidebarWidth: (width: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.setSidebarWidth, width) as Promise<SidebarLayout>,
  toggleSidebar: () => ipcRenderer.invoke(IPC_CHANNELS.toggleSidebar) as Promise<SidebarLayout>,
  setSidebarPreview: (open: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.setSidebarPreview, open) as Promise<SidebarLayout>,
  setModalOverlay: (open: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.setModalOverlay, open) as Promise<void>,
  getPanelState: () => ipcRenderer.invoke(IPC_CHANNELS.getPanelState) as Promise<PanelState>,
  setPanelState: (patch: PanelStatePatch) =>
    ipcRenderer.invoke(IPC_CHANNELS.setPanelState, patch) as Promise<PanelState>,
  getEditorState: () => ipcRenderer.invoke(IPC_CHANNELS.getEditorState) as Promise<EditorState>,
  getEditorDocument: (input: EditorDocumentTarget) =>
    ipcRenderer.invoke(IPC_CHANNELS.getEditorDocument, input) as Promise<EditorDocument>,
  openEditorFile: (input: OpenEditorFileInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.openEditorFile, input) as Promise<EditorState>,
  activateEditorTab: (input: ActivateEditorTabInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.activateEditorTab, input) as Promise<EditorState>,
  updateEditorDocument: (input: UpdateEditorDocumentInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateEditorDocument, input) as Promise<EditorDocument>,
  saveEditorDocument: (input: EditorDocumentTarget) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveEditorDocument, input) as Promise<EditorDocument>,
  reloadEditorDocument: (input: EditorDocumentTarget) =>
    ipcRenderer.invoke(IPC_CHANNELS.reloadEditorDocument, input) as Promise<EditorDocument>,
  closeEditorTab: (input: EditorDocumentTarget) =>
    ipcRenderer.invoke(IPC_CHANNELS.closeEditorTab, input) as Promise<EditorState>,
  selectWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.selectWorkspace, workspaceId) as Promise<ChatGptTabListResult>,
});

contextBridge.exposeInMainWorld('chatsplice', bridge);
