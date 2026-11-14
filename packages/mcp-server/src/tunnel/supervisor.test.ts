import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteSettingsRepository } from '@chatsplice/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TunnelSupervisor, buildTunnelEnvironment } from './supervisor.js';

const configuration = {
  tunnel_id: 'tunnel_0123456789abcdef',
  organization_id: 'org-0123456789abcdef',
  executable_path: '/tmp/tunnel-client',
  automatic_start: true,
} as const;
const RUNTIME_API_KEY = 'sk-runtime-secret-value';

function fakeChild(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  Object.assign(emitter, {
    exitCode: null,
    stdout: { resume: () => undefined },
    stderr: { resume: () => undefined },
    kill: () => {
      Object.assign(emitter, { exitCode: 0 });
      emitter.emit('exit', 0, null);
      return true;
    },
  });
  return emitter;
}

describe('TunnelSupervisor', () => {
  const cleanupDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('keeps the runtime credential out of argv and passes only file-referenced MCP auth', () => {
    const environment = buildTunnelEnvironment(
      configuration,
      RUNTIME_API_KEY,
      'http://127.0.0.1:3333/mcp',
      '/tmp/mcp-token',
      '/tmp/health-url',
      { PATH: '/usr/bin' },
    );
    expect(environment.CONTROL_PLANE_API_KEY).toBe(RUNTIME_API_KEY);
    expect(environment.MCP_EXTRA_HEADERS).toBe('x-chatsplice-token: file:/tmp/mcp-token');
    expect(JSON.stringify(configuration)).not.toContain(RUNTIME_API_KEY);
  });

  it('launches the installed binary as a managed child with only the run argument', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-tunnel-supervisor-'));
    cleanupDirectories.push(temporaryDirectory);
    const executablePath = join(temporaryDirectory, 'tunnel-client');
    await writeFile(executablePath, '#!/bin/sh\nexit 0\n');
    await chmod(executablePath, 0o700);
    const repository = new SqliteSettingsRepository(join(temporaryDirectory, 'state.sqlite'));
    repository.setTunnelConfiguration({ ...configuration, executable_path: executablePath });
    let observedArguments: readonly string[] = [];
    let observedOptions: SpawnOptions | undefined;
    const child = fakeChild();
    const supervisor = new TunnelSupervisor({
      dataDirectory: temporaryDirectory,
      mcpUrl: 'http://127.0.0.1:3333/mcp',
      tokenPath: join(temporaryDirectory, 'mcp-token'),
      settingsRepository: repository,
      spawnProcess: (_command, arguments_, options) => {
        observedArguments = arguments_;
        observedOptions = options;
        return child;
      },
      probeHealth: async () => {
        throw new Error('not running');
      },
    });
    try {
      const status = await supervisor.start({ runtime_api_key: RUNTIME_API_KEY });
      expect(observedArguments).toEqual(['run']);
      expect(observedArguments).not.toContain(RUNTIME_API_KEY);
      expect(observedOptions?.shell).toBe(false);
      expect(status.mode).toBe('managed');
      expect(status.state).toBe('starting');
    } finally {
      await supervisor.close();
      repository.close();
    }
  });

  it('does not spawn a deferred start after stop supersedes its refresh', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-tunnel-supervisor-race-'));
    cleanupDirectories.push(temporaryDirectory);
    const executablePath = join(temporaryDirectory, 'tunnel-client');
    await writeFile(executablePath, '#!/bin/sh\nexit 0\n');
    await chmod(executablePath, 0o700);
    const repository = new SqliteSettingsRepository(join(temporaryDirectory, 'state.sqlite'));
    repository.setTunnelConfiguration({ ...configuration, executable_path: executablePath });
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let probeStarted!: () => void;
    const probeStartedPromise = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    let spawnCount = 0;
    const supervisor = new TunnelSupervisor({
      dataDirectory: temporaryDirectory,
      mcpUrl: 'http://127.0.0.1:3333/mcp',
      tokenPath: join(temporaryDirectory, 'mcp-token'),
      settingsRepository: repository,
      spawnProcess: () => {
        spawnCount += 1;
        return fakeChild();
      },
      probeHealth: async () => {
        probeStarted();
        await probeGate;
        return {
          healthy: false,
          ready: false,
          tunnelId: null,
          mcpUrl: null,
          errorCode: null,
        };
      },
    });
    try {
      const startPromise = supervisor.start({ runtime_api_key: RUNTIME_API_KEY });
      await probeStartedPromise;
      const stopPromise = supervisor.stop();
      releaseProbe();
      await expect(stopPromise).resolves.toMatchObject({ state: 'stopped' });
      await expect(startPromise).resolves.toMatchObject({ state: 'stopped' });
      expect(spawnCount).toBe(0);
    } finally {
      await supervisor.close();
      repository.close();
    }
  });

  it('does not let a stale configure overwrite a newer configuration while stopping', async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'chatsplice-tunnel-supervisor-config-'),
    );
    cleanupDirectories.push(temporaryDirectory);
    const executablePath = join(temporaryDirectory, 'tunnel-client');
    await writeFile(executablePath, '#!/bin/sh\nexit 0\n');
    await chmod(executablePath, 0o700);
    const repository = new SqliteSettingsRepository(join(temporaryDirectory, 'state.sqlite'));
    repository.setTunnelConfiguration({ ...configuration, executable_path: executablePath });
    const child = new EventEmitter() as ChildProcess;
    let releaseStop!: () => void;
    const stopRequested = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    Object.assign(child, {
      exitCode: null,
      stdout: { resume: () => undefined },
      stderr: { resume: () => undefined },
      kill: () => {
        releaseStop();
        return true;
      },
    });
    const supervisor = new TunnelSupervisor({
      dataDirectory: temporaryDirectory,
      mcpUrl: 'http://127.0.0.1:3333/mcp',
      tokenPath: join(temporaryDirectory, 'mcp-token'),
      settingsRepository: repository,
      spawnProcess: () => child,
      probeHealth: async () => {
        throw new Error('not running');
      },
    });
    const firstConfiguration = {
      ...configuration,
      executable_path: executablePath,
      tunnel_id: 'tunnel_aaaaaaaaaaaaaaaa',
    };
    const secondConfiguration = {
      ...configuration,
      executable_path: executablePath,
      tunnel_id: 'tunnel_bbbbbbbbbbbbbbbb',
    };
    try {
      await supervisor.start({ runtime_api_key: RUNTIME_API_KEY });
      const firstConfigure = supervisor.configure(firstConfiguration);
      await stopRequested;
      const secondStatus = await supervisor.configure(secondConfiguration);
      expect(secondStatus.configuration?.tunnel_id).toBe(secondConfiguration.tunnel_id);
      Object.assign(child, { exitCode: 0 });
      child.emit('exit', 0, null);
      await expect(firstConfigure).resolves.toMatchObject({
        configuration: { tunnel_id: secondConfiguration.tunnel_id },
      });
      expect(repository.getTunnelConfiguration()?.tunnel_id).toBe(secondConfiguration.tunnel_id);
    } finally {
      await supervisor.close();
      repository.close();
    }
  });

  it('runs an output-free, fixed-argv doctor preflight without changing tunnel state', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-tunnel-doctor-'));
    cleanupDirectories.push(temporaryDirectory);
    const executablePath = join(temporaryDirectory, 'tunnel-client');
    await writeFile(executablePath, '#!/bin/sh\nexit 0\n');
    await chmod(executablePath, 0o700);
    const repository = new SqliteSettingsRepository(join(temporaryDirectory, 'state.sqlite'));
    repository.setTunnelConfiguration({ ...configuration, executable_path: executablePath });
    let observedArguments: readonly string[] = [];
    let observedOptions: SpawnOptions | undefined;
    const child = fakeChild();
    const supervisor = new TunnelSupervisor({
      dataDirectory: temporaryDirectory,
      mcpUrl: 'http://127.0.0.1:3333/mcp',
      tokenPath: join(temporaryDirectory, 'mcp-token'),
      settingsRepository: repository,
      spawnProcess: (_command, arguments_, options) => {
        observedArguments = arguments_;
        observedOptions = options;
        queueMicrotask(() => child.emit('exit', 0, null));
        return child;
      },
      probeHealth: async () => {
        throw new Error('not running');
      },
    });
    try {
      await expect(supervisor.doctor({ runtime_api_key: RUNTIME_API_KEY })).resolves.toEqual({
        state: 'passed',
        error_code: null,
      });
      expect(observedArguments).toEqual(['doctor', '--explain']);
      expect(observedArguments).not.toContain(RUNTIME_API_KEY);
      expect(observedOptions?.shell).toBe(false);
      expect(observedOptions?.stdio).toBe('ignore');
      expect(supervisor.status().state).toBe('stopped');
    } finally {
      await supervisor.close();
      repository.close();
    }
  });
  it.each(['throw', 'event'] as const)(
    'contains %s spawn errors and cancels automatic recovery on Stop',
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), 'chatsplice-tunnel-launch-error-'));
      cleanupDirectories.push(directory);
      const executable = join(directory, 'tunnel-client');
      await writeFile(executable, '#!/bin/sh\nexit 0\n');
      await chmod(executable, 0o700);
      const repository = new SqliteSettingsRepository(join(directory, 'state.sqlite'));
      repository.setTunnelConfiguration({ ...configuration, executable_path: executable });
      const child = fakeChild();
      let attempts = 0;
      const supervisor = new TunnelSupervisor({
        dataDirectory: directory,
        mcpUrl: 'http://127.0.0.1:3333/mcp',
        tokenPath: join(directory, 'mcp-token'),
        settingsRepository: repository,
        probeHealth: async () => {
          throw new Error('offline');
        },
        spawnProcess: () => {
          attempts += 1;
          if (mode === 'throw') throw new Error('secret must not leak');
          return child;
        },
      });
      try {
        if (mode === 'throw') {
          await expect(
            supervisor.start({ runtime_api_key: RUNTIME_API_KEY }),
          ).resolves.toMatchObject({ state: 'failed', error_code: 'tunnel_client_launch_failed' });
        } else {
          await supervisor.start({ runtime_api_key: RUNTIME_API_KEY });
          expect(() => child.emit('error', new Error('secret must not leak'))).not.toThrow();
          expect(supervisor.status()).toMatchObject({
            state: 'failed',
            error_code: 'tunnel_client_launch_failed',
          });
        }
        vi.useFakeTimers();
        await supervisor.stop();
        await vi.advanceTimersByTimeAsync(35_000);
        expect(attempts).toBe(1);
        expect(JSON.stringify(supervisor.status())).not.toContain('secret');
      } finally {
        vi.useRealTimers();
        await supervisor.close();
        repository.close();
      }
    },
  );

  it('installs a missing client automatically and does not launch after Stop during installation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chatsplice-tunnel-auto-install-'));
    cleanupDirectories.push(directory);
    const repository = new SqliteSettingsRepository(join(directory, 'state.sqlite'));
    repository.setTunnelConfiguration({
      ...configuration,
      executable_path: join(directory, 'missing'),
    });
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const installationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let spawns = 0;
    const supervisor = new TunnelSupervisor({
      dataDirectory: directory,
      mcpUrl: 'http://127.0.0.1:3333/mcp',
      tokenPath: join(directory, 'mcp-token'),
      settingsRepository: repository,
      probeHealth: async () => {
        throw new Error('offline');
      },
      spawnProcess: () => {
        spawns += 1;
        return fakeChild();
      },
      installClient: async () => {
        started();
        await gate;
        return {
          status: 'installed',
          version: 'v-test',
          executable_path: join(directory, 'installed'),
          error_code: null,
        };
      },
    });
    try {
      const starting = supervisor.start({ runtime_api_key: RUNTIME_API_KEY });
      await installationStarted;
      await supervisor.stop();
      release();
      await starting;
      expect(spawns).toBe(0);
      expect(supervisor.status().state).toBe('stopped');
      expect(repository.getTunnelConfiguration()?.executable_path).toBe(join(directory, 'missing'));
    } finally {
      release();
      await supervisor.close();
      repository.close();
    }
  });
  it('recovers from a client exit automatically using the saved in-memory credential', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chatsplice-tunnel-restart-'));
    cleanupDirectories.push(directory);
    const executable = join(directory, 'tunnel-client');
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o700);
    const repository = new SqliteSettingsRepository(join(directory, 'state.sqlite'));
    repository.setTunnelConfiguration({ ...configuration, executable_path: executable });
    const children: ChildProcess[] = [];
    const supervisor = new TunnelSupervisor({
      dataDirectory: directory,
      mcpUrl: 'http://127.0.0.1:3333/mcp',
      tokenPath: join(directory, 'mcp-token'),
      settingsRepository: repository,
      probeHealth: async () => {
        throw new Error('offline');
      },
      spawnProcess: (_command, _args, options) => {
        expect(options.env?.CONTROL_PLANE_API_KEY).toBe(RUNTIME_API_KEY);
        const child = fakeChild();
        children.push(child);
        return child;
      },
    });
    try {
      await supervisor.start({ runtime_api_key: RUNTIME_API_KEY });
      children[0]!.emit('exit', 1);
      await vi.waitFor(() => expect(children).toHaveLength(2), { timeout: 3_000 });
      expect(supervisor.status()).toMatchObject({ mode: 'managed', state: 'starting' });
    } finally {
      await supervisor.close();
      repository.close();
    }
  });

  it('installs a missing configured client before launching and saves the repaired path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chatsplice-tunnel-install-repair-'));
    cleanupDirectories.push(directory);
    const executable = join(directory, 'tunnel-client');
    const repository = new SqliteSettingsRepository(join(directory, 'state.sqlite'));
    repository.setTunnelConfiguration({
      ...configuration,
      executable_path: join(directory, 'missing'),
    });
    let installations = 0;
    let spawns = 0;
    const supervisor = new TunnelSupervisor({
      dataDirectory: directory,
      mcpUrl: 'http://127.0.0.1:3333/mcp',
      tokenPath: join(directory, 'mcp-token'),
      settingsRepository: repository,
      probeHealth: async () => {
        throw new Error('offline');
      },
      spawnProcess: () => {
        spawns += 1;
        return fakeChild();
      },
      installClient: async () => {
        installations += 1;
        await writeFile(executable, '#!/bin/sh\nexit 0\n');
        await chmod(executable, 0o700);
        return {
          status: 'installed',
          version: 'v-test',
          executable_path: executable,
          error_code: null,
        };
      },
    });
    try {
      expect((await supervisor.start({ runtime_api_key: RUNTIME_API_KEY })).state).toBe('starting');
      expect(installations).toBe(1);
      expect(spawns).toBe(1);
      expect(repository.getTunnelConfiguration()?.executable_path).toBe(await realpath(executable));
    } finally {
      await supervisor.close();
      repository.close();
    }
  });
});
