import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { SqliteWorkspaceRepository, WorkspaceService } from '@chatsplice/core';
import type { ProjectExecInput } from '@chatsplice/protocol';
import { describe, expect, it } from 'vitest';

import { DESKTOP_EXECUTION_CONCURRENCY, ProjectExecutionService } from './service.js';

describe('workspace execution identity', () => {
  it('bounds independent foreground/background pools and admits a queued replacement after cancellation', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'cs-slots-'));
    const repository = new SqliteWorkspaceRepository(join(directory, 'state.sqlite'));
    const workspace = new WorkspaceService(repository);
    const started = new Set<string>();
    const service = new ProjectExecutionService(workspace, {
      concurrency: DESKTOP_EXECUTION_CONCURRENCY,
      backend: async (_workspace, input, options) => {
        started.add(input.request_id);
        await new Promise<void>((resolve) => {
          if (options.signal.aborted) resolve();
          else options.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { exit_code: 0, duration_ms: 1, timed_out: false };
      },
    });
    try {
      const jobs = [];
      for (let index = 0; index < 13; index += 1) {
        const root = join(directory, `project-${index}`);
        await mkdir(root);
        const registered = await workspace.register({ root_path: root });
        const input = {
          workspace_id: registered.workspace_id,
          workspace_binding: `wb_${'0'.repeat(64)}`,
          cwd: '.',
          timeout_ms: 5000,
        };
        jobs.push(
          service.submit({
            ...input,
            request_id: `background-${index}`,
            operation: {
              kind: 'shell',
              command: 'server',
              background: true,
              network: 'local',
            },
          }),
        );
        if (index < 9)
          jobs.push(
            service.submit({
              ...input,
              request_id: `foreground-${index}`,
              operation: {
                kind: 'shell',
                command: 'check',
                network: 'local',
              },
            }),
          );
      }
      await expect.poll(() => started.size).toBe(20);
      expect([...started].filter((id) => id.startsWith('foreground'))).toHaveLength(8);
      expect([...started].filter((id) => id.startsWith('background'))).toHaveLength(12);
      expect(started.has('foreground-8')).toBe(false);
      expect(started.has('background-12')).toBe(false);
      for (const job of jobs.slice(0, 2)) service.cancel(job.workspace_id, job.job_id);
      await expect
        .poll(() => started.has('foreground-8') && started.has('background-12'))
        .toBe(true);
    } finally {
      await service.shutdown();
      repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('deduplicates request IDs within a workspace and permits reuse across projects', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'cs-multi-'));
    const repository = new SqliteWorkspaceRepository(join(directory, 'state.sqlite'));
    const workspace = new WorkspaceService(repository);
    const service = new ProjectExecutionService(workspace, {
      backend: async () => ({ exit_code: 0, duration_ms: 1, timed_out: false }),
    });
    try {
      const inputs: ProjectExecInput[] = [];
      for (const name of ['one', 'two']) {
        const root = join(directory, name);
        await mkdir(root);
        const registered = await workspace.register({ root_path: root });
        inputs.push({
          workspace_id: registered.workspace_id,
          workspace_binding: `wb_${'0'.repeat(64)}`,
          request_id: 'shared-project-request',
          cwd: '.',
          timeout_ms: 5000,
          operation: { kind: 'cargo', task: 'check' },
        });
      }
      const first = service.submit(inputs[0]!);
      const second = service.submit(inputs[1]!);
      expect(second.job_id).not.toBe(first.job_id);
      expect(service.submit(inputs[0]!).job_id).toBe(first.job_id);
      expect(service.submit(inputs[1]!).job_id).toBe(second.job_id);
      expect(() =>
        service.submit({ ...inputs[0]!, operation: { kind: 'cargo', task: 'test' } }),
      ).toThrow('request_id is already associated');
      expect(() => service.getJob(inputs[0]!.workspace_id, second.job_id)).toThrow(
        'does not exist for this workspace',
      );
    } finally {
      await service.shutdown();
      repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
