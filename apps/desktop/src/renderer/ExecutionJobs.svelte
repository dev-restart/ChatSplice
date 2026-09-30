<script lang="ts">
  import { onDestroy } from 'svelte';

  import type { ProjectExecJob, ProjectExecState, ProjectExecSummary } from '@chatsplice/protocol';

  import { uiText, type UiLocale, type UiTextKey } from './i18n.js';

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
  let loading = false;
  let error = '';
  let cancelling = false;
  let pollTimer: number | undefined;
  let requestSerial = 0;
  let inFlightJobId: string | null = null;
  let lastWorkspaceId = workspaceId;
  let lastFocusedJobId = '';
  let destroyed = false;

  $: t = (key: UiTextKey, values: Record<string, string | number> = {}) =>
    uiText(locale, key, values);
  $: workspaceJobs = (jobs ?? [])
    .filter((job) => job.workspace_id === workspaceId)
    .slice()
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  $: selectedSummary = workspaceJobs.find((job) => job.job_id === selectedJobId);
  $: if (workspaceId !== lastWorkspaceId) {
    lastWorkspaceId = workspaceId;
    lastFocusedJobId = '';
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
      void selectJob(focusedSummary);
    }
  }
  $: if (selectedJob !== null && selectedJob.job_id !== selectedJobId) {
    selectedJob = null;
  }
  $: if (selectedJobId === '' && workspaceJobs[0] !== undefined) {
    void selectJob(workspaceJobs[0]);
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
    if (job.operation.mode === 'resolve') return 'executionLockfileRefresh';
    return 'executionInstall';
  }

  function operationDetail(job: ProjectExecSummary): string {
    if (job.operation.kind === 'node_script') return job.operation.script;
    if (job.operation.kind === 'cargo') return job.operation.task;
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
    if (destroyed) return;
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
        {#each workspaceJobs.slice(0, 100) as summary (summary.job_id)}
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
                <small>{t(stateKey(summary.state))} · {formatTime(summary.created_at)}</small>
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
            {#if selectedJob.message !== '' || selectedJob.error_code !== null}
              <p class="execution-message">{selectedJob.message}</p>
              {#if selectedJob.error_code !== null}
                <small class="execution-error-code"
                  >{t('executionErrorCode')}: {selectedJob.error_code}</small
                >
              {/if}
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
                  <dt>{t('executionCwd')}</dt>
                  <dd title={selectedJob.cwd}>{selectedJob.cwd}</dd>
                </div>
                <div>
                  <dt>{t('executionNetwork')}</dt>
                  <dd>
                    {selectedJob.used_network
                      ? t('executionNetworkUsed')
                      : t('executionNetworkNotUsed')}
                  </dd>
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
      {#each workspaceJobs.slice(0, 8) as summary (summary.job_id)}
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
              <small>{t(stateKey(summary.state))} · {formatTime(summary.created_at)}</small>
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
            <dt>{t('executionCwd')}</dt>
            <dd title={selectedJob.cwd}>{selectedJob.cwd}</dd>
          </div>
          <div>
            <dt>{t('executionNetwork')}</dt>
            <dd>
              {selectedJob.used_network ? t('executionNetworkUsed') : t('executionNetworkNotUsed')}
            </dd>
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
        {#if selectedJob.message !== '' || selectedJob.error_code !== null}
          <p class="execution-message">{selectedJob.message}</p>
          {#if selectedJob.error_code !== null}
            <small class="execution-error-code"
              >{t('executionErrorCode')}: {selectedJob.error_code}</small
            >
          {/if}
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
