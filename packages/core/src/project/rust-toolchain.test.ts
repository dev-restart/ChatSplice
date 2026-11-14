import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { terminateProcessGroup } from '../process/bounded-output.js';
import type * as BoundedOutputModule from '../process/bounded-output.js';
import { resolveTrustedCargo, rustupQuerySandboxProfile } from './rust-toolchain.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../process/bounded-output.js', async (importOriginal) => ({
  ...(await importOriginal<typeof BoundedOutputModule>()),
  terminateProcessGroup: vi.fn(),
}));

describe('Cargo toolchain selection', () => {
  let temporaryDirectory: string;
  let workspaceRoot: string;
  let runtimeDirectory: string;
  let proxyDirectory: string;
  let selectedCargo: string;
  let olderCargo: string;
  let queryChild: ChildProcess;

  async function executable(path: string): Promise<string> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    return path;
  }

  async function toolchain(name: string): Promise<string> {
    const bin = join(temporaryDirectory, 'toolchains', name, 'bin');
    await executable(join(bin, 'rustc'));
    return executable(join(bin, 'cargo'));
  }

  function queryResult(output: string, exitCode = 0, error = ''): void {
    vi.mocked(spawn).mockImplementation(() => {
      queryChild = Object.assign(new EventEmitter(), {
        pid: 8_000_001,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      }) as unknown as ChildProcess;
      queueMicrotask(() => {
        queryChild.stdout?.emit('data', Buffer.from(output));
        queryChild.stderr?.emit('data', Buffer.from(error));
        queryChild.emit('close', exitCode);
      });
      return queryChild as ReturnType<typeof spawn>;
    });
  }

  function pendingQuery(): Promise<void> {
    return new Promise((started) => {
      vi.mocked(spawn).mockImplementation(() => {
        queryChild = Object.assign(new EventEmitter(), {
          pid: 8_000_001,
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        }) as unknown as ChildProcess;
        started();
        return queryChild as ReturnType<typeof spawn>;
      });
      vi.mocked(terminateProcessGroup).mockImplementation((_pid, signal) => {
        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          queueMicrotask(() => queryChild.emit('close', null));
        }
      });
    });
  }

  beforeEach(async () => {
    temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'cs-rust-selection-')));
    workspaceRoot = join(temporaryDirectory, 'workspace');
    runtimeDirectory = join(temporaryDirectory, 'runtime');
    proxyDirectory = join(temporaryDirectory, 'rustup-package', 'bin');
    await Promise.all([mkdir(workspaceRoot), mkdir(runtimeDirectory)]);
    const rustup = await executable(join(proxyDirectory, 'rustup'));
    await symlink(rustup, join(proxyDirectory, 'cargo'));
    selectedCargo = await toolchain('stable-1.96.0');
    olderCargo = await toolchain('1.85.0');
    vi.stubEnv('PATH', [proxyDirectory, dirname(olderCargo)].join(delimiter));
    queryResult(`${selectedCargo}\n`);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('keeps the first Rustup proxy authoritative over a later older Cargo', async () => {
    const result = await resolveTrustedCargo(workspaceRoot, workspaceRoot, runtimeDirectory);
    expect(result).toEqual({
      path: selectedCargo,
      root: dirname(dirname(selectedCargo)),
      searchDirectory: dirname(selectedCargo),
    });
    expect(result.path).not.toBe(olderCargo);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('asks Rustup from the actual nested cwd so its project pin is honored', async () => {
    const nested = join(workspaceRoot, 'crate');
    await mkdir(nested);
    await writeFile(join(nested, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.85.0"\n');
    queryResult(`${olderCargo}\n`);
    expect(await resolveTrustedCargo(workspaceRoot, nested, runtimeDirectory)).toMatchObject({
      path: olderCargo,
    });
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({ cwd: nested });
  });

  it('reports an unavailable selected toolchain without trying an installed older compiler', async () => {
    await writeFile(join(workspaceRoot, 'rust-toolchain'), '1.99.0\n');
    queryResult('', 1, 'error: toolchain 1.99.0 is not installed\n');
    await expect(
      resolveTrustedCargo(workspaceRoot, workspaceRoot, runtimeDirectory),
    ).rejects.toThrow('no different toolchain was substituted');
    expect(spawn).toHaveBeenCalledOnce();
  });

  it.each([
    'sandbox-exec: sandbox_apply: Operation not permitted\n',
    'sandbox_init: Operation not permitted\n',
  ])(
    'distinguishes selector sandbox initialization failure %j from a missing toolchain',
    async (error) => {
      queryResult('', 1, error);
      const execution = resolveTrustedCargo(workspaceRoot, workspaceRoot, runtimeDirectory);
      await expect(execution).rejects.toThrow('[RUST_TOOLCHAIN_SANDBOX_UNAVAILABLE]');
      await expect(execution).rejects.not.toThrow('directory override');
      expect(spawn).toHaveBeenCalledOnce();
    },
  );

  it('uses a private Rustup identity for Homebrew rustup-init aliases', async () => {
    await rm(join(proxyDirectory, 'cargo'));
    const rustupInit = await executable(join(proxyDirectory, 'rustup-init'));
    await symlink(rustupInit, join(proxyDirectory, 'cargo'));
    await resolveTrustedCargo(workspaceRoot, workspaceRoot, runtimeDirectory);
    const args = vi.mocked(spawn).mock.calls[0]?.[1] as readonly string[];
    expect(args.slice(-3)).toEqual([
      join(runtimeDirectory, 'rustup-selector', 'rustup'),
      'which',
      'cargo',
    ]);
    expect(await realpath(args[args.length - 3]!)).toBe(rustupInit);
  });

  it('runs a bounded offline selector without provider keys or host Cargo credentials', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'not-for-the-selector');
    vi.stubEnv('RUSTUP_TOOLCHAIN', 'not-inherited-by-the-developer-shell');
    await resolveTrustedCargo(workspaceRoot, workspaceRoot, runtimeDirectory);
    const [command, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(command).toBe('/usr/bin/sandbox-exec');
    expect(args).toContain(`CARGO_TOOL_HOME=${join(runtimeDirectory, 'rustup-selector')}`);
    const profile = args?.[args.indexOf('-p') + 1] ?? '';
    for (const match of profile.matchAll(/\(param "([A-Z_0-9]+)"\)/gu)) {
      expect(args?.some((arg) => arg.startsWith(`${match[1]}=`))).toBe(true);
    }
    expect(args).toContain(`PACKAGE_MANAGER_ROOT=${join(runtimeDirectory, 'rustup-selector')}`);
    expect(args).toContain(`RUSTUP_SETTINGS=${join(homedir(), '.rustup', 'settings.toml')}`);
    expect(options).toMatchObject({
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        HOME: join(runtimeDirectory, 'rustup-selector'),
        CARGO_HOME: join(runtimeDirectory, 'rustup-selector'),
        RUSTUP_HOME: join(homedir(), '.rustup'),
        RUSTUP_AUTO_INSTALL: '0',
      },
    });
    expect(options?.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(options?.env).not.toHaveProperty('RUSTUP_TOOLCHAIN');
    expect(terminateProcessGroup).toHaveBeenCalledWith(8_000_001, 'SIGKILL');
  });

  it('retains a real first PATH toolchain without invoking Rustup', async () => {
    vi.stubEnv('PATH', [dirname(olderCargo), proxyDirectory].join(delimiter));
    expect(await resolveTrustedCargo(workspaceRoot, workspaceRoot, runtimeDirectory)).toEqual({
      path: olderCargo,
      root: dirname(dirname(olderCargo)),
      searchDirectory: dirname(olderCargo),
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a Cargo path returned inside the writable workspace', async () => {
    const localCargo = await executable(join(workspaceRoot, 'bin', 'cargo'));
    queryResult(`${localCargo}\n`);
    await expect(
      resolveTrustedCargo(workspaceRoot, workspaceRoot, runtimeDirectory),
    ).rejects.toThrow('workspace-boundary');
  });

  it('rejects Cargo and rustc that resolve to different toolchains', async () => {
    const selectedRustc = join(dirname(selectedCargo), 'rustc');
    await rm(selectedRustc);
    await symlink(join(dirname(olderCargo), 'rustc'), selectedRustc);
    await expect(
      resolveTrustedCargo(workspaceRoot, workspaceRoot, runtimeDirectory),
    ).rejects.toThrow('same trusted toolchain');
  });

  it('validates project pin files before the selection subprocess starts', async () => {
    const outside = join(temporaryDirectory, 'outside-pin');
    await writeFile(outside, 'stable\n');
    await symlink(outside, join(workspaceRoot, 'rust-toolchain'));
    await expect(
      resolveTrustedCargo(workspaceRoot, workspaceRoot, runtimeDirectory),
    ).rejects.toThrow('regular, single-link');
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['relative/cargo\n', '/one/cargo\n/two/cargo\n', '\n'])(
    'rejects a malformed selector result %j',
    async (output) => {
      queryResult(output);
      await expect(
        resolveTrustedCargo(workspaceRoot, workspaceRoot, runtimeDirectory),
      ).rejects.toThrow('one absolute Cargo executable path');
    },
  );

  it('stops a selector that exceeds the total 16 KiB output budget', async () => {
    queryResult('x'.repeat(12 * 1024 + 1));
    await expect(
      resolveTrustedCargo(workspaceRoot, workspaceRoot, runtimeDirectory),
    ).rejects.toThrow('bounded output');
    expect(terminateProcessGroup).toHaveBeenCalledWith(8_000_001, 'SIGTERM');
  });

  it('bounds a stalled selector to five seconds and cleans its process group', async () => {
    vi.useFakeTimers();
    const started = pendingQuery();
    const execution = resolveTrustedCargo(workspaceRoot, workspaceRoot, runtimeDirectory);
    const expected = expect(execution).rejects.toThrow('timed out after 5 seconds');
    await started;
    await vi.advanceTimersByTimeAsync(5_000);
    await expected;
    expect(terminateProcessGroup).toHaveBeenCalledWith(8_000_001, 'SIGTERM');
    expect(terminateProcessGroup).toHaveBeenCalledWith(8_000_001, 'SIGKILL');
  });

  it('cancels a running selector without returning an alternative compiler', async () => {
    const controller = new AbortController();
    const started = pendingQuery();
    const execution = resolveTrustedCargo(
      workspaceRoot,
      workspaceRoot,
      runtimeDirectory,
      controller.signal,
    );
    const expected = expect(execution).rejects.toThrow('selection was cancelled');
    await started;
    controller.abort();
    await expected;
    expect(terminateProcessGroup).toHaveBeenCalledWith(8_000_001, 'SIGTERM');
  });

  it('keeps project pins read-only during toolchain selection', () => {
    const profile = rustupQuerySandboxProfile();
    const writes = profile.slice(
      profile.indexOf('(allow file-write*'),
      profile.indexOf('(deny file-read-data file-map-executable)'),
    );
    expect(writes).not.toContain('WORKSPACE');
    expect(writes).toContain('RUNTIME');
    expect(writes).toContain('CARGO_HOME');
    expect(profile).toContain(
      '(allow file-read-data file-map-executable\n  (subpath (param "WORKSPACE"))',
    );
  });

  it('keeps host-secret denials after the narrow Rustup allowances', () => {
    const profile = rustupQuerySandboxProfile();
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain('(deny file-link)');
    expect(profile).toContain('(deny file-write*)');
    expect(profile.indexOf('(literal (param "RUSTUP_EXECUTABLE"))')).toBeLessThan(
      profile.indexOf('(subpath (param "USER_SSH"))'),
    );
  });
});
