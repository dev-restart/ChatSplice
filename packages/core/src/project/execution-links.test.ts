import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertExecutionWorkspaceLinks } from './execution-links.js';
import { MAX_MANIFEST_BYTES, readManifest } from './pi-trusted.js';

describe('execution file validation', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'chatsplice-execution-links-')));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('accepts ordinary files and does not traverse symbolic directory links', async () => {
    await mkdir(join(directory, 'src'));
    await writeFile(join(directory, 'src', 'note.txt'), 'source');
    await symlink(join(directory, 'src'), join(directory, 'alias'));
    await expect(assertExecutionWorkspaceLinks(directory)).resolves.toBeUndefined();
  });

  it('refuses regular-file aliases outside the registered root before project execution', async () => {
    const root = join(directory, 'project');
    await mkdir(root);
    await writeFile(join(directory, 'note.txt'), 'source');
    await link(join(directory, 'note.txt'), join(root, 'alias.txt'));
    await expect(assertExecutionWorkspaceLinks(root)).rejects.toMatchObject({
      code: 'PATH_NOT_FILE',
    });
  });

  it('accepts internal esbuild-style aliases without following symbolic aliases', async () => {
    await mkdir(join(directory, 'node_modules/esbuild/bin'), { recursive: true });
    await mkdir(join(directory, 'node_modules/@esbuild/darwin-arm64/bin'), { recursive: true });
    const binary = join(directory, 'node_modules/esbuild/bin/esbuild');
    await writeFile(binary, 'fixture binary');
    await link(binary, join(directory, 'node_modules/@esbuild/darwin-arm64/bin/esbuild'));
    await symlink(binary, join(directory, 'symbolic-alias'));
    await expect(assertExecutionWorkspaceLinks(directory)).resolves.toBeUndefined();
  });

  it('does not count symbolic aliases as missing hard-link paths', async () => {
    const root = join(directory, 'project');
    await mkdir(root);
    await writeFile(join(directory, 'note.txt'), 'source');
    await link(join(directory, 'note.txt'), join(root, 'alias.txt'));
    await symlink(join(directory, 'note.txt'), join(root, 'symbolic-alias'));
    await expect(assertExecutionWorkspaceLinks(root)).rejects.toMatchObject({
      code: 'PATH_NOT_FILE',
    });
  });

  it('inspects read-only roots with the same fail-closed depth budget', async () => {
    const writableRoot = join(directory, 'project');
    const readRoot = join(directory, 'reference');
    await Promise.all([mkdir(writableRoot), mkdir(readRoot)]);
    await writeFile(join(readRoot, 'note.txt'), 'approved text');
    await expect(
      assertExecutionWorkspaceLinks(writableRoot, undefined, [readRoot]),
    ).resolves.toBeUndefined();
    let path = readRoot;
    for (let index = 0; index < 65; index += 1) {
      path = join(path, 'd');
      await mkdir(path);
    }
    await expect(
      assertExecutionWorkspaceLinks(writableRoot, undefined, [readRoot]),
    ).rejects.toThrow('depth limit');
  });

  it('rejects unapproved file aliases inside a read-only folder', async () => {
    const writableRoot = join(directory, 'project');
    const readRoot = join(directory, 'reference');
    await Promise.all([mkdir(writableRoot), mkdir(readRoot)]);
    const outside = join(directory, 'outside.txt');
    await writeFile(outside, 'outside the approved folders');
    await link(outside, join(readRoot, 'alias.txt'));
    await expect(
      assertExecutionWorkspaceLinks(writableRoot, undefined, [readRoot]),
    ).rejects.toMatchObject({ code: 'PATH_NOT_FILE' });
  });

  it('accepts aliases across read-only folders and still rejects a writable alias to them', async () => {
    const writableRoot = join(directory, 'project');
    const readRoot = join(directory, 'reference');
    const otherReadRoot = join(directory, 'other-reference');
    await Promise.all([writableRoot, readRoot, otherReadRoot].map((root) => mkdir(root)));
    const note = join(readRoot, 'note.txt');
    await writeFile(note, 'approved text');
    await link(note, join(otherReadRoot, 'alias.txt'));
    await expect(
      assertExecutionWorkspaceLinks(writableRoot, undefined, [readRoot, otherReadRoot]),
    ).resolves.toBeUndefined();
    await link(note, join(writableRoot, 'writable-alias.txt'));
    await expect(
      assertExecutionWorkspaceLinks(writableRoot, undefined, [readRoot, otherReadRoot]),
    ).rejects.toMatchObject({ code: 'PATH_NOT_FILE' });
  });

  it('counts nested read-only aliases once even when both folders are registered', async () => {
    const writableRoot = join(directory, 'project');
    const readRoot = join(directory, 'reference');
    const nestedRoot = join(readRoot, 'nested');
    await mkdir(writableRoot);
    await mkdir(nestedRoot, { recursive: true });
    const note = join(readRoot, 'note.txt');
    await writeFile(note, 'approved text');
    await link(note, join(nestedRoot, 'alias.txt'));
    await expect(
      assertExecutionWorkspaceLinks(writableRoot, undefined, [readRoot, nestedRoot]),
    ).resolves.toBeUndefined();
  });

  it('fails closed on cancellation and excessive directory depth', async () => {
    await expect(assertExecutionWorkspaceLinks(directory, AbortSignal.abort())).rejects.toThrow(
      'cancelled',
    );
    let path = directory;
    for (let index = 0; index < 65; index += 1) {
      path = join(path, 'd');
      await mkdir(path);
    }
    await expect(assertExecutionWorkspaceLinks(directory)).rejects.toThrow('depth limit');
  });

  it('rejects invalid UTF-8 instead of silently replacing manifest bytes', async () => {
    const path = join(directory, 'package.json');
    await writeFile(
      path,
      Buffer.concat([Buffer.from('{"name":"'), Buffer.from([0xff]), Buffer.from('"}')]),
    );
    await expect(readManifest(path)).rejects.toThrow('valid UTF-8 JSON');
  });

  it('enforces the manifest byte bound and single-link requirement', async () => {
    const path = join(directory, 'package.json');
    await writeFile(path, Buffer.alloc(MAX_MANIFEST_BYTES + 1, 0x20));
    await expect(readManifest(path)).rejects.toThrow('file-size limit');
    await writeFile(path, '{"scripts":{"test":"node test.js"}}');
    await link(path, join(directory, 'manifest-alias.json'));
    await expect(readManifest(path)).rejects.toThrow('single-link');
  });
});
