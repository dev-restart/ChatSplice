import { spawn } from 'node:child_process';
import { lstat, mkdir, realpath, stat, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';

import { readCheckedFile } from '../fs/checked-file.js';
import { BoundedOutputCapture, terminateProcessGroup } from '../process/bounded-output.js';

import { sandboxProfile, SANDBOX_EXECUTABLE } from './pi-sandbox.js';
import {
  badRequest,
  fileIsRegular,
  resolveTrustedExecutable,
  resolveTrustedSearchDirectory,
} from './pi-trusted.js';
import type { TrustedExecutable } from './pi-types.js';

const MAX_RUSTUP_QUERY_MS = 5_000;
const MAX_RUSTUP_STDOUT_BYTES = 12 * 1024;
const MAX_RUSTUP_STDERR_BYTES = 4 * 1024;
const MAX_TOOLCHAIN_FILE_BYTES = 16 * 1024;
const MAX_PATH_DIRECTORIES = 64;

/** This query cannot install a toolchain, alter Rustup state or use the network. */
export function rustupQuerySandboxProfile(): string {
  // Selection only reads project pins. It must not acquire project write access
  // before the command's execution preflight has run.
  const base = sandboxProfile(false, false).replace(
    '(allow file-write*\n  (subpath (param "WORKSPACE"))',
    '(allow file-write*',
  );
  const marker = '(deny file-read-data file-map-executable file-write*';
  const allowance = [
    '(allow file-read-data file-map-executable (literal (param "RUSTUP_EXECUTABLE")))',
    '(allow file-read-data (literal (param "RUSTUP_SETTINGS")))',
  ].join('\n');
  return base.replace(marker, `${allowance}\n${marker}`);
}

async function validateProjectToolchainFiles(cwd: string, workspaceRoot: string): Promise<void> {
  let directory = cwd;
  for (let depth = 0; depth < 64; depth += 1) {
    for (const name of ['rust-toolchain', 'rust-toolchain.toml']) {
      const path = join(directory, name);
      const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        badRequest('The project Rust toolchain selection could not be inspected.');
      });
      if (metadata === undefined) continue;
      await fileIsRegular(path, name, MAX_TOOLCHAIN_FILE_BYTES);
      // Validate actual bytes/inode/link count before Rustup reads the pin. The
      // native selector, not a partial TOML parser, interprets its contents.
      await readCheckedFile(path, MAX_TOOLCHAIN_FILE_BYTES);
    }
    if (directory === workspaceRoot) return;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  badRequest('Rust toolchain selection exceeded the bounded project directory depth.');
}

async function isRustupProxy(candidate: string, executable: TrustedExecutable): Promise<boolean> {
  if (['rustup', 'rustup-init'].includes(basename(executable.path))) return true;
  // Rustup also supports hard-linked proxies, whose realpath still ends in cargo.
  const cargo = await stat(executable.path);
  for (const name of ['rustup', 'rustup-init']) {
    const proxy = await stat(join(dirname(candidate), name)).catch(() => undefined);
    if (proxy !== undefined && proxy.dev === cargo.dev && proxy.ino === cargo.ino) return true;
  }
  return false;
}

async function queryRustupCargo(
  rustup: TrustedExecutable,
  workspaceRoot: string,
  cwd: string,
  runtimeDirectory: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) badRequest('Rust toolchain selection was cancelled.');
  await validateProjectToolchainFiles(cwd, workspaceRoot);
  const rustupHome = join(homedir(), '.rustup');
  const privateDirectory = join(runtimeDirectory, 'rustup-selector');
  await mkdir(privateDirectory, { mode: 0o700 });
  // Homebrew's rustup may resolve to rustup-init. Preserve argv[0]'s rustup
  // identity through a private alias rather than accidentally invoking setup.
  const invocation = join(privateDirectory, 'rustup');
  await symlink(rustup.path, invocation);
  if ((await realpath(invocation)) !== rustup.path) {
    badRequest('The private Rustup selector changed during preparation.');
  }
  const parameters = {
    WORKSPACE: workspaceRoot,
    RUNTIME: privateDirectory,
    CARGO_HOME: privateDirectory,
    CARGO_TOOL_HOME: privateDirectory,
    COREPACK_CACHE: privateDirectory,
    // ~/.cargo/bin/rustup has ~/.cargo as its executable root. Do not grant
    // that broad read boundary: only the verified Rustup binary is readable.
    PACKAGE_MANAGER_ROOT: privateDirectory,
    NODE_RUNTIME_ROOT: privateDirectory,
    RUST_TOOLCHAIN_ROOT: join(rustupHome, 'toolchains'),
    RUSTUP_EXECUTABLE: rustup.path,
    RUSTUP_SETTINGS: join(rustupHome, 'settings.toml'),
    USER_SSH: join(homedir(), '.ssh'),
    USER_GNUPG: join(homedir(), '.gnupg'),
    USER_AWS: join(homedir(), '.aws'),
    USER_CODEX: join(homedir(), '.codex'),
    USER_PI: join(homedir(), '.pi'),
    USER_CHATSPLICE: join(homedir(), '.chatsplice'),
    WORKSPACE_GIT: join(workspaceRoot, '.git'),
    WORKSPACE_SSH: join(workspaceRoot, '.ssh'),
    WORKSPACE_ENV: join(workspaceRoot, '.env'),
    WORKSPACE_NPMRC: join(workspaceRoot, '.npmrc'),
  };
  const environment: NodeJS.ProcessEnv = {
    HOME: privateDirectory,
    TMPDIR: privateDirectory,
    CARGO_HOME: privateDirectory,
    RUSTUP_HOME: rustupHome,
    RUSTUP_AUTO_INSTALL: '0',
    RUSTUP_TERM_COLOR: 'never',
    RUSTUP_TERM_PROGRESS_WHEN: 'never',
    RUSTUP_NO_BACKTRACE: '1',
    PATH: '/usr/bin:/bin',
    LANG: 'C',
  };
  const stdout = new BoundedOutputCapture(MAX_RUSTUP_STDOUT_BYTES);
  const stderr = new BoundedOutputCapture(MAX_RUSTUP_STDERR_BYTES);
  if (signal?.aborted) badRequest('Rust toolchain selection was cancelled.');
  const child = spawn(
    SANDBOX_EXECUTABLE,
    [
      ...Object.entries(parameters).flatMap(([key, value]) => ['-D', `${key}=${value}`]),
      '-p',
      rustupQuerySandboxProfile(),
      invocation,
      'which',
      'cargo',
    ],
    { cwd, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let reason: 'cancelled' | 'timed_out' | 'output_limit' | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  const stop = (nextReason: NonNullable<typeof reason>): void => {
    if (reason !== undefined) return;
    reason = nextReason;
    terminateProcessGroup(child.pid, 'SIGTERM');
    killTimer = setTimeout(() => terminateProcessGroup(child.pid, 'SIGKILL'), 1_000);
    killTimer.unref();
  };
  const onAbort = (): void => stop('cancelled');
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout.append(chunk);
        if (stdout.truncated) stop('output_limit');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr.append(chunk);
        if (stderr.truncated) stop('output_limit');
      });
      child.once('error', () => reject(new Error('The Rustup selector could not be started.')));
      child.once('close', resolve);
      signal?.addEventListener('abort', onAbort, { once: true });
      timeoutTimer = setTimeout(() => stop('timed_out'), MAX_RUSTUP_QUERY_MS);
      timeoutTimer.unref();
      if (signal?.aborted) onAbort();
    }).catch(() => badRequest('The sandboxed Rustup selector could not be started.'));
    if (reason === 'cancelled') badRequest('Rust toolchain selection was cancelled.');
    if (reason === 'timed_out') badRequest('Rust toolchain selection timed out after 5 seconds.');
    if (reason === 'output_limit' || stdout.truncated || stderr.truncated) {
      badRequest('Rust toolchain selection exceeded its bounded output limit.');
    }
    if (exitCode !== 0) {
      const detail = stderr.value
        .replaceAll(/\p{Cc}/gu, ' ')
        .trim()
        .slice(0, 1_024);
      if (
        /^(?:sandbox-exec:\s*)?(?:sandbox_apply|sandbox_init):\s*(?:Operation not permitted|Permission denied)\s*$/imu.test(
          stderr.value,
        )
      ) {
        badRequest(
          '[RUST_TOOLCHAIN_SANDBOX_UNAVAILABLE] Rust toolchain inspection could not initialize ' +
            'the execution sandbox. No toolchain selection or installation was performed. ' +
            detail,
        );
      }
      badRequest(
        'Rustup could not select an installed Cargo toolchain for this project. ' +
          'Check rust-toolchain(.toml), the directory override and the Rustup default; ' +
          'no different toolchain was substituted.' +
          (detail.length === 0 ? '' : ` ${detail}`),
      );
    }
    const selected = stdout.value.trim();
    if (
      selected.length === 0 ||
      selected.length > 4_096 ||
      /\p{Cc}/u.test(selected) ||
      !isAbsolute(selected)
    ) {
      badRequest('Rustup did not return one absolute Cargo executable path.');
    }
    return selected;
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (killTimer !== undefined) clearTimeout(killTimer);
    signal?.removeEventListener('abort', onAbort);
    terminateProcessGroup(child.pid, 'SIGKILL');
  }
}

async function validateSelectedCargo(
  path: string,
  workspaceRoot: string,
): Promise<TrustedExecutable> {
  const cargo = await resolveTrustedExecutable(path, workspaceRoot);
  if (basename(cargo.path) !== 'cargo') {
    badRequest('Rustup did not select a real Cargo executable.');
  }
  const bin = dirname(cargo.path);
  const rustc = await resolveTrustedExecutable(join(bin, 'rustc'), workspaceRoot);
  if (
    basename(rustc.path) !== 'rustc' ||
    dirname(rustc.path) !== bin ||
    rustc.root !== cargo.root
  ) {
    badRequest('The selected Cargo and rustc must belong to the same trusted toolchain.');
  }
  const searchDirectory = await resolveTrustedSearchDirectory(bin, workspaceRoot);
  return { ...cargo, searchDirectory };
}

/** Preserve shell PATH precedence and let Rustup resolve cwd pins/defaults. */
export async function resolveTrustedCargo(
  workspaceRoot: string,
  cwd: string,
  runtimeDirectory: string,
  signal?: AbortSignal,
): Promise<TrustedExecutable> {
  const directories = [...new Set((process.env.PATH ?? '').split(delimiter).filter(isAbsolute))];
  if (directories.length > MAX_PATH_DIRECTORIES) {
    badRequest('Rust toolchain discovery exceeded the bounded PATH directory limit.');
  }
  for (const directory of directories) {
    if (signal?.aborted) badRequest('Rust toolchain selection was cancelled.');
    const candidate = join(directory, 'cargo');
    let executable: TrustedExecutable;
    try {
      executable = await resolveTrustedExecutable(candidate, workspaceRoot);
      await resolveTrustedSearchDirectory(directory, workspaceRoot);
    } catch {
      continue;
    }
    if (await isRustupProxy(candidate, executable)) {
      // Once a trusted proxy is found, its selection failure is authoritative.
      // Skipping to a later PATH entry or sorting installed versions can run an
      // older compiler despite the project's pin or the user's active default.
      const selected = await queryRustupCargo(
        executable,
        workspaceRoot,
        cwd,
        runtimeDirectory,
        signal,
      );
      return validateSelectedCargo(selected, workspaceRoot);
    }
    return validateSelectedCargo(candidate, workspaceRoot);
  }
  badRequest(
    "A trusted Cargo executable was not found on ChatSplice's PATH. Configure Cargo or Rustup before running this check.",
  );
}
