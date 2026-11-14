import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';

import {
  ChatSpliceError,
  isWithinOrEqualRoot,
  readCheckedFile,
  resolveExistingWorkspacePath,
  resolveNewWorkspacePath,
} from '@chatsplice/core';
import type { WorkspaceService } from '@chatsplice/core';
import { ProjectEnvironmentResultSchema } from '@chatsplice/protocol';
import type { ProjectExecInput, ProjectEnvironmentResult } from '@chatsplice/protocol';

const FILES = [
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'requirements.txt',
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'uv.lock',
  'requirements.lock',
  'go.mod',
  'go.sum',
  'go.work',
  'go.work.sum',
  'mix.exs',
  'mix.lock',
] as const;
const TOOLS = [
  'node',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'cargo',
  'rustc',
  'python3',
  'uv',
  'python',
  'pip3',
  'go',
  'elixir',
  'erl',
  'mix',
  'sh',
  'bash',
] as const;
const LOCKS = {
  pnpm: ['pnpm-lock.yaml'],
  npm: ['package-lock.json', 'npm-shrinkwrap.json'],
  yarn: ['yarn.lock'],
  bun: ['bun.lock', 'bun.lockb'],
} as const;
type FileState = ProjectEnvironmentResult['files'][number]['state'];
type Manager = keyof typeof LOCKS;
const require = createRequire(import.meta.url);

function checkAbort(signal: AbortSignal): void {
  signal.throwIfAborted();
}
function fileError(error: unknown): FileState {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR'
    ? 'missing'
    : code === 'EACCES' || code === 'EPERM'
      ? 'unreadable'
      : 'invalid';
}

async function entryState(
  service: WorkspaceService,
  input: ProjectExecInput,
  path: string,
): Promise<FileState> {
  try {
    // Validate the real parent, then inspect the leaf without following links.
    // The existing-path resolver converts a missing leaf into BAD_REQUEST.
    const { targetPath } = await resolveNewWorkspacePath(
      service,
      input.workspace_id,
      path,
      'environment inspection',
    );
    const metadata = await lstat(targetPath);
    return metadata.isFile() && metadata.nlink === 1 ? 'present' : 'invalid';
  } catch (error) {
    return fileError(error);
  }
}

async function toolState(
  name: string,
  paths: string[],
  root: string,
  signal: AbortSignal,
): Promise<'found' | 'missing' | 'unreadable'> {
  let unreadable = false;
  for (const directory of paths) {
    checkAbort(signal);
    if (!isAbsolute(directory) || isWithinOrEqualRoot(root, directory)) continue;
    try {
      const path = join(directory, name);
      if (!(await stat(path)).isFile()) continue;
      await access(path, constants.X_OK);
      return 'found';
    } catch (error) {
      unreadable ||= ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '');
    }
  }
  return unreadable ? 'unreadable' : 'missing';
}

/** Uses the pinned public installer dry-run; never installs or launches a browser. */
export async function inspectManagedBrowser(
  signal: AbortSignal,
): Promise<ProjectEnvironmentResult['browser']> {
  checkAbort(signal);
  const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cli, 'install', '--dry-run', 'chromium', '--only-shell'],
      {
        env: {
          HOME: homedir(),
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          TMPDIR: tmpdir(),
          PLAYWRIGHT_SKIP_BROWSER_GC: '1',
          ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
          ...(process.env.PLAYWRIGHT_BROWSERS_PATH === undefined
            ? {}
            : { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }),
        },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    let text = '';
    let failed = false;
    const stop = () => {
      failed = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(stop, 3000);
    signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
      if (Buffer.byteLength(text) > 32768) stop();
    });
    child.on('error', () => {
      failed = true;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      if (signal.aborted) reject(signal.reason);
      else resolve(failed || code !== 0 ? '' : text);
    });
    if (signal.aborted) stop();
  });
  const locations = [...output.matchAll(/^\s+Install location:\s+(.+)$/gm)].map((match) =>
    match[1]!.trim(),
  );
  if (locations.length !== 2) return { state: 'not_checked', launch_verified: false };
  let state: ProjectEnvironmentResult['browser']['state'] = 'cache_present';
  for (const location of locations) {
    checkAbort(signal);
    try {
      if (!(await stat(location)).isDirectory()) state = 'missing';
      await access(location, constants.R_OK | constants.X_OK);
    } catch (error) {
      const inaccessible = ['EACCES', 'EPERM'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      );
      if (inaccessible) return { state: 'unreadable', launch_verified: false };
      state = 'missing';
    }
  }
  return { state, launch_verified: false };
}

export async function inspectProjectEnvironment(
  service: WorkspaceService,
  input: ProjectExecInput,
  options: {
    signal: AbortSignal;
    browserProbe?: (signal: AbortSignal) => Promise<ProjectEnvironmentResult['browser']>;
    searchPath?: string;
  },
): Promise<ProjectEnvironmentResult> {
  checkAbort(options.signal);
  if (input.cwd !== '.' && input.cwd.split('/').length > 31)
    throw new ChatSpliceError(
      'BAD_REQUEST',
      'Environment inspection supports at most 31 cwd levels.',
    );
  const { canonicalRoot, canonicalTarget: cwd } = await resolveExistingWorkspacePath(
    service,
    input.workspace_id,
    input.cwd,
    'environment cwd',
  );
  if (!(await stat(cwd)).isDirectory())
    throw new ChatSpliceError('BAD_REQUEST', 'Environment cwd must be a directory.');
  const prefix = (name: string) => (input.cwd === '.' ? name : `${input.cwd}/${name}`);
  const files: ProjectEnvironmentResult['files'] = [];
  for (const name of FILES) {
    checkAbort(options.signal);
    files.push({ path: prefix(name), state: await entryState(service, input, prefix(name)) });
  }
  const node: ProjectEnvironmentResult['node'] = {
    package_manager: null,
    selection: 'not_applicable',
    lockfile_path: null,
    scripts: [],
    scripts_truncated: false,
  };
  const manifest = files[0]!;
  if (manifest.state === 'present') {
    try {
      const { bytes } = await readCheckedFile(join(cwd, 'package.json'), 65536);
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Invalid manifest.');
      const record = parsed as Record<string, unknown>;
      const manager =
        typeof record.packageManager === 'string'
          ? (record.packageManager.split('@')[0] ?? '')
          : '';
      if (Object.hasOwn(LOCKS, manager)) {
        node.package_manager = manager as Manager;
        node.selection = 'declared';
      }
      const scripts = record.scripts;
      if (scripts !== null && typeof scripts === 'object' && !Array.isArray(scripts)) {
        const names = Object.entries(scripts)
          .filter(
            ([name, value]) =>
              /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/.test(name) && typeof value === 'string',
          )
          .map(([name]) => name)
          .sort();
        node.scripts = names.slice(0, 32);
        node.scripts_truncated = names.length > 32;
      }
    } catch (error) {
      manifest.state =
        error instanceof ChatSpliceError &&
        error.message === 'The file exceeds the bounded source limit.'
          ? 'too_large'
          : fileError(error);
    }
    if (manifest.state === 'present') {
      let current = cwd;
      for (let depth = 0; depth < 32; depth += 1) {
        checkAbort(options.signal);
        const managers =
          node.package_manager === null
            ? (Object.keys(LOCKS) as Manager[])
            : [node.package_manager];
        for (const manager of managers) {
          for (const name of LOCKS[manager]) {
            const path = relative(canonicalRoot, join(current, name)).split('\\').join('/');
            if ((await entryState(service, input, path)) === 'present') {
              node.package_manager ??= manager;
              if (node.selection !== 'declared') node.selection = 'lockfile';
              node.lockfile_path = path;
              break;
            }
          }
          if (node.lockfile_path !== null) break;
        }
        if (node.lockfile_path !== null || current === canonicalRoot) break;
        current = dirname(current);
      }
      if (node.package_manager === null) {
        node.package_manager = 'npm';
        node.selection = 'default';
      }
    }
  }
  const allPaths = [
    ...new Set((options.searchPath ?? process.env.PATH ?? '/usr/bin:/bin').split(delimiter)),
  ];
  const tools: ProjectEnvironmentResult['tools'] = [];
  for (const name of TOOLS)
    tools.push({
      name,
      state: await toolState(name, allPaths.slice(0, 64), canonicalRoot, options.signal),
    });
  const browser = await (options.browserProbe ?? inspectManagedBrowser)(options.signal);
  const issues = new Set<ProjectEnvironmentResult['issues'][number]>();
  if (files.slice(0, 4).some((file) => !['present', 'missing'].includes(file.state)))
    issues.add('manifest_invalid');
  if (node.package_manager !== null) {
    if (node.lockfile_path === null) issues.add('lockfile_missing');
    if (tools.find((tool) => tool.name === node.package_manager)?.state !== 'found')
      issues.add('package_manager_missing');
    if (
      node.package_manager !== 'bun' &&
      tools.find((tool) => tool.name === 'node')?.state !== 'found'
    )
      issues.add('runtime_missing');
  }
  if (files[1]!.state === 'present') {
    if (
      tools.find((tool) => tool.name === 'cargo')?.state !== 'found' ||
      tools.find((tool) => tool.name === 'rustc')?.state !== 'found'
    )
      issues.add('runtime_missing');
    if (files.find((file) => file.path === prefix('Cargo.lock'))?.state !== 'present')
      issues.add('lockfile_missing');
  }
  if (
    files.slice(2, 4).some((file) => file.state === 'present') &&
    tools.find((tool) => tool.name === 'python3')?.state !== 'found'
  )
    issues.add('runtime_missing');
  const present = (name: string) =>
    files.some((file) => file.path === prefix(name) && file.state === 'present');
  if (
    (present('go.mod') || present('go.work')) &&
    tools.find((tool) => tool.name === 'go')?.state !== 'found'
  )
    issues.add('runtime_missing');
  if (
    present('mix.exs') &&
    ['elixir', 'erl', 'mix'].some(
      (name) => tools.find((tool) => tool.name === name)?.state !== 'found',
    )
  )
    issues.add('runtime_missing');
  // These are presence checks only: a Go module need not have go.sum and
  // a dependency-free Mix project need not have mix.lock.
  if (
    ['go.mod', 'go.work', 'mix.exs'].some((name) =>
      files.some(
        (file) => file.path === prefix(name) && !['present', 'missing'].includes(file.state),
      ),
    )
  )
    issues.add('manifest_invalid');
  if (browser.state === 'missing') issues.add('browser_missing');
  if (browser.state === 'unreadable') issues.add('browser_unreadable');
  checkAbort(options.signal);
  return ProjectEnvironmentResultSchema.parse({
    cwd: input.cwd,
    inspected_at: new Date().toISOString(),
    files,
    node,
    tools,
    path_scan_truncated: allPaths.length > 64,
    browser,
    issues: [...issues],
  });
}
