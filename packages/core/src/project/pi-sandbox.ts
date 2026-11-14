import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readdir, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type { ProjectExecInput } from '@chatsplice/protocol';

import { terminateExitedProcessGroup, terminateProcessGroup } from '../process/bounded-output.js';

import {
  ancestorDirectoryReadProfile,
  developmentSandboxProfile,
  LOCAL_NETWORK_SANDBOX_PROFILE,
  structuredGitReadOnlyProfile,
} from './development-sandbox.js';
import { developmentCommandPath, developmentToolEnvironment } from './development-tools.js';
import { prepareProjectPythonShims } from './project-python-shims.js';
import { badRequest, fileIsRegular } from './pi-trusted.js';
import { shellRuntimeParameters, shellSandboxProfile } from './shell-sandbox.js';
import type {
  OutputBudget,
  PackageManager,
  PreparedOperation,
  ProcessResult,
  ProjectOperationOptions,
  TrustedExecutable,
} from './pi-types.js';

export const SANDBOX_EXECUTABLE = '/usr/bin/sandbox-exec';
const MAX_SDK_OUTPUT_BYTES = 48 * 1024;
const MAX_SDK_OUTPUT_LINES = 1_800;
const TERMINATE_GRACE_MS = 1_000;
const MAX_CACHED_MANAGER_VERSIONS = 64;
const MAX_COREPACK_METADATA_BYTES = 4_096;
const SANDBOX_PROFILE_BASE = [
  '(version 1)',
  '(allow default)',
  '(deny file-link)',
  '(deny file-write*)',
  '(allow file-write*',
  '  (subpath (param "WORKSPACE"))',
  '  (subpath (param "RUNTIME"))',
  '  (subpath (param "CARGO_HOME"))',
  '  (subpath (param "CARGO_TOOL_HOME")))',
  '(deny file-read-data file-map-executable)',
  '(allow file-read-data file-map-executable',
  '  (subpath (param "WORKSPACE"))',
  '  (subpath (param "RUNTIME"))',
  '  (subpath (param "CARGO_HOME"))',
  '  (subpath (param "CARGO_TOOL_HOME"))',
  '  (subpath (param "COREPACK_CACHE"))',
  '  (subpath (param "PACKAGE_MANAGER_ROOT"))',
  '  (subpath (param "NODE_RUNTIME_ROOT"))',
  '  (subpath (param "RUST_TOOLCHAIN_ROOT"))',
  '  (subpath "/Library/Apple")',
  '  (subpath "/Library/Developer/CommandLineTools")',
  '  (subpath "/Applications/Xcode.app/Contents/Developer")',
  '  (subpath "/System")',
  '  (subpath "/usr/bin")',
  '  (subpath "/usr/lib")',
  '  (subpath "/usr/share")',
  '  (subpath "/bin")',
  '  (subpath "/sbin")',
  '  (subpath "/private/var/db/timezone")',
  '  (literal "/private/etc/localtime")',
  '  (literal "/private/etc/ssl/openssl.cnf")',
  '  (subpath "/private/etc/ssl")',
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
  '(allow file-write-data (literal "/dev/null"))',
  // The allow above is intentionally broad enough for the system loader. The
  // following deny rules win for repository secret and control paths.
  '(deny file-read-data file-map-executable file-write* file-link',
  '  (regex (string-append "^" (regex-quote (param "WORKSPACE")) #"/([^/]+/)*([.][sS][sS][hH]|[.][cC][oO][dD][eE][xX]|[.][lL][oO][cC][aA][lL][cC][hH][aA][tT]|[.][cC][hH][aA][tT][sS][pP][lL][iI][cC][eE]|[.][pP][iI])(/|$)"))',
  '  (regex (string-append "^" (regex-quote (param "WORKSPACE")) #"/([^/]+/)*([.][eE][nN][vV]([.][^/]*|[rR][cC])?|[.][gG][iI][tT]-[cC][rR][eE][dD][eE][nN][tT][iI][aA][lL][sS]|[.][nN][pP][mM][rR][cC]|[.][pP][yY][pP][iI][rR][cC]|[iI][dD]_[eE][dD]25519|[iI][dD]_[rR][sS][aA])(/|$)"))',
  '  (regex (string-append "^" (regex-quote (param "WORKSPACE")) #"/([^/]+/)*[^/]*([.][kK][eE][yY]|[.][pP]12|[.][pP][eE][mM]|[.][pP][fF][xX])(/|$)"))',
  '  (regex (string-append "^" (regex-quote (param "WORKSPACE")) #"/([^/]+/)*[.]cargo/credentials([.]toml([.]enc)?)?$"))',
  '  (regex (string-append "^" (regex-quote (param "CARGO_HOME")) #"/(config([.]toml)?|credentials([.]toml([.]enc)?)?)$"))',
  '  (regex (string-append "^" (regex-quote (param "CARGO_TOOL_HOME")) #"/(config([.]toml)?|credentials([.]toml([.]enc)?)?)$"))',
  '  (subpath (param "USER_SSH"))',
  '  (subpath (param "USER_GNUPG"))',
  '  (subpath (param "USER_AWS"))',
  '  (subpath (param "USER_CODEX"))',
  '  (subpath (param "USER_PI"))',
  '  (subpath (param "USER_CHATSPLICE"))',
  '  (subpath (param "WORKSPACE_SSH"))',
  '  (subpath (param "WORKSPACE_ENV"))',
  '  (subpath (param "WORKSPACE_NPMRC")))',
].join('\n');

export function safeEnvironment(
  runtimeDirectory: string,
  executable: TrustedExecutable,
  nodeRuntime: TrustedExecutable | undefined,
  shimDirectory: string | undefined,
  cargoHome: string,
  corepackCache: string,
  cargoOperation: boolean,
  network: boolean,
): NodeJS.ProcessEnv {
  const nodeDirectories =
    nodeRuntime === undefined
      ? [dirname(process.execPath)]
      : [
          ...(nodeRuntime.searchDirectory === undefined ? [] : [nodeRuntime.searchDirectory]),
          dirname(nodeRuntime.path),
        ];
  const commandDirectories = [
    dirname(executable.path),
    ...(executable.searchDirectory === undefined ? [] : [executable.searchDirectory]),
  ];
  const executableDirectories = [
    ...(shimDirectory === undefined ? [] : [shimDirectory]),
    // Cargo must find rustc/rustfmt/clippy from its selected toolchain before
    // an unrelated Node or package-manager installation on PATH.
    ...(cargoOperation
      ? [...commandDirectories, ...nodeDirectories]
      : [...nodeDirectories, ...commandDirectories]),
    join(cargoHome, 'bin'),
    '/usr/bin',
    '/bin',
  ];
  const environment: NodeJS.ProcessEnv = {
    HOME: runtimeDirectory,
    TMPDIR: runtimeDirectory,
    TMP: runtimeDirectory,
    TEMP: runtimeDirectory,
    // zsh heredocs use TMPPREFIX, not TMPDIR, for their temporary files.
    TMPPREFIX: join(runtimeDirectory, 'zsh'),
    CARGO_HOME: cargoHome,
    COREPACK_HOME: corepackCache,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    COREPACK_ENABLE_NETWORK: '0',
    CI: '1',
    NO_COLOR: '1',
    CARGO_NET_OFFLINE: cargoOperation && !network ? 'true' : 'false',
    CARGO_TERM_COLOR: 'never',
    PATH: [...new Set(executableDirectories)].join(delimiter),
  };
  if (network) {
    environment.NPM_CONFIG_IGNORE_SCRIPTS = 'true';
  }
  for (const key of ['LANG', 'LC_ALL', 'TERM'] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

/** Reuse development tools installed by an earlier job in this project. */
export function shellCommandPath(cargoHome: string, inheritedPath: string | undefined): string {
  return [
    ...new Set([join(cargoHome, 'bin'), ...(inheritedPath ?? '').split(delimiter).filter(Boolean)]),
  ].join(delimiter);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function preparePackageManagerShim(
  runtimeDirectory: string,
  manager: PackageManager,
  executable: TrustedExecutable,
  nodeRuntime?: TrustedExecutable,
): Promise<string> {
  const shimDirectory = join(runtimeDirectory, 'bin');
  await mkdir(shimDirectory, { mode: 0o700 });
  const shimPath = join(shimDirectory, manager);
  let invocation = `exec ${shellQuote(executable.path)} "$@"`;
  if (/\.(?:c|m)?js$/iu.test(executable.path)) {
    if (nodeRuntime === undefined) {
      badRequest('A trusted Node runtime is required for this package-manager executable.');
    }
    invocation = `exec ${shellQuote(nodeRuntime.path)} ${shellQuote(executable.path)} "$@"`;
  }
  const shim = `#!/bin/sh\n${invocation}\n`;
  await writeFile(shimPath, shim, { encoding: 'utf8', mode: 0o700 });
  await chmod(shimPath, 0o700);
  await fileIsRegular(shimPath, 'private package-manager shim');
  return shimDirectory;
}

async function prepareShellCorepackCache(
  runtimeDirectory: string,
  installedCache: string,
): Promise<string> {
  const privateCache = join(runtimeDirectory, 'corepack-cache');
  await mkdir(privateCache, { mode: 0o700 });
  for (const manager of ['npm', 'pnpm', 'yarn']) {
    const installedVersions = join(installedCache, 'v1', manager);
    const versions = await readdir(installedVersions, { withFileTypes: true }).catch(() => []);
    const selected = versions
      .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9._+-]+$/u.test(entry.name))
      .sort((left, right) => right.name.localeCompare(left.name))
      .slice(0, MAX_CACHED_MANAGER_VERSIONS);
    if (selected.length === 0) continue;
    const privateVersions = join(privateCache, 'v1', manager);
    await mkdir(privateVersions, { recursive: true, mode: 0o700 });
    for (const version of selected) {
      // Existing managers stay read-only through COREPACK_CACHE's allowlist.
      // Only new versions and mutable metadata live in this execution's cache.
      await symlink(join(installedVersions, version.name), join(privateVersions, version.name));
    }
  }
  const metadataFile = await open(
    join(installedCache, 'lastKnownGood.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => undefined);
  if (metadataFile !== undefined) {
    try {
      const metadata = await metadataFile.stat();
      if (!metadata.isFile() || metadata.nlink !== 1) return privateCache;
      const bytes = Buffer.alloc(MAX_COREPACK_METADATA_BYTES + 1);
      const { bytesRead } = await metadataFile.read(bytes);
      if (bytesRead <= MAX_COREPACK_METADATA_BYTES) {
        await writeFile(join(privateCache, 'lastKnownGood.json'), bytes.subarray(0, bytesRead), {
          mode: 0o600,
        });
      }
    } finally {
      await metadataFile.close();
    }
  }
  return privateCache;
}

export function sandboxProfile(network: boolean, allowLoopback: boolean): string {
  const base = `${SANDBOX_PROFILE_BASE}\n${structuredGitReadOnlyProfile()}`;
  if (network) return `${base}\n(allow network*)`;
  if (allowLoopback) return `${base}\n${LOCAL_NETWORK_SANDBOX_PROFILE}`;
  return `${base}\n(deny network*)`;
}

export function workspaceAncestorDirectoryReadProfile(canonicalRoot: string): string {
  return ancestorDirectoryReadProfile([canonicalRoot]);
}

/** Additional folder rules are inserted before the existing host-secret denials. */
export function additionalFolderSandboxPolicy(
  base: string,
  folders: NonNullable<PreparedOperation['additionalFolders']>,
  developerShell: boolean,
): { profile: string; parameters: string[] } {
  if (folders.length === 0) return { profile: base, parameters: [] };
  if (folders.length > 100) badRequest('Execution supports at most 100 additional folders.');
  const parameters: string[] = [];
  const rules: string[] = [];
  const protections: string[] = [];
  const protectedPaths = SANDBOX_PROFILE_BASE.slice(
    SANDBOX_PROFILE_BASE.indexOf('(deny file-read-data file-map-executable file-write* file-link'),
  )
    .split('\n')
    .filter(
      (line) => line.trimStart().startsWith('(regex ') && line.includes('(param "WORKSPACE")'),
    );
  for (const [index, folder] of folders.entries()) {
    const parameter = `FOLDER_${index}`;
    parameters.push('-D', `${parameter}=${folder.rootPath}`);
    rules.push(`(allow file-read-data file-map-executable (subpath (param "${parameter}")))`);
    if (folder.accessMode === 'read_write') {
      rules.push(`(allow file-write* (subpath (param "${parameter}")))`);
    }
    // Cwd reconstruction gets exact ancestor directories, not their contents.
    rules.push(workspaceAncestorDirectoryReadProfile(folder.rootPath));
    if (!developerShell) {
      protections.push(structuredGitReadOnlyProfile(parameter));
      protections.push('(deny file-read-data file-map-executable file-write* file-link');
      protections.push(
        ...protectedPaths.map((line) =>
          line.replaceAll('(param "WORKSPACE")', `(param "${parameter}")`),
        ),
      );
      protections.push(')');
    }
  }
  const marker = '(deny file-read-data file-map-executable file-write* file-link';
  const position = base.indexOf(marker);
  if (position < 0) badRequest('The execution sandbox profile is incomplete.');
  return {
    profile: `${base.slice(0, position)}${rules.join('\n')}\n${base.slice(position)}\n${protections.join('\n')}`,
    parameters,
  };
}

export function appendSdkBounded(
  chunk: Buffer,
  budget: OutputBudget,
  onData: (data: Buffer) => void,
): void {
  if (chunk.byteLength === 0 || budget.bytes >= MAX_SDK_OUTPUT_BYTES) return;
  const remainingBytes = MAX_SDK_OUTPUT_BYTES - budget.bytes;
  let candidate = chunk.subarray(0, remainingBytes);
  const newlines = candidate.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0);
  if (budget.lines + newlines > MAX_SDK_OUTPUT_LINES) {
    let allowedNewlines = MAX_SDK_OUTPUT_LINES - budget.lines;
    let end = 0;
    while (end < candidate.byteLength) {
      if (candidate[end] === 0x0a) {
        if (allowedNewlines === 0) break;
        allowedNewlines -= 1;
      }
      end += 1;
    }
    candidate = candidate.subarray(0, end);
  }
  if (candidate.byteLength === 0) return;
  budget.bytes += candidate.byteLength;
  budget.lines += candidate.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0);
  const copy = Buffer.from(candidate);
  onData(copy);
}

export async function executeSandboxedCommand(
  command: string,
  cwd: string,
  input: ProjectExecInput,
  prepared: PreparedOperation,
  network: boolean,
  options: ProjectOperationOptions,
  sdkOnData: (data: Buffer) => void,
): Promise<ProcessResult> {
  const shell = input.operation.kind === 'shell';
  const environment = safeEnvironment(
    prepared.runtimeDirectory,
    prepared.executable,
    prepared.nodeRuntime,
    prepared.shimDirectory,
    prepared.cargoHome,
    prepared.corepackCache,
    input.operation.kind === 'cargo' ||
      (input.operation.kind === 'install' && input.operation.ecosystem === 'rust'),
    network,
  );
  Object.assign(
    environment,
    developmentToolEnvironment(
      prepared.runtimeDirectory,
      prepared.workspaceRoot,
      prepared.cargoHome,
      prepared.cargoToolHome,
    ),
  );
  environment.PATH = developmentCommandPath(
    shell ? undefined : environment.PATH,
    prepared.workspaceRoot,
    prepared.cargoHome,
    undefined,
    prepared.cargoToolHome,
  );
  if (!shell) {
    const projectPython = await prepareProjectPythonShims(
      prepared.runtimeDirectory,
      prepared.workspaceRoot,
    );
    if (projectPython !== undefined)
      environment.PATH = `${projectPython}${delimiter}${environment.PATH}`;
  }
  if (shell) {
    // Developer installs run their project hooks. Legacy structured installs
    // keep safeEnvironment's explicit ignore-scripts policy.
    delete environment.NPM_CONFIG_IGNORE_SCRIPTS;
    // Structured checks use the installed cache read-only. A developer shell
    // may download its pinned manager, but only into this execution's cache.
    environment.COREPACK_ENABLE_NETWORK = network ? '1' : '0';
    if (network) {
      environment.COREPACK_HOME = await prepareShellCorepackCache(
        prepared.runtimeDirectory,
        prepared.corepackCache,
      );
    }
  }
  const baseProfile = shell
    ? shellSandboxProfile(network)
    : sandboxProfile(
        network,
        input.operation.kind === 'node_script' || input.operation.kind === 'cargo',
      );
  const folderPolicy = additionalFolderSandboxPolicy(
    baseProfile,
    prepared.additionalFolders ?? [],
    shell,
  );
  const commandProfile = developmentSandboxProfile(folderPolicy.profile, [
    prepared.workspaceRoot,
    prepared.runtimeDirectory,
    prepared.cargoHome,
    prepared.cargoToolHome ?? prepared.cargoHome,
    prepared.corepackCache,
    prepared.executable.root,
    ...(prepared.nodeRuntime === undefined ? [] : [prepared.nodeRuntime.root]),
    ...(prepared.additionalFolders ?? []).map((folder) => folder.rootPath),
  ]);
  const sdkBudget: OutputBudget = { bytes: 0, lines: 0 };
  let timedOut = false;
  let aborted = options.signal?.aborted ?? false;
  let terminated = false;
  let killTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;

  if (aborted) return { exitCode: null, timedOut: false, aborted: true };

  options.onStart?.({ command, used_network: network });
  if (options.signal?.aborted) return { exitCode: null, timedOut: false, aborted: true };

  const child = spawn(
    SANDBOX_EXECUTABLE,
    [
      '-D',
      `WORKSPACE=${prepared.workspaceRoot}`,
      '-D',
      `RUNTIME=${prepared.runtimeDirectory}`,
      '-D',
      `CARGO_HOME=${prepared.cargoHome}`,
      '-D',
      `CARGO_TOOL_HOME=${prepared.cargoToolHome ?? prepared.cargoHome}`,
      '-D',
      `COREPACK_CACHE=${prepared.corepackCache}`,
      '-D',
      `PACKAGE_MANAGER_ROOT=${prepared.executable.root}`,
      '-D',
      `NODE_RUNTIME_ROOT=${prepared.nodeRuntime?.root ?? prepared.runtimeDirectory}`,
      '-D',
      `RUST_TOOLCHAIN_ROOT=${prepared.executable.root}`,
      '-D',
      `USER_SSH=${join(homedir(), '.ssh')}`,
      '-D',
      `USER_GNUPG=${join(homedir(), '.gnupg')}`,
      '-D',
      `USER_AWS=${join(homedir(), '.aws')}`,
      '-D',
      `USER_CODEX=${join(homedir(), '.codex')}`,
      '-D',
      `USER_PI=${join(homedir(), '.pi')}`,
      '-D',
      `USER_CHATSPLICE=${join(homedir(), '.chatsplice')}`,
      '-D',
      `WORKSPACE_GIT=${join(prepared.workspaceRoot, '.git')}`,
      '-D',
      `WORKSPACE_SSH=${join(prepared.workspaceRoot, '.ssh')}`,
      '-D',
      `WORKSPACE_ENV=${join(prepared.workspaceRoot, '.env')}`,
      '-D',
      `WORKSPACE_NPMRC=${join(prepared.workspaceRoot, '.npmrc')}`,
      ...(shell ? shellRuntimeParameters() : []),
      ...folderPolicy.parameters,
      '-p',
      commandProfile,
      prepared.executable.path,
      ...prepared.args,
    ],
    {
      cwd,
      env: environment,
      detached: true,
      stdio: [
        shell && input.operation.kind === 'shell' && input.operation.stdin !== undefined
          ? 'pipe'
          : 'ignore',
        'pipe',
        'pipe',
      ],
    },
  );
  const childPid: number | undefined = child.pid;
  if (input.operation.kind === 'shell' && input.operation.stdin !== undefined) {
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input.operation.stdin);
  }
  let exited = false;
  const terminate = (signal: NodeJS.Signals): void => {
    if (childPid === undefined) return;
    if (exited) terminateExitedProcessGroup(childPid, signal);
    else terminateProcessGroup(childPid, signal);
  };
  const scheduleTermination = (): void => {
    if (terminated) return;
    terminated = true;
    terminate('SIGTERM');
    killTimer = setTimeout(() => {
      terminate('SIGKILL');
      // A descendant outside the process group can hold the pipes open
      // forever; release them so close is still emitted.
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, TERMINATE_GRACE_MS);
    killTimer.unref();
  };

  const handleOutput = (chunk: Buffer, decoder: StringDecoder): void => {
    appendSdkBounded(chunk, sdkBudget, sdkOnData);
    // The daemon owns its structured output cap and truncation marker. Feed
    // it every stream chunk while the SDK receives its separately bounded
    // copy, preventing the SDK's raw-output spool without hiding evidence
    // from the execution job store.
    if (options.onOutput !== undefined) options.onOutput(decoder.write(chunk));
  };
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  child.stdout?.on('data', (chunk: Buffer) => handleOutput(chunk, stdoutDecoder));
  child.stderr?.on('data', (chunk: Buffer) => handleOutput(chunk, stderrDecoder));
  child.stdout?.on('end', () => {
    const remainder = stdoutDecoder.end();
    if (remainder !== '' && options.onOutput !== undefined) options.onOutput(remainder);
  });
  child.stderr?.on('end', () => {
    const remainder = stderrDecoder.end();
    if (remainder !== '' && options.onOutput !== undefined) options.onOutput(remainder);
  });

  const onAbort = (): void => {
    aborted = true;
    scheduleTermination();
  };
  if (options.signal !== undefined)
    options.signal.addEventListener('abort', onAbort, { once: true });
  if (input.timeout_ms > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      scheduleTermination();
    }, input.timeout_ms);
    timeoutTimer.unref();
  }

  const result = await new Promise<{ exitCode: number | null }>((resolveResult, rejectResult) => {
    child.once('error', (error) => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      scheduleTermination();
      rejectResult(error);
    });
    child.once('exit', () => {
      // A shell can exit while a background descendant still owns its pipes.
      // Kill the detached process group as soon as the main process exits.
      exited = true;
      scheduleTermination();
    });
    child.once('close', (exitCode) => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      // The close event is the last point at which all stdio handles are
      // closed. Force the group down before publishing a terminal result.
      terminate('SIGKILL');
      resolveResult({ exitCode });
    });
  }).finally(() => {
    if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort);
  });

  return {
    exitCode: aborted || timedOut ? null : result.exitCode,
    timedOut,
    aborted,
  };
}
