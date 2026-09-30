import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveTrustedPathFromPath } from './pi-trusted.js';

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
