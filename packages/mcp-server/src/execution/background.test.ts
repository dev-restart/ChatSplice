import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SqliteWorkspaceRepository, WorkspaceService } from '@chatsplice/core';
import { ProjectExecInputSchema } from '@chatsplice/protocol';
import { describe, expect, it } from 'vitest';

import { ProjectExecutionService } from './service.js';

describe('background root lifecycle', () => {
  it('keeps roots registered while allowing simultaneous edits and foreground checks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cs-background-'));
    const root = join(directory, 'project');
    await mkdir(root);
    const repository = new SqliteWorkspaceRepository(join(directory, 'state.sqlite'));
    const workspace = new WorkspaceService(repository);
    const id = (await workspace.register({ root_path: root })).workspace_id;
    let started: (() => void) | undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const service = new ProjectExecutionService(workspace, {
      backend: async (_workspace, input, options) => {
        if (input.operation.kind === 'shell' && input.operation.background) {
          started?.();
          await new Promise<void>((resolve) =>
            options.signal.addEventListener('abort', () => resolve(), { once: true }),
          );
        }
        return { exit_code: 0, timed_out: false, duration_ms: 1 };
      },
    });
    const base = { workspace_id: id, workspace_binding: `wb_${'a'.repeat(64)}` };
    try {
      const server = service.submit(
        ProjectExecInputSchema.parse({
          ...base,
          request_id: 'background-server-1',
          operation: { kind: 'shell', command: 'server', background: true },
        }),
      );
      await running;
      expect(() => workspace.remove(id)).toThrow('queued or running');
      await expect(workspace.withOperation(id, async () => 'edited')).resolves.toBe('edited');
      const check = service.submit(
        ProjectExecInputSchema.parse({
          ...base,
          request_id: 'foreground-check-1',
          operation: { kind: 'cargo', task: 'check' },
        }),
      );
      expect(
        (await service.awaitJob({ ...base, job_id: check.job_id, timeout_ms: 1000 })).state,
      ).toBe('succeeded');
      service.cancel(id, server.job_id);
      expect(
        (await service.awaitJob({ ...base, job_id: server.job_id, timeout_ms: 1000 })).state,
      ).toBe('cancelled');
      expect(workspace.isBusy(root)).toBe(false);
    } finally {
      await service.shutdown();
      repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
