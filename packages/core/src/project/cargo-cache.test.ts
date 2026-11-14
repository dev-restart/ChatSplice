import { randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  beginCargoCacheRepair,
  inspectManagedCargoCache,
  prepareManagedCargoCache,
  publishCargoCacheRepair,
  type CargoCacheRepair,
  type ManagedCargoCache,
} from './cargo-cache.js';

const success = { exitCode: 0, timedOut: false, aborted: false };

describe('explicit Cargo cache generation recovery', () => {
  let temporary: string;
  let workspace: string;
  let initial: ManagedCargoCache;
  let selector: string;
  let ownedHomes: Set<string>;

  beforeEach(async () => {
    temporary = await realpath(await mkdtemp(join(tmpdir(), 'cs-cargo-recovery-')));
    workspace = join(temporary, 'workspace');
    await mkdir(workspace);
    initial = await prepareManagedCargoCache(workspace);
    selector = join(dirname(initial.toolHome), `${basename(initial.toolHome)}.selection.json`);
    ownedHomes = new Set([initial.toolHome]);
  });

  afterEach(async () => {
    await rm(selector, { force: true });
    for (const home of ownedHomes) await rm(home, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  });

  async function begin(): Promise<CargoCacheRepair> {
    const repair = await beginCargoCacheRepair(workspace);
    ownedHomes.add(repair.cargoHome);
    return repair;
  }

  async function extraction(home: string, name: string, marker: boolean, manifest: boolean) {
    const directory = join(home, 'registry', 'src', 'fixture-registry', name);
    await mkdir(directory, { recursive: true });
    if (marker) await writeFile(join(directory, '.cargo-ok'), '{"v":1}');
    if (manifest) await writeFile(join(directory, 'Cargo.toml'), '[package]\nname = "fixture"\n');
    return directory;
  }

  it('preserves the legacy home by default and does not create selection metadata', async () => {
    expect(initial.cargoHome).toBe(initial.toolHome);
    expect(basename(initial.toolHome)).toMatch(/^[a-f0-9]{64}$/);
    expect(await prepareManagedCargoCache(workspace)).toEqual(initial);
    await expect(lstat(selector)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(initial.cargoHome)).mode & 0o077).toBe(0);
  });

  it('publishes a successful new cache while retaining old jobs, tools and other language caches', async () => {
    const oldPackage = await extraction(initial.cargoHome, 'walkdir-2.5.0', true, false);
    await mkdir(join(initial.toolHome, 'bin'));
    await writeFile(join(initial.toolHome, 'bin', 'fixture-tool'), 'installed-tool');
    await mkdir(join(initial.toolHome, 'development-tools'));
    await writeFile(join(initial.toolHome, 'development-tools', 'python-cache'), 'retained');
    const repair = await begin();
    expect(repair.previousCargoHome).toBe(initial.cargoHome);
    expect(dirname(repair.cargoHome)).toBe(dirname(initial.cargoHome));
    expect(repair.cargoHome).not.toBe(initial.cargoHome);
    expect(await prepareManagedCargoCache(workspace)).toEqual(initial);
    await extraction(repair.cargoHome, 'walkdir-2.5.0', true, true);
    const promoted = await publishCargoCacheRepair(repair, success);
    expect(promoted).toEqual({ cargoHome: repair.cargoHome, toolHome: initial.toolHome });
    expect(await prepareManagedCargoCache(workspace)).toEqual(promoted);
    expect(JSON.parse(await readFile(selector, 'utf8'))).toEqual({
      format: 1,
      generation: basename(repair.cargoHome),
    });
    expect((await lstat(selector)).nlink).toBe(1);
    expect((await lstat(selector)).mode & 0o077).toBe(0);
    expect(await readFile(join(oldPackage, '.cargo-ok'), 'utf8')).toBe('{"v":1}');
    await expect(lstat(join(oldPackage, 'Cargo.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(initial.toolHome, 'bin', 'fixture-tool'), 'utf8')).toBe(
      'installed-tool',
    );
    expect(
      await readFile(join(initial.toolHome, 'development-tools', 'python-cache'), 'utf8'),
    ).toBe('retained');
    // A background job that already received the old path can keep using it.
    await writeFile(join(initial.cargoHome, 'old-job-output'), 'still-owned');
    expect(await readFile(join(initial.cargoHome, 'old-job-output'), 'utf8')).toBe('still-owned');
  });

  it.each([
    { exitCode: 101, timedOut: false, aborted: false },
    { exitCode: null, timedOut: true, aborted: false },
    { exitCode: 0, timedOut: false, aborted: true },
  ])('does not publish or delete a failed repair: %j', async (result) => {
    const repair = await begin();
    await writeFile(join(repair.cargoHome, 'partial-download'), 'diagnostic-evidence');
    await expect(publishCargoCacheRepair(repair, result)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(await prepareManagedCargoCache(workspace)).toEqual(initial);
    expect(await readFile(join(repair.cargoHome, 'partial-download'), 'utf8')).toBe(
      'diagnostic-evidence',
    );
    await expect(lstat(selector)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not publish a successful command after cancellation', async () => {
    const repair = await begin();
    const controller = new AbortController();
    controller.abort(new Error('repair-cancelled'));
    await expect(publishCargoCacheRepair(repair, success, controller.signal)).rejects.toThrow(
      'repair-cancelled',
    );
    expect(await prepareManagedCargoCache(workspace)).toEqual(initial);
    expect((await lstat(repair.cargoHome)).isDirectory()).toBe(true);
  });

  it('rejects a stale competing repair instead of silently replacing the newer selection', async () => {
    const first = await begin();
    const second = await begin();
    const results = await Promise.allSettled([
      publishCargoCacheRepair(first, success),
      publishCargoCacheRepair(second, success),
    ]);
    const successful = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      message: expect.stringContaining('selection changed'),
    });
    expect(await prepareManagedCargoCache(workspace)).toEqual(successful[0]?.value);
    expect((await lstat(first.cargoHome)).isDirectory()).toBe(true);
    expect((await lstat(second.cargoHome)).isDirectory()).toBe(true);
  });

  it('keeps the fixed tool home through repeated repairs and rejects reused handles', async () => {
    const first = await begin();
    await publishCargoCacheRepair(first, success);
    const second = await begin();
    expect(second.previousCargoHome).toBe(first.cargoHome);
    await publishCargoCacheRepair(second, success);
    expect(await prepareManagedCargoCache(workspace)).toEqual({
      cargoHome: second.cargoHome,
      toolHome: initial.toolHome,
    });
    await expect(publishCargoCacheRepair(first, success)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('recreates a cleared selected cache without changing its selection', async () => {
    const first = await begin();
    await publishCargoCacheRepair(first, success);
    const selectionBefore = await readFile(selector, 'utf8');
    await rm(first.cargoHome, { recursive: true });
    expect(await inspectManagedCargoCache(workspace)).toMatchObject({
      cargoHome: first.cargoHome,
      exists: false,
    });
    await expect(lstat(first.cargoHome)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await prepareManagedCargoCache(workspace)).toEqual({
      cargoHome: first.cargoHome,
      toolHome: initial.toolHome,
    });
    expect((await lstat(first.cargoHome)).mode & 0o077).toBe(0);
    expect(await readFile(selector, 'utf8')).toBe(selectionBefore);
    const replacement = await begin();
    await publishCargoCacheRepair(replacement, success);
    expect((await prepareManagedCargoCache(workspace)).cargoHome).toBe(replacement.cargoHome);
    expect((await lstat(first.cargoHome)).isDirectory()).toBe(true);
  });

  it.each(['config', 'config.toml', 'credentials', 'credentials.toml', 'credentials.toml.enc'])(
    'retains forbidden %s checks when publishing a generation',
    async (name) => {
      const repair = await begin();
      await writeFile(join(repair.cargoHome, name), 'untrusted');
      await expect(publishCargoCacheRepair(repair, success)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(await prepareManagedCargoCache(workspace)).toEqual(initial);
    },
  );

  it.each([
    () => '{',
    () => JSON.stringify({ format: 1, generation: '../outside' }),
    () => JSON.stringify({ format: 1, generation: `${'a'.repeat(64)}-${randomUUID()}` }),
    () => JSON.stringify({ format: 2, generation: 'unknown' }),
    () => ' '.repeat(513),
  ])('rejects invalid, cross-workspace or oversized selection metadata', async (contents) => {
    await writeFile(selector, contents(), { mode: 0o600 });
    await expect(prepareManagedCargoCache(workspace)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it.each(['symbolic', 'hard'])('rejects a %s link used as selection metadata', async (kind) => {
    const file = join(temporary, 'foreign-selection');
    await writeFile(file, '{}', { mode: 0o600 });
    if (kind === 'symbolic') await symlink(file, selector);
    else await link(file, selector);
    await expect(prepareManagedCargoCache(workspace)).rejects.toMatchObject({
      code: 'PATH_NOT_FILE',
    });
    expect(await readFile(file, 'utf8')).toBe('{}');
  });

  it('rejects selection metadata that is not private', async () => {
    const repair = await begin();
    await publishCargoCacheRepair(repair, success);
    await chmod(selector, 0o644);
    await expect(prepareManagedCargoCache(workspace)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('reports completed extractions missing manifests without changing packages', async () => {
    const broken = await extraction(initial.cargoHome, 'aho-corasick-1.1.5', true, false);
    await extraction(initial.cargoHome, 'healthy-1.0.0', true, true);
    await extraction(initial.cargoHome, 'in-progress-1.0.0', false, false);
    const inspection = await inspectManagedCargoCache(workspace);
    expect(inspection).toMatchObject({
      cargoHome: initial.cargoHome,
      toolHome: initial.toolHome,
      exists: true,
      scannedPackages: 3,
      completedExtractions: 2,
      missingManifests: ['registry/src/fixture-registry/aho-corasick-1.1.5/Cargo.toml'],
      inspectionErrors: [],
      truncated: false,
    });
    expect(await readFile(join(broken, '.cargo-ok'), 'utf8')).toBe('{"v":1}');
    await expect(lstat(join(broken, 'Cargo.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(selector)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('bounds diagnostic output and does not follow linked package directories', async () => {
    for (let index = 0; index < 33; index += 1) {
      await extraction(initial.cargoHome, `broken-${index}`, true, false);
    }
    const outside = join(temporary, 'outside-package');
    await mkdir(outside);
    await writeFile(join(outside, '.cargo-ok'), '{"v":1}');
    await symlink(
      outside,
      join(initial.cargoHome, 'registry', 'src', 'fixture-registry', 'linked-package'),
    );
    const inspection = await inspectManagedCargoCache(workspace);
    expect(inspection.missingManifests).toHaveLength(32);
    expect(inspection.truncated).toBe(true);
    expect(inspection.missingManifests.some((path) => path.includes('linked-package'))).toBe(false);
  });

  it('does not create a Cargo home when inspecting an unused workspace', async () => {
    const unused = join(temporary, 'unused');
    await mkdir(unused);
    const inspection = await inspectManagedCargoCache(unused);
    expect(inspection.exists).toBe(false);
    await expect(lstat(inspection.cargoHome)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
