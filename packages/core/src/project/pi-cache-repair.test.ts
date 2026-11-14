import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectExecInputSchema, type ProjectExecInput } from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatSpliceError } from '../errors.js';
import { WorkspaceService } from '../workspace/service.js';
import { SqliteWorkspaceRepository } from '../workspace/sqlite-repository.js';
import { executeProjectOperation } from './pi-execution.js';
import type * as TrustedModule from './pi-trusted.js';
import type { PreparedOperation, ProcessResult } from './pi-types.js';

const harness = vi.hoisted(() => ({
  execute: vi.fn(),
  prepare: vi.fn(),
  begin: vi.fn(),
  publish: vi.fn(),
  invokeCommand: true,
  afterCommand: undefined as (() => void) | undefined,
}));

vi.mock('./cargo-cache.js', () => ({
  prepareManagedCargoCache: harness.prepare,
  beginCargoCacheRepair: harness.begin,
  publishCargoCacheRepair: harness.publish,
}));

// This suite exercises orchestration; native runtime placement is tested separately.
vi.mock('./runtime-directory.js', () => ({
  createProjectRuntimeDirectory: () => mkdtemp(join(tmpdir(), 'cs-unit-exec-')),
}));

vi.mock('./pi-sandbox.js', () => ({
  SANDBOX_EXECUTABLE: '/usr/bin/sandbox-exec',
  executeSandboxedCommand: harness.execute,
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createBashTool: (
    cwd: string,
    configuration: {
      operations: {
        exec: (
          command: string,
          cwd: string,
          options: { signal?: AbortSignal; onData: (data: Buffer) => void },
        ) => Promise<unknown>;
      };
    },
  ) => ({
    execute: async (_id: string, input: { command: string }, signal?: AbortSignal) => {
      if (!harness.invokeCommand) return {};
      await configuration.operations.exec(input.command, cwd, {
        ...(signal === undefined ? {} : { signal }),
        onData: () => undefined,
      });
      harness.afterCommand?.();
      return {};
    },
  }),
}));

vi.mock('./pi-prepare.js', () => ({
  prepareOperation: (
    _input: ProjectExecInput,
    canonicalRoot: string,
    _cwd: string,
    runtimeDirectory: string,
    cargoHome: string,
    corepackCache: string,
  ): Promise<PreparedOperation> =>
    Promise.resolve({
      command: 'cargo fetch --locked',
      args: ['fetch', '--locked'],
      usedNetwork: true,
      executable: { path: '/usr/bin/true', root: '/usr' },
      workspaceRoot: canonicalRoot,
      runtimeDirectory,
      cargoHome,
      corepackCache,
    }),
}));

vi.mock('./pi-trusted.js', async (importOriginal) => {
  const actual = await importOriginal<typeof TrustedModule>();
  return {
    ...actual,
    nodeRuntimeVersionSupported: () => true,
    resolveTrustedExecutable: (path: string) => Promise.resolve({ path, root: '/usr' }),
    revalidateTrustedExecutables: () => Promise.resolve(),
  };
});

describe('explicit Cargo cache repair orchestration', () => {
  let temporary: string;
  let root: string;
  let toolHome: string;
  let cargoHome: string;
  let previousCargoHome: string;
  let repair: { cargoHome: string; toolHome: string; previousCargoHome: string };
  let repository: SqliteWorkspaceRepository;
  let workspaces: WorkspaceService;
  let workspaceId: string;
  let platform: PropertyDescriptor;

  beforeEach(async () => {
    platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    temporary = await realpath(await mkdtemp(join(tmpdir(), 'cs-cache-orchestration-')));
    root = join(temporary, 'workspace');
    toolHome = join(temporary, 'tool-home');
    cargoHome = join(temporary, 'new-cargo-home');
    previousCargoHome = join(temporary, 'old-cargo-home');
    await Promise.all([root, toolHome, cargoHome, previousCargoHome].map((path) => mkdir(path)));
    repair = { cargoHome, toolHome, previousCargoHome };
    repository = new SqliteWorkspaceRepository(join(temporary, 'state.sqlite'));
    workspaces = new WorkspaceService(repository);
    workspaceId = (await workspaces.register({ root_path: root })).workspace_id;
    harness.invokeCommand = true;
    harness.afterCommand = undefined;
    harness.execute.mockReset().mockResolvedValue({ exitCode: 0, timedOut: false, aborted: false });
    harness.prepare.mockReset().mockResolvedValue({ cargoHome: previousCargoHome, toolHome });
    harness.begin.mockReset().mockResolvedValue(repair);
    harness.publish.mockReset().mockResolvedValue({ cargoHome, toolHome });
  });

  afterEach(async () => {
    Object.defineProperty(process, 'platform', platform);
    repository.close();
    await rm(temporary, { recursive: true, force: true });
  });

  function run(signal?: AbortSignal, repairCache = true) {
    return executeProjectOperation(
      workspaces,
      ProjectExecInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: `wb_${'a'.repeat(64)}`,
        request_id: 'cache-repair-orchestration',
        operation: {
          kind: 'install',
          ecosystem: 'rust',
          mode: 'locked',
          repair_cache: repairCache,
        },
        timeout_ms: 30_000,
      }),
      signal === undefined ? {} : { signal },
    );
  }

  it('publishes the fresh cache only after the actual locked fetch succeeds and retains the tool home', async () => {
    expect(await run()).toMatchObject({
      exit_code: 0,
      timed_out: false,
      cargo_cache_repaired: true,
    });
    expect(harness.begin).toHaveBeenCalledOnce();
    expect(harness.publish).toHaveBeenCalledOnce();
    expect(harness.publish.mock.calls[0]?.[0]).toBe(repair);
    expect(harness.publish.mock.calls[0]?.[1]).toEqual({
      exitCode: 0,
      timedOut: false,
      aborted: false,
    });
    const prepared = harness.execute.mock.calls[0]?.[3] as PreparedOperation;
    expect(prepared.cargoHome).toBe(cargoHome);
    expect(prepared.cargoToolHome).toBe(toolHome);
    expect(harness.execute.mock.invocationCallOrder[0]).toBeLessThan(
      harness.publish.mock.invocationCallOrder[0]!,
    );
  });

  it.each<ProcessResult>([
    { exitCode: 101, timedOut: false, aborted: false },
    { exitCode: null, timedOut: true, aborted: false },
    { exitCode: null, timedOut: false, aborted: true },
  ])('preserves a failed or interrupted fetch result without publishing: %j', async (result) => {
    harness.execute.mockResolvedValue(result);
    const response = await run();
    expect(response).toMatchObject({ exit_code: result.exitCode, timed_out: result.timedOut });
    expect(response).not.toHaveProperty('cargo_cache_repaired');
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('does not publish when cancellation arrives after fetch exits but before publication', async () => {
    const controller = new AbortController();
    harness.afterCommand = () => controller.abort();
    await run(controller.signal).then(
      (result) => expect(result).not.toHaveProperty('cargo_cache_repaired'),
      (error: unknown) => expect(error).toMatchObject({ name: 'AbortError' }),
    );
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('refuses to mark repair successful when the SDK returns without executing the command', async () => {
    harness.invokeCommand = false;
    await expect(run()).rejects.toThrow();
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('surfaces failed publication instead of reporting a successful repair', async () => {
    harness.publish.mockRejectedValue(new ChatSpliceError('BAD_REQUEST', 'selection changed'));
    await expect(run()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'selection changed',
    });
    expect(harness.execute).toHaveBeenCalledOnce();
    expect(harness.publish).toHaveBeenCalledOnce();
  });

  it('keeps ordinary install on the selected cache without creating or publishing a generation', async () => {
    const result = await run(undefined, false);
    expect(result).toMatchObject({ exit_code: 0 });
    expect(result).not.toHaveProperty('cargo_cache_repaired');
    expect(harness.prepare).toHaveBeenCalledOnce();
    expect(harness.begin).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
    const prepared = harness.execute.mock.calls[0]?.[3] as PreparedOperation;
    expect(prepared.cargoHome).toBe(previousCargoHome);
    expect(prepared.cargoToolHome).toBe(toolHome);
  });
});
