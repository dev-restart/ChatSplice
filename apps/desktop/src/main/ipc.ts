import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';

import { clipboard, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

import {
  AutoAttachInputSchema,
  DEFAULT_MCP_APP_NAME,
  McpAppNameInputSchema,
  AutomateChatGptProjectInputSchema,
  AutomateChatGptProjectInstructionsInputSchema,
  ChatGptTabIdSchema,
  CreateChatGptTabInputSchema,
  DesktopStatusSchema,
  IPC_CHANNELS,
  ProjectExecTargetSchema,
  ProjectExecSubmitInputSchema,
  PanelStatePatchSchema,
  RemoveWorkspaceInputSchema,
  RenameWorkspaceInputSchema,
  RemoveWorkspaceResultSchema,
  TunnelConfigurationSchema,
  TunnelSetupHelpTopicSchema,
  TunnelStartInputSchema,
  UiLocaleSchema,
  UpdateChatGptTabInputSchema,
  WorkspaceSummarySchema,
  SidebarWidthSchema,
  WorkspaceFileListInputSchema,
  WorkspaceFileReadInputSchema,
  WorkspaceReferenceMutationInputSchema,
  CONTROL_PROTOCOL_VERSION,
  CreateTerminalSessionInputSchema,
  ReadTerminalSessionInputSchema,
  ResizeTerminalSessionInputSchema,
  TerminalSessionTargetSchema,
  WriteTerminalSessionInputSchema,
  ActivateEditorTabInputSchema,
  EditorDocumentSchema,
  EditorDocumentTargetSchema,
  EditorStateSchema,
  OpenEditorFileInputSchema,
  SelectWorkspaceInputSchema,
  UpdateEditorDocumentInputSchema,
} from '@chatsplice/protocol';
import type {
  DaemonStatus,
  DesktopStatus,
  EditorDocument,
  WorkspaceEditorFile,
  SidebarLayout,
  PanelState,
  PanelStatePatch,
  TunnelSetupHelpTopic,
} from '@chatsplice/protocol';

import type { TunnelCredentialStore } from './credential-store.js';
import { DaemonControlError } from './daemon-client.js';
import type { DaemonSupervisor } from './daemon-supervisor.js';
import type { ChatGptTabManager } from './chatgpt-tabs.js';
import type { TerminalService } from './terminal-service.js';
import type {
  EditorTabTarget,
  EditorSessionState,
  WorkbenchEditorSessionManager,
} from './workbench-editor-session.js';

/**
 * Fixed destinations for tunnel setup guidance. The renderer can only ever
 * request one of these keys — never a URL — so this map is the sole source
 * of what `shell.openExternal` is allowed to open for this action.
 */
const TUNNEL_SETUP_HELP_URLS: Record<TunnelSetupHelpTopic, string> = {
  tunnel_id: 'https://platform.openai.com/settings/organization/tunnels',
  organization_id: 'https://platform.openai.com/settings/organization/general',
  runtime_key: 'https://platform.openai.com/settings/organization/api-keys',
};

async function resolveRegisteredProjectRoot(
  supervisor: DaemonSupervisor,
  workspaceId: string,
): Promise<string> {
  const workspaces = await supervisor.client.listWorkspaces();
  const workspace = workspaces.workspaces.find(
    (candidate) => candidate.workspace_id === workspaceId && candidate.kind === 'user',
  );
  if (workspace === undefined) {
    throw new Error('Only a registered user workspace can open a local project surface.');
  }
  const canonicalRoot = await realpath(workspace.root_path);
  if (canonicalRoot !== workspace.root_path) {
    throw new Error('The registered workspace root changed. Refresh the project and retry.');
  }
  return canonicalRoot;
}

async function openRegisteredWorkspace(
  rootPath: string,
  application: 'Terminal' | 'Finder',
): Promise<{ opened: true }> {
  if (process.platform !== 'darwin') {
    throw new Error('Local Terminal and Finder actions are supported only on macOS.');
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/open', ['-a', application, rootPath], {
      shell: false,
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${application} could not be opened.`));
    });
    child.unref();
  });
  return { opened: true };
}

function offlineStatus(): DaemonStatus {
  return {
    protocol_version: CONTROL_PROTOCOL_VERSION,
    healthy: false,
    ready: false,
    mcp_url: null,
    workspace_count: 0,
    probe_workspace_id: null,
    latest_direct_edits: [],
    latest_mcp_activities: [],
    execution_jobs: [],
    tunnel: {
      mode: 'none',
      state: 'unconfigured',
      healthy: false,
      ready: false,
      configuration: null,
      detected_executable_path: null,
      detected_tunnel_id: null,
      mcp_url: null,
      admin_url: null,
      error_code: null,
    },
    read_only_mode: false,
    auto_attach_workspace_ids: [],
    mcp_app_name: DEFAULT_MCP_APP_NAME,
  };
}

export function installIpcHandlers(
  supervisor: DaemonSupervisor,
  credentialStore: TunnelCredentialStore,
  promptForCredential: (locale: 'en' | 'ko') => Promise<string | null>,
  localViewIds: () => ReadonlySet<number>,
  chatgptTabs: ChatGptTabManager,
  sidebar: {
    get(): SidebarLayout;
    setWidth(width: number): SidebarLayout;
    toggle(): SidebarLayout;
    setPreview(open: boolean): SidebarLayout;
    setOverlay(open: boolean): void;
  },
  panel: {
    get(): PanelState;
    set(patch: PanelStatePatch): PanelState;
    syncWorkspace(workspaceId: string | null): PanelState;
    setEditorActive(active: boolean): void;
  },
  terminalService: TerminalService,
  consoleViewId: () => number | undefined,
  editorViewId: () => number | undefined,
  filesViewId: () => number | undefined,
  sidebarViewId: () => number | undefined,
  editorSession: WorkbenchEditorSessionManager,
  invalidateAutomaticTunnelStart: () => void,
): () => void {
  const assertLocalSender = (event: IpcMainInvokeEvent): void => {
    const expectedIds = localViewIds();
    const frameUrl = event.senderFrame?.url;
    let isLocalRenderer = false;
    if (frameUrl !== undefined) {
      try {
        const parsed = new URL(frameUrl);
        isLocalRenderer = parsed.protocol === 'chatsplice:' && parsed.hostname === 'renderer';
      } catch {
        isLocalRenderer = false;
      }
    }
    if (!expectedIds.has(event.sender.id) || !isLocalRenderer) {
      throw new Error('Privileged IPC is available only to the ChatSplice renderer.');
    }
  };

  const status = async (): Promise<DesktopStatus> => {
    const [daemon, credentialAvailable, credentialConfigured] = await Promise.all([
      supervisor.client.status().catch(offlineStatus),
      credentialStore.isAvailable().catch(() => false),
      credentialStore.isConfigured().catch(() => false),
    ]);
    return DesktopStatusSchema.parse({
      daemon,
      // Login confirmation is retained in the status shape for compatibility,
      // but there is no longer a renderer-controlled confirmation action.
      chatgpt_login_confirmed: false,
      credential_store: {
        available: credentialAvailable,
        configured: credentialConfigured,
        error_code: credentialStore.errorCode(),
      },
    });
  };

  let tunnelActionRevision = 0;
  const invalidateTunnelStart = (): number => {
    tunnelActionRevision += 1;
    invalidateAutomaticTunnelStart();
    return tunnelActionRevision;
  };
  const startSavedTunnel = async (revision: number): Promise<void> => {
    const credential = await credentialStore.read();
    if (revision !== tunnelActionRevision || credential === undefined) return;
    const validated = TunnelStartInputSchema.safeParse({ runtime_api_key: credential });
    if (!validated.success) throw new Error('invalid_runtime_key');
    await supervisor.client.startTunnel(validated.data);
  };

  let workspaceSelectionRevision = 0;
  let editorCenterIntentRevision = 0;

  const syncPanelToActiveTab = (
    tabs: {
      active_tab_id: string;
      tabs: readonly {
        chatgpt_tab_id: string;
        workspace_id: string | null;
      }[];
    },
    options: { readonly restoreEditor?: boolean } = {},
  ): void => {
    const active = tabs.tabs.find((tab) => tab.chatgpt_tab_id === tabs.active_tab_id);
    workspaceSelectionRevision += 1;
    panel.syncWorkspace(active?.workspace_id ?? null);
    if (options.restoreEditor === true) {
      editorSession.selectWorkspace(active?.workspace_id ?? null);
      return;
    }
    if (active?.workspace_id === null || active?.workspace_id === undefined) {
      editorSession.selectWorkspace(null);
    } else {
      editorSession.activateChat(active.workspace_id);
    }
    chatgptTabs.setCenterSurface('chatgpt');
    panel.setEditorActive(false);
  };

  const assertSelectedPanelWorkspace = (workspaceId: string): void => {
    if (panel.get().workspace_id !== workspaceId) {
      throw new Error('The selected project changed. Refresh the local panel and retry.');
    }
  };

  const assertConsoleSender = (event: IpcMainInvokeEvent): void => {
    assertLocalSender(event);
    if (consoleViewId() !== event.sender.id) {
      throw new Error('Terminal IPC is available only to the ChatSplice console renderer.');
    }
  };

  const assertEditorSender = (event: IpcMainInvokeEvent): void => {
    assertLocalSender(event);
    if (editorViewId() !== event.sender.id) {
      throw new Error('Editor IPC is available only to the editor renderer.');
    }
  };

  const assertEditorSummarySender = (event: IpcMainInvokeEvent): void => {
    assertLocalSender(event);
    const senderId = event.sender.id;
    if (editorViewId() !== senderId && sidebarViewId() !== senderId) {
      throw new Error('Editor summaries are available only to local editor surfaces.');
    }
  };

  const assertEditorOpenSender = (event: IpcMainInvokeEvent): void => {
    assertLocalSender(event);
    const senderId = event.sender.id;
    if (filesViewId() !== senderId && sidebarViewId() !== senderId) {
      throw new Error('Editor file opening is available only to trusted file surfaces.');
    }
  };

  const editorError = (code: string, message: string): Error => {
    const error = new Error(message);
    Object.defineProperty(error, 'code', { value: code, enumerable: true });
    return error;
  };

  const mapEditorDaemonError = (error: unknown, operation: 'read' | 'save'): Error => {
    if (error instanceof DaemonControlError) {
      if (operation === 'save' && error.statusCode === 409) {
        return editorError(
          'editor_conflict',
          '파일이 외부에서 변경되어 저장할 수 없습니다. 다시 읽은 뒤 확인해 주세요.',
        );
      }
      if (error.code === 'UNSUPPORTED_ENCODING') {
        return editorError('editor_unsupported_encoding', 'UTF-8 텍스트 파일만 열 수 있습니다.');
      }
      if (error.code === 'SECRET_PATH_DENIED' || error.code === 'PATH_OUTSIDE_WORKSPACE') {
        return editorError('editor_path_denied', '이 경로에는 접근할 수 없습니다.');
      }
      if (error.code === 'PATH_NOT_FILE' || error.code === 'WORKSPACE_NOT_FOUND') {
        return editorError('editor_file_not_found', '파일을 찾을 수 없습니다.');
      }
    }
    return error instanceof Error ? error : new Error('Editor file operation failed.');
  };

  const assertEditorSelection = (workspaceId: string, revision: number): void => {
    if (revision !== workspaceSelectionRevision || panel.get().workspace_id !== workspaceId) {
      throw editorError(
        'editor_selection_changed',
        '선택한 프로젝트가 변경되었습니다. 파일을 다시 열어 주세요.',
      );
    }
  };

  const assertEditorCenterIntent = (revision: number): void => {
    if (revision !== editorCenterIntentRevision) {
      throw editorError('editor_selection_changed', '다른 편집기 탭이 선택되었습니다.');
    }
  };

  const editorTarget = (input: unknown): EditorTabTarget => EditorDocumentTargetSchema.parse(input);

  const snapshotEditorDocument = (target: EditorTabTarget): EditorDocument =>
    editorSession.getDocument(target);

  const saveEditorSnapshot = async (document: EditorDocument): Promise<EditorDocument> => {
    let saved: WorkspaceEditorFile;
    try {
      saved = await supervisor.client.saveWorkspaceEditorFile({
        workspace_id: document.workspace_id,
        path: document.path,
        expected_sha256: document.sha256,
        content: document.content,
      });
    } catch (error) {
      throw mapEditorDaemonError(error, 'save');
    }
    return editorSession.markSaved({
      workspace_id: document.workspace_id,
      editor_tab_id: document.editor_tab_id,
      expected_revision: document.draft_revision,
      content: saved.content,
      sha256: saved.sha256,
    }).document;
  };

  const askUnsavedAction = async (
    documentCount: number,
  ): Promise<'save' | 'discard' | 'cancel'> => {
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: '저장하지 않은 변경 사항',
      message:
        documentCount === 1
          ? '저장하지 않은 변경 사항이 있습니다.'
          : `${documentCount}개 파일에 저장하지 않은 변경 사항이 있습니다.`,
      detail: '계속하면 변경 사항이 사라질 수 있습니다.',
      buttons: ['저장', '버리기', '취소'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (result.response === 0) return 'save';
    if (result.response === 1) return 'discard';
    return 'cancel';
  };

  const guardDirtyEditorDocuments = async (workspaceId?: string): Promise<boolean> => {
    for (;;) {
      const dirty = editorSession
        .listDirtyDocuments()
        .filter((document) => workspaceId === undefined || document.workspace_id === workspaceId);
      if (dirty.length === 0) return true;
      const revisions = new Map(
        dirty.map((document) => [document.editor_tab_id, document.draft_revision]),
      );
      const action = await askUnsavedAction(dirty.length);
      if (action === 'cancel') return false;
      if (action === 'discard') {
        const changed = editorSession
          .listDirtyDocuments()
          .some(
            (document) =>
              revisions.get(document.editor_tab_id) !== undefined &&
              revisions.get(document.editor_tab_id) !== document.draft_revision,
          );
        if (changed) continue;
        return true;
      }
      for (const document of dirty) await saveEditorSnapshot(document);
    }
  };

  const resolveDirtyEditorDocument = async (target: EditorTabTarget): Promise<void> => {
    for (;;) {
      const document = snapshotEditorDocument(target);
      if (!document.dirty) return;
      const revision = document.draft_revision;
      const action = await askUnsavedAction(1);
      if (action === 'cancel') throw editorError('editor_cancelled', '작업을 취소했습니다.');
      if (action === 'discard') {
        const current = snapshotEditorDocument(target);
        if (current.draft_revision !== revision) continue;
        return;
      }
      await saveEditorSnapshot(document);
    }
  };

  ipcMain.handle(IPC_CHANNELS.getStatus, async (event) => {
    assertLocalSender(event);
    return status();
  });
  ipcMain.handle(IPC_CHANNELS.getExecutionJob, async (event, input: unknown) => {
    assertLocalSender(event);
    return supervisor.client.getExecutionJob(ProjectExecTargetSchema.parse(input));
  });
  ipcMain.handle(IPC_CHANNELS.cancelExecutionJob, async (event, input: unknown) => {
    assertLocalSender(event);
    return supervisor.client.cancelExecutionJob(ProjectExecTargetSchema.parse(input));
  });
  ipcMain.handle(IPC_CHANNELS.submitProjectExec, async (event, input: unknown) => {
    assertLocalSender(event);
    const validated = ProjectExecSubmitInputSchema.parse(input);
    assertSelectedPanelWorkspace(validated.workspace_id);
    return supervisor.client.submitProjectExec(validated);
  });
  ipcMain.handle(IPC_CHANNELS.listWorkspaces, async (event) => {
    assertLocalSender(event);
    return supervisor.client.listWorkspaces();
  });
  ipcMain.handle(IPC_CHANNELS.listWorkspaceFiles, async (event, input: unknown) => {
    assertLocalSender(event);
    const validated = WorkspaceFileListInputSchema.parse(input);
    assertSelectedPanelWorkspace(validated.workspace_id);
    return supervisor.client.listWorkspaceFiles(validated);
  });
  ipcMain.handle(IPC_CHANNELS.readWorkspaceFile, async (event, input: unknown) => {
    assertLocalSender(event);
    const validated = WorkspaceFileReadInputSchema.parse(input);
    assertSelectedPanelWorkspace(validated.workspace_id);
    return supervisor.client.readWorkspaceFile(validated);
  });
  ipcMain.handle(IPC_CHANNELS.getEditorState, (event) => {
    assertEditorSummarySender(event);
    const state = editorSession.getState(panel.get().workspace_id);
    return EditorStateSchema.parse(state);
  });
  ipcMain.handle(IPC_CHANNELS.getEditorDocument, async (event, input: unknown) => {
    assertEditorSender(event);
    const target = editorTarget(input);
    assertSelectedPanelWorkspace(target.workspace_id);
    try {
      return EditorDocumentSchema.parse(editorSession.getDocument(target));
    } catch {
      const state = editorSession.getState(target.workspace_id);
      const tab = state.tabs.find((candidate) => candidate.editor_tab_id === target.editor_tab_id);
      if (tab === undefined) {
        throw editorError('editor_tab_not_found', '편집기 탭을 찾을 수 없습니다.');
      }
      const selectionRevision = workspaceSelectionRevision;
      const file = await supervisor.client
        .readWorkspaceEditorFile({ workspace_id: target.workspace_id, path: tab.path })
        .catch((error: unknown) => {
          throw mapEditorDaemonError(error, 'read');
        });
      assertEditorSelection(target.workspace_id, selectionRevision);
      const currentTab = editorSession
        .getState(target.workspace_id)
        .tabs.find((candidate) => candidate.editor_tab_id === target.editor_tab_id);
      if (currentTab === undefined || currentTab.path !== tab.path) {
        throw editorError('editor_tab_not_found', '편집기 탭이 닫혔습니다.');
      }
      const hydrated = editorSession.hydrateDocument({
        ...target,
        path: file.path,
        content: file.content,
        sha256: file.sha256,
      });
      return EditorDocumentSchema.parse(hydrated);
    }
  });
  ipcMain.handle(IPC_CHANNELS.openEditorFile, async (event, input: unknown) => {
    assertEditorOpenSender(event);
    const validated = OpenEditorFileInputSchema.parse(input);
    const centerIntentRevision = ++editorCenterIntentRevision;
    assertSelectedPanelWorkspace(validated.workspace_id);
    const state = editorSession.getState(validated.workspace_id);
    const existing = state.tabs.find((tab) => tab.path === validated.path);
    const existingTarget =
      existing === undefined
        ? undefined
        : { workspace_id: validated.workspace_id, editor_tab_id: existing.editor_tab_id };
    const existingDocument =
      existing?.loaded === true && existingTarget !== undefined
        ? editorSession.getDocument(existingTarget)
        : undefined;
    if (existing?.loaded === true && existing.dirty) {
      editorSession.activateTab(existingTarget!);
      chatgptTabs.setCenterSurface('editor');
      panel.setEditorActive(true);
      return EditorStateSchema.parse(editorSession.getState(validated.workspace_id));
    }

    const selectionRevision = workspaceSelectionRevision;
    const file = await supervisor.client
      .readWorkspaceEditorFile(validated)
      .catch((error: unknown) => {
        throw mapEditorDaemonError(error, 'read');
      });
    assertEditorSelection(validated.workspace_id, selectionRevision);
    assertEditorCenterIntent(centerIntentRevision);

    let nextState: EditorSessionState;
    if (existing === undefined || existing.loaded === false) {
      nextState = editorSession.openFile({
        workspace_id: validated.workspace_id,
        path: file.path,
        content: file.content,
        sha256: file.sha256,
      }).state;
    } else {
      const latestBeforeReload = editorSession.getDocument(existingTarget!);
      if (
        existingDocument !== undefined &&
        (latestBeforeReload.draft_revision !== existingDocument.draft_revision ||
          latestBeforeReload.dirty)
      ) {
        editorSession.activateTab(existingTarget!);
        chatgptTabs.setCenterSurface('editor');
        panel.setEditorActive(true);
        return EditorStateSchema.parse(editorSession.getState(validated.workspace_id));
      }
      assertEditorCenterIntent(centerIntentRevision);
      editorSession.reloadDocument({
        workspace_id: validated.workspace_id,
        editor_tab_id: existing.editor_tab_id,
        content: file.content,
        sha256: file.sha256,
      });
      nextState = editorSession.activateTab({
        workspace_id: validated.workspace_id,
        editor_tab_id: existing.editor_tab_id,
      });
    }
    chatgptTabs.setCenterSurface('editor');
    panel.setEditorActive(true);
    return EditorStateSchema.parse(nextState);
  });
  ipcMain.handle(IPC_CHANNELS.activateEditorTab, async (event, input: unknown) => {
    assertEditorSender(event);
    const validated = ActivateEditorTabInputSchema.parse(input);
    const centerIntentRevision = ++editorCenterIntentRevision;
    assertSelectedPanelWorkspace(validated.workspace_id);
    let state: EditorSessionState;
    if (validated.editor_tab_id === null) {
      state = editorSession.activateChat(validated.workspace_id);
      chatgptTabs.setCenterSurface('chatgpt');
      panel.setEditorActive(false);
    } else {
      const target = {
        workspace_id: validated.workspace_id,
        editor_tab_id: validated.editor_tab_id,
      };
      const currentState = editorSession.getState(validated.workspace_id);
      const tab = currentState.tabs.find(
        (candidate) => candidate.editor_tab_id === validated.editor_tab_id,
      );
      if (tab === undefined)
        throw editorError('editor_tab_not_found', '편집기 탭을 찾을 수 없습니다.');
      if (!tab.dirty) {
        const initialDocument = tab.loaded ? editorSession.getDocument(target) : undefined;
        const selectionRevision = workspaceSelectionRevision;
        const file = await supervisor.client
          .readWorkspaceEditorFile({ workspace_id: validated.workspace_id, path: tab.path })
          .catch((error: unknown) => {
            throw mapEditorDaemonError(error, 'read');
          });
        assertEditorSelection(validated.workspace_id, selectionRevision);
        assertEditorCenterIntent(centerIntentRevision);
        if (tab.loaded) {
          const latestDocument = editorSession.getDocument(target);
          if (
            initialDocument !== undefined &&
            (latestDocument.draft_revision !== initialDocument.draft_revision ||
              latestDocument.dirty)
          ) {
            state = editorSession.activateTab(target);
            chatgptTabs.setCenterSurface('editor');
            panel.setEditorActive(true);
            return EditorStateSchema.parse(state);
          }
          editorSession.reloadDocument({
            ...target,
            content: file.content,
            sha256: file.sha256,
          });
        } else {
          editorSession.openFile({
            workspace_id: validated.workspace_id,
            path: file.path,
            content: file.content,
            sha256: file.sha256,
          });
        }
      }
      assertEditorCenterIntent(centerIntentRevision);
      state = editorSession.activateTab(target);
      chatgptTabs.setCenterSurface('editor');
      panel.setEditorActive(true);
    }
    return EditorStateSchema.parse(state);
  });
  ipcMain.handle(IPC_CHANNELS.updateEditorDocument, (event, input: unknown) => {
    assertEditorSender(event);
    const validated = UpdateEditorDocumentInputSchema.parse(input);
    // Renderer debouncing can deliver the final draft after the sidebar has
    // moved to another project. The explicit workspace/tab target and manager
    // revision check still keep this mutation bound to its original document.
    return EditorDocumentSchema.parse(editorSession.updateDocument(validated).document);
  });
  ipcMain.handle(IPC_CHANNELS.saveEditorDocument, async (event, input: unknown) => {
    assertEditorSender(event);
    const target = editorTarget(input);
    const document = snapshotEditorDocument(target);
    return EditorDocumentSchema.parse(await saveEditorSnapshot(document));
  });
  ipcMain.handle(IPC_CHANNELS.reloadEditorDocument, async (event, input: unknown) => {
    assertEditorSender(event);
    const target = editorTarget(input);
    assertSelectedPanelWorkspace(target.workspace_id);
    const current = snapshotEditorDocument(target);
    const selectionRevision = workspaceSelectionRevision;
    if (current.dirty) {
      await resolveDirtyEditorDocument(target);
    }
    assertEditorSelection(target.workspace_id, selectionRevision);
    const revisionBeforeRead = snapshotEditorDocument(target).draft_revision;
    const file = await supervisor.client
      .readWorkspaceEditorFile({ workspace_id: target.workspace_id, path: current.path })
      .catch((error: unknown) => {
        throw mapEditorDaemonError(error, 'read');
      });
    assertEditorSelection(target.workspace_id, selectionRevision);
    const latest = snapshotEditorDocument(target);
    if (latest.draft_revision !== revisionBeforeRead) {
      return EditorDocumentSchema.parse(latest);
    }
    return EditorDocumentSchema.parse(
      editorSession.reloadDocument({
        ...target,
        content: file.content,
        sha256: file.sha256,
      }).document,
    );
  });
  ipcMain.handle(IPC_CHANNELS.closeEditorTab, async (event, input: unknown) => {
    assertEditorSender(event);
    const target = editorTarget(input);
    assertSelectedPanelWorkspace(target.workspace_id);
    let closed = editorSession.closeTab(target);
    if (!closed.closed && closed.reason === 'dirty') {
      const selectionRevision = workspaceSelectionRevision;
      await resolveDirtyEditorDocument(target);
      assertEditorSelection(target.workspace_id, selectionRevision);
      closed = editorSession.closeTab({ ...target, discard: true });
    }
    if (!closed.closed)
      throw editorError('editor_unsaved_changes', '저장하지 않은 변경 사항이 있습니다.');
    const state = EditorStateSchema.parse(closed.state);
    panel.setEditorActive(state.active_editor_tab_id !== null);
    if (state.active_editor_tab_id === null) chatgptTabs.setCenterSurface('chatgpt');
    return state;
  });
  ipcMain.handle(IPC_CHANNELS.selectWorkspace, async (event, input: unknown) => {
    assertLocalSender(event);
    if (sidebarViewId() !== event.sender.id) {
      throw new Error('Project selection is available only to the ChatSplice sidebar.');
    }
    const workspaceId = SelectWorkspaceInputSchema.parse(input);
    const selectionRequestRevision = ++workspaceSelectionRevision;
    const workspaces = await supervisor.client.listWorkspaces();
    if (selectionRequestRevision !== workspaceSelectionRevision) {
      throw editorError('editor_selection_changed', '선택한 프로젝트가 변경되었습니다.');
    }
    const workspace = workspaces.workspaces.find(
      (candidate) => candidate.workspace_id === workspaceId && candidate.kind === 'user',
    );
    if (workspace === undefined) throw new Error('Unknown ChatSplice workspace association.');
    const activated = await chatgptTabs.activateWorkspace(workspaceId);
    const tabs =
      activated ??
      (await chatgptTabs.createTab({
        workspace_id: workspaceId,
        label: `${workspace.display_name} · ChatGPT Project`,
      }));
    if (selectionRequestRevision !== workspaceSelectionRevision) {
      throw editorError('editor_selection_changed', '선택한 프로젝트가 변경되었습니다.');
    }
    syncPanelToActiveTab(tabs, { restoreEditor: true });
    const restored = EditorStateSchema.parse(editorSession.getState(workspaceId));
    const editorVisible = restored.active_editor_tab_id !== null;
    chatgptTabs.setCenterSurface(editorVisible ? 'editor' : 'chatgpt');
    panel.setEditorActive(editorVisible);
    return tabs;
  });
  ipcMain.handle(IPC_CHANNELS.openWorkspaceTerminal, async (event, workspaceId: unknown) => {
    assertLocalSender(event);
    const validatedId = WorkspaceSummarySchema.shape.workspace_id.parse(workspaceId);
    return openRegisteredWorkspace(
      await resolveRegisteredProjectRoot(supervisor, validatedId),
      'Terminal',
    );
  });
  ipcMain.handle(IPC_CHANNELS.openWorkspaceFinder, async (event, workspaceId: unknown) => {
    assertLocalSender(event);
    const validatedId = WorkspaceSummarySchema.shape.workspace_id.parse(workspaceId);
    return openRegisteredWorkspace(
      await resolveRegisteredProjectRoot(supervisor, validatedId),
      'Finder',
    );
  });
  ipcMain.handle(IPC_CHANNELS.listWorkspaceReferences, async (event) => {
    assertLocalSender(event);
    return supervisor.client.listWorkspaceReferences();
  });
  ipcMain.handle(IPC_CHANNELS.addWorkspaceReference, async (event, input: unknown) => {
    assertLocalSender(event);
    return supervisor.client.addWorkspaceReference(
      WorkspaceReferenceMutationInputSchema.parse(input),
    );
  });
  ipcMain.handle(IPC_CHANNELS.removeWorkspaceReference, async (event, input: unknown) => {
    assertLocalSender(event);
    return supervisor.client.removeWorkspaceReference(
      WorkspaceReferenceMutationInputSchema.parse(input),
    );
  });
  ipcMain.handle(IPC_CHANNELS.openWorkspace, async (event) => {
    assertLocalSender(event);
    const result = await dialog.showOpenDialog({
      title: 'Open ChatSplice workspace',
      properties: ['openDirectory'],
    });
    const rootPath = result.filePaths[0];
    if (result.canceled || rootPath === undefined) {
      return null;
    }
    return supervisor.client.registerWorkspace({ root_path: rootPath });
  });
  ipcMain.handle(IPC_CHANNELS.renameWorkspace, async (event, input: unknown) => {
    assertLocalSender(event);
    return supervisor.client.renameWorkspace(RenameWorkspaceInputSchema.parse(input));
  });
  ipcMain.handle(IPC_CHANNELS.updateWorkspaceRootPath, async (event, workspaceId: unknown) => {
    assertLocalSender(event);
    const validatedId = WorkspaceSummarySchema.shape.workspace_id.parse(workspaceId);
    const result = await dialog.showOpenDialog({
      title: 'Choose the new local folder',
      properties: ['openDirectory'],
    });
    const rootPath = result.filePaths[0];
    if (result.canceled || rootPath === undefined) {
      return null;
    }
    if (!(await guardDirtyEditorDocuments(validatedId))) return null;
    const updated = await supervisor.client.updateWorkspaceRootPath({
      workspace_id: validatedId,
      root_path: rootPath,
    });
    await terminalService.closeWorkspace(validatedId);
    editorSession.closeWorkspace(validatedId, { discard: true });
    if (panel.get().workspace_id === validatedId) panel.setEditorActive(false);
    return updated;
  });
  ipcMain.handle(IPC_CHANNELS.removeWorkspace, async (event, input: unknown) => {
    assertLocalSender(event);
    const validated = RemoveWorkspaceInputSchema.parse(input);
    if (!(await guardDirtyEditorDocuments(validated.workspace_id))) {
      const currentWorkspaces = await supervisor.client.listWorkspaces();
      return RemoveWorkspaceResultSchema.parse({
        workspaces: currentWorkspaces,
        tabs: chatgptTabs.list(),
      });
    }
    const workspaces = await supervisor.client.removeWorkspace(validated);
    await terminalService.closeWorkspace(validated.workspace_id);
    editorSession.closeWorkspace(validated.workspace_id, { discard: true });
    if (panel.get().workspace_id === validated.workspace_id) panel.setEditorActive(false);
    const tabs = await chatgptTabs.detachWorkspace(validated.workspace_id);
    if (panel.get().workspace_id === validated.workspace_id) {
      panel.set({ workspace_id: null });
    }
    syncPanelToActiveTab(tabs);
    return RemoveWorkspaceResultSchema.parse({ workspaces, tabs });
  });
  ipcMain.handle(IPC_CHANNELS.copyProjectBinding, async (event, workspaceId: unknown) => {
    assertLocalSender(event);
    const validatedId = WorkspaceSummarySchema.shape.workspace_id.parse(workspaceId);
    const binding = await supervisor.client.projectBinding(validatedId);
    clipboard.writeText(binding.binding_text);
    return { copied: true };
  });
  ipcMain.handle(IPC_CHANNELS.automateChatGptProject, async (event, input: unknown) => {
    assertLocalSender(event);
    const validated = AutomateChatGptProjectInputSchema.parse(input);
    const workspaces = await supervisor.client.listWorkspaces();
    const workspace = workspaces.workspaces.find(
      (candidate) => candidate.workspace_id === validated.workspace_id && candidate.kind === 'user',
    );
    if (workspace === undefined) {
      throw new Error('Unknown ChatSplice workspace association.');
    }
    const binding = await supervisor.client.projectBinding(validated.workspace_id);
    const result = await chatgptTabs.automateProjectSetup({
      workspace_id: workspace.workspace_id,
      workspace_name: workspace.display_name,
      binding_text: binding.binding_text,
    });
    syncPanelToActiveTab(result.tabs);
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.automateProjectInstructionsUpdate, async (event, input: unknown) => {
    assertLocalSender(event);
    const validated = AutomateChatGptProjectInstructionsInputSchema.parse(input);
    const workspaces = await supervisor.client.listWorkspaces();
    const workspace = workspaces.workspaces.find(
      (candidate) => candidate.workspace_id === validated.workspace_id && candidate.kind === 'user',
    );
    if (workspace === undefined) {
      throw new Error('Unknown ChatSplice workspace association.');
    }
    const binding = await supervisor.client.projectBinding(validated.workspace_id);
    const result = await chatgptTabs.automateProjectInstructionsUpdate({
      workspace_id: workspace.workspace_id,
      workspace_name: workspace.display_name,
      binding_text: binding.binding_text,
      automatic: validated.automatic === true,
    });
    if (!validated.automatic) syncPanelToActiveTab(result.tabs);
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.listChatGptTabs, (event) => {
    assertLocalSender(event);
    return chatgptTabs.list();
  });
  ipcMain.handle(IPC_CHANNELS.createChatGptTab, async (event, input: unknown) => {
    assertLocalSender(event);
    const validated = CreateChatGptTabInputSchema.parse(input);
    if (validated.workspace_id !== null) {
      const workspaces = await supervisor.client.listWorkspaces();
      if (
        !workspaces.workspaces.some(
          (workspace) => workspace.workspace_id === validated.workspace_id,
        )
      ) {
        throw new Error('Unknown ChatSplice workspace association.');
      }
    }
    const result = await chatgptTabs.createTab(validated);
    syncPanelToActiveTab(result);
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.activateChatGptTab, async (event, chatGptTabId: unknown) => {
    assertLocalSender(event);
    const result = await chatgptTabs.activateTab(ChatGptTabIdSchema.parse(chatGptTabId));
    syncPanelToActiveTab(result);
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.updateChatGptTab, async (event, input: unknown) => {
    assertLocalSender(event);
    const validated = UpdateChatGptTabInputSchema.parse(input);
    if (validated.workspace_id !== undefined && validated.workspace_id !== null) {
      const workspaces = await supervisor.client.listWorkspaces();
      if (
        !workspaces.workspaces.some(
          (workspace) => workspace.workspace_id === validated.workspace_id,
        )
      ) {
        throw new Error('Unknown ChatSplice workspace association.');
      }
    }
    const result = await chatgptTabs.updateTab(validated);
    syncPanelToActiveTab(result);
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.closeChatGptTab, async (event, chatGptTabId: unknown) => {
    assertLocalSender(event);
    const result = await chatgptTabs.closeTab(ChatGptTabIdSchema.parse(chatGptTabId));
    syncPanelToActiveTab(result);
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.configureTunnel, async (event, input: unknown) => {
    assertLocalSender(event);
    const validated = TunnelConfigurationSchema.parse(input);
    const revision = invalidateTunnelStart();
    await supervisor.client.configureTunnel(validated);
    if (validated.automatic_start && revision === tunnelActionRevision)
      await startSavedTunnel(revision);
    return status();
  });
  ipcMain.handle(IPC_CHANNELS.setAutoAttach, async (event, input: unknown) => {
    assertLocalSender(event);
    await supervisor.client.setAutoAttach(AutoAttachInputSchema.parse(input));
    return status();
  });
  ipcMain.handle(IPC_CHANNELS.setMcpAppName, async (event, input: unknown) => {
    assertLocalSender(event);
    await supervisor.client.setMcpAppName(McpAppNameInputSchema.parse(input).name);
    return status();
  });
  ipcMain.handle(IPC_CHANNELS.requestTunnelCredential, async (event, locale: unknown) => {
    assertLocalSender(event);
    const validatedLocale = UiLocaleSchema.parse(locale);
    const revision = invalidateTunnelStart();
    const credential = await promptForCredential(validatedLocale);
    if (credential === null) {
      return { saved: false, error_code: null, status: await status() };
    }
    const validated = TunnelStartInputSchema.safeParse({ runtime_api_key: credential });
    if (!validated.success) {
      return { saved: false, error_code: 'invalid_runtime_key', status: await status() };
    }
    await credentialStore.store(validated.data.runtime_api_key);
    if (revision === tunnelActionRevision) await supervisor.client.startTunnel(validated.data);
    return { saved: true, error_code: null, status: await status() };
  });
  ipcMain.handle(IPC_CHANNELS.startTunnel, async (event) => {
    assertLocalSender(event);
    const revision = invalidateTunnelStart();
    if (!(await credentialStore.isConfigured()))
      throw new Error('Tunnel runtime credential is not configured.');
    await startSavedTunnel(revision);
    return status();
  });
  ipcMain.handle(IPC_CHANNELS.checkTunnel, async (event) => {
    assertLocalSender(event);
    const credential = await credentialStore.read();
    if (credential === undefined) {
      throw new Error('Tunnel runtime credential is not configured.');
    }
    const validated = TunnelStartInputSchema.safeParse({ runtime_api_key: credential });
    if (!validated.success) {
      throw new Error('invalid_runtime_key');
    }
    return supervisor.client.doctorTunnel(validated.data);
  });
  ipcMain.handle(IPC_CHANNELS.stopTunnel, async (event) => {
    assertLocalSender(event);
    invalidateTunnelStart();
    await supervisor.client.stopTunnel();
    return status();
  });
  ipcMain.handle(IPC_CHANNELS.installTunnelClient, async (event) => {
    assertLocalSender(event);
    return supervisor.client.installTunnelClient();
  });
  ipcMain.handle(IPC_CHANNELS.openTunnelSetupHelp, async (event, topic: unknown) => {
    assertLocalSender(event);
    const validated = TunnelSetupHelpTopicSchema.parse(topic);
    await shell.openExternal(TUNNEL_SETUP_HELP_URLS[validated]);
  });
  ipcMain.handle(IPC_CHANNELS.removeTunnelCredential, async (event) => {
    assertLocalSender(event);
    invalidateTunnelStart();
    await supervisor.client.stopTunnel();
    await credentialStore.remove();
    return status();
  });
  ipcMain.handle(IPC_CHANNELS.getSidebarLayout, (event) => {
    assertLocalSender(event);
    return sidebar.get();
  });
  ipcMain.handle(IPC_CHANNELS.setSidebarWidth, (event, width: unknown) => {
    assertLocalSender(event);
    return sidebar.setWidth(SidebarWidthSchema.parse(width));
  });
  ipcMain.handle(IPC_CHANNELS.toggleSidebar, (event) => {
    assertLocalSender(event);
    return sidebar.toggle();
  });
  ipcMain.handle(IPC_CHANNELS.setSidebarPreview, (event, open: unknown) => {
    assertLocalSender(event);
    if (typeof open !== 'boolean') throw new TypeError('Sidebar preview state must be boolean.');
    return sidebar.setPreview(open);
  });
  ipcMain.handle(IPC_CHANNELS.setModalOverlay, (event, open: unknown) => {
    assertLocalSender(event);
    if (typeof open !== 'boolean') throw new TypeError('Modal overlay state must be boolean.');
    sidebar.setOverlay(open);
    chatgptTabs.setProjectInstructionsPaused(open);
    return null;
  });
  ipcMain.handle(IPC_CHANNELS.getPanelState, (event) => {
    assertLocalSender(event);
    return panel.get();
  });
  ipcMain.handle(IPC_CHANNELS.setPanelState, async (event, input: unknown) => {
    assertLocalSender(event);
    const patch = PanelStatePatchSchema.parse(input);
    const workspaceId = patch.workspace_id;
    const revision =
      workspaceId === undefined ? workspaceSelectionRevision : ++workspaceSelectionRevision;
    if (patch.workspace_id !== undefined && patch.workspace_id !== null) {
      await resolveRegisteredProjectRoot(supervisor, patch.workspace_id);
    }
    if (workspaceId !== undefined && revision !== workspaceSelectionRevision) {
      const booleanPatch = { ...patch };
      delete booleanPatch.workspace_id;
      return panel.set(booleanPatch);
    }
    return panel.set(patch);
  });

  ipcMain.handle(IPC_CHANNELS.listTerminalSessions, async (event, workspaceId: unknown) => {
    assertConsoleSender(event);
    const validatedWorkspaceId = TerminalSessionTargetSchema.shape.workspace_id.parse(workspaceId);
    return terminalService.listTerminalSessions(validatedWorkspaceId);
  });
  ipcMain.handle(IPC_CHANNELS.createTerminalSession, async (event, input: unknown) => {
    assertConsoleSender(event);
    return terminalService.createTerminalSession(CreateTerminalSessionInputSchema.parse(input));
  });
  ipcMain.handle(IPC_CHANNELS.readTerminalSession, async (event, input: unknown) => {
    assertConsoleSender(event);
    return terminalService.readTerminalSession(ReadTerminalSessionInputSchema.parse(input));
  });
  ipcMain.handle(IPC_CHANNELS.writeTerminalSession, async (event, input: unknown) => {
    assertConsoleSender(event);
    await terminalService.writeTerminalSession(WriteTerminalSessionInputSchema.parse(input));
    return null;
  });
  ipcMain.handle(IPC_CHANNELS.resizeTerminalSession, async (event, input: unknown) => {
    assertConsoleSender(event);
    await terminalService.resizeTerminalSession(ResizeTerminalSessionInputSchema.parse(input));
    return null;
  });
  ipcMain.handle(IPC_CHANNELS.closeTerminalSession, async (event, input: unknown) => {
    assertConsoleSender(event);
    await terminalService.closeTerminalSession(TerminalSessionTargetSchema.parse(input));
    return null;
  });
  return () => {
    for (const channel of Object.values(IPC_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
  };
}
