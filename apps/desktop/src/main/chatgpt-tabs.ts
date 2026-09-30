import { createHash, randomBytes } from 'node:crypto';

import type { BaseWindow, Rectangle, WebContentsView } from 'electron';

import {
  AutomateChatGptProjectInputSchema,
  AutomateChatGptProjectResultSchema,
  ChatGptTabListResultSchema,
  ChatGptTabStateSchema,
  CreateChatGptTabInputSchema,
  DEFAULT_MCP_APP_NAME,
  UpdateChatGptTabInputSchema,
} from '@chatsplice/protocol';
import type {
  AutomateChatGptProjectResult,
  ChatGptProjectAutomationResult,
  ChatGptTabListResult,
  ChatGptTabRecord,
  ChatGptTabState,
  CreateChatGptTabInput,
  UpdateChatGptTabInput,
} from '@chatsplice/protocol';

import {
  buildChatGptProjectAutomationScript,
  buildChatGptProjectCreateClickScript,
  buildChatGptProjectCreateModalProbeScript,
  buildChatGptProjectInstructionsUpdateScript,
  parseChatGptProjectAutomationResult,
} from './chatgpt-project-automation.js';
import { buildLocalMcpAutoAttachScript } from './local-mcp-auto-attach.js';
import { isRestorableChatGptUrl } from './navigation-policy.js';

const CHATGPT_HOME = 'https://chatgpt.com/';
const DEFAULT_GENERAL_CHAT_LABEL = 'General ChatGPT chat';
const PROJECT_LAUNCHER_SUFFIX = ' · ChatGPT Project';

function projectLauncherLabel(workspaceName: string): string {
  return `${workspaceName.slice(0, 60)}${PROJECT_LAUNCHER_SUFFIX}`;
}

interface ChatGptProjectSetupInput {
  readonly workspace_id: string;
  readonly workspace_name: string;
  readonly binding_text: string;
  readonly automatic?: boolean;
}

interface ChatGptTabEntry {
  record: ChatGptTabRecord;
  readonly view: WebContentsView;
  loaded: boolean;
  loading: Promise<void> | undefined;
}

interface ChatGptTabManagerOptions {
  readonly window: BaseWindow;
  readonly initialState: ChatGptTabState | undefined;
  readonly createView: () => WebContentsView;
  readonly persist: (state: ChatGptTabState) => Promise<void>;
}

export type ChatGptCenterSurface = 'chatgpt' | 'editor';

export interface LocalMcpAutoAttachContext {
  readonly chatgpt_tab_id: string;
  readonly workspace_id: string;
  readonly url: string;
}

function newTabId(): string {
  return `tab_${randomBytes(12).toString('hex')}`;
}

function newRecord(input: CreateChatGptTabInput): ChatGptTabRecord {
  const timestamp = new Date().toISOString();
  return {
    chatgpt_tab_id: newTabId(),
    workspace_id: input.workspace_id,
    project_instructions_confirmed: false,
    label: input.label ?? DEFAULT_GENERAL_CHAT_LABEL,
    url: CHATGPT_HOME,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export class ChatGptTabManager {
  readonly #window: BaseWindow;
  readonly #createView: () => WebContentsView;
  readonly #persistState: (state: ChatGptTabState) => Promise<void>;
  readonly #entries = new Map<string, ChatGptTabEntry>();
  readonly #lastTabByWorkspace = new Map<string | null, string>();
  #activeTabId: string;
  #centerSurface: ChatGptCenterSurface = 'chatgpt';
  #bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  #persistQueue: Promise<void> = Promise.resolve();
  #closed = false;
  #instructionAutomationTabId: string | undefined;
  #instructionAutomationAutomatic = false;
  #instructionUiPaused = false;
  readonly #instructionVersions = new Map<string, string>();
  readonly #instructionRetryAt = new Map<string, number>();

  private constructor(options: ChatGptTabManagerOptions) {
    this.#window = options.window;
    this.#createView = options.createView;
    this.#persistState = options.persist;

    const initialState =
      options.initialState ??
      (() => {
        const record = newRecord({ workspace_id: null });
        return { tabs: [record], active_tab_id: record.chatgpt_tab_id };
      })();
    const validated = ChatGptTabStateSchema.parse(initialState);
    for (const record of validated.tabs) {
      this.#addEntry({
        ...record,
        url: isRestorableChatGptUrl(record.url) ? record.url : CHATGPT_HOME,
      });
    }
    this.#activeTabId = validated.active_tab_id;
    this.#rememberTabForWorkspace(this.#activeTabId);
    this.#applyVisibility();
  }

  public static async create(options: ChatGptTabManagerOptions): Promise<ChatGptTabManager> {
    const manager = new ChatGptTabManager(options);
    const active = manager.#entry(manager.#activeTabId);
    void manager.#loadEntry(active).then(() => manager.#focusWhenCurrent(active));
    await manager.#queuePersist();
    return manager;
  }

  public list(): ChatGptTabListResult {
    return ChatGptTabListResultSchema.parse({
      tabs: [...this.#entries.values()].map(({ record }) => ({
        chatgpt_tab_id: record.chatgpt_tab_id,
        workspace_id: record.workspace_id,
        project_instructions_confirmed: record.project_instructions_confirmed,
        label: record.label,
        active: record.chatgpt_tab_id === this.#activeTabId,
      })),
      active_tab_id: this.#activeTabId,
    });
  }

  public async createTab(input: CreateChatGptTabInput): Promise<ChatGptTabListResult> {
    const validated = CreateChatGptTabInputSchema.parse(input);
    this.#rememberActiveTab();
    const record = newRecord(validated);
    const entry = this.#addEntry(record);
    this.#activeTabId = record.chatgpt_tab_id;
    this.#rememberActiveTab();
    this.#centerSurface = 'chatgpt';
    this.#applyVisibility();
    void this.#loadEntry(entry).then(() => this.#focusWhenCurrent(entry));
    await this.#queuePersist();
    return this.list();
  }

  public async activateTab(chatGptTabId: string): Promise<ChatGptTabListResult> {
    const entry = this.#entry(chatGptTabId);
    this.#rememberActiveTab();
    this.#activeTabId = entry.record.chatgpt_tab_id;
    entry.record.updated_at = new Date().toISOString();
    this.#rememberActiveTab();
    this.#centerSurface = 'chatgpt';
    this.#applyVisibility();
    void this.#loadEntry(entry).then(() => this.#focusWhenCurrent(entry));
    await this.#queuePersist();
    return this.list();
  }

  /**
   * Activates the most recently selected ChatGPT tab for a local workspace.
   *
   * The map is intentionally session-only. The durable ChatGPT tab state
   * remains the browser navigation record and does not grow a second active
   * selection protocol field. A workspace without an associated tab keeps the
   * current browser tab so setup flows can create one explicitly.
   */
  public async activateWorkspace(
    workspaceId: string | null,
  ): Promise<ChatGptTabListResult | undefined> {
    const tabId = this.#tabIdForWorkspace(workspaceId);
    if (tabId === undefined) return undefined;
    return this.activateTab(tabId);
  }

  /** Returns the session's last tab for a workspace, if it still exists. */
  public lastTabForWorkspace(workspaceId: string | null): string | undefined {
    return this.#tabIdForWorkspace(workspaceId);
  }

  /**
   * Selects which center surface owns the visible center body. The remote
   * WebContentsView stays loaded while the editor is active so ChatGPT state
   * and scroll position remain intact, but it is hidden and cannot receive
   * automatic Local MCP attachment work in that state.
   */
  public setCenterSurface(surface: ChatGptCenterSurface): void {
    this.#centerSurface = surface;
    this.#applyVisibility();
  }

  public async updateTab(input: UpdateChatGptTabInput): Promise<ChatGptTabListResult> {
    const validated = UpdateChatGptTabInputSchema.parse(input);
    const entry = this.#entry(validated.chatgpt_tab_id);
    const previousWorkspaceId = entry.record.workspace_id;
    if (validated.workspace_id !== undefined) {
      if (validated.workspace_id !== entry.record.workspace_id) {
        entry.record.project_instructions_confirmed = false;
      }
      entry.record.workspace_id = validated.workspace_id;
    }
    if (validated.project_instructions_confirmed !== undefined) {
      if (validated.project_instructions_confirmed && entry.record.workspace_id === null) {
        throw new Error('A ChatGPT Project confirmation requires a local workspace association.');
      }
      entry.record.project_instructions_confirmed = validated.project_instructions_confirmed;
    }
    if (validated.label !== undefined) {
      entry.record.label = validated.label;
    }
    entry.record.updated_at = new Date().toISOString();
    if (previousWorkspaceId !== entry.record.workspace_id) {
      if (this.#lastTabByWorkspace.get(previousWorkspaceId) === entry.record.chatgpt_tab_id) {
        this.#lastTabByWorkspace.delete(previousWorkspaceId);
      }
      this.#rememberTabForWorkspace(entry.record.chatgpt_tab_id);
    }
    await this.#queuePersist();
    return this.list();
  }

  public async closeTab(chatGptTabId: string): Promise<ChatGptTabListResult> {
    const entry = this.#entry(chatGptTabId);
    this.#rememberActiveTab();
    const order = [...this.#entries.keys()];
    const closedIndex = order.indexOf(chatGptTabId);
    this.#entries.delete(chatGptTabId);
    this.#instructionVersions.delete(chatGptTabId);
    this.#instructionRetryAt.delete(chatGptTabId);
    for (const [workspaceId, tabId] of this.#lastTabByWorkspace) {
      if (tabId === chatGptTabId) this.#lastTabByWorkspace.delete(workspaceId);
    }
    this.#window.contentView.removeChildView(entry.view);
    entry.view.webContents.close();

    if (this.#entries.size === 0) {
      const replacement = newRecord({ workspace_id: null });
      const replacementEntry = this.#addEntry(replacement);
      this.#activeTabId = replacement.chatgpt_tab_id;
      this.#rememberActiveTab();
      void this.#loadEntry(replacementEntry).then(() => this.#focusWhenCurrent(replacementEntry));
    } else if (this.#activeTabId === chatGptTabId) {
      const nextOrder = [...this.#entries.keys()];
      this.#activeTabId = nextOrder[Math.min(closedIndex, nextOrder.length - 1)] ?? nextOrder[0]!;
      this.#rememberActiveTab();
    }

    this.#applyVisibility();
    const activeEntry = this.#entries.get(this.#activeTabId);
    if (activeEntry !== undefined) this.#focusWhenCurrent(activeEntry);
    await this.#queuePersist();
    return this.list();
  }

  /**
   * Detaches ChatSplice-only metadata from browser tabs when a workspace is
   * removed. It never closes or alters the actual remote ChatGPT Project.
   */
  public async detachWorkspace(workspaceId: string): Promise<ChatGptTabListResult> {
    for (const entry of this.#entries.values()) {
      if (entry.record.workspace_id !== workspaceId) continue;
      if (this.#lastTabByWorkspace.get(workspaceId) === entry.record.chatgpt_tab_id) {
        this.#lastTabByWorkspace.delete(workspaceId);
      }
      entry.record.workspace_id = null;
      entry.record.project_instructions_confirmed = false;
      if (entry.record.label.endsWith(PROJECT_LAUNCHER_SUFFIX)) {
        entry.record.label = DEFAULT_GENERAL_CHAT_LABEL;
      }
      entry.record.updated_at = new Date().toISOString();
      this.#rememberTabForWorkspace(entry.record.chatgpt_tab_id);
    }
    await this.#queuePersist();
    return this.list();
  }

  /**
   * The only remote-page automation available in the desktop app. Callers can
   * identify a workspace but cannot provide a URL or arbitrary JavaScript.
   */
  public async automateProjectSetup(
    input: ChatGptProjectSetupInput,
  ): Promise<AutomateChatGptProjectResult> {
    if (this.#instructionAutomationTabId !== undefined) return this.#deferredInstructions();
    const entry = this.#projectLauncherEntry(input.workspace_id, input.workspace_name);
    this.#instructionAutomationTabId = entry.record.chatgpt_tab_id;
    try {
      const result = await this.#createProject(input);
      if (result.automation.status === 'completed') {
        this.#instructionVersions.set(
          entry.record.chatgpt_tab_id,
          this.#instructionVersion(input.binding_text),
        );
      }
      return result;
    } finally {
      this.#instructionAutomationTabId = undefined;
      this.#instructionAutomationAutomatic = false;
    }
  }

  async #createProject(input: ChatGptProjectSetupInput): Promise<AutomateChatGptProjectResult> {
    const validated = AutomateChatGptProjectInputSchema.parse({ workspace_id: input.workspace_id });
    const automation = buildChatGptProjectAutomationScript({
      workspaceId: validated.workspace_id,
      workspaceName: input.workspace_name,
      bindingText: input.binding_text,
    });
    const entry = this.#projectLauncherEntry(validated.workspace_id, input.workspace_name);
    this.#rememberActiveTab();
    this.#activeTabId = entry.record.chatgpt_tab_id;
    this.#rememberActiveTab();
    this.#centerSurface = 'chatgpt';
    this.#applyVisibility();
    await this.#loadUrl(entry, automation.url);
    entry.view.webContents.focus();

    if (!entry.loaded) {
      entry.record.updated_at = new Date().toISOString();
      await this.#queuePersist();
      return AutomateChatGptProjectResultSchema.parse({
        automation: {
          status: 'needs_user',
          reason: 'project_setup_failed',
          message: 'ChatGPT Projects 화면을 불러오지 못했습니다.',
        },
        tabs: this.list(),
      });
    }

    let result: ChatGptProjectAutomationResult;
    try {
      this.#window.focus();
      entry.view.webContents.focus();
      await entry.view.webContents.executeJavaScript(
        'window.__chatspliceProjectInstructionsCancelled = false',
      );
      const opened = await this.#openProjectCreateModal(entry);
      if (opened === 'button_not_found') {
        result = {
          status: 'needs_user' as const,
          reason: 'chatgpt_ui_changed' as const,
          message: 'ChatGPT의 새 Project 버튼을 찾지 못했습니다. ChatGPT UI를 확인하세요.',
        };
      } else if (opened === 'modal_not_opened') {
        result = {
          status: 'needs_user' as const,
          reason: 'create_modal_not_opened' as const,
          message:
            'ChatGPT의 새 Project 만들기 창이 열리지 않았습니다. 오른쪽 ChatGPT 화면에서 새 프로젝트를 직접 눌러주세요.',
        };
      } else if (
        this.#closed ||
        this.#centerSurface !== 'chatgpt' ||
        this.#activeTabId !== entry.record.chatgpt_tab_id
      ) {
        return this.#deferredInstructions();
      } else {
        const rawResult = await entry.view.webContents.executeJavaScript(automation.source, true);
        result = parseChatGptProjectAutomationResult(rawResult);
      }
    } catch {
      result = {
        status: 'needs_user' as const,
        reason: 'project_setup_failed' as const,
        message: 'ChatGPT Project 자동 설정을 완료하지 못했습니다.',
      };
    }
    if (result.status === 'completed') {
      entry.record.project_instructions_confirmed = true;
    }
    entry.record.updated_at = new Date().toISOString();
    await this.#queuePersist();
    return AutomateChatGptProjectResultSchema.parse({ automation: result, tabs: this.list() });
  }

  /**
   * Clicking once isn't always enough — ChatGPT's layout can still be
   * settling right after navigation, so a click can land before the control
   * is interactive. Re-locate and re-click a few times, checking after each
   * attempt whether the modal's name field actually appeared, before giving up.
   */
  async #openProjectCreateModal(
    entry: ChatGptTabEntry,
  ): Promise<'opened' | 'modal_not_opened' | 'button_not_found'> {
    const attempts = 3;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const clicked = await entry.view.webContents.executeJavaScript(
        buildChatGptProjectCreateClickScript(),
        true,
      );
      if (clicked === 'not_found') return 'button_not_found';

      const opened = await entry.view.webContents.executeJavaScript(
        buildChatGptProjectCreateModalProbeScript(1_500),
        true,
      );
      if (opened === true) return 'opened';
    }
    return 'modal_not_opened';
  }

  /**
   * Refreshes instructions on a Project this workspace is already bound to,
   * using the tab's own retained ChatGPT view — never a
   * caller-supplied one — and writing only between the ChatSplice markers.
   */
  public setProjectInstructionsPaused(paused: boolean): void {
    this.#instructionUiPaused = paused;
    this.#applyVisibility();
  }

  #instructionVersion(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  #deferredInstructions(): AutomateChatGptProjectResult {
    return AutomateChatGptProjectResultSchema.parse({
      automation: {
        status: 'needs_user',
        reason: 'automation_deferred',
        message: '현재 작업이 끝나면 지침을 갱신합니다.',
      },
      tabs: this.list(),
    });
  }

  public async automateProjectInstructionsUpdate(
    input: ChatGptProjectSetupInput,
  ): Promise<AutomateChatGptProjectResult> {
    if (this.#closed || this.#instructionAutomationTabId !== undefined)
      return this.#deferredInstructions();
    const active = this.#entries.get(this.#activeTabId);
    if (
      input.automatic &&
      (this.#centerSurface !== 'chatgpt' ||
        this.#instructionUiPaused ||
        active === undefined ||
        active.record.workspace_id !== input.workspace_id ||
        !active.record.project_instructions_confirmed ||
        !active.loaded ||
        active.view.webContents.isDestroyed() ||
        active.view.webContents.isLoadingMainFrame())
    ) {
      return this.#deferredInstructions();
    }
    const entry = input.automatic
      ? active!
      : this.#projectLauncherEntry(input.workspace_id, input.workspace_name);
    const key = entry.record.chatgpt_tab_id;
    const version = this.#instructionVersion(input.binding_text);
    if (input.automatic && this.#instructionVersions.get(key) === version) {
      return {
        automation: {
          status: 'completed',
          reason: 'instructions_current',
          message: '지침이 최신 상태입니다.',
        },
        tabs: this.list(),
      };
    }
    if (input.automatic && (this.#instructionRetryAt.get(key) ?? 0) > Date.now())
      return this.#deferredInstructions();
    this.#instructionAutomationTabId = key;
    this.#instructionAutomationAutomatic = input.automatic === true;
    try {
      const result = await this.#updateProjectInstructions(input);
      if (result.automation.status === 'completed') {
        this.#instructionVersions.set(key, version);
        this.#instructionRetryAt.delete(key);
      } else if (result.automation.reason !== 'automation_deferred') {
        this.#instructionRetryAt.set(key, Date.now() + 60_000);
      }
      return result;
    } finally {
      this.#instructionAutomationTabId = undefined;
      this.#instructionAutomationAutomatic = false;
    }
  }

  async #updateProjectInstructions(
    input: ChatGptProjectSetupInput,
  ): Promise<AutomateChatGptProjectResult> {
    const validated = AutomateChatGptProjectInputSchema.parse({ workspace_id: input.workspace_id });
    const entry = this.#projectLauncherEntry(validated.workspace_id, input.workspace_name);
    const targetUrl = entry.record.url;
    if (!isRestorableChatGptUrl(targetUrl) || targetUrl === CHATGPT_HOME) {
      return AutomateChatGptProjectResultSchema.parse({
        automation: {
          status: 'needs_user',
          reason: 'chatgpt_ui_changed',
          message: '연결된 ChatGPT Project 주소를 아직 확인하지 못했습니다.',
        },
        tabs: this.list(),
      });
    }

    this.#activeTabId = entry.record.chatgpt_tab_id;
    this.#rememberActiveTab();
    this.#centerSurface = 'chatgpt';
    this.#applyVisibility();
    await this.#loadEntry(entry);
    if (!input.automatic) entry.view.webContents.focus();

    if (!entry.loaded) {
      entry.record.updated_at = new Date().toISOString();
      await this.#queuePersist();
      return AutomateChatGptProjectResultSchema.parse({
        automation: {
          status: 'needs_user',
          reason: 'chatgpt_ui_changed',
          message: 'ChatGPT Project 화면을 불러오지 못했습니다.',
        },
        tabs: this.list(),
      });
    }

    const automation = buildChatGptProjectInstructionsUpdateScript({
      workspaceId: validated.workspace_id,
      workspaceName: input.workspace_name,
      bindingText: input.binding_text,
      automatic: input.automatic === true,
    });
    let result: ChatGptProjectAutomationResult;
    try {
      if (!input.automatic) {
        this.#window.focus();
        entry.view.webContents.focus();
      }
      if (
        this.#closed ||
        this.#centerSurface !== 'chatgpt' ||
        this.#activeTabId !== entry.record.chatgpt_tab_id
      )
        return this.#deferredInstructions();
      await entry.view.webContents.executeJavaScript(
        'window.__chatspliceProjectInstructionsCancelled = false',
      );
      if (
        this.#closed ||
        this.#centerSurface !== 'chatgpt' ||
        this.#activeTabId !== entry.record.chatgpt_tab_id
      )
        return this.#deferredInstructions();
      const rawResult = await entry.view.webContents.executeJavaScript(automation.source, true);
      if (
        this.#closed ||
        this.#centerSurface !== 'chatgpt' ||
        this.#activeTabId !== entry.record.chatgpt_tab_id ||
        (input.automatic && this.#instructionUiPaused)
      )
        return this.#deferredInstructions();
      result = parseChatGptProjectAutomationResult(rawResult);
    } catch {
      result = {
        status: 'needs_user' as const,
        reason: 'chatgpt_ui_changed' as const,
        message: 'Project instructions 자동 갱신을 완료하지 못했습니다.',
      };
    }
    if (result.status === 'completed') {
      entry.record.project_instructions_confirmed = true;
    }
    entry.record.updated_at = new Date().toISOString();
    await this.#queuePersist();
    return AutomateChatGptProjectResultSchema.parse({ automation: result, tabs: this.list() });
  }

  /**
   * Best-effort, owner-opted-in convenience for the active tab only: re-picks
   * "Local MCP" in that project's composer so the owner does not have to do
   * it by hand on every message. Silently does nothing for a tab with no
   * workspace, a tab not in `enabledWorkspaceIds`, or a tab that has not
   * finished loading — never throws, never blocks sending a message.
   */
  public getLocalMcpAutoAttachContext(): LocalMcpAutoAttachContext | undefined {
    if (this.#closed) return undefined;
    if (this.#centerSurface !== 'chatgpt') return undefined;
    const entry = this.#entries.get(this.#activeTabId);
    if (entry === undefined || entry.record.workspace_id === null) return undefined;
    if (entry.view.webContents.isDestroyed()) return undefined;
    return {
      chatgpt_tab_id: entry.record.chatgpt_tab_id,
      workspace_id: entry.record.workspace_id,
      url: entry.view.webContents.getURL(),
    };
  }

  public async runLocalMcpAutoAttach(
    enabledWorkspaceIds: ReadonlySet<string>,
    appName: string = DEFAULT_MCP_APP_NAME,
  ): Promise<string> {
    if (this.#closed) return 'skipped';
    if (this.#centerSurface !== 'chatgpt' || this.#instructionAutomationTabId !== undefined)
      return 'skipped';
    const activeTabId = this.#activeTabId;
    const entry = this.#entries.get(activeTabId);
    if (entry === undefined || entry.record.workspace_id === null) return 'skipped';
    if (!enabledWorkspaceIds.has(entry.record.workspace_id)) return 'skipped';
    if (!entry.loaded || entry.view.webContents.isDestroyed()) return 'skipped';
    if (entry.view.webContents.isLoadingMainFrame()) return 'busy';
    const workspaceId = entry.record.workspace_id;
    const url = entry.view.webContents.getURL();
    const contextIsCurrent = (): boolean =>
      !this.#closed &&
      this.#centerSurface === 'chatgpt' &&
      this.#activeTabId === activeTabId &&
      entry.record.workspace_id === workspaceId &&
      !entry.view.webContents.isDestroyed() &&
      !entry.view.webContents.isLoadingMainFrame() &&
      entry.view.webContents.getURL() === url;
    try {
      const raw = await entry.view.webContents.executeJavaScript(
        buildLocalMcpAutoAttachScript(appName),
        true,
      );
      if (!contextIsCurrent()) return 'context_changed';
      return typeof raw === 'string' ? raw : 'unknown_result';
    } catch {
      return 'script_failed';
    }
  }

  public setBounds(bounds: Rectangle): void {
    this.#bounds = bounds;
    for (const entry of this.#entries.values()) {
      entry.view.setBounds(bounds);
    }
  }

  public bringActiveToFront(): void {
    const active = this.#entries.get(this.#activeTabId);
    if (active !== undefined) this.#window.contentView.addChildView(active.view);
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#persistQueue.catch(() => undefined);
    for (const entry of this.#entries.values()) {
      if (!entry.view.webContents.isDestroyed()) {
        entry.view.webContents.close();
      }
    }
    this.#entries.clear();
  }

  #addEntry(record: ChatGptTabRecord): ChatGptTabEntry {
    const view = this.#createView();
    const entry: ChatGptTabEntry = { record, view, loaded: false, loading: undefined };
    this.#entries.set(record.chatgpt_tab_id, entry);
    this.#window.contentView.addChildView(view, 0);
    view.setBounds(this.#bounds);
    view.setVisible(false);

    const captureUrl = (url: string): void => {
      if (!isRestorableChatGptUrl(url) || url === entry.record.url) return;
      entry.record.url = url;
      entry.record.updated_at = new Date().toISOString();
      void this.#queuePersist().catch(() => undefined);
    };
    view.webContents.on('did-navigate', (_event, url) => captureUrl(url));
    view.webContents.on('did-navigate-in-page', (_event, url) => captureUrl(url));
    return entry;
  }

  #loadEntry(entry: ChatGptTabEntry): Promise<void> {
    if (entry.loaded) return Promise.resolve();
    if (entry.loading !== undefined) return entry.loading;
    const loading = (async (): Promise<void> => {
      try {
        await entry.view.webContents.loadURL(entry.record.url);
        entry.loaded = true;
      } catch {
        entry.loaded = false;
      }
    })();
    entry.loading = loading;
    void loading.then(() => {
      if (entry.loading === loading) entry.loading = undefined;
    });
    return loading;
  }

  #focusWhenCurrent(entry: ChatGptTabEntry): void {
    setImmediate(() => {
      if (
        this.#closed ||
        this.#centerSurface !== 'chatgpt' ||
        this.#activeTabId !== entry.record.chatgpt_tab_id ||
        entry.view.webContents.isDestroyed()
      ) {
        return;
      }
      entry.view.webContents.focus();
    });
  }

  async #loadUrl(entry: ChatGptTabEntry, url: string): Promise<void> {
    entry.record.url = url;
    entry.record.updated_at = new Date().toISOString();
    try {
      await entry.view.webContents.loadURL(url);
      entry.loaded = true;
    } catch {
      entry.loaded = false;
    }
  }

  #projectLauncherEntry(workspaceId: string, workspaceName: string): ChatGptTabEntry {
    const launcherLabel = projectLauncherLabel(workspaceName);
    const existing =
      [...this.#entries.values()].find(
        (entry) =>
          entry.record.workspace_id === workspaceId && entry.record.project_instructions_confirmed,
      ) ?? [...this.#entries.values()].find((entry) => entry.record.workspace_id === workspaceId);
    if (existing !== undefined) {
      existing.record.label = launcherLabel;
      existing.record.updated_at = new Date().toISOString();
      return existing;
    }
    return this.#addEntry(
      newRecord({
        workspace_id: workspaceId,
        label: launcherLabel,
      }),
    );
  }

  #entry(chatGptTabId: string): ChatGptTabEntry {
    const entry = this.#entries.get(chatGptTabId);
    if (entry === undefined) {
      throw new Error('Unknown ChatSplice ChatGPT browser tab.');
    }
    return entry;
  }

  #applyVisibility(): void {
    if (
      this.#instructionAutomationTabId !== undefined &&
      (this.#centerSurface !== 'chatgpt' ||
        this.#activeTabId !== this.#instructionAutomationTabId ||
        (this.#instructionAutomationAutomatic && this.#instructionUiPaused))
    ) {
      const running = this.#entries.get(this.#instructionAutomationTabId);
      if (running !== undefined && !running.view.webContents.isDestroyed()) {
        void running.view.webContents
          .executeJavaScript('window.__chatspliceProjectInstructionsCancelled = true')
          .catch(() => undefined);
      }
    }
    for (const [chatGptTabId, entry] of this.#entries) {
      entry.view.setVisible(
        this.#centerSurface === 'chatgpt' && chatGptTabId === this.#activeTabId,
      );
    }
  }

  #rememberActiveTab(): void {
    this.#rememberTabForWorkspace(this.#activeTabId);
  }

  #rememberTabForWorkspace(chatGptTabId: string): void {
    const entry = this.#entries.get(chatGptTabId);
    if (entry === undefined) return;
    const currentId = this.#lastTabByWorkspace.get(entry.record.workspace_id);
    const current = currentId === undefined ? undefined : this.#entries.get(currentId);
    if (current === undefined || current.record.updated_at <= entry.record.updated_at) {
      this.#lastTabByWorkspace.set(entry.record.workspace_id, chatGptTabId);
    }
  }

  #tabIdForWorkspace(workspaceId: string | null): string | undefined {
    const remembered = this.#lastTabByWorkspace.get(workspaceId);
    if (
      remembered !== undefined &&
      this.#entries.get(remembered)?.record.workspace_id === workspaceId
    ) {
      return remembered;
    }
    const fallback = [...this.#entries.values()]
      .filter((entry) => entry.record.workspace_id === workspaceId)
      .sort((left, right) => right.record.updated_at.localeCompare(left.record.updated_at))[0];
    if (fallback === undefined) return undefined;
    this.#lastTabByWorkspace.set(workspaceId, fallback.record.chatgpt_tab_id);
    return fallback.record.chatgpt_tab_id;
  }

  #state(): ChatGptTabState {
    return ChatGptTabStateSchema.parse({
      tabs: [...this.#entries.values()].map(({ record }) => ({ ...record })),
      active_tab_id: this.#activeTabId,
    });
  }

  #queuePersist(): Promise<void> {
    const state = this.#state();
    this.#persistQueue = this.#persistQueue
      .catch(() => undefined)
      .then(() => this.#persistState(state));
    return this.#persistQueue;
  }
}
