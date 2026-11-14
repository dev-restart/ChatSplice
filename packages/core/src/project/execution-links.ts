import type { BigIntStats } from 'node:fs';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { join, relative } from 'node:path';

import { ChatSpliceError } from '../errors.js';
import { isWithinOrEqualRoot, isWorkspacePathDenied } from '../fs/path-policy.js';

// Inspect dependency-heavy projects completely within a finite work/time budget.
const MAX_ENTRIES = 1_000_000;
const MAX_DEPTH = 64;
const MAX_DURATION_MS = 60_000;
const MAX_METADATA_CONCURRENCY = 8;
const PROGRESS_INTERVAL_MS = 500;

export interface ExecutionPreflightProgress {
  readonly phase: 'scanning' | 'checking_links' | 'complete';
  readonly roots: number;
  readonly entries: number;
  readonly directories: number;
  readonly depth: number;
  readonly elapsed_ms: number;
  readonly entry_limit: number;
  readonly depth_limit: number;
  readonly duration_limit_ms: number;
}

/** Metadata-only, fail-closed preflight. Symlink targets are never traversed. */
export async function assertExecutionWorkspaceLinks(
  canonicalRoot: string | readonly string[],
  signal?: AbortSignal,
  readOnlyRoots: readonly string[] = [],
  onProgress?: (progress: ExecutionPreflightProgress) => void,
): Promise<void> {
  const startedAt = performance.now();
  const writableRoots = [
    ...new Set(typeof canonicalRoot === 'string' ? [canonicalRoot] : canonicalRoot),
  ];
  const candidates = [...new Set([...writableRoots, ...readOnlyRoots])];
  if (writableRoots.length === 0 || candidates.length > 101) {
    throw new ChatSpliceError('BAD_REQUEST', 'Execution link inspection requires 1–101 roots.');
  }
  const roots = candidates.filter(
    (root) => !candidates.some((other) => other !== root && isWithinOrEqualRoot(other, root)),
  );
  const pending = roots.map((root) => ({ path: root, depth: 0 }));
  const linked = new Map<string, { paths: string[]; links: bigint; dev: bigint; ino: bigint }>();
  let entries = 0;
  let directories = 0;
  let deepestDirectory = 0;
  let phase: ExecutionPreflightProgress['phase'] = 'scanning';
  let lastProgressAt = -Infinity;
  const reportProgress = (nextPhase = phase, force = false) => {
    if (onProgress === undefined) return;
    const now = performance.now();
    if (!force && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    phase = nextPhase;
    try {
      onProgress({
        phase,
        roots: roots.length,
        entries,
        directories,
        depth: deepestDirectory,
        elapsed_ms: Math.max(0, Math.trunc(now - startedAt)),
        entry_limit: MAX_ENTRIES,
        depth_limit: MAX_DEPTH,
        duration_limit_ms: MAX_DURATION_MS,
      });
    } catch {
      // Diagnostic callbacks cannot change the file validation outcome.
    }
  };
  const failLimit = (reason: 'entry' | 'time' | 'depth'): never => {
    const elapsedMs = Math.max(0, Math.trunc(performance.now() - startedAt));
    throw new ChatSpliceError(
      'BAD_REQUEST',
      '[EXECUTION_PREFLIGHT_' +
        reason.toUpperCase() +
        '_LIMIT] ' +
        'The execution link inspection ' +
        reason +
        ' limit was exceeded; the command was not started. ' +
        'Observed: roots=' +
        roots.length +
        ', entries=' +
        entries +
        ', directories=' +
        directories +
        ', depth=' +
        deepestDirectory +
        ', elapsed_ms=' +
        elapsedMs +
        '. Limits: entries=' +
        MAX_ENTRIES +
        ', depth=' +
        MAX_DEPTH +
        ', duration_ms=' +
        MAX_DURATION_MS +
        '. ' +
        'The inspection covers all permitted folders, including dependency and build directories. ' +
        'Changing cwd does not reduce this scope. Review the project and additional folder roots ' +
        'or unnecessary generated files before retrying.',
    );
  };
  const checkBudget = () => {
    if (signal?.aborted) throw new ChatSpliceError('BAD_REQUEST', 'Execution was cancelled.');
    if (entries > MAX_ENTRIES) failLimit('entry');
    if (performance.now() - startedAt >= MAX_DURATION_MS) failLimit('time');
    reportProgress();
  };
  const readMetadataBatch = async (
    paths: readonly string[],
  ): Promise<{ path: string; current: BigIntStats }[]> => {
    // Every path still gets lstat, including dependency/build entries and
    // symlinks. Drain the whole fixed-size batch even on cancellation/error,
    // so no metadata operation survives the failed preflight's root lease.
    const results = await Promise.allSettled(
      paths.map(async (path) => {
        checkBudget();
        const current = await lstat(path, { bigint: true });
        checkBudget();
        return { path, current };
      }),
    );
    return results.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
  };
  while (pending.length > 0) {
    checkBudget();
    const directory = pending.pop()!;
    const metadata = await lstat(directory.path, { bigint: true });
    if (!metadata.isDirectory() || (await realpath(directory.path)) !== directory.path) {
      throw new ChatSpliceError('PATH_OUTSIDE_WORKSPACE', 'The execution directory changed.');
    }
    checkBudget();
    const handle = await opendir(directory.path);
    directories += 1;
    const inspectEntries = async (paths: readonly string[]) => {
      for (const { path, current } of await readMetadataBatch(paths)) {
        if (current.isFile() && current.nlink !== 1n) {
          const key = `${current.dev}:${current.ino}`;
          const group = linked.get(key);
          if (group === undefined) {
            linked.set(key, {
              paths: [path],
              links: current.nlink,
              dev: current.dev,
              ino: current.ino,
            });
          } else {
            if (group.links !== current.nlink) {
              throw new ChatSpliceError(
                'PATH_NOT_FILE',
                'A linked file changed during execution inspection. Retry.',
              );
            }
            group.paths.push(path);
          }
        }
        if (current.isDirectory()) {
          deepestDirectory = Math.max(deepestDirectory, directory.depth + 1);
          if (directory.depth >= MAX_DEPTH) failLimit('depth');
          pending.push({ path, depth: directory.depth + 1 });
        }
      }
    };
    let batch: string[] = [];
    for await (const entry of handle) {
      entries += 1;
      checkBudget();
      batch.push(join(directory.path, entry.name));
      if (batch.length === MAX_METADATA_CONCURRENCY) {
        await inspectEntries(batch);
        batch = [];
      }
    }
    if (batch.length > 0) await inspectEntries(batch);
    const after = await lstat(directory.path, { bigint: true });
    if (after.dev !== metadata.dev || after.ino !== metadata.ino || !after.isDirectory()) {
      throw new ChatSpliceError('PATH_OUTSIDE_WORKSPACE', 'The execution directory changed.');
    }
    checkBudget();
  }
  checkBudget();
  reportProgress('checking_links', true);
  for (const group of linked.values()) {
    checkBudget();
    // Walk the readable union only once, with one entry/depth/time budget.
    // A writable inode must keep every alias inside writable roots. An inode
    // reached only through read-only roots must keep every alias in the full
    // readable union, so an approved folder cannot expose an unapproved file.
    const writableAliases = group.paths.filter((path) =>
      writableRoots.some((root) => isWithinOrEqualRoot(root, path)),
    );
    const allowedAliases = writableAliases.length === 0 ? group.paths : writableAliases;
    if (BigInt(allowedAliases.length) !== group.links) {
      const ownerRoot = roots.find((root) => isWithinOrEqualRoot(root, group.paths[0]!))!;
      const path = relative(ownerRoot, group.paths[0]!);
      const detail = isWorkspacePathDenied(path)
        ? ''
        : ` File: ${JSON.stringify(path.slice(0, 1024))}.`;
      throw new ChatSpliceError(
        'PATH_NOT_FILE',
        `Project execution requires hard-link aliases to remain inside the workspace's ${writableAliases.length === 0 ? 'readable' : 'writable'} folders.${detail} Copy externally linked files before retrying.`,
      );
    }
    for (let offset = 0; offset < group.paths.length; offset += MAX_METADATA_CONCURRENCY) {
      const paths = group.paths.slice(offset, offset + MAX_METADATA_CONCURRENCY);
      for (const { current } of await readMetadataBatch(paths)) {
        if (
          !current.isFile() ||
          current.dev !== group.dev ||
          current.ino !== group.ino ||
          current.nlink !== group.links
        ) {
          throw new ChatSpliceError(
            'PATH_NOT_FILE',
            'A linked file changed during execution inspection. Retry.',
          );
        }
      }
    }
  }
  checkBudget();
  reportProgress('complete', true);
}
