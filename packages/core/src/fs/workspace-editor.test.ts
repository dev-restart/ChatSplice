import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceService } from '../workspace/service.js';
import { SqliteWorkspaceRepository } from '../workspace/sqlite-repository.js';
import {
  MAX_WORKSPACE_EDITOR_FILE_BYTES,
  readWorkspaceEditorFile,
  saveWorkspaceEditorFile,
} from './workspace-editor.js';

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('workspace editor file service', () => {
  let temporaryDirectory: string;
  let workspaceRoot: string;
  let repository: SqliteWorkspaceRepository;
  let service: WorkspaceService;
  let workspaceId: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-core-editor-'));
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

  it('reads the full UTF-8 document beyond the MCP preview cap', async () => {
    const content = 'line\n'.repeat(20_000);
    await writeFile(join(workspaceRoot, 'README.md'), content, 'utf8');

    const result = await readWorkspaceEditorFile(service, {
      workspace_id: workspaceId,
      path: 'README.md',
    });

    expect(result).toEqual({
      workspace_id: workspaceId,
      path: 'README.md',
      content,
      sha256: hash(content),
    });
  });

  it('saves exact editor bytes under the fresh SHA guard and preserves CRLF only when sent', async () => {
    const original = 'one\r\ntwo\r\n';
    const next = 'one\nchanged\n';
    await writeFile(join(workspaceRoot, 'note.md'), original, 'utf8');
    const loaded = await readWorkspaceEditorFile(service, {
      workspace_id: workspaceId,
      path: 'note.md',
    });

    const saved = await saveWorkspaceEditorFile(service, {
      workspace_id: workspaceId,
      path: 'note.md',
      expected_sha256: loaded.sha256,
      content: next,
    });

    expect(saved).toEqual({
      workspace_id: workspaceId,
      path: 'note.md',
      content: next,
      sha256: hash(next),
    });
    expect(await readFile(join(workspaceRoot, 'note.md'), 'utf8')).toBe(next);
  });

  it('keeps a UTF-8 BOM in the editor document and rejects NUL binary content', async () => {
    const path = join(workspaceRoot, 'bom.txt');
    const original = '\uFEFFfirst\n';
    await writeFile(path, original, 'utf8');
    const loaded = await readWorkspaceEditorFile(service, {
      workspace_id: workspaceId,
      path: 'bom.txt',
    });
    expect(loaded.content).toBe(original);

    await expect(
      saveWorkspaceEditorFile(service, {
        workspace_id: workspaceId,
        path: 'bom.txt',
        expected_sha256: loaded.sha256,
        content: '\uFEFFchanged\n',
      }),
    ).resolves.toMatchObject({ content: '\uFEFFchanged\n' });

    await writeFile(path, Buffer.from('valid\u0000binary', 'utf8'));
    await expect(
      readWorkspaceEditorFile(service, { workspace_id: workspaceId, path: 'bom.txt' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ENCODING' });
  });

  it('rejects an external change and never silently overwrites it', async () => {
    const path = join(workspaceRoot, 'note.md');
    await writeFile(path, 'before\n', 'utf8');
    const loaded = await readWorkspaceEditorFile(service, {
      workspace_id: workspaceId,
      path: 'note.md',
    });
    await writeFile(path, 'external\n', 'utf8');

    await expect(
      saveWorkspaceEditorFile(service, {
        workspace_id: workspaceId,
        path: 'note.md',
        expected_sha256: loaded.sha256,
        content: 'editor\n',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await readFile(path, 'utf8')).toBe('external\n');
  });

  it('revalidates the registered root before saving', async () => {
    const path = join(workspaceRoot, 'note.md');
    await writeFile(path, 'before\n', 'utf8');
    const loaded = await readWorkspaceEditorFile(service, {
      workspace_id: workspaceId,
      path: 'note.md',
    });
    await rm(workspaceRoot, { recursive: true, force: true });

    await expect(
      saveWorkspaceEditorFile(service, {
        workspace_id: workspaceId,
        path: 'note.md',
        expected_sha256: loaded.sha256,
        content: 'editor\n',
      }),
    ).rejects.toThrow();
  });

  it('keeps the existing path and file safety policy', async () => {
    const safePath = join(workspaceRoot, 'safe.txt');
    await writeFile(safePath, 'safe\n', 'utf8');
    await writeFile(join(workspaceRoot, '.env'), 'TOKEN=private', 'utf8');
    await symlink('.env', join(workspaceRoot, 'secret-alias.txt'));
    await link(safePath, join(workspaceRoot, 'hard-link.txt'));

    await expect(
      readWorkspaceEditorFile(service, { workspace_id: workspaceId, path: '../outside.txt' }),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    await expect(
      readWorkspaceEditorFile(service, { workspace_id: workspaceId, path: '.env' }),
    ).rejects.toMatchObject({ code: 'SECRET_PATH_DENIED' });
    await expect(
      readWorkspaceEditorFile(service, { workspace_id: workspaceId, path: 'secret-alias.txt' }),
    ).rejects.toMatchObject({ code: 'SECRET_PATH_DENIED' });
    await expect(
      readWorkspaceEditorFile(service, { workspace_id: workspaceId, path: 'hard-link.txt' }),
    ).rejects.toMatchObject({ code: 'PATH_NOT_FILE' });
  });

  it('rejects invalid UTF-8 and the editor byte limit without changing the file', async () => {
    const path = join(workspaceRoot, 'note.txt');
    await writeFile(path, Buffer.from([0xff, 0xfe]));
    await expect(
      readWorkspaceEditorFile(service, { workspace_id: workspaceId, path: 'note.txt' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ENCODING' });

    await writeFile(path, Buffer.alloc(MAX_WORKSPACE_EDITOR_FILE_BYTES + 1, 0x61));
    await expect(
      readWorkspaceEditorFile(service, { workspace_id: workspaceId, path: 'note.txt' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects malformed JavaScript text instead of replacing an unpaired surrogate', async () => {
    const path = join(workspaceRoot, 'surrogate.txt');
    await writeFile(path, 'before\n', 'utf8');
    const loaded = await readWorkspaceEditorFile(service, {
      workspace_id: workspaceId,
      path: 'surrogate.txt',
    });

    await expect(
      saveWorkspaceEditorFile(service, {
        workspace_id: workspaceId,
        path: 'surrogate.txt',
        expected_sha256: loaded.sha256,
        content: 'bad\ud800',
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ENCODING' });
    expect(await readFile(path, 'utf8')).toBe('before\n');
  });
});
