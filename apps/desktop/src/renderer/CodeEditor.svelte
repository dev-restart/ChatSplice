<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  import { Compartment, EditorState, type Extension } from '@codemirror/state';
  import { defaultKeymap, history, historyKeymap, redo, undo } from '@codemirror/commands';
  import {
    bracketMatching,
    HighlightStyle,
    indentOnInput,
    syntaxHighlighting,
  } from '@codemirror/language';
  import {
    highlightSelectionMatches,
    openSearchPanel,
    search,
    searchKeymap,
  } from '@codemirror/search';
  import {
    drawSelection,
    dropCursor,
    EditorView,
    highlightActiveLine,
    highlightActiveLineGutter,
    highlightSpecialChars,
    keymap,
    lineNumbers,
    type ViewUpdate,
  } from '@codemirror/view';
  import { tags } from '@lezer/highlight';

  import type {
    CodeEditorChange,
    CodeEditorDocument,
    CodeEditorSave,
  } from './code-editor-types.js';
  import {
    codeEditorDocumentText,
    createCodeEditorState,
    shouldAdoptCodeEditorBaseline,
    shouldReplaceCodeEditorState,
  } from './editor-state.js';
  import { codeEditorLanguageExtension, codeEditorLanguageForPath } from './editor-language.js';
  import type { UiLocale } from './i18n.js';

  /**
   * CodeMirror's themes and highlighters use style-mod to mount scoped style
   * elements. This component is intended for the owner-controlled local editor
   * surface, whose CSP may allow those styles. It is never mounted in ChatGPT's
   * remote webContents and never renders document content as HTML.
   */

  export let activeDocument: CodeEditorDocument | null = null;
  export let openDocumentIds: readonly string[] = [];
  export let maxCachedDocuments = 48;
  export let readOnly = false;
  export let locale: UiLocale = 'en';
  export let onChange: (event: CodeEditorChange) => void = () => undefined;
  export let onSave: (event: CodeEditorSave) => void = () => undefined;

  type CachedEditor = {
    state: EditorState;
    language: string;
    languageCompartment: Compartment;
    readOnlyCompartment: Compartment;
    readOnly: boolean;
    lastUsedAt: number;
  };

  const monoFont =
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

  const editorTheme = EditorView.theme({
    '&': {
      height: '100%',
      color: 'var(--color-text, #0d0d0d)',
      backgroundColor: 'var(--color-surface, #ffffff)',
      fontFamily: monoFont,
      fontSize: '13px',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: monoFont,
    },
    '.cm-content': {
      minHeight: '100%',
      padding: '10px 0 18px',
      caretColor: 'var(--color-focus, #2563eb)',
    },
    '.cm-line': {
      padding: '0 14px',
    },
    '.cm-gutters': {
      minWidth: '42px',
      borderRight: '1px solid var(--color-border, #e5e5e5)',
      backgroundColor: 'var(--color-surface-muted, #f6f6f6)',
      color: 'var(--color-text-subtle, #6b6b6b)',
    },
    '.cm-activeLine': {
      backgroundColor: 'var(--color-hover, #ececec)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--color-selected, #e8e8e8)',
      color: 'var(--color-text, #0d0d0d)',
    },
    '.cm-selectionBackground, ::selection': {
      backgroundColor: 'var(--color-selected, #e8e8e8)',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--color-focus, #2563eb)',
    },
    '.cm-panels': {
      backgroundColor: 'var(--color-surface-muted, #f6f6f6)',
      color: 'var(--color-text, #0d0d0d)',
      borderBottom: '1px solid var(--color-border, #e5e5e5)',
    },
    '.cm-panels input, .cm-panels button': {
      fontFamily: 'inherit',
      fontSize: '12px',
    },
    '.cm-panels input': {
      border: '1px solid var(--color-border-strong, #d5d5d5)',
      borderRadius: '4px',
      backgroundColor: 'var(--color-surface, #ffffff)',
      color: 'var(--color-text, #0d0d0d)',
    },
    '.cm-tooltip': {
      border: '1px solid var(--color-border-strong, #d5d5d5)',
      backgroundColor: 'var(--color-surface, #ffffff)',
      color: 'var(--color-text, #0d0d0d)',
    },
  });

  const editorHighlightStyle = HighlightStyle.define([
    {
      tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
      color: 'var(--color-text-subtle, #6b6b6b)',
      fontStyle: 'italic',
    },
    {
      tag: [
        tags.keyword,
        tags.controlKeyword,
        tags.operatorKeyword,
        tags.definitionKeyword,
        tags.moduleKeyword,
        tags.modifier,
      ],
      color: 'var(--color-link, #2563eb)',
      fontWeight: '600',
    },
    {
      tag: [tags.string, tags.docString, tags.character, tags.attributeValue],
      color: 'var(--color-ok, #16a34a)',
    },
    {
      tag: [tags.number, tags.integer, tags.float, tags.bool, tags.atom, tags.unit],
      color: 'var(--color-warn, #a16207)',
    },
    {
      tag: [tags.regexp, tags.escape],
      color: 'var(--color-running, #2563eb)',
    },
    {
      tag: [tags.typeName, tags.className, tags.namespace, tags.macroName],
      color: 'var(--color-focus, #2563eb)',
    },
    {
      tag: [tags.propertyName, tags.attributeName, tags.labelName],
      color: 'var(--color-text, #0d0d0d)',
    },
    {
      tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket],
      color: 'var(--color-text-muted, #5f5f5f)',
    },
    {
      tag: [tags.invalid, tags.meta, tags.annotation, tags.processingInstruction],
      color: 'var(--color-bad, #dc2626)',
    },
  ]);

  let editorHost: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  let activeDocumentId = '';
  let activeDirty = false;
  let mounted = false;
  let destroyed = false;
  let suppressUpdates = 0;
  let usageClock = 0;
  let lastSynchronizedDocument: CodeEditorDocument | null | undefined;
  const cachedEditors = new Map<string, CachedEditor>();
  const baseContentById = new Map<string, string | undefined>();
  const revisionById = new Map<string, number | undefined>();

  $: activeLanguage =
    activeDocument === null
      ? 'plaintext'
      : codeEditorLanguageForPath(activeDocument.path, activeDocument.language);

  // Svelte reruns this when the container changes the active document, the open
  // tab set, or editability. The guards below prevent a parent acknowledgement
  // of the current draft from replacing the live EditorState.
  $: if (mounted) synchronizeInput(activeDocument, readOnly, openDocumentIds);

  function localized(en: string, ko: string): string {
    return locale === 'ko' ? ko : en;
  }

  function isDirty(documentId: string, state: EditorState): boolean {
    const baseContent = baseContentById.get(documentId);
    return baseContent === undefined || codeEditorDocumentText(state) !== baseContent;
  }

  function readOnlyExtensions(value: boolean): Extension {
    return value ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];
  }

  function createCachedEditor(document: CodeEditorDocument, nextReadOnly: boolean): CachedEditor {
    const language = codeEditorLanguageForPath(document.path, document.language);
    const languageCompartment = new Compartment();
    const readOnlyCompartment = new Compartment();
    const state = createCodeEditorState(document.content, [
      editorTheme,
      syntaxHighlighting(editorHighlightStyle),
      lineNumbers(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      highlightSelectionMatches(),
      search(),
      languageCompartment.of(codeEditorLanguageExtension(document.path, document.language)),
      readOnlyCompartment.of(readOnlyExtensions(nextReadOnly)),
      keymap.of([
        {
          key: 'Mod-s',
          run: saveCommand,
          preventDefault: true,
        },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
      ]),
      EditorView.updateListener.of((update) => handleViewUpdate(document.id, update)),
    ]);
    const entry: CachedEditor = {
      state,
      language,
      languageCompartment,
      readOnlyCompartment,
      readOnly: nextReadOnly,
      lastUsedAt: ++usageClock,
    };
    baseContentById.set(document.id, document.dirty === true ? undefined : document.content);
    revisionById.set(document.id, document.revision);
    cachedEditors.set(document.id, entry);
    return entry;
  }

  function saveActiveState(): void {
    if (view === undefined || activeDocumentId === '') return;
    const entry = cachedEditors.get(activeDocumentId);
    if (entry === undefined) return;
    entry.state = view.state;
    entry.lastUsedAt = ++usageClock;
    cachedEditors.set(activeDocumentId, entry);
  }

  function destroyActiveView(): void {
    saveActiveState();
    view?.destroy();
    view = undefined;
    activeDocumentId = '';
    activeDirty = false;
    lastSynchronizedDocument = null;
  }

  function installEditorState(entry: CachedEditor): void {
    suppressUpdates += 1;
    try {
      if (view === undefined) {
        if (editorHost === undefined) return;
        view = new EditorView({ state: entry.state, parent: editorHost });
      } else {
        view.setState(entry.state);
      }
    } finally {
      suppressUpdates -= 1;
    }
    entry.state = view.state;
    entry.lastUsedAt = ++usageClock;
  }

  function replaceCachedEditor(document: CodeEditorDocument, nextReadOnly: boolean): CachedEditor {
    const entry = createCachedEditor(document, nextReadOnly);
    activeDocumentId = document.id;
    activeDirty = false;
    installEditorState(entry);
    return entry;
  }

  function switchDocument(document: CodeEditorDocument, nextReadOnly: boolean): void {
    saveActiveState();
    let entry = cachedEditors.get(document.id);
    if (entry === undefined) {
      entry = createCachedEditor(document, nextReadOnly);
    } else {
      const currentContent = codeEditorDocumentText(entry.state);
      const entryDirty = isDirty(document.id, entry.state);
      if (
        shouldReplaceCodeEditorState({
          currentContent,
          incomingContent: document.content,
          currentDirty: entryDirty,
          incomingDirty: document.dirty,
          incomingRevision: document.revision,
          knownRevision: revisionById.get(document.id),
        })
      ) {
        entry = replaceCachedEditor(document, nextReadOnly);
      } else if (
        shouldAdoptCodeEditorBaseline({
          currentContent,
          incomingContent: document.content,
          currentDirty: entryDirty,
          incomingDirty: document.dirty,
          incomingRevision: document.revision,
          knownRevision: revisionById.get(document.id),
        })
      ) {
        baseContentById.set(document.id, document.content);
      }
    }

    revisionById.set(document.id, document.revision);
    activeDocumentId = document.id;
    if (view === undefined || view.state !== entry.state) installEditorState(entry);
    syncEditorConfiguration(entry, document, nextReadOnly);
    activeDirty = isDirty(document.id, view?.state ?? entry.state);
    lastSynchronizedDocument = document;
  }

  function syncEditorConfiguration(
    entry: CachedEditor,
    document: CodeEditorDocument,
    nextReadOnly: boolean,
  ): void {
    if (view === undefined) return;
    const language = codeEditorLanguageForPath(document.path, document.language);
    if (entry.language !== language) {
      suppressUpdates += 1;
      try {
        view.dispatch({
          effects: entry.languageCompartment.reconfigure(
            codeEditorLanguageExtension(document.path, document.language),
          ),
        });
      } finally {
        suppressUpdates -= 1;
      }
      entry.language = language;
    }
    if (entry.readOnly !== nextReadOnly) {
      suppressUpdates += 1;
      try {
        view.dispatch({
          effects: entry.readOnlyCompartment.reconfigure(readOnlyExtensions(nextReadOnly)),
        });
      } finally {
        suppressUpdates -= 1;
      }
      entry.readOnly = nextReadOnly;
    }
    entry.state = view.state;
    entry.lastUsedAt = ++usageClock;
    cachedEditors.set(document.id, entry);
  }

  function synchronizeCurrentDocument(document: CodeEditorDocument, nextReadOnly: boolean): void {
    const entry = cachedEditors.get(document.id);
    if (entry === undefined || view === undefined) {
      switchDocument(document, nextReadOnly);
      return;
    }

    const currentContent = codeEditorDocumentText(view.state);
    const currentDirty = isDirty(document.id, view.state);
    if (
      shouldReplaceCodeEditorState({
        currentContent,
        incomingContent: document.content,
        currentDirty,
        incomingDirty: document.dirty,
        incomingRevision: document.revision,
        knownRevision: revisionById.get(document.id),
      })
    ) {
      replaceCachedEditor(document, nextReadOnly);
      syncEditorConfiguration(cachedEditors.get(document.id)!, document, nextReadOnly);
    } else if (
      shouldAdoptCodeEditorBaseline({
        currentContent,
        incomingContent: document.content,
        currentDirty,
        incomingDirty: document.dirty,
        incomingRevision: document.revision,
        knownRevision: revisionById.get(document.id),
      })
    ) {
      // A save acknowledgement keeps the same EditorState so its undo and
      // selection survive, while moving the clean baseline to this content.
      baseContentById.set(document.id, document.content);
      activeDirty = false;
    }
    revisionById.set(document.id, document.revision);
    syncEditorConfiguration(cachedEditors.get(document.id)!, document, nextReadOnly);
    activeDirty = isDirty(document.id, view.state);
    lastSynchronizedDocument = document;
  }

  function synchronizeInput(
    document: CodeEditorDocument | null,
    nextReadOnly: boolean,
    nextOpenDocumentIds: readonly string[],
  ): void {
    if (destroyed) return;
    if (editorHost === undefined) {
      if (view !== undefined) destroyActiveView();
      pruneCache(nextOpenDocumentIds);
      return;
    }
    if (document === null || document.id === '') {
      if (view !== undefined) destroyActiveView();
      pruneCache(nextOpenDocumentIds);
      lastSynchronizedDocument = document;
      return;
    }

    if (document.id !== activeDocumentId || view === undefined) {
      switchDocument(document, nextReadOnly);
    } else if (document !== lastSynchronizedDocument) {
      synchronizeCurrentDocument(document, nextReadOnly);
    } else {
      const entry = cachedEditors.get(document.id);
      if (entry !== undefined) syncEditorConfiguration(entry, document, nextReadOnly);
    }
    pruneCache(nextOpenDocumentIds, document.id);
  }

  function pruneCache(openIds: readonly string[], keepActiveId = activeDocumentId): void {
    const keep = new Set(openIds);
    if (keepActiveId !== '') keep.add(keepActiveId);
    for (const id of cachedEditors.keys()) {
      if (!keep.has(id)) removeCachedDocument(id);
    }

    const capacity = Number.isFinite(maxCachedDocuments)
      ? Math.max(1, Math.floor(maxCachedDocuments))
      : 48;
    while (cachedEditors.size > capacity) {
      let oldestId: string | undefined;
      let oldestUse = Number.POSITIVE_INFINITY;
      for (const [id, entry] of cachedEditors) {
        if (id === keepActiveId) continue;
        if (entry.lastUsedAt < oldestUse) {
          oldestId = id;
          oldestUse = entry.lastUsedAt;
        }
      }
      if (oldestId === undefined) break;
      removeCachedDocument(oldestId);
    }
  }

  function removeCachedDocument(documentId: string): void {
    if (documentId === activeDocumentId && view !== undefined) return;
    cachedEditors.delete(documentId);
    baseContentById.delete(documentId);
    revisionById.delete(documentId);
  }

  export function disposeDocument(documentId: string): void {
    if (documentId === activeDocumentId) {
      destroyActiveView();
    }
    removeCachedDocument(documentId);
  }

  /** Drop inactive EditorState snapshots while keeping the visible editor live. */
  export function clearDocumentCache(): void {
    saveActiveState();
    const activeId = activeDocumentId;
    for (const id of cachedEditors.keys()) {
      if (id !== activeId) removeCachedDocument(id);
    }
  }

  function handleViewUpdate(documentId: string, update: ViewUpdate): void {
    const entry = cachedEditors.get(documentId);
    if (entry !== undefined) {
      entry.state = update.state;
      entry.lastUsedAt = ++usageClock;
      cachedEditors.set(documentId, entry);
    }
    if (suppressUpdates > 0 || !update.docChanged || documentId !== activeDocumentId) return;
    const document = activeDocument;
    if (document === null || document.id !== documentId) return;
    activeDirty = isDirty(documentId, update.state);
    onChange({
      documentId,
      content: codeEditorDocumentText(update.state),
      dirty: activeDirty,
    });
  }

  function saveCommand(target: EditorView): boolean {
    if (target !== view) return false;
    requestSave();
    return true;
  }

  function requestSave(): void {
    if (
      readOnly ||
      view === undefined ||
      activeDocument === null ||
      activeDocument.id !== activeDocumentId
    ) {
      return;
    }
    const content = codeEditorDocumentText(view.state);
    onSave({
      documentId: activeDocument.id,
      content,
      dirty: isDirty(activeDocument.id, view.state),
    });
  }

  function runCommand(command: (target: EditorView) => boolean): void {
    if (view !== undefined) command(view);
  }

  onMount(() => {
    mounted = true;
    synchronizeInput(activeDocument, readOnly, openDocumentIds);
  });

  onDestroy(() => {
    destroyed = true;
    saveActiveState();
    view?.destroy();
    view = undefined;
    cachedEditors.clear();
    baseContentById.clear();
    revisionById.clear();
  });
</script>

<section
  class="code-editor-shell"
  aria-label={localized('Code editor', '코드 편집기')}
  data-document-id={activeDocument?.id ?? undefined}
>
  {#if activeDocument !== null}
    <header class="code-editor-toolbar">
      <div class="code-editor-document" title={activeDocument.path}>
        <code>{activeDocument.path}</code>
        {#if activeDirty}<span
            class="code-editor-dirty"
            aria-label={localized('Unsaved changes', '저장되지 않은 변경')}>*</span
          >{/if}
        <span class="code-editor-language">{activeLanguage}</span>
      </div>
      <div class="code-editor-actions" aria-label={localized('Editor actions', '편집기 작업')}>
        <button
          type="button"
          class="code-editor-action"
          aria-label={localized('Undo', '실행 취소')}
          title={localized('Undo', '실행 취소')}
          disabled={readOnly || view === undefined}
          onclick={() => runCommand(undo)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true"
            ><path d="M8 5 3.5 9 8 13" /><path d="M4 9h7a5.5 5.5 0 0 1 5.5 5.5" /></svg
          >
        </button>
        <button
          type="button"
          class="code-editor-action"
          aria-label={localized('Redo', '다시 실행')}
          title={localized('Redo', '다시 실행')}
          disabled={readOnly || view === undefined}
          onclick={() => runCommand(redo)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true"
            ><path d="m12 5 4.5 4-4.5 4" /><path d="M16 9H9a5.5 5.5 0 0 0-5.5 5.5" /></svg
          >
        </button>
        <button
          type="button"
          class="code-editor-action"
          aria-label={localized('Find', '찾기')}
          title={localized('Find (⌘/Ctrl+F)', '찾기 (⌘/Ctrl+F)')}
          disabled={view === undefined}
          onclick={() => view && openSearchPanel(view)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true"
            ><circle cx="8.8" cy="8.8" r="5.3" /><path d="m12.7 12.7 4 4" /></svg
          >
        </button>
        <button
          type="button"
          class="code-editor-action save"
          aria-label={localized('Save (⌘/Ctrl+S)', '저장 (⌘/Ctrl+S)')}
          title={localized('Save (⌘/Ctrl+S)', '저장 (⌘/Ctrl+S)')}
          disabled={readOnly || view === undefined || !activeDirty}
          onclick={requestSave}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true"
            ><path d="M4 3.5h9.7l2.3 2.3v10.7H4z" /><path
              d="M6.5 3.5v5h6v-5M6.5 16.5v-4h7v4"
            /></svg
          >
        </button>
      </div>
    </header>
  {:else}
    <div class="code-editor-empty" role="status">
      {localized('Choose a file from the project tree.', '프로젝트 트리에서 파일을 선택하세요.')}
    </div>
  {/if}
  <!-- Keep the binding stable while the parent temporarily has no active document. -->
  <div
    class="code-editor-viewport"
    class:code-editor-viewport-hidden={activeDocument === null}
    aria-hidden={activeDocument === null ? 'true' : undefined}
    bind:this={editorHost}
  ></div>
</section>

<style>
  .code-editor-shell {
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    overflow: hidden;
    background: var(--color-surface, #ffffff);
    color: var(--color-text, #0d0d0d);
  }

  .code-editor-toolbar {
    display: flex;
    min-height: 31px;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    border-bottom: 1px solid var(--color-border, #e5e5e5);
    padding: 3px 6px 3px 11px;
    background: var(--color-surface-muted, #f6f6f6);
    font-size: 11px;
  }

  .code-editor-document {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 5px;
  }

  .code-editor-document code {
    overflow: hidden;
    min-width: 0;
    color: var(--color-text, #0d0d0d);
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .code-editor-dirty {
    color: var(--color-warn, #a16207);
    font-size: 14px;
    font-weight: 700;
    line-height: 1;
  }

  .code-editor-language {
    flex: none;
    color: var(--color-text-subtle, #6b6b6b);
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
    font-size: 10px;
    text-transform: uppercase;
  }

  .code-editor-actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: 2px;
  }

  .code-editor-action {
    display: grid;
    width: 24px;
    height: 24px;
    place-items: center;
    border: 1px solid transparent;
    border-radius: 5px;
    padding: 0;
    background: transparent;
    color: var(--color-text-muted, #5f5f5f);
    cursor: pointer;
  }

  .code-editor-action:hover:not(:disabled) {
    border-color: var(--color-border, #e5e5e5);
    background: var(--color-hover, #ececec);
    color: var(--color-text, #0d0d0d);
  }

  .code-editor-action.save:not(:disabled) {
    color: var(--color-focus, #2563eb);
  }

  .code-editor-action svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.5;
  }

  .code-editor-viewport {
    min-width: 0;
    min-height: 0;
    flex: 1;
    overflow: hidden;
  }

  .code-editor-viewport-hidden {
    display: none;
  }

  .code-editor-empty {
    display: grid;
    height: 100%;
    place-items: center;
    padding: 24px;
    color: var(--color-text-muted, #5f5f5f);
    font-size: 12px;
  }

  :global(.code-editor-viewport .cm-editor) {
    height: 100%;
  }

  :global(.code-editor-viewport .cm-line) {
    line-height: 1.5;
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.code-editor-viewport .cm-scroller) {
      scroll-behavior: auto;
    }
  }
</style>
