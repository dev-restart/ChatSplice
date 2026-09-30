<script lang="ts">
  import { onMount } from 'svelte';

  import type {
    ActivateEditorTabInput,
    EditorDocument,
    EditorDocumentTarget,
    EditorState,
    EditorTab,
    OpenEditorFileInput,
    UpdateEditorDocumentInput,
  } from '@chatsplice/protocol';

  import type { ChatSpliceBridge } from '../preload/index.js';
  import CodeEditor from './CodeEditor.svelte';
  import { uiText, type UiLocale, type UiTextKey } from './i18n.js';

  type EditorBridge = {
    getEditorState: () => Promise<EditorState>;
    getEditorDocument: (target: EditorDocumentTarget) => Promise<EditorDocument>;
    openEditorFile: (input: OpenEditorFileInput) => Promise<EditorState>;
    activateEditorTab: (input: ActivateEditorTabInput) => Promise<EditorState>;
    updateEditorDocument: (input: UpdateEditorDocumentInput) => Promise<EditorDocument>;
    saveEditorDocument: (target: EditorDocumentTarget) => Promise<EditorDocument>;
    reloadEditorDocument: (target: EditorDocumentTarget) => Promise<EditorDocument>;
    closeEditorTab: (target: EditorDocumentTarget) => Promise<EditorState>;
  };

  type EditorChange = {
    documentId: string;
    content: string;
    dirty: boolean;
  };

  type EditorSave = {
    documentId: string;
    content: string;
    dirty: boolean;
  };

  export let locale: UiLocale;

  const bridge = window.chatsplice as ChatSpliceBridge & EditorBridge;
  const POLL_INTERVAL_MS = 700;
  const EMPTY_STATE = {
    workspace_id: null,
    tabs: [],
    active_editor_tab_id: null,
    open_document_ids: [],
    revision: 0,
  } satisfies EditorState;

  let editorState: EditorState = EMPTY_STATE;
  let activeDocument: EditorDocument | null = null;
  let documentsById = new Map<string, EditorDocument>();
  let latestContentById = new Map<string, string>();
  // Every document mutation shares one queue. This keeps save/close behind the
  // latest draft update while allowing CodeMirror to remain editable during a
  // save request.
  let updateQueues = new Map<string, Promise<unknown>>();
  let updateFailures = new Map<string, unknown>();
  let busyDocumentId = '';
  let editorError = '';
  let destroyed = false;
  let stateRequestSerial = 0;
  let documentRequestSerial = 0;
  let activationSerial = 0;
  let statePollTimer: number | undefined;

  $: t = (key: UiTextKey, values: Record<string, string | number> = {}) =>
    uiText(locale, key, values);
  $: chatActive = editorState.active_editor_tab_id === null;
  $: activeLineCount = activeDocument === null ? 0 : activeDocument.content.split('\n').length;
  $: activeLanguage = activeDocument === null ? '' : languageLabel(activeDocument.path);
  $: codeEditorDocument =
    activeDocument === null || chatActive
      ? null
      : {
          id: activeDocument.editor_tab_id,
          path: activeDocument.path,
          content: activeDocument.content,
          revision: activeDocument.draft_revision,
          dirty: activeDocument.dirty,
        };

  function editorErrorMessage(error: unknown, fallback: string): string {
    if (!(error instanceof Error)) return fallback;
    const message = error.message.trim();
    if (message === '') return fallback;

    const ipcError = message.match(/^Error invoking remote method '[^']+':\s*Error:\s*([\s\S]*)$/);
    if (ipcError?.[1]?.trim()) return ipcError[1].trim();
    if (message.startsWith('Error invoking remote method ')) return fallback;

    return message;
  }

  function isCurrentWorkspace(workspaceId: string): boolean {
    return !destroyed && editorState.workspace_id === workspaceId;
  }

  function isRevisionConflict(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as Error & { code?: unknown }).code;
    return (
      code === 'editor_stale_revision' ||
      error.message.includes('EDITOR_DOCUMENT_REVISION_CONFLICT') ||
      error.message.toLowerCase().includes('revision conflict')
    );
  }

  function targetFor(tab: EditorTab): EditorDocumentTarget {
    return {
      workspace_id: tab.workspace_id,
      editor_tab_id: tab.editor_tab_id,
    };
  }

  function targetForDocument(document: EditorDocument): EditorDocumentTarget {
    return {
      workspace_id: document.workspace_id,
      editor_tab_id: document.editor_tab_id,
    };
  }

  function updateTabFromDocument(document: EditorDocument): void {
    documentsById = new Map(documentsById).set(document.editor_tab_id, document);
    latestContentById = new Map(latestContentById).set(document.editor_tab_id, document.content);
    editorState = {
      ...editorState,
      tabs: editorState.tabs.map((tab) =>
        tab.editor_tab_id === document.editor_tab_id
          ? {
              ...tab,
              dirty: document.dirty,
              draft_revision: document.draft_revision,
              loaded: true,
            }
          : tab,
      ),
    };
    if (
      editorState.active_editor_tab_id === document.editor_tab_id &&
      editorState.workspace_id === document.workspace_id
    ) {
      activeDocument = document;
    }
  }

  function pruneDocumentCaches(openDocumentIds: readonly string[]): void {
    const openIds = new Set(openDocumentIds);
    let documentsChanged = false;
    for (const documentId of documentsById.keys()) {
      if (!openIds.has(documentId)) {
        documentsById.delete(documentId);
        documentsChanged = true;
      }
    }
    if (documentsChanged) documentsById = new Map(documentsById);

    let contentChanged = false;
    for (const documentId of latestContentById.keys()) {
      if (!openIds.has(documentId)) {
        latestContentById.delete(documentId);
        contentChanged = true;
      }
    }
    if (contentChanged) latestContentById = new Map(latestContentById);

    let failuresChanged = false;
    for (const documentId of updateFailures.keys()) {
      if (!openIds.has(documentId)) {
        updateFailures.delete(documentId);
        failuresChanged = true;
      }
    }
    if (failuresChanged) updateFailures = new Map(updateFailures);
  }

  /**
   * Apply a main-process acknowledgement without replacing a newer local
   * draft. The acknowledgement's revision and disk SHA must still advance so
   * the next queued update uses the current optimistic-concurrency token.
   */
  function applyDocumentAcknowledgement(document: EditorDocument): void {
    if (!editorState.open_document_ids.includes(document.editor_tab_id)) return;
    const latestContent = latestContentById.get(document.editor_tab_id);
    const current = documentsById.get(document.editor_tab_id);
    if (latestContent === undefined || latestContent === document.content) {
      updateTabFromDocument(document);
      return;
    }

    updateTabFromDocument({
      ...document,
      content: latestContent,
      dirty: current?.dirty ?? true,
    });
  }

  async function loadDocument(
    workspaceId: string,
    editorTabId: string,
    requestSerial = ++documentRequestSerial,
  ): Promise<void> {
    try {
      const document = await bridge.getEditorDocument({
        workspace_id: workspaceId,
        editor_tab_id: editorTabId,
      });
      if (
        destroyed ||
        requestSerial !== documentRequestSerial ||
        !isCurrentWorkspace(workspaceId) ||
        editorState.active_editor_tab_id !== editorTabId
      ) {
        return;
      }
      updateTabFromDocument(document);
      editorError = '';
    } catch (error) {
      if (
        !destroyed &&
        requestSerial === documentRequestSerial &&
        isCurrentWorkspace(workspaceId) &&
        editorState.active_editor_tab_id === editorTabId
      ) {
        editorError = editorErrorMessage(error, t('editorOpenError'));
      }
    }
  }

  async function applyEditorState(next: EditorState, forceDocument = false): Promise<void> {
    const previousWorkspaceId = editorState.workspace_id;
    const previousTabId = editorState.active_editor_tab_id;
    const previousRevision = editorState.revision;
    const nextTabId = next.active_editor_tab_id;
    const workspaceChanged = previousWorkspaceId !== next.workspace_id;
    const activeTabChanged = previousTabId !== nextTabId;

    if (workspaceChanged) activationSerial += 1;
    editorState = next;
    pruneDocumentCaches(next.open_document_ids);
    editorError = '';
    if (workspaceChanged || activeTabChanged || nextTabId === null) {
      documentRequestSerial += 1;
      activeDocument = null;
    }
    if (next.workspace_id === null || nextTabId === null) return;

    const pendingUpdate = updateQueues.has(nextTabId);
    const currentDocument = documentsById.get(nextTabId);
    const shouldLoad =
      forceDocument ||
      workspaceChanged ||
      activeTabChanged ||
      currentDocument === undefined ||
      (next.revision !== previousRevision && !pendingUpdate);
    if (shouldLoad) {
      await loadDocument(next.workspace_id, nextTabId);
    } else if (currentDocument !== undefined && activeDocument === null) {
      activeDocument = currentDocument;
    }
  }

  async function syncState(forceDocument = false): Promise<void> {
    const requestSerial = ++stateRequestSerial;
    try {
      const next = await bridge.getEditorState();
      if (destroyed || requestSerial !== stateRequestSerial) return;

      const previousRevision = editorState.revision;
      const activeTabId = next.active_editor_tab_id;
      const workspaceChanged = editorState.workspace_id !== next.workspace_id;
      const activeTabChanged = editorState.active_editor_tab_id !== activeTabId;
      if (workspaceChanged || activeTabChanged) {
        activationSerial += 1;
      }
      const revisionChanged = previousRevision !== next.revision;
      const pendingUpdate = activeTabId !== null && updateQueues.has(activeTabId);
      const needsDocument =
        forceDocument ||
        workspaceChanged ||
        activeTabChanged ||
        activeDocument === null ||
        (revisionChanged && !pendingUpdate);

      editorState = next;
      pruneDocumentCaches(next.open_document_ids);
      if (next.workspace_id === null || activeTabId === null) {
        documentRequestSerial += 1;
        activeDocument = null;
        return;
      }
      if (needsDocument) {
        // Keep the live document mounted while refreshing the same tab. A
        // draft revision changes on every edit; clearing here would make
        // CodeEditor tear down its active view and lose IME/focus state.
        if (workspaceChanged || activeTabChanged || activeDocument === null) {
          activeDocument = null;
        }
        await loadDocument(next.workspace_id, activeTabId);
      }
    } catch (error) {
      if (!destroyed && requestSerial === stateRequestSerial) {
        editorError = editorErrorMessage(error, t('editorOpenError'));
      }
    }
  }

  function markLocalChange(change: EditorChange): void {
    const document = documentsById.get(change.documentId) ?? activeDocument;
    if (
      document === undefined ||
      document === null ||
      document.editor_tab_id !== change.documentId ||
      !isCurrentWorkspace(document.workspace_id)
    ) {
      return;
    }

    latestContentById = new Map(latestContentById).set(change.documentId, change.content);
    const nextDocument: EditorDocument = {
      ...document,
      content: change.content,
      dirty: change.dirty,
    };
    documentsById = new Map(documentsById).set(change.documentId, nextDocument);
    activeDocument = nextDocument;
    editorState = {
      ...editorState,
      tabs: editorState.tabs.map((tab) =>
        tab.editor_tab_id === change.documentId
          ? { ...tab, dirty: change.dirty, loaded: true }
          : tab,
      ),
    };
    updateFailures.delete(change.documentId);
    void queueDocumentUpdate(document.workspace_id, change.documentId, change.content);
  }

  function queueDocumentUpdate(
    workspaceId: string,
    editorTabId: string,
    content: string,
  ): Promise<EditorDocument | null> {
    const previous = (updateQueues.get(editorTabId) ?? Promise.resolve()).catch(() => undefined);
    const operation = previous
      .then(async () => {
        // Coalesce keystrokes that arrived while the previous request was in flight.
        if (latestContentById.get(editorTabId) !== content) return null;
        const current = documentsById.get(editorTabId);
        if (current === undefined) return null;
        let result: EditorDocument;
        try {
          result = await bridge.updateEditorDocument({
            workspace_id: workspaceId,
            editor_tab_id: editorTabId,
            expected_revision: current.draft_revision,
            content,
          });
        } catch (error) {
          if (!isRevisionConflict(error)) throw error;
          const resynced = await bridge.getEditorDocument({
            workspace_id: workspaceId,
            editor_tab_id: editorTabId,
          });
          applyDocumentAcknowledgement(resynced);
          if (latestContentById.get(editorTabId) !== content) {
            updateFailures.delete(editorTabId);
            return null;
          }
          const currentAfterResync = documentsById.get(editorTabId);
          if (currentAfterResync === undefined) return null;
          result = await bridge.updateEditorDocument({
            workspace_id: workspaceId,
            editor_tab_id: editorTabId,
            expected_revision: currentAfterResync.draft_revision,
            content,
          });
        }
        applyDocumentAcknowledgement(result);
        return result;
      })
      .catch((error: unknown) => {
        updateFailures.set(editorTabId, error);
        if (!destroyed && isCurrentWorkspace(workspaceId)) {
          editorError = editorErrorMessage(error, t('editorSaveError'));
        }
        return null;
      });
    updateQueues = new Map(updateQueues).set(editorTabId, operation);
    const cleanup = (): void => {
      if (updateQueues.get(editorTabId) === operation) {
        const nextQueues = new Map(updateQueues);
        nextQueues.delete(editorTabId);
        updateQueues = nextQueues;
      }
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  async function saveDocument(target: EditorDocumentTarget): Promise<EditorDocument> {
    const previous = (updateQueues.get(target.editor_tab_id) ?? Promise.resolve()).catch(
      () => undefined,
    );
    const operation = previous.then(async () => {
      const failure = updateFailures.get(target.editor_tab_id);
      if (failure !== undefined) {
        updateFailures.delete(target.editor_tab_id);
        throw failure;
      }

      const latest = latestContentById.get(target.editor_tab_id);
      const current = documentsById.get(target.editor_tab_id);
      if (latest !== undefined && current !== undefined && latest !== current.content) {
        const updated = await bridge.updateEditorDocument({
          workspace_id: target.workspace_id,
          editor_tab_id: target.editor_tab_id,
          expected_revision: current.draft_revision,
          content: latest,
        });
        applyDocumentAcknowledgement(updated);
      }

      // Registering this operation in the same per-document queue means any
      // typing that arrives while save is in flight is sent after the save.
      const saved = await bridge.saveEditorDocument(target);
      applyDocumentAcknowledgement(saved);
      if (isCurrentWorkspace(target.workspace_id)) {
        editorError = '';
      }
      return saved;
    });
    updateQueues = new Map(updateQueues).set(target.editor_tab_id, operation);
    const cleanup = (): void => {
      if (updateQueues.get(target.editor_tab_id) === operation) {
        const nextQueues = new Map(updateQueues);
        nextQueues.delete(target.editor_tab_id);
        updateQueues = nextQueues;
      }
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  async function handleSave(event: EditorSave): Promise<void> {
    const document = documentsById.get(event.documentId) ?? activeDocument;
    if (
      document === undefined ||
      document === null ||
      document.editor_tab_id !== event.documentId
    ) {
      return;
    }
    if (event.content !== document.content) {
      markLocalChange(event);
    }
    const target = targetForDocument(document);
    try {
      busyDocumentId = event.documentId;
      await saveDocument(target);
    } catch (error) {
      if (!destroyed && isCurrentWorkspace(document.workspace_id)) {
        editorError = editorErrorMessage(error, t('editorSaveError'));
      }
    } finally {
      if (busyDocumentId === event.documentId) busyDocumentId = '';
    }
  }

  async function saveActiveDocument(): Promise<void> {
    const document = activeDocument;
    if (document === null || !document.dirty || busyDocumentId !== '') return;
    const target = targetForDocument(document);
    try {
      busyDocumentId = document.editor_tab_id;
      await saveDocument(target);
    } catch (error) {
      if (!destroyed && isCurrentWorkspace(document.workspace_id)) {
        editorError = editorErrorMessage(error, t('editorSaveError'));
      }
    } finally {
      if (busyDocumentId === document.editor_tab_id) busyDocumentId = '';
    }
  }

  function isEditorCancelled(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as Error & { code?: unknown }).code;
    return code === 'editor_cancelled' || editorErrorMessage(error, '') === '작업을 취소했습니다.';
  }

  async function reloadDocument(target: EditorDocumentTarget): Promise<EditorDocument> {
    const previous = (updateQueues.get(target.editor_tab_id) ?? Promise.resolve()).catch(
      () => undefined,
    );
    const operation = previous.then(async () => {
      const failure = updateFailures.get(target.editor_tab_id);
      if (failure !== undefined) {
        updateFailures.delete(target.editor_tab_id);
        throw failure;
      }
      const requestedContent = latestContentById.get(target.editor_tab_id);
      const reloaded = await bridge.reloadEditorDocument(target);
      if (latestContentById.get(target.editor_tab_id) === requestedContent) {
        latestContentById = new Map(latestContentById).set(target.editor_tab_id, reloaded.content);
        updateTabFromDocument(reloaded);
      } else {
        applyDocumentAcknowledgement(reloaded);
      }
      if (isCurrentWorkspace(target.workspace_id)) {
        editorError = '';
      }
      return reloaded;
    });
    updateQueues = new Map(updateQueues).set(target.editor_tab_id, operation);
    const cleanup = (): void => {
      if (updateQueues.get(target.editor_tab_id) === operation) {
        const next = new Map(updateQueues);
        next.delete(target.editor_tab_id);
        updateQueues = next;
      }
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  async function reloadActiveDocument(): Promise<void> {
    const document = activeDocument;
    if (document === null || busyDocumentId !== '') return;
    try {
      busyDocumentId = document.editor_tab_id;
      await reloadDocument(targetForDocument(document));
    } catch (error) {
      if (!isEditorCancelled(error) && !destroyed && isCurrentWorkspace(document.workspace_id)) {
        editorError = editorErrorMessage(error, t('editorOpenError'));
      }
    } finally {
      if (busyDocumentId === document.editor_tab_id) busyDocumentId = '';
    }
  }

  async function activateTab(editorTabId: string | null): Promise<void> {
    const workspaceId = editorState.workspace_id;
    if (workspaceId === null) return;
    const requestWorkspaceId = workspaceId;
    const requestSerial = ++activationSerial;
    try {
      const next = await bridge.activateEditorTab({
        workspace_id: requestWorkspaceId,
        editor_tab_id: editorTabId,
      });
      if (!isCurrentWorkspace(requestWorkspaceId) || requestSerial !== activationSerial) return;
      await applyEditorState(next, editorTabId !== null);
    } catch (error) {
      if (!destroyed && isCurrentWorkspace(requestWorkspaceId)) {
        editorError = editorErrorMessage(error, t('editorOpenError'));
      }
    }
  }

  function requestClose(tab: EditorTab): void {
    if (busyDocumentId !== '') return;
    void closeDocument(targetFor(tab));
  }

  async function closeDocument(target: EditorDocumentTarget): Promise<void> {
    if (editorState.workspace_id !== target.workspace_id) return;
    busyDocumentId = target.editor_tab_id;
    const previous = (updateQueues.get(target.editor_tab_id) ?? Promise.resolve()).catch(
      () => undefined,
    );
    const operation = previous.then(async () => {
      const failure = updateFailures.get(target.editor_tab_id);
      if (failure !== undefined) {
        updateFailures.delete(target.editor_tab_id);
        throw failure;
      }
      return bridge.closeEditorTab(target);
    });
    updateQueues = new Map(updateQueues).set(target.editor_tab_id, operation);
    const cleanup = (): void => {
      if (updateQueues.get(target.editor_tab_id) === operation) {
        const next = new Map(updateQueues);
        next.delete(target.editor_tab_id);
        updateQueues = next;
      }
    };
    void operation.then(cleanup, cleanup);
    try {
      const next = await operation;
      if (!isCurrentWorkspace(target.workspace_id)) return;
      await applyEditorState(next, true);
    } catch (error) {
      if (!isEditorCancelled(error) && !destroyed && isCurrentWorkspace(target.workspace_id)) {
        editorError = editorErrorMessage(error, t('editorSaveError'));
      }
    } finally {
      if (busyDocumentId === target.editor_tab_id) busyDocumentId = '';
    }
  }

  function languageLabel(path: string): string {
    const extension = path.split('.').at(-1)?.toLowerCase() ?? '';
    const labels: Record<string, string> = {
      c: 'C',
      cpp: 'C++',
      css: 'CSS',
      go: 'Go',
      html: 'HTML',
      java: 'Java',
      js: 'JavaScript',
      json: 'JSON',
      md: 'Markdown',
      py: 'Python',
      rs: 'Rust',
      svelte: 'Svelte',
      ts: 'TypeScript',
      tsx: 'TSX',
      vue: 'Vue',
      yaml: 'YAML',
      yml: 'YAML',
    };
    return labels[extension] ?? (extension === '' ? 'Plain text' : extension.toUpperCase());
  }

  onMount(() => {
    void syncState(true);
    statePollTimer = window.setInterval(() => void syncState(), POLL_INTERVAL_MS);
    return () => {
      destroyed = true;
      stateRequestSerial += 1;
      documentRequestSerial += 1;
      if (statePollTimer !== undefined) window.clearInterval(statePollTimer);
    };
  });
</script>

<main class="native-surface editor-surface" class:editor-chat-active={chatActive}>
  <nav class="editor-tabstrip" aria-label={t('editorTabList')}>
    <button
      type="button"
      class:active={chatActive}
      class="editor-tab editor-chat-tab"
      onclick={() => void activateTab(null)}
      aria-current={chatActive ? 'page' : undefined}
      title={t('editorChatTab')}
    >
      <span class="editor-chat-mark" aria-hidden="true">⌘</span>
      <span>{t('editorChatTab')}</span>
    </button>

    {#each editorState.tabs as tab (tab.editor_tab_id)}
      <div class:active={editorState.active_editor_tab_id === tab.editor_tab_id} class="editor-tab">
        <button
          type="button"
          class="editor-tab-main"
          onclick={() => void activateTab(tab.editor_tab_id)}
          aria-current={editorState.active_editor_tab_id === tab.editor_tab_id ? 'page' : undefined}
          title={tab.path}
        >
          <span class="editor-file-mark" aria-hidden="true">•</span>
          <span class="editor-tab-label">{tab.label}</span>
          {#if tab.dirty}<span class="editor-dirty-dot" aria-label={t('editorDirty')}></span>{/if}
        </button>
        <button
          type="button"
          class="editor-tab-close"
          onclick={(event) => {
            event.stopPropagation();
            requestClose(tab);
          }}
          aria-label={`${t('closeTab')} ${tab.label}`}
          title={t('closeTab')}
          disabled={busyDocumentId === tab.editor_tab_id}
        >
          ×
        </button>
      </div>
    {/each}
  </nav>

  {#if editorState.workspace_id === null}
    <section class="editor-empty" aria-live="polite">{t('editorChooseProject')}</section>
  {:else if !chatActive && activeDocument === null}
    <section class="editor-empty" aria-live="polite">{t('filesLoading')}</section>
  {:else if activeDocument !== null && !chatActive}
    <header class="editor-document-header">
      <code title={activeDocument.path}>{activeDocument.path}</code>
      <div class="editor-document-actions">
        {#if activeDocument.dirty}
          <span class="editor-dirty-label">{t('editorDirty')}</span>
        {:else}
          <span class="editor-clean-label">{t('editorSaved')}</span>
        {/if}
        <button
          type="button"
          class="editor-save-button"
          onclick={() => void saveActiveDocument()}
          disabled={!activeDocument.dirty || busyDocumentId !== ''}
        >
          {busyDocumentId === activeDocument.editor_tab_id ? t('editorSaving') : t('editorSave')}
        </button>
        <button
          type="button"
          class="editor-secondary-button"
          onclick={() => void reloadActiveDocument()}
          disabled={busyDocumentId !== ''}
        >
          {busyDocumentId === activeDocument.editor_tab_id
            ? t('editorReloading')
            : t('editorReload')}
        </button>
      </div>
    </header>
  {/if}

  {#if editorError !== '' && !chatActive}<p class="editor-error" role="alert">{editorError}</p>{/if}

  <div class:editor-content-hidden={codeEditorDocument === null} class="editor-content">
    <CodeEditor
      activeDocument={codeEditorDocument}
      openDocumentIds={editorState.open_document_ids}
      maxCachedDocuments={48}
      readOnly={false}
      {locale}
      onChange={markLocalChange}
      onSave={handleSave}
    />
  </div>

  {#if activeDocument !== null && !chatActive}
    <footer class="editor-statusbar">
      <span>{activeLanguage}</span>
      <span>UTF-8</span>
      <span>{activeLineCount} {t('editorLines')}</span>
      <span>{activeDocument.dirty ? t('editorDirty') : t('editorSaved')}</span>
    </footer>
  {/if}
</main>

<style>
  .editor-surface {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    overflow: hidden;
    background: var(--color-bg);
    color: var(--color-text);
  }

  .editor-tabstrip {
    display: flex;
    min-width: 0;
    min-height: 36px;
    flex: 0 0 36px;
    align-items: stretch;
    gap: 1px;
    overflow-x: auto;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface-muted);
    scrollbar-width: thin;
  }

  .editor-tab {
    display: flex;
    min-width: 0;
    max-width: 240px;
    align-items: stretch;
    border: 0;
    border-right: 1px solid var(--color-border);
    background: transparent;
    color: var(--color-text-muted);
    font-size: 12px;
  }

  .editor-tab.active {
    background: var(--color-surface);
    color: var(--color-text);
    box-shadow: inset 0 -2px var(--color-focus);
  }

  .editor-tab-main,
  .editor-chat-tab {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 6px;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
  }

  .editor-tab-main {
    flex: 1;
    padding: 0 8px;
    text-align: left;
  }

  .editor-chat-tab {
    flex: 0 0 auto;
    padding: 0 12px;
  }

  .editor-tab-main:hover,
  .editor-chat-tab:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .editor-tab-main:focus-visible,
  .editor-chat-tab:focus-visible,
  .editor-tab-close:focus-visible,
  .editor-save-button:focus-visible,
  .editor-secondary-button:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: -2px;
  }

  .editor-tab-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .editor-file-mark,
  .editor-chat-mark {
    flex: 0 0 auto;
    color: var(--color-focus);
    font-size: 13px;
    line-height: 1;
  }

  .editor-chat-mark {
    font-size: 12px;
  }

  .editor-dirty-dot {
    width: 6px;
    height: 6px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: var(--color-warn);
  }

  .editor-tab-close {
    display: grid;
    width: 26px;
    flex: 0 0 26px;
    place-items: center;
    border: 0;
    background: transparent;
    color: var(--color-text-muted);
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
  }

  .editor-tab-close:hover:not(:disabled) {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .editor-tab-close:disabled {
    cursor: default;
    opacity: 0.45;
  }

  .editor-content-hidden {
    display: none;
  }

  .editor-document-header {
    display: flex;
    min-width: 0;
    min-height: 34px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface);
    padding: 0 10px;
  }

  .editor-document-header code {
    min-width: 0;
    overflow: hidden;
    color: var(--color-text-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .editor-document-actions,
  .editor-statusbar {
    display: flex;
    align-items: center;
  }

  .editor-document-actions {
    flex: 0 0 auto;
    gap: 8px;
  }

  .editor-dirty-label,
  .editor-clean-label {
    color: var(--color-text-muted);
    font-size: 10px;
  }

  .editor-dirty-label {
    color: var(--color-warn);
  }

  .editor-save-button,
  .editor-secondary-button {
    min-height: 25px;
    border: 1px solid var(--color-border-strong);
    border-radius: 5px;
    padding: 0 9px;
    font-size: 11px;
    cursor: pointer;
  }

  .editor-save-button {
    border-color: var(--color-focus);
    background: var(--color-focus);
    color: var(--color-focus-contrast, #101318);
  }

  .editor-secondary-button {
    background: var(--color-surface-muted);
    color: var(--color-text);
  }

  .editor-save-button:disabled {
    cursor: default;
    opacity: 0.45;
  }

  .editor-error {
    flex: 0 0 auto;
    margin: 0;
    border-bottom: 1px solid var(--color-error-fg);
    background: color-mix(in srgb, var(--color-error-fg) 10%, transparent);
    padding: 5px 10px;
    color: var(--color-error-fg);
    font-size: 11px;
  }

  .editor-content {
    min-width: 0;
    min-height: 0;
    flex: 1;
    overflow: hidden;
  }

  .editor-statusbar {
    min-height: 23px;
    flex: 0 0 23px;
    justify-content: flex-end;
    gap: 12px;
    border-top: 1px solid var(--color-border);
    background: var(--color-surface-muted);
    padding: 0 9px;
    color: var(--color-text-muted);
    font-size: 10px;
  }

  .editor-empty {
    display: grid;
    min-height: 0;
    flex: 1;
    place-items: center;
    color: var(--color-text-muted);
    font-size: 12px;
  }
</style>
