<script lang="ts">
  import type { FileTreeNodeState } from './file-tree.js';
  import { canExpandNode, treeDomKey } from './file-tree.js';

  export let node: FileTreeNodeState;
  export let selectedPath = '';
  export let focusedPath = '';
  export let onToggle: (node: FileTreeNodeState) => void = () => undefined;
  export let onSelect: (node: FileTreeNodeState) => void = () => undefined;
  export let onKeydown: (event: KeyboardEvent, node: FileTreeNodeState) => void = () => undefined;
  export let directoryLabel = 'folder';
  export let fileLabel = 'file';
  export let symlinkLabel = 'blocked link';

  $: expandable = canExpandNode(node);
  $: selected = selectedPath === node.path;
  $: focused = focusedPath === node.path;

  function handleClick(): void {
    if (node.type === 'directory') {
      onToggle(node);
    } else if (node.type === 'file') {
      onSelect(node);
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    onKeydown(event, node);
  }
</script>

<div
  class="file-tree-row"
  class:directory={node.type === 'directory'}
  class:file={node.type === 'file'}
  class:symlink={node.type === 'symlink'}
  class:selected
  class:focused
  class:blocked={node.type === 'symlink'}
  role="treeitem"
  aria-level={node.depth + 1}
  aria-expanded={expandable ? node.expanded : undefined}
  aria-selected={selected}
  aria-disabled={node.type === 'symlink'}
  aria-label={`${node.name} · ${node.type === 'directory' ? directoryLabel : node.type === 'symlink' ? symlinkLabel : fileLabel}`}
  data-tree-key={treeDomKey(node.path)}
  tabindex={focused ? 0 : -1}
  title={node.type === 'symlink' ? symlinkLabel : node.path}
  style={`--tree-depth: ${node.depth}`}
  onclick={handleClick}
  onkeydown={handleKeydown}
>
  <span class="file-tree-caret" aria-hidden="true">
    {#if expandable}
      <svg viewBox="0 0 12 12" class:expanded={node.expanded}><path d="m4.5 2.5 3 3-3 3" /></svg>
    {/if}
  </span>

  <span class="file-tree-icon" aria-hidden="true">
    {#if node.type === 'directory'}
      <svg viewBox="0 0 20 20" class:open={node.expanded}
        ><path
          d="M2.5 5.5h5l1.8 2H17a1 1 0 0 1 1 1v6.8a1.2 1.2 0 0 1-1.2 1.2H3.2a1.2 1.2 0 0 1-1.2-1.2v-9.8a1 1 0 0 1 .5-.9Z"
        /></svg
      >
    {:else if node.type === 'symlink'}
      <svg viewBox="0 0 20 20"
        ><circle cx="10" cy="10" r="7.4" /><path d="m7.3 7.3 5.4 5.4M12.7 7.3l-5.4 5.4" /></svg
      >
    {:else}
      <svg viewBox="0 0 20 20"
        ><path d="M5 2.5h6.3L15.5 7v10.5H5z" /><path
          d="M11.2 2.7V7h4.1M7.3 10h5.8M7.3 13h5.8"
        /></svg
      >
    {/if}
  </span>

  <span class="file-tree-name">{node.name}</span>

  {#if node.type === 'directory' && node.childrenLoading}
    <span class="file-tree-loading" aria-label="loading" title="Loading">•</span>
  {/if}
</div>

<style>
  .file-tree-row {
    display: grid;
    min-height: 24px;
    grid-template-columns: 14px 18px minmax(0, 1fr) 12px;
    align-items: center;
    gap: 4px;
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 0 7px 0 calc(7px + (var(--tree-depth) * 18px));
    color: var(--color-text, #e8e8e8);
    cursor: default;
    outline: none;
    user-select: none;
  }

  .file-tree-row:hover,
  .file-tree-row.focused {
    background: var(--color-hover, rgb(255 255 255 / 6%));
  }

  .file-tree-row.selected {
    border-color: var(--color-border, rgb(255 255 255 / 12%));
    background: var(--color-selected, rgb(255 255 255 / 10%));
  }

  .file-tree-row:focus-visible {
    border-color: var(--color-focus, #9bbcff);
    box-shadow: 0 0 0 2px var(--color-focus-ring, rgb(155 188 255 / 24%));
  }

  .file-tree-row.blocked {
    color: var(--color-text-muted, #8f8f8f);
  }

  .file-tree-caret,
  .file-tree-icon {
    display: grid;
    width: 18px;
    height: 18px;
    place-items: center;
    color: var(--color-text-muted, #989898);
  }

  .file-tree-caret {
    width: 14px;
  }

  .file-tree-caret svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.5;
    transition: transform 120ms ease;
  }

  .file-tree-caret svg.expanded {
    transform: rotate(90deg);
  }

  .file-tree-icon svg {
    width: 17px;
    height: 17px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.35;
  }

  .file-tree-row.directory .file-tree-icon {
    color: var(--color-focus, #9bbcff);
  }

  .file-tree-row.directory .file-tree-icon svg.open {
    color: var(--color-focus, #9bbcff);
  }

  .file-tree-name {
    overflow: hidden;
    min-width: 0;
    font-size: 11px;
    line-height: 22px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-tree-row.blocked .file-tree-name {
    color: var(--color-text-muted, #8f8f8f);
    font-style: italic;
  }

  .file-tree-loading {
    color: var(--color-text-muted, #8f8f8f);
    font-size: 15px;
    line-height: 1;
    text-align: center;
  }

  @media (prefers-reduced-motion: reduce) {
    .file-tree-caret svg {
      transition: none;
    }
  }
</style>
