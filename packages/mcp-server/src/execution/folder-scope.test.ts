import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SqliteSettingsRepository,
  SqliteWorkspaceRepository,
  WorkspaceReferenceService,
  WorkspaceService,
} from '@chatsplice/core';
import { ProjectExecInputSchema } from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProjectExecutionService } from './service.js';

describe('additional folder execution lifecycle', () => {
  let directory: string;
  let workspaceRepository: SqliteWorkspaceRepository;
  let settingsRepository: SqliteSettingsRepository;
  let workspaces: WorkspaceService;
  let references: WorkspaceReferenceService;
  let execution: ProjectExecutionService | undefined;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'cs-folder-jobs-')));
    workspaceRepository = new SqliteWorkspaceRepository(join(directory, 'state.sqlite'));
    settingsRepository = new SqliteSettingsRepository(join(directory, 'state.sqlite'));
    workspaces = new WorkspaceService(workspaceRepository);
    references = new WorkspaceReferenceService(workspaces, settingsRepository);
  });

  afterEach(async () => {
    await execution?.shutdown();
    execution = undefined;
    settingsRepository.close();
    workspaceRepository.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function project(name: string) {
    const root = join(directory, name);
    await mkdir(root);
    return workspaces.register({ root_path: root });
  }

  function request(sourceId: string, requestId: string, targetId?: string) {
    return ProjectExecInputSchema.parse({
      workspace_id: sourceId,
      workspace_binding: `wb_${'a'.repeat(64)}`,
      request_id: requestId,
      ...(targetId === undefined ? {} : { reference_workspace_id: targetId }),
      operation: { kind: 'shell', command: 'check', network: 'local' },
      timeout_ms: 5000,
    });
  }

  it('retains source ownership and prevents changing an executing folder grant', async () => {
    const source = await project('application');
    const target = await project('shared-code');
    const readOnly = await project('documentation');
    references.setAccess({
      source_workspace_id: source.workspace_id,
      reference_workspace_id: target.workspace_id,
      access_mode: 'read_write',
    });
    references.add({
      source_workspace_id: source.workspace_id,
      reference_workspace_id: readOnly.workspace_id,
    });
    let started = false;
    execution = new ProjectExecutionService(workspaces, {
      referenceService: references,
      backend: async (_workspaces, input, options) => {
        expect(input.workspace_id).toBe(source.workspace_id);
        expect(input.reference_workspace_id).toBe(target.workspace_id);
        expect(options.referenceService).toBe(references);
        started = true;
        await new Promise<void>((resolve) => {
          if (options.signal.aborted) resolve();
          else options.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { exit_code: 0, duration_ms: 1, timed_out: false };
      },
    });

    expect(() =>
      execution!.submit(request(source.workspace_id, 'read-only-target', readOnly.workspace_id)),
    ).toThrow();
    const job = execution.submit(
      request(source.workspace_id, 'additional-folder-job', target.workspace_id),
    );
    await expect.poll(() => started).toBe(true);
    expect(job.workspace_id).toBe(source.workspace_id);
    expect(job.reference_workspace_id).toBe(target.workspace_id);
    expect(job.reference_workspace_name).toBe(target.display_name);
    expect(() => execution!.getJob(target.workspace_id, job.job_id)).toThrow();
    expect(() =>
      references.setAccess({
        source_workspace_id: source.workspace_id,
        reference_workspace_id: target.workspace_id,
        access_mode: 'read_only',
      }),
    ).toThrow();
    expect(() =>
      references.remove({
        source_workspace_id: source.workspace_id,
        reference_workspace_id: target.workspace_id,
      }),
    ).toThrow();

    execution.cancel(source.workspace_id, job.job_id);
    expect((await execution.waitForCompletion(source.workspace_id, job.job_id, 1000)).state).toBe(
      'cancelled',
    );
    await expect
      .poll(() => workspaces.isBusy(workspaces.getRecord(target.workspace_id).rootPath))
      .toBe(false);
    references.setAccess({
      source_workspace_id: source.workspace_id,
      reference_workspace_id: target.workspace_id,
      access_mode: 'read_only',
    });
    expect(() =>
      execution!.submit(request(source.workspace_id, 'revoked-folder-job', target.workspace_id)),
    ).toThrow();
  });

  it('serializes reciprocal folder scopes and still admits unrelated work', async () => {
    const first = await project('first');
    const second = await project('second');
    const independent = await project('independent');
    for (const [source, target] of [
      [first, second],
      [second, first],
    ] as const) {
      references.setAccess({
        source_workspace_id: source.workspace_id,
        reference_workspace_id: target.workspace_id,
        access_mode: 'read_write',
      });
    }
    const started = new Set<string>();
    let releaseFirst = () => {};
    const firstWait = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    execution = new ProjectExecutionService(workspaces, {
      referenceService: references,
      backend: async (_workspaces, input, options) => {
        started.add(input.request_id);
        if (input.request_id === 'first-folder-job') {
          await Promise.race([
            firstWait,
            new Promise<void>((resolve) => {
              if (options.signal.aborted) resolve();
              else options.signal.addEventListener('abort', () => resolve(), { once: true });
            }),
          ]);
        }
        return { exit_code: 0, duration_ms: 1, timed_out: false };
      },
    });
    const firstJob = execution.submit(request(first.workspace_id, 'first-folder-job'));
    await expect.poll(() => started.has('first-folder-job')).toBe(true);
    const secondJob = execution.submit(request(second.workspace_id, 'second-folder-job'));
    const unrelated = execution.submit(request(independent.workspace_id, 'independent-folder-job'));
    expect(
      (await execution.waitForCompletion(independent.workspace_id, unrelated.job_id, 1000)).state,
    ).toBe('succeeded');
    expect(started.has('second-folder-job')).toBe(false);
    expect(execution.getJob(second.workspace_id, secondJob.job_id).state).toBe('queued');
    releaseFirst();
    expect(
      (await execution.waitForCompletion(first.workspace_id, firstJob.job_id, 1000)).state,
    ).toBe('succeeded');
    expect(
      (await execution.waitForCompletion(second.workspace_id, secondJob.job_id, 1000)).state,
    ).toBe('succeeded');
    expect(started.has('second-folder-job')).toBe(true);
  });
});
