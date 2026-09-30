import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  TerminalPtyProcess,
  TerminalPtySpawnOptions,
  TerminalPtySpawner,
} from './terminal-service.js';
import {
  MAX_TERMINAL_REPLAY_BYTES,
  MAX_TERMINAL_SESSIONS_PER_WORKSPACE,
  TerminalService,
  terminalEnvironment,
  terminalShell,
} from './terminal-service.js';

const WORKSPACE_ID = `ws_${'a'.repeat(24)}`;

class FakePty implements TerminalPtyProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = false;
  readonly options: TerminalPtySpawnOptions;
  #dataListeners = new Set<(data: string) => void>();
  #exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  public constructor(options: TerminalPtySpawnOptions) {
    this.options = options;
  }

  public onData(listener: (data: string) => void) {
    this.#dataListeners.add(listener);
    return { dispose: () => this.#dataListeners.delete(listener) };
  }

  public onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.#exitListeners.add(listener);
    return { dispose: () => this.#exitListeners.delete(listener) };
  }

  public write(data: string): void {
    this.writes.push(data);
  }

  public resize(columns: number, rows: number): void {
    this.resizes.push([columns, rows]);
  }

  public kill(): void {
    this.killed = true;
    for (const listener of this.#exitListeners) listener({ exitCode: 0 });
  }

  public emitData(data: string): void {
    for (const listener of this.#dataListeners) listener(data);
  }

  public emitExit(): void {
    for (const listener of this.#exitListeners) listener({ exitCode: 0 });
  }
}

describe('TerminalService', () => {
  let workspaceRoot: string;
  let replacementRoot: string;
  let spawned: FakePty[];

  afterEach(async () => {
    if (workspaceRoot !== undefined) await rm(workspaceRoot, { recursive: true, force: true });
    if (replacementRoot !== undefined) await rm(replacementRoot, { recursive: true, force: true });
  });

  async function setup(): Promise<{
    service: TerminalService;
    setWorkspaceRoot: (root: string | undefined) => void;
  }> {
    workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), 'chatsplice-terminal-')));
    let registeredRoot: string | undefined = workspaceRoot;
    spawned = [];
    const spawnPty: TerminalPtySpawner = (_file, _args, options) => {
      const instance = new FakePty(options);
      spawned.push(instance);
      return instance;
    };
    const service = new TerminalService(
      {
        listWorkspaces: async () => ({
          workspaces:
            registeredRoot === undefined
              ? []
              : [
                  {
                    workspace_id: WORKSPACE_ID,
                    display_name: 'Workspace',
                    kind: 'user' as const,
                    created_at: '2026-09-08T00:00:00.000Z',
                    root_path: registeredRoot,
                  },
                ],
          count: registeredRoot === undefined ? 0 : 1,
        }),
      },
      spawnPty,
    );
    return {
      service,
      setWorkspaceRoot: (root) => {
        registeredRoot = root;
      },
    };
  }

  it('starts in the registered root, forwards input/resize, and replays bounded output', async () => {
    const { service } = await setup();
    const created = await service.createTerminalSession({
      workspace_id: WORKSPACE_ID,
      cols: 100,
      rows: 28,
    });
    const pty = spawned[0];
    expect(pty?.options.cwd).toBe(workspaceRoot);
    expect(created.state).toBe('shellrunning');
    expect(created.sequence).toBe(0);

    pty?.emitData('hello\r\n');
    await service.writeTerminalSession({
      workspace_id: WORKSPACE_ID,
      terminal_id: created.terminal_id,
      data: 'pwd\r',
    });
    await service.resizeTerminalSession({
      workspace_id: WORKSPACE_ID,
      terminal_id: created.terminal_id,
      cols: 120,
      rows: 31,
    });
    const replay = await service.readTerminalSession({
      workspace_id: WORKSPACE_ID,
      terminal_id: created.terminal_id,
      after_sequence: 0,
    });
    expect(replay.output).toContain('hello');
    expect(replay.sequence).toBe(1);
    expect(replay.replay_truncated).toBe(false);
    expect(pty?.writes).toEqual(['pwd\r']);
    expect(pty?.resizes).toEqual([[120, 31]]);

    await service.closeTerminalSession({
      workspace_id: WORKSPACE_ID,
      terminal_id: created.terminal_id,
    });
    expect(pty?.killed).toBe(true);
    await expect(
      service.readTerminalSession({
        workspace_id: WORKSPACE_ID,
        terminal_id: created.terminal_id,
      }),
    ).rejects.toThrow('Unknown terminal session');
  });

  it('marks replay truncation only when the requested sequence is no longer retained', async () => {
    const { service } = await setup();
    const created = await service.createTerminalSession({
      workspace_id: WORKSPACE_ID,
      cols: 120,
      rows: 30,
    });
    spawned[0]?.emitData('x'.repeat(MAX_TERMINAL_REPLAY_BYTES + 10));
    const current = await service.readTerminalSession({
      workspace_id: WORKSPACE_ID,
      terminal_id: created.terminal_id,
      after_sequence: 1,
    });
    expect(current.output).toBe('');
    expect(current.replay_truncated).toBe(false);

    spawned[0]?.emitData('y'.repeat(262_144));
    const replay = await service.readTerminalSession({
      workspace_id: WORKSPACE_ID,
      terminal_id: created.terminal_id,
      after_sequence: 0,
    });
    expect(replay.output.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(replay.output)).toBeLessThanOrEqual(MAX_TERMINAL_REPLAY_BYTES);
    expect(replay.replay_truncated).toBe(true);
  });

  it('keeps UTF-8 output on character boundaries while enforcing the byte cap', async () => {
    const { service } = await setup();
    const created = await service.createTerminalSession({
      workspace_id: WORKSPACE_ID,
      cols: 120,
      rows: 30,
    });
    spawned[0]?.emitData('가'.repeat(200_000));
    const replay = await service.readTerminalSession({
      workspace_id: WORKSPACE_ID,
      terminal_id: created.terminal_id,
      after_sequence: 0,
    });
    expect(Buffer.byteLength(replay.output)).toBeLessThanOrEqual(MAX_TERMINAL_REPLAY_BYTES);
    expect(replay.output).not.toContain('\uFFFD');
    expect(replay.replay_truncated).toBe(true);
  });

  it('removes sessions on workspace reroot/removal and enforces per-workspace caps', async () => {
    const { service, setWorkspaceRoot } = await setup();
    const sessions = [];
    for (let index = 0; index < MAX_TERMINAL_SESSIONS_PER_WORKSPACE; index += 1) {
      sessions.push(
        await service.createTerminalSession({ workspace_id: WORKSPACE_ID, cols: 120, rows: 30 }),
      );
    }
    await expect(
      service.createTerminalSession({ workspace_id: WORKSPACE_ID, cols: 120, rows: 30 }),
    ).rejects.toThrow('workspace has reached');

    replacementRoot = await realpath(await mkdtemp(join(tmpdir(), 'chatsplice-terminal-reroot-')));
    setWorkspaceRoot(replacementRoot);
    expect(await service.listTerminalSessions(WORKSPACE_ID)).toEqual([]);
    expect(spawned.every((instance) => instance.killed)).toBe(true);

    await service.closeWorkspace(WORKSPACE_ID);
    setWorkspaceRoot(undefined);
    await expect(service.listTerminalSessions(WORKSPACE_ID)).rejects.toThrow(
      'registered user workspace',
    );
    expect(sessions).toHaveLength(MAX_TERMINAL_SESSIONS_PER_WORKSPACE);
  });

  it('does not spawn a pending create after app shutdown begins', async () => {
    workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), 'chatsplice-terminal-shutdown-')));
    spawned = [];
    let releaseRegistry!: () => void;
    const workspace = {
      workspace_id: WORKSPACE_ID,
      display_name: 'Workspace',
      kind: 'user' as const,
      created_at: '2026-09-08T00:00:00.000Z',
      root_path: workspaceRoot,
    };
    const registry = {
      listWorkspaces: () =>
        new Promise<{ workspaces: (typeof workspace)[]; count: number }>((resolve) => {
          releaseRegistry = () => resolve({ workspaces: [workspace], count: 1 });
        }),
    };
    const service = new TerminalService(registry, (_file, _args, options) => {
      const instance = new FakePty(options);
      spawned.push(instance);
      return instance;
    });
    const creating = service.createTerminalSession({
      workspace_id: WORKSPACE_ID,
      cols: 120,
      rows: 30,
    });
    await Promise.resolve();
    const closing = service.closeAll();
    releaseRegistry();
    await expect(creating).rejects.toThrow('terminal service is closing');
    await closing;
    expect(spawned).toHaveLength(0);
  });

  it('waits for an in-flight session operation before app shutdown disposes its PTY', async () => {
    workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), 'chatsplice-terminal-write-')));
    spawned = [];
    const workspace = {
      workspace_id: WORKSPACE_ID,
      display_name: 'Workspace',
      kind: 'user' as const,
      created_at: '2026-09-08T00:00:00.000Z',
      root_path: workspaceRoot,
    };
    let registryCalls = 0;
    let releaseRead!: () => void;
    const registry = {
      listWorkspaces: () => {
        registryCalls += 1;
        if (registryCalls === 1) return Promise.resolve({ workspaces: [workspace], count: 1 });
        return new Promise<{ workspaces: (typeof workspace)[]; count: number }>((resolve) => {
          releaseRead = () => resolve({ workspaces: [workspace], count: 1 });
        });
      },
    };
    const service = new TerminalService(registry, (_file, _args, options) => {
      const instance = new FakePty(options);
      spawned.push(instance);
      return instance;
    });
    const created = await service.createTerminalSession({
      workspace_id: WORKSPACE_ID,
      cols: 120,
      rows: 30,
    });
    const pty = spawned[0];
    const writing = service.writeTerminalSession({
      workspace_id: WORKSPACE_ID,
      terminal_id: created.terminal_id,
      data: 'echo before close\r',
    });
    await Promise.resolve();
    await Promise.resolve();
    const closing = service.closeAll();
    await Promise.resolve();
    expect(pty?.killed).toBe(false);
    expect(releaseRead).toBeTypeOf('function');
    releaseRead();
    await writing;
    await closing;
    expect(pty?.writes).toEqual(['echo before close\r']);
    expect(pty?.killed).toBe(true);
  });

  it('does not pass ChatSplice control credentials or Electron launcher state to the shell', () => {
    const environment = terminalEnvironment({
      PATH: '/bin:/usr/bin',
      CHATSPLICE_CONTROL_MUTATION_TOKEN: 'secret',
      LOCALCHAT_RUNTIME_API_KEY: 'secret',
      MCP_EXTRA_HEADERS: 'x-chatsplice-token: file:/private/token',
      NODE_OPTIONS: '--require /private/injected.js',
      ELECTRON_RUN_AS_NODE: '1',
      OPENAI_API_KEY: 'user-configured',
    });
    expect(environment).toEqual({
      PATH: '/bin:/usr/bin',
      OPENAI_API_KEY: 'user-configured',
    });
    expect(terminalShell({ SHELL: '/bin/bash' }, 'darwin')).toBe('/bin/bash');
  });
});
