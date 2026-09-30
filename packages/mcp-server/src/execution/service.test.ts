import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectExecAwaitInputSchema, type ProjectExecInput } from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceService } from '@chatsplice/core';
import { SqliteWorkspaceRepository } from '@chatsplice/core';

import type { ProjectExecutionBackend } from './backend.js';
import { ProjectExecutionService } from './service.js';

const WORKSPACE_BINDING = `wb_${'0'.repeat(64)}`;

function input(
  workspaceId: string,
  requestId: string,
  operation: ProjectExecInput['operation'] = { kind: 'cargo', task: 'check' },
): ProjectExecInput {
  return {
    workspace_id: workspaceId,
    workspace_binding: WORKSPACE_BINDING,
    request_id: requestId,
    cwd: '.',
    operation,
    timeout_ms: 5_000,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise?.() };
}

describe('ProjectExecutionService', () => {
  let temporaryDirectory: string;
  let repository: SqliteWorkspaceRepository;
  let workspaceService: WorkspaceService;
  let workspaceId: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-execution-'));
    const workspaceRoot = join(temporaryDirectory, 'workspace');
    await mkdir(workspaceRoot);
    repository = new SqliteWorkspaceRepository(join(temporaryDirectory, 'state.sqlite'));
    workspaceService = new WorkspaceService(repository);
    workspaceId = (await workspaceService.register({ root_path: workspaceRoot })).workspace_id;
  });

  afterEach(async () => {
    repository.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('deduplicates identical requests through a retained terminal job', async () => {
    let calls = 0;
    let readOnly = false;
    const backend: ProjectExecutionBackend = async (_service, _input, options) => {
      calls += 1;
      options.onStart({ command: 'fake cargo check', used_network: false });
      options.onOutput('ok\n');
      return { exit_code: 0, duration_ms: 3, timed_out: false };
    };
    const execution = new ProjectExecutionService(workspaceService, {
      backend,
      isReadOnly: () => readOnly,
    });
    const request = input(workspaceId, 'request-dedupe-1');
    const started = execution.submit(request);
    const result = await execution.awaitJob(
      ProjectExecAwaitInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        job_id: started.job_id,
        timeout_ms: 1_000,
      }),
    );

    expect(result).toMatchObject({
      state: 'succeeded',
      output: 'ok\n',
      command: 'fake cargo check',
    });
    expect(calls).toBe(1);
    readOnly = true;
    expect(execution.submit(request).job_id).toBe(started.job_id);
    expect(() =>
      execution.submit({ ...request, operation: { kind: 'cargo', task: 'test' } }),
    ).toThrow('request_id is already associated');
    expect(() => execution.submit(input(workspaceId, 'request-readonly-1'))).toThrow(
      'read-only mode',
    );
    await execution.shutdown();
  });

  it('retains a UTF-8-safe tail so late failure output remains available', async () => {
    const backend: ProjectExecutionBackend = async (_service, _input, options) => {
      options.onStart({ command: 'fake failing command', used_network: false });
      options.onOutput(`HEAD-${'x'.repeat(70_000)}`);
      options.onOutput('가나'.repeat(200));
      options.onOutput('\nLAST-FAILURE-LINE\n');
      return { exit_code: 7, duration_ms: 4, timed_out: false };
    };
    const execution = new ProjectExecutionService(workspaceService, { backend });
    const started = execution.submit(input(workspaceId, 'request-tail-1'));
    const result = await execution.awaitJob(
      ProjectExecAwaitInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        job_id: started.job_id,
        timeout_ms: 1_000,
      }),
    );

    expect(result.state).toBe('failed');
    expect(result.exit_code).toBe(7);
    expect(result.truncated).toBe(true);
    expect(result.output).not.toContain('HEAD-');
    expect(result.output).toContain('LAST-FAILURE-LINE');
    expect(result.output).not.toContain('\uFFFD');
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    await execution.shutdown();
  });

  it('retains install mode in summaries and request fingerprints', async () => {
    const backend: ProjectExecutionBackend = async (_service, _input, options) => {
      options.onStart({ command: 'fake install', used_network: true });
      return { exit_code: 0, duration_ms: 2, timed_out: false };
    };
    const execution = new ProjectExecutionService(workspaceService, { backend });
    const request = input(workspaceId, 'request-install-mode', {
      kind: 'install',
      ecosystem: 'node',
      mode: 'locked',
    });
    const started = execution.submit(request);

    expect(started.operation).toEqual(request.operation);
    expect(execution.submit(request)).toMatchObject({
      job_id: started.job_id,
      operation: { kind: 'install', ecosystem: 'node', mode: 'locked' },
    });
    expect(() =>
      execution.submit({
        ...request,
        operation: { kind: 'install', ecosystem: 'node', mode: 'resolve' },
      }),
    ).toThrow('request_id is already associated');
    await execution.shutdown();
  });

  it('keeps a queued root reservation until cancellation cleanup completes', async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    let calls = 0;
    const backend: ProjectExecutionBackend = async (_service, _input, options) => {
      calls += 1;
      options.onStart({ command: 'fake', used_network: false });
      firstStarted.resolve();
      await releaseFirst.promise;
      return { exit_code: 0, duration_ms: 2, timed_out: false };
    };
    const execution = new ProjectExecutionService(workspaceService, { backend });
    const first = execution.submit(input(workspaceId, 'request-first-1'));
    await firstStarted.promise;
    const second = execution.submit(input(workspaceId, 'request-second-1'));

    expect(() => workspaceService.remove(workspaceId)).toThrow('queued or running operations');
    const cancelling = execution.cancel(workspaceId, second.job_id);
    expect(cancelling.state).toBe('cancelling');
    releaseFirst.resolve();
    const secondResult = await execution.awaitJob(
      ProjectExecAwaitInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        job_id: second.job_id,
        timeout_ms: 1_000,
      }),
    );

    expect(secondResult.state).toBe('cancelled');
    expect(calls).toBe(1);
    await execution.awaitJob(
      ProjectExecAwaitInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        job_id: first.job_id,
        timeout_ms: 1_000,
      }),
    );
    await execution.shutdown();
  });

  it('limits two running jobs globally while allowing independent roots to queue', async () => {
    const additionalRoots = await Promise.all(
      ['workspace-b', 'workspace-c'].map(async (name) => {
        const root = join(temporaryDirectory, name);
        await mkdir(root);
        return root;
      }),
    );
    const additionalWorkspaces = await Promise.all(
      additionalRoots.map((root) => workspaceService.register({ root_path: root })),
    );
    const workspaces = [workspaceId, ...additionalWorkspaces.map((item) => item.workspace_id)];
    const started = workspaces.map(() => deferred());
    const releases = workspaces.map(() => deferred());
    let calls = 0;
    const backend: ProjectExecutionBackend = async (_service, _input, options) => {
      const index = calls;
      calls += 1;
      options.onStart({ command: `fake-${index}`, used_network: false });
      started[index]?.resolve();
      await releases[index]!.promise;
      return { exit_code: 0, duration_ms: 2, timed_out: false };
    };
    const execution = new ProjectExecutionService(workspaceService, { backend });
    const jobs = workspaces.map((workspace, index) =>
      execution.submit(input(workspace, `request-global-${index}`)),
    );

    await Promise.all([started[0]!.promise, started[1]!.promise]);
    expect(calls).toBe(2);
    expect(jobs[2]?.state).toBe('queued');

    releases[0]!.resolve();
    await started[2]!.promise;
    expect(calls).toBe(3);
    releases[1]!.resolve();
    releases[2]!.resolve();
    await Promise.all(
      jobs.map((job) =>
        execution.awaitJob(
          ProjectExecAwaitInputSchema.parse({
            workspace_id: job.workspace_id,
            workspace_binding: WORKSPACE_BINDING,
            job_id: job.job_id,
            timeout_ms: 1_000,
          }),
        ),
      ),
    );
    await execution.shutdown();
  });

  it('rechecks read-only mode after a queued job acquires its execution slot', async () => {
    let readOnly = false;
    const firstStarted = deferred();
    const releaseFirst = deferred();
    let calls = 0;
    const backend: ProjectExecutionBackend = async (_service, _input, options) => {
      calls += 1;
      options.onStart({ command: 'fake', used_network: false });
      if (calls === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return { exit_code: 0, duration_ms: 1, timed_out: false };
    };
    const execution = new ProjectExecutionService(workspaceService, {
      backend,
      isReadOnly: () => readOnly,
    });
    execution.submit(input(workspaceId, 'request-slot-first'));
    await firstStarted.promise;
    const second = execution.submit(input(workspaceId, 'request-slot-second'));
    readOnly = true;
    releaseFirst.resolve();

    const result = await execution.awaitJob(
      ProjectExecAwaitInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        job_id: second.job_id,
        timeout_ms: 1_000,
      }),
    );
    expect(result.state).toBe('failed');
    expect(result.error_code).toBe('READ_ONLY_MODE_ENABLED');
    expect(calls).toBe(1);
    await execution.shutdown();
  });
});
