import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  resolveTrustedExecutable,
  resolveTrustedPathFromPath,
  resolveTrustedSearchDirectory,
  revalidateTrustedExecutables,
} from './pi-trusted.js';

describe('trusted Cargo executable discovery', () => {
  let temporaryDirectory: string;
  let workspaceRoot: string;
  let executableDirectory: string;
  let previousPath: string | undefined;

  beforeEach(async () => {
    previousPath = process.env.PATH;
    temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'chatsplice-cargo-proxy-')));
    workspaceRoot = join(temporaryDirectory, 'workspace');
    executableDirectory = join(temporaryDirectory, 'toolchain', 'bin');
    await mkdir(workspaceRoot);
    await mkdir(executableDirectory, { recursive: true, mode: 0o700 });
    process.env.PATH = executableDirectory;
  });

  afterEach(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it.each(['rustup', 'rustup-init'])('rejects a Cargo alias to the %s proxy', async (proxy) => {
    await writeFile(join(executableDirectory, proxy), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    await symlink(proxy, join(executableDirectory, 'cargo'));

    await expect(resolveTrustedPathFromPath('cargo', workspaceRoot)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('retains discovery of a real Cargo executable', async () => {
    const executable = join(executableDirectory, 'cargo');
    await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });

    await expect(resolveTrustedPathFromPath('cargo', workspaceRoot)).resolves.toEqual({
      path: executable,
      root: join(temporaryDirectory, 'toolchain'),
      searchDirectory: executableDirectory,
    });
  });
});

describe('trusted runtimes with multiple writable folders', () => {
  let temporaryDirectory: string;
  let sourceRoot: string;
  let sharedRoot: string;
  let executableDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await realpath(
      await mkdtemp(join(tmpdir(), 'chatsplice-runtime-folders-')),
    );
    sourceRoot = join(temporaryDirectory, 'source');
    sharedRoot = join(temporaryDirectory, 'shared');
    executableDirectory = join(temporaryDirectory, 'toolchain', 'bin');
    await Promise.all([
      mkdir(sourceRoot),
      mkdir(sharedRoot),
      mkdir(executableDirectory, { recursive: true, mode: 0o700 }),
    ]);
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  async function trustedExecutable(path: string) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    return resolveTrustedExecutable(path, sourceRoot);
  }

  it('retains external executables and Node runtimes for every writable folder', async () => {
    const manager = await trustedExecutable(join(executableDirectory, 'pnpm'));
    const node = await trustedExecutable(join(executableDirectory, 'node'));
    await expect(
      revalidateTrustedExecutables([manager, node], [sourceRoot, sharedRoot]),
    ).resolves.toBeUndefined();
  });

  it('rejects a Node runtime inside another approved writable folder', async () => {
    const manager = await trustedExecutable(join(executableDirectory, 'pnpm'));
    const node = await trustedExecutable(join(sharedRoot, 'runtime', 'bin', 'node'));
    await expect(revalidateTrustedExecutables([manager, node], [sharedRoot])).rejects.toMatchObject(
      { code: 'BAD_REQUEST' },
    );
  });

  it('rejects a runtime read boundary that contains another writable folder', async () => {
    const manager = await trustedExecutable(join(executableDirectory, 'pnpm'));
    const nestedWorkspace = join(temporaryDirectory, 'toolchain', 'project');
    await mkdir(nestedWorkspace);
    await expect(revalidateTrustedExecutables([manager], [nestedWorkspace])).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('revalidates executable search directories against every writable folder', async () => {
    const node = await trustedExecutable(join(executableDirectory, 'node'));
    const searchDirectory = join(sharedRoot, 'bin');
    await mkdir(searchDirectory, { mode: 0o700 });
    await resolveTrustedSearchDirectory(searchDirectory, sourceRoot);
    await expect(
      revalidateTrustedExecutables([{ ...node, searchDirectory }], [sharedRoot]),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
