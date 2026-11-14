import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Metadata {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  isDirectory(): boolean;
  isFile(): boolean;
}

const io = vi.hoisted(() => ({
  now: undefined as unknown as () => number,
  stat: undefined as unknown as (path: string) => Promise<Metadata>,
  list: undefined as unknown as (path: string) => Promise<AsyncIterable<{ name: string }>>,
  canonical: undefined as unknown as (path: string) => Promise<string>,
}));

// A plain clock avoids retaining millions of spy calls in the large-tree boundary tests.
vi.mock('node:perf_hooks', () => ({ performance: { now: () => io.now() } }));

vi.mock('node:fs/promises', () => ({
  lstat: (path: string) => io.stat(path),
  opendir: (path: string) => io.list(path),
  realpath: (path: string) => io.canonical(path),
}));

import {
  assertExecutionWorkspaceLinks,
  type ExecutionPreflightProgress,
} from './execution-links.js';

const root = '/fixture/private-project';
const directoryMetadata = (ino = 1n): Metadata => ({
  dev: 1n,
  ino,
  nlink: 1n,
  isDirectory: () => true,
  isFile: () => false,
});
const fileMetadata = (links = 1n): Metadata => ({
  dev: 1n,
  ino: 2n,
  nlink: links,
  isDirectory: () => false,
  isFile: () => true,
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('bounded execution metadata preflight', () => {
  let elapsed: number;
  let closed: boolean;

  const entries = (count: number): AsyncIterable<{ name: string }> => ({
    async *[Symbol.asyncIterator]() {
      try {
        for (let index = 0; index < count; index += 1) yield { name: 'file-' + index };
      } finally {
        closed = true;
      }
    },
  });

  beforeEach(() => {
    elapsed = 0;
    closed = false;
    io.now = () => elapsed;
    io.canonical = async (path) => path;
    io.list = async () => entries(0);
    io.stat = async (path) => (path === root ? directoryMetadata() : fileMetadata());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the enlarged entry cap without scanning beyond it or exposing paths', async () => {
    let fileReads = 0;
    io.list = async () => entries(1_000_001);
    io.stat = async (path) => {
      if (path === root) return directoryMetadata();
      fileReads += 1;
      return fileMetadata();
    };

    const failure = await assertExecutionWorkspaceLinks(root).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
    const message = (failure as Error).message;
    expect(message).toContain('[EXECUTION_PREFLIGHT_ENTRY_LIMIT]');
    expect(message).toContain('the command was not started');
    expect(message).toContain('entries=1000001');
    expect(message).toContain('Limits: entries=1000000, depth=64, duration_ms=60000');
    expect(message).toContain('roots=1');
    expect(message).not.toContain(root);
    expect(message.length).toBeLessThan(1000);
    expect(fileReads).toBe(1_000_000);
    expect(closed).toBe(true);
  }, 20_000);

  it('rejects a time overrun during the final directory recheck, even in an empty root', async () => {
    let reads = 0;
    io.stat = async () => {
      reads += 1;
      if (reads === 2) elapsed = 60_000;
      return directoryMetadata();
    };

    await expect(assertExecutionWorkspaceLinks(root)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('[EXECUTION_PREFLIGHT_TIME_LIMIT]'),
    });
    expect(closed).toBe(true);
  });

  it('reports the unchanged depth cap in an approved read-only root', async () => {
    const readRoot = '/fixture/private-reference';
    const depth = (path: string) => path.slice(readRoot.length).split('/').filter(Boolean).length;
    io.stat = async (path) => directoryMetadata(BigInt(path.length));
    io.list = async (path) => ({
      async *[Symbol.asyncIterator]() {
        if (path !== root && depth(path) < 65) yield { name: 'd' };
      },
    });

    const failure = await assertExecutionWorkspaceLinks(root, undefined, [readRoot]).catch(
      (error: unknown) => error,
    );
    const message = (failure as Error).message;
    expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
    expect(message).toContain('[EXECUTION_PREFLIGHT_DEPTH_LIMIT]');
    expect(message).toContain('depth=65');
    expect(message).toContain('roots=2');
    expect(message).not.toContain(readRoot);
  });

  it('bounds concurrent metadata reads and inspects dependency/build entries without following symlinks', async () => {
    const directories = new Set([root, root + '/node_modules', root + '/target']);
    const observed = new Set<string>();
    const resolved = new Set<string>();
    let active = 0;
    let peak = 0;
    io.canonical = async (path) => {
      resolved.add(path);
      return path;
    };
    io.list = async (path) =>
      path === root
        ? {
            async *[Symbol.asyncIterator]() {
              yield { name: 'node_modules' };
              yield { name: 'target' };
              yield { name: 'symbolic-alias' };
            },
          }
        : entries(path.endsWith('/target') ? 17 : 16);
    io.stat = async (path) => {
      if (directories.has(path)) return directoryMetadata(BigInt(path.length));
      active += 1;
      peak = Math.max(peak, active);
      try {
        await tick();
        observed.add(path);
        return path.endsWith('/symbolic-alias')
          ? { ...fileMetadata(), isFile: () => false }
          : fileMetadata();
      } finally {
        active -= 1;
      }
    };

    await expect(assertExecutionWorkspaceLinks(root)).resolves.toBeUndefined();
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(active).toBe(0);
    expect(observed.size).toBe(34);
    expect(observed.has(root + '/node_modules/file-15')).toBe(true);
    expect(observed.has(root + '/target/file-16')).toBe(true);
    expect(observed.has(root + '/symbolic-alias')).toBe(true);
    expect(resolved).toEqual(directories);
  });

  it('drains every in-flight metadata read and closes the directory after a failed batch', async () => {
    const failure = new Error('fixture metadata failure');
    let active = 0;
    let fileReads = 0;
    io.list = async () => entries(16);
    io.stat = async (path) => {
      if (path === root) return directoryMetadata();
      active += 1;
      fileReads += 1;
      try {
        await tick();
        if (path.endsWith('/file-0')) throw failure;
        return fileMetadata();
      } finally {
        active -= 1;
      }
    };

    await expect(assertExecutionWorkspaceLinks(root)).rejects.toBe(failure);
    expect(active).toBe(0);
    expect(fileReads).toBe(8);
    expect(closed).toBe(true);
  });

  it('drains in-flight reads on cancellation and never inspects the next batch', async () => {
    const controller = new AbortController();
    let active = 0;
    let fileReads = 0;
    io.list = async () => entries(16);
    io.stat = async (path) => {
      if (path === root) return directoryMetadata();
      active += 1;
      fileReads += 1;
      try {
        await tick();
        controller.abort();
        return fileMetadata();
      } finally {
        active -= 1;
      }
    };

    await expect(assertExecutionWorkspaceLinks(root, controller.signal)).rejects.toThrow(
      'Execution was cancelled.',
    );
    expect(active).toBe(0);
    expect(fileReads).toBe(8);
    expect(closed).toBe(true);
  });

  it('retains the directory inode recheck after batched file inspection', async () => {
    let rootReads = 0;
    io.list = async () => entries(1);
    io.stat = async (path) => {
      if (path !== root) return fileMetadata();
      rootReads += 1;
      return directoryMetadata(BigInt(rootReads));
    };

    await expect(assertExecutionWorkspaceLinks(root)).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_WORKSPACE',
      message: 'The execution directory changed.',
    });
  });

  it('retains acceptance at the former 200,000 entry boundary', async () => {
    let fileReads = 0;
    io.list = async () => entries(200_000);
    io.stat = async (path) => {
      if (path === root) return directoryMetadata();
      fileReads += 1;
      return fileMetadata();
    };

    await expect(assertExecutionWorkspaceLinks(root)).resolves.toBeUndefined();
    expect(fileReads).toBe(200_000);
    expect(closed).toBe(true);
  });

  it('accepts a complete tree above the former entry and time limits', async () => {
    let fileReads = 0;
    io.list = async () => entries(200_001);
    io.stat = async (path) => {
      if (path === root) return directoryMetadata();
      fileReads += 1;
      if (fileReads === 100_000) elapsed = 20_000;
      return fileMetadata();
    };

    await expect(assertExecutionWorkspaceLinks(root)).resolves.toBeUndefined();
    expect(fileReads).toBe(200_001);
    expect(closed).toBe(true);
  }, 20_000);

  it('accepts exactly one million fully inspected entries at the new boundary', async () => {
    let fileReads = 0;
    io.list = async () => entries(1_000_000);
    io.stat = async (path) => {
      if (path === root) return directoryMetadata();
      fileReads += 1;
      return fileMetadata();
    };

    await expect(assertExecutionWorkspaceLinks(root)).resolves.toBeUndefined();
    expect(fileReads).toBe(1_000_000);
    expect(closed).toBe(true);
  }, 20_000);

  it('reports bounded path-free progress and distinguishes alias recheck from completion', async () => {
    const progress: ExecutionPreflightProgress[] = [];
    io.list = async () => entries(40);
    io.stat = async (path) => {
      if (path === root) return directoryMetadata();
      elapsed += 100;
      return fileMetadata();
    };

    await assertExecutionWorkspaceLinks(root, undefined, [], (value) => progress.push(value));
    expect(progress[0]).toMatchObject({ phase: 'scanning', entries: 0, elapsed_ms: 0 });
    const scans = progress.filter((value) => value.phase === 'scanning');
    expect(scans.length).toBeGreaterThan(1);
    for (let index = 1; index < scans.length; index += 1) {
      expect(scans[index]!.elapsed_ms - scans[index - 1]!.elapsed_ms).toBeGreaterThanOrEqual(500);
    }
    expect(progress.slice(-2).map((value) => value.phase)).toEqual(['checking_links', 'complete']);
    expect(progress.at(-1)).toEqual({
      phase: 'complete',
      roots: 1,
      entries: 40,
      directories: 1,
      depth: 0,
      elapsed_ms: 4_000,
      entry_limit: 1_000_000,
      depth_limit: 64,
      duration_limit_ms: 60_000,
    });
    expect(JSON.stringify(progress)).not.toContain(root);
    expect(progress.length).toBeLessThanOrEqual(11);
  });

  it('isolates diagnostic callback failures without accepting an external alias', async () => {
    const throwingProgress = () => {
      throw new Error('observer failure');
    };
    await expect(
      assertExecutionWorkspaceLinks(root, undefined, [], throwingProgress),
    ).resolves.toBeUndefined();

    io.list = async () => entries(1);
    io.stat = async (path) => (path === root ? directoryMetadata() : fileMetadata(2n));
    const phases: ExecutionPreflightProgress['phase'][] = [];
    await expect(
      assertExecutionWorkspaceLinks(root, undefined, [], (value) => {
        phases.push(value.phase);
        throwingProgress();
      }),
    ).rejects.toMatchObject({ code: 'PATH_NOT_FILE' });
    expect(phases).toContain('checking_links');
    expect(phases).not.toContain('complete');
  });

  it('accepts directory depth 64 without a deeper child', async () => {
    const depth = (path: string) => path.slice(root.length).split('/').filter(Boolean).length;
    const openedDepths: number[] = [];
    io.stat = async (path) => directoryMetadata(BigInt(path.length));
    io.list = async (path) => {
      const currentDepth = depth(path);
      openedDepths.push(currentDepth);
      return {
        async *[Symbol.asyncIterator]() {
          if (currentDepth < 64) yield { name: 'd' };
        },
      };
    };

    await expect(assertExecutionWorkspaceLinks(root)).resolves.toBeUndefined();
    expect(openedDepths).toHaveLength(65);
    expect(Math.max(...openedDepths)).toBe(64);
  });

  it('rejects a writable inode with an alias in an approved read-only root', async () => {
    const readRoot = '/fixture/private-reference';
    const directories = new Set([root, readRoot]);
    io.list = async () => entries(1);
    io.stat = async (path) =>
      directories.has(path) ? directoryMetadata(BigInt(path.length)) : fileMetadata(2n);

    await expect(assertExecutionWorkspaceLinks(root, undefined, [readRoot])).rejects.toMatchObject({
      code: 'PATH_NOT_FILE',
      message: expect.stringContaining("workspace's writable folders"),
    });
  });

  it('accepts and rechecks an inode whose aliases fill the approved read-only union', async () => {
    const firstReadRoot = '/fixture/private-reference-a';
    const secondReadRoot = '/fixture/private-reference-b';
    const directories = new Set([root, firstReadRoot, secondReadRoot]);
    const reads = new Map<string, number>();
    io.list = async (path) => entries(path === root ? 0 : 1);
    io.stat = async (path) => {
      if (directories.has(path)) return directoryMetadata(BigInt(path.length));
      reads.set(path, (reads.get(path) ?? 0) + 1);
      return fileMetadata(2n);
    };

    await expect(
      assertExecutionWorkspaceLinks(root, undefined, [firstReadRoot, secondReadRoot]),
    ).resolves.toBeUndefined();
    expect(reads.size).toBe(2);
    expect(reads.get(firstReadRoot + '/file-0')).toBe(2);
    expect(reads.get(secondReadRoot + '/file-0')).toBe(2);
  });

  it('walks nested roots only once when proving hard-link alias completeness', async () => {
    const nestedRoot = root + '/nested';
    const directories = new Set([root, nestedRoot]);
    const opened = new Map<string, number>();
    const reads = new Map<string, number>();
    io.list = async (path) => {
      opened.set(path, (opened.get(path) ?? 0) + 1);
      return {
        async *[Symbol.asyncIterator]() {
          yield { name: 'file-0' };
          if (path === root) yield { name: 'nested' };
        },
      };
    };
    io.stat = async (path) => {
      if (directories.has(path)) return directoryMetadata(BigInt(path.length));
      reads.set(path, (reads.get(path) ?? 0) + 1);
      return fileMetadata(2n);
    };

    await expect(assertExecutionWorkspaceLinks([root, nestedRoot, root])).resolves.toBeUndefined();
    expect(opened.size).toBe(2);
    expect(opened.get(root)).toBe(1);
    expect(opened.get(nestedRoot)).toBe(1);
    expect(reads.size).toBe(2);
    expect(reads.get(root + '/file-0')).toBe(2);
    expect(reads.get(nestedRoot + '/file-0')).toBe(2);
  });

  it('rechecks all hard-link aliases before accepting their original in-root count', async () => {
    const reads = new Map<string, number>();
    io.list = async () => entries(2);
    io.stat = async (path) => {
      if (path === root) return directoryMetadata();
      const count = (reads.get(path) ?? 0) + 1;
      reads.set(path, count);
      return fileMetadata(path.endsWith('/file-0') && count === 2 ? 3n : 2n);
    };

    await expect(assertExecutionWorkspaceLinks(root)).rejects.toMatchObject({
      code: 'PATH_NOT_FILE',
      message: 'A linked file changed during execution inspection. Retry.',
    });
    expect([...reads.values()]).toEqual([2, 2]);
  });
});
