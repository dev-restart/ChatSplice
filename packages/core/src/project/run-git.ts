import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

import {
  GIT_NETWORK_COMMANDS,
  ProjectGitInputSchema,
  type ProjectGitCommand,
  type ProjectGitInput,
  type ProjectGitResult,
} from '@chatsplice/protocol';

import { ChatSpliceError } from '../errors.js';
import { isWithinOrEqualRoot } from '../fs/path-policy.js';
import { BoundedOutputCapture, terminateProcessGroup } from '../process/bounded-output.js';
import type { WorkspaceService } from '../workspace/service.js';

const MAX_OUTPUT_BYTES = 96 * 1024;
const MAX_CONFIG_OUTPUT_BYTES = 32 * 1024;
const TERMINATE_GRACE_MS = 1_000;
const EXECUTABLE_CONFIG_PATTERN =
  '^(filter\\..*\\.(clean|smudge|process|required)|merge\\..*\\.driver|protocol\\..*\\.allow)$';

type GitConfigPair = readonly [key: string, value: string];

interface BoundedGitProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

interface GitRuntime {
  readonly root: string;
  readonly emptyConfig: string;
  readonly hooksDirectory: string;
  readonly noopExecutable: string;
  readonly rejectingExecutable: string;
  readonly sshConfig: string;
}

function isTrustedExecutableMode(mode: number): boolean {
  return (mode & 0o022) === 0;
}

async function findTrustedExecutable(
  executableName: string,
  workspaceRoot: string,
  directories: readonly string[],
): Promise<string | undefined> {
  const operatorUid = process.getuid?.();
  if (operatorUid === undefined) return undefined;
  for (const directory of directories) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, executableName);
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
      // Try the next absolute directory.
    }
  }
  return undefined;
}

/**
 * Resolve a git binary from an absolute PATH entry owned by root or the
 * operator and not group/other-writable, mirroring the package-manager trust
 * check used by project.run so a workspace-planted git is never executed.
 */
async function resolveTrustedGitExecutable(workspaceRoot: string): Promise<string> {
  if (process.getuid?.() === undefined) {
    throw new ChatSpliceError('BAD_REQUEST', 'ChatSplice could not verify the git owner.');
  }
  const resolved = await findTrustedExecutable(
    'git',
    workspaceRoot,
    process.env.PATH?.split(delimiter) ?? [],
  );
  if (resolved !== undefined) return resolved;
  throw new ChatSpliceError(
    'BAD_REQUEST',
    "A trusted git executable was not found on ChatSplice's PATH.",
  );
}

/**
 * Turn one structured, already-validated git command into a fixed git argv.
 * Every dynamic value is a schema-validated ref or workspace-relative path, and
 * a `--` separator precedes any path list so a value can never act as a flag.
 */
function buildGitArgv(command: ProjectGitCommand): string[] {
  switch (command.command) {
    case 'status':
      return ['status', '--porcelain=v1', '--branch'];
    case 'branch':
      return ['branch', '--verbose', '--all'];
    case 'log':
      return ['log', `--max-count=${command.max_count}`, '--oneline', '--no-color'];
    case 'diff':
      return [
        'diff',
        '--no-color',
        ...(command.staged ? ['--staged'] : []),
        ...(command.paths.length > 0 ? ['--', ...command.paths] : []),
      ];
    case 'add':
      return command.all ? ['add', '--all'] : ['add', '--', ...command.paths];
    case 'commit':
      return ['commit', ...(command.all ? ['--all'] : []), '--message', command.message];
    case 'push':
      return [
        'push',
        ...(command.set_upstream ? ['--set-upstream'] : []),
        command.remote,
        ...(command.branch ? [command.branch] : []),
      ];
    case 'pull':
      return [
        'pull',
        ...(command.remote ? [command.remote] : []),
        ...(command.branch ? [command.branch] : []),
      ];
    case 'fetch':
      return ['fetch', ...(command.remote ? [command.remote] : [])];
    default:
      return command satisfies never;
  }
}

function hardenedGitArgv(
  command: ProjectGitCommand,
  displayArguments: readonly string[],
): string[] {
  const argumentsAfterCommand = displayArguments.slice(1);
  switch (command.command) {
    case 'diff':
      return ['diff', '--no-ext-diff', '--no-textconv', ...argumentsAfterCommand];
    case 'commit':
      return ['commit', '--no-gpg-sign', ...argumentsAfterCommand];
    case 'push':
      return ['push', '--no-signed', ...argumentsAfterCommand];
    case 'pull':
      return [
        'pull',
        '--no-recurse-submodules',
        '--no-verify-signatures',
        '--no-gpg-sign',
        ...argumentsAfterCommand,
      ];
    case 'fetch':
      return ['fetch', '--no-recurse-submodules', ...argumentsAfterCommand];
    default:
      return [...displayArguments];
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function createGitRuntime(): Promise<GitRuntime> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'chatsplice-project-git-')));
  try {
    await chmod(root, 0o700);
    const emptyConfig = join(root, 'empty.gitconfig');
    const hooksDirectory = join(root, 'hooks');
    const noopExecutable = join(root, 'noop');
    const rejectingExecutable = join(root, 'reject');
    const sshConfig = join(root, 'ssh_config');
    await Promise.all([
      mkdir(hooksDirectory, { mode: 0o700 }),
      mkdir(join(root, 'xdg'), { mode: 0o700 }),
      mkdir(join(root, 'gnupg'), { mode: 0o700 }),
      writeFile(emptyConfig, '', { encoding: 'utf8', mode: 0o600 }),
      writeFile(sshConfig, '', { encoding: 'utf8', mode: 0o600 }),
      writeFile(noopExecutable, '#!/bin/sh\nexit 0\n', { encoding: 'utf8', mode: 0o700 }),
      writeFile(rejectingExecutable, '#!/bin/sh\nexit 1\n', { encoding: 'utf8', mode: 0o700 }),
    ]);
    await Promise.all([chmod(noopExecutable, 0o700), chmod(rejectingExecutable, 0o700)]);
    return { root, emptyConfig, hooksDirectory, noopExecutable, rejectingExecutable, sshConfig };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function trustedSearchPath(gitExecutable: string): string {
  return [...new Set([dirname(gitExecutable), '/usr/bin', '/bin'])].join(delimiter);
}

function safeSshCommand(sshExecutable: string, runtime: GitRuntime): string {
  return [
    shellQuote(sshExecutable),
    '-F',
    shellQuote(runtime.sshConfig),
    '-o',
    'ProxyCommand=none',
    '-o',
    'ProxyJump=none',
    '-o',
    'PermitLocalCommand=no',
    '-o',
    'LocalCommand=none',
    '-o',
    'KnownHostsCommand=none',
  ].join(' ');
}

/**
 * Git receives a fresh private HOME and no inherited Git configuration. The
 * SSH agent remains available, while prompts and user-controlled helper,
 * editor, pager, SSH-config, and GPG command surfaces are replaced.
 */
function gitEnvironment(
  runtime: GitRuntime,
  gitExecutable: string,
  sshCommand: string,
  canonicalRoot: string,
  gitDirectory: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: runtime.root,
    TMPDIR: runtime.root,
    XDG_CONFIG_HOME: join(runtime.root, 'xdg'),
    GNUPGHOME: join(runtime.root, 'gnupg'),
    PATH: trustedSearchPath(gitExecutable),
    CI: '1',
    NO_COLOR: '1',
    GIT_CONFIG_GLOBAL: runtime.emptyConfig,
    GIT_CONFIG_SYSTEM: runtime.emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '0',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_DIR: gitDirectory,
    GIT_WORK_TREE: canonicalRoot,
    GIT_CEILING_DIRECTORIES: canonicalRoot,
    GIT_DISCOVERY_ACROSS_FILESYSTEM: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_EDITOR: runtime.noopExecutable,
    GIT_SEQUENCE_EDITOR: runtime.noopExecutable,
    GIT_ASKPASS: runtime.rejectingExecutable,
    SSH_ASKPASS: runtime.rejectingExecutable,
    GIT_SSH_COMMAND: sshCommand,
    GIT_SSH_VARIANT: 'ssh',
  };
  for (const key of ['LANG', 'LC_ALL', 'TERM', 'SSH_AUTH_SOCK'] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function fixedSecurityConfig(
  runtime: GitRuntime,
  sshCommand: string,
  credentialHelper: string | undefined,
  canonicalRoot: string,
): GitConfigPair[] {
  return [
    ['core.bare', 'false'],
    ['core.worktree', canonicalRoot],
    ['core.hooksPath', runtime.hooksDirectory],
    ['core.fsmonitor', 'false'],
    ['core.sshCommand', sshCommand],
    ['core.askPass', runtime.rejectingExecutable],
    ['core.editor', runtime.noopExecutable],
    ['sequence.editor', runtime.noopExecutable],
    ['core.pager', 'cat'],
    ['commit.gpgSign', 'false'],
    ['commit.verbose', 'false'],
    ['tag.gpgSign', 'false'],
    ['push.gpgSign', 'false'],
    ['log.showSignature', 'false'],
    ['merge.verifySignatures', 'false'],
    ['merge.autoEdit', 'no'],
    ['diff.external', ''],
    ['credential.helper', ''],
    ...(credentialHelper === undefined
      ? []
      : ([['credential.helper', credentialHelper]] as GitConfigPair[])),
    ['credential.interactive', 'false'],
    ['core.gitProxy', 'none'],
    ['fetch.recurseSubmodules', 'false'],
    ['submodule.recurse', 'false'],
    ['gc.auto', '0'],
    ['maintenance.auto', 'false'],
    ['protocol.allow', 'never'],
    ['protocol.file.allow', 'never'],
    ['protocol.ext.allow', 'never'],
    ['protocol.git.allow', 'never'],
    ['protocol.http.allow', 'always'],
    ['protocol.https.allow', 'always'],
    ['protocol.ssh.allow', 'always'],
  ];
}

function configArguments(config: readonly GitConfigPair[]): string[] {
  return config.flatMap(([key, value]) => ['-c', `${key}=${value}`]);
}

async function runBoundedGitProcess(
  gitExecutable: string,
  gitArguments: readonly string[],
  canonicalRoot: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  maximumOutputBytes = MAX_OUTPUT_BYTES,
): Promise<BoundedGitProcessResult> {
  const stdout = new BoundedOutputCapture(maximumOutputBytes);
  const stderr = new BoundedOutputCapture(maximumOutputBytes);
  let timedOut = false;
  const child = spawn(gitExecutable, gitArguments, {
    cwd: canonicalRoot,
    env: environment,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
      }, timeoutMs);
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
  );

  return {
    ...result,
    timedOut,
    stdout: stdout.value,
    stderr: stderr.value,
    truncated: stdout.truncated || stderr.truncated,
  };
}

async function repositoryConfigOverrides(
  gitExecutable: string,
  canonicalRoot: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<GitConfigPair[]> {
  const result = await runBoundedGitProcess(
    gitExecutable,
    ['config', '--includes', '--null', '--name-only', '--get-regexp', EXECUTABLE_CONFIG_PATTERN],
    canonicalRoot,
    environment,
    Math.min(timeoutMs, 5_000),
    MAX_CONFIG_OUTPUT_BYTES,
  ).catch(() => {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      'The repository Git configuration could not be inspected safely.',
    );
  });
  if (result.timedOut || result.signal !== null || result.truncated) {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      'The repository Git configuration could not be inspected safely.',
    );
  }
  if (result.exitCode === 1) return [];
  if (result.exitCode !== 0 || !result.stdout.endsWith('\0')) {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      'The repository Git configuration could not be inspected safely.',
    );
  }

  const overrides = new Map<string, string>();
  for (const key of result.stdout.slice(0, -1).split('\0')) {
    const filter =
      /^filter\.([A-Za-z0-9][A-Za-z0-9._-]{0,200})\.(?:clean|smudge|process|required)$/i.exec(key);
    if (filter !== null) {
      for (const property of ['clean', 'smudge', 'process'] as const) {
        overrides.set(`filter.${filter[1]}.${property}`, '');
      }
      overrides.set(`filter.${filter[1]}.required`, 'false');
      continue;
    }
    const merge = /^merge\.([A-Za-z0-9][A-Za-z0-9._-]{0,200})\.driver$/i.exec(key);
    if (merge !== null) {
      overrides.set(`merge.${merge[1]}.driver`, 'false');
      continue;
    }
    const protocol = /^protocol\.([A-Za-z0-9][A-Za-z0-9.+-]{0,100})\.allow$/i.exec(key);
    if (protocol !== null) {
      const protocolName = protocol[1]!.toLowerCase();
      overrides.set(
        `protocol.${protocol[1]}.allow`,
        ['http', 'https', 'ssh'].includes(protocolName) ? 'always' : 'never',
      );
      continue;
    }
    throw new ChatSpliceError(
      'BAD_REQUEST',
      'The repository contains an unsupported executable Git configuration key.',
    );
  }
  if (overrides.size > 256) {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      'The repository defines too many executable Git configuration entries.',
    );
  }
  return [...overrides];
}

/**
 * Run one bounded git command inside a single explicitly bound user workspace.
 * There is no shell and no arbitrary argument path: the command is one of a
 * fixed allowlist and the argv is assembled here from schema-validated values.
 */
async function runWorkspaceGitUnlocked(
  workspaceService: WorkspaceService,
  input: ProjectGitInput,
): Promise<ProjectGitResult> {
  const validated = ProjectGitInputSchema.parse(input);
  const workspace = workspaceService.getRecord(validated.workspace_id);
  if (workspace.kind !== 'user') {
    throw new ChatSpliceError('BAD_REQUEST', 'project.git is available only for user workspaces.');
  }

  const canonicalRoot = await realpath(workspace.rootPath);
  const gitDirectory = join(canonicalRoot, '.git');
  const gitDirectoryMetadata = await lstat(gitDirectory).catch(() => {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      'project.git requires an existing git repository at the workspace root.',
    );
  });
  if (!gitDirectoryMetadata.isDirectory()) {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      'project.git requires a real .git directory at the workspace root.',
    );
  }

  const gitExecutable = await resolveTrustedGitExecutable(canonicalRoot);
  const gitArguments = buildGitArgv(validated.git);
  const executionGitArguments = hardenedGitArgv(validated.git, gitArguments);
  const usedNetwork = (GIT_NETWORK_COMMANDS as readonly string[]).includes(validated.git.command);
  const startedAt = Date.now();
  const runtime = await createGitRuntime();

  try {
    const trustedSsh = await findTrustedExecutable('ssh', canonicalRoot, [
      dirname(gitExecutable),
      '/usr/bin',
      '/bin',
    ]);
    const sshCommand = safeSshCommand(trustedSsh ?? runtime.rejectingExecutable, runtime);
    const credentialHelper =
      process.platform === 'darwin'
        ? await findTrustedExecutable('git-credential-osxkeychain', canonicalRoot, [
            dirname(gitExecutable),
            '/Library/Developer/CommandLineTools/usr/libexec/git-core',
            '/Applications/Xcode.app/Contents/Developer/usr/libexec/git-core',
            '/usr/libexec/git-core',
          ])
        : undefined;
    const environment = gitEnvironment(
      runtime,
      gitExecutable,
      sshCommand,
      canonicalRoot,
      gitDirectory,
    );
    const dynamicConfig = await repositoryConfigOverrides(
      gitExecutable,
      canonicalRoot,
      environment,
      validated.timeout_ms,
    );
    const securityArguments = configArguments([
      ...fixedSecurityConfig(runtime, sshCommand, credentialHelper, canonicalRoot),
      ...dynamicConfig,
    ]);
    const result = await runBoundedGitProcess(
      gitExecutable,
      [...securityArguments, ...executionGitArguments],
      canonicalRoot,
      environment,
      validated.timeout_ms,
    ).catch((error: NodeJS.ErrnoException) => {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        error.code === 'ENOENT'
          ? 'The trusted git executable could not be started.'
          : 'The bounded git command could not be started.',
      );
    });

    return {
      workspace_id: validated.workspace_id,
      workspace_name: workspace.display_name,
      command: validated.git.command,
      argv: `git ${gitArguments.join(' ')}`.slice(0, 400),
      used_network: usedNetwork,
      exit_code: result.exitCode,
      signal: result.signal,
      timed_out: result.timedOut,
      duration_ms: Date.now() - startedAt,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
    };
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
}

export function runWorkspaceGit(
  workspaceService: WorkspaceService,
  input: ProjectGitInput,
): Promise<ProjectGitResult> {
  return workspaceService.withOperation(input.workspace_id, () =>
    runWorkspaceGitUnlocked(workspaceService, input),
  );
}
