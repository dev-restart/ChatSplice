import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { safeEnvironment, shellCommandPath } from './pi-sandbox.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cs-rust-path-test-'));
  temporaryDirectories.push(root);
  const selected = join(root, 'selected', 'bin');
  const other = join(root, 'other-runtime', 'bin');
  const cache = join(root, 'cargo-cache');
  for (const directory of [selected, other, join(cache, 'bin')]) {
    await mkdir(directory, { recursive: true });
  }
  return { root, selected, other, cache };
}

async function executable(path: string, marker: string) {
  await writeFile(path, '#!/bin/sh\n' + "printf '%s' '" + marker + "'\n");
  await chmod(path, 0o700);
}

describe('Rust command environment compatibility', () => {
  it.each([false, true])(
    'uses the selected compiler before other runtimes (network=%s)',
    async (network) => {
      const { root, selected, other, cache } = await fixture();
      await executable(join(selected, 'rustc'), 'selected-toolchain');
      await executable(join(other, 'rustc'), 'older-unrelated-toolchain');
      const environment = safeEnvironment(
        root,
        { path: join(selected, 'cargo'), root: dirname(selected), searchDirectory: selected },
        { path: join(other, 'node'), root: dirname(other) },
        undefined,
        cache,
        root,
        true,
        network,
      );
      const result = spawnSync('rustc', [], { env: environment, encoding: 'utf8', timeout: 3000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('selected-toolchain');
      expect(environment.CARGO_NET_OFFLINE).toBe(network ? 'false' : 'true');
    },
  );

  it('finds a Cargo-installed development tool in the next shell environment', async () => {
    const { root, other, cache } = await fixture();
    await executable(join(cache, 'bin', 'cargo-fixture-tool'), 'retained-project-tool');
    const environment = safeEnvironment(
      root,
      { path: '/bin/zsh', root: '/bin' },
      undefined,
      undefined,
      cache,
      root,
      false,
      false,
    );
    environment.PATH = shellCommandPath(cache, other + ':/usr/bin:/bin');
    const result = spawnSync('cargo-fixture-tool', [], {
      env: environment,
      encoding: 'utf8',
      timeout: 3000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('retained-project-tool');
    expect(environment.HOME).toBe(root);
    expect(environment.CARGO_HOME).toBe(cache);
  });
});
