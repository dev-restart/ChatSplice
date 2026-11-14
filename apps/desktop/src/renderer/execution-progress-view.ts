import type { ProjectExecSummary } from '@chatsplice/protocol';

import type { ExecutionTextKey } from './execution-diagnostics-text.js';
import type { UiLocale } from './i18n.js';

export interface ExecutionDiagnosticMetric {
  readonly label: ExecutionTextKey;
  readonly value: number;
  readonly duration: boolean;
}

export interface ExecutionProgressView {
  readonly title: ExecutionTextKey;
  readonly detail: ExecutionTextKey;
  readonly metrics: readonly ExecutionDiagnosticMetric[];
}

const STAGES: Record<string, readonly [ExecutionTextKey, ExecutionTextKey]> = {
  EXECUTION_WAITING_ROOT: ['executionProgressWaitRoot', 'executionProgressWaitRootDetail'],
  EXECUTION_WAITING_SLOT: ['executionProgressWaitSlot', 'executionProgressWaitSlotDetail'],
  EXECUTION_PREPARING: ['executionProgressPreparing', 'executionProgressPreparingDetail'],
  EXECUTION_PREFLIGHT: ['executionProgressInspecting', 'executionProgressInspectingDetail'],
  EXECUTION_RUNNING: ['executionProgressRunning', 'executionProgressRunningDetail'],
};

/** Read only known, unique numeric fields from bounded runner messages. */
function numberField(message: string, key: string): number | null {
  const expression = new RegExp('(?<![A-Za-z0-9_])' + key + '=([^;,]+)(?=[;,]|$)', 'g');
  const matches = [...message.matchAll(expression)];
  if (matches.length !== 1) return null;
  const raw = matches[0]![1]!.trim();
  if (!/^\d{1,9}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= 86_400_000 ? value : null;
}

function metric(
  message: string,
  key: string,
  label: ExecutionTextKey,
  duration = false,
): ExecutionDiagnosticMetric[] {
  const value = numberField(message, key);
  return value === null ? [] : [{ label, value, duration }];
}

export function executionProgressView(job: ProjectExecSummary): ExecutionProgressView | null {
  if (job.state === 'cancelling') {
    return {
      title: 'executionProgressCancelling',
      detail: 'executionProgressCancellingDetail',
      metrics: [],
    };
  }
  if (job.state !== 'queued' && job.state !== 'running') return null;
  if (job.message.length > 4_096) return null;
  const prefix = /^\[([A-Z_]+)\]/.exec(job.message)?.[1];
  const stage = prefix === undefined ? undefined : STAGES[prefix];
  if (stage === undefined) return null;
  let [title, detail] = stage;
  const metrics = [
    ...metric(job.message, 'phase_elapsed_ms', 'executionPhaseElapsed', true),
    ...metric(job.message, 'queue_ms', 'executionQueueElapsed', true),
  ];
  if (prefix === 'EXECUTION_PREFLIGHT') {
    if (/(?:^|[;\s])phase=checking_links(?:;|\s|$)/.test(job.message)) {
      title = 'executionProgressLinks';
      detail = 'executionProgressLinksDetail';
    } else if (/(?:^|[;\s])phase=complete(?:;|\s|$)/.test(job.message)) {
      title = 'executionProgressInspected';
      detail = 'executionProgressInspectedDetail';
    }
    metrics.push(
      ...metric(job.message, 'entries', 'executionInspectedEntries'),
      ...metric(job.message, 'roots', 'executionInspectedRoots'),
      ...metric(job.message, 'elapsed_ms', 'executionInspectionDuration', true),
    );
  }
  return { title, detail, metrics };
}

/** Stable preflight failure text separates measured values from configured limits. */
export function executionInspectionFailureMetrics(
  job: ProjectExecSummary,
): ExecutionDiagnosticMetric[] {
  if (job.state !== 'failed' && job.state !== 'timed_out') return [];
  if (
    job.message.length > 4_096 ||
    !/^\[EXECUTION_PREFLIGHT_(?:ENTRY|TIME|DEPTH)_LIMIT\]/.test(job.message)
  )
    return [];
  const observed = /Observed: ([\s\S]*?)\. Limits: ([\s\S]*?)\.(?:\s|$)/.exec(job.message);
  if (observed === null) return [];
  return [
    ...metric(observed[1]!, 'entries', 'executionInspectedEntries'),
    ...metric(observed[2]!, 'entries', 'executionEntryLimit'),
    ...metric(observed[1]!, 'elapsed_ms', 'executionInspectionDuration', true),
    ...metric(observed[2]!, 'duration_ms', 'executionInspectionTimeLimit', true),
  ];
}

export function formatExecutionMetric(locale: UiLocale, item: ExecutionDiagnosticMetric): string {
  const value = item.duration && item.value >= 1_000 ? item.value / 1_000 : item.value;
  const number = new Intl.NumberFormat(locale === 'ko' ? 'ko-KR' : 'en-US', {
    maximumFractionDigits: item.duration ? 1 : 0,
  }).format(value);
  if (!item.duration) return number;
  return number + (item.value < 1_000 ? ' ms' : locale === 'ko' ? '초' : ' s');
}
