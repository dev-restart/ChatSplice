import type * as ChildProcessModule from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { ProjectExecInputSchema, type ProjectExecOperation } from '@chatsplice/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareOperation } from './pi-prepare.js';
import { executeSandboxedCommand } from './pi-sandbox.js';
import type * as TrustedModule from './pi-trusted.js';
import type { TrustedExecutable } from './pi-types.js';

const mocked = vi.hoisted(() => ({
  node: vi.fn<(name: string, root: string) => Promise<TrustedExecutable>>(),
  cargo: vi.fn<() => Promise<TrustedExecutable>>(),
  spawn:
    vi.fn<
      (
        command: string,
        args: readonly string[],
        options: unknown,
      ) => ChildProcessModule.ChildProcess
    >(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  spawn: mocked.spawn,
}));

vi.mock('./pi-trusted.js', async (importOriginal) => ({
  ...(await importOriginal<typeof TrustedModule>()),
  fileIsRegular: vi.fn(async () => undefined),
  hasCargoLockfile: vi.fn(async () => true),
  validateCargoConfiguration: vi.fn(async () => undefined),
  resolveTrustedPathFromPath: mocked.node,
}));

vi.mock('./rust-toolchain.js', () => ({ resolveTrustedCargo: mocked.cargo }));

const workspace = '/Users/developer/projects/example';
const runtime = '/private/var/folders/test/T/job';
const cargoHome = '/private/var/folders/test/T/cargo-cache';
const corepackCache = '/Users/developer/Library/Caches/node/corepack';
const cargo: TrustedExecutable = {
  path: '/Users/developer/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo',
  root: '/Users/developer/.rustup/toolchains/stable-aarch64-apple-darwin',
};
const node: TrustedExecutable = {
  path: '/Users/developer/.nvm/versions/node/v24.18.0/bin/node',
  root: '/Users/developer/.nvm/versions/node/v24.18.0',
};

function input(operation: ProjectExecOperation) {
  return ProjectExecInputSchema.parse({
    workspace_id: `ws_${'a'.repeat(24)}`,
    workspace_binding: `wb_${'b'.repeat(64)}`,
    request_id: 'trusted-runtime-access-check',
    operation,
    cwd: '.',
    timeout_ms: 1_000,
  });
}

describe('trusted runtime access for Rust development commands', () => {
  beforeEach(() => {
    mocked.node.mockReset().mockResolvedValue(node);
    mocked.cargo.mockReset().mockResolvedValue(cargo);
    mocked.spawn.mockReset().mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        pid: undefined,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);
      });
      return child as unknown as ChildProcessModule.ChildProcess;
    });
  });

  it.each([
    { kind: 'cargo', task: 'test' },
    { kind: 'install', ecosystem: 'rust', mode: 'locked' },
    { kind: 'install', ecosystem: 'rust', mode: 'resolve' },
  ] as const)('prepares an installed trusted Node for $kind $mode', async (operation) => {
    const prepared = await prepareOperation(
      input(operation),
      workspace,
      workspace,
      runtime,
      cargoHome,
      corepackCache,
    );
    expect(mocked.node).toHaveBeenCalledTimes(1);
    expect(mocked.node).toHaveBeenCalledWith('node', workspace);
    expect(prepared.nodeRuntime).toEqual(node);
    expect(prepared.executable).toEqual(cargo);
  });

  it('keeps a pure Rust check available when no trusted Node is installed', async () => {
    mocked.node.mockRejectedValue(new Error('No trusted Node is available.'));
    const prepared = await prepareOperation(
      input({ kind: 'cargo', task: 'test' }),
      workspace,
      workspace,
      runtime,
      cargoHome,
      corepackCache,
    );
    expect(prepared.nodeRuntime).toBeUndefined();
    expect(prepared.args).toEqual(['test', '--offline', '--locked']);
  });

  it('passes trusted runtime roots and their directory ancestors to the actual command profile', async () => {
    const request = input({ kind: 'cargo', task: 'test' });
    const prepared = await prepareOperation(
      request,
      workspace,
      workspace,
      runtime,
      cargoHome,
      corepackCache,
    );
    const result = await executeSandboxedCommand(
      prepared.command,
      workspace,
      request,
      prepared,
      false,
      {},
      () => undefined,
    );
    expect(result.exitCode).toBe(0);
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
    const args = mocked.spawn.mock.calls[0]![1];
    const profile = args[args.indexOf('-p') + 1]!;
    expect(args).toContain(`NODE_RUNTIME_ROOT=${node.root}`);
    expect(args).toContain(`RUST_TOOLCHAIN_ROOT=${cargo.root}`);
    expect(args).toContain(`COREPACK_CACHE=${corepackCache}`);
    for (const directory of [
      '/Users/developer/.nvm',
      '/Users/developer/.nvm/versions',
      '/Users/developer/.nvm/versions/node',
      '/Users/developer/.rustup',
      '/Users/developer/.rustup/toolchains',
      '/Users/developer/Library/Caches',
      '/Users/developer/Library/Caches/node',
    ]) {
      expect(profile).toContain(`(literal ${JSON.stringify(directory)})`);
    }
    expect(profile).toContain('(vnode-type DIRECTORY)');
    expect(profile).not.toContain('(subpath "/Users/developer/.nvm")');
    expect(profile).not.toContain('(subpath "/Users/developer/Library")');
    const protectedPaths = profile.indexOf(
      '(deny file-read-data file-map-executable file-write* file-link',
    );
    expect(profile.indexOf('(literal "/Users/developer/.nvm")')).toBeLessThan(protectedPaths);
    const writeRules = profile.slice(
      profile.indexOf('(deny file-write*)'),
      profile.indexOf('(deny file-read-data file-map-executable)'),
    );
    expect(writeRules).not.toContain('NODE_RUNTIME_ROOT');
    expect(writeRules).not.toContain('RUST_TOOLCHAIN_ROOT');
    expect(writeRules).not.toContain('COREPACK_CACHE');
  });
});
