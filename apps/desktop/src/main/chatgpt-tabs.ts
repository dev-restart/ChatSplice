import { createHash, randomBytes } from 'node:crypto';

import type { BaseWindow, Rectangle, WebContentsView } from 'electron';

import {
  AutomateChatGptProjectInputSchema,
  AutomateChatGptProjectResultSchema,
  ChatGptTabListResultSchema,
  ChatGptProjectKeySchema,
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

function isChatGptProjectUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === 'https://chatgpt.com' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      /^\/g\/[A-Za-z0-9_-]+\/project\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function projectKeyOf(value: string): string | undefined {
  try {
    return /^\/g\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(new URL(value).pathname)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * A Project conversation address carries its Project key, so the Project home is
 * derivable from it. The result is only a candidate: it becomes the stored pin
 * after the instructions identity check passes on that page.
 */
function projectHomeFromUrl(value: string): string | undefined {
  const key = projectKeyOf(value);
  if (key === undefined || !key.startsWith('g-p-')) return undefined;
  const home = `https://chatgpt.com/g/${key}/project`;
  return isChatGptProjectUrl(home) ? home : undefined;
}

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
  /** Verified ChatGPT Project key per workspace; independent of any tab's lifetime. */
  readonly #projectKeys = new Map<string, string>();
  #activeTabId: string;
  #selectionClock = 0;
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
      this.#selectionClock = Math.max(
        this.#selectionClock,
        Date.parse(record.last_activated_at ?? record.updated_at),
      );
      const entry = this.#addEntry({
        ...record,
        last_activated_at: record.last_activated_at ?? record.updated_at,
        url: isRestorableChatGptUrl(record.url) ? record.url : CHATGPT_HOME,
      });
      if (record.workspace_id === null) delete entry.record.project_url;
      if (this.#projectContextMismatch(entry)) entry.record.project_instructions_confirmed = false;
      this.#rememberProjectUrl(entry);
      this.#rememberProjectLocation(entry);
    }
    for (const [workspaceId, key] of Object.entries(validated.project_keys ?? {})) {
      this.#projectKeys.set(workspaceId, key);
    }
    // Pins stored on tabs before the registry existed are the same verified fact.
    for (const entry of this.#entries.values()) this.#recordProjectKey(entry);
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
    const project =
      validated.project_chat === true
        ? this.#projectChatContext(validated.workspace_id!)
        : undefined;
    if (this.#entries.size >= 50) throw new Error('chatgpt_tab_limit_reached');
    this.#rememberActiveTab();
    const record = newRecord(validated);
    if (project !== undefined) {
      record.url = project.url;
      record.project_url = project.url;
      record.project_instructions_confirmed = project.confirmed;
    }
    const entry = this.#addEntry(record);
    this.#rememberProjectLocation(entry);
    this.#activeTabId = record.chatgpt_tab_id;
    this.#markSelected(entry);
    this.#centerSurface = 'chatgpt';
    this.#applyVisibility();
    void this.#loadEntry(entry).then(() => this.#focusWhenCurrent(entry));
    await this.#queuePersist();
    return this.list();
  }

  /**
   * Owner menu recovery when the remote sidebar cannot be used. Open a fresh
   * unbound tab, never overwrite a Project conversation or inherit its binding.
   * The only destinations are public pages, not caller-supplied URLs or scripts.
   */
  public async openBrowserPage(destination: 'home' | 'projects'): Promise<ChatGptTabListResult> {
    if (this.#closed) throw new Error('ChatGPT tabs are closed.');
    if (destination !== 'home' && destination !== 'projects') {
      throw new Error('Unsupported ChatGPT browser destination.');
    }
    this.#rememberActiveTab();
    const record = newRecord({
      workspace_id: null,
      label: destination === 'home' ? 'ChatGPT Home' : 'ChatGPT Projects',
    });
    record.url = destination === 'home' ? CHATGPT_HOME : 'https://chatgpt.com/projects';
    const entry = this.#addEntry(record);
    this.#activeTabId = record.chatgpt_tab_id;
    this.#markSelected(entry);
    this.#centerSurface = 'chatgpt';
    this.#applyVisibility();
    const loading = this.#loadEntry(entry);
    await this.#queuePersist();
    await loading;
    if (!entry.loaded) throw new Error('ChatGPT page could not be loaded.');
    this.#focusWhenCurrent(entry);
    return this.list();
  }

  public async activateTab(chatGptTabId: string): Promise<ChatGptTabListResult> {
    const entry = this.#entry(chatGptTabId);
    this.#rememberActiveTab();
    this.#activeTabId = entry.record.chatgpt_tab_id;
    this.#markSelected(entry);
    this.#centerSurface = 'chatgpt';
    this.#applyVisibility();
    void this.#loadEntry(entry).then(() => this.#focusWhenCurrent(entry));
    await this.#queuePersist();
    return this.list();
  }

  /**
   * Activates the most recently selected ChatGPT tab for a local workspace.
   *
   * Explicit activation has its own persisted timestamp, so background URL or
   * instruction updates cannot replace a workspace's most recently chosen tab.
   * Legacy records migrate their original updated_at once, before navigation.
   * A workspace without a tab is reported explicitly for the setup flow.
   */
  public async activateWorkspace(
    workspaceId: string | null,
  ): Promise<ChatGptTabListResult | undefined> {
    const tabId = this.#tabIdForWorkspace(workspaceId);
    if (tabId === undefined) {
      const pinned = workspaceId === null ? undefined : this.#pinnedProjectEntry(workspaceId);
      if (pinned !== undefined) {
        return this.#returnToProject(
          pinned,
          pinned.record.project_last_url ?? pinned.record.project_url!,
        );
      }
      return undefined;
    }
    const entry = this.#entry(tabId);
    const restore = this.#projectRestoreTarget(entry);
    if (restore !== undefined) return this.#returnToProject(entry, restore);
    return this.activateTab(tabId);
  }

  /**
   * Where a project's tab should be brought back to. A project tab that wandered
   * to a general chat or another ChatGPT page returns to the last location seen
   * inside its own pinned Project; a tab still inside the Project is left alone.
   */
  #projectRestoreTarget(entry: ChatGptTabEntry): string | undefined {
    const { workspace_id: workspaceId, project_url: pin, project_last_url: last } = entry.record;
    if (workspaceId === null || pin === undefined || last === undefined) return undefined;
    const pinKey = projectKeyOf(pin);
    if (pinKey === undefined || projectKeyOf(entry.record.url) === pinKey) return undefined;
    return projectKeyOf(last) === pinKey ? last : undefined;
  }

  /**
   * The workspace's most recently used tab that carries a verified project pin.
   * Only the app-stored pin is ever a destination; a tab that merely shows some
   * other Project, or a general conversation, is never used to guess one.
   */
  #pinnedProjectEntry(workspaceId: string): ChatGptTabEntry | undefined {
    return [...this.#entries.values()]
      .filter(
        (entry) =>
          entry.record.workspace_id === workspaceId &&
          entry.record.project_url !== undefined &&
          isChatGptProjectUrl(entry.record.project_url),
      )
      .sort((left, right) =>
        this.#activationTime(right).localeCompare(this.#activationTime(left)),
      )[0];
  }

  /**
   * Navigates a project tab back to a location inside its own pinned Project.
   * Confirmation is never restored by navigation alone; a tab that drifted to
   * another Project stays unconfirmed until the explicit setup flow re-verifies
   * its instructions.
   */
  async #returnToProject(entry: ChatGptTabEntry, url: string): Promise<ChatGptTabListResult> {
    this.#rememberActiveTab();
    this.#activeTabId = entry.record.chatgpt_tab_id;
    this.#markSelected(entry);
    this.#centerSurface = 'chatgpt';
    this.#applyVisibility();
    await this.#loadUrl(entry, url);
    this.#focusWhenCurrent(entry);
    await this.#queuePersist();
    return this.list();
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
        delete entry.record.project_url;
      }
      entry.record.workspace_id = validated.workspace_id;
    }
    if (validated.project_instructions_confirmed !== undefined) {
      if (validated.project_instructions_confirmed && entry.record.workspace_id === null) {
        throw new Error('A ChatGPT Project confirmation requires a local workspace association.');
      }
      entry.record.project_instructions_confirmed = validated.project_instructions_confirmed;
      if (!validated.project_instructions_confirmed) delete entry.record.project_url;
      else this.#rememberProjectUrl(entry, true);
    }
    if (validated.label !== undefined) {
      entry.record.label = validated.label;
    }
    entry.record.updated_at = new Date().toISOString();
    if (previousWorkspaceId !== entry.record.workspace_id) {
      if (this.#lastTabByWorkspace.get(previousWorkspaceId) === entry.record.chatgpt_tab_id) {
        this.#lastTabByWorkspace.delete(previousWorkspaceId);
      }
      if (this.#activeTabId === entry.record.chatgpt_tab_id) this.#rememberActiveTab();
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
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();

    if (this.#entries.size === 0) {
      const replacement = newRecord({ workspace_id: null });
      const replacementEntry = this.#addEntry(replacement);
      this.#activeTabId = replacement.chatgpt_tab_id;
      this.#markSelected(replacementEntry);
      void this.#loadEntry(replacementEntry).then(() => this.#focusWhenCurrent(replacementEntry));
    } else if (this.#activeTabId === chatGptTabId) {
      const nextOrder = [...this.#entries.keys()];
      this.#activeTabId = nextOrder[Math.min(closedIndex, nextOrder.length - 1)] ?? nextOrder[0]!;
      this.#markSelected(this.#entry(this.#activeTabId));
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
    this.#projectKeys.delete(workspaceId);
    for (const entry of this.#entries.values()) {
      if (entry.record.workspace_id !== workspaceId) continue;
      if (this.#lastTabByWorkspace.get(workspaceId) === entry.record.chatgpt_tab_id) {
        this.#lastTabByWorkspace.delete(workspaceId);
      }
      entry.record.workspace_id = null;
      entry.record.project_instructions_confirmed = false;
      delete entry.record.project_url;
      if (entry.record.label.endsWith(PROJECT_LAUNCHER_SUFFIX)) {
        entry.record.label = DEFAULT_GENERAL_CHAT_LABEL;
      }
      entry.record.updated_at = new Date().toISOString();
      if (this.#activeTabId === entry.record.chatgpt_tab_id) this.#rememberActiveTab();
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
    if (this.#projectContextMismatch(entry)) {
      return AutomateChatGptProjectResultSchema.parse({
        automation: {
          status: 'needs_user',
          reason: 'chatgpt_ui_changed',
          message: '연결된 프로젝트와 다른 화면입니다. 원래 ChatGPT 프로젝트 홈을 열어 주세요.',
        },
        tabs: this.list(),
      });
    }
    this.#instructionAutomationTabId = entry.record.chatgpt_tab_id;
    try {
      const result =
        entry.record.project_url !== undefined || isChatGptProjectUrl(entry.record.url)
          ? await this.#updateProjectInstructions(
              input,
              !entry.record.project_instructions_confirmed,
            )
          : await this.#createProject(input);
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
      createOnly: true,
    });
    const entry = this.#projectLauncherEntry(validated.workspace_id, input.workspace_name);
    this.#rememberActiveTab();
    this.#activeTabId = entry.record.chatgpt_tab_id;
    this.#markSelected(entry);
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
      if (opened === 'context_changed') {
        return this.#deferredInstructions();
      } else if (opened === 'button_not_found') {
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
        result = await this.#submitAndBindProject(entry, automation.source, input);
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
      // The freshly created Project's key is stored the moment it is verified.
      this.#rememberProjectUrl(entry, true);
      this.#rememberProjectLocation(entry);
    }
    entry.record.updated_at = new Date().toISOString();
    await this.#queuePersist();
    return AutomateChatGptProjectResultSchema.parse({ automation: result, tabs: this.list() });
  }

  async #submitAndBindProject(
    entry: ChatGptTabEntry,
    source: string,
    input: ChatGptProjectSetupInput,
  ): Promise<ChatGptProjectAutomationResult> {
    const contents = entry.view.webContents;
    let interrupted = false;
    let createdUrl: string | undefined;
    const contextIsCurrent = (): boolean =>
      !interrupted &&
      !this.#closed &&
      this.#centerSurface === 'chatgpt' &&
      this.#activeTabId === entry.record.chatgpt_tab_id &&
      !contents.isDestroyed();
    const onNavigation = (_event: unknown, url: string): void => {
      if (!isChatGptProjectUrl(url) || (createdUrl !== undefined && createdUrl !== url)) {
        interrupted = true;
      } else {
        createdUrl = url;
      }
    };
    const onInPageNavigation = (event: unknown, url: string, isMainFrame: boolean): void => {
      if (isMainFrame) onNavigation(event, url);
    };
    const onInput = (_event: unknown, event: { type: string }): void => {
      if (['keyDown', 'mouseDown', 'touchStart'].includes(event.type)) interrupted = true;
    };
    contents.on('did-navigate', onNavigation);
    contents.on('did-navigate-in-page', onInPageNavigation);
    contents.on('input-event', onInput);
    contents.on('before-input-event', onInput);
    try {
      let submitted: unknown;
      try {
        submitted = await contents.executeJavaScript(source, true);
      } catch {
        // Navigation may destroy the submitting document before its promise
        // reaches main. Never resubmit; require an observed Project navigation.
      }
      if (!contextIsCurrent()) return this.#deferredInstructions().automation;
      if (submitted !== undefined && submitted !== 'submitted') {
        const failure = parseChatGptProjectAutomationResult(submitted);
        return failure.status === 'needs_user'
          ? failure
          : {
              status: 'needs_user',
              reason: 'project_setup_failed',
              message: '생성 제출 결과만으로 지침 저장을 확인할 수 없습니다.',
            };
      }
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && contextIsCurrent()) {
        if (createdUrl && contents.getURL() === createdUrl && !contents.isLoadingMainFrame()) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!contextIsCurrent()) return this.#deferredInstructions().automation;
      if (!createdUrl || contents.getURL() !== createdUrl || contents.isLoadingMainFrame()) {
        return {
          status: 'needs_user',
          reason: 'project_setup_failed',
          message:
            '새 Project로 이동했는지 확인하지 못했습니다. 다시 만들지 않고 현재 화면을 유지합니다.',
        };
      }
      entry.record.url = createdUrl;
      const instructions = buildChatGptProjectInstructionsUpdateScript({
        workspaceId: input.workspace_id,
        workspaceName: input.workspace_name,
        bindingText: input.binding_text,
        initializeEmpty: true,
        expectedProjectUrl: createdUrl,
      });
      const rawResult = await contents.executeJavaScript(instructions.source, true);
      if (!contextIsCurrent() || contents.getURL() !== createdUrl) {
        return this.#deferredInstructions().automation;
      }
      const result = parseChatGptProjectAutomationResult(rawResult);
      return result.status === 'completed'
        ? {
            status: 'completed',
            reason: 'created_and_bound',
            message: 'ChatGPT Project를 만들고 지침 저장을 재확인했습니다.',
          }
        : result;
    } finally {
      contents.removeListener('did-navigate', onNavigation);
      contents.removeListener('did-navigate-in-page', onInPageNavigation);
      contents.removeListener('input-event', onInput);
      contents.removeListener('before-input-event', onInput);
    }
  }

  /**
   * Clicking once isn't always enough — ChatGPT's layout can still be
   * settling right after navigation, so a click can land before the control
   * is interactive. Re-locate and re-click a few times, checking after each
   * attempt whether the modal's name field actually appeared, before giving up.
   */
  async #openProjectCreateModal(
    entry: ChatGptTabEntry,
  ): Promise<'opened' | 'modal_not_opened' | 'button_not_found' | 'context_changed'> {
    const url = entry.view.webContents.getURL();
    const contextIsCurrent = (): boolean =>
      !this.#closed &&
      this.#centerSurface === 'chatgpt' &&
      this.#activeTabId === entry.record.chatgpt_tab_id &&
      !entry.view.webContents.isDestroyed() &&
      entry.view.webContents.getURL() === url;
    const attempts = 3;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!contextIsCurrent()) return 'context_changed';
      const clicked = await entry.view.webContents.executeJavaScript(
        buildChatGptProjectCreateClickScript(),
        true,
      );
      if (!contextIsCurrent() || clicked === 'context_changed') return 'context_changed';
      if (clicked === 'not_found') return 'button_not_found';

      const opened = await entry.view.webContents.executeJavaScript(
        buildChatGptProjectCreateModalProbeScript(1_500),
        true,
      );
      if (!contextIsCurrent() || opened === 'context_changed') return 'context_changed';
      if (opened === true) return 'opened';
    }
    return 'modal_not_opened';
  }

  /**
   * Refreshes instructions on a Project this workspace is already bound to,
   * using a retained Project home — never a caller-supplied address — while
   * keeping the active conversation intact and preserving unmanaged text.
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
        (!active.record.project_instructions_confirmed &&
          active.record.project_url === undefined) ||
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
      const result = await this.#updateProjectInstructions(
        input,
        input.automatic !== true && entry.record.project_url !== undefined,
      );
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
    initializeEmpty = false,
  ): Promise<AutomateChatGptProjectResult> {
    const validated = AutomateChatGptProjectInputSchema.parse({ workspace_id: input.workspace_id });
    const source = input.automatic
      ? this.#entry(this.#activeTabId)
      : this.#projectLauncherEntry(validated.workspace_id, input.workspace_name);
    // A tab confirmed before Project pins existed may only know a conversation
    // address. Its Project home is a candidate until the identity check passes.
    const derivedHome =
      source.record.project_url === undefined && !isChatGptProjectUrl(source.record.url)
        ? projectHomeFromUrl(source.record.url)
        : undefined;
    const targetUrl = source.record.project_url ?? derivedHome ?? source.record.url;
    if (
      targetUrl === undefined ||
      !isChatGptProjectUrl(targetUrl) ||
      this.#projectContextMismatch(source)
    ) {
      return AutomateChatGptProjectResultSchema.parse({
        automation: {
          status: 'needs_user',
          reason: 'chatgpt_ui_changed',
          message: '연결된 ChatGPT Project 주소를 아직 확인하지 못했습니다.',
        },
        tabs: this.list(),
      });
    }

    if (input.automatic && !isChatGptProjectUrl(source.record.url)) {
      return AutomateChatGptProjectResultSchema.parse({
        automation: {
          status: 'needs_user',
          reason: 'project_home_required',
          message: '현재 대화를 유지했습니다. 프로젝트 설정에서 지침 저장 상태를 확인해 주세요.',
        },
        tabs: this.list(),
      });
    }

    const previous = this.#entries.get(this.#activeTabId);
    const entry =
      input.automatic || derivedHome !== undefined
        ? source
        : this.#projectInstructionsHomeEntry(source, targetUrl, input.workspace_name);
    this.#instructionAutomationTabId = entry.record.chatgpt_tab_id;
    this.#rememberActiveTab();
    this.#activeTabId = entry.record.chatgpt_tab_id;
    if (!input.automatic) this.#markSelected(entry);
    this.#centerSurface = 'chatgpt';
    this.#applyVisibility();
    if (derivedHome !== undefined) await this.#loadUrl(entry, derivedHome);
    else await this.#loadEntry(entry);
    if (!input.automatic) entry.view.webContents.focus();

    if (!entry.loaded) {
      this.#setProjectInstructionsVerification(entry, false);
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
      initializeEmpty,
      ...(initializeEmpty ? { expectedProjectUrl: targetUrl } : {}),
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
        this.#activeTabId !== entry.record.chatgpt_tab_id ||
        entry.view.webContents.getURL().replace(/\/$/, '') !== targetUrl.replace(/\/$/, '')
      )
        return this.#deferredInstructions();
      await entry.view.webContents.executeJavaScript(
        'window.__chatspliceProjectInstructionsCancelled = false',
      );
      if (
        this.#closed ||
        this.#centerSurface !== 'chatgpt' ||
        this.#activeTabId !== entry.record.chatgpt_tab_id ||
        entry.view.webContents.getURL().replace(/\/$/, '') !== targetUrl.replace(/\/$/, '')
      )
        return this.#deferredInstructions();
      const rawResult = await entry.view.webContents.executeJavaScript(automation.source, true);
      if (
        this.#closed ||
        this.#centerSurface !== 'chatgpt' ||
        this.#activeTabId !== entry.record.chatgpt_tab_id ||
        entry.view.webContents.getURL().replace(/\/$/, '') !== targetUrl.replace(/\/$/, '') ||
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
      this.#setProjectInstructionsVerification(entry, true, input.binding_text);
      this.#rememberProjectUrl(entry, true);
      this.#rememberProjectLocation(entry);
      if (
        !input.automatic &&
        previous !== undefined &&
        previous !== entry &&
        previous.record.workspace_id === validated.workspace_id &&
        !previous.view.webContents.isDestroyed() &&
        this.#activeTabId === entry.record.chatgpt_tab_id &&
        this.#centerSurface === 'chatgpt'
      ) {
        this.#activeTabId = previous.record.chatgpt_tab_id;
        this.#markSelected(previous);
        this.#applyVisibility();
        previous.view.webContents.focus();
      }
    } else if (result.reason !== 'automation_deferred') {
      this.#setProjectInstructionsVerification(entry, false);
    }
    entry.record.updated_at = new Date().toISOString();
    await this.#queuePersist();
    return AutomateChatGptProjectResultSchema.parse({ automation: result, tabs: this.list() });
  }

  #projectInstructionsHomeEntry(
    source: ChatGptTabEntry,
    home: string,
    workspaceName: string,
  ): ChatGptTabEntry {
    const normalizedHome = home.replace(/\/$/, '');
    const existing = [...this.#entries.values()].find(
      (entry) =>
        entry.record.workspace_id === source.record.workspace_id &&
        entry.record.url.replace(/\/$/, '') === normalizedHome &&
        !this.#projectContextMismatch(entry) &&
        !entry.view.webContents.isDestroyed(),
    );
    if (existing !== undefined) return existing;
    if (this.#entries.size >= 50) throw new Error('chatgpt_tab_limit_reached');
    const record = newRecord({
      workspace_id: source.record.workspace_id,
      label: projectLauncherLabel(workspaceName),
    });
    record.url = normalizedHome;
    if (source.record.project_url !== undefined) record.project_url = normalizedHome;
    return this.#addEntry(record);
  }

  /** A fresh failed verification must not be hidden by an older tab's confirmation. */
  #setProjectInstructionsVerification(
    entry: ChatGptTabEntry,
    confirmed: boolean,
    bindingText?: string,
  ): void {
    const projectKey = projectKeyOf(entry.record.project_url ?? entry.record.url);
    const version = bindingText === undefined ? undefined : this.#instructionVersion(bindingText);
    for (const candidate of this.#entries.values()) {
      if (
        candidate.record.workspace_id !== entry.record.workspace_id ||
        projectKeyOf(candidate.record.project_url ?? candidate.record.url) !== projectKey
      )
        continue;
      candidate.record.project_instructions_confirmed = confirmed;
      if (confirmed && version !== undefined) {
        this.#instructionVersions.set(candidate.record.chatgpt_tab_id, version);
        this.#instructionRetryAt.delete(candidate.record.chatgpt_tab_id);
      } else {
        this.#instructionVersions.delete(candidate.record.chatgpt_tab_id);
      }
    }
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
    if (record.project_instructions_confirmed && record.project_url !== undefined) {
      const verified = [...this.#entries.values()].find(
        (candidate) =>
          candidate.record.workspace_id === record.workspace_id &&
          candidate.record.project_url === record.project_url &&
          candidate.record.project_instructions_confirmed &&
          this.#instructionVersions.has(candidate.record.chatgpt_tab_id),
      );
      if (verified !== undefined) {
        this.#instructionVersions.set(
          record.chatgpt_tab_id,
          this.#instructionVersions.get(verified.record.chatgpt_tab_id)!,
        );
      }
    }
    this.#entries.set(record.chatgpt_tab_id, entry);
    this.#window.contentView.addChildView(view, 0);
    view.setBounds(this.#bounds);
    view.setVisible(false);

    const captureUrl = (url: string): void => {
      if (!isRestorableChatGptUrl(url) || url === entry.record.url) return;
      entry.record.url = url;
      entry.record.updated_at = new Date().toISOString();
      if (this.#projectContextMismatch(entry, url)) {
        entry.record.project_instructions_confirmed = false;
        this.#instructionVersions.delete(entry.record.chatgpt_tab_id);
      }
      this.#rememberProjectUrl(entry);
      this.#rememberProjectLocation(entry);
      void this.#queuePersist().catch(() => undefined);
    };
    view.webContents.on('did-navigate', (_event, url) => captureUrl(url));
    view.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) captureUrl(url);
    });
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
    const candidates = [...this.#entries.values()]
      .filter((entry) => entry.record.workspace_id === workspaceId)
      .sort((left, right) => this.#activationTime(right).localeCompare(this.#activationTime(left)));
    const active = this.#entries.get(this.#activeTabId);
    const existing =
      (active?.record.workspace_id === workspaceId &&
      (active.record.project_instructions_confirmed || active.record.project_url !== undefined)
        ? active
        : undefined) ??
      candidates.find((entry) => entry.record.project_instructions_confirmed) ??
      candidates[0];
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

  #rememberProjectUrl(entry: ChatGptTabEntry, verified = false): void {
    if (
      entry.record.workspace_id !== null &&
      entry.record.project_instructions_confirmed &&
      (entry.record.project_url === undefined || verified) &&
      isChatGptProjectUrl(entry.record.url)
    ) {
      entry.record.project_url = new URL(entry.record.url).href.replace(/\/$/, '');
      this.#recordProjectKey(entry);
    }
  }

  /** Stores the Project key of a verified pin so navigation survives the tab itself. */
  #recordProjectKey(entry: ChatGptTabEntry): void {
    const { workspace_id: workspaceId, project_url: pin } = entry.record;
    if (workspaceId === null || pin === undefined) return;
    const key = projectKeyOf(pin);
    if (
      key !== undefined &&
      key.startsWith('g-p-') &&
      ChatGptProjectKeySchema.safeParse(key).success
    ) {
      this.#projectKeys.set(workspaceId, key);
    }
  }

  #rememberProjectLocation(entry: ChatGptTabEntry): void {
    const pin = entry.record.project_url;
    if (entry.record.workspace_id === null || pin === undefined) return;
    try {
      const current = new URL(entry.record.url);
      if (
        current.origin !== 'https://chatgpt.com' ||
        projectKeyOf(current.href) !== projectKeyOf(pin) ||
        !/^\/g\/[A-Za-z0-9_-]+\/(?:project|c\/[A-Za-z0-9-]+)\/?$/.test(current.pathname)
      ) {
        return;
      }
      entry.record.project_last_url = `${current.origin}${current.pathname}`.replace(/\/$/, '');
    } catch {
      // A malformed URL is never a restore destination.
    }
  }

  #projectContextMismatch(entry: ChatGptTabEntry, value = entry.record.url): boolean {
    const projectUrl = entry.record.project_url;
    if (projectUrl === undefined) return false;
    try {
      const current = new URL(value);
      const expected = new URL(projectUrl);
      const currentKey = /^\/g\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(current.pathname)?.[1];
      const expectedKey = /^\/g\/([A-Za-z0-9_-]+)\//.exec(expected.pathname)?.[1];
      return (
        current.origin === expected.origin && currentKey !== undefined && currentKey !== expectedKey
      );
    } catch {
      return false;
    }
  }

  #projectChatContext(workspaceId: string): { url: string; confirmed: boolean } {
    const candidates = [...this.#entries.values()].filter(
      (entry) =>
        entry.record.workspace_id === workspaceId &&
        entry.record.project_instructions_confirmed &&
        entry.record.project_url !== undefined &&
        isChatGptProjectUrl(entry.record.project_url),
    );
    const urls = new Set(candidates.map((entry) => entry.record.project_url!.replace(/\/$/, '')));
    if (urls.size === 0) {
      const key = this.#projectKeys.get(workspaceId);
      if (key === undefined) throw new Error('project_chat_url_unavailable');
      return { url: `https://chatgpt.com/g/${key}/project`, confirmed: true };
    }
    if (urls.size > 1) throw new Error('project_chat_url_ambiguous');
    return {
      url: [...urls][0]!,
      confirmed: candidates.some((entry) => entry.record.project_instructions_confirmed),
    };
  }

  #activationTime(entry: ChatGptTabEntry): string {
    return entry.record.last_activated_at ?? entry.record.updated_at;
  }

  #markSelected(entry: ChatGptTabEntry): void {
    this.#selectionClock = Math.max(Date.now(), this.#selectionClock + 1);
    const timestamp = new Date(this.#selectionClock).toISOString();
    entry.record.last_activated_at = timestamp;
    entry.record.updated_at = timestamp;
    this.#rememberActiveTab();
  }

  #rememberActiveTab(): void {
    this.#rememberTabForWorkspace(this.#activeTabId);
  }

  #rememberTabForWorkspace(chatGptTabId: string): void {
    const entry = this.#entries.get(chatGptTabId);
    if (entry === undefined) return;
    this.#lastTabByWorkspace.set(entry.record.workspace_id, chatGptTabId);
  }

  #tabIdForWorkspace(workspaceId: string | null): string | undefined {
    const remembered = this.#lastTabByWorkspace.get(workspaceId);
    if (
      remembered !== undefined &&
      this.#entries.get(remembered)?.record.workspace_id === workspaceId &&
      !this.#projectContextMismatch(this.#entries.get(remembered)!)
    ) {
      return remembered;
    }
    const fallback = [...this.#entries.values()]
      .filter(
        (entry) =>
          entry.record.workspace_id === workspaceId && !this.#projectContextMismatch(entry),
      )
      .sort((left, right) =>
        this.#activationTime(right).localeCompare(this.#activationTime(left)),
      )[0];
    if (fallback === undefined) return undefined;
    this.#lastTabByWorkspace.set(workspaceId, fallback.record.chatgpt_tab_id);
    return fallback.record.chatgpt_tab_id;
  }

  #state(): ChatGptTabState {
    return ChatGptTabStateSchema.parse({
      tabs: [...this.#entries.values()].map(({ record }) => ({ ...record })),
      active_tab_id: this.#activeTabId,
      ...(this.#projectKeys.size > 0
        ? { project_keys: Object.fromEntries(this.#projectKeys) }
        : {}),
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
