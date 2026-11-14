import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceService } from './service.js';
import { SqliteWorkspaceRepository } from './sqlite-repository.js';

describe('workspace root update coordination', () => {
  let directory: string;
  let root: string;
  let nextRoot: string;
  let repository: SqliteWorkspaceRepository;
  let service: WorkspaceService;
  let workspaceId: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cs-root-update-'));
    root = join(directory, 'project');
    nextRoot = join(directory, 'replacement');
    await Promise.all([mkdir(root), mkdir(nextRoot)]);
    root = await realpath(root);
    repository = new SqliteWorkspaceRepository(join(directory, 'state.sqlite'));
    service = new WorkspaceService(repository);
    workspaceId = (await service.register({ root_path: root })).workspace_id;
  });

  afterEach(async () => {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('rejects a root update when foreground work starts during folder validation', async () => {
    const updating = service.updateRootPath(workspaceId, nextRoot);
    const release = service.operations.tryReserve(root);
    expect(release).toBeTypeOf('function');
    try {
      await expect(updating).rejects.toThrow('queued or running operations');
      expect(service.getRecord(workspaceId).rootPath).toBe(root);
    } finally {
      release?.();
    }
  });

  it('rejects a root update when a concurrent server lease starts during folder validation', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const updating = service.updateRootPath(workspaceId, nextRoot);
    const operation = service.withConcurrentOperation(workspaceId, async () => gate);
    // Keep a handler attached even if the old implementation changes the root
    // before the concurrent operation finishes validating it.
    const completion = operation.catch((error: unknown) => error);
    try {
      expect(service.isBusy(root)).toBe(true);
      await expect(updating).rejects.toThrow('queued or running operations');
      expect(service.getRecord(workspaceId).rootPath).toBe(root);
    } finally {
      release?.();
      await completion;
    }
  });

  it('rejects a stale root update after another folder change finishes', async () => {
    const alternativeRoot = join(directory, 'alternative');
    await mkdir(alternativeRoot);
    const updates = await Promise.allSettled([
      service.updateRootPath(workspaceId, nextRoot),
      service.updateRootPath(workspaceId, alternativeRoot),
    ]);

    const successful = updates.filter((result) => result.status === 'fulfilled');
    const failed = updates.filter((result) => result.status === 'rejected');
    expect(successful).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      reason: { code: 'PATH_OUTSIDE_WORKSPACE', message: 'The registered workspace root changed.' },
    });
    const winner = successful[0];
    if (winner?.status === 'fulfilled')
      expect(service.getRecord(workspaceId).rootPath).toBe(winner.value.root_path);
  });
});
