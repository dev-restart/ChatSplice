import { randomUUID } from 'node:crypto';

import { ChatSpliceError } from '@chatsplice/core';
import type { WorkspaceService } from '@chatsplice/core';
import {
  ProjectExecJobSchema,
  ProjectExecSummarySchema,
  type ProjectExecAwaitInput,
  type ProjectExecInput,
  type ProjectExecJob,
  type ProjectExecSummary,
} from '@chatsplice/protocol';

import {
  executeProjectOperation,
  type ProjectExecutionBackend,
  type ProjectExecutionStart,
} from './backend.js';

const MAX_RETAINED_JOBS = 100;
const MAX_PENDING_JOBS = 20;
const MAX_RUNNING_JOBS = 2;
const MAX_OUTPUT_BYTES = 64 * 1024;

type JobState = ProjectExecSummary['state'];

interface InternalJob {
  readonly job_id: string;
  readonly request_id: string;
  readonly fingerprint: string;
  readonly input: ProjectExecInput;
  readonly workspace_name: string;
  readonly created_at: string;
  readonly controller: AbortController;
  readonly waiters: Set<() => void>;
  command: string;
  state: JobState;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  error_code: string | null;
  message: string;
  used_network: boolean;
  truncated: boolean;
  duration_ms: number;
  output: string;
  cancel_requested: boolean;
  completion: Promise<void> | undefined;
}

interface SlotWaiter {
  readonly job: InternalJob;
  readonly resolve: (release: (() => void) | undefined) => void;
  readonly onAbort: () => void;
}

export interface ProjectExecutionServiceOptions {
  readonly isReadOnly?: () => boolean;
  readonly backend?: ProjectExecutionBackend;
}

function isTerminal(state: JobState): boolean {
  return (
    state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'timed_out'
  );
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
}

function boundedText(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString('utf8');
}

function boundedUtf8Tail(
  value: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return { text: value, truncated: false };

  const start = bytes.length - maxBytes;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  // The cap can begin in the middle of a UTF-8 sequence. At most three bytes
  // need to be discarded to reach the next valid code point boundary.
  for (let offset = 0; offset <= 3 && start + offset <= bytes.length; offset += 1) {
    try {
      return {
        text: decoder.decode(bytes.subarray(start + offset)),
        truncated: true,
      };
    } catch {
      // Try the next possible UTF-8 boundary.
    }
  }
  // Buffer.from(string) always produces valid UTF-8. This fallback is only a
  // defensive guard if that invariant changes, and remains byte bounded.
  return { text: bytes.subarray(start).toString('utf8'), truncated: true };
}

function operationCommand(input: ProjectExecInput): string {
  switch (input.operation.kind) {
    case 'node_script':
      return `node_script ${input.operation.script}`;
    case 'cargo':
      return `cargo ${input.operation.task}`;
    case 'install':
      return `install ${input.operation.ecosystem}`;
  }
}

export class ProjectExecutionService {
  readonly #workspaceService: WorkspaceService;
  readonly #isReadOnly: () => boolean;
  readonly #backend: ProjectExecutionBackend;
  readonly #jobs = new Map<string, InternalJob>();
  readonly #jobsByRequest = new Map<string, { fingerprint: string; job_id: string }>();
  readonly #terminalOrder: string[] = [];
  readonly #slotWaiters: SlotWaiter[] = [];
  readonly #activeRuns = new Set<Promise<void>>();
  #pendingCount = 0;
  #runningCount = 0;
  #closed = false;
  #shutdownPromise: Promise<void> | undefined;

  public constructor(
    workspaceService: WorkspaceService,
    options: ProjectExecutionServiceOptions = {},
  ) {
    this.#workspaceService = workspaceService;
    this.#isReadOnly = options.isReadOnly ?? (() => false);
    this.#backend = options.backend ?? executeProjectOperation;
  }

  public submit(input: ProjectExecInput): ProjectExecSummary {
    if (this.#closed) {
      throw new ChatSpliceError('BAD_REQUEST', 'ChatSplice is shutting down.');
    }
    const workspace = this.#workspaceService.getRecord(input.workspace_id);
    if (workspace.kind !== 'user') {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'Project execution is available only for registered user workspaces.',
      );
    }

    const fingerprint = stableSerialize(input);
    const existingRequest = this.#jobsByRequest.get(input.request_id);
    if (existingRequest !== undefined) {
      if (existingRequest.fingerprint !== fingerprint) {
        throw new ChatSpliceError(
          'BAD_REQUEST',
          'request_id is already associated with a different project execution.',
        );
      }
      const existingJob = this.#jobs.get(existingRequest.job_id);
      if (existingJob !== undefined) return this.#summary(existingJob);
      this.#jobsByRequest.delete(input.request_id);
    }

    if (this.#isReadOnly()) {
      throw new ChatSpliceError(
        'READ_ONLY_MODE_ENABLED',
        'ChatSplice read-only mode is on. Turn it off before starting project execution.',
      );
    }

    if (this.#pendingCount >= MAX_PENDING_JOBS) {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        `The bounded project execution queue is full (${MAX_PENDING_JOBS} pending jobs).`,
      );
    }

    const job: InternalJob = {
      job_id: `exec_${randomUUID()}`,
      request_id: input.request_id,
      fingerprint,
      input,
      workspace_name: workspace.display_name,
      created_at: new Date().toISOString(),
      controller: new AbortController(),
      waiters: new Set(),
      command: operationCommand(input),
      state: 'queued',
      started_at: null,
      finished_at: null,
      exit_code: null,
      error_code: null,
      message: 'Queued for execution.',
      used_network: false,
      truncated: false,
      duration_ms: 0,
      output: '',
      cancel_requested: false,
      completion: undefined,
    };
    this.#jobs.set(job.job_id, job);
    this.#jobsByRequest.set(input.request_id, { fingerprint, job_id: job.job_id });
    this.#pendingCount += 1;
    this.#trimRetainedJobs();

    const completion = this.#run(job);
    job.completion = completion;
    this.#activeRuns.add(completion);
    void completion.finally(() => this.#activeRuns.delete(completion)).catch(() => undefined);
    return this.#summary(job);
  }

  public getJob(workspaceId: string, jobId: string): ProjectExecJob {
    const job = this.#requireJob(workspaceId, jobId);
    return this.#job(job);
  }

  public list(): ProjectExecSummary[] {
    const jobs = [...this.#jobs.values()].sort((left, right) =>
      right.created_at.localeCompare(left.created_at),
    );
    const active = jobs.filter((job) => !isTerminal(job.state));
    const terminal = jobs.filter((job) => isTerminal(job.state));
    return [...active, ...terminal].slice(0, MAX_RETAINED_JOBS).map((job) => this.#summary(job));
  }

  public async awaitJob(input: ProjectExecAwaitInput): Promise<ProjectExecJob> {
    const job = this.#requireJob(input.workspace_id, input.job_id);
    if (isTerminal(job.state) || input.timeout_ms === 0) return this.#job(job);

    const timeoutMs = Math.min(Math.max(input.timeout_ms, 0), 30_000);
    await new Promise<void>((resolve) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        job.waiters.delete(onTerminal);
      };
      const settle = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onTerminal = (): void => settle();
      job.waiters.add(onTerminal);
      const timer = setTimeout(settle, timeoutMs);
      if (isTerminal(job.state)) settle();
    });
    return this.#job(job);
  }

  public cancel(workspaceId: string, jobId: string): ProjectExecJob {
    const job = this.#requireJob(workspaceId, jobId);
    if (isTerminal(job.state)) return this.#job(job);
    job.cancel_requested = true;
    job.state = 'cancelling';
    job.message = 'Cancellation requested; waiting for cleanup.';
    job.controller.abort();
    return this.#job(job);
  }

  public async shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    this.#closed = true;
    for (const job of this.#jobs.values()) {
      if (!isTerminal(job.state)) {
        job.cancel_requested = true;
        job.state = 'cancelling';
        job.message = 'Daemon shutdown requested; waiting for cleanup.';
        job.controller.abort();
      }
    }
    this.#shutdownPromise = (async () => {
      await Promise.allSettled([...this.#activeRuns]);
      while (this.#activeRuns.size > 0 || this.#pendingCount > 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })();
    return this.#shutdownPromise;
  }

  #requireJob(workspaceId: string, jobId: string): InternalJob {
    const job = this.#jobs.get(jobId);
    if (job === undefined || job.input.workspace_id !== workspaceId) {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'The project execution job does not exist for this workspace.',
      );
    }
    return job;
  }

  async #run(job: InternalJob): Promise<void> {
    try {
      await this.#workspaceService.withOperation(
        job.input.workspace_id,
        async () => {
          if (job.cancel_requested) return;

          const release = await this.#acquireSlot(job);
          if (release === undefined) return;
          try {
            // Read-only mode is checked again after the root reservation and
            // slot acquisition. A queued request must never start after the
            // owner flips the switch while it is waiting.
            if (job.cancel_requested) return;
            if (this.#isReadOnly()) {
              this.#finishFailure(
                job,
                'READ_ONLY_MODE_ENABLED',
                'Read-only mode was enabled before this queued execution started.',
              );
              return;
            }

            job.state = 'running';
            job.started_at = new Date().toISOString();
            job.message = 'Project execution is running.';
            const result = await this.#backend(this.#workspaceService, job.input, {
              signal: job.controller.signal,
              onOutput: (chunk) => this.#appendOutput(job, chunk),
              onStart: (execution) => this.#onStart(job, execution),
            });
            if (job.cancel_requested) {
              this.#finishCancelled(job, result.duration_ms);
            } else if (result.timed_out) {
              this.#finish(
                job,
                'timed_out',
                result.exit_code,
                null,
                'Project execution timed out.',
                result.duration_ms,
              );
            } else if (result.exit_code === 0) {
              this.#finish(
                job,
                'succeeded',
                result.exit_code,
                null,
                'Project execution succeeded.',
                result.duration_ms,
              );
            } else {
              this.#finish(
                job,
                'failed',
                result.exit_code,
                null,
                'Project execution failed.',
                result.duration_ms,
              );
            }
          } finally {
            release();
          }
        },
        job.controller.signal,
      );
    } catch (error) {
      if (job.cancel_requested) {
        this.#finishCancelled(
          job,
          job.started_at === null ? 0 : Date.now() - Date.parse(job.started_at),
        );
      } else {
        const errorCode = error instanceof ChatSpliceError ? error.code : 'INTERNAL_ERROR';
        const message = error instanceof Error ? error.message : 'Project execution failed.';
        this.#finishFailure(job, errorCode, message);
      }
    } finally {
      if (!isTerminal(job.state)) {
        if (job.cancel_requested) {
          this.#finishCancelled(
            job,
            job.started_at === null ? 0 : Date.now() - Date.parse(job.started_at),
          );
        } else {
          this.#finishFailure(job, 'INTERNAL_ERROR', 'Project execution ended without a result.');
        }
      }
    }
  }

  async #acquireSlot(job: InternalJob): Promise<(() => void) | undefined> {
    if (job.cancel_requested) return undefined;
    if (this.#runningCount < MAX_RUNNING_JOBS) return this.#takeSlot();
    return new Promise<(() => void) | undefined>((resolve) => {
      let waiting = true;
      const remove = (): void => {
        if (!waiting) return;
        waiting = false;
        const index = this.#slotWaiters.findIndex((item) => item.job.job_id === job.job_id);
        if (index >= 0) this.#slotWaiters.splice(index, 1);
        job.controller.signal.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        remove();
        resolve(undefined);
      };
      this.#slotWaiters.push({
        job,
        resolve: (release) => {
          remove();
          resolve(release);
        },
        onAbort,
      });
      job.controller.signal.addEventListener('abort', onAbort, { once: true });
      if (job.cancel_requested) onAbort();
      else this.#drainSlots();
    });
  }

  #takeSlot(): () => void {
    this.#runningCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#runningCount -= 1;
      this.#drainSlots();
    };
  }

  #drainSlots(): void {
    while (this.#runningCount < MAX_RUNNING_JOBS && this.#slotWaiters.length > 0) {
      const waiter = this.#slotWaiters.shift();
      if (waiter === undefined) return;
      if (waiter.job.cancel_requested || waiter.job.controller.signal.aborted) {
        waiter.onAbort();
        continue;
      }
      waiter.resolve(this.#takeSlot());
    }
  }

  #onStart(job: InternalJob, execution: ProjectExecutionStart): void {
    job.command = boundedText(execution.command, 4096);
    job.used_network = execution.used_network;
  }

  #appendOutput(job: InternalJob, chunk: string): void {
    if (isTerminal(job.state) || chunk.length === 0) return;
    const bounded = boundedUtf8Tail(job.output + chunk, MAX_OUTPUT_BYTES);
    job.output = bounded.text;
    job.truncated ||= bounded.truncated;
  }

  #finishFailure(job: InternalJob, errorCode: string, message: string): void {
    this.#finish(job, 'failed', null, errorCode, message, this.#duration(job));
  }

  #finishCancelled(job: InternalJob, durationMs: number): void {
    this.#finish(
      job,
      'cancelled',
      null,
      'CANCELLED',
      'Project execution was cancelled.',
      durationMs,
    );
  }

  #finish(
    job: InternalJob,
    state: Exclude<JobState, 'queued' | 'running' | 'cancelling'>,
    exitCode: number | null,
    errorCode: string | null,
    message: string,
    durationMs: number,
  ): void {
    if (isTerminal(job.state)) return;
    job.state = state;
    job.exit_code = exitCode;
    job.error_code = errorCode;
    job.message = boundedText(message, 1000);
    job.duration_ms = Math.max(0, Math.trunc(durationMs));
    job.finished_at = new Date().toISOString();
    this.#pendingCount = Math.max(0, this.#pendingCount - 1);
    this.#terminalOrder.push(job.job_id);
    this.#notify(job);
    this.#trimRetainedJobs();
  }

  #duration(job: InternalJob): number {
    return job.started_at === null ? 0 : Math.max(0, Date.now() - Date.parse(job.started_at));
  }

  #notify(job: InternalJob): void {
    for (const waiter of [...job.waiters]) {
      try {
        waiter();
      } catch {
        // A waiter is transport-owned; a broken waiter must not affect the job.
      }
    }
  }

  #summary(job: InternalJob): ProjectExecSummary {
    return ProjectExecSummarySchema.parse({
      job_id: job.job_id,
      workspace_id: job.input.workspace_id,
      workspace_name: job.workspace_name,
      operation: job.input.operation,
      cwd: job.input.cwd,
      state: job.state,
      command: job.command,
      created_at: job.created_at,
      started_at: job.started_at,
      finished_at: job.finished_at,
      exit_code: job.exit_code,
      error_code: job.error_code,
      message: job.message,
      used_network: job.used_network,
      truncated: job.truncated,
      duration_ms: isTerminal(job.state) ? job.duration_ms : this.#duration(job),
    });
  }

  #job(job: InternalJob): ProjectExecJob {
    return ProjectExecJobSchema.parse({ ...this.#summary(job), output: job.output });
  }

  #trimRetainedJobs(): void {
    while (this.#jobs.size > MAX_RETAINED_JOBS && this.#terminalOrder.length > 0) {
      const jobId = this.#terminalOrder.shift();
      if (jobId === undefined) continue;
      const job = this.#jobs.get(jobId);
      if (job === undefined || !isTerminal(job.state)) continue;
      this.#jobs.delete(jobId);
      const request = this.#jobsByRequest.get(job.request_id);
      if (request?.job_id === jobId) this.#jobsByRequest.delete(job.request_id);
    }
  }
}

export const PROJECT_EXECUTION_LIMITS = {
  max_retained_jobs: MAX_RETAINED_JOBS,
  max_pending_jobs: MAX_PENDING_JOBS,
  max_running_jobs: MAX_RUNNING_JOBS,
  max_output_bytes: MAX_OUTPUT_BYTES,
} as const;
