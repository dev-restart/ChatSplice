import { join } from 'node:path';

import { BaseWindow, WebContentsView, session, shell } from 'electron';
import type { BrowserWindow, Session, WebContents } from 'electron';

import type {
  ChatGptTabState,
  PanelState,
  PanelStatePatch,
  SidebarLayout,
} from '@chatsplice/protocol';

import { ChatGptTabManager } from './chatgpt-tabs.js';
import {
  isAllowedAuthPopup,
  isAllowedChatGptNavigation,
  isSafeExternalUrl,
} from './navigation-policy.js';
import { allowsRemotePermission } from './remote-permissions.js';
import {
  clampSidebarWidth,
  clampConsoleHeight,
  clampFilesPanelWidth,
  contentTopInset,
  CONSOLE_DEFAULT_HEIGHT,
  DEFAULT_SIDEBAR_WIDTH,
  FILES_PANEL_DEFAULT_WIDTH,
  layoutBounds,
  MACOS_TITLEBAR_HEIGHT,
  workspacePanelBounds,
} from './sidebar-layout.js';
import { captureWindowState } from './window-state.js';
import type { WindowState } from './window-state.js';

// This storage key is intentionally stable so the public rename never signs
// existing users out of ChatGPT.
const CHATGPT_PARTITION = 'persist:localchat-chatgpt';

export interface ChatSpliceWindow {
  readonly window: BaseWindow;
  readonly localView: WebContentsView;
  readonly editorView: WebContentsView;
  readonly consoleView: WebContentsView;
  readonly filesView: WebContentsView;
  readonly chatgptTabs: ChatGptTabManager;
  readonly sidebar: {
    get(): SidebarLayout;
    setWidth(width: number): SidebarLayout;
    toggle(): SidebarLayout;
    setPreview(open: boolean): SidebarLayout;
    setOverlay(open: boolean): void;
  };
  readonly panel: {
    get(): PanelState;
    set(patch: PanelStatePatch): PanelState;
    syncWorkspace(workspaceId: string | null): PanelState;
    setEditorActive(active: boolean): void;
    isEditorActive(): boolean;
  };
  close(): Promise<void>;
}

function remoteWebPreferences() {
  return {
    partition: CHATGPT_PARTITION,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: true,
  } as const;
}

function installDefaultDenyPermissions(remoteSession: Session): void {
  remoteSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    allowsRemotePermission(permission, requestingOrigin),
  );
  remoteSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(allowsRemotePermission(permission, webContents.getURL()));
  });
  remoteSession.setDevicePermissionHandler(() => false);
}

function secureRemoteContents(contents: WebContents): void {
  contents.on('will-navigate', (event, navigationUrl) => {
    if (!isAllowedChatGptNavigation(navigationUrl)) {
      event.preventDefault();
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedAuthPopup(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: remoteWebPreferences(),
        },
      };
    }
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  contents.on('did-create-window', (child: BrowserWindow) => {
    child.setMenuBarVisibility(false);
    secureRemoteContents(child.webContents);
  });
}

function secureLocalContents(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, navigationUrl) => {
    if (
      !navigationUrl.startsWith('chatsplice://renderer/') &&
      !navigationUrl.startsWith('localchat://renderer/')
    ) {
      event.preventDefault();
    }
  });
}

export async function createChatSpliceWindow(
  preloadPath: string,
  initialTabState: ChatGptTabState | undefined,
  persistTabState: (state: ChatGptTabState) => Promise<void>,
  initialSidebarLayout: SidebarLayout,
  persistSidebarLayout: (layout: SidebarLayout) => Promise<void>,
  initialWindowState: WindowState,
  persistWindowState: (state: WindowState) => Promise<void>,
  beforeNavigation?: (
    localView: WebContentsView,
    chatgptTabs: ChatGptTabManager,
    sidebar: ChatSpliceWindow['sidebar'],
    localControlViews: readonly WebContentsView[],
    panel: ChatSpliceWindow['panel'],
  ) => void,
): Promise<ChatSpliceWindow> {
  const window = new BaseWindow({
    ...initialWindowState.bounds,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#f9f9f9',
    title: process.platform === 'darwin' ? '' : 'ChatSplice',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
  });
  window.setMovable(true);

  const localView = new WebContentsView({
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  const localControlView = new WebContentsView({
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  const localEdgeView = new WebContentsView({
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  const consoleView = new WebContentsView({
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  const filesView = new WebContentsView({
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  const editorView = new WebContentsView({
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  // WebContentsView backgrounds are opaque on some macOS compositor paths.
  // Match the titlebar instead of exposing a contrasting rectangle behind the toggle.
  // The primary local view expands while a modal is open so the dialog backdrop can
  // cover ChatGPT. Keep that expanded area transparent; the renderer paints only
  // the actual sidebar and leaves the ChatGPT view visible beneath the backdrop.
  localView.setBackgroundColor('#00000000');
  localControlView.setBackgroundColor('#f9f9f9');
  localEdgeView.setBackgroundColor('#f9f9f9');
  consoleView.setBackgroundColor('#111827');
  filesView.setBackgroundColor('#f9f9f9');
  editorView.setBackgroundColor('#f9f9f9');
  const remoteSession = session.fromPartition(CHATGPT_PARTITION, { cache: true });
  installDefaultDenyPermissions(remoteSession);

  secureLocalContents(localView.webContents);
  secureLocalContents(localControlView.webContents);
  secureLocalContents(localEdgeView.webContents);
  secureLocalContents(consoleView.webContents);
  secureLocalContents(filesView.webContents);
  secureLocalContents(editorView.webContents);

  const chatgptTabs = await ChatGptTabManager.create({
    window,
    initialState: initialTabState,
    createView: () => {
      const view = new WebContentsView({ webPreferences: remoteWebPreferences() });
      secureRemoteContents(view.webContents);
      return view;
    },
    persist: persistTabState,
  });
  // Keep remote views behind the app-owned surfaces. Normal project, tab and
  // layout changes update geometry and visibility without rebuilding the stack.
  const attachInitialNativeViewOrder = (): void => {
    window.contentView.addChildView(localView, chatgptTabs.list().tabs.length);
    window.contentView.addChildView(editorView);
    window.contentView.addChildView(filesView);
    window.contentView.addChildView(consoleView);
    window.contentView.addChildView(localControlView);
    window.contentView.addChildView(localEdgeView);
  };
  const restoreNormalNativeViewOrder = (): void => {
    window.contentView.addChildView(localView, chatgptTabs.list().tabs.length);
  };
  attachInitialNativeViewOrder();
  let sidebarLayout: SidebarLayout = {
    width: clampSidebarWidth(initialSidebarLayout.width || DEFAULT_SIDEBAR_WIDTH, 1440),
    collapsed: initialSidebarLayout.collapsed,
  };
  let sidebarPreviewOpen = false;
  let modalOverlayOpen = false;
  let nativeViewOrder: 'normal' | 'preview' | 'modal' = 'normal';
  let panelState: PanelState = {
    workspace_id: chatgptTabs.list().tabs.find((tab) => tab.active)?.workspace_id ?? null,
    console_open: false,
    files_open: false,
    files_width: initialWindowState.panel_sizes?.files_width ?? FILES_PANEL_DEFAULT_WIDTH,
    console_height: initialWindowState.panel_sizes?.console_height ?? CONSOLE_DEFAULT_HEIGHT,
  };
  let editorActive = false;
  let persistSidebarLayoutPromise: Promise<void> = Promise.resolve();
  let persistWindowStatePromise: Promise<void> = Promise.resolve();
  let windowStateTimer: NodeJS.Timeout | undefined;
  const persistSidebar = (): void => {
    persistSidebarLayoutPromise = persistSidebarLayoutPromise
      .catch(() => undefined)
      .then(() => persistSidebarLayout(sidebarLayout));
  };
  const persistCapturedWindowState = (): void => {
    if (window.isDestroyed()) return;
    const captured = captureWindowState(window);
    const state: WindowState = {
      ...captured,
      panel_sizes: {
        files_width: panelState.files_width,
        console_height: panelState.console_height,
      },
    };
    persistWindowStatePromise = persistWindowStatePromise
      .catch(() => undefined)
      .then(() => persistWindowState(state));
  };
  const scheduleWindowStatePersist = (): void => {
    if (windowStateTimer !== undefined) clearTimeout(windowStateTimer);
    windowStateTimer = setTimeout(() => {
      windowStateTimer = undefined;
      persistCapturedWindowState();
    }, 300);
    windowStateTimer.unref();
  };
  const layout = (): void => {
    const size = window.getContentSize();
    const width = size[0] ?? 1440;
    const height = size[1] ?? 900;
    const clampedWidth = clampSidebarWidth(sidebarLayout.width, width);
    if (clampedWidth !== sidebarLayout.width) {
      sidebarLayout = { ...sidebarLayout, width: clampedWidth };
      persistSidebar();
    }
    const bounds = layoutBounds(width, sidebarLayout, sidebarPreviewOpen);
    const topInset = contentTopInset(process.platform === 'darwin');
    const panelBounds = workspacePanelBounds(
      width,
      Math.max(0, height - topInset),
      sidebarLayout,
      panelState,
      sidebarPreviewOpen,
    );
    const desiredNativeViewOrder = modalOverlayOpen
      ? 'modal'
      : sidebarPreviewOpen
        ? 'preview'
        : 'normal';
    if (desiredNativeViewOrder !== nativeViewOrder) {
      // Only real overlay/preview transitions need a native stack change.
      // Project, editor-tab, panel and resize changes keep their WebContents
      // views attached so macOS can retain each renderer's live viewport.
      if (desiredNativeViewOrder === 'normal') {
        restoreNormalNativeViewOrder();
      } else {
        // The overlay/preview surface is deliberately re-added last so it
        // covers every app-owned and ChatGPT WebContentsView.
        window.contentView.addChildView(localView);
      }
      nativeViewOrder = desiredNativeViewOrder;
    }
    // A hidden WebContentsView can retain the viewport it had at load time.
    // Make a panel visible before setting its new bounds so Chromium receives
    // the resize while the view belongs to a live widget.
    consoleView.setVisible(panelState.console_open && panelState.workspace_id !== null);
    filesView.setVisible(panelState.files_open && panelState.workspace_id !== null);
    editorView.setVisible(true);
    // A modal dialog rendered inside localView must dim and cover the whole
    // window (including the ChatGPT view), not just the sidebar's own
    // narrow viewport, so its ::backdrop spans the full window while open.
    const localWidth = modalOverlayOpen ? width : bounds.localWidth;
    localView.setBounds({
      x: 0,
      y: topInset,
      width: localWidth,
      height: Math.max(0, height - topInset),
    });
    const editorStripHeight = 36;
    chatgptTabs.setBounds({
      x: panelBounds.chatgptX,
      y: topInset + panelBounds.chatgptY + (editorActive ? 0 : editorStripHeight),
      width: panelBounds.chatgptWidth,
      height: editorActive ? 0 : Math.max(0, panelBounds.chatgptHeight - editorStripHeight),
    });
    editorView.setBounds({
      x: panelBounds.chatgptX,
      y: topInset + panelBounds.chatgptY,
      width: panelBounds.chatgptWidth,
      height: editorActive ? panelBounds.chatgptHeight : editorStripHeight,
    });
    consoleView.setBounds({
      x: panelBounds.consoleX,
      y: topInset + panelBounds.consoleY,
      width: panelBounds.consoleWidth,
      height: panelBounds.consoleHeight,
    });
    filesView.setBounds({
      x: panelBounds.filesX,
      y: topInset + panelBounds.filesY,
      width: panelBounds.filesWidth,
      height: panelBounds.filesHeight,
    });
    // With a hidden inset titlebar there is no native drag region, so the
    // chrome surface spans the full top strip and exposes -webkit-app-region:
    // drag. Native traffic lights float above WebContentsViews on macOS, so
    // they stay visible and clickable; the toggle is marked no-drag in CSS.
    if (process.platform === 'darwin') {
      localControlView.setBounds({
        x: 0,
        y: 0,
        width,
        height: MACOS_TITLEBAR_HEIGHT,
      });
    } else {
      localControlView.setBounds({ x: 68, y: 0, width: 56, height: 36 });
    }
    localEdgeView.setBounds({ x: 0, y: 0, width: 8, height });
  };
  const sidebar = {
    get: (): SidebarLayout => sidebarLayout,
    setWidth: (width: number): SidebarLayout => {
      const contentWidth = window.getContentSize()[0] ?? 1440;
      sidebarLayout = { ...sidebarLayout, width: clampSidebarWidth(width, contentWidth) };
      persistSidebar();
      layout();
      return sidebarLayout;
    },
    toggle: (): SidebarLayout => {
      sidebarLayout = { ...sidebarLayout, collapsed: !sidebarLayout.collapsed };
      sidebarPreviewOpen = false;
      persistSidebar();
      layout();
      return sidebarLayout;
    },
    setPreview: (open: boolean): SidebarLayout => {
      sidebarPreviewOpen = open && sidebarLayout.collapsed;
      layout();
      return sidebarLayout;
    },
    setOverlay: (open: boolean): void => {
      modalOverlayOpen = open;
      layout();
    },
  };
  const panel = {
    get: (): PanelState => panelState,
    set: (patch: PanelStatePatch): PanelState => {
      const [contentWidth, contentHeight] = window.getContentSize();
      const base = layoutBounds(contentWidth ?? 1440, sidebarLayout, sidebarPreviewOpen);
      const availableWidth = Math.max(0, (contentWidth ?? 1440) - base.chatgptX);
      const availableHeight = Math.max(
        0,
        (contentHeight ?? 900) - contentTopInset(process.platform === 'darwin'),
      );
      const filesWidth =
        patch.files_width === undefined
          ? panelState.files_width
          : clampFilesPanelWidth(patch.files_width, availableWidth);
      const consoleHeight =
        patch.console_height === undefined
          ? panelState.console_height
          : clampConsoleHeight(patch.console_height, availableHeight);
      panelState = {
        workspace_id:
          patch.workspace_id === undefined ? panelState.workspace_id : patch.workspace_id,
        console_open:
          patch.console_open === undefined ? panelState.console_open : patch.console_open,
        files_open: patch.files_open === undefined ? panelState.files_open : patch.files_open,
        files_width: filesWidth,
        console_height: consoleHeight,
      };
      if (patch.files_width !== undefined || patch.console_height !== undefined) {
        scheduleWindowStatePersist();
      }
      layout();
      return panelState;
    },
    syncWorkspace: (workspaceId: string | null): PanelState => {
      panelState = { ...panelState, workspace_id: workspaceId };
      layout();
      return panelState;
    },
    setEditorActive: (active: boolean): void => {
      if (editorActive === active) return;
      editorActive = active;
      layout();
    },
    isEditorActive: (): boolean => editorActive,
  };
  beforeNavigation?.(
    localView,
    chatgptTabs,
    sidebar,
    [localControlView, localEdgeView, consoleView, filesView, editorView],
    panel,
  );
  window.on('resize', () => {
    layout();
    scheduleWindowStatePersist();
  });
  window.on('move', scheduleWindowStatePersist);
  window.on('maximize', scheduleWindowStatePersist);
  window.on('unmaximize', scheduleWindowStatePersist);
  window.on('enter-full-screen', scheduleWindowStatePersist);
  window.on('leave-full-screen', scheduleWindowStatePersist);
  window.on('close', persistCapturedWindowState);
  layout();

  await localView.webContents.loadURL('chatsplice://renderer/');
  await localControlView.webContents.loadURL('chatsplice://renderer/?surface=chrome');
  await localEdgeView.webContents.loadURL('chatsplice://renderer/?surface=edge');
  await consoleView.webContents.loadURL('chatsplice://renderer/?surface=console');
  await filesView.webContents.loadURL('chatsplice://renderer/?surface=files');
  await editorView.webContents.loadURL('chatsplice://renderer/?surface=editor');
  window.show();
  if (initialWindowState.fullscreen) window.setFullScreen(true);
  else if (initialWindowState.maximized) window.maximize();
  // The first layout runs before the native compositor has a visible widget.
  // Reapply bounds once the window is shown so WebContentsView renderers paint
  // their initial viewport without requiring a manual resize.
  setImmediate(() => {
    if (!window.isDestroyed()) layout();
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (windowStateTimer !== undefined) {
      clearTimeout(windowStateTimer);
      windowStateTimer = undefined;
    }
    persistCapturedWindowState();
    await persistWindowStatePromise.catch(() => undefined);
    if (!localView.webContents.isDestroyed()) {
      localView.webContents.close();
    }
    if (!localControlView.webContents.isDestroyed()) localControlView.webContents.close();
    if (!localEdgeView.webContents.isDestroyed()) localEdgeView.webContents.close();
    if (!consoleView.webContents.isDestroyed()) consoleView.webContents.close();
    if (!filesView.webContents.isDestroyed()) filesView.webContents.close();
    if (!editorView.webContents.isDestroyed()) editorView.webContents.close();
    await chatgptTabs.close();
    if (!window.isDestroyed()) {
      window.destroy();
    }
  };
  window.on('closed', () => void close());
  return {
    window,
    localView,
    editorView,
    consoleView,
    filesView,
    chatgptTabs,
    sidebar,
    panel,
    close,
  };
}

export function desktopPreloadPath(appPath: string): string {
  return join(appPath, 'dist', 'preload', 'index.cjs');
}
