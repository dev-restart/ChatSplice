import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

import type { ProjectRunInput, ProjectRunResult } from '@chatsplice/protocol';

import { ChatSpliceError } from '../errors.js';
import { isWithinOrEqualRoot } from '../fs/path-policy.js';
import { BoundedOutputCapture, terminateProcessGroup } from '../process/bounded-output.js';
import type { WorkspaceService } from '../workspace/service.js';

const SANDBOX_EXECUTABLE = '/usr/bin/sandbox-exec';
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 96 * 1024;
const TERMINATE_GRACE_MS = 1_000;
const SANDBOX_PROFILE = [
  '(version 1)',
  '(allow default)',
  '(deny network*)',
  '(deny file-write*)',
  '(allow file-write*',
  '  (subpath (param "WORKSPACE"))',
  '  (subpath (param "RUNTIME")))',
  '(deny file-read-data file-map-executable)',
  '(allow file-read-data file-map-executable',
  '  (subpath (param "WORKSPACE"))',
  '  (subpath (param "RUNTIME"))',
  '  (subpath (param "PACKAGE_MANAGER_ROOT"))',
  '  (subpath (param "NODE_RUNTIME_ROOT"))',
  '  (subpath (param "COREPACK_CACHE"))',
  '  (subpath "/Library/Apple")',
  '  (subpath "/System")',
  '  (subpath "/usr/bin")',
  '  (subpath "/usr/lib")',
  '  (subpath "/usr/share")',
  '  (subpath "/bin")',
  '  (subpath "/sbin")',
  '  (subpath "/private/var/db/timezone")',
  '  (literal "/private/etc/localtime")',
  '  (literal "/private/etc/master.passwd")',
  '  (literal "/private/etc/passwd")',
  '  (literal "/private/etc/protocols")',
  '  (literal "/private/etc/services")',
  '  (literal "/")',
  '  (literal "/dev/null")',
  '  (literal "/dev/random")',
  '  (literal "/dev/urandom")',
  '  (literal "/dev/zero")',
  '  (subpath "/dev/fd"))',
  '(deny file-read-data file-map-executable file-write*',
  '  (regex (string-append "^" (regex-quote (param "WORKSPACE")) #"/([^/]+/)*([.][gG][iI][tT]|[.][sS][sS][hH]|[.][cC][oO][dD][eE][xX]|[.][lL][oO][cC][aA][lL][cC][hH][aA][tT]|[.][cC][hH][aA][tT][sS][pP][lL][iI][cC][eE]|[.][pP][iI])(/|$)"))',
  '  (regex (string-append "^" (regex-quote (param "WORKSPACE")) #"/([^/]+/)*([.][eE][nN][vV]([.][^/]*|[rR][cC])?|[.][gG][iI][tT]-[cC][rR][eE][dD][eE][nN][tT][iI][aA][lL][sS]|[.][nN][pP][mM][rR][cC]|[.][pP][yY][pP][iI][rR][cC]|[iI][dD]_[eE][dD]25519|[iI][dD]_[rR][sS][aA])(/|$)"))',
  '  (regex (string-append "^" (regex-quote (param "WORKSPACE")) #"/([^/]+/)*[^/]*([.][kK][eE][yY]|[.][pP]12|[.][pP][eE][mM]|[.][pP][fF][xX])(/|$)"))',
  '  (subpath (param "USER_SSH"))',
  '  (subpath (param "USER_GNUPG"))',
  '  (subpath (param "USER_AWS"))',
  '  (subpath (param "USER_CODEX"))',
  '  (subpath (param "USER_PI"))',
  '  (subpath (param "USER_CHATSPLICE"))',
  '  (subpath (param "WORKSPACE_GIT"))',
  '  (subpath (param "WORKSPACE_SSH"))',
  '  (subpath (param "WORKSPACE_ENV"))',
  '  (subpath (param "WORKSPACE_NPMRC")))',
].join('\n');

type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

function packageManagerFromManifest(value: unknown): PackageManager | null {
  if (typeof value !== 'string') return null;
  const manager = value.split('@')[0];
  return manager === 'pnpm' || manager === 'npm' || manager === 'yarn' || manager === 'bun'
    ? manager
    : null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function resolvePackageManager(
  rootPath: string,
  manifestValue: unknown,
): Promise<PackageManager> {
  const declared = packageManagerFromManifest(manifestValue);
  if (declared !== null) return declared;
  if (await fileExists(join(rootPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await fileExists(join(rootPath, 'yarn.lock'))) return 'yarn';
  if (
    (await fileExists(join(rootPath, 'bun.lock'))) ||
    (await fileExists(join(rootPath, 'bun.lockb')))
  ) {
    return 'bun';
  }
  return 'npm';
}

function safeEnvironment(
  runtimeDirectory: string,
  executablePath: string,
  corepackCache: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: runtimeDirectory,
    TMPDIR: runtimeDirectory,
    COREPACK_HOME: corepackCache,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    COREPACK_ENABLE_NETWORK: '0',
    CI: '1',
    NO_COLOR: '1',
    PATH: [
      ...new Set([dirname(executablePath), dirname(process.execPath), '/usr/bin', '/bin']),
    ].join(delimiter),
  };
  for (const key of ['LANG', 'LC_ALL', 'TERM'] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function isTrustedExecutableMode(mode: number): boolean {
  return (mode & 0o022) === 0;
}

async function resolveTrustedPackageManagerExecutable(
  manager: PackageManager,
  workspaceRoot: string,
): Promise<string> {
  const operatorUid = process.getuid?.();
  if (operatorUid === undefined) {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      'ChatSplice could not verify the package-manager owner.',
    );
  }
  for (const directory of process.env.PATH?.split(delimiter) ?? []) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, manager);
    try {
      await access(candidate, constants.X_OK);
      const candidateMetadata = await lstat(candidate);
      const resolved = await realpath(candidate);
      const resolvedMetadata = await stat(resolved);
      const ownerAllowed = (uid: number): boolean => uid === 0 || uid === operatorUid;
      if (
        (!candidateMetadata.isFile() && !candidateMetadata.isSymbolicLink()) ||
        !resolvedMetadata.isFile() ||
        !ownerAllowed(candidateMetadata.uid) ||
        !ownerAllowed(resolvedMetadata.uid) ||
        !isTrustedExecutableMode(candidateMetadata.mode) ||
        !isTrustedExecutableMode(resolvedMetadata.mode) ||
        isWithinOrEqualRoot(workspaceRoot, candidate) ||
        isWithinOrEqualRoot(workspaceRoot, resolved)
      ) {
        continue;
      }
      return resolved;
    } catch {
      // Try the next absolute PATH entry.
    }
  }
  throw new ChatSpliceError(
    'BAD_REQUEST',
    `A trusted ${manager} executable was not found on ChatSplice's PATH.`,
  );
}

async function runWorkspaceProjectTaskUnlocked(
  workspaceService: WorkspaceService,
  input: ProjectRunInput,
): Promise<ProjectRunResult> {
  const workspace = workspaceService.getRecord(input.workspace_id);
  if (workspace.kind !== 'user') {
    throw new ChatSpliceError('BAD_REQUEST', 'project.run is available only for user workspaces.');
  }
  if (process.platform !== 'darwin') {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      'project.run currently requires the macOS sandbox-exec boundary.',
    );
  }
  await access(SANDBOX_EXECUTABLE, constants.X_OK).catch(() => {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      'The macOS sandbox-exec boundary required by project.run is unavailable.',
    );
  });

  const canonicalRoot = await realpath(workspace.rootPath);
  const packageJsonPath = join(canonicalRoot, 'package.json');
  const packageJsonStat = await stat(packageJsonPath).catch(() => {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      'project.run requires package.json at the workspace root.',
    );
  });
  if (!packageJsonStat.isFile() || packageJsonStat.size > MAX_PACKAGE_JSON_BYTES) {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      'The workspace package.json is not a bounded regular file.',
    );
  }

  let manifest: { packageManager?: unknown; scripts?: Record<string, unknown> };
  try {
    manifest = JSON.parse(await readFile(packageJsonPath, 'utf8')) as typeof manifest;
  } catch {
    throw new ChatSpliceError('BAD_REQUEST', 'The workspace package.json is not valid UTF-8 JSON.');
  }
  if (typeof manifest.scripts?.[input.task] !== 'string') {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      `package.json does not define the allowed ${input.task} script.`,
    );
  }

  const manager = await resolvePackageManager(canonicalRoot, manifest.packageManager);
  const managerExecutable = await resolveTrustedPackageManagerExecutable(manager, canonicalRoot);
  const commandArguments = ['run', input.task];
  const command = `${manager} run ${input.task}`;
  const runtimeDirectory = await realpath(await mkdtemp(join(tmpdir(), 'chatsplice-project-run-')));
  const userHome = homedir();
  const corepackCache = await realpath(join(userHome, '.cache', 'node', 'corepack', 'v1')).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return join(userHome, '.cache', 'node', 'corepack', 'v1');
      throw error;
    },
  );
  const packageManagerRoot = dirname(dirname(managerExecutable));
  const nodeRuntimeRoot = dirname(dirname(await realpath(process.execPath)));
  const startedAt = Date.now();
  const stdout = new BoundedOutputCapture(MAX_OUTPUT_BYTES);
  const stderr = new BoundedOutputCapture(MAX_OUTPUT_BYTES);
  let timedOut = false;

  try {
    const child = spawn(
      SANDBOX_EXECUTABLE,
      [
        '-D',
        `WORKSPACE=${canonicalRoot}`,
        '-D',
        `RUNTIME=${runtimeDirectory}`,
        '-D',
        `PACKAGE_MANAGER_ROOT=${packageManagerRoot}`,
        '-D',
        `NODE_RUNTIME_ROOT=${nodeRuntimeRoot}`,
        '-D',
        `COREPACK_CACHE=${corepackCache}`,
        '-D',
        `USER_SSH=${join(userHome, '.ssh')}`,
        '-D',
        `USER_GNUPG=${join(userHome, '.gnupg')}`,
        '-D',
        `USER_AWS=${join(userHome, '.aws')}`,
        '-D',
        `USER_CODEX=${join(userHome, '.codex')}`,
        '-D',
        `USER_PI=${join(userHome, '.pi')}`,
        '-D',
        `USER_CHATSPLICE=${join(userHome, '.chatsplice')}`,
        '-D',
        `WORKSPACE_GIT=${join(canonicalRoot, '.git')}`,
        '-D',
        `WORKSPACE_SSH=${join(canonicalRoot, '.ssh')}`,
        '-D',
        `WORKSPACE_ENV=${join(canonicalRoot, '.env')}`,
        '-D',
        `WORKSPACE_NPMRC=${join(canonicalRoot, '.npmrc')}`,
        '-p',
        SANDBOX_PROFILE,
        managerExecutable,
        ...commandArguments,
      ],
      {
        cwd: canonicalRoot,
        env: safeEnvironment(runtimeDirectory, managerExecutable, corepackCache),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.append(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.append(chunk);
    });

    const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          timedOut = true;
          terminateProcessGroup(child.pid, 'SIGTERM');
          setTimeout(() => terminateProcessGroup(child.pid, 'SIGKILL'), TERMINATE_GRACE_MS).unref();
        }, input.timeout_ms);
        timeout.unref();
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('close', (exitCode, signal) => {
          clearTimeout(timeout);
          resolve({ exitCode, signal });
        });
      },
    ).catch((error: NodeJS.ErrnoException) => {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        error.code === 'ENOENT'
          ? `The trusted ${manager} executable could not be started.`
          : 'The bounded project task could not be started.',
      );
    });

    return {
      workspace_id: input.workspace_id,
      workspace_name: workspace.display_name,
      task: input.task,
      command,
      exit_code: result.exitCode,
      signal: result.signal,
      timed_out: timedOut,
      duration_ms: Date.now() - startedAt,
      stdout: stdout.value,
      stderr: stderr.value,
      truncated: stdout.truncated || stderr.truncated,
    };
  } finally {
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
}

export function runWorkspaceProjectTask(
  workspaceService: WorkspaceService,
  input: ProjectRunInput,
): Promise<ProjectRunResult> {
  return workspaceService.withOperation(input.workspace_id, () =>
    runWorkspaceProjectTaskUnlocked(workspaceService, input),
  );
}
