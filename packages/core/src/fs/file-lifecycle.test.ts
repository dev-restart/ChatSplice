import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FsDeleteInputSchema,
  FsMkdirInputSchema,
  FsRenameInputSchema,
  FsWriteInputSchema,
} from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceService } from '../workspace/service.js';
import { SqliteWorkspaceRepository } from '../workspace/sqlite-repository.js';
import {
  deleteWorkspaceFile,
  makeWorkspaceDirectory,
  renameWorkspaceFile,
  writeWorkspaceFile,
} from './file-lifecycle.js';

const WORKSPACE_BINDING = `wb_${'0'.repeat(64)}`;

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('direct workspace file lifecycle', () => {
  let temporaryDirectory: string;
  let workspaceRoot: string;
  let repository: SqliteWorkspaceRepository;
  let service: WorkspaceService;
  let workspaceId: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-core-lifecycle-'));
    workspaceRoot = join(temporaryDirectory, 'workspace');
    await mkdir(workspaceRoot);
    repository = new SqliteWorkspaceRepository(join(temporaryDirectory, 'state.sqlite'));
    service = new WorkspaceService(repository);
    workspaceId = (await service.register({ root_path: workspaceRoot })).workspace_id;
  });

  afterEach(async () => {
    repository.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('creates and replaces bounded UTF-8 files without overwriting on create', async () => {
    const created = await writeWorkspaceFile(
      service,
      FsWriteInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        path: 'created.txt',
        mode: 'create',
        content: 'first\n',
      }),
    );
    expect(created).toMatchObject({ mode: 'create', previous_sha256: null });
    expect(await readFile(join(workspaceRoot, 'created.txt'), 'utf8')).toBe('first\n');

    await expect(
      writeWorkspaceFile(
        service,
        FsWriteInputSchema.parse({
          workspace_id: workspaceId,
          workspace_binding: WORKSPACE_BINDING,
          path: 'created.txt',
          mode: 'create',
          content: 'must not overwrite\n',
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const replaced = await writeWorkspaceFile(
      service,
      FsWriteInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        path: 'created.txt',
        mode: 'replace',
        expected_sha256: hash('first\n'),
        content: 'second\n',
      }),
    );
    expect(replaced).toMatchObject({
      mode: 'replace',
      previous_sha256: hash('first\n'),
      sha256: hash('second\n'),
    });
    expect(await readFile(join(workspaceRoot, 'created.txt'), 'utf8')).toBe('second\n');
  });

  it('creates one directory level and then creates a file inside it', async () => {
    await makeWorkspaceDirectory(
      service,
      FsMkdirInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        path: 'src',
      }),
    );
    await writeWorkspaceFile(
      service,
      FsWriteInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        path: 'src/index.ts',
        mode: 'create',
        content: 'export {};\n',
      }),
    );
    expect((await stat(join(workspaceRoot, 'src'))).isDirectory()).toBe(true);
    expect(await readFile(join(workspaceRoot, 'src', 'index.ts'), 'utf8')).toBe('export {};\n');
  });

  it('renames and deletes only the exact SHA-guarded regular file', async () => {
    await writeFile(join(workspaceRoot, 'before.txt'), 'content\n', 'utf8');
    const renamed = await renameWorkspaceFile(
      service,
      FsRenameInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        source_path: 'before.txt',
        destination_path: 'after.txt',
        expected_sha256: hash('content\n'),
      }),
    );
    expect(renamed).toMatchObject({
      source_path: 'before.txt',
      destination_path: 'after.txt',
    });
    await expect(readFile(join(workspaceRoot, 'before.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(workspaceRoot, 'after.txt'), 'utf8')).toBe('content\n');

    const deleted = await deleteWorkspaceFile(
      service,
      FsDeleteInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        path: 'after.txt',
        expected_sha256: hash('content\n'),
      }),
    );
    expect(deleted.deleted_sha256).toBe(hash('content\n'));
    await expect(readFile(join(workspaceRoot, 'after.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects stale replace/delete hashes and secret destinations', async () => {
    await writeFile(join(workspaceRoot, 'safe.txt'), 'safe\n', 'utf8');
    await expect(
      deleteWorkspaceFile(
        service,
        FsDeleteInputSchema.parse({
          workspace_id: workspaceId,
          workspace_binding: WORKSPACE_BINDING,
          path: 'safe.txt',
          expected_sha256: '0'.repeat(64),
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      writeWorkspaceFile(
        service,
        FsWriteInputSchema.parse({
          workspace_id: workspaceId,
          workspace_binding: WORKSPACE_BINDING,
          path: '.env',
          mode: 'create',
          content: 'SECRET=value\n',
        }),
      ),
    ).rejects.toMatchObject({ code: 'SECRET_PATH_DENIED' });
    expect(await readFile(join(workspaceRoot, 'safe.txt'), 'utf8')).toBe('safe\n');
  });
});
