import type { ProjectExecSummary } from '@chatsplice/protocol';
import { describe, expect, it } from 'vitest';

import {
  executionFailureView,
  executionNetworkKey,
  filterExecutionFailures,
  groupExecutionFailures,
  retainedWorkspaceExecutions,
} from './execution-failure-view.js';
import { executionText as uiText } from './execution-diagnostics-text.js';

const workspaceId = 'ws_' + 'a'.repeat(24);
const otherId = 'ws_' + 'b'.repeat(24);
const legacyLimit =
  'The execution link inspection exceeded its bounded limit. Use a smaller workspace.';

function job(overrides: Partial<ProjectExecSummary> = {}): ProjectExecSummary {
  return {
    job_id: 'exec_00000000-0000-0000-0000-000000000001',
    workspace_id: workspaceId,
    workspace_name: 'Project',
    operation: { kind: 'node_script', script: 'check' },
    cwd: 'web',
    state: 'failed',
    command: 'pnpm run check',
    created_at: '2026-10-19T12:00:00.000Z',
    started_at: '2026-10-19T12:00:01.000Z',
    finished_at: '2026-10-19T12:00:07.000Z',
    exit_code: null,
    error_code: 'BAD_REQUEST',
    message: legacyLimit,
    used_network: false,
    truncated: false,
    duration_ms: 6000,
    ...overrides,
  };
}

describe('execution failure presentation', () => {
  it('identifies an explicit file wait timeout without treating generic waiting as a failure', () => {
    const failure = executionFailureView(
      job({
        message:
          '[WORKSPACE_OPERATION_WAIT_TIMEOUT] This change did not start. wait_limit_ms=15000;',
      }),
    );
    expect(failure?.cause).toBe('workspace_busy');
    expect(uiText('ko', failure!.title)).toBe('파일 작업 대기 시간 초과');
    expect(uiText('en', failure!.title)).toBe('File operation wait timed out');
    expect(executionFailureView(job({ message: 'Waiting for a file operation.' }))?.cause).toBe(
      'request',
    );
    expect(
      executionFailureView(job({ state: 'queued', message: '[WORKSPACE_OPERATION_WAIT_TIMEOUT]' })),
    ).toBeNull();
  });

  it('recognizes retained legacy preflight errors before treating BAD_REQUEST as configuration', () => {
    expect(executionFailureView(job())?.cause).toBe('preflight_limit');
    const legacyDepth = executionFailureView(
      job({
        message: 'The execution link inspection depth limit was exceeded.',
      }),
    );
    expect(legacyDepth?.cause).toBe('preflight_limit');
    expect(legacyDepth?.detail).toBe('executionFailureDepthLimitDetail');
    expect(legacyDepth?.next).toBe('executionFailureDepthLimitNext');
    expect(executionFailureView(job())?.detail).toBe('executionFailurePreflightLimitDetail');
  });

  it.each(['ENTRY', 'TIME', 'DEPTH'])(
    'recognizes the stable %s limit marker without parsing paths or logs',
    (kind) => {
      const failure = executionFailureView(
        job({
          message:
            '[EXECUTION_PREFLIGHT_' +
            kind +
            '_LIMIT] Command was not started. Observed: roots=2, entries=200001.',
        }),
      );
      expect(failure?.cause).toBe('preflight_limit');
      const limit = kind === 'ENTRY' ? 'Entry' : kind === 'TIME' ? 'Time' : 'Depth';
      expect(failure?.detail).toBe('executionFailure' + limit + 'LimitDetail');
      expect(failure?.next).toBe('executionFailure' + limit + 'LimitNext');
      for (const locale of ['ko', 'en'] as const) {
        expect(uiText(locale, failure!.detail).length).toBeGreaterThan(0);
        expect(uiText(locale, failure!.next).length).toBeGreaterThan(0);
      }
    },
  );

  it('does not infer a permission denial or command start from an empty result or network flag', () => {
    for (const used_network of [false, true]) {
      expect(
        executionFailureView(
          job({
            used_network,
            message: 'Project execution failed.',
            error_code: null,
            exit_code: null,
          }),
        )?.cause,
      ).toBe('unknown');
    }
    expect(
      executionFailureView(
        job({
          message: 'Unknown request problem.',
          error_code: 'BAD_REQUEST',
        }),
      )?.cause,
    ).toBe('request');
  });

  it('distinguishes a missing tool, missing browser, denied startup, and failed browser action', () => {
    expect(
      executionFailureView(
        job({
          message: "A trusted pnpm executable was not found on ChatSplice's PATH.",
        }),
      )?.cause,
    ).toBe('tool_missing');
    expect(
      executionFailureView(
        job({
          message: '[browser_missing] Managed Chromium is missing.',
        }),
      )?.cause,
    ).toBe('browser_missing');
    expect(
      executionFailureView(
        job({
          message: '[browser_permission_denied] The environment denied startup.',
        }),
      )?.cause,
    ).toBe('permission');
    expect(
      executionFailureView(
        job({
          message: '[browser_launch_failed] Chromium could not start.',
        }),
      )?.cause,
    ).toBe('browser_start');
    expect(
      executionFailureView(
        job({
          operation: { kind: 'browser', action: { kind: 'open', url: 'http://127.0.0.1:5173' } },
          message: 'Project execution failed.',
          error_code: null,
          exit_code: 1,
        }),
      )?.cause,
    ).toBe('browser_action');
    expect(
      executionFailureView(
        job({
          operation: { kind: 'browser', action: { kind: 'setup' } },
          message: 'Project execution failed.',
          error_code: null,
          exit_code: 1,
        }),
      )?.cause,
    ).toBe('command');
  });

  it('keeps successful, active and cancelled jobs out of failure counts', () => {
    for (const state of ['succeeded', 'queued', 'running', 'cancelling', 'cancelled'] as const) {
      expect(executionFailureView(job({ state }))).toBeNull();
    }
    expect(
      executionFailureView(
        job({
          state: 'timed_out',
          message: 'Project execution timed out.',
          error_code: null,
        }),
      )?.cause,
    ).toBe('timeout');
  });

  it('scopes retained summaries to one project, deduplicates IDs, and bounds the visible history', () => {
    const inputs = Array.from({ length: 105 }, (_, index) =>
      job({
        job_id: 'exec_00000000-0000-0000-0000-' + String(index).padStart(12, '0'),
        created_at: new Date(Date.UTC(2026, 9, 19, 12, 0, index)).toISOString(),
      }),
    );
    const newest = inputs[104]!;
    const selected = retainedWorkspaceExecutions(
      [...inputs, newest, job({ workspace_id: otherId })],
      workspaceId,
    );
    expect(selected).toHaveLength(100);
    expect(selected[0]?.job_id).toBe(newest.job_id);
    expect(new Set(selected.map((entry) => entry.job_id)).size).toBe(100);
    expect(selected.every((entry) => entry.workspace_id === workspaceId)).toBe(true);
    expect(retainedWorkspaceExecutions(undefined, workspaceId)).toEqual([]);
  });

  it('groups known causes and includes unknown failures without inflating counts from cancellations', () => {
    const samples = [
      job(),
      job({ job_id: 'exec_00000000-0000-0000-0000-000000000002' }),
      job({ job_id: 'exec_00000000-0000-0000-0000-000000000003', state: 'cancelled' }),
      job({ job_id: 'exec_00000000-0000-0000-0000-000000000004', message: '', error_code: null }),
    ];
    expect(groupExecutionFailures(samples)).toEqual([
      { cause: 'preflight_limit', count: 2 },
      { cause: 'unknown', count: 1 },
    ]);
    expect(filterExecutionFailures(samples, 'failed')).toHaveLength(3);
    expect(filterExecutionFailures(samples, 'preflight_limit')).toHaveLength(2);
    expect(filterExecutionFailures(samples, 'all')).toHaveLength(4);
  });

  it('shows the requested network scope regardless of the legacy used_network flag', () => {
    for (const used_network of [false, true]) {
      expect(executionNetworkKey(job({ used_network }))).toBe('executionNetworkLocal');
      expect(
        executionNetworkKey(
          job({
            used_network,
            operation: { kind: 'cargo', task: 'check' },
          }),
        ),
      ).toBe('executionNetworkCargoLocal');
      expect(uiText('ko', 'executionNetworkCargoLocal')).toContain('로컬 통신');
      expect(uiText('ko', 'executionNetworkCargoLocal')).toContain('의존성 오프라인');
      expect(uiText('en', 'executionNetworkCargoLocal')).toContain('Local network');
      expect(uiText('en', 'executionNetworkCargoLocal')).toContain('dependencies offline');
      expect(
        executionNetworkKey(
          job({
            used_network,
            operation: { kind: 'shell', command: 'echo ok', network: 'local' },
          }),
        ),
      ).toBe('executionNetworkLocal');
      expect(
        executionNetworkKey(
          job({
            used_network,
            operation: { kind: 'shell', command: 'echo ok' },
          }),
        ),
      ).toBe('executionNetworkEnabled');
      expect(
        executionNetworkKey(
          job({
            used_network,
            operation: { kind: 'install', ecosystem: 'node' },
          }),
        ),
      ).toBe('executionNetworkEnabled');
      expect(
        executionNetworkKey(
          job({
            used_network,
            operation: { kind: 'browser', action: { kind: 'setup' } },
          }),
        ),
      ).toBe('executionNetworkEnabled');
      expect(
        executionNetworkKey(
          job({
            used_network,
            operation: { kind: 'browser', action: { kind: 'open', url: 'http://127.0.0.1:5173' } },
          }),
        ),
      ).toBe('executionNetworkLocal');
      expect(
        executionNetworkKey(
          job({
            used_network,
            operation: { kind: 'environment' },
          }),
        ),
      ).toBe('executionNetworkNone');
    }
  });

  it('provides localized diagnosis and next checks without claiming model refusal', () => {
    const failure = executionFailureView(job())!;
    for (const locale of ['ko', 'en'] as const) {
      const copy = [failure.title, failure.detail, failure.next].map((key) => uiText(locale, key));
      expect(copy.every((text) => text.length > 0)).toBe(true);
      expect(copy.join(' ')).not.toMatch(/model refused|모델.*거절/i);
    }
    expect(uiText('ko', 'executionHistoryScope', { count: 9, failures: 7 })).toContain('실패 7건');
    expect(uiText('en', 'executionHistoryScope', { count: 9, failures: 7 })).toContain(
      'failures: 7',
    );
  });
});
