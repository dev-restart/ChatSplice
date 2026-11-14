import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ProjectExecInputSchema,
  type ProjectExecInput,
  type ProjectExecOperation,
} from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceService } from '../workspace/service.js';
import { SqliteWorkspaceRepository } from '../workspace/sqlite-repository.js';
import { executeProjectOperation } from './pi-execution.js';
import { prepareCargoHome } from './pi-trusted.js';
import type * as TrustedModule from './pi-trusted.js';
import type { PreparedOperation } from './pi-types.js';

const boundary = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock('./pi-sandbox.js', () => ({
  SANDBOX_EXECUTABLE: '/usr/bin/sandbox-exec',
  executeSandboxedCommand: boundary.execute,
}));

// These tests exercise cache ownership and lifecycle, not executable discovery
// or macOS kernel enforcement. Only the command launch/preparation is replaced.
vi.mock('./pi-prepare.js', () => ({
  prepareOperation: (
    input: ProjectExecInput,
    canonicalRoot: string,
    _cwd: string,
    runtimeDirectory: string,
    cargoHome: string,
    corepackCache: string,
  ): Promise<PreparedOperation> =>
    Promise.resolve({
      command: `fixture-${input.operation.kind}`,
      args: [],
      usedNetwork: false,
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
  };
});

describe('Cargo cache lifecycle across command operations', () => {
  let temporaryDirectory: string;
  let root: string;
  let repository: SqliteWorkspaceRepository;
  let service: WorkspaceService;
  let workspaceId: string;
  let requestNumber: number;
  let platformDescriptor: PropertyDescriptor;
  let ownedCaches: Set<string>;

  beforeEach(async () => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
    temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'cs-cargo-cache-test-')));
    root = join(temporaryDirectory, 'workspace');
    await mkdir(root);
    repository = new SqliteWorkspaceRepository(join(temporaryDirectory, 'state.sqlite'));
    service = new WorkspaceService(repository);
    workspaceId = (await service.register({ root_path: root })).workspace_id;
    requestNumber = 0;
    ownedCaches = new Set([await prepareCargoHome(root)]);
    boundary.execute.mockReset();
  });

  afterEach(async () => {
    Object.defineProperty(process, 'platform', platformDescriptor);
    repository.close();
    for (const cache of ownedCaches) await rm(cache, { recursive: true, force: true });
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  async function run(operation: ProjectExecOperation, targetWorkspaceId = workspaceId) {
    requestNumber += 1;
    return executeProjectOperation(
      service,
      ProjectExecInputSchema.parse({
        workspace_id: targetWorkspaceId,
        workspace_binding: `wb_${'a'.repeat(64)}`,
        request_id: `cache-compat-${requestNumber}`,
        timeout_ms: 30_000,
        operation,
      }),
    );
  }

  it('keeps shell dependencies available to later shell, Node and dedicated Cargo jobs', async () => {
    const homes: string[] = [];
    const runtimes: string[] = [];
    boundary.execute.mockImplementation(
      async (
        _command: string,
        _cwd: string,
        _input: ProjectExecInput,
        prepared: PreparedOperation,
      ) => {
        const registry = join(prepared.cargoHome, 'registry');
        const marker = join(registry, 'fixture-cache');
        if (homes.length === 0) {
          await mkdir(registry, { recursive: true });
          await writeFile(marker, 'available-after-job-cleanup');
        } else {
          expect(await readFile(marker, 'utf8')).toBe('available-after-job-cleanup');
        }
        homes.push(prepared.cargoHome);
        runtimes.push(prepared.runtimeDirectory);
        return { exitCode: 0, timedOut: false, aborted: false };
      },
    );
    const operations: ProjectExecOperation[] = [
      { kind: 'shell', command: 'cargo fetch', network: 'enabled' },
      { kind: 'shell', command: 'cargo check --offline', network: 'local' },
      { kind: 'node_script', script: 'check' },
      { kind: 'cargo', task: 'check' },
      { kind: 'install', ecosystem: 'rust', mode: 'resolve' },
      { kind: 'install', ecosystem: 'node', mode: 'resolve' },
    ];
    for (const operation of operations) {
      expect(await run(operation)).toMatchObject({ exit_code: 0, timed_out: false });
    }
    expect(new Set(homes).size).toBe(1);
    expect(new Set(runtimes).size).toBe(operations.length);
    for (const runtime of runtimes) {
      await expect(stat(runtime)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await readFile(join(homes[0]!, 'registry', 'fixture-cache'), 'utf8')).toBe(
      'available-after-job-cleanup',
    );
  });

  it('assigns a separate persisted dependency cache to another project', async () => {
    boundary.execute.mockImplementation(
      async (
        _command: string,
        _cwd: string,
        input: ProjectExecInput,
        prepared: PreparedOperation,
      ) => {
        ownedCaches.add(prepared.cargoHome);
        const marker = join(prepared.cargoHome, 'fixture-cache');
        if (input.workspace_id === workspaceId) await writeFile(marker, 'first-project');
        else await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        return { exitCode: 0, timedOut: false, aborted: false };
      },
    );
    expect(await run({ kind: 'shell', command: 'fixture', network: 'local' })).toMatchObject({
      exit_code: 0,
    });
    const otherRoot = join(temporaryDirectory, 'other-workspace');
    await mkdir(otherRoot);
    const otherId = (await service.register({ root_path: otherRoot })).workspace_id;
    expect(await run({ kind: 'cargo', task: 'check' }, otherId)).toMatchObject({ exit_code: 0 });
    expect(ownedCaches.size).toBe(2);
  });

  it.each(['config', 'config.toml', 'credentials', 'credentials.toml', 'credentials.toml.enc'])(
    'refuses persisted %s before executing a developer shell',
    async (name) => {
      const cache = await prepareCargoHome(root);
      await writeFile(join(cache, name), 'untrusted-persisted-state');
      await expect(
        run({ kind: 'shell', command: 'fixture', network: 'local' }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('Cargo cache configuration and credentials'),
      });
      expect(boundary.execute).not.toHaveBeenCalled();
      expect(await readFile(join(cache, name), 'utf8')).toBe('untrusted-persisted-state');
    },
  );
});
