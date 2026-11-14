import { mkdtemp, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { WorkspaceService } from './service.js';
import { SqliteWorkspaceRepository } from './sqlite-repository.js';
import { ensureWorkspaceSchema } from './sqlite-schema.js';

const LEGACY_WORKSPACES_TABLE = `
  CREATE TABLE workspaces (
    workspace_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('user', 'probe')),
    created_at TEXT NOT NULL
  ) STRICT;
`;

describe('SqliteWorkspaceRepository', () => {
  it('upgrades the original registry while preserving live connections, IDs and other settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chatsplice-registry-upgrade-'));
    const path = join(directory, 'state.sqlite');
    const live = new Database(path);
    live.pragma('journal_mode = WAL');
    live.exec(LEGACY_WORKSPACES_TABLE);
    live.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT');
    live.prepare('INSERT INTO settings VALUES (?, ?)').run('fixture', '{"keep":true}');
    const insert = live.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)');
    insert.run('ws_user', 'Existing project', '/fixture/project', 'user', '2026-09-01');
    insert.run('ws_probe', 'Probe', '/fixture/probe', 'probe', '2026-09-01');
    const original = live.prepare('SELECT * FROM workspaces ORDER BY workspace_id').all();
    expect(() =>
      insert.run('ws_ref', 'Reference', '/fixture/reference', 'reference', '2026-10-19'),
    ).toThrow('CHECK constraint failed');
    let repository: SqliteWorkspaceRepository | undefined;
    try {
      repository = new SqliteWorkspaceRepository(path);
      expect(live.prepare('SELECT * FROM workspaces ORDER BY workspace_id').all()).toEqual(
        original,
      );
      expect(
        live.prepare('SELECT * FROM workspaces_before_reference_kind ORDER BY workspace_id').all(),
      ).toEqual(original);
      // This statement was prepared before the migration on another connection,
      // as in the running daemon. SQLite must revalidate its old CHECK constraint.
      insert.run('ws_ref', 'Reference', '/fixture/reference', 'reference', '2026-10-19');
      expect(repository.findById('ws_ref')?.kind).toBe('reference');
      expect(live.prepare('SELECT value FROM settings WHERE key = ?').get('fixture')).toEqual({
        value: '{"keep":true}',
      });
      repository.close();
      repository = new SqliteWorkspaceRepository(path);
      expect(repository.list()).toHaveLength(3);
      expect(live.pragma('quick_check', { simple: true })).toBe('ok');
    } finally {
      repository?.close();
      live.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rolls back an upgrade conflict without replacing the registry or its recovery snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chatsplice-registry-upgrade-'));
    const database = new Database(join(directory, 'state.sqlite'));
    try {
      database.exec(LEGACY_WORKSPACES_TABLE);
      database.exec('CREATE TABLE workspaces_before_reference_kind (preserved TEXT)');
      database
        .prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)')
        .run('ws_user', 'Project', '/fixture/project', 'user', '2026-09-01');
      expect(() => ensureWorkspaceSchema(database)).toThrow();
      expect(database.prepare('SELECT workspace_id FROM workspaces').all()).toEqual([
        { workspace_id: 'ws_user' },
      ]);
      expect(
        database.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get('workspaces'),
      ).toEqual({ sql: LEGACY_WORKSPACES_TABLE.trim().replace(/;$/, '') });
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

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
