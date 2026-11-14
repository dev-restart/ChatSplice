import { basename } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  EDITOR_MAX_COMBINED_BYTES,
  EDITOR_MAX_DOCUMENT_BYTES,
  EDITOR_MAX_GLOBAL_TABS,
  EDITOR_MAX_TABS_PER_WORKSPACE,
  EditorPathSchema,
  EditorTabIdSchema,
  EditorWorkspaceIdSchema,
} from '@chatsplice/protocol';

export const MAX_EDITOR_TABS_PER_WORKSPACE = EDITOR_MAX_TABS_PER_WORKSPACE;
export const MAX_EDITOR_TABS_TOTAL = EDITOR_MAX_GLOBAL_TABS;
export const MAX_EDITOR_WORKSPACES = 500;
export const MAX_EDITOR_DOCUMENT_BYTES = EDITOR_MAX_DOCUMENT_BYTES;
export const MAX_EDITOR_TOTAL_DOCUMENT_BYTES = EDITOR_MAX_COMBINED_BYTES;

export type EditorSessionWorkspaceId = string;

export interface EditorSessionPersistedTab {
  readonly editor_tab_id: string;
  readonly path: string;
  readonly label: string;
}

export interface EditorSessionPersistedWorkspace {
  readonly workspace_id: EditorSessionWorkspaceId;
  readonly tabs: readonly EditorSessionPersistedTab[];
  readonly active_editor_tab_id: string | null;
}

/**
 * Only file-tab metadata is persisted. Document bodies, baselines and dirty
 * drafts deliberately never cross an app restart.
 */
export interface EditorSessionPersistedState {
  readonly active_workspace_id: EditorSessionWorkspaceId | null;
  readonly workspaces: readonly EditorSessionPersistedWorkspace[];
}

export interface EditorTab {
  readonly editor_tab_id: string;
  readonly workspace_id: EditorSessionWorkspaceId;
  readonly path: string;
  readonly label: string;
  readonly loaded: boolean;
  readonly dirty: boolean;
  readonly draft_revision: number;
}

export interface EditorDocument {
  readonly editor_tab_id: string;
  readonly workspace_id: EditorSessionWorkspaceId;
  readonly path: string;
  readonly content: string;
  /** SHA-256 of the last file content loaded/saved on disk. */
  readonly sha256: string;
  readonly draft_revision: number;
  readonly dirty: boolean;
}

export interface EditorSessionState {
  /** The project whose tabs are represented by `tabs`. */
  readonly workspace_id: EditorSessionWorkspaceId | null;
  readonly tabs: readonly EditorTab[];
  readonly active_editor_tab_id: string | null;
  /** IDs for all open tabs, including metadata-only tabs from a restart. */
  readonly open_document_ids: readonly string[];
  /** Monotonic in-memory state revision used by renderer refreshes. */
  readonly revision: number;
}

export type WorkbenchEditorState = EditorSessionState;

export interface OpenEditorFileInput {
  readonly workspace_id: EditorSessionWorkspaceId;
  readonly path: string;
  readonly label?: string;
  readonly content: string;
  readonly sha256: string;
}

export interface EditorTabTarget {
  readonly workspace_id: EditorSessionWorkspaceId;
  readonly editor_tab_id: string;
}

export interface HydrateEditorDocumentInput extends EditorTabTarget {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
}

export interface UpdateEditorDocumentInput extends EditorTabTarget {
  readonly content: string;
  /** The draft revision rendered by the caller before it started typing. */
  readonly expected_revision: number;
}

export interface MarkEditorDocumentSavedInput extends EditorTabTarget {
  /** Revision of the content snapshot sent to the filesystem writer. */
  readonly expected_revision: number;
  readonly content: string;
  readonly sha256: string;
}

export interface ReloadEditorDocumentInput extends EditorTabTarget {
  readonly content: string;
  readonly sha256: string;
}

export interface CloseEditorTabInput extends EditorTabTarget {
  /** Set only after the owner has confirmed discarding a dirty draft. */
  readonly discard?: boolean;
}

export interface CloseEditorTabResult {
  readonly closed: boolean;
  readonly reason?: 'dirty';
  readonly state: EditorSessionState;
}

export interface CloseEditorWorkspaceResult {
  readonly closed: boolean;
  readonly reason?: 'dirty';
  readonly dirty_document_ids?: readonly string[];
  readonly state: EditorSessionState;
}

export interface OpenEditorFileResult {
  readonly state: EditorSessionState;
  readonly document: EditorDocument;
}

export interface UpdateEditorDocumentResult {
  readonly state: EditorSessionState;
  readonly document: EditorDocument;
}

export interface SaveEditorDocumentResult {
  readonly state: EditorSessionState;
  readonly document: EditorDocument;
}

export interface ReloadEditorDocumentResult {
  readonly state: EditorSessionState;
  readonly document: EditorDocument;
}

export interface WorkbenchEditorSessionManagerOptions {
  readonly initialState?: EditorSessionPersistedState;
  readonly persist?: (state: EditorSessionPersistedState) => Promise<void> | void;
}

interface InternalTab {
  readonly editor_tab_id: string;
  readonly workspace_id: EditorSessionWorkspaceId;
  readonly path: string;
  readonly label: string;
  loaded: boolean;
  dirty: boolean;
  draft_revision: number;
}

interface InternalDocument {
  readonly editor_tab_id: string;
  readonly workspace_id: EditorSessionWorkspaceId;
  readonly path: string;
  content: string;
  baseline_content: string;
  sha256: string;
  dirty: boolean;
  draft_revision: number;
}

interface WorkspaceTabs {
  readonly workspace_id: EditorSessionWorkspaceId;
  readonly tabs: Map<string, InternalTab>;
  active_editor_tab_id: string | null;
}

function newEditorTabId(): string {
  return `edtab_${randomBytes(12).toString('hex')}`;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function requireWorkspaceId(workspaceId: string): void {
  try {
    EditorWorkspaceIdSchema.parse(workspaceId);
  } catch {
    throw new Error('Editor workspace_id is invalid.');
  }
}

function requirePath(path: string): void {
  try {
    EditorPathSchema.parse(path);
  } catch {
    throw new Error('Editor paths must be non-empty workspace-relative paths.');
  }
}

function requireRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('Editor draft revision is invalid.');
  }
}

function requireSha256(sha256: string): void {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Editor SHA-256 is invalid.');
}

function requireEditorText(value: string): void {
  if (value.includes('\0')) throw new Error('Editor content contains a NUL byte.');
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        throw new Error('Editor content contains invalid UTF-16.');
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error('Editor content contains invalid UTF-16.');
    }
  }
  if (utf8Bytes(value) > MAX_EDITOR_DOCUMENT_BYTES) {
    throw new Error('EDITOR_DOCUMENT_SIZE_LIMIT_REACHED');
  }
}

function requireLabel(label: string): void {
  if (label.trim() === '' || label.trim().length > 240) {
    throw new Error('Editor tab label is invalid.');
  }
}

function cloneTab(tab: InternalTab): EditorTab {
  return {
    editor_tab_id: tab.editor_tab_id,
    workspace_id: tab.workspace_id,
    path: tab.path,
    label: tab.label,
    loaded: tab.loaded,
    dirty: tab.dirty,
    draft_revision: tab.draft_revision,
  };
}

export class WorkbenchEditorSessionManager {
  readonly #persistState:
    ((state: EditorSessionPersistedState) => Promise<void> | void) | undefined;
  readonly #workspaces = new Map<EditorSessionWorkspaceId, WorkspaceTabs>();
  readonly #documents = new Map<string, InternalDocument>();
  #activeWorkspaceId: EditorSessionWorkspaceId | null;
  #revision = 0;
  #persistQueue: Promise<void> = Promise.resolve();

  public constructor(options: WorkbenchEditorSessionManagerOptions = {}) {
    this.#persistState = options.persist;
    this.#activeWorkspaceId = options.initialState?.active_workspace_id ?? null;
    this.#hydrate(options.initialState);
  }

  /** Returns only the active project's tabs and summaries for every open ID. */
  public getState(
    workspaceId: EditorSessionWorkspaceId | null = this.#activeWorkspaceId,
  ): EditorSessionState {
    return this.#state(workspaceId);
  }

  /** Returns a document body only when the caller names its exact project/tab. */
  public getDocument(target: EditorTabTarget): EditorDocument {
    const tab = this.#tab(target);
    const document = this.#documents.get(tab.editor_tab_id);
    if (document === undefined || !tab.loaded) {
      throw new Error('Editor document is not loaded.');
    }
    return this.#document(document);
  }

  /**
   * Installs a disk read only for a metadata-only tab. A late read for a
   * loaded tab is intentionally ignored so it cannot replace a draft.
   */
  public hydrateDocument(input: HydrateEditorDocumentInput): EditorDocument {
    const tab = this.#tab(input);
    requirePath(input.path);
    if (input.path !== tab.path) {
      throw new Error('Editor document path does not match editor tab.');
    }
    if (tab.loaded) return this.#document(this.#loadedDocument(tab));
    this.#setLoadedDocument(tab, input.content, input.sha256);
    this.#touch();
    return this.#document(this.#loadedDocument(tab));
  }

  public selectWorkspace(workspaceId: EditorSessionWorkspaceId | null): EditorSessionState {
    if (workspaceId !== null) requireWorkspaceId(workspaceId);
    this.#activeWorkspaceId = workspaceId;
    this.#touch();
    return this.#state(workspaceId);
  }

  /** Selects the workspace's ChatGPT center and clears its active file. */
  public activateChat(workspaceId: EditorSessionWorkspaceId): WorkbenchEditorState {
    requireWorkspaceId(workspaceId);
    const workspace = this.#workspace(workspaceId, true);
    workspace.active_editor_tab_id = null;
    this.#activeWorkspaceId = workspaceId;
    this.#touch();
    return this.#state(workspaceId);
  }

  public openFile(input: OpenEditorFileInput): OpenEditorFileResult {
    requireWorkspaceId(input.workspace_id);
    requirePath(input.path);
    requireEditorText(input.content);
    requireSha256(input.sha256);
    const workspace = this.#workspace(input.workspace_id, true);
    const existing = [...workspace.tabs.values()].find((tab) => tab.path === input.path);
    if (existing !== undefined) {
      workspace.active_editor_tab_id = existing.editor_tab_id;
      this.#activeWorkspaceId = input.workspace_id;
      if (!existing.loaded) {
        this.#setLoadedDocument(existing, input.content, input.sha256);
        this.#touch();
      }
      return {
        state: this.#state(input.workspace_id),
        document: this.getDocument(this.#target(existing)),
      };
    }

    this.#assertDocumentBudget(input.content, input.content);
    this.#assertTabCapacity(workspace);
    const label = input.label?.trim() || basename(input.path);
    requireLabel(label);
    const tab: InternalTab = {
      editor_tab_id: newEditorTabId(),
      workspace_id: input.workspace_id,
      path: input.path,
      label,
      loaded: true,
      dirty: false,
      draft_revision: 0,
    };
    workspace.tabs.set(tab.editor_tab_id, tab);
    workspace.active_editor_tab_id = tab.editor_tab_id;
    this.#activeWorkspaceId = input.workspace_id;
    this.#documents.set(tab.editor_tab_id, {
      editor_tab_id: tab.editor_tab_id,
      workspace_id: input.workspace_id,
      path: input.path,
      content: input.content,
      baseline_content: input.content,
      sha256: input.sha256,
      dirty: false,
      draft_revision: 0,
    });
    this.#touch();
    return {
      state: this.#state(input.workspace_id),
      document: this.getDocument(this.#target(tab)),
    };
  }

  public activateTab(target: EditorTabTarget): EditorSessionState {
    const tab = this.#tab(target);
    const workspace = this.#workspace(target.workspace_id, false);
    workspace.active_editor_tab_id = tab.editor_tab_id;
    this.#activeWorkspaceId = target.workspace_id;
    this.#touch();
    return this.#state(target.workspace_id);
  }

  public updateDocument(input: UpdateEditorDocumentInput): UpdateEditorDocumentResult {
    requireRevision(input.expected_revision);
    const tab = this.#tab(input);
    const document = this.#loadedDocument(tab);
    if (document.draft_revision !== input.expected_revision) {
      throw new Error('EDITOR_DOCUMENT_REVISION_CONFLICT');
    }
    this.#assertDocumentBudget(input.content, document.baseline_content, document.editor_tab_id);
    document.content = input.content;
    document.dirty = document.content !== document.baseline_content;
    document.draft_revision += 1;
    tab.dirty = document.dirty;
    tab.draft_revision = document.draft_revision;
    this.#touch();
    return {
      state: this.#state(input.workspace_id),
      document: this.#document(document),
    };
  }

  /**
   * Commits the exact content snapshot handed to the filesystem writer. If
   * typing continued while the write was in flight, only the baseline moves;
   * the newer draft remains in memory and stays dirty.
   */
  public markSaved(input: MarkEditorDocumentSavedInput): SaveEditorDocumentResult {
    requireRevision(input.expected_revision);
    requireEditorText(input.content);
    requireSha256(input.sha256);
    const tab = this.#tab(input);
    const document = this.#loadedDocument(tab);
    this.#assertDocumentBudget(document.content, input.content, document.editor_tab_id);
    document.baseline_content = input.content;
    document.sha256 = input.sha256;
    document.dirty = document.content !== document.baseline_content;
    tab.dirty = document.dirty;
    tab.draft_revision = document.draft_revision;
    this.#touch();
    return {
      state: this.#state(input.workspace_id),
      document: this.#document(document),
    };
  }

  public reloadDocument(input: ReloadEditorDocumentInput): ReloadEditorDocumentResult {
    requireEditorText(input.content);
    requireSha256(input.sha256);
    const tab = this.#tab(input);
    const document = this.#loadedDocument(tab);
    this.#assertDocumentBudget(input.content, input.content, document.editor_tab_id);
    document.content = input.content;
    document.baseline_content = input.content;
    document.sha256 = input.sha256;
    document.dirty = false;
    document.draft_revision += 1;
    tab.dirty = false;
    tab.draft_revision = document.draft_revision;
    this.#touch();
    return {
      state: this.#state(input.workspace_id),
      document: this.#document(document),
    };
  }

  public closeTab(input: CloseEditorTabInput): CloseEditorTabResult {
    const tab = this.#tab(input);
    const workspace = this.#workspace(input.workspace_id, false);
    if (tab.dirty && input.discard !== true) {
      return { closed: false, reason: 'dirty', state: this.#state(input.workspace_id) };
    }
    workspace.tabs.delete(tab.editor_tab_id);
    this.#documents.delete(tab.editor_tab_id);
    if (workspace.active_editor_tab_id === tab.editor_tab_id) {
      workspace.active_editor_tab_id = [...workspace.tabs.keys()].at(-1) ?? null;
    }
    this.#touch();
    return { closed: true, state: this.#state(input.workspace_id) };
  }

  /** Clears one project's tabs and loaded documents after a guarded remove/path change. */
  public closeWorkspace(
    workspaceId: EditorSessionWorkspaceId,
    options: { readonly discard?: boolean } = {},
  ): CloseEditorWorkspaceResult {
    requireWorkspaceId(workspaceId);
    const workspace = this.#workspaces.get(workspaceId);
    if (workspace === undefined) {
      return { closed: true, state: this.#state(this.#activeWorkspaceId) };
    }
    const dirtyDocuments = [...workspace.tabs.values()]
      .filter((tab) => tab.dirty)
      .map((tab) => tab.editor_tab_id);
    if (dirtyDocuments.length > 0 && options.discard !== true) {
      return {
        closed: false,
        reason: 'dirty',
        dirty_document_ids: dirtyDocuments,
        state: this.#state(workspaceId),
      };
    }
    for (const editorTabId of workspace.tabs.keys()) this.#documents.delete(editorTabId);
    this.#workspaces.delete(workspaceId);
    if (this.#activeWorkspaceId === workspaceId) this.#activeWorkspaceId = null;
    this.#touch();
    return { closed: true, state: this.#state(this.#activeWorkspaceId) };
  }

  public listDirtyDocuments(): readonly EditorDocument[] {
    return [...this.#documents.values()]
      .filter((document) => document.dirty)
      .map((document) => this.#document(document));
  }

  public async flushPersistence(): Promise<void> {
    await this.#persistQueue;
  }

  #hydrate(initialState: EditorSessionPersistedState | undefined): void {
    if (initialState === undefined) return;
    if (initialState.active_workspace_id !== null) {
      requireWorkspaceId(initialState.active_workspace_id);
    }
    if (initialState.workspaces.length > MAX_EDITOR_WORKSPACES) {
      throw new Error('Editor workspace metadata limit exceeded.');
    }
    const seenTabIds = new Set<string>();
    let totalTabs = 0;
    for (const persistedWorkspace of initialState.workspaces) {
      requireWorkspaceId(persistedWorkspace.workspace_id);
      if (this.#workspaces.has(persistedWorkspace.workspace_id)) {
        throw new Error('Duplicate editor workspace metadata.');
      }
      if (persistedWorkspace.tabs.length > MAX_EDITOR_TABS_PER_WORKSPACE) {
        throw new Error('Editor workspace tab limit exceeded.');
      }
      const tabs = new Map<string, InternalTab>();
      for (const persistedTab of persistedWorkspace.tabs) {
        try {
          EditorTabIdSchema.parse(persistedTab.editor_tab_id);
        } catch {
          throw new Error('Editor tab ID is invalid.');
        }
        requirePath(persistedTab.path);
        requireLabel(persistedTab.label);
        if (seenTabIds.has(persistedTab.editor_tab_id)) {
          throw new Error('Duplicate editor tab ID.');
        }
        if ([...tabs.values()].some((tab) => tab.path === persistedTab.path)) {
          throw new Error('Duplicate editor path in workspace metadata.');
        }
        seenTabIds.add(persistedTab.editor_tab_id);
        tabs.set(persistedTab.editor_tab_id, {
          editor_tab_id: persistedTab.editor_tab_id,
          workspace_id: persistedWorkspace.workspace_id,
          path: persistedTab.path,
          label: persistedTab.label || basename(persistedTab.path),
          loaded: false,
          dirty: false,
          draft_revision: 0,
        });
      }
      const active =
        persistedWorkspace.active_editor_tab_id !== null &&
        tabs.has(persistedWorkspace.active_editor_tab_id) &&
        EditorTabIdSchema.safeParse(persistedWorkspace.active_editor_tab_id).success
          ? persistedWorkspace.active_editor_tab_id
          : null;
      this.#workspaces.set(persistedWorkspace.workspace_id, {
        workspace_id: persistedWorkspace.workspace_id,
        tabs,
        active_editor_tab_id: active,
      });
      totalTabs += tabs.size;
    }
    if (totalTabs > MAX_EDITOR_TABS_TOTAL) throw new Error('Global editor tab limit exceeded.');
    if (this.#activeWorkspaceId !== null && !this.#workspaces.has(this.#activeWorkspaceId)) {
      this.#activeWorkspaceId = null;
    }
  }

  #workspace(workspaceId: string, create: boolean): WorkspaceTabs {
    const existing = this.#workspaces.get(workspaceId);
    if (existing !== undefined) return existing;
    if (!create) throw new Error('Unknown editor workspace.');
    const workspace: WorkspaceTabs = {
      workspace_id: workspaceId,
      tabs: new Map(),
      active_editor_tab_id: null,
    };
    this.#workspaces.set(workspaceId, workspace);
    return workspace;
  }

  #tab(target: EditorTabTarget): InternalTab {
    requireWorkspaceId(target.workspace_id);
    try {
      EditorTabIdSchema.parse(target.editor_tab_id);
    } catch {
      throw new Error('Editor tab ID is invalid.');
    }
    const tab = this.#workspace(target.workspace_id, false).tabs.get(target.editor_tab_id);
    if (tab === undefined) throw new Error('Unknown editor tab.');
    return tab;
  }

  #loadedDocument(tab: InternalTab): InternalDocument {
    const document = this.#documents.get(tab.editor_tab_id);
    if (document === undefined || !tab.loaded) throw new Error('Editor document is not loaded.');
    return document;
  }

  #setLoadedDocument(tab: InternalTab, content: string, sha256: string): void {
    requireEditorText(content);
    requireSha256(sha256);
    this.#assertDocumentBudget(content, content, tab.editor_tab_id);
    tab.loaded = true;
    tab.dirty = false;
    tab.draft_revision = 0;
    this.#documents.set(tab.editor_tab_id, {
      editor_tab_id: tab.editor_tab_id,
      workspace_id: tab.workspace_id,
      path: tab.path,
      content,
      baseline_content: content,
      sha256,
      dirty: false,
      draft_revision: 0,
    });
  }

  #target(tab: InternalTab): EditorTabTarget {
    return { workspace_id: tab.workspace_id, editor_tab_id: tab.editor_tab_id };
  }

  #assertTabCapacity(workspace: WorkspaceTabs): void {
    if (workspace.tabs.size >= MAX_EDITOR_TABS_PER_WORKSPACE) {
      throw new Error('EDITOR_WORKSPACE_TAB_LIMIT_REACHED');
    }
    if (this.#documentsAndTabsCount() >= MAX_EDITOR_TABS_TOTAL) {
      throw new Error('EDITOR_GLOBAL_TAB_LIMIT_REACHED');
    }
  }

  #documentsAndTabsCount(): number {
    let count = 0;
    for (const workspace of this.#workspaces.values()) count += workspace.tabs.size;
    return count;
  }

  #documentBytes(excludeEditorTabId?: string): number {
    let total = 0;
    for (const document of this.#documents.values()) {
      if (document.editor_tab_id === excludeEditorTabId) continue;
      total += utf8Bytes(document.content) + utf8Bytes(document.baseline_content);
    }
    return total;
  }

  #assertDocumentBudget(
    content: string,
    baselineContent: string,
    replacingEditorTabId?: string,
  ): void {
    requireEditorText(content);
    requireEditorText(baselineContent);
    if (utf8Bytes(content) > MAX_EDITOR_DOCUMENT_BYTES) {
      throw new Error('EDITOR_DOCUMENT_SIZE_LIMIT_REACHED');
    }
    if (utf8Bytes(baselineContent) > MAX_EDITOR_DOCUMENT_BYTES) {
      throw new Error('EDITOR_DOCUMENT_SIZE_LIMIT_REACHED');
    }
    const total =
      this.#documentBytes(replacingEditorTabId) + utf8Bytes(content) + utf8Bytes(baselineContent);
    if (total > MAX_EDITOR_TOTAL_DOCUMENT_BYTES) {
      throw new Error('EDITOR_DOCUMENT_MEMORY_LIMIT_REACHED');
    }
  }

  #document(document: InternalDocument): EditorDocument {
    return {
      editor_tab_id: document.editor_tab_id,
      workspace_id: document.workspace_id,
      path: document.path,
      content: document.content,
      sha256: document.sha256,
      draft_revision: document.draft_revision,
      dirty: document.dirty,
    };
  }

  #state(workspaceId: string | null): EditorSessionState {
    const workspace = workspaceId === null ? undefined : this.#workspaces.get(workspaceId);
    const tabs = workspace === undefined ? [] : [...workspace.tabs.values()].map(cloneTab);
    const openDocumentIds = [...this.#workspaces.values()].flatMap((item) => [...item.tabs.keys()]);
    return {
      workspace_id: workspaceId,
      tabs,
      active_editor_tab_id: workspace?.active_editor_tab_id ?? null,
      open_document_ids: openDocumentIds,
      revision: this.#revision,
    };
  }

  #persistedState(): EditorSessionPersistedState {
    return {
      active_workspace_id: this.#activeWorkspaceId,
      workspaces: [...this.#workspaces.values()].map((workspace) => ({
        workspace_id: workspace.workspace_id,
        tabs: [...workspace.tabs.values()].map((tab) => ({
          editor_tab_id: tab.editor_tab_id,
          path: tab.path,
          label: tab.label,
        })),
        active_editor_tab_id: workspace.active_editor_tab_id,
      })),
    };
  }

  #touch(): void {
    this.#revision += 1;
    if (this.#persistState === undefined) return;
    const snapshot = this.#persistedState();
    this.#persistQueue = this.#persistQueue
      .catch(() => undefined)
      .then(() => this.#persistState?.(snapshot))
      .then(() => undefined);
  }
}
