import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FsEditInputSchema } from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceService } from '../workspace/service.js';
import { SqliteWorkspaceRepository } from '../workspace/sqlite-repository.js';
import { editWorkspaceFile } from './edit-file.js';

const WORKSPACE_BINDING = `wb_${'0'.repeat(64)}`;

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('editWorkspaceFile', () => {
  let temporaryDirectory: string;
  let repository: SqliteWorkspaceRepository;
  let service: WorkspaceService;
  let workspaceId: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-core-edit-'));
    workspaceRoot = join(temporaryDirectory, 'workspace');
    await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, 'hello.txt'), 'hello\nworld\n', 'utf8');
    repository = new SqliteWorkspaceRepository(join(temporaryDirectory, 'state.sqlite'));
    service = new WorkspaceService(repository);
    workspaceId = (await service.register({ root_path: workspaceRoot })).workspace_id;
  });

  afterEach(async () => {
    repository.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('applies exact replacements with optimistic concurrency', async () => {
    const result = await editWorkspaceFile(
      service,
      FsEditInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        path: 'hello.txt',
        expected_sha256: hash('hello\nworld\n'),
        edits: [{ old_text: 'world', new_text: 'ChatSplice' }],
      }),
    );

    expect(await readFile(join(workspaceRoot, 'hello.txt'), 'utf8')).toBe('hello\nChatSplice\n');
    expect(result.previous_sha256).toBe(hash('hello\nworld\n'));
    expect(result.sha256).toBe(hash('hello\nChatSplice\n'));
    expect(result.replacements).toBe(1);
  });

  it('preserves CRLF line endings while accepting fs.read-style LF text', async () => {
    await writeFile(join(workspaceRoot, 'crlf.txt'), 'hello\r\nworld\r\n', 'utf8');
    await editWorkspaceFile(
      service,
      FsEditInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        path: 'crlf.txt',
        expected_sha256: hash('hello\r\nworld\r\n'),
        edits: [{ old_text: 'hello\nworld', new_text: 'hello\nchat' }],
      }),
    );

    expect(await readFile(join(workspaceRoot, 'crlf.txt'), 'utf8')).toBe('hello\r\nchat\r\n');
  });

  it('does not normalize unrelated mixed line endings', async () => {
    const original = 'first\r\nsecond\nthird\r\n';
    await writeFile(join(workspaceRoot, 'mixed.txt'), original, 'utf8');
    await editWorkspaceFile(
      service,
      FsEditInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        path: 'mixed.txt',
        expected_sha256: hash(original),
        edits: [{ old_text: 'second\nthird', new_text: 'changed\nthird' }],
      }),
    );

    expect(await readFile(join(workspaceRoot, 'mixed.txt'), 'utf8')).toBe(
      'first\r\nchanged\nthird\r\n',
    );
  });

  it('rejects stale hashes without changing the file', async () => {
    await expect(
      editWorkspaceFile(
        service,
        FsEditInputSchema.parse({
          workspace_id: workspaceId,
          workspace_binding: WORKSPACE_BINDING,
          path: 'hello.txt',
          expected_sha256: '0'.repeat(64),
          edits: [{ old_text: 'world', new_text: 'ChatSplice' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await readFile(join(workspaceRoot, 'hello.txt'), 'utf8')).toBe('hello\nworld\n');
  });

  it('rejects ambiguous edits unless replace_all is explicit', async () => {
    await writeFile(join(workspaceRoot, 'repeat.txt'), 'same\nsame\n', 'utf8');
    await expect(
      editWorkspaceFile(
        service,
        FsEditInputSchema.parse({
          workspace_id: workspaceId,
          workspace_binding: WORKSPACE_BINDING,
          path: 'repeat.txt',
          expected_sha256: hash('same\nsame\n'),
          edits: [{ old_text: 'same', new_text: 'changed' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects secret paths and symlink escape', async () => {
    await writeFile(join(workspaceRoot, '.env'), 'TOKEN=secret', 'utf8');
    await mkdir(join(workspaceRoot, '.codex'));
    await writeFile(join(workspaceRoot, '.codex', 'auth.json'), '{"token":"secret"}', 'utf8');
    const outside = join(temporaryDirectory, 'outside.txt');
    await writeFile(outside, 'outside', 'utf8');
    await symlink(outside, join(workspaceRoot, 'escape.txt'));

    for (const path of ['.env', '.codex/auth.json', 'escape.txt']) {
      await expect(
        editWorkspaceFile(
          service,
          FsEditInputSchema.parse({
            workspace_id: workspaceId,
            workspace_binding: WORKSPACE_BINDING,
            path,
            expected_sha256: hash(
              path === '.env'
                ? 'TOKEN=secret'
                : path === '.codex/auth.json'
                  ? '{"token":"secret"}'
                  : 'outside',
            ),
            edits: [{ old_text: 'secret', new_text: 'redacted' }],
          }),
        ),
      ).rejects.toMatchObject({
        code: path === 'escape.txt' ? 'PATH_OUTSIDE_WORKSPACE' : 'SECRET_PATH_DENIED',
      });
    }
  });

  it('rejects path traversal before opening a file', async () => {
    await expect(
      editWorkspaceFile(
        service,
        FsEditInputSchema.parse({
          workspace_id: workspaceId,
          workspace_binding: WORKSPACE_BINDING,
          path: '../outside.txt',
          expected_sha256: hash('outside'),
          edits: [{ old_text: 'outside', new_text: 'changed' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });
  it('serializes competing edits so one stale writer cannot overwrite the winner', async () => {
    const results = await Promise.allSettled(
      ['first', 'second'].map((replacement) =>
        editWorkspaceFile(
          service,
          FsEditInputSchema.parse({
            workspace_id: workspaceId,
            workspace_binding: WORKSPACE_BINDING,
            path: 'hello.txt',
            expected_sha256: hash('hello\nworld\n'),
            edits: [{ old_text: 'world', new_text: replacement }],
          }),
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(['hello\nfirst\n', 'hello\nsecond\n']).toContain(
      await readFile(join(workspaceRoot, 'hello.txt'), 'utf8'),
    );
  });

  it('rejects a harmless-looking symlink to a secret file without modifying the target', async () => {
    await writeFile(join(workspaceRoot, '.env'), 'AUDIT=original');
    await symlink('.env', join(workspaceRoot, 'public.txt'));
    await expect(
      editWorkspaceFile(
        service,
        FsEditInputSchema.parse({
          workspace_id: workspaceId,
          workspace_binding: WORKSPACE_BINDING,
          path: 'public.txt',
          expected_sha256: hash('AUDIT=original'),
          edits: [{ old_text: 'original', new_text: 'changed' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'SECRET_PATH_DENIED' });
    expect(await readFile(join(workspaceRoot, '.env'), 'utf8')).toBe('AUDIT=original');
  });
});
