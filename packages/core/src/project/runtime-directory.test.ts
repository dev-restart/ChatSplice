import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProjectRuntimeDirectory } from './runtime-directory.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    mkdtemp: vi.fn(actual.mkdtemp),
    realpath: vi.fn(actual.realpath),
    rmdir: vi.fn(actual.rmdir),
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<{ platform: typeof platform; tmpdir: typeof tmpdir }>();
  return { ...actual, platform: vi.fn(() => 'linux') };
});

let actualFs: typeof fs;
const temporaryDirectories: string[] = [];
const uid = process.getuid?.() ?? -1;
const macParent = '/private/tmp';

beforeAll(async () => {
  actualFs = await vi.importActual<typeof fs>('node:fs/promises');
});

beforeEach(() => {
  vi.mocked(platform).mockReset().mockReturnValue('linux');
  vi.mocked(fs.lstat).mockReset().mockImplementation(actualFs.lstat);
  vi.mocked(fs.mkdtemp).mockReset().mockImplementation(actualFs.mkdtemp);
  vi.mocked(fs.realpath).mockReset().mockImplementation(actualFs.realpath);
  vi.mocked(fs.rmdir).mockReset().mockImplementation(actualFs.rmdir);
});

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await actualFs.rm(directory, { recursive: true, force: true });
  }
});

function metadata(overrides: Partial<Stats> = {}): Stats {
  return {
    dev: 1,
    ino: 2,
    uid,
    mode: 0o700,
    isDirectory: () => true,
    isSymbolicLink: () => false,
    ...overrides,
  } as Stats;
}

function mockMacRuntime(kind: 'exec' | 'run', child = metadata()): string {
  const directory = `${macParent}/${kind === 'exec' ? 'cs-e-' : 'cs-r-'}ABCDEF`;
  const parent = metadata({ uid: 0, mode: 0o1777, ino: 1 });
  vi.mocked(platform).mockReturnValue('darwin');
  vi.mocked(fs.realpath).mockResolvedValueOnce(macParent).mockResolvedValue(directory);
  vi.mocked(fs.mkdtemp).mockResolvedValue(directory);
  vi.mocked(fs.lstat)
    .mockResolvedValueOnce(parent)
    .mockResolvedValueOnce(child)
    .mockResolvedValueOnce(child)
    .mockResolvedValueOnce(parent)
    .mockResolvedValue(child);
  vi.mocked(fs.rmdir).mockResolvedValue(undefined);
  return directory;
}

describe('private project runtime directories', () => {
  it('creates distinct canonical 0700 directories owned by the current user in the allowed test TMPDIR', async () => {
    // Force the portable branch so this unit also runs inside the old managed
    // macOS sandbox, whose existing TMPDIR is its only writable runtime root.
    const parent = await actualFs.realpath(tmpdir());
    const execution = await createProjectRuntimeDirectory('exec');
    temporaryDirectories.push(execution);
    const run = await createProjectRuntimeDirectory('run');
    temporaryDirectories.push(run);

    expect(execution).not.toBe(run);
    const directories: Array<[string, string]> = [
      [execution, 'cs-e-'],
      [run, 'cs-r-'],
    ];
    for (const [directory, prefix] of directories) {
      const stat = await actualFs.lstat(directory);
      expect(dirname(directory)).toBe(parent);
      expect(basename(directory)).toMatch(new RegExp(`^${prefix}[A-Za-z0-9]{6}$`, 'u'));
      expect(stat.uid).toBe(uid);
      expect(stat.mode & 0o777).toBe(0o700);
      expect(stat.isDirectory()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(await actualFs.realpath(directory)).toBe(directory);
    }
  });

  it.each(['exec', 'run'] as const)(
    'uses the short canonical macOS path for %s without using the host TMPDIR',
    async (kind) => {
      const directory = mockMacRuntime(kind);
      await expect(createProjectRuntimeDirectory(kind)).resolves.toBe(directory);
      expect(fs.mkdtemp).toHaveBeenCalledTimes(1);
      expect(fs.mkdtemp).toHaveBeenCalledWith(
        `${macParent}/${kind === 'exec' ? 'cs-e-' : 'cs-r-'}`,
      );
      expect(fs.rmdir).not.toHaveBeenCalled();
    },
  );

  it('rejects a noncanonical macOS parent before creating anything', async () => {
    mockMacRuntime('exec');
    vi.mocked(fs.realpath).mockReset().mockResolvedValue('/unexpected/tmp');
    await expect(createProjectRuntimeDirectory('exec')).rejects.toThrow('parent must be canonical');
    expect(fs.mkdtemp).not.toHaveBeenCalled();
    expect(fs.rmdir).not.toHaveBeenCalled();
  });

  it.each([
    ['symbolic link', metadata({ isSymbolicLink: () => true })],
    ['foreign owner', metadata({ uid: uid + 10_000 })],
    ['shared writable without sticky bit', metadata({ uid: 0, mode: 0o777 })],
  ])('rejects an untrusted parent: %s', async (_label, parent) => {
    mockMacRuntime('exec');
    vi.mocked(fs.lstat)
      .mockReset()
      .mockResolvedValue(parent as Stats);
    await expect(createProjectRuntimeDirectory('exec')).rejects.toThrow('not a trusted directory');
    expect(fs.mkdtemp).not.toHaveBeenCalled();
  });

  it.each([
    ['foreign owner', metadata({ uid: uid + 10_000 })],
    ['symbolic link', metadata({ isSymbolicLink: () => true })],
  ])('does not use or remove an untrusted child: %s', async (_label, child) => {
    mockMacRuntime('exec', child as Stats);
    await expect(createProjectRuntimeDirectory('exec')).rejects.toThrow('private 0700 directory');
    expect(fs.rmdir).not.toHaveBeenCalled();
  });

  it('rejects a permissive child and removes only that same empty owned directory', async () => {
    const child = metadata({ mode: 0o755 });
    const directory = mockMacRuntime('exec', child);
    vi.mocked(fs.lstat)
      .mockReset()
      .mockResolvedValueOnce(metadata({ uid: 0, mode: 0o1777, ino: 1 }))
      .mockResolvedValueOnce(child)
      .mockResolvedValueOnce(metadata({ uid: 0, mode: 0o1777, ino: 1 }))
      .mockResolvedValue(child);
    await expect(createProjectRuntimeDirectory('exec')).rejects.toThrow('private 0700 directory');
    expect(fs.rmdir).toHaveBeenCalledTimes(1);
    expect(fs.rmdir).toHaveBeenCalledWith(directory);
  });

  it('rejects an inode replacement without deleting the replacement', async () => {
    mockMacRuntime('exec');
    const parent = metadata({ uid: 0, mode: 0o1777, ino: 1 });
    vi.mocked(fs.lstat)
      .mockReset()
      .mockResolvedValueOnce(parent)
      .mockResolvedValueOnce(metadata({ ino: 2 }))
      .mockResolvedValueOnce(metadata({ ino: 3 }))
      .mockResolvedValueOnce(parent)
      .mockResolvedValue(metadata({ ino: 3 }));
    await expect(createProjectRuntimeDirectory('exec')).rejects.toThrow('changed while');
    expect(fs.mkdtemp).toHaveBeenCalledWith(`${macParent}/cs-e-`);
    expect(fs.rmdir).not.toHaveBeenCalled();
  });

  it('cleans up a real empty runtime in the allowed TMPDIR when canonical validation fails', async () => {
    const parent = await actualFs.realpath(tmpdir());
    vi.mocked(fs.realpath)
      .mockReset()
      .mockResolvedValueOnce(parent)
      .mockResolvedValueOnce(`${parent}/unexpected-runtime-alias`);
    await expect(createProjectRuntimeDirectory('exec')).rejects.toThrow('may not traverse');
    const result = vi.mocked(fs.mkdtemp).mock.results[0];
    expect(result?.type).toBe('return');
    const directory = (await result?.value) as string;
    temporaryDirectories.push(directory);
    expect(fs.rmdir).toHaveBeenCalledTimes(1);
    expect(fs.rmdir).toHaveBeenCalledWith(directory);
    await expect(actualFs.lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
