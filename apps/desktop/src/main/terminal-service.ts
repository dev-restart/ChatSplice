import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';

import * as pty from 'node-pty';

import {
  CreateTerminalSessionInputSchema,
  ReadTerminalSessionInputSchema,
  ResizeTerminalSessionInputSchema,
  TerminalSessionSnapshotSchema,
  TerminalSessionSummaryListSchema,
  TerminalSessionSummarySchema,
  TerminalSessionTargetSchema,
  WriteTerminalSessionInputSchema,
} from '@chatsplice/protocol';
import type {
  CreateTerminalSessionInput,
  ReadTerminalSessionInput,
  ResizeTerminalSessionInput,
  TerminalSessionSnapshot,
  TerminalSessionSummary,
  TerminalSessionSummaryList,
  TerminalSessionTarget,
  WorkspaceDetail,
  WorkspaceDetailListResult,
  WriteTerminalSessionInput,
} from '@chatsplice/protocol';

export const MAX_TERMINAL_SESSIONS_PER_WORKSPACE = 8;
export const MAX_TERMINAL_SESSIONS_GLOBAL = 32;
export const MAX_TERMINAL_OUTPUT_HISTORY_BYTES = 262_144;
export const MAX_TERMINAL_REPLAY_BYTES = 65_536;
export const MAX_TERMINAL_INPUT_BYTES = 131_072;
const TERMINAL_KILL_GRACE_MS = 100;
const TERMINAL_KILL_TIMEOUT_MS = 900;
const MAX_TERMINAL_DESCENDANTS = 256;
const MAX_TERMINAL_PROCESS_DEPTH = 16;

type Disposable = { dispose(): void };

export interface TerminalPtyProcess {
  readonly pid?: number;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): Disposable;
  write(data: string | Buffer): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
}

export interface TerminalPtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export type TerminalPtySpawner = (
  file: string,
  args: string[],
  options: TerminalPtySpawnOptions,
) => TerminalPtyProcess;

export interface TerminalWorkspaceRegistry {
  listWorkspaces(): Promise<WorkspaceDetailListResult>;
}

interface OutputChunk {
  sequence: number;
  data: string;
  bytes: number;
}

interface TerminalRecord {
  readonly terminalId: string;
  readonly workspaceId: string;
  readonly rootPath: string;
  readonly label: string;
  readonly pty: TerminalPtyProcess;
  readonly dataSubscription: Disposable;
  readonly exitSubscription: Disposable;
  disposed: boolean;
  state: 'shellrunning' | 'exited';
  cols: number;
  rows: number;
  sequence: number;
  outputHistoryTruncated: boolean;
  historyBytes: number;
  chunks: OutputChunk[];
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

function terminalId(): string {
  return `term_${randomBytes(12).toString('hex')}`;
}

function truncateUtf8Tail(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) return value;
  let start = buffer.byteLength - maxBytes;
  while (start < buffer.byteLength && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

function isControlCredentialEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase();
  if (normalized === 'MCP_TOKEN' || normalized === 'MCP_EXTRA_HEADERS') return true;
  if (normalized === 'RUNTIME_API_KEY' || normalized === 'RUNTIME_KEY') return true;
  if (
    normalized === 'NODE_OPTIONS' ||
    normalized === 'ELECTRON_RUN_AS_NODE' ||
    normalized === 'ELECTRON_NO_ATTACH_CONSOLE' ||
    normalized === 'NODE_CHANNEL_FD'
  ) {
    return true;
  }
  const appPrefix = normalized.startsWith('CHATSPLICE_') || normalized.startsWith('LOCALCHAT_');
  return appPrefix && /(TOKEN|KEY|SECRET|CREDENTIAL|PASSWORD)/.test(normalized);
}

/** Return the user's normal environment with ChatSplice control credentials removed. */
export function terminalEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || isControlCredentialEnvironmentName(name)) continue;
    environment[name] = value;
  }
  return environment;
}

export function terminalShell(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') return source.COMSPEC || 'cmd.exe';
  return source.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return;
  try {
    process.kill(pid, signal);
  } catch {
    // The process may have exited between the bounded ps snapshot and signal.
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32' || !Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // A PTY implementation may not create a process group for the shell.
  }
}

interface ProcessSnapshot {
  readonly pid: number;
  readonly ppid: number;
  readonly uid: number;
  readonly start: string;
}

interface ProcessTree {
  readonly shell: ProcessSnapshot | undefined;
  readonly descendants: ProcessSnapshot[];
}

async function processTable(): Promise<Map<number, ProcessSnapshot> | undefined> {
  const output = await new Promise<string | undefined>((resolve) => {
    execFile(
      '/bin/ps',
      ['-axo', 'pid=,ppid=,uid=,lstart='],
      { encoding: 'utf8', timeout: 250, maxBuffer: 512 * 1024 },
      (error, stdout) => resolve(error === null ? stdout : undefined),
    );
  });
  if (output === undefined) return undefined;
  const table = new Map<number, ProcessSnapshot>();
  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const uid = Number(parts[2]);
    const start = parts.slice(3).join(' ');
    if (
      !Number.isSafeInteger(pid) ||
      !Number.isSafeInteger(ppid) ||
      !Number.isSafeInteger(uid) ||
      pid <= 1 ||
      start === ''
    ) {
      continue;
    }
    table.set(pid, { pid, ppid, uid, start });
  }
  return table;
}

async function processDescendants(rootPid: number | undefined): Promise<ProcessTree> {
  if (
    process.platform === 'win32' ||
    rootPid === undefined ||
    !Number.isSafeInteger(rootPid) ||
    rootPid <= 1 ||
    rootPid === process.pid
  ) {
    return { shell: undefined, descendants: [] };
  }
  const table = await processTable();
  const shell = table?.get(rootPid);
  if (table === undefined || shell === undefined) {
    return { shell: undefined, descendants: [] };
  }
  const children = new Map<number, number[]>();
  for (const process_ of table.values()) {
    if (process_.uid !== shell.uid) continue;
    const siblings = children.get(process_.ppid) ?? [];
    if (siblings.length < MAX_TERMINAL_DESCENDANTS) siblings.push(process_.pid);
    children.set(process_.ppid, siblings);
  }
  const descendants: ProcessSnapshot[] = [];
  const queue: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }];
  const visited = new Set<number>([rootPid]);
  while (queue.length > 0 && descendants.length < MAX_TERMINAL_DESCENDANTS) {
    const current = queue.shift();
    if (current === undefined || current.depth >= MAX_TERMINAL_PROCESS_DEPTH) continue;
    for (const childPid of children.get(current.pid) ?? []) {
      const child = table.get(childPid);
      if (child === undefined || visited.has(childPid) || childPid === process.pid) continue;
      visited.add(childPid);
      descendants.push(child);
      queue.push({ pid: childPid, depth: current.depth + 1 });
      if (descendants.length >= MAX_TERMINAL_DESCENDANTS) break;
    }
  }
  return { shell, descendants: descendants.reverse() };
}

async function signalProcessSnapshots(
  snapshots: readonly ProcessSnapshot[],
  signal: NodeJS.Signals,
): Promise<void> {
  const table = await processTable();
  if (table === undefined) return;
  for (const snapshot of snapshots) {
    const current = table.get(snapshot.pid);
    if (current !== undefined && current.uid === snapshot.uid && current.start === snapshot.start) {
      signalProcess(snapshot.pid, signal);
    }
  }
}

async function terminateTerminalProcess(terminal: TerminalPtyProcess): Promise<void> {
  const pid = terminal.pid;
  if (pid === undefined) {
    try {
      terminal.kill();
    } catch {
      // The shell may have exited already.
    }
    return;
  }
  let exited = false;
  let exitSubscription: Disposable | undefined;
  const exitPromise = new Promise<void>((resolve) => {
    exitSubscription = terminal.onExit(() => {
      exited = true;
      resolve();
    });
  });
  if (process.platform === 'win32') {
    try {
      terminal.kill();
    } catch {
      // The shell may have exited already.
    }
    await Promise.race([exitPromise, wait(TERMINAL_KILL_TIMEOUT_MS)]);
    exitSubscription?.dispose();
    return;
  }
  const processTree = await processDescendants(pid);
  const descendants = processTree.descendants;
  const shell = processTree.shell;
  if (shell === undefined) {
    try {
      terminal.kill('SIGHUP');
    } catch {
      // The shell may have exited already.
    }
    if (!exited) await Promise.race([exitPromise, wait(TERMINAL_KILL_TIMEOUT_MS)]);
    exitSubscription?.dispose();
    return;
  }
  const killShell = async (signal: NodeJS.Signals): Promise<void> => {
    if (exited) return;
    const table = await processTable();
    if (table === undefined) {
      if (signal === 'SIGHUP') {
        try {
          terminal.kill(signal);
        } catch {
          // The shell may have exited already.
        }
      }
      return;
    }
    const current = table.get(shell.pid);
    if (current === undefined || current.uid !== shell.uid || current.start !== shell.start) return;
    signalProcessGroup(shell.pid, signal);
    signalProcess(shell.pid, signal);
    try {
      terminal.kill(signal);
    } catch {
      // The shell may have exited already.
    }
  };
  await signalProcessSnapshots(descendants, 'SIGHUP');
  await killShell('SIGHUP');
  await wait(TERMINAL_KILL_GRACE_MS);
  await signalProcessSnapshots(descendants, 'SIGTERM');
  await killShell('SIGTERM');
  await wait(TERMINAL_KILL_TIMEOUT_MS - TERMINAL_KILL_GRACE_MS - 200);
  await signalProcessSnapshots(descendants, 'SIGKILL');
  await killShell('SIGKILL');
  if (!exited) await Promise.race([exitPromise, wait(200)]);
  exitSubscription?.dispose();
}

export class TerminalService {
  readonly #workspaceRegistry: TerminalWorkspaceRegistry;
  readonly #spawnPty: TerminalPtySpawner;
  readonly #sessions = new Map<string, TerminalRecord>();
  readonly #sessionTails = new Map<string, Promise<void>>();
  readonly #closingWorkspaces = new Set<string>();
  #mutationTail: Promise<void> = Promise.resolve();
  #closingAll = false;

  public constructor(
    workspaceRegistry: TerminalWorkspaceRegistry,
    spawnPty: TerminalPtySpawner = (file, args, options) => pty.spawn(file, args, options),
  ) {
    this.#workspaceRegistry = workspaceRegistry;
    this.#spawnPty = spawnPty;
  }

  public async listTerminalSessions(workspaceId: string): Promise<TerminalSessionSummaryList> {
    const validatedWorkspaceId = TerminalSessionTargetSchema.shape.workspace_id.parse(workspaceId);
    const workspace = await this.#resolveWorkspace(validatedWorkspaceId);
    await this.#removeRerootedSessions(validatedWorkspaceId, workspace.root_path);
    const summaries = [...this.#sessions.values()]
      .filter((record) => record.workspaceId === validatedWorkspaceId)
      .map((record) => this.#summary(record));
    return TerminalSessionSummaryListSchema.parse(summaries);
  }

  public async createTerminalSession(
    input: CreateTerminalSessionInput,
  ): Promise<TerminalSessionSnapshot> {
    const validated = CreateTerminalSessionInputSchema.parse(input);
    return this.#withMutationLock(async () => {
      const workspace = await this.#resolveWorkspace(validated.workspace_id);
      if (this.#closingAll || this.#closingWorkspaces.has(validated.workspace_id)) {
        throw new Error('The terminal service is closing.');
      }
      await this.#removeRerootedSessions(validated.workspace_id, workspace.root_path);
      const workspaceCount = [...this.#sessions.values()].filter(
        (record) => record.workspaceId === validated.workspace_id,
      ).length;
      if (workspaceCount >= MAX_TERMINAL_SESSIONS_PER_WORKSPACE) {
        throw new Error('The workspace has reached its terminal session limit.');
      }
      if (this.#sessions.size >= MAX_TERMINAL_SESSIONS_GLOBAL) {
        throw new Error('The app has reached its terminal session limit.');
      }

      const cols = validated.cols ?? DEFAULT_COLS;
      const rows = validated.rows ?? DEFAULT_ROWS;
      const id = terminalId();
      const label = `Terminal ${workspaceCount + 1}`;
      let terminal: TerminalPtyProcess;
      try {
        terminal = this.#spawnPty(terminalShell(), [], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: workspace.root_path,
          env: terminalEnvironment(),
        });
      } catch (error) {
        throw new Error(
          `Could not start the workspace terminal: ${error instanceof Error ? error.message : 'unknown error'}`,
          { cause: error },
        );
      }

      const record = {} as TerminalRecord;
      const dataSubscription = terminal.onData((data) => {
        if (this.#sessions.get(id) !== record) return;
        this.#appendOutput(record, data);
      });
      const exitSubscription = terminal.onExit(() => {
        if (this.#sessions.get(id) !== record) return;
        record.state = 'exited';
      });
      Object.assign(record, {
        terminalId: id,
        workspaceId: validated.workspace_id,
        rootPath: workspace.root_path,
        label,
        pty: terminal,
        dataSubscription,
        exitSubscription,
        disposed: false,
        state: 'shellrunning',
        cols,
        rows,
        sequence: 0,
        outputHistoryTruncated: false,
        historyBytes: 0,
        chunks: [],
      });
      this.#sessions.set(id, record);
      return this.#snapshot(record);
    });
  }

  public async readTerminalSession(
    input: ReadTerminalSessionInput,
  ): Promise<TerminalSessionSnapshot> {
    const validated = ReadTerminalSessionInputSchema.parse(input);
    const { record } = await this.#resolveSession(validated);
    return this.#snapshot(record, validated.after_sequence);
  }

  public async writeTerminalSession(input: WriteTerminalSessionInput): Promise<void> {
    const validated = WriteTerminalSessionInputSchema.parse(input);
    if (byteLength(validated.data) > MAX_TERMINAL_INPUT_BYTES) {
      throw new Error('Terminal input exceeds the size limit.');
    }
    await this.#withSessionLock(validated.terminal_id, async () => {
      const { record } = await this.#resolveSession(validated);
      if (record.state !== 'shellrunning') {
        throw new Error('The terminal shell has exited.');
      }
      record.pty.write(validated.data);
    });
  }

  public async resizeTerminalSession(input: ResizeTerminalSessionInput): Promise<void> {
    const validated = ResizeTerminalSessionInputSchema.parse(input);
    await this.#withSessionLock(validated.terminal_id, async () => {
      const { record } = await this.#resolveSession(validated);
      if (record.state !== 'shellrunning') {
        throw new Error('The terminal shell has exited.');
      }
      record.pty.resize(validated.cols, validated.rows);
      record.cols = validated.cols;
      record.rows = validated.rows;
    });
  }

  public async closeTerminalSession(input: TerminalSessionTarget): Promise<void> {
    const validated = TerminalSessionTargetSchema.parse(input);
    await this.#withMutationLock(async () => {
      await this.#withSessionLock(validated.terminal_id, async () => {
        const record = this.#sessions.get(validated.terminal_id);
        if (record === undefined) return;
        if (record.workspaceId !== validated.workspace_id) {
          throw new Error('The terminal session does not belong to this workspace.');
        }
        await this.#disposeSession(record);
      });
    });
  }

  public async closeAll(): Promise<void> {
    this.#closingAll = true;
    await this.#withMutationLock(async () => {
      await Promise.all(
        [...this.#sessions.values()].map((record) =>
          this.#withSessionLock(record.terminalId, () => this.#disposeSession(record)),
        ),
      );
    });
  }

  public async closeWorkspace(workspaceId: string): Promise<void> {
    const validatedWorkspaceId = TerminalSessionTargetSchema.shape.workspace_id.parse(workspaceId);
    this.#closingWorkspaces.add(validatedWorkspaceId);
    try {
      await this.#withMutationLock(async () => {
        await Promise.all(
          [...this.#sessions.values()]
            .filter((record) => record.workspaceId === validatedWorkspaceId)
            .map((record) =>
              this.#withSessionLock(record.terminalId, () => this.#disposeSession(record)),
            ),
        );
      });
    } finally {
      this.#closingWorkspaces.delete(validatedWorkspaceId);
    }
  }

  #appendOutput(record: TerminalRecord, data: string): void {
    if (data === '') return;
    record.sequence += 1;
    let retained = data;
    const bytes = byteLength(retained);
    if (bytes > MAX_TERMINAL_OUTPUT_HISTORY_BYTES) {
      retained = truncateUtf8Tail(data, MAX_TERMINAL_OUTPUT_HISTORY_BYTES);
      record.outputHistoryTruncated = true;
    }
    const chunk: OutputChunk = {
      sequence: record.sequence,
      data: retained,
      bytes: byteLength(retained),
    };
    record.chunks.push(chunk);
    record.historyBytes += chunk.bytes;
    while (
      (record.historyBytes > MAX_TERMINAL_OUTPUT_HISTORY_BYTES || record.chunks.length > 8_192) &&
      record.chunks.length > 0
    ) {
      const removed = record.chunks.shift();
      record.historyBytes -= removed?.bytes ?? 0;
      record.outputHistoryTruncated = true;
    }
  }

  #summary(record: TerminalRecord): TerminalSessionSummary {
    return TerminalSessionSummarySchema.parse({
      terminal_id: record.terminalId,
      label: record.label,
      workspace_id: record.workspaceId,
      state: record.state,
      cols: record.cols,
      rows: record.rows,
      sequence: record.sequence,
    });
  }

  #snapshot(record: TerminalRecord, afterSequence?: number): TerminalSessionSnapshot {
    const retained = record.chunks;
    let replayTruncated = afterSequence === undefined && record.outputHistoryTruncated;
    let chunks = retained;
    if (afterSequence !== undefined) {
      const firstSequence = retained[0]?.sequence;
      if (firstSequence !== undefined && afterSequence < firstSequence - 1) {
        replayTruncated = true;
      }
      chunks = retained.filter((chunk) => chunk.sequence > afterSequence);
    }
    let output = chunks.map((chunk) => chunk.data).join('');
    if (byteLength(output) > MAX_TERMINAL_REPLAY_BYTES) {
      output = truncateUtf8Tail(output, MAX_TERMINAL_REPLAY_BYTES);
      replayTruncated = true;
    }
    return TerminalSessionSnapshotSchema.parse({
      ...this.#summary(record),
      output,
      replay_truncated: replayTruncated,
    });
  }

  async #resolveWorkspace(workspaceId: string): Promise<WorkspaceDetail> {
    const result = await this.#workspaceRegistry.listWorkspaces();
    const workspace = result.workspaces.find(
      (candidate) => candidate.workspace_id === workspaceId && candidate.kind === 'user',
    );
    if (workspace === undefined) {
      throw new Error('Only a registered user workspace can open a local terminal.');
    }
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(workspace.root_path);
      const rootStat = await stat(canonicalRoot);
      if (!rootStat.isDirectory()) throw new Error('Workspace root is not a directory.');
    } catch {
      throw new Error(
        'The registered workspace root is unavailable. Refresh the project and retry.',
      );
    }
    if (canonicalRoot !== workspace.root_path) {
      throw new Error('The registered workspace root changed. Refresh the project and retry.');
    }
    return workspace;
  }

  async #resolveSession(
    input: TerminalSessionTarget,
  ): Promise<{ record: TerminalRecord; workspace: WorkspaceDetail }> {
    const validated = TerminalSessionTargetSchema.parse({
      workspace_id: input.workspace_id,
      terminal_id: input.terminal_id,
    });
    const workspace = await this.#resolveWorkspace(validated.workspace_id);
    const record = this.#sessions.get(validated.terminal_id);
    if (record === undefined) throw new Error('Unknown terminal session.');
    if (record.workspaceId !== validated.workspace_id) {
      throw new Error('The terminal session does not belong to this workspace.');
    }
    if (record.rootPath !== workspace.root_path) {
      await this.#disposeSession(record);
      throw new Error('The workspace root changed. Refresh the terminal and retry.');
    }
    return { record, workspace };
  }

  async #removeRerootedSessions(workspaceId: string, currentRoot: string): Promise<void> {
    await Promise.all(
      [...this.#sessions.values()]
        .filter((record) => record.workspaceId === workspaceId && record.rootPath !== currentRoot)
        .map((record) =>
          this.#withSessionLock(record.terminalId, () => this.#disposeSession(record)),
        ),
    );
  }

  async #disposeSession(record: TerminalRecord): Promise<void> {
    if (record.disposed) return;
    record.disposed = true;
    if (this.#sessions.get(record.terminalId) === record) {
      this.#sessions.delete(record.terminalId);
    }
    record.dataSubscription.dispose();
    if (record.state === 'shellrunning') {
      await terminateTerminalProcess(record.pty);
    }
    record.exitSubscription.dispose();
  }

  async #withMutationLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTail;
    let release!: () => void;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  async #withSessionLock<T>(terminalId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#sessionTails.get(terminalId) ?? Promise.resolve();
    const result = previous.then(action);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#sessionTails.set(terminalId, tail);
    try {
      return await result;
    } finally {
      if (this.#sessionTails.get(terminalId) === tail) this.#sessionTails.delete(terminalId);
    }
  }
}
