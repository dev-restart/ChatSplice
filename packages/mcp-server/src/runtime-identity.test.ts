import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getRuntimeIdentity,
  getRuntimeIdentitySync,
  hashRuntimeCodePaths,
} from './runtime-identity.js';

describe('runtime code identity', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'chatsplice-runtime-code-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('hashes actual code and filenames, excluding tests and generated declaration/maps', async () => {
    await writeFile(join(directory, 'index.js'), 'export const value = 1;');
    const paths = [{ label: 'runtime', path: directory }];
    const initial = hashRuntimeCodePaths(paths);
    await writeFile(join(directory, 'index.test.js'), 'test-only');
    await writeFile(join(directory, 'index.d.ts'), 'declaration-only');
    await writeFile(join(directory, 'index.js.map'), 'source-map-only');
    expect(hashRuntimeCodePaths(paths)).toBe(initial);
    await writeFile(join(directory, 'index.js'), 'export const value = 2;');
    expect(hashRuntimeCodePaths(paths)).not.toBe(initial);
  });

  it('is independent of absolute deployment directory and input ordering', async () => {
    const first = join(directory, 'first');
    const second = join(directory, 'second');
    await mkdir(first);
    await mkdir(second);
    await writeFile(join(first, 'index.js'), 'module.exports = 1;');
    await writeFile(join(second, 'index.js'), 'module.exports = 1;');
    expect(hashRuntimeCodePaths([{ label: 'runtime', path: first }])).toBe(
      hashRuntimeCodePaths([{ label: 'runtime', path: second }]),
    );
    const paths = [
      { label: 'core', path: first },
      { label: 'protocol', path: second },
    ];
    expect(hashRuntimeCodePaths(paths)).toBe(hashRuntimeCodePaths([...paths].reverse()));
  });

  it('supports the packaged daemon single-file code path', async () => {
    const bundle = join(directory, 'chatspliced.js');
    await writeFile(bundle, '/* all workspace packages */ module.exports = 1;');
    const first = hashRuntimeCodePaths([{ label: 'daemon-bundle', path: bundle }]);
    await writeFile(bundle, '/* all workspace packages */ module.exports = 2;');
    expect(hashRuntimeCodePaths([{ label: 'daemon-bundle', path: bundle }])).not.toBe(first);
  });

  it('rejects escaped links, empty trees and oversized code', async () => {
    await writeFile(join(directory, 'index.js'), 'code');
    await symlink(join(directory, 'index.js'), join(directory, 'linked.js'));
    expect(() => hashRuntimeCodePaths([{ label: 'runtime', path: directory }])).toThrow(
      'symbolic links',
    );
    const empty = join(directory, 'empty');
    await mkdir(empty);
    expect(() => hashRuntimeCodePaths([{ label: 'empty', path: empty }])).toThrow(
      'no executable code',
    );
    const oversized = join(directory, 'large.js');
    await writeFile(oversized, Buffer.alloc(32 * 1024 * 1024 + 1));
    expect(() => hashRuntimeCodePaths([{ label: 'bundle', path: oversized }])).toThrow('exceeded');
  });

  it('provides the same cached process identity through sync and async callers', async () => {
    const sync = getRuntimeIdentitySync();
    expect(sync.build_id).toMatch(/^[a-f0-9]{64}$/u);
    expect(sync.run_id).toMatch(/^[a-f0-9-]{36}$/u);
    expect(await getRuntimeIdentity()).toBe(sync);
    expect(getRuntimeIdentitySync()).toBe(sync);
  });
});
