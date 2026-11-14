<script lang="ts">
  import { onDestroy } from 'svelte';

  import type { ProjectExecJob, ProjectExecState, ProjectExecSummary } from '@chatsplice/protocol';

  import type { UiLocale, UiTextKey } from './i18n.js';
  import { executionText, type ExecutionTextKey } from './execution-diagnostics-text.js';
  import { executionProgressView } from './execution-progress-view.js';
  import ExecutionProgressDetail from './ExecutionProgressDetail.svelte';
  import ExecutionFailureDetail from './ExecutionFailureDetail.svelte';
  import {
    executionFailureTitle,
    executionNetworkKey,
    filterExecutionFailures,
    groupExecutionFailures,
    retainedWorkspaceExecutions,
    type ExecutionFailureFilter,
  } from './execution-failure-view.js';

  export let workspaceId: string;
  export let locale: UiLocale;
  export let jobs: ProjectExecSummary[] | undefined;
  export let compact = false;
  export let focusedJobId = '';

  const MAX_VISIBLE_OUTPUT = 16_000;
  const ACTIVE_STATES: ReadonlySet<ProjectExecState> = new Set(['queued', 'running', 'cancelling']);

  let selectedJobId = '';
  let selectedJob: ProjectExecJob | null = null;
  let selectedSummary: ProjectExecSummary | undefined;
  let workspaceJobs: ProjectExecSummary[] = [];
  let failureFilter: ExecutionFailureFilter = 'all';
  let loading = false;
  let error = '';
  let cancelling = false;
  let pollTimer: number | undefined;
  let requestSerial = 0;
  let inFlightJobId: string | null = null;
  let lastWorkspaceId = workspaceId;
  let lastFocusedJobId = '';
  let destroyed = false;

  $: t = (key: ExecutionTextKey, values: Record<string, string | number> = {}) =>
    executionText(locale, key, values);
  $: workspaceJobs = retainedWorkspaceExecutions(jobs, workspaceId);
  $: failureGroups = groupExecutionFailures(workspaceJobs);
  $: failureCount = failureGroups.reduce((total, group) => total + group.count, 0);
  $: visibleJobs = filterExecutionFailures(workspaceJobs, failureFilter);
  $: selectedSummary = workspaceJobs.find((job) => job.job_id === selectedJobId);
  $: if (
    (failureFilter === 'failed' && failureCount === 0) ||
    (failureFilter !== 'all' &&
      failureFilter !== 'failed' &&
      !failureGroups.some((group) => group.cause === failureFilter))
  ) {
    failureFilter = 'all';
  }
  $: reconcileRetainedSelection(workspaceJobs);
  $: if (workspaceId !== lastWorkspaceId) {
    lastWorkspaceId = workspaceId;
    lastFocusedJobId = '';
    failureFilter = 'all';
    requestSerial += 1;
    clearPolling();
    selectedJobId = '';
    selectedJob = null;
    error = '';
  }
  $: if (focusedJobId === '' && lastFocusedJobId !== '') {
    lastFocusedJobId = '';
  }
  $: if (focusedJobId !== '' && focusedJobId !== lastFocusedJobId) {
    const focusedSummary = workspaceJobs.find((job) => job.job_id === focusedJobId);
    if (focusedSummary !== undefined) {
      lastFocusedJobId = focusedJobId;
      failureFilter = 'all';
      void selectJob(focusedSummary);
    }
  }
  $: if (selectedJob !== null && selectedJob.job_id !== selectedJobId) {
    selectedJob = null;
  }
  $: if (selectedJobId === '' && visibleJobs[0] !== undefined) {
    void selectJob(visibleJobs[0]);
  }

  function changeFailureFilter(value: string): void {
    if (
      value !== 'all' &&
      value !== 'failed' &&
      !failureGroups.some((group) => group.cause === value)
    )
      return;
    failureFilter = value as ExecutionFailureFilter;
    const next = filterExecutionFailures(workspaceJobs, failureFilter)[0];
    if (next !== undefined) void selectJob(next);
  }

  function reconcileRetainedSelection(retained: ProjectExecSummary[]): void {
    if (workspaceId !== lastWorkspaceId) return;
    if (selectedJobId === '' || retained.some((job) => job.job_id === selectedJobId)) return;
    const filtered = filterExecutionFailures(retained, failureFilter);
    const next = filtered[0] ?? retained[0];
    if (filtered.length === 0) failureFilter = 'all';
    resetSelectedJob();
    if (next !== undefined) void selectJob(next);
  }

  function resetSelectedJob(): void {
    requestSerial += 1;
    clearPolling();
    selectedJobId = '';
    selectedJob = null;
    loading = false;
    error = '';
  }

  function isActive(state: ProjectExecState): boolean {
    return ACTIVE_STATES.has(state);
  }

  function clearPolling(): void {
    if (pollTimer !== undefined) {
      window.clearInterval(pollTimer);
      pollTimer = undefined;
    }
  }

  function stateKey(state: ProjectExecState): UiTextKey {
    if (state === 'queued') return 'executionQueued';
    if (state === 'running') return 'executionRunning';
    if (state === 'cancelling') return 'executionCancelling';
    if (state === 'succeeded') return 'executionSucceeded';
    if (state === 'failed') return 'executionFailed';
    if (state === 'cancelled') return 'executionCancelled';
    return 'executionTimedOut';
  }

  function operationKey(job: ProjectExecSummary): UiTextKey {
    if (job.operation.kind === 'node_script') return 'executionNodeScript';
    if (job.operation.kind === 'cargo') return 'executionCargo';
    if (job.operation.kind === 'shell') return 'executionShell';
    if (job.operation.kind === 'browser') return 'executionBrowser';
    if (job.operation.kind === 'readiness') return 'executionReadiness';
    if (job.operation.kind === 'environment') return 'executionEnvironment';
    if (job.operation.mode === 'resolve') return 'executionLockfileRefresh';
    return 'executionInstall';
  }

  function operationDetail(job: ProjectExecSummary): string {
    if (job.operation.kind === 'node_script') return job.operation.script;
    if (job.operation.kind === 'cargo') return job.operation.task;
    if (job.operation.kind === 'shell')
      return job.operation.background
        ? t('executionBackground')
        : job.operation.command.slice(0, 100);
    if (job.operation.kind === 'browser') return job.operation.action.kind;
    if (job.operation.kind === 'environment') return job.cwd;
    if (job.operation.kind === 'readiness') {
      const url = new URL(job.operation.url);
      return `${url.origin}${url.pathname}`;
    }
    return job.operation.ecosystem;
  }

  function formatTime(value: string | null): string {
    if (value === null) return t('executionNotAvailable');
    return new Intl.DateTimeFormat(locale === 'ko' ? 'ko-KR' : 'en-US', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  }

  function formatDuration(durationMs: number): string {
    if (durationMs < 1_000) return String(durationMs) + ' ms';
    return String((durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)) + ' s';
  }

  function readinessSummary(job: ProjectExecJob): string {
    const result = job.readiness_result;
    if (result === undefined) return '';
    return `${t(result.ready ? 'executionReadinessReady' : 'executionReadinessNotReady')} · ${t('executionReadinessEvidence', { status: result.status_code ?? '—', attempts: result.attempts_used })}`;
  }

  async function loadJob(jobId: string, showLoading: boolean): Promise<ProjectExecJob | null> {
    if (inFlightJobId === jobId) return null;
    const requestId = ++requestSerial;
    inFlightJobId = jobId;
    if (showLoading) loading = true;
    error = '';
    try {
      const result = await window.chatsplice.getExecutionJob({
        workspace_id: workspaceId,
        job_id: jobId,
      });
      if (requestId !== requestSerial || selectedJobId !== jobId) return null;
      selectedJob = result;
      if (!isActive(result.state)) clearPolling();
      return result;
    } catch {
      if (requestId === requestSerial && selectedJobId === jobId) {
        error = t('executionLoadError');
      }
      return null;
    } finally {
      if (requestId === requestSerial) loading = false;
      if (inFlightJobId === jobId) inFlightJobId = null;
    }
  }

  function startPolling(): void {
    if (destroyed) return;
    clearPolling();
    pollTimer = window.setInterval(() => {
      if (selectedJobId !== '') void loadJob(selectedJobId, false);
    }, 1_000);
  }

  async function selectJob(summary: ProjectExecSummary): Promise<void> {
    if (selectedJobId === summary.job_id && selectedJob !== null) return;
    clearPolling();
    selectedJobId = summary.job_id;
    selectedJob = null;
    const loadedJob = await loadJob(summary.job_id, true);
    if (destroyed || selectedJobId !== summary.job_id) return;
    if (loadedJob !== null && isActive(loadedJob.state)) startPolling();
    else if (isActive(summary.state)) startPolling();
  }

  async function cancelSelectedJob(): Promise<void> {
    if (selectedJob === null || !isActive(selectedJob.state) || cancelling) return;
    const targetJobId = selectedJob.job_id;
    const targetWorkspaceId = workspaceId;
    const requestId = ++requestSerial;
    cancelling = true;
    error = '';
    try {
      const result = await window.chatsplice.cancelExecutionJob({
        workspace_id: targetWorkspaceId,
        job_id: targetJobId,
      });
      if (requestId !== requestSerial || selectedJobId !== targetJobId) return;
      selectedJob = result;
      if (!isActive(result.state)) clearPolling();
    } catch {
      if (!destroyed && requestId === requestSerial && selectedJobId === targetJobId) {
        error = t('executionCancelError');
      }
    } finally {
      cancelling = false;
    }
  }

  function visibleOutput(job: ProjectExecJob): string {
    if (job.browser_result !== undefined) {
      const preview = job.browser_result;
      return [job.output, preview.title, preview.url, preview.text, ...preview.console]
        .join('\n')
        .slice(-MAX_VISIBLE_OUTPUT);
    }
    if (job.output === '') return t('executionNoOutput');
    return job.output.slice(-MAX_VISIBLE_OUTPUT);
  }

  onDestroy(() => {
    destroyed = true;
    requestSerial += 1;
    clearPolling();
  });
</script>

<section
  class:console-execution-section={compact}
  class="modal-section execution-jobs"
  aria-labelledby="execution-jobs-title"
>
  {#if compact}
    <h3 id="execution-jobs-title" class="sr-only">{t('recentExecutions')}</h3>
  {/if}
  {#if !compact}
    <div class="modal-section-heading execution-heading">
      <div>
        <h3 id="execution-jobs-title">{t('recentExecutions')}</h3>
        <p>{t('executionFromChat')}</p>
      </div>
      {#if workspaceJobs.some((job) => isActive(job.state))}
        <span class="execution-live-badge">{t('executionActive')}</span>
      {/if}
    </div>
  {/if}

  {#if workspaceJobs.length > 0}
    <div class="execution-history-summary" data-testid="execution-failure-overview">
      <div class="execution-history-scope">
        <strong
          >{t('executionHistoryScope', {
            count: workspaceJobs.length,
            failures: failureCount,
          })}</strong
        >
        <small
          >{t('executionHistoryRange', {
            from: formatTime(workspaceJobs[workspaceJobs.length - 1]!.created_at),
            to: formatTime(workspaceJobs[0]!.created_at),
          })}</small
        >
        <details class="execution-retention-note">
          <summary>{t('consoleSessionOnly')}</summary>
          <p>{t('executionHistoryRetention')}</p>
        </details>
      </div>
      <label class="execution-failure-filter">
        <span>{t('executionFailureFilter')}</span>
        <select
          value={failureFilter}
          onchange={(event) => changeFailureFilter(event.currentTarget.value)}
        >
          <option value="all">{t('executionFailureAll', { count: workspaceJobs.length })}</option>
          {#if failureCount > 0}
            <option value="failed">{t('executionFailureOnly', { count: failureCount })}</option>
          {/if}
          {#each failureGroups as group (group.cause)}
            <option value={group.cause}
              >{t('executionFailureOption', {
                cause: t(executionFailureTitle(group.cause)),
                count: group.count,
              })}</option
            >
          {/each}
        </select>
      </label>
    </div>
  {/if}

  {#if jobs === undefined}
    <p class="execution-empty" role="status">{t('executionLoading')}</p>
  {:else if workspaceJobs.length === 0}
    <p class="execution-empty">{t('executionEmpty')}</p>
  {:else if compact}
    <div class="execution-compact-layout">
      <div
        class="execution-compact-list execution-list"
        role="list"
        aria-label={t('recentExecutions')}
      >
        {#each visibleJobs.slice(0, 100) as summary (summary.job_id)}
          <div role="listitem">
            <button
              type="button"
              class:selected={summary.job_id === selectedJobId}
              class="execution-row"
              aria-pressed={summary.job_id === selectedJobId}
              onclick={() => void selectJob(summary)}
            >
              <i class="execution-dot {summary.state}" aria-hidden="true"></i>
              <span class="execution-row-copy">
                <strong>{t(operationKey(summary))} · {operationDetail(summary)}</strong>
                <small
                  >{t(executionProgressView(summary)?.title ?? stateKey(summary.state))} · {formatTime(
                    summary.created_at,
                  )}</small
                >
              </span>
            </button>
          </div>
        {/each}
      </div>

      <div class="execution-compact-log" aria-live="polite">
        {#if error !== ''}
          <p class="execution-error" role="alert">{error}</p>
        {/if}
        {#if loading}
          <p class="execution-empty" role="status">{t('executionLoading')}</p>
        {:else if selectedJob !== null}
          <div class="execution-detail execution-detail-compact">
            <div class="execution-compact-log-heading">
              <div class="execution-detail-heading">
                <div>
                  <strong>{t('executionCommand')}</strong>
                  <code title={selectedJob.command}>{selectedJob.command}</code>
                </div>
                <span class="execution-state {selectedJob.state}"
                  >{t(stateKey(selectedJob.state))}</span
                >
              </div>
              {#if isActive(selectedJob.state)}
                <button
                  type="button"
                  class="danger-button execution-cancel"
                  onclick={() => void cancelSelectedJob()}
                  disabled={cancelling || selectedJob.state === 'cancelling'}
                >
                  {cancelling || selectedJob.state === 'cancelling'
                    ? t('executionCancelPending')
                    : t('executionCancel')}
                </button>
              {/if}
            </div>
            <ExecutionProgressDetail job={selectedJob} {locale} />
            <ExecutionFailureDetail job={selectedJob} {locale} />
            {#if (selectedJob.message !== '' && executionProgressView(selectedJob) === null) || selectedJob.error_code !== null}
              <p class="execution-message">{selectedJob.message}</p>
              {#if selectedJob.error_code !== null}
                <small class="execution-error-code"
                  >{t('executionErrorCode')}: {selectedJob.error_code}</small
                >
              {/if}
            {/if}
            {#if selectedJob.readiness_result !== undefined}
              <p class="execution-message">{readinessSummary(selectedJob)}</p>
            {/if}
            {#if selectedJob.environment_result !== undefined}
              <p class="execution-message">
                {t('executionEnvironmentIssues', {
                  count: selectedJob.environment_result.issues.length,
                })}
              </p>
            {/if}
            <pre class="execution-output">{visibleOutput(selectedJob)}</pre>
            <details class="execution-compact-meta">
              <summary>{t('executionDetails')}</summary>
              <dl class="execution-meta">
                <div>
                  <dt>{t('executionExitCode')}</dt>
                  <dd>{selectedJob.exit_code ?? t('executionNotAvailable')}</dd>
                </div>
                <div>
                  <dt>{t('executionStarted')}</dt>
                  <dd>{formatTime(selectedJob.started_at)}</dd>
                </div>
                <div>
                  <dt>{t('executionFinished')}</dt>
                  <dd>{formatTime(selectedJob.finished_at)}</dd>
                </div>
                <div>
                  <dt>{t('executionDuration')}</dt>
                  <dd>{formatDuration(selectedJob.duration_ms)}</dd>
                </div>
                <div>
                  <dt>{t('executionJobId')}</dt>
                  <dd class="execution-job-id">{selectedJob.job_id}</dd>
                </div>
                <div>
                  <dt>{t('executionCwd')}</dt>
                  <dd title={selectedJob.cwd}>
                    {#if selectedJob.reference_workspace_name}
                      <span
                        >{t('executionSharedFolder')}: {selectedJob.reference_workspace_name}</span
                      ><br />
                    {/if}
                    {selectedJob.cwd}
                  </dd>
                </div>
                <div>
                  <dt title={t('executionNetworkHelp')}>{t('executionNetwork')}</dt>
                  <dd title={t('executionNetworkHelp')}>{t(executionNetworkKey(selectedJob))}</dd>
                </div>
                <div>
                  <dt>{t('executionOutput')}</dt>
                  <dd>
                    {selectedJob.truncated || selectedJob.output.length > MAX_VISIBLE_OUTPUT
                      ? t('executionOutputTruncated')
                      : t('executionOutputComplete')}
                  </dd>
                </div>
              </dl>
            </details>
          </div>
        {:else if selectedSummary !== undefined}
          <p class="execution-empty">{t('executionLoading')}</p>
        {/if}
      </div>
    </div>
  {:else}
    <div class="execution-list" role="list" aria-label={t('recentExecutions')}>
      {#each visibleJobs.slice(0, 8) as summary (summary.job_id)}
        <div role="listitem">
          <button
            type="button"
            class:selected={summary.job_id === selectedJobId}
            class="execution-row"
            aria-pressed={summary.job_id === selectedJobId}
            onclick={() => void selectJob(summary)}
          >
            <i class="execution-dot {summary.state}" aria-hidden="true"></i>
            <span class="execution-row-copy">
              <strong>{t(operationKey(summary))} · {operationDetail(summary)}</strong>
              <small
                >{t(executionProgressView(summary)?.title ?? stateKey(summary.state))} · {formatTime(
                  summary.created_at,
                )}</small
              >
            </span>
          </button>
        </div>
      {/each}
    </div>

    {#if error !== ''}
      <p class="execution-error" role="alert">{error}</p>
    {/if}

    {#if loading}
      <p class="execution-empty" role="status">{t('executionLoading')}</p>
    {:else if selectedJob !== null}
      <div class="execution-detail" aria-live="polite">
        <div class="execution-detail-heading">
          <div>
            <strong>{t('executionCommand')}</strong>
            <code title={selectedJob.command}>{selectedJob.command}</code>
          </div>
          <span class="execution-state {selectedJob.state}">{t(stateKey(selectedJob.state))}</span>
        </div>
        <dl class="execution-meta">
          <div>
            <dt>{t('executionExitCode')}</dt>
            <dd>{selectedJob.exit_code ?? t('executionNotAvailable')}</dd>
          </div>
          <div>
            <dt>{t('executionStarted')}</dt>
            <dd>{formatTime(selectedJob.started_at)}</dd>
          </div>
          <div>
            <dt>{t('executionFinished')}</dt>
            <dd>{formatTime(selectedJob.finished_at)}</dd>
          </div>
          <div>
            <dt>{t('executionDuration')}</dt>
            <dd>{formatDuration(selectedJob.duration_ms)}</dd>
          </div>
          <div>
            <dt>{t('executionJobId')}</dt>
            <dd class="execution-job-id">{selectedJob.job_id}</dd>
          </div>
          <div>
            <dt>{t('executionCwd')}</dt>
            <dd title={selectedJob.cwd}>
              {#if selectedJob.reference_workspace_name}
                <span>{t('executionSharedFolder')}: {selectedJob.reference_workspace_name}</span><br
                />
              {/if}
              {selectedJob.cwd}
            </dd>
          </div>
          <div>
            <dt title={t('executionNetworkHelp')}>{t('executionNetwork')}</dt>
            <dd title={t('executionNetworkHelp')}>{t(executionNetworkKey(selectedJob))}</dd>
          </div>
          <div>
            <dt>{t('executionOutput')}</dt>
            <dd>
              {selectedJob.truncated || selectedJob.output.length > MAX_VISIBLE_OUTPUT
                ? t('executionOutputTruncated')
                : t('executionOutputComplete')}
            </dd>
          </div>
        </dl>
        <ExecutionProgressDetail job={selectedJob} {locale} />
        <ExecutionFailureDetail job={selectedJob} {locale} />
        {#if (selectedJob.message !== '' && executionProgressView(selectedJob) === null) || selectedJob.error_code !== null}
          <p class="execution-message">{selectedJob.message}</p>
          {#if selectedJob.error_code !== null}
            <small class="execution-error-code"
              >{t('executionErrorCode')}: {selectedJob.error_code}</small
            >
          {/if}
        {/if}
        {#if selectedJob.readiness_result !== undefined}
          <p class="execution-message">{readinessSummary(selectedJob)}</p>
        {/if}
        {#if selectedJob.environment_result !== undefined}
          <p class="execution-message">
            {t('executionEnvironmentIssues', {
              count: selectedJob.environment_result.issues.length,
            })}
          </p>
        {/if}
        <pre class="execution-output">{visibleOutput(selectedJob)}</pre>
        {#if isActive(selectedJob.state)}
          <button
            type="button"
            class="danger-button execution-cancel"
            onclick={() => void cancelSelectedJob()}
            disabled={cancelling || selectedJob.state === 'cancelling'}
          >
            {cancelling || selectedJob.state === 'cancelling'
              ? t('executionCancelPending')
              : t('executionCancel')}
          </button>
        {/if}
      </div>
    {:else if selectedSummary !== undefined}
      <p class="execution-empty">{t('executionLoading')}</p>
    {/if}
  {/if}
</section>

<style>
  .execution-job-id {
    overflow-wrap: anywhere;
  }

  .console-execution-section {
    display: flex;
    min-height: 0;
    flex: 1 1 auto;
    flex-direction: column;
    overflow: hidden;
    gap: 0;
  }

  .execution-history-summary {
    display: flex;
    flex: 0 0 auto;
    min-width: 0;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 8px;
    color: var(--color-text);
    font-size: 11px;
  }

  .execution-history-scope {
    display: grid;
    min-width: 0;
    gap: 2px;
    word-break: keep-all;
    overflow-wrap: anywhere;
  }

  .execution-history-scope strong {
    font-size: 11px;
  }

  .execution-history-scope small,
  .execution-retention-note {
    color: var(--color-text-muted);
    font-size: 10px;
  }

  .execution-retention-note summary {
    width: fit-content;
    cursor: pointer;
  }

  .execution-retention-note p {
    max-width: 540px;
    margin: 4px 0;
  }

  .execution-failure-filter {
    display: grid;
    flex: 0 1 220px;
    min-width: 0;
    gap: 3px;
    color: var(--color-text-muted);
    font-size: 10px;
  }

  .execution-failure-filter select {
    width: 100%;
    min-width: 0;
    min-height: 28px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    padding: 3px 6px;
    color: var(--color-text);
    font-size: 11px;
  }

  .execution-failure-filter select:focus-visible,
  .execution-retention-note summary:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 2px;
  }

  @media (max-width: 560px) {
    .console-execution-section .execution-compact-list {
      max-height: 96px;
    }

    .execution-history-summary {
      flex-wrap: wrap;
      gap: 5px;
    }

    .execution-failure-filter {
      flex-basis: 100%;
    }
  }
</style>
