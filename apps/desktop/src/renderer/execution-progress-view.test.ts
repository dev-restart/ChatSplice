import type { ProjectExecSummary } from '@chatsplice/protocol';
import { describe, expect, it } from 'vitest';

import { executionText } from './execution-diagnostics-text.js';
import {
  executionInspectionFailureMetrics,
  executionProgressView,
  formatExecutionMetric,
} from './execution-progress-view.js';

function job(message: string, state: ProjectExecSummary['state'] = 'running'): ProjectExecSummary {
  return {
    job_id: 'exec_00000000-0000-0000-0000-000000000001',
    workspace_id: 'ws_' + 'a'.repeat(24),
    workspace_name: 'Project',
    operation: { kind: 'shell', command: 'fixture-check', network: 'local' },
    cwd: '.',
    state,
    command: 'fixture-check',
    created_at: '2026-10-20T00:00:00.000Z',
    started_at: '2026-10-20T00:00:01.000Z',
    finished_at: null,
    exit_code: null,
    error_code: null,
    message,
    used_network: false,
    truncated: false,
    duration_ms: 1000,
  };
}

describe('execution progress presentation', () => {
  it.each([
    ['EXECUTION_WAITING_ROOT', 'executionProgressWaitRoot'],
    ['EXECUTION_WAITING_SLOT', 'executionProgressWaitSlot'],
    ['EXECUTION_PREPARING', 'executionProgressPreparing'],
    ['EXECUTION_RUNNING', 'executionProgressRunning'],
  ] as const)('shows the reported %s stage and measured waiting time', (prefix, title) => {
    const view = executionProgressView(
      job('[' + prefix + '] Local work. phase_elapsed_ms=1200; queue_ms=4000;'),
    )!;
    expect(view.title).toBe(title);
    expect(view.metrics).toEqual([
      { label: 'executionPhaseElapsed', value: 1200, duration: true },
      { label: 'executionQueueElapsed', value: 4000, duration: true },
    ]);
    expect(executionText('ko', view.title)).not.toEqual(executionText('en', view.title));
  });

  it('distinguishes scanning, final link validation, and completion without claiming command output', () => {
    for (const [phase, title] of [
      ['scanning', 'executionProgressInspecting'],
      ['checking_links', 'executionProgressLinks'],
      ['complete', 'executionProgressInspected'],
    ] as const) {
      const view = executionProgressView(
        job(
          '[EXECUTION_PREFLIGHT] phase=' +
            phase +
            '; roots=2; entries=250008; directories=800; elapsed_ms=5600; phase_elapsed_ms=1400; queue_ms=4000;',
        ),
      )!;
      expect(view.title).toBe(title);
      expect(view.metrics.find((item) => item.label === 'executionInspectedEntries')?.value).toBe(
        250008,
      );
      expect(view.metrics.find((item) => item.label === 'executionInspectionDuration')?.value).toBe(
        5600,
      );
      expect(view.metrics.find((item) => item.label === 'executionPhaseElapsed')?.value).toBe(1400);
    }
  });

  it('does not infer progress from legacy text, output flags, unknown prefixes, or completed jobs', () => {
    expect(executionProgressView(job('Project execution is running.'))).toBeNull();
    expect(executionProgressView(job('[UNKNOWN_STAGE] entries=4;'))).toBeNull();
    expect(executionProgressView(job('prefix [EXECUTION_RUNNING]'))).toBeNull();
    for (const state of ['failed', 'timed_out', 'succeeded', 'cancelled'] as const) {
      expect(executionProgressView(job('[EXECUTION_RUNNING]', state))).toBeNull();
    }
    expect(executionProgressView(job('[EXECUTION_PREFLIGHT] ' + 'x'.repeat(4096)))).toBeNull();
  });

  it('omits missing, duplicate, negative, fractional and unbounded numbers', () => {
    for (const fields of [
      'entries=1; entries=2;',
      'entries=-1;',
      'entries=1.5;',
      'entries=1e6;',
      'entries=999999999;',
      'entries=NaN;',
      'entries=4 trailing text;',
    ]) {
      const view = executionProgressView(job('[EXECUTION_PREFLIGHT] phase=scanning; ' + fields))!;
      expect(
        view.metrics.find((item) => item.label === 'executionInspectedEntries'),
      ).toBeUndefined();
    }
    expect(executionProgressView(job('[EXECUTION_RUNNING]'))?.metrics).toEqual([]);
  });

  it('uses explicit cancellation state independently from the previous stage', () => {
    const view = executionProgressView(job('[EXECUTION_PREFLIGHT] entries=8;', 'cancelling'))!;
    expect(view.title).toBe('executionProgressCancelling');
    expect(view.metrics).toEqual([]);
  });

  it('separates observed failure counts from configured limits and ignores legacy ambiguity', () => {
    const message =
      '[EXECUTION_PREFLIGHT_ENTRY_LIMIT] The command was not started. Observed: roots=1, entries=1000001, directories=800, depth=8, elapsed_ms=16000. Limits: entries=1000000, depth=64, duration_ms=60000.';
    const metrics = executionInspectionFailureMetrics(job(message, 'failed'));
    expect(metrics).toEqual([
      { label: 'executionInspectedEntries', value: 1000001, duration: false },
      { label: 'executionEntryLimit', value: 1000000, duration: false },
      { label: 'executionInspectionDuration', value: 16000, duration: true },
      { label: 'executionInspectionTimeLimit', value: 60000, duration: true },
    ]);
    expect(
      executionInspectionFailureMetrics(
        job(
          message +
            ' The inspection covers all permitted folders. Changing cwd does not reduce this scope.',
          'failed',
        ),
      ),
    ).toEqual(metrics);
    expect(executionInspectionFailureMetrics(job(message))).toEqual([]);
    expect(
      executionInspectionFailureMetrics(
        job(
          'The execution link inspection exceeded its bounded limit. Use a smaller workspace.',
          'failed',
        ),
      ),
    ).toEqual([]);
  });

  it('formats localized measured durations and counts without a client-side running clock', () => {
    expect(
      formatExecutionMetric('ko', {
        label: 'executionInspectedEntries',
        value: 250008,
        duration: false,
      }),
    ).toBe('250,008');
    expect(
      formatExecutionMetric('en', { label: 'executionPhaseElapsed', value: 5600, duration: true }),
    ).toBe('5.6 s');
    expect(
      formatExecutionMetric('ko', { label: 'executionPhaseElapsed', value: 5600, duration: true }),
    ).toBe('5.6초');
    expect(
      formatExecutionMetric('en', { label: 'executionPhaseElapsed', value: 800, duration: true }),
    ).toBe('800 ms');
  });
});
