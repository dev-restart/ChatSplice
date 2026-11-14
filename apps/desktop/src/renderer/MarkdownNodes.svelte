<script lang="ts">
  import type { Token, Tokens } from 'marked';

  import MarkdownNodes from './MarkdownNodes.svelte';
  import { describableHref } from './markdown-view.js';

  let {
    tokens,
    imageLabel,
  }: {
    tokens: Token[];
    imageLabel: (alt: string) => string;
  } = $props();

  const headingLevel = (depth: number): string => `h${Math.min(6, Math.max(1, depth))}`;
  const children = (token: Token): Token[] =>
    'tokens' in token && Array.isArray(token.tokens) ? (token.tokens as Token[]) : [];
</script>

{#each tokens as token, index (index)}
  {#if token.type === 'heading'}
    <svelte:element this={headingLevel((token as Tokens.Heading).depth)}>
      <MarkdownNodes tokens={children(token)} {imageLabel} />
    </svelte:element>
  {:else if token.type === 'paragraph'}
    <p><MarkdownNodes tokens={children(token)} {imageLabel} /></p>
  {:else if token.type === 'text'}
    {#if children(token).length > 0}
      <MarkdownNodes tokens={children(token)} {imageLabel} />
    {:else}
      {(token as Tokens.Text).text}
    {/if}
  {:else if token.type === 'list'}
    {@const list = token as Tokens.List}
    <svelte:element
      this={list.ordered ? 'ol' : 'ul'}
      start={list.ordered && typeof list.start === 'number' ? list.start : undefined}
      class:task-list={list.items.some((item) => item.task)}
    >
      {#each list.items as item, itemIndex (itemIndex)}
        <li class:task={item.task}>
          {#if item.task}
            <input type="checkbox" checked={item.checked === true} disabled />
          {/if}
          <MarkdownNodes tokens={item.tokens} {imageLabel} />
        </li>
      {/each}
    </svelte:element>
  {:else if token.type === 'code'}
    {@const code = token as Tokens.Code}
    <pre data-language={code.lang?.split(/\s/)[0] ?? ''}><code>{code.text}</code></pre>
  {:else if token.type === 'blockquote'}
    <blockquote><MarkdownNodes tokens={children(token)} {imageLabel} /></blockquote>
  {:else if token.type === 'hr'}
    <hr />
  {:else if token.type === 'table'}
    {@const table = token as Tokens.Table}
    <div class="md-table-wrap">
      <table>
        <thead>
          <tr>
            {#each table.header as cell, cellIndex (cellIndex)}
              <th style:text-align={cell.align ?? undefined}>
                <MarkdownNodes tokens={cell.tokens} {imageLabel} />
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each table.rows as row, rowIndex (rowIndex)}
            <tr>
              {#each row as cell, cellIndex (cellIndex)}
                <td style:text-align={cell.align ?? undefined}>
                  <MarkdownNodes tokens={cell.tokens} {imageLabel} />
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else if token.type === 'strong'}
    <strong><MarkdownNodes tokens={children(token)} {imageLabel} /></strong>
  {:else if token.type === 'em'}
    <em><MarkdownNodes tokens={children(token)} {imageLabel} /></em>
  {:else if token.type === 'del'}
    <del><MarkdownNodes tokens={children(token)} {imageLabel} /></del>
  {:else if token.type === 'codespan'}
    <code>{(token as Tokens.Codespan).text}</code>
  {:else if token.type === 'br'}
    <br />
  {:else if token.type === 'link'}
    {@const link = token as Tokens.Link}
    {@const href = describableHref(link.href)}
    <span class="md-link" class:md-link-inert={href === null} title={href ?? undefined}>
      <MarkdownNodes tokens={children(token)} {imageLabel} />
    </span>
  {:else if token.type === 'image'}
    <span class="md-image">{imageLabel((token as Tokens.Image).text)}</span>
  {:else if token.type === 'escape'}
    {(token as Tokens.Escape).text}
  {:else if token.type === 'html'}
    <!-- Raw HTML is shown as literal text; it is never inserted into the page. -->
    <span class="md-raw">{(token as Tokens.HTML).text}</span>
  {:else if token.type === 'space' || token.type === 'def' || token.type === 'checkbox'}
    <!-- No visible output. -->
  {:else if children(token).length > 0}
    <MarkdownNodes tokens={children(token)} {imageLabel} />
  {:else if 'raw' in token}
    {token.raw}
  {/if}
{/each}
