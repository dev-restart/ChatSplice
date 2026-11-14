<script lang="ts">
  import type { ProjectExecSummary } from '@chatsplice/protocol';

  import { executionText } from './execution-diagnostics-text.js';
  import { executionProgressView, formatExecutionMetric } from './execution-progress-view.js';
  import type { UiLocale } from './i18n.js';

  export let job: ProjectExecSummary;
  export let locale: UiLocale;

  $: progress = executionProgressView(job);
</script>

{#if progress !== null}
  <aside
    class="execution-progress-card"
    aria-label={executionText(locale, 'executionProgressTitle')}
    data-testid="execution-progress"
  >
    <strong>{executionText(locale, progress.title)}</strong>
    <p>{executionText(locale, progress.detail)}</p>
    {#if progress.metrics.length > 0}
      <dl>
        {#each progress.metrics as item (item.label)}
          <div>
            <dt>{executionText(locale, item.label)}</dt>
            <dd>{formatExecutionMetric(locale, item)}</dd>
          </div>
        {/each}
      </dl>
      <small>{executionText(locale, 'executionProgressEvidence')}</small>
    {/if}
    {#if job.message !== ''}
      <details>
        <summary>{executionText(locale, 'executionOriginalStatus')}</summary>
        <p class="original-status">{job.message}</p>
      </details>
    {/if}
  </aside>
{/if}

<style>
  .execution-progress-card {
    min-width: 0;
    border-left: 3px solid var(--color-accent, #4263eb);
    border-radius: 3px;
    background: var(--color-surface-muted);
    padding: 8px 10px;
    color: var(--color-text);
    font-size: 11px;
    line-height: 1.5;
    word-break: keep-all;
    overflow-wrap: anywhere;
  }

  strong {
    font-size: 12px;
  }

  p {
    margin: 3px 0 0;
  }

  dl {
    display: flex;
    flex-wrap: wrap;
    gap: 5px 16px;
    margin: 8px 0 4px;
  }

  dl div {
    min-width: 0;
  }

  dt,
  small,
  summary {
    color: var(--color-text-muted);
    font-size: 10px;
  }

  dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
    font-weight: 650;
  }

  details {
    margin-top: 4px;
  }

  summary {
    width: fit-content;
    cursor: pointer;
  }

  summary:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 2px;
  }

  .original-status {
    font-family: monospace;
    white-space: pre-wrap;
  }
</style>
