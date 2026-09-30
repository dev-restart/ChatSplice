import { link, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FsReadInputSchema } from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceService } from '../workspace/service.js';
import { SqliteWorkspaceRepository } from '../workspace/sqlite-repository.js';
import { readWorkspaceFile } from './read-file.js';

const WORKSPACE_BINDING = `wb_${'0'.repeat(64)}`;

describe('readWorkspaceFile', () => {
  let temporaryDirectory: string;
  let repository: SqliteWorkspaceRepository;
  let service: WorkspaceService;
  let workspaceId: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-core-'));
    const workspaceRoot = join(temporaryDirectory, 'workspace');
    await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, 'hello.txt'), 'hello\nworld\n', 'utf8');
    repository = new SqliteWorkspaceRepository(join(temporaryDirectory, 'state.sqlite'));
    service = new WorkspaceService(repository);
    const workspace = await service.register({ root_path: workspaceRoot });
    workspaceId = workspace.workspace_id;
  });

  afterEach(async () => {
    repository.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('reads UTF-8 text with a full-file hash', async () => {
    const result = await readWorkspaceFile(
      service,
      FsReadInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        path: 'hello.txt',
      }),
    );

    expect(result.content).toBe('hello\nworld');
    expect(result.workspace_name).toBe('workspace');
    expect(result.total_lines).toBe(2);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.truncated).toBe(false);
  });

  it('rejects lexical traversal', async () => {
    await expect(
      readWorkspaceFile(
        service,
        FsReadInputSchema.parse({
          workspace_id: workspaceId,
          workspace_binding: WORKSPACE_BINDING,
          path: '../outside.txt',
        }),
      ),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });

  it('rejects a file symlink that escapes the workspace', async () => {
    const outsideFile = join(temporaryDirectory, 'outside.txt');
    const workspaceRoot = service.getRecord(workspaceId).rootPath;
    await writeFile(outsideFile, 'outside', 'utf8');
    await symlink(outsideFile, join(workspaceRoot, 'escape.txt'));

    await expect(
      readWorkspaceFile(
        service,
        FsReadInputSchema.parse({
          workspace_id: workspaceId,
          workspace_binding: WORKSPACE_BINDING,
          path: 'escape.txt',
        }),
      ),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });

  it('rejects a directory symlink that escapes the workspace', async () => {
    const outsideDirectory = join(temporaryDirectory, 'outside');
    const workspaceRoot = service.getRecord(workspaceId).rootPath;
    await mkdir(outsideDirectory);
    await writeFile(join(outsideDirectory, 'secret.txt'), 'outside', 'utf8');
    await symlink(outsideDirectory, join(workspaceRoot, 'escape-dir'));

    await expect(
      readWorkspaceFile(
        service,
        FsReadInputSchema.parse({
          workspace_id: workspaceId,
          workspace_binding: WORKSPACE_BINDING,
          path: 'escape-dir/secret.txt',
        }),
      ),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });

  it('blocks default secret paths', async () => {
    const workspaceRoot = service.getRecord(workspaceId).rootPath;
    await writeFile(join(workspaceRoot, '.env'), 'TOKEN=do-not-read', 'utf8');

    await expect(
      readWorkspaceFile(
        service,
        FsReadInputSchema.parse({
          workspace_id: workspaceId,
          workspace_binding: WORKSPACE_BINDING,
          path: '.env',
        }),
      ),
    ).rejects.toMatchObject({ code: 'SECRET_PATH_DENIED' });
  });

  it('enforces the byte output limit at a UTF-8 boundary', async () => {
    const workspaceRoot = service.getRecord(workspaceId).rootPath;
    await writeFile(join(workspaceRoot, 'utf8.txt'), '가나다', 'utf8');
    const result = await readWorkspaceFile(
      service,
      FsReadInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        path: 'utf8.txt',
        max_bytes: 4,
      }),
    );

    expect(result.content).toBe('가');
    expect(result.bytes_returned).toBe(3);
    expect(result.truncated).toBe(true);
  });
  it('rejects internal secret symlinks and hard-link aliases', async () => {
    const root = service.getRecord(workspaceId).rootPath;
    await writeFile(join(root, '.env'), 'AUDIT=dummy');
    await symlink('.env', join(root, 'public.txt'));
    await expect(
      readWorkspaceFile(
        service,
        FsReadInputSchema.parse({
          workspace_id: workspaceId,
          workspace_binding: WORKSPACE_BINDING,
          path: 'public.txt',
        }),
      ),
    ).rejects.toMatchObject({ code: 'SECRET_PATH_DENIED' });
    await link(join(root, '.env'), join(root, 'hard.txt'));
    await expect(
      readWorkspaceFile(
        service,
        FsReadInputSchema.parse({
          workspace_id: workspaceId,
          workspace_binding: WORKSPACE_BINDING,
          path: 'hard.txt',
        }),
      ),
    ).rejects.toMatchObject({ code: 'PATH_NOT_FILE' });
  });
});
