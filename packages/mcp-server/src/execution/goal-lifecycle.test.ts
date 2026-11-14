import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteWorkspaceRepository, WorkspaceService } from '@chatsplice/core';
import type { ProjectExecInput, ProjectExecSummary } from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProjectExecutionService, type ProjectExecutionGoalLifecycle } from './service.js';

const BINDING = `wb_${'0'.repeat(64)}`;
const GOAL_ID = 'goal_00000000-0000-4000-8000-000000000001';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('Goal execution receipts', () => {
  let directory: string;
  let repository: SqliteWorkspaceRepository;
  let workspace: WorkspaceService;
  let workspaceId: string;
  const services: ProjectExecutionService[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'chatsplice-goal-execution-'));
    const root = join(directory, 'project');
    await mkdir(root);
    repository = new SqliteWorkspaceRepository(join(directory, 'state.sqlite'));
    workspace = new WorkspaceService(repository);
    workspaceId = (await workspace.register({ root_path: root })).workspace_id;
  });

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.shutdown()));
    repository.close();
    await rm(directory, { recursive: true, force: true });
  });

  function request(): ProjectExecInput {
    return {
      workspace_id: workspaceId,
      workspace_binding: BINDING,
      request_id: 'goal-request-001',
      goal_id: GOAL_ID,
      criterion_id: 'check',
      cwd: '.',
      operation: { kind: 'cargo', task: 'check' },
      timeout_ms: 5000,
    };
  }

  function lifecycle(
    overrides: Partial<ProjectExecutionGoalLifecycle> = {},
  ): ProjectExecutionGoalLifecycle {
    return {
      onSubmit: () => undefined,
      beforeStart: async () => undefined,
      onFinish: async () => undefined,
      ...overrides,
    };
  }

  function start(
    hooks: ProjectExecutionGoalLifecycle,
    timeoutObserver?: (timeout: number) => void,
  ): ProjectExecutionService {
    const execution = new ProjectExecutionService(workspace, {
      goalLifecycle: hooks,
      backend: async (_workspace, input) => {
        timeoutObserver?.(input.timeout_ms);
        return { exit_code: 0, duration_ms: 1, timed_out: false };
      },
    });
    services.push(execution);
    return execution;
  }

  function awaitResult(execution: ProjectExecutionService, jobId: string, timeout = 1000) {
    return execution.awaitJob({
      workspace_id: workspaceId,
      workspace_binding: BINDING,
      job_id: jobId,
      timeout_ms: timeout,
    });
  }

  it('persists one acceptance for duplicate requests and preserves Goal ownership', async () => {
    const accepted: ProjectExecSummary[] = [];
    const finished: ProjectExecSummary[] = [];
    const execution = start(
      lifecycle({
        onSubmit: (summary) => {
          accepted.push(summary);
        },
        onFinish: async (summary) => {
          finished.push(summary);
        },
      }),
    );
    const job = execution.submit(request());
    expect(execution.submit(request()).job_id).toBe(job.job_id);
    expect(await awaitResult(execution, job.job_id)).toMatchObject({
      state: 'succeeded',
      goal_id: GOAL_ID,
      criterion_id: 'check',
    });
    expect(accepted).toHaveLength(1);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ state: 'succeeded', goal_id: GOAL_ID });
  });

  it('holds the root and conceals terminal success until the receipt is durable', async () => {
    const saving = deferred();
    const saved = deferred();
    const execution = start(
      lifecycle({
        onFinish: async () => {
          saving.resolve();
          await saved.promise;
        },
      }),
    );
    const job = execution.submit(request());
    try {
      await saving.promise;
      expect(workspace.isBusy(workspace.getRecord(workspaceId).rootPath)).toBe(true);
      expect(execution.getJob(workspaceId, job.job_id).state).toBe('running');
      expect((await awaitResult(execution, job.job_id, 0)).state).toBe('running');
    } finally {
      saved.resolve();
    }
    expect((await awaitResult(execution, job.job_id)).state).toBe('succeeded');
  });

  it('does not execute a queued job when Goal validation rejects the start', async () => {
    let executed = false;
    const finished: ProjectExecSummary[] = [];
    const execution = start(
      lifecycle({
        beforeStart: async () => {
          throw new Error('Goal was paused.');
        },
        onFinish: async (summary) => {
          finished.push(summary);
        },
      }),
      () => {
        executed = true;
      },
    );
    const job = execution.submit(request());
    expect(await awaitResult(execution, job.job_id)).toMatchObject({
      state: 'failed',
      message: 'Goal was paused.',
    });
    expect(executed).toBe(false);
    expect(finished[0]?.state).toBe('failed');
  });

  it('fails closed when durable receipt saving fails', async () => {
    const execution = start(
      lifecycle({
        onFinish: async () => {
          throw new Error('Database unavailable.');
        },
      }),
    );
    const job = execution.submit(request());
    expect(await awaitResult(execution, job.job_id)).toMatchObject({
      state: 'failed',
      error_code: 'INTERNAL_ERROR',
      message: 'Goal execution receipt could not be saved; inspect the Goal before continuing.',
    });
  });

  it('clamps backend time to the Goal deadline without changing request deduplication', async () => {
    let timeout: number | undefined;
    const execution = start(lifecycle({ executionTimeout: () => 1250 }), (value) => {
      timeout = value;
    });
    const input = request();
    const job = execution.submit(input);
    await awaitResult(execution, job.job_id);
    expect(timeout).toBe(1250);
    expect(input.timeout_ms).toBe(5000);
    expect(execution.submit(input).job_id).toBe(job.job_id);
  });
});
