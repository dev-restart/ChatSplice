import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { app, autoUpdater, dialog, Menu, protocol, safeStorage, screen, shell } from 'electron';

import { TunnelStartInputSchema } from '@chatsplice/protocol';
import { SidebarLayoutSchema } from '@chatsplice/protocol';

import { promptForTunnelCredential } from './credential-prompt.js';
import {
  resolveCompatibleControlSocketPath,
  resolveCompatibleDaemonDataDirectory,
  resolveCompatibleUserDataPath,
} from './brand-compatibility.js';
import { TunnelCredentialStore } from './credential-store.js';
import { DaemonSupervisor } from './daemon-supervisor.js';
import { installIpcHandlers } from './ipc.js';
import { LocalApplyAutoDispatcher } from './local-apply-auto-dispatcher.js';
import { LocalMcpAutoAttachDispatcher } from './local-mcp-auto-attach-dispatcher.js';
import { registerLocalRendererProtocol } from './local-protocol.js';
import { ReferenceRequestDispatcher } from './reference-request-dispatcher.js';
import { TerminalService } from './terminal-service.js';
import { createChatSpliceWindow, desktopPreloadPath } from './window.js';
import type { ChatSpliceWindow } from './window.js';
import { DEFAULT_SIDEBAR_WIDTH } from './sidebar-layout.js';
import { readWindowState, writeWindowState } from './window-state.js';
import { WorkbenchEditorSessionManager } from './workbench-editor-session.js';
import type { EditorSessionPersistedState } from './workbench-editor-session.js';
import { AppUpdateController, RELEASES_URL, supportsAppUpdates } from './app-updates.js';

const MAX_EDITOR_SESSION_METADATA_BYTES = 512 * 1024;
const MAX_EDITOR_SESSION_WORKSPACES = 500;
const MAX_EDITOR_SESSION_TABS_PER_WORKSPACE = 16;
const MAX_EDITOR_SESSION_TABS_TOTAL = 48;

async function readSidebarLayout(path: string) {
  try {
    return SidebarLayoutSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return { width: DEFAULT_SIDEBAR_WIDTH, collapsed: false } as const;
  }
}

async function writeSidebarLayout(path: string, layout: unknown): Promise<void> {
  const validated = SidebarLayoutSchema.parse(layout);
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(validated)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readEditorSessionMetadata(value: unknown): EditorSessionPersistedState | undefined {
  if (!isRecord(value)) return undefined;
  const activeWorkspaceId = value.active_workspace_id;
  if (activeWorkspaceId !== null && typeof activeWorkspaceId !== 'string') return undefined;
  const workspaces = value.workspaces;
  if (!Array.isArray(workspaces) || workspaces.length > MAX_EDITOR_SESSION_WORKSPACES) {
    return undefined;
  }
  let totalTabs = 0;
  const parsedWorkspaces: Array<EditorSessionPersistedState['workspaces'][number]> = [];
  for (const workspace of workspaces) {
    if (!isRecord(workspace) || typeof workspace.workspace_id !== 'string') return undefined;
    const activeTabId = workspace.active_editor_tab_id;
    if (activeTabId !== null && typeof activeTabId !== 'string') return undefined;
    if (
      !Array.isArray(workspace.tabs) ||
      workspace.tabs.length > MAX_EDITOR_SESSION_TABS_PER_WORKSPACE
    ) {
      return undefined;
    }
    const tabs: Array<EditorSessionPersistedState['workspaces'][number]['tabs'][number]> = [];
    for (const tab of workspace.tabs) {
      if (
        !isRecord(tab) ||
        typeof tab.editor_tab_id !== 'string' ||
        typeof tab.path !== 'string' ||
        typeof tab.label !== 'string'
      ) {
        return undefined;
      }
      tabs.push({ editor_tab_id: tab.editor_tab_id, path: tab.path, label: tab.label });
    }
    totalTabs += tabs.length;
    if (totalTabs > MAX_EDITOR_SESSION_TABS_TOTAL) return undefined;
    parsedWorkspaces.push({
      workspace_id: workspace.workspace_id,
      tabs,
      active_editor_tab_id: activeTabId,
    });
  }
  return { active_workspace_id: activeWorkspaceId, workspaces: parsedWorkspaces };
}

async function readEditorSession(path: string): Promise<EditorSessionPersistedState | undefined> {
  try {
    const serialized = await readFile(path, 'utf8');
    if (Buffer.byteLength(serialized, 'utf8') > MAX_EDITOR_SESSION_METADATA_BYTES) return undefined;
    return readEditorSessionMetadata(JSON.parse(serialized));
  } catch {
    return undefined;
  }
}

async function writeEditorSession(path: string, state: EditorSessionPersistedState): Promise<void> {
  const serialized = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EDITOR_SESSION_METADATA_BYTES) {
    throw new Error('Editor session metadata exceeded its size limit.');
  }
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, serialized, { mode: 0o600 });
  await rename(temporaryPath, path);
}

app.setName('ChatSplice');

const configuredUserData = app.isPackaged
  ? undefined
  : (process.env.CHATSPLICE_USER_DATA_DIR ?? process.env.LOCALCHAT_USER_DATA_DIR);
if (configuredUserData !== undefined && configuredUserData !== '') {
  app.setPath('userData', resolve(configuredUserData));
} else {
  const currentUserData = app.getPath('userData');
  const legacyUserData = join(dirname(currentUserData), 'LocalChat ADE');
  app.setPath('userData', resolveCompatibleUserDataPath(currentUserData, legacyUserData));
}
const hasSingleInstanceLock = app.requestSingleInstanceLock();

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'chatsplice',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      codeCache: true,
    },
  },
  {
    scheme: 'localchat',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      codeCache: true,
    },
  },
]);

let chatspliceWindow: ChatSpliceWindow | undefined;
let supervisor: DaemonSupervisor | undefined;
let credentialStore: TunnelCredentialStore | undefined;
let removeIpcHandlers: (() => void) | undefined;
let cleanupStarted = false;
let localApplyAutoDispatcher: LocalApplyAutoDispatcher | undefined;
let referenceRequestDispatcher: ReferenceRequestDispatcher | undefined;
let localMcpAutoAttachDispatcher: LocalMcpAutoAttachDispatcher | undefined;
let terminalService: TerminalService | undefined;
let editorSession: WorkbenchEditorSessionManager | undefined;
let automaticTunnelStartGeneration = 0;

function invalidateAutomaticTunnelStart(): void {
  automaticTunnelStartGeneration += 1;
}

function logAutomaticTunnelEvent(stage: 'credential_read' | 'credential_invalid' | 'start'): void {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'warn',
      event: 'desktop_automatic_tunnel_start_failed',
      stage,
    })}\n`,
  );
}

async function startAutomaticTunnel(
  expectedSupervisor: DaemonSupervisor,
  expectedCredentialStore: TunnelCredentialStore,
  expectedGeneration: number,
): Promise<void> {
  const isCurrent = (): boolean =>
    !cleanupStarted &&
    automaticTunnelStartGeneration === expectedGeneration &&
    supervisor === expectedSupervisor &&
    credentialStore === expectedCredentialStore;

  if (!isCurrent()) return;

  let credential: string | undefined;
  try {
    credential = await expectedCredentialStore.read();
  } catch {
    if (isCurrent()) logAutomaticTunnelEvent('credential_read');
    return;
  }

  if (!isCurrent()) return;
  if (credential === undefined) return;

  const validated = TunnelStartInputSchema.safeParse({ runtime_api_key: credential });
  if (!validated.success) {
    logAutomaticTunnelEvent('credential_invalid');
    return;
  }
  if (!isCurrent()) return;

  try {
    const result = await expectedSupervisor.client.startTunnel(validated.data);
    if (isCurrent() && result.state === 'failed') logAutomaticTunnelEvent('start');
  } catch {
    if (isCurrent()) logAutomaticTunnelEvent('start');
  }
}

async function start(): Promise<void> {
  if (!hasSingleInstanceLock) return;
  const applicationPath = app.getAppPath();
  if (process.platform === 'darwin') {
    app.dock?.setIcon(join(applicationPath, 'resources', 'app-icon.png'));
  }
  const userData = app.getPath('userData');
  const runDirectory = join(userData, 'run');
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  registerLocalRendererProtocol(join(applicationPath, 'dist', 'renderer'));

  const daemonDataDirectory = resolveCompatibleDaemonDataDirectory(userData);
  supervisor = new DaemonSupervisor(
    daemonDataDirectory,
    resolveCompatibleControlSocketPath(userData, daemonDataDirectory),
  );
  await supervisor.start();
  let daemonStatus = await supervisor.client.status();
  if (daemonStatus.read_only_mode) {
    await supervisor.client.setReadOnlyMode(false);
    daemonStatus = await supervisor.client.status();
  }
  terminalService = new TerminalService(supervisor.client);
  credentialStore = new TunnelCredentialStore(join(userData, 'secrets', 'tunnel-runtime-key.enc'), {
    isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptStringAsync(value),
    decrypt: async (value) => {
      const decrypted = await safeStorage.decryptStringAsync(value);
      return { value: decrypted.result, shouldReEncrypt: decrypted.shouldReEncrypt };
    },
  });
  let authorizedLocalViewIds = new Set<number>();
  const sidebarLayoutPath = join(userData, 'sidebar-layout.json');
  const windowStatePath = join(userData, 'window-state.json');
  const initialSidebarLayout = await readSidebarLayout(sidebarLayoutPath);
  const initialWindowState = await readWindowState(
    windowStatePath,
    screen.getAllDisplays().map((display) => display.workArea),
  );
  const initialTabState = await supervisor.client.getChatGptTabState().catch(() => undefined);
  const editorSessionPath = join(userData, 'editor-session.json');
  const persistedEditorSession = await readEditorSession(editorSessionPath);
  try {
    editorSession = new WorkbenchEditorSessionManager({
      ...(persistedEditorSession === undefined ? {} : { initialState: persistedEditorSession }),
      persist: (state) => writeEditorSession(editorSessionPath, state),
    });
  } catch {
    // Invalid or stale metadata must never prevent the desktop from starting.
    editorSession = new WorkbenchEditorSessionManager({
      persist: (state) => writeEditorSession(editorSessionPath, state),
    });
  }
  const automaticTunnelStartupGeneration = automaticTunnelStartGeneration;
  chatspliceWindow = await createChatSpliceWindow(
    desktopPreloadPath(applicationPath),
    initialTabState,
    async (state) => {
      await supervisor!.client.setChatGptTabState(state);
    },
    initialSidebarLayout,
    (layout) => writeSidebarLayout(sidebarLayoutPath, layout),
    initialWindowState,
    (state) => writeWindowState(windowStatePath, state),
    (localView, chatgptTabs, sidebar, localControlViews, panel) => {
      const activeWorkspaceId =
        chatgptTabs.list().tabs.find((tab) => tab.active)?.workspace_id ?? null;
      const activeEditorState = editorSession!.selectWorkspace(activeWorkspaceId);
      const editorVisible = activeEditorState.active_editor_tab_id !== null;
      chatgptTabs.setCenterSurface(editorVisible ? 'editor' : 'chatgpt');
      panel.setEditorActive(editorVisible);
      authorizedLocalViewIds = new Set([
        localView.webContents.id,
        ...localControlViews.map((view) => view.webContents.id),
      ]);
      removeIpcHandlers = installIpcHandlers(
        supervisor!,
        credentialStore!,
        promptForTunnelCredential,
        () => authorizedLocalViewIds,
        chatgptTabs,
        sidebar,
        panel,
        terminalService!,
        () => localControlViews[2]?.webContents.id,
        () => localControlViews[4]?.webContents.id,
        () => localControlViews[3]?.webContents.id,
        () => localView.webContents.id,
        editorSession!,
        invalidateAutomaticTunnelStart,
      );
      localMcpAutoAttachDispatcher = new LocalMcpAutoAttachDispatcher(
        supervisor!.client,
        chatgptTabs,
      );
      void localMcpAutoAttachDispatcher.start();
    },
  );
  if (daemonStatus.tunnel.configuration?.automatic_start === true) {
    void startAutomaticTunnel(supervisor, credentialStore, automaticTunnelStartupGeneration);
  }
  localApplyAutoDispatcher = new LocalApplyAutoDispatcher(supervisor.client);
  void localApplyAutoDispatcher.start();
  referenceRequestDispatcher = new ReferenceRequestDispatcher(
    supervisor.client,
    () => chatspliceWindow?.window,
  );
  void referenceRequestDispatcher.start();
  await configureAppUpdates();
}

let updateTimer: ReturnType<typeof setInterval> | undefined;

async function configureAppUpdates(): Promise<void> {
  let controller: AppUpdateController | undefined;
  const metadata: unknown = JSON.parse(
    await readFile(join(app.getAppPath(), 'package.json'), 'utf8'),
  );
  if (supportsAppUpdates(app.isPackaged, process.platform, metadata)) {
    const { default: electronUpdater } = await import('electron-updater');
    controller = new AppUpdateController({
      updater: electronUpdater.autoUpdater,
      stageNativeUpdate: () =>
        new Promise<void>((resolve, reject) => {
          const finish = (error?: Error): void => {
            clearTimeout(timeout);
            autoUpdater.removeListener('update-downloaded', onDownloaded);
            autoUpdater.removeListener('error', onError);
            if (error === undefined) resolve();
            else reject(error);
          };
          const onDownloaded = (): void => finish();
          const onError = (): void => finish(new Error('native_update_staging_failed'));
          const timeout = setTimeout(
            () => finish(new Error('native_update_staging_timeout')),
            10 * 60 * 1000,
          );
          autoUpdater.once('update-downloaded', onDownloaded);
          autoUpdater.once('error', onError);
          try {
            autoUpdater.checkForUpdates();
          } catch {
            onError();
          }
        }),
      choose: async (message, buttons) =>
        (
          await dialog.showMessageBox({
            type: 'info',
            title: 'ChatSplice 업데이트',
            message,
            buttons,
            defaultId: buttons.length - 1,
            cancelId: buttons.length - 1,
            noLink: true,
          })
        ).response,
      prepareToInstall: async () => {
        if (quitGuardInFlight !== undefined || cleanupStarted) return false;
        let allowed = false;
        quitGuardInFlight = (async () => {
          allowed = await confirmDirtyEditorQuit();
          if (!allowed) return;
          quitAfterEditorGuard = true;
          chatspliceWindow?.window.hide();
          // Keep windows alive until the native installer initiates shutdown.
          await cleanup(false);
        })().finally(() => {
          quitGuardInFlight = undefined;
        });
        await quitGuardInFlight;
        return allowed;
      },
    });
    void controller.check();
    updateTimer = setInterval(() => void controller?.check(), 6 * 60 * 60 * 1000);
    updateTimer.unref();
  }
  const checkUpdates = async (): Promise<void> => {
    if (controller !== undefined) return controller.check(true);
    const choice = await dialog.showMessageBox({
      type: 'info',
      title: 'ChatSplice 업데이트',
      message: '이 빌드는 수동 업데이트를 사용합니다.',
      detail: 'Release에서 새 DMG와 SHA-256을 확인하고 앱을 종료한 뒤 교체하세요.',
      buttons: ['Release 열기', '닫기'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (choice.response === 0) await shell.openExternal(RELEASES_URL);
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'ChatSplice',
        submenu: [
          { role: 'about' },
          {
            label: '업데이트 확인…',
            click: () => {
              void checkUpdates().catch(() => undefined);
            },
          },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

async function cleanup(closeWindow = true): Promise<void> {
  if (cleanupStarted) return;
  cleanupStarted = true;
  if (updateTimer !== undefined) clearInterval(updateTimer);
  invalidateAutomaticTunnelStart();
  removeIpcHandlers?.();
  await terminalService?.closeAll();
  localApplyAutoDispatcher?.stop();
  referenceRequestDispatcher?.stop();
  localMcpAutoAttachDispatcher?.stop();
  await editorSession?.flushPersistence();
  if (closeWindow) await chatspliceWindow?.close();
  await supervisor?.close();
}

async function confirmDirtyEditorQuit(): Promise<boolean> {
  const session = editorSession;
  const expectedSupervisor = supervisor;
  if (session === undefined || expectedSupervisor === undefined) return true;
  for (;;) {
    const dirty = session.listDirtyDocuments();
    if (dirty.length === 0) return true;
    const revisions = new Map(
      dirty.map((document) => [document.editor_tab_id, document.draft_revision]),
    );
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: '저장하지 않은 변경 사항',
      message:
        dirty.length === 1
          ? '저장하지 않은 변경 사항이 있습니다.'
          : `${dirty.length}개 파일에 저장하지 않은 변경 사항이 있습니다.`,
      detail: '종료하면 변경 사항이 사라질 수 있습니다.',
      buttons: ['저장', '버리기', '취소'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (result.response === 2) return false;
    if (result.response === 1) {
      const changed = session
        .listDirtyDocuments()
        .some(
          (document) =>
            revisions.get(document.editor_tab_id) !== undefined &&
            revisions.get(document.editor_tab_id) !== document.draft_revision,
        );
      if (changed) continue;
      return true;
    }
    try {
      for (const document of dirty) {
        const saved = await expectedSupervisor.client.saveWorkspaceEditorFile({
          workspace_id: document.workspace_id,
          path: document.path,
          expected_sha256: document.sha256,
          content: document.content,
        });
        session.markSaved({
          workspace_id: document.workspace_id,
          editor_tab_id: document.editor_tab_id,
          expected_revision: document.draft_revision,
          content: saved.content,
          sha256: saved.sha256,
        });
      }
    } catch {
      await dialog.showMessageBox({
        type: 'error',
        title: '저장 실패',
        message: '파일을 저장하지 못해 종료를 취소했습니다.',
        buttons: ['확인'],
        noLink: true,
      });
      return false;
    }
  }
}

let quitGuardInFlight: Promise<void> | undefined;
let quitAfterEditorGuard = false;

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = chatspliceWindow?.window;
    if (window !== undefined && !window.isDestroyed()) {
      window.show();
      window.focus();
    }
  });
  void app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      process.stderr.write(
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'error',
          event: 'desktop_start_failed',
          reason: error instanceof Error ? error.message : 'unknown',
        })}\n`,
      );
      app.quit();
    });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (cleanupStarted || quitAfterEditorGuard) return;
  event.preventDefault();
  if (quitGuardInFlight !== undefined) return;
  quitGuardInFlight = confirmDirtyEditorQuit()
    .then((allowed) => {
      if (!allowed) return;
      quitAfterEditorGuard = true;
      return cleanup().finally(() => app.quit());
    })
    .catch(() => undefined)
    .finally(() => {
      quitGuardInFlight = undefined;
    });
});
