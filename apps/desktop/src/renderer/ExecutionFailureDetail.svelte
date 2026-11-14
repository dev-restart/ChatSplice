<script lang="ts">
  import type { ProjectExecSummary } from '@chatsplice/protocol';

  import { executionFailureView } from './execution-failure-view.js';
  import { executionText, type ExecutionTextKey } from './execution-diagnostics-text.js';
  import {
    executionInspectionFailureMetrics,
    formatExecutionMetric,
  } from './execution-progress-view.js';
  import type { UiLocale } from './i18n.js';

  export let job: ProjectExecSummary;
  export let locale: UiLocale;

  $: failure = executionFailureView(job);
  $: metrics = executionInspectionFailureMetrics(job);
  $: t = (key: ExecutionTextKey) => executionText(locale, key);
</script>

{#if failure !== null}
  <aside
    class="execution-failure-card"
    aria-label={t('executionFailureTitle')}
    data-testid="execution-failure-diagnosis"
  >
    <strong>{t(failure.title)}</strong>
    <p>{t(failure.detail)}</p>
    {#if metrics.length > 0}
      <dl>
        {#each metrics as item (item.label)}
          <div>
            <dt>{t(item.label)}</dt>
            <dd>{formatExecutionMetric(locale, item)}</dd>
          </div>
        {/each}
      </dl>
    {/if}
    <p class="execution-failure-next"><span>{t('executionFailureNext')}</span>{t(failure.next)}</p>
  </aside>
{/if}

<style>
  .execution-failure-card {
    min-width: 0;
    border-left: 3px solid var(--color-warn, #ad7000);
    border-radius: 3px;
    background: var(--color-surface-muted);
    padding: 8px 10px;
    color: var(--color-text);
    font-size: 11px;
    line-height: 1.5;
    word-break: keep-all;
    overflow-wrap: anywhere;
  }

  dl {
    display: flex;
    flex-wrap: wrap;
    gap: 5px 16px;
    margin: 8px 0 4px;
  }

  dt {
    color: var(--color-text-muted);
    font-size: 10px;
  }

  dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
    font-weight: 650;
  }

  strong {
    font-size: 12px;
  }

  p {
    margin: 3px 0 0;
  }

  .execution-failure-next {
    color: var(--color-text-muted);
  }

  .execution-failure-next span {
    margin-right: 6px;
    color: var(--color-text);
    font-weight: 650;
  }
</style>
