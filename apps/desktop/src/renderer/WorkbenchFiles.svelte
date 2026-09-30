<script lang="ts">
  import { onMount } from 'svelte';

  import type { PanelState, WorkspaceDetail } from '@chatsplice/protocol';

  import FileTreeNode from './FileTreeNode.svelte';
  import { uiText, type UiLocale, type UiTextKey } from './i18n.js';
  import {
    canExpandNode,
    countFileTreeNodes,
    FILE_TREE_MAX_NODES,
    findFileTreeNode,
    flattenFileTree,
    mergeFileTreeChildrenBounded,
    type FileTreeNodeState,
    treeDomKey,
  } from './file-tree.js';
  import { PANEL_ROOT_PATH, parentWorkspacePath } from './panel-utils.js';

  export let locale: UiLocale;

  type TreeRootState = {
    children: FileTreeNodeState[];
    loaded: boolean;
    loading: boolean;
    hasMore: boolean;
    nextOffset: number | null;
  };

  const bridge = window.chatsplice;
  const emptyRoot = (): TreeRootState => ({
    children: [],
    loaded: false,
    loading: false,
    hasMore: false,
    nextOffset: null,
  });

  let workspaces: WorkspaceDetail[] = [];
  let panelState: PanelState = {
    workspace_id: null,
    console_open: false,
    files_open: true,
    files_width: 340,
    console_height: 260,
  };
  let root = emptyRoot();
  let selectedPath = '';
  let focusedPath = '';
  let searchQuery = '';
  let loading = true;
  let error = '';
  let treeNotice = '';
  let refreshSerial = 0;
  let listRequestSerial = 0;
  let treeGeneration = 0;
  let lastWorkspaceId = '';
  let destroyed = false;
  const listRequests = new Map<string, number>();

  $: t = (key: UiTextKey, values: Record<string, string | number> = {}) =>
    uiText(locale, key, values);
  // getPanelState is the source of truth for the selected project. The workspace
  // list only supplies the display label beside that immutable selection.
  $: selectedWorkspaceId = panelState.workspace_id ?? '';
  $: selectedWorkspace = workspaces.find(
    (workspace) => workspace.workspace_id === selectedWorkspaceId,
  );
  $: selectedProjectName = selectedWorkspace?.display_name ?? selectedWorkspaceId;
  $: flattenedTree = flattenFileTree(
    root.children,
    searchQuery,
    'name',
    new Map(),
    FILE_TREE_MAX_NODES,
  );
  $: visibleNodes = flattenedTree.nodes;
  $: searchActive = searchQuery.trim() !== '';

  function resetSelection(): void {
    selectedPath = '';
    focusedPath = '';
  }

  function resetTree(): void {
    treeGeneration += 1;
    listRequestSerial += 1;
    listRequests.clear();
    root = emptyRoot();
    treeNotice = '';
  }

  function beginList(path: string): { generation: number; requestId: number } {
    const requestId = ++listRequestSerial;
    listRequests.set(path, requestId);
    return { generation: treeGeneration, requestId };
  }

  function listIsCurrent(
    workspaceId: string,
    path: string,
    generation: number,
    requestId: number,
  ): boolean {
    return (
      !destroyed &&
      generation === treeGeneration &&
      listRequests.get(path) === requestId &&
      panelState.workspace_id === workspaceId
    );
  }

  async function refresh(): Promise<void> {
    const requestId = ++refreshSerial;
    try {
      const [listedWorkspaces, nextPanelState] = await Promise.all([
        bridge.listWorkspaces(),
        bridge.getPanelState(),
      ]);
      if (destroyed || requestId !== refreshSerial) return;

      workspaces = listedWorkspaces.workspaces.filter((workspace) => workspace.kind === 'user');
      const nextWorkspaceId = nextPanelState.workspace_id ?? '';
      const workspaceChanged = nextWorkspaceId !== lastWorkspaceId;
      panelState = nextPanelState;
      error = '';

      if (workspaceChanged) {
        lastWorkspaceId = nextWorkspaceId;
        resetTree();
        resetSelection();
        if (nextWorkspaceId !== '') await loadRootPage(nextWorkspaceId, 0, true);
      } else if (nextWorkspaceId !== '' && !root.loaded && !root.loading) {
        await loadRootPage(nextWorkspaceId, 0, true);
      }
    } catch {
      if (!destroyed && requestId === refreshSerial) error = t('filesLoadError');
    } finally {
      if (!destroyed && requestId === refreshSerial) loading = false;
    }
  }

  async function loadRootPage(
    workspaceId: string,
    offset: number,
    replace: boolean,
  ): Promise<void> {
    if (workspaceId === '') return;
    const request = beginList(PANEL_ROOT_PATH);
    root = { ...root, loading: true };
    if (replace) {
      error = '';
      treeNotice = '';
    }

    try {
      const result = await bridge.listWorkspaceFiles({
        workspace_id: workspaceId,
        path: PANEL_ROOT_PATH,
        offset,
      });
      if (!listIsCurrent(workspaceId, PANEL_ROOT_PATH, request.generation, request.requestId)) {
        return;
      }

      const previousChildren = root.children;
      const existing = replace ? [] : previousChildren;
      const outsideCount = countFileTreeNodes(root.children) - countFileTreeNodes(previousChildren);
      const allowed = Math.max(0, FILE_TREE_MAX_NODES - outsideCount);
      const merged = mergeFileTreeChildrenBounded(existing, result.entries, null, allowed);
      root = {
        children: merged.children,
        loaded: true,
        loading: false,
        hasMore: result.has_more && result.next_offset !== null && !merged.truncated,
        nextOffset: result.next_offset,
      };
      listRequests.delete(PANEL_ROOT_PATH);
      if (focusedPath === '' && root.children[0] !== undefined) {
        focusedPath = root.children[0].path;
      }
    } catch {
      if (listIsCurrent(workspaceId, PANEL_ROOT_PATH, request.generation, request.requestId)) {
        root = { ...root, loaded: false, loading: false };
        listRequests.delete(PANEL_ROOT_PATH);
        error = t('filesListError');
      }
    } finally {
      if (listIsCurrent(workspaceId, PANEL_ROOT_PATH, request.generation, request.requestId)) {
        root = { ...root, loading: false };
      }
    }
  }

  async function loadDirectoryPage(
    nodePath: string,
    offset: number,
    replace: boolean,
  ): Promise<void> {
    const workspaceId = selectedWorkspaceId;
    const node = findFileTreeNode(root.children, nodePath);
    if (
      workspaceId === '' ||
      node === undefined ||
      node.type !== 'directory' ||
      !canExpandNode(node) ||
      node.childrenLoading
    ) {
      return;
    }

    const request = beginList(nodePath);
    node.childrenLoading = true;
    treeNotice = '';
    root = { ...root };
    try {
      const result = await bridge.listWorkspaceFiles({
        workspace_id: workspaceId,
        path: nodePath,
        offset,
      });
      if (!listIsCurrent(workspaceId, nodePath, request.generation, request.requestId)) return;

      const currentNode = findFileTreeNode(root.children, nodePath);
      if (currentNode === undefined) return;
      const previousChildren = currentNode.children;
      const existing = replace ? [] : previousChildren;
      const currentTotal = countFileTreeNodes(root.children);
      const previousTotal = countFileTreeNodes(previousChildren);
      const allowed = Math.max(0, FILE_TREE_MAX_NODES - (currentTotal - previousTotal));
      const merged = mergeFileTreeChildrenBounded(
        existing,
        result.entries,
        currentNode.depth,
        allowed,
      );
      currentNode.children = merged.children;
      currentNode.childrenLoaded = true;
      currentNode.childrenLoading = false;
      currentNode.childrenHasMore =
        result.has_more && result.next_offset !== null && !merged.truncated;
      currentNode.childrenNextOffset = result.next_offset;
      listRequests.delete(nodePath);
      root = { ...root };
    } catch {
      if (!listIsCurrent(workspaceId, nodePath, request.generation, request.requestId)) return;
      const currentNode = findFileTreeNode(root.children, nodePath);
      if (currentNode !== undefined) {
        currentNode.childrenLoading = false;
        root = { ...root };
      }
      listRequests.delete(nodePath);
      treeNotice = t('filesListError');
    } finally {
      if (listIsCurrent(workspaceId, nodePath, request.generation, request.requestId)) {
        const currentNode = findFileTreeNode(root.children, nodePath);
        if (currentNode !== undefined && currentNode.childrenLoading) {
          currentNode.childrenLoading = false;
          root = { ...root };
        }
      }
    }
  }

  async function toggleNode(node: FileTreeNodeState): Promise<void> {
    if (node.type !== 'directory' || !canExpandNode(node)) return;
    node.expanded = !node.expanded;
    focusedPath = node.path;
    root = { ...root };
    focusTreeRow(node.path);
    if (node.expanded && !node.childrenLoaded) {
      await loadDirectoryPage(node.path, 0, true);
    }
  }

  function loadMore(node: FileTreeNodeState | null): void {
    if (countFileTreeNodes(root.children) >= FILE_TREE_MAX_NODES) return;
    if (node === null) {
      if (root.hasMore && root.nextOffset !== null && !root.loading) {
        void loadRootPage(selectedWorkspaceId, root.nextOffset, false);
      }
      return;
    }
    if (node.childrenHasMore && node.childrenNextOffset !== null && !node.childrenLoading) {
      void loadDirectoryPage(node.path, node.childrenNextOffset, false);
    }
  }

  function collapseAll(): void {
    function collapse(nodes: FileTreeNodeState[]): void {
      for (const node of nodes) {
        node.expanded = false;
        collapse(node.children);
      }
    }
    collapse(root.children);
    focusedPath = root.children[0]?.path ?? '';
    root = { ...root };
    if (focusedPath !== '') focusTreeRow(focusedPath);
  }

  function refreshRoot(): void {
    if (selectedWorkspaceId === '') return;
    resetTree();
    resetSelection();
    void loadRootPage(selectedWorkspaceId, 0, true);
  }

  async function openFile(node: FileTreeNodeState): Promise<void> {
    if (node.type !== 'file') return;
    const requestWorkspaceId = selectedWorkspaceId;
    selectedPath = node.path;
    focusedPath = node.path;
    error = '';
    focusTreeRow(node.path);
    try {
      await bridge.openEditorFile({
        workspace_id: requestWorkspaceId,
        path: node.path,
      });
    } catch {
      if (!destroyed && requestWorkspaceId === selectedWorkspaceId && selectedPath === node.path) {
        error = t('filesOpenError');
      }
    }
  }

  function focusTreeRow(path: string): void {
    focusedPath = path;
    queueMicrotask(() => {
      if (destroyed) return;
      const row = document.querySelector<HTMLElement>(`[data-tree-key="${treeDomKey(path)}"]`);
      row?.focus();
    });
  }

  function handleTreeKeydown(event: KeyboardEvent, node: FileTreeNodeState): void {
    const index = visibleNodes.findIndex((item) => item.path === node.path);
    if (index < 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusTreeRow(visibleNodes[Math.min(index + 1, visibleNodes.length - 1)]?.path ?? node.path);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusTreeRow(visibleNodes[Math.max(index - 1, 0)]?.path ?? node.path);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      focusTreeRow(visibleNodes[0]?.path ?? node.path);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      focusTreeRow(visibleNodes.at(-1)?.path ?? node.path);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (node.type === 'directory' && canExpandNode(node)) {
        if (!node.expanded) void toggleNode(node);
        else {
          const child = visibleNodes[index + 1];
          focusTreeRow(child !== undefined && child.depth > node.depth ? child.path : node.path);
        }
      }
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (node.type === 'directory' && node.expanded) {
        void toggleNode(node);
        return;
      }
      const parentPath = parentWorkspacePath(node.path);
      if (parentPath !== null) {
        const parent = visibleNodes.find((item) => item.path === parentPath);
        if (parent !== undefined) focusTreeRow(parent.path);
      }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (node.type === 'directory') void toggleNode(node);
      else void openFile(node);
    }
  }

  function searchPlaceholder(currentLocale: UiLocale): string {
    return currentLocale === 'ko' ? '불러온 파일 이름 검색' : 'Search loaded file names';
  }

  function searchModeHint(currentLocale: UiLocale): string {
    return currentLocale === 'ko'
      ? '현재 불러온 트리의 파일 이름만 검색합니다.'
      : 'Searches file names in the loaded tree.';
  }

  function rootLabel(currentLocale: UiLocale): string {
    return currentLocale === 'ko' ? '프로젝트 루트' : 'Project root';
  }

  function noSearchMatchesLabel(currentLocale: UiLocale): string {
    return currentLocale === 'ko'
      ? '불러온 트리에서 일치 항목이 없습니다.'
      : 'No matches in the loaded tree.';
  }

  function treeBoundLabel(currentLocale: UiLocale): string {
    return currentLocale === 'ko'
      ? '표시할 수 있는 항목 상한에 도달했습니다.'
      : 'The loaded tree reached its display limit.';
  }

  onMount(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      destroyed = true;
      refreshSerial += 1;
      treeGeneration += 1;
      listRequestSerial += 1;
      window.clearInterval(timer);
    };
  });
</script>

<main class="native-surface files-surface file-browser" aria-labelledby="files-title">
  <header class="file-browser-header">
    <div class="file-browser-project">
      <span class="file-browser-project-mark" aria-hidden="true">
        <svg viewBox="0 0 20 20"
          ><path
            d="M3 5.5h5l1.8 2H17a1 1 0 0 1 1 1v6.8a1.2 1.2 0 0 1-1.2 1.2H3.2a1.2 1.2 0 0 1-1.2-1.2v-9.8a1 1 0 0 1 1-.9Z"
          /></svg
        >
      </span>
      <div class="file-browser-project-copy">
        <h1 id="files-title">{selectedProjectName || t('filesPanel')}</h1>
        <span>{rootLabel(locale)}</span>
      </div>
    </div>
    <div class="file-browser-actions">
      <button
        type="button"
        class="file-browser-action"
        onclick={collapseAll}
        disabled={selectedWorkspaceId === '' || root.children.length === 0}
        aria-label={locale === 'ko' ? '모두 접기' : 'Collapse all'}
        title={locale === 'ko' ? '모두 접기' : 'Collapse all'}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true"
          ><path d="M3 5h4M3 10h4M3 15h4M10 5h7M10 10h7M10 15h7" /><path
            d="m7 3-2 2 2 2M7 8l-2 2 2 2M7 13l-2 2 2 2"
          /></svg
        >
      </button>
      <button
        type="button"
        class="file-browser-action"
        onclick={refreshRoot}
        disabled={selectedWorkspaceId === '' || root.loading}
        aria-label={locale === 'ko' ? '루트 새로고침' : 'Refresh project root'}
        title={locale === 'ko' ? '루트 새로고침' : 'Refresh project root'}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true"
          ><path d="M16 6.5A6.5 6.5 0 1 0 17 12" /><path d="M16 3.5v3h-3" /></svg
        >
      </button>
    </div>
  </header>

  <div class="file-browser-toolbar">
    <label class="file-search-field">
      <span class="file-search-icon" aria-hidden="true">
        <svg viewBox="0 0 20 20"
          ><path d="m12.8 12.8 4 4M8.8 14.5a5.7 5.7 0 1 0 0-11.4 5.7 5.7 0 0 0 0 11.4Z" /></svg
        >
      </span>
      <span class="sr-only">{searchPlaceholder(locale)}</span>
      <input
        value={searchQuery}
        oninput={(event) => (searchQuery = (event.currentTarget as HTMLInputElement).value)}
        placeholder={searchPlaceholder(locale)}
        title={searchPlaceholder(locale)}
        type="search"
        autocomplete="off"
        spellcheck="false"
      />
    </label>
    <span class="file-search-hint">{searchModeHint(locale)}</span>
  </div>

  {#if loading && selectedWorkspaceId === ''}
    <p class="native-empty" role="status">{t('filesLoading')}</p>
  {:else if selectedWorkspaceId === ''}
    <p class="native-empty">{t('filesChooseProject')}</p>
  {:else}
    <div class="file-browser-layout">
      <section class="file-tree-panel" aria-labelledby="file-tree-title">
        <div class="file-tree-heading">
          <h2 id="file-tree-title">{selectedProjectName || t('filesPanel')}</h2>
          {#if root.loaded}<span>{root.children.length}</span>{/if}
        </div>
        {#if error !== ''}
          <p class="file-browser-error" role="alert">{error}</p>
        {:else if root.loading && !root.loaded}
          <p class="file-browser-empty" role="status">{t('filesLoading')}</p>
        {:else}
          <div class="file-tree-scroll">
            <div class="file-tree" role="tree" aria-labelledby="file-tree-title">
              {#each visibleNodes as node (node.path)}
                <FileTreeNode
                  {node}
                  {selectedPath}
                  {focusedPath}
                  directoryLabel={locale === 'ko' ? '폴더' : 'folder'}
                  fileLabel={locale === 'ko' ? '파일' : 'file'}
                  symlinkLabel={t('filesSymlinkBlocked')}
                  onToggle={toggleNode}
                  onSelect={openFile}
                  onKeydown={handleTreeKeydown}
                />
                {#if node.type === 'directory' && node.expanded && node.childrenHasMore}
                  <button
                    type="button"
                    class="file-tree-load-more"
                    role="treeitem"
                    aria-level={node.depth + 2}
                    aria-selected={false}
                    style={`--tree-depth: ${node.depth + 1}`}
                    disabled={node.childrenLoading ||
                      countFileTreeNodes(root.children) >= FILE_TREE_MAX_NODES}
                    onclick={() => loadMore(node)}>{t('loadMore')}</button
                  >
                {/if}
              {:else}
                <p class="file-browser-empty">
                  {searchActive ? noSearchMatchesLabel(locale) : t('filesEmpty')}
                </p>
              {/each}
              {#if root.hasMore}
                <button
                  type="button"
                  class="file-tree-load-more root-load-more"
                  disabled={root.loading ||
                    countFileTreeNodes(root.children) >= FILE_TREE_MAX_NODES}
                  onclick={() => loadMore(null)}
                  >{root.loading ? t('filesLoading') : t('loadMore')}</button
                >
              {/if}
            </div>
          </div>
          {#if flattenedTree.truncated}<p class="file-tree-bound">{treeBoundLabel(locale)}</p>{/if}
          {#if treeNotice !== ''}<p class="file-browser-error" role="alert">{treeNotice}</p>{/if}
        {/if}
      </section>
    </div>
  {/if}
</main>

<style>
  .file-browser {
    background: var(--color-bg);
    color: var(--color-text);
  }

  .file-browser-header {
    display: flex;
    min-height: 48px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface);
    padding: 7px 12px;
  }

  .file-browser-project,
  .file-browser-actions,
  .file-browser-project-copy,
  .file-tree-heading {
    display: flex;
    align-items: center;
  }

  .file-browser-project {
    min-width: 0;
    gap: 8px;
  }

  .file-browser-project-mark {
    display: grid;
    width: 22px;
    height: 22px;
    flex: 0 0 auto;
    place-items: center;
    color: var(--color-focus);
  }

  .file-browser-project-mark svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.4;
  }

  .file-browser-project-copy {
    min-width: 0;
    align-items: baseline;
    gap: 8px;
  }

  .file-browser-project-copy h1 {
    overflow: hidden;
    margin: 0;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: -0.02em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-browser-project-copy span {
    flex: 0 0 auto;
    color: var(--color-text-muted);
    font-size: 10px;
  }

  .file-browser-actions {
    flex: 0 0 auto;
    gap: 2px;
  }

  .file-browser-action {
    display: grid;
    width: 28px;
    height: 28px;
    place-items: center;
    border: 1px solid transparent;
    border-radius: 5px;
    background: transparent;
    color: var(--color-text-muted);
    cursor: pointer;
  }

  .file-browser-action:hover:not(:disabled) {
    border-color: var(--color-border);
    background: var(--color-hover);
    color: var(--color-text);
  }

  .file-browser-action:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 1px;
  }

  .file-browser-action:disabled {
    cursor: default;
    opacity: 0.45;
  }

  .file-browser-action svg {
    width: 17px;
    height: 17px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.45;
  }

  .file-browser-toolbar {
    display: grid;
    flex: 0 0 auto;
    gap: 7px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface);
    padding: 8px 10px 7px;
  }

  .file-search-field {
    display: flex;
    min-height: 32px;
    align-items: center;
    gap: 8px;
    border: 1px solid var(--color-border-strong);
    border-radius: 7px;
    background: var(--color-surface-muted);
    padding: 0 9px;
  }

  .file-search-field:focus-within {
    border-color: var(--color-focus);
    box-shadow: 0 0 0 2px var(--color-focus-ring);
  }

  .file-search-icon {
    display: grid;
    width: 16px;
    height: 16px;
    flex: 0 0 auto;
    place-items: center;
    color: var(--color-text-muted);
  }

  .file-search-icon svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.5;
  }

  .file-search-field input {
    min-width: 0;
    flex: 1;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--color-text);
    font-size: 12px;
  }

  .file-search-field input::placeholder {
    color: var(--color-text-muted);
  }

  .file-search-hint {
    color: var(--color-text-muted);
    font-size: 10px;
    line-height: 1.35;
  }

  .file-browser-layout {
    display: grid;
    min-height: 0;
    flex: 1;
    grid-template-columns: 1fr;
    gap: 1px;
    overflow: hidden;
    background: var(--color-border);
  }

  .file-tree-panel {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    overflow: hidden;
    background: var(--color-surface);
    padding: 8px 9px 12px;
  }

  .file-tree-heading {
    min-height: 24px;
    flex: 0 0 auto;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 5px;
  }

  .file-tree-heading h2 {
    margin: 0;
    color: var(--color-text);
    font-size: 11px;
    font-weight: 700;
  }

  .file-tree-heading span {
    color: var(--color-text-muted);
    font-size: 10px;
  }

  .file-tree-scroll {
    min-height: 0;
    flex: 1;
    overflow: auto;
    scrollbar-color: var(--color-border-strong) transparent;
  }

  .file-tree {
    min-height: 100%;
  }

  .file-tree-load-more {
    display: block;
    width: calc(100% - 14px);
    min-height: 24px;
    margin: 2px 7px 0;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--color-text-muted);
    font-size: 10px;
    text-align: left;
    cursor: pointer;
  }

  .file-tree-load-more:hover:not(:disabled) {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .file-tree-load-more:focus-visible {
    border-color: var(--color-focus);
    outline: none;
  }

  .file-tree-load-more:disabled {
    cursor: default;
    opacity: 0.5;
  }

  .file-tree-load-more.root-load-more {
    margin-top: 6px;
    padding-left: 7px;
  }

  .file-browser-empty,
  .file-browser-error,
  .file-tree-bound {
    margin: 12px 5px;
    color: var(--color-text-muted);
    font-size: 11px;
    line-height: 1.45;
  }

  .file-browser-error {
    color: var(--color-error-fg);
  }

  .file-tree-bound {
    flex: 0 0 auto;
    margin-block: 6px 0;
    color: var(--color-warn);
    font-size: 10px;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    padding: 0;
    border: 0;
    margin: -1px;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }

  @media (max-width: 720px) {
    .file-browser-layout {
      grid-template-columns: 1fr;
      overflow: auto;
    }

    .file-tree-panel {
      min-height: 260px;
    }
  }

  @media (max-width: 430px) {
    .file-browser-project-copy span {
      display: none;
    }

    .file-tree-panel {
      padding-inline: 7px;
    }
  }
</style>
