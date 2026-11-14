import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app } from 'electron';
import type { DaemonStatus } from '@chatsplice/protocol';

import { DaemonClient, IncompatibleDaemonError } from './daemon-client.js';

const START_TIMEOUT_MS = 8_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function daemonEntryPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'chatspliced', 'chatspliced.js');
  }
  return fileURLToPath(
    new URL('../../../../packages/mcp-server/dist/bin/chatspliced.js', import.meta.url),
  );
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ['LANG', 'LC_ALL', 'PATH', 'TMPDIR'] as const) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  if (app.isPackaged) {
    environment.ELECTRON_RUN_AS_NODE = '1';
  }
  return environment;
}

export class DaemonSupervisor {
  public readonly client: DaemonClient;
  readonly #dataDirectory: string;
  readonly #socketPath: string;
  #child: ChildProcess | undefined;
  #owned = false;
  #ready = false;

  public constructor(dataDirectory: string, socketPath: string) {
    this.#dataDirectory = dataDirectory;
    this.#socketPath = socketPath;
    this.client = new DaemonClient(
      socketPath,
      join(dataDirectory, 'run', 'control-mutation-token'),
    );
  }

  public async start(): Promise<void> {
    let existingStatus: DaemonStatus | undefined;
    try {
      existingStatus = await this.client.status();
    } catch (error) {
      if (error instanceof IncompatibleDaemonError) throw error;
      // No healthy daemon is available at the owner-only socket.
    }

    if (existingStatus !== undefined) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < START_TIMEOUT_MS) {
        if (existingStatus.healthy && existingStatus.ready) return;
        await delay(100);
        try {
          existingStatus = await this.client.status();
        } catch (error) {
          if (error instanceof IncompatibleDaemonError) throw error;
          // A responding daemon retains its ownership while readiness is retried.
        }
      }
      throw new Error('chatspliced did not become ready before the startup timeout.');
    }

    const executable = app.isPackaged
      ? process.execPath
      : (process.env.CHATSPLICE_NODE_BINARY ?? process.env.LOCALCHAT_NODE_BINARY ?? 'node');
    const child = spawn(
      executable,
      [daemonEntryPath(), '--data-dir', this.#dataDirectory, '--control-socket', this.#socketPath],
      {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnvironment(),
      },
    );
    this.#child = child;
    this.#owned = true;
    let launchFailed = false;
    child.on('error', () => {
      launchFailed = true;
    });
    child.stdout?.resume();
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));

    const startedAt = Date.now();
    while (Date.now() - startedAt < START_TIMEOUT_MS) {
      if (launchFailed) {
        throw new Error('chatspliced could not be started.');
      }
      if (child.exitCode !== null) {
        throw new Error('chatspliced exited before becoming ready.');
      }
      try {
        const status = await this.client.status();
        if (status.healthy && status.ready) {
          this.#ready = true;
          return;
        }
      } catch (error) {
        if (error instanceof IncompatibleDaemonError) throw error;
        // The next iteration retries both transport errors and not-ready responses.
      }
      await delay(100);
    }
    throw new Error('chatspliced did not become ready before the startup timeout.');
  }

  public async close(): Promise<void> {
    if (!this.#owned || this.#child === undefined) {
      return;
    }
    const child = this.#child;
    // A daemon terminated by a signal reports signalCode, not exitCode.
    const running = (): boolean => child.exitCode === null && !child.signalCode;
    const exited = (timeoutMs: number): Promise<void> =>
      running()
        ? Promise.race([
            new Promise<void>((resolve) => child.once('exit', () => resolve())),
            delay(timeoutMs),
          ])
        : Promise.resolve();
    if (this.#ready && running()) {
      await this.client.shutdown().catch(() => undefined);
    }
    await exited(2_000);
    if (running()) {
      child.kill('SIGTERM');
      // An owned daemon that ignores SIGTERM would otherwise survive the app
      // and block the next launch's ownership check.
      const escalation = setTimeout(() => {
        if (running()) child.kill('SIGKILL');
      }, 2_000);
      child.once('exit', () => clearTimeout(escalation));
    }
    this.#owned = false;
    this.#ready = false;
  }
}
