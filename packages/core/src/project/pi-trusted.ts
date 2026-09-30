import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { ProjectExecInput } from '@chatsplice/protocol';
import { parseDocument } from 'yaml';

import { ChatSpliceError } from '../errors.js';
import type { WorkspaceService } from '../workspace/service.js';
import {
  isWithinOrEqualRoot,
  isWorkspacePathDenied,
  validateWorkspaceRelativePath,
} from '../fs/path-policy.js';

import type { Manifest, PackageManager, TrustedExecutable } from './pi-types.js';

export const MAX_MANIFEST_BYTES = 1024 * 1024;
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 19;
const MAX_PNPM_CONFIG_ALIAS_COUNT = 32;
const MAX_PNPM_CONFIG_NODES = 4_096;
const CARGO_CACHE_DIRECTORY_NAME = 'chatsplice-cargo-cache';
export function badRequest(message: string): never {
  throw new ChatSpliceError('BAD_REQUEST', message);
}

export function pathError(message: string): never {
  throw new ChatSpliceError('PATH_OUTSIDE_WORKSPACE', message);
}

export function secretError(message: string): never {
  throw new ChatSpliceError('SECRET_PATH_DENIED', message);
}

export function packageManagerFromManifest(value: unknown): PackageManager | null {
  if (typeof value !== 'string') return null;
  const manager = value.split('@')[0];
  return manager === 'pnpm' || manager === 'npm' || manager === 'yarn' || manager === 'bun'
    ? manager
    : null;
}

export function isTrustedExecutableMode(mode: number): boolean {
  return (mode & 0o022) === 0;
}

export async function fileIsRegular(
  path: string,
  label: string,
  maximumBytes?: number,
): Promise<void> {
  const metadata = await lstat(path).catch(() => badRequest(`${label} was not found.`));
  if (!metadata.isFile() || metadata.nlink !== 1) {
    badRequest(`${label} must be a regular, single-link file.`);
  }
  if (maximumBytes !== undefined && metadata.size > maximumBytes) {
    badRequest(`${label} exceeds the bounded file-size limit.`);
  }
  const canonical = await realpath(path).catch(() => badRequest(`${label} could not be resolved.`));
  if (canonical !== path) {
    pathError(`${label} may not be a symbolic link.`);
  }
}

export async function regularFileExists(path: string, label: string): Promise<boolean> {
  try {
    await fileIsRegular(path, label);
    return true;
  } catch (error) {
    if (error instanceof ChatSpliceError && error.message.endsWith('was not found.')) return false;
    throw error;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  return regularFileExists(path, path);
}

export async function directoryIsCanonical(path: string, label: string): Promise<void> {
  const metadata = await lstat(path).catch(() => badRequest(`${label} was not found.`));
  if (!metadata.isDirectory()) badRequest(`${label} must be a directory.`);
  const canonical = await realpath(path).catch(() => pathError(`${label} could not be resolved.`));
  if (canonical !== path) pathError(`${label} may not be a symbolic link.`);
}

export async function readManifest(path: string): Promise<Manifest> {
  await fileIsRegular(path, 'package.json', MAX_MANIFEST_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    badRequest('package.json is not valid UTF-8 JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    badRequest('package.json must contain a JSON object.');
  }
  return parsed as Manifest;
}

export async function resolveExistingCwd(
  workspaceService: WorkspaceService,
  input: ProjectExecInput,
): Promise<{ canonicalRoot: string; cwd: string }> {
  if (isAbsolute(input.cwd) || input.cwd.includes('\0')) {
    pathError('project.exec cwd must be a relative path inside the selected workspace.');
  }
  validateWorkspaceRelativePath(input.cwd, 'project.exec cwd');
  const workspace = workspaceService.getRecord(input.workspace_id);
  const canonicalRoot = await realpath(workspace.rootPath).catch(() =>
    pathError('The registered workspace root could not be resolved.'),
  );
  if (canonicalRoot !== workspace.rootPath) {
    pathError('The registered workspace root changed.');
  }
  const requestedCwd = resolve(canonicalRoot, input.cwd);
  const canonicalCwd = await realpath(requestedCwd).catch(() =>
    pathError('project.exec cwd does not exist inside the workspace.'),
  );
  if (!isWithinOrEqualRoot(canonicalRoot, canonicalCwd)) {
    pathError('project.exec cwd escapes the registered workspace.');
  }
  if (canonicalCwd !== requestedCwd) {
    pathError('project.exec cwd may not traverse a symbolic link.');
  }
  const relativeCwd = relative(canonicalRoot, canonicalCwd);
  if (isWorkspacePathDenied(relativeCwd)) {
    secretError('project.exec cwd matches the default secret or control path policy.');
  }
  await directoryIsCanonical(canonicalCwd, 'project.exec cwd');
  return { canonicalRoot, cwd: canonicalCwd };
}

export async function resolveTrustedExecutable(
  executable: string,
  workspaceRoot: string,
): Promise<TrustedExecutable> {
  const operatorUid = process.getuid?.();
  if (operatorUid === undefined) badRequest('ChatSplice could not verify executable ownership.');
  const candidateMetadata = await lstat(executable).catch(() =>
    badRequest(`Trusted executable '${executable}' was not found.`),
  );
  const resolved = await realpath(executable).catch(() =>
    badRequest(`Trusted executable '${executable}' could not be resolved.`),
  );
  const resolvedMetadata = await stat(resolved).catch(() =>
    badRequest(`Trusted executable '${executable}' could not be inspected.`),
  );
  const ownerAllowed = (uid: number): boolean => uid === 0 || uid === operatorUid;
  if (
    (!candidateMetadata.isFile() && !candidateMetadata.isSymbolicLink()) ||
    !resolvedMetadata.isFile() ||
    !ownerAllowed(candidateMetadata.uid) ||
    !ownerAllowed(resolvedMetadata.uid) ||
    !isTrustedExecutableMode(candidateMetadata.mode) ||
    !isTrustedExecutableMode(resolvedMetadata.mode) ||
    isWithinOrEqualRoot(workspaceRoot, executable) ||
    isWithinOrEqualRoot(workspaceRoot, resolved)
  ) {
    badRequest(
      `The trusted executable '${executable}' failed the ownership or workspace-boundary check.`,
    );
  }
  await access(resolved, constants.X_OK).catch(() =>
    badRequest(`Trusted executable '${executable}' is not executable.`),
  );
  const packageRoot = dirname(dirname(resolved));
  const canonicalHome = await realpath(homedir()).catch(() => homedir());
  const broadUserRoots = [
    'Library',
    'Library/Application Support',
    'Library/Caches',
    'Documents',
    'Desktop',
    'Downloads',
    'Pictures',
    'Movies',
    'Music',
  ].map((name) => join(canonicalHome, name));
  if (
    packageRoot === '/' ||
    isWithinOrEqualRoot(packageRoot, canonicalHome) ||
    broadUserRoots.includes(packageRoot) ||
    isWithinOrEqualRoot(packageRoot, workspaceRoot)
  ) {
    badRequest(`The trusted executable '${executable}' has an unsafe sandbox read boundary.`);
  }
  return { path: resolved, root: packageRoot };
}

export async function resolveTrustedSearchDirectory(
  directory: string,
  workspaceRoot: string,
): Promise<string> {
  const operatorUid = process.getuid?.();
  if (operatorUid === undefined) {
    badRequest('ChatSplice could not verify executable-directory ownership.');
  }
  const metadata = await lstat(directory).catch(() =>
    badRequest(`Trusted executable directory '${directory}' was not found.`),
  );
  const canonical = await realpath(directory).catch(() =>
    badRequest(`Trusted executable directory '${directory}' could not be resolved.`),
  );
  const ownerAllowed = (uid: number): boolean => uid === 0 || uid === operatorUid;
  if (
    !metadata.isDirectory() ||
    canonical !== directory ||
    !ownerAllowed(metadata.uid) ||
    !isTrustedExecutableMode(metadata.mode) ||
    isWithinOrEqualRoot(workspaceRoot, canonical)
  ) {
    badRequest(`The trusted executable directory '${directory}' failed its boundary check.`);
  }
  return canonical;
}

export async function resolveTrustedPathFromPath(
  executableName: string,
  workspaceRoot: string,
): Promise<TrustedExecutable> {
  const candidates = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(isAbsolute)
    .map((directory) => join(directory, executableName));
  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      // Homebrew also exposes Cargo through a rustup-init alias. Both proxies
      // require external rustup state; resolve a real toolchain binary instead.
      if (executableName === 'cargo' && ['rustup', 'rustup-init'].includes(basename(resolved))) {
        continue;
      }
      const executable = await resolveTrustedExecutable(candidate, workspaceRoot);
      const searchDirectory = await resolveTrustedSearchDirectory(
        dirname(candidate),
        workspaceRoot,
      );
      return { ...executable, searchDirectory };
    } catch {
      // Continue to the next absolute PATH entry.
    }
  }
  badRequest(`A trusted ${executableName} executable was not found on ChatSplice's PATH.`);
}

export async function resolveTrustedCargo(workspaceRoot: string): Promise<TrustedExecutable> {
  try {
    return await resolveTrustedPathFromPath('cargo', workspaceRoot);
  } catch {
    // On rustup installations PATH cargo is commonly a rustup proxy. Search
    // only real toolchain binaries, never a proxy or an arbitrary executable.
  }
  const rustupToolchains = join(homedir(), '.rustup', 'toolchains');
  const entries = await readdir(rustupToolchains, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const candidate = join(rustupToolchains, entry.name, 'bin', 'cargo');
    try {
      const resolved = await realpath(candidate);
      if (basename(resolved) !== 'cargo') continue;
      const executable = await resolveTrustedExecutable(candidate, workspaceRoot);
      const rustc = join(executable.root, 'bin', 'rustc');
      await resolveTrustedExecutable(rustc, workspaceRoot);
      return executable;
    } catch {
      // Try the next installed, trusted toolchain.
    }
  }
  badRequest('A trusted real Rust toolchain executable was not found.');
}

export async function resolvePackageManager(
  cwd: string,
  workspaceRoot: string,
  manifestValue: unknown,
): Promise<PackageManager> {
  const declared = packageManagerFromManifest(manifestValue);
  if (declared !== null) return declared;
  const lockNames: readonly [PackageManager, string[]][] = [
    ['pnpm', ['pnpm-lock.yaml']],
    ['npm', ['package-lock.json', 'npm-shrinkwrap.json']],
    ['yarn', ['yarn.lock']],
    ['bun', ['bun.lock', 'bun.lockb']],
  ];
  let current = cwd;
  while (isWithinOrEqualRoot(workspaceRoot, current)) {
    for (const [manager, names] of lockNames) {
      for (const name of names) {
        if (await fileExists(join(current, name))) return manager;
      }
    }
    if (current === workspaceRoot) break;
    current = dirname(current);
  }
  return 'npm';
}

export async function hasLockfile(
  cwd: string,
  workspaceRoot: string,
  manager: PackageManager,
): Promise<boolean> {
  const names: Record<PackageManager, readonly string[]> = {
    pnpm: ['pnpm-lock.yaml'],
    npm: ['package-lock.json', 'npm-shrinkwrap.json'],
    yarn: ['yarn.lock'],
    bun: ['bun.lock', 'bun.lockb'],
  };
  let current = cwd;
  while (isWithinOrEqualRoot(workspaceRoot, current)) {
    for (const name of names[manager]) {
      if (await fileExists(join(current, name))) return true;
    }
    if (current === workspaceRoot) break;
    current = dirname(current);
  }
  return false;
}

export async function hasCargoLockfile(cwd: string, workspaceRoot: string): Promise<boolean> {
  let current = cwd;
  while (isWithinOrEqualRoot(workspaceRoot, current)) {
    if (await fileExists(join(current, 'Cargo.lock'))) return true;
    if (current === workspaceRoot) break;
    current = dirname(current);
  }
  return false;
}

export function containsPnpmManagedRuntime(value: unknown): boolean {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const visited = new WeakSet<object>();
  let inspectedNodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    inspectedNodes += 1;
    if (inspectedNodes > MAX_PNPM_CONFIG_NODES || current.depth > 128) {
      badRequest('pnpm workspace configuration is too complex to inspect safely.');
    }
    if (current.value === null || typeof current.value !== 'object') continue;
    if (visited.has(current.value)) continue;
    visited.add(current.value);
    for (const [key, nested] of Object.entries(current.value)) {
      const normalizedKey = key.replaceAll(/[-_]/gu, '').toLowerCase();
      if (normalizedKey === 'usenodeversion' || normalizedKey === 'executionenv') return true;
      pending.push({ value: nested, depth: current.depth + 1 });
    }
  }
  return false;
}

export function rejectPnpmManagedRuntimeYaml(contents: string, fileName: string): void {
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(contents, { version: '1.2' });
  } catch {
    badRequest(`${fileName} is not valid YAML.`);
  }
  if (document.errors.length > 0) badRequest(`${fileName} is not valid YAML.`);
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: MAX_PNPM_CONFIG_ALIAS_COUNT });
  } catch {
    badRequest(`${fileName} contains an unsafe YAML alias expansion.`);
  }
  if (containsPnpmManagedRuntime(value)) {
    badRequest('pnpm-managed Node runtime downloads are not permitted for project.exec.');
  }
}

export async function rejectPnpmRuntimeConfiguration(
  cwd: string,
  workspaceRoot: string,
  manifest: Manifest,
): Promise<void> {
  if (manifest.pnpm !== null && typeof manifest.pnpm === 'object' && manifest.pnpm !== undefined) {
    const hasExecutionEnv = Object.keys(manifest.pnpm).some(
      (key) => key.replaceAll(/[-_]/gu, '').toLowerCase() === 'executionenv',
    );
    if (hasExecutionEnv) {
      badRequest('pnpm executionEnv runtime downloads are not permitted for project.exec.');
    }
  }
  let current = cwd;
  while (isWithinOrEqualRoot(workspaceRoot, current)) {
    for (const fileName of ['pnpm-workspace.yaml', 'pnpm-workspace.yml'] as const) {
      const workspaceConfigPath = join(current, fileName);
      try {
        await access(workspaceConfigPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        badRequest('pnpm workspace configuration could not be inspected safely.');
      }
      await fileIsRegular(workspaceConfigPath, fileName, MAX_MANIFEST_BYTES);
      rejectPnpmManagedRuntimeYaml(await readFile(workspaceConfigPath, 'utf8'), fileName);
    }
    if (current === workspaceRoot) break;
    current = dirname(current);
  }
}

export async function rejectCargoConfiguration(cwd: string, workspaceRoot: string): Promise<void> {
  let current = cwd;
  while (isWithinOrEqualRoot(workspaceRoot, current)) {
    const cargoDirectory = join(current, '.cargo');
    let cargoDirectoryMetadata: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      cargoDirectoryMetadata = await lstat(cargoDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        badRequest('Cargo configuration could not be inspected safely.');
      }
    }
    if (cargoDirectoryMetadata !== undefined) {
      if (!cargoDirectoryMetadata.isDirectory()) {
        badRequest('The workspace .cargo path must be a directory.');
      }
      const canonicalCargoDirectory = await realpath(cargoDirectory).catch(() =>
        pathError('The workspace .cargo path could not be resolved safely.'),
      );
      if (canonicalCargoDirectory !== cargoDirectory) {
        pathError('The workspace .cargo path may not be a symbolic link.');
      }
      for (const fileName of [
        'config',
        'config.toml',
        'credentials',
        'credentials.toml',
      ] as const) {
        let metadata: Awaited<ReturnType<typeof lstat>> | undefined;
        try {
          metadata = await lstat(join(cargoDirectory, fileName));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            badRequest('Cargo configuration could not be inspected safely.');
          }
        }
        if (metadata !== undefined) {
          badRequest('Workspace Cargo configuration and credentials are not permitted.');
        }
      }
    }
    if (current === workspaceRoot) break;
    current = dirname(current);
  }
}

export async function prepareCargoHome(workspaceRoot: string): Promise<string> {
  const canonicalTemporaryDirectory = await realpath(tmpdir()).catch(() =>
    badRequest('Cargo cache parent could not be resolved.'),
  );
  const cacheRootPath = join(canonicalTemporaryDirectory, CARGO_CACHE_DIRECTORY_NAME);
  await mkdir(cacheRootPath, { recursive: true, mode: 0o700 });
  const cacheRoot = await realpath(cacheRootPath).catch(() =>
    badRequest('Cargo cache could not be resolved.'),
  );
  if (cacheRoot !== cacheRootPath) pathError('Cargo cache may not traverse a symbolic link.');
  const operatorUid = process.getuid?.();
  const cacheRootMetadata = await lstat(cacheRoot).catch(() =>
    badRequest('Cargo cache could not be inspected.'),
  );
  if (
    operatorUid === undefined ||
    !cacheRootMetadata.isDirectory() ||
    cacheRootMetadata.uid !== operatorUid ||
    (cacheRootMetadata.mode & 0o077) !== 0
  ) {
    badRequest('Cargo cache is not a private directory owned by the current user.');
  }
  const cacheKey = createHash('sha256').update(workspaceRoot).digest('hex');
  const cargoHome = join(cacheRoot, cacheKey);
  await mkdir(cargoHome, { recursive: true, mode: 0o700 });
  const canonical = await realpath(cargoHome).catch(() =>
    badRequest('Cargo cache could not be resolved.'),
  );
  if (canonical !== cargoHome) pathError('Cargo cache may not traverse a symbolic link.');
  const metadata = await lstat(canonical).catch(() =>
    badRequest('Cargo cache could not be inspected.'),
  );
  if (operatorUid === undefined || metadata.uid !== operatorUid || (metadata.mode & 0o077) !== 0) {
    badRequest('Cargo cache is not a private directory owned by the current user.');
  }
  for (const fileName of [
    'config',
    'config.toml',
    'credentials',
    'credentials.toml',
    'credentials.toml.enc',
  ]) {
    const entry = await lstat(join(canonical, fileName)).catch(() => undefined);
    if (entry !== undefined) {
      badRequest('Cargo cache configuration and credentials are not permitted.');
    }
  }
  return canonical;
}

export async function resolveCorepackCache(): Promise<string> {
  // COREPACK_HOME is the directory containing Corepack's versioned v1 cache;
  // pointing it at v1 makes Corepack look for (and try to create) v1/v1.
  const configured = join(homedir(), '.cache', 'node', 'corepack');
  return realpath(configured).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return configured;
    throw new ChatSpliceError(
      'BAD_REQUEST',
      'The configured Corepack cache could not be resolved safely.',
    );
  });
}

export function nodeRuntimeVersionSupported(): boolean {
  const [majorText, minorText] = process.versions.node.split('.');
  const major = Number(majorText);
  const minor = Number(minorText);
  return (
    Number.isInteger(major) &&
    Number.isInteger(minor) &&
    (major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR))
  );
}
