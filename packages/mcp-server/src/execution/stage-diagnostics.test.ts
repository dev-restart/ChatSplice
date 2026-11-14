import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteWorkspaceRepository, WorkspaceService } from '@chatsplice/core';
import { ProjectExecInputSchema } from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectExecutionBackendOptions } from './backend.js';
import { ProjectExecutionService } from './service.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('execution waiting and preflight observations', () => {
  let root: string;
  let repository: SqliteWorkspaceRepository;
  let workspaceService: WorkspaceService;
  let executionService: ProjectExecutionService | undefined;
  let workspaceId: string;
  let secondId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chatsplice-execution-stages-'));
    repository = new SqliteWorkspaceRepository(join(root, 'state.sqlite'));
    workspaceService = new WorkspaceService(repository);
    await mkdir(join(root, 'first'));
    await mkdir(join(root, 'second'));
    workspaceId = (await workspaceService.register({ root_path: join(root, 'first') }))
      .workspace_id;
    secondId = (await workspaceService.register({ root_path: join(root, 'second') })).workspace_id;
  });

  afterEach(async () => {
    await executionService?.shutdown();
    repository.close();
    await rm(root, { recursive: true, force: true });
  });

  const input = (id = workspaceId, request = 'stage-regression') =>
    ProjectExecInputSchema.parse({
      workspace_id: id,
      workspace_binding: `wb_${'0'.repeat(64)}`,
      request_id: request,
      operation: { kind: 'shell', command: 'echo stage', network: 'local' },
      timeout_ms: 30_000,
    });

  it('shows root wait, inspection and local work without treating inspection completion as success', async () => {
    const inspected = deferred();
    const inspectComplete = deferred();
    const completeObserved = deferred();
    const startWork = deferred();
    const workStarted = deferred();
    const finishWork = deferred();
    let callbacks: ProjectExecutionBackendOptions | undefined;
    executionService = new ProjectExecutionService(workspaceService, {
      backend: async (_service, _input, options) => {
        callbacks = options;
        const stats = {
          roots: 1,
          entries: 201_001,
          directories: 101,
          depth: 4,
          elapsed_ms: 1250,
          entry_limit: 1_000_000,
          depth_limit: 64,
          duration_limit_ms: 60_000,
        };
        options.onPreflight?.({ phase: 'scanning', ...stats });
        inspected.resolve();
        await inspectComplete.promise;
        options.onPreflight?.({ phase: 'complete', ...stats });
        completeObserved.resolve();
        await startWork.promise;
        options.onStart({ command: 'echo stage', used_network: false });
        options.onOutput('command output only\n');
        workStarted.resolve();
        await finishWork.promise;
        return { exit_code: 0, duration_ms: 20, timed_out: false };
      },
    });
    const release = workspaceService.operations.tryReserve(
      workspaceService.getRecord(workspaceId).rootPath,
    )!;
    const accepted = executionService.submit(input());
    try {
      expect(accepted.message).toContain('[EXECUTION_WAITING_ROOT]');
      expect(accepted.started_at).toBeNull();
      expect(executionService.submit(input()).job_id).toBe(accepted.job_id);
      release();
      await inspected.promise;
      const inspecting = executionService.getJob(workspaceId, accepted.job_id);
      expect(inspecting.message).toContain('[EXECUTION_PREFLIGHT]');
      expect(inspecting.message).toContain('phase=scanning;');
      expect(inspecting.message).toContain('entries=201001;');
      expect(inspecting.message).toMatch(/queue_ms=\d+;/u);
      expect(inspecting.message).toMatch(/phase_elapsed_ms=\d+;/u);
      expect(inspecting.output).toBe('');
      inspectComplete.resolve();
      await completeObserved.promise;
      const complete = executionService.getJob(workspaceId, accepted.job_id);
      expect(complete.state).toBe('running');
      expect(complete.exit_code).toBeNull();
      expect(complete.message).toContain('phase=complete;');
      startWork.resolve();
      await workStarted.promise;
      expect(executionService.getJob(workspaceId, accepted.job_id).message).toContain(
        '[EXECUTION_RUNNING]',
      );
      finishWork.resolve();
      const result = await executionService.waitForCompletion(workspaceId, accepted.job_id);
      expect(result.state).toBe('succeeded');
      expect(result.message).toBe('Project execution succeeded.');
      expect(result.output).toBe('command output only\n');
      callbacks?.onPreflight?.({
        phase: 'scanning',
        roots: 1,
        entries: 0,
        directories: 0,
        depth: 0,
        elapsed_ms: 0,
        entry_limit: 1_000_000,
        depth_limit: 64,
        duration_limit_ms: 60_000,
      });
      expect(executionService.getJob(workspaceId, accepted.job_id).message).toBe(result.message);
    } finally {
      release();
      inspectComplete.resolve();
      startWork.resolve();
      finishWork.resolve();
    }
  });

  it('distinguishes execution-slot waiting from root waiting and preserves cancellation', async () => {
    const entered = deferred();
    const finish = deferred();
    const called: string[] = [];
    executionService = new ProjectExecutionService(workspaceService, {
      concurrency: { foreground: 1, background: 1, browser_sessions: 1, pending: 8 },
      backend: async (_service, request, options) => {
        called.push(request.workspace_id);
        options.onStart({ command: 'echo stage', used_network: false });
        entered.resolve();
        await finish.promise;
        return { exit_code: 0, duration_ms: 1, timed_out: false };
      },
    });
    const first = executionService.submit(input());
    try {
      await entered.promise;
      const second = executionService.submit(input(secondId, 'second-stage'));
      await vi.waitFor(() => {
        expect(executionService!.getJob(secondId, second.job_id).message).toContain(
          '[EXECUTION_WAITING_SLOT]',
        );
      });
      executionService.cancel(secondId, second.job_id);
      const cancelled = await executionService.waitForCompletion(secondId, second.job_id);
      expect(cancelled.state).toBe('cancelled');
      expect(cancelled.message).toBe('Project execution was cancelled.');
      expect(called).toEqual([workspaceId]);
      finish.resolve();
      await executionService.waitForCompletion(workspaceId, first.job_id);
    } finally {
      finish.resolve();
    }
  });
});
