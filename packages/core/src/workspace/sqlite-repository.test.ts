import { mkdtemp, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { WorkspaceService } from './service.js';
import { SqliteWorkspaceRepository } from './sqlite-repository.js';

describe('SqliteWorkspaceRepository', () => {
  it('persists immutable workspace IDs across restart', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-registry-'));
    const workspaceRoot = join(temporaryDirectory, 'workspace');
    const databasePath = join(temporaryDirectory, 'state.sqlite');
    await mkdir(workspaceRoot);

    const firstRepository = new SqliteWorkspaceRepository(databasePath);
    const firstService = new WorkspaceService(firstRepository);
    const created = await firstService.register({ root_path: workspaceRoot });
    firstRepository.close();

    const secondRepository = new SqliteWorkspaceRepository(databasePath);
    try {
      expect(secondRepository.findById(created.workspace_id)?.rootPath).toBe(
        await realpath(workspaceRoot),
      );
    } finally {
      secondRepository.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('removes only a user workspace registry entry and leaves its folder intact', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-registry-'));
    const workspaceRoot = join(temporaryDirectory, 'workspace');
    const databasePath = join(temporaryDirectory, 'state.sqlite');
    await mkdir(workspaceRoot);

    const repository = new SqliteWorkspaceRepository(databasePath);
    const service = new WorkspaceService(repository);
    try {
      const created = await service.register({ root_path: workspaceRoot });
      const remaining = service.remove(created.workspace_id);

      expect(remaining.workspaces).not.toContainEqual(
        expect.objectContaining({ workspace_id: created.workspace_id }),
      );
      expect((await stat(workspaceRoot)).isDirectory()).toBe(true);
      expect(() => service.getRecord(created.workspace_id)).toThrow('not registered');
    } finally {
      repository.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('renames only the sidebar label, leaving the folder and workspace_id untouched', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-registry-'));
    const workspaceRoot = join(temporaryDirectory, 'workspace');
    const databasePath = join(temporaryDirectory, 'state.sqlite');
    await mkdir(workspaceRoot);

    const repository = new SqliteWorkspaceRepository(databasePath);
    const service = new WorkspaceService(repository);
    try {
      const created = await service.register({ root_path: workspaceRoot });
      const renamed = service.rename(created.workspace_id, 'My Renamed Project');

      expect(renamed).toEqual({
        workspace_id: created.workspace_id,
        display_name: 'My Renamed Project',
        kind: 'user',
        created_at: created.created_at,
      });
      expect(repository.findById(created.workspace_id)?.rootPath).toBe(
        await realpath(workspaceRoot),
      );
    } finally {
      repository.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('rejects renaming the ChatSplice probe workspace', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-registry-'));
    const databasePath = join(temporaryDirectory, 'state.sqlite');
    const repository = new SqliteWorkspaceRepository(databasePath);
    const service = new WorkspaceService(repository);
    try {
      const probe = await service.ensureProbeWorkspace(temporaryDirectory);
      expect(() => service.rename(probe.workspace_id, 'Renamed probe')).toThrow(
        'probe workspace cannot be renamed',
      );
    } finally {
      repository.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('repoints a registered project at a new folder while keeping its workspace_id', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-registry-'));
    const oldRoot = join(temporaryDirectory, 'old-workspace');
    const newRoot = join(temporaryDirectory, 'new-workspace');
    const databasePath = join(temporaryDirectory, 'state.sqlite');
    await mkdir(oldRoot);
    await mkdir(newRoot);

    const repository = new SqliteWorkspaceRepository(databasePath);
    const service = new WorkspaceService(repository);
    try {
      const created = await service.register({ root_path: oldRoot });
      const updated = await service.updateRootPath(created.workspace_id, newRoot);

      expect(updated.workspace_id).toBe(created.workspace_id);
      expect(updated.root_path).toBe(await realpath(newRoot));
      expect(repository.findById(created.workspace_id)?.rootPath).toBe(await realpath(newRoot));
    } finally {
      repository.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('rejects repointing a project at a folder another registered project already uses', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-registry-'));
    const firstRoot = join(temporaryDirectory, 'first-workspace');
    const secondRoot = join(temporaryDirectory, 'second-workspace');
    const databasePath = join(temporaryDirectory, 'state.sqlite');
    await mkdir(firstRoot);
    await mkdir(secondRoot);

    const repository = new SqliteWorkspaceRepository(databasePath);
    const service = new WorkspaceService(repository);
    try {
      const first = await service.register({ root_path: firstRoot });
      await service.register({ root_path: secondRoot });

      await expect(service.updateRootPath(first.workspace_id, secondRoot)).rejects.toThrow(
        'already uses that folder',
      );
    } finally {
      repository.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('rejects repointing the ChatSplice probe workspace', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-registry-'));
    const newRoot = join(temporaryDirectory, 'new-workspace');
    const databasePath = join(temporaryDirectory, 'state.sqlite');
    await mkdir(newRoot);
    const repository = new SqliteWorkspaceRepository(databasePath);
    const service = new WorkspaceService(repository);
    try {
      const probe = await service.ensureProbeWorkspace(temporaryDirectory);
      await expect(service.updateRootPath(probe.workspace_id, newRoot)).rejects.toThrow(
        'folder can be changed',
      );
    } finally {
      repository.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
