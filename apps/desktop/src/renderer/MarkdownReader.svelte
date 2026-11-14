<script lang="ts">
  import MarkdownNodes from './MarkdownNodes.svelte';
  import { parseMarkdown } from './markdown-view.js';

  let {
    source,
    emptyLabel,
    imageLabel,
  }: {
    source: string;
    emptyLabel: string;
    imageLabel: (alt: string) => string;
  } = $props();

  const tokens = $derived(parseMarkdown(source));
  const hasContent = $derived(source.trim() !== '');
</script>

<article class="markdown-body" data-testid="markdown-reader">
  {#if hasContent}
    <MarkdownNodes {tokens} {imageLabel} />
  {:else}
    <p class="md-empty">{emptyLabel}</p>
  {/if}
</article>

<style>
  .markdown-body {
    box-sizing: border-box;
    width: 100%;
    max-width: 820px;
    margin: 0 auto;
    padding: 28px 32px 56px;
    color: var(--color-text);
    font-size: 15px;
    line-height: 1.7;
    overflow-wrap: anywhere;
  }

  .markdown-body :global(h1),
  .markdown-body :global(h2),
  .markdown-body :global(h3),
  .markdown-body :global(h4),
  .markdown-body :global(h5),
  .markdown-body :global(h6) {
    margin: 1.6em 0 0.6em;
    font-weight: 650;
    line-height: 1.3;
  }

  .markdown-body :global(h1) {
    margin-top: 0;
    border-bottom: 1px solid var(--color-border);
    padding-bottom: 0.3em;
    font-size: 1.8em;
  }

  .markdown-body :global(h2) {
    border-bottom: 1px solid var(--color-border);
    padding-bottom: 0.25em;
    font-size: 1.4em;
  }

  .markdown-body :global(h3) {
    font-size: 1.15em;
  }

  .markdown-body :global(h4),
  .markdown-body :global(h5),
  .markdown-body :global(h6) {
    font-size: 1em;
  }

  .markdown-body :global(p),
  .markdown-body :global(ul),
  .markdown-body :global(ol),
  .markdown-body :global(blockquote),
  .markdown-body :global(pre),
  .markdown-body :global(.md-table-wrap) {
    margin: 0 0 1em;
  }

  .markdown-body :global(ul),
  .markdown-body :global(ol) {
    padding-left: 1.6em;
  }

  .markdown-body :global(ul) {
    list-style: disc;
  }

  .markdown-body :global(ul ul) {
    list-style: circle;
  }

  .markdown-body :global(ol) {
    list-style: decimal;
  }

  .markdown-body :global(ul.task-list) {
    list-style: none;
    padding-left: 0.4em;
  }

  .markdown-body :global(li > p) {
    margin: 0.25em 0;
  }

  .markdown-body :global(li + li) {
    margin-top: 0.25em;
  }

  .markdown-body :global(li.task) {
    list-style: none;
  }

  .markdown-body :global(li.task input) {
    margin: 0 0.5em 0 0;
    vertical-align: -1px;
  }

  .markdown-body :global(code) {
    border-radius: 5px;
    background: var(--color-surface-muted);
    padding: 0.12em 0.4em;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.88em;
  }

  .markdown-body :global(pre) {
    overflow-x: auto;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-surface-muted);
    padding: 12px 14px;
    line-height: 1.55;
  }

  .markdown-body :global(pre code) {
    background: none;
    padding: 0;
    font-size: 0.86em;
    white-space: pre;
  }

  .markdown-body :global(blockquote) {
    border-left: 3px solid var(--color-border-strong);
    padding: 0.1em 0 0.1em 1em;
    color: var(--color-text-muted);
  }

  .markdown-body :global(blockquote > :last-child) {
    margin-bottom: 0;
  }

  .markdown-body :global(hr) {
    margin: 1.6em 0;
    border: 0;
    border-top: 1px solid var(--color-border);
  }

  .markdown-body :global(.md-table-wrap) {
    overflow-x: auto;
  }

  .markdown-body :global(table) {
    border-collapse: collapse;
    font-size: 0.94em;
  }

  .markdown-body :global(th),
  .markdown-body :global(td) {
    border: 1px solid var(--color-border);
    padding: 6px 12px;
    vertical-align: top;
  }

  .markdown-body :global(th) {
    background: var(--color-surface-muted);
    font-weight: 600;
  }

  .markdown-body :global(.md-link) {
    color: var(--color-link);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .markdown-body :global(.md-link-inert) {
    color: inherit;
    text-decoration-style: dotted;
  }

  .markdown-body :global(.md-image),
  .markdown-body :global(.md-raw) {
    border-radius: 5px;
    background: var(--color-surface-muted);
    padding: 0.1em 0.4em;
    color: var(--color-text-muted);
    font-size: 0.9em;
  }

  .markdown-body :global(.md-empty) {
    color: var(--color-text-muted);
  }
</style>
