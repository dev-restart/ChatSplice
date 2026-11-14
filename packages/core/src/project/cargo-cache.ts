import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatSpliceError } from '../errors.js';
import { readCheckedFile } from '../fs/checked-file.js';

const CACHE_DIRECTORY = 'chatsplice-cargo-cache';
const MAX_SELECTION_BYTES = 512;
const MAX_SCAN_ENTRIES = 4096;
const MAX_SCAN_ISSUES = 32;
const SCAN_DEADLINE_MS = 3000;
const FORBIDDEN_FILES = [
  'config',
  'config.toml',
  'credentials',
  'credentials.toml',
  'credentials.toml.enc',
];
const GENERATION_SUFFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ManagedCargoCache {
  cargoHome: string;
  /** Stable CARGO_INSTALL_ROOT and home for the other development-tool caches. */
  toolHome: string;
}

export interface CargoCacheRepair extends ManagedCargoCache {
  previousCargoHome: string;
}

export interface CargoCacheInspection extends ManagedCargoCache {
  exists: boolean;
  scannedPackages: number;
  completedExtractions: number;
  missingManifests: string[];
  inspectionErrors: { path: string; code: string }[];
  truncated: boolean;
}

interface CacheLayout {
  cacheRoot: string;
  cacheKey: string;
  toolHome: string;
  selectionPath: string;
}

interface Selection {
  generation: string | undefined;
  fingerprint: string | null;
}

interface RepairState {
  layout: CacheLayout;
  generation: string;
  expectedSelection: string | null;
}

const repairs = new WeakMap<CargoCacheRepair, RepairState>();
const publishQueues = new Map<string, Promise<void>>();

function invalid(message: string): never {
  throw new ChatSpliceError('BAD_REQUEST', message);
}

function pathError(message: string): never {
  throw new ChatSpliceError('PATH_OUTSIDE_WORKSPACE', message);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function layoutFor(workspaceRoot: string): Promise<CacheLayout> {
  const parent = await realpath(tmpdir());
  const cacheRoot = join(parent, CACHE_DIRECTORY);
  const cacheKey = createHash('sha256').update(workspaceRoot).digest('hex');
  return {
    cacheRoot,
    cacheKey,
    toolHome: join(cacheRoot, cacheKey),
    selectionPath: join(cacheRoot, `${cacheKey}.selection.json`),
  };
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || (await realpath(path)) !== path) {
    pathError('Cargo cache may not traverse a symbolic link.');
  }
  const uid = process.getuid?.();
  if (uid === undefined || metadata.uid !== uid || (metadata.mode & 0o077) !== 0) {
    invalid('Cargo cache is not a private directory owned by the current user.');
  }
}

async function createPrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  await assertPrivateDirectory(path);
}

async function assertCargoHome(path: string): Promise<void> {
  await assertPrivateDirectory(path);
  for (const name of FORBIDDEN_FILES) {
    if (await exists(join(path, name))) {
      invalid('Cargo cache configuration and credentials are not permitted.');
    }
  }
}

function isGeneration(layout: CacheLayout, name: string): boolean {
  const prefix = `${layout.cacheKey}-`;
  return name.startsWith(prefix) && GENERATION_SUFFIX.test(name.slice(prefix.length));
}

async function readSelection(layout: CacheLayout): Promise<Selection> {
  let checked: Awaited<ReturnType<typeof readCheckedFile>>;
  try {
    checked = await readCheckedFile(layout.selectionPath, MAX_SELECTION_BYTES);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { generation: undefined, fingerprint: null };
    throw error;
  }
  if (checked.metadata.uid !== process.getuid?.() || (checked.metadata.mode & 0o077) !== 0) {
    invalid('Cargo cache selection must be private and owned by the current user.');
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(checked.bytes));
  } catch {
    invalid('Cargo cache selection is not valid UTF-8 JSON.');
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'format,generation' ||
    !('format' in value) ||
    value.format !== 1 ||
    !('generation' in value) ||
    typeof value.generation !== 'string' ||
    !isGeneration(layout, value.generation)
  ) {
    invalid('Cargo cache selection must name a generation of this workspace.');
  }
  return {
    generation: value.generation,
    fingerprint: createHash('sha256').update(checked.bytes).digest('hex'),
  };
}

function selectedHome(layout: CacheLayout, selection: Selection): string {
  return selection.generation === undefined
    ? layout.toolHome
    : join(layout.cacheRoot, selection.generation);
}

/** Resolves the selected cache without inspecting or changing package contents. */
export async function prepareManagedCargoCache(workspaceRoot: string): Promise<ManagedCargoCache> {
  const layout = await layoutFor(workspaceRoot);
  await createPrivateDirectory(layout.cacheRoot);
  await createPrivateDirectory(layout.toolHome);
  await assertCargoHome(layout.toolHome);
  const cargoHome = selectedHome(layout, await readSelection(layout));
  // The OS can clear a cache directory. Recreate only the selected directory
  // so unrelated language jobs remain usable; never delete existing packages.
  await createPrivateDirectory(cargoHome);
  await assertCargoHome(cargoHome);
  return { cargoHome, toolHome: layout.toolHome };
}

/** Creates a new, empty sibling. Neither this nor a failed command changes selection. */
export async function beginCargoCacheRepair(
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<CargoCacheRepair> {
  signal?.throwIfAborted();
  const layout = await layoutFor(workspaceRoot);
  await createPrivateDirectory(layout.cacheRoot);
  await createPrivateDirectory(layout.toolHome);
  await assertCargoHome(layout.toolHome);
  const selection = await readSelection(layout);
  const generation = `${layout.cacheKey}-${randomUUID()}`;
  const cargoHome = join(layout.cacheRoot, generation);
  signal?.throwIfAborted();
  await mkdir(cargoHome, { mode: 0o700 });
  await assertCargoHome(cargoHome);
  signal?.throwIfAborted();
  const repair = Object.freeze({
    cargoHome,
    toolHome: layout.toolHome,
    previousCargoHome: selectedHome(layout, selection),
  });
  repairs.set(repair, { layout, generation, expectedSelection: selection.fingerprint });
  return repair;
}

async function withPublishLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = publishQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  publishQueues.set(key, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (publishQueues.get(key) === tail) publishQueues.delete(key);
  }
}

/**
 * Call only with the result of the fixed `cargo fetch --locked` repair command.
 * The owner daemon serializes publication; stale repair handles cannot overwrite
 * a newer selection. Selection lives outside both granted CARGO_HOME directories.
 */
export async function publishCargoCacheRepair(
  repair: CargoCacheRepair,
  result: { exitCode: number | null; timedOut: boolean; aborted: boolean },
  signal?: AbortSignal,
): Promise<ManagedCargoCache> {
  if (result.exitCode !== 0 || result.timedOut || result.aborted) {
    invalid('Cargo cache repair was not published because locked fetch did not succeed.');
  }
  const state = repairs.get(repair);
  if (state === undefined) invalid('Cargo cache repair handle is unknown or already published.');
  return withPublishLock(state.layout.selectionPath, async () => {
    signal?.throwIfAborted();
    const { layout } = state;
    const cargoHome = join(layout.cacheRoot, state.generation);
    await assertPrivateDirectory(layout.cacheRoot);
    await assertCargoHome(layout.toolHome);
    await assertCargoHome(cargoHome);
    const assertExpected = async () => {
      if ((await readSelection(layout)).fingerprint !== state.expectedSelection) {
        invalid(
          'Cargo cache selection changed during repair. The previous selection was preserved.',
        );
      }
    };
    await assertExpected();
    const pending = join(layout.cacheRoot, `.${layout.cacheKey}-${randomUUID()}.selection.tmp`);
    const handle = await open(
      pending,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let published = false;
    try {
      try {
        await handle.writeFile(
          `${JSON.stringify({ format: 1, generation: state.generation })}\n`,
          'utf8',
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await assertPrivateDirectory(layout.cacheRoot);
      await assertExpected();
      signal?.throwIfAborted();
      await rename(pending, layout.selectionPath);
      published = true;
      repairs.delete(repair);
      return { cargoHome, toolHome: layout.toolHome };
    } finally {
      // Only the unique metadata staging file is removed. Cargo homes are never deleted.
      if (!published) await unlink(pending).catch(() => undefined);
    }
  });
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && (await realpath(path)) === path;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

/** Read-only, bounded observation. A missing marker is not treated as corruption. */
export async function inspectManagedCargoCache(
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<CargoCacheInspection> {
  const layout = await layoutFor(workspaceRoot);
  const result: CargoCacheInspection = {
    cargoHome: layout.toolHome,
    toolHome: layout.toolHome,
    exists: false,
    scannedPackages: 0,
    completedExtractions: 0,
    missingManifests: [],
    inspectionErrors: [],
    truncated: false,
  };
  signal?.throwIfAborted();
  if (!(await exists(layout.cacheRoot))) return result;
  await assertPrivateDirectory(layout.cacheRoot);
  result.cargoHome = selectedHome(layout, await readSelection(layout));
  if (!(await exists(result.cargoHome))) return result;
  await assertCargoHome(result.cargoHome);
  result.exists = true;
  const sourceRoot = join(result.cargoHome, 'registry', 'src');
  if (!(await isRealDirectory(sourceRoot))) return result;
  const deadline = Date.now() + SCAN_DEADLINE_MS;
  let entries = 0;
  const atLimit = () => {
    signal?.throwIfAborted();
    const limited =
      entries >= MAX_SCAN_ENTRIES ||
      result.missingManifests.length + result.inspectionErrors.length >= MAX_SCAN_ISSUES ||
      Date.now() >= deadline;
    if (limited) result.truncated = true;
    return limited;
  };
  const registries = await opendir(sourceRoot);
  for await (const registry of registries) {
    if (atLimit()) break;
    entries += 1;
    if (!registry.isDirectory()) continue;
    const registryPath = join(sourceRoot, registry.name);
    if (!(await isRealDirectory(registryPath))) continue;
    const packages = await opendir(registryPath);
    for await (const entry of packages) {
      if (atLimit()) break;
      entries += 1;
      if (!entry.isDirectory()) continue;
      const relativePath = `registry/src/${registry.name}/${entry.name}`;
      const packagePath = join(registryPath, entry.name);
      if (!(await isRealDirectory(packagePath))) continue;
      result.scannedPackages += 1;
      try {
        let marker: unknown;
        const checked = await readCheckedFile(join(packagePath, '.cargo-ok'), 128);
        try {
          marker = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(checked.bytes));
        } catch {
          // Cargo can re-extract an interrupted or unrecognized marker itself.
          continue;
        }
        if (typeof marker !== 'object' || marker === null || !('v' in marker) || marker.v !== 1)
          continue;
        result.completedExtractions += 1;
        try {
          const manifest = await lstat(join(packagePath, 'Cargo.toml'));
          if (!manifest.isFile() || manifest.nlink !== 1) {
            result.inspectionErrors.push({
              path: `${relativePath}/Cargo.toml`,
              code: 'PATH_NOT_FILE',
            });
          }
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
          result.missingManifests.push(`${relativePath}/Cargo.toml`);
        }
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        result.inspectionErrors.push({
          path: relativePath,
          code: errorCode(error) ?? 'INSPECTION_FAILED',
        });
      }
    }
    if (atLimit()) break;
  }
  return result;
}
