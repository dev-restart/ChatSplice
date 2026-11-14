import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { ChatSpliceError, resolveProjectExecutionAccess } from '@chatsplice/core';
import type {
  ExecutionPreflightProgress,
  ProjectExecutionAccess,
  WorkspaceReferenceService,
  WorkspaceService,
} from '@chatsplice/core';
import {
  ProjectExecInputSchema,
  ProjectExecJobSchema,
  ProjectExecSummarySchema,
  isBackgroundOperation,
  type ProjectBrowserSnapshot,
  type ProjectReadinessResult,
  type ProjectEnvironmentResult,
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
import { ProjectBrowserService } from '../browser/service.js';
import {
  EMBEDDED_EXECUTION_CONCURRENCY,
  EXECUTION_STORAGE_LIMITS,
  resolveExecutionConcurrency,
  type ProjectExecutionConcurrency,
} from './limits.js';
import { log } from '../logging.js';

export { DESKTOP_EXECUTION_CONCURRENCY, type ProjectExecutionConcurrency } from './limits.js';

const MAX_RETAINED_JOBS = EXECUTION_STORAGE_LIMITS.retained_jobs;
const MAX_IMAGE_BYTES = EXECUTION_STORAGE_LIMITS.image_bytes;
const MAX_OUTPUT_BYTES = EXECUTION_STORAGE_LIMITS.output_bytes;

type JobState = ProjectExecSummary['state'];

interface InternalJob {
  readonly job_id: string;
  readonly request_id: string;
  readonly fingerprint: string;
  readonly input: ProjectExecInput;
  readonly access: ProjectExecutionAccess;
  readonly workspace_name: string;
  readonly created_at: string;
  readonly accepted_at_ms: number;
  phase_started_ms: number;
  phase_key: string;
  queue_ms: number | null;
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
  browser_result: ProjectBrowserSnapshot | undefined;
  readiness_result: ProjectReadinessResult | undefined;
  environment_result: ProjectEnvironmentResult | undefined;
  receipt_pending: boolean;
  terminal_notified: boolean;
}

interface SlotWaiter {
  readonly job: InternalJob;
  readonly resolve: (release: (() => void) | undefined) => void;
  readonly onAbort: () => void;
}

export interface ProjectExecutionServiceOptions {
  readonly referenceService?: WorkspaceReferenceService;
  readonly isReadOnly?: () => boolean;
  readonly backend?: ProjectExecutionBackend;
  readonly concurrency?: ProjectExecutionConcurrency;
  readonly goalLifecycle?: ProjectExecutionGoalLifecycle;
}

/** Goal receipts are saved before terminal execution results become observable. */
export interface ProjectExecutionGoalLifecycle {
  onSubmit(summary: ProjectExecSummary, input: ProjectExecInput): void;
  beforeStart(summary: ProjectExecSummary, input: ProjectExecInput): Promise<void>;
  onFinish(summary: ProjectExecSummary, input: ProjectExecInput): Promise<void>;
  executionTimeout?(input: ProjectExecInput): number;
  onRuntimeChanged?(workspaceId: string): void;
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
    case 'shell':
      return boundedText(input.operation.command, 4096);
    case 'browser':
      return `browser ${input.operation.action.kind}`;
    case 'environment':
      return 'environment inspection';
    case 'readiness': {
      const url = new URL(input.operation.url);
      return boundedText(`HEAD ${url.origin}${url.pathname}`, 4096);
    }
  }
}

export class ProjectExecutionService {
  readonly #workspaceService: WorkspaceService;
  readonly #referenceService: WorkspaceReferenceService | undefined;
  readonly #isReadOnly: () => boolean;
  readonly #backend: ProjectExecutionBackend;
  readonly #browser: ProjectBrowserService;
  readonly #concurrency: ProjectExecutionConcurrency;
  readonly #images = new Map<string, { data: Buffer; mimeType: 'image/jpeg' }>();
  readonly #jobs = new Map<string, InternalJob>();
  readonly #jobsByRequest = new Map<string, { fingerprint: string; job_id: string }>();
  readonly #terminalOrder: string[] = [];
  readonly #slotWaiters: SlotWaiter[] = [];
  readonly #activeRuns = new Set<Promise<void>>();
  #pendingCount = 0;
  #runningCount = 0;
  #backgroundCount = 0;
  #awaitWaiterCount = 0;
  #imageBytes = 0;
  #closed = false;
  #shutdownPromise: Promise<void> | undefined;
  #goalLifecycle: ProjectExecutionGoalLifecycle | undefined;

  public constructor(
    workspaceService: WorkspaceService,
    options: ProjectExecutionServiceOptions = {},
  ) {
    this.#concurrency = resolveExecutionConcurrency(options.concurrency);
    this.#browser = new ProjectBrowserService(this.#concurrency.browser_sessions);
    this.#workspaceService = workspaceService;
    this.#referenceService = options.referenceService;
    this.#isReadOnly = options.isReadOnly ?? (() => false);
    this.#goalLifecycle = options.goalLifecycle;
    this.#backend =
      options.backend ??
      ((service, input, executionOptions) =>
        input.operation.kind === 'browser'
          ? this.#browser.execute(
              input,
              executionOptions,
              service.getRecord(input.workspace_id).rootPath,
            )
          : executeProjectOperation(service, input, executionOptions));
  }

  public setGoalLifecycle(lifecycle: ProjectExecutionGoalLifecycle): void {
    if (this.#goalLifecycle !== undefined && this.#goalLifecycle !== lifecycle) {
      throw new ChatSpliceError('BAD_REQUEST', 'Goal execution lifecycle is already configured.');
    }
    this.#goalLifecycle = lifecycle;
  }

  public submit(request: ProjectExecInput): ProjectExecSummary {
    if (this.#closed) {
      throw new ChatSpliceError('BAD_REQUEST', 'ChatSplice is shutting down.');
    }
    // Async execution must retain the accepted target and operation even when
    // an embedded caller subsequently reuses or mutates its request object.
    const input = ProjectExecInputSchema.parse(request);
    const workspace = this.#workspaceService.getRecord(input.workspace_id);
    if (workspace.kind !== 'user') {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'Project execution is available only for registered user workspaces.',
      );
    }

    const fingerprint = stableSerialize(input);
    const requestKey = JSON.stringify([input.workspace_id, input.request_id]);
    const existingRequest = this.#jobsByRequest.get(requestKey);
    if (existingRequest !== undefined) {
      if (existingRequest.fingerprint !== fingerprint) {
        throw new ChatSpliceError(
          'BAD_REQUEST',
          'request_id is already associated with a different project execution.',
        );
      }
      const existingJob = this.#jobs.get(existingRequest.job_id);
      if (existingJob !== undefined) return this.#summary(existingJob);
      this.#jobsByRequest.delete(requestKey);
    }

    if (this.#isReadOnly()) {
      throw new ChatSpliceError(
        'READ_ONLY_MODE_ENABLED',
        'ChatSplice read-only mode is on. Turn it off before starting project execution.',
      );
    }

    if (this.#pendingCount >= this.#concurrency.pending) {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        `The bounded project execution queue is full (${this.#concurrency.pending} pending jobs).`,
      );
    }

    const access = resolveProjectExecutionAccess(
      this.#workspaceService,
      input,
      this.#referenceService,
    );
    const job: InternalJob = {
      job_id: `exec_${randomUUID()}`,
      request_id: input.request_id,
      fingerprint,
      input,
      access,
      workspace_name: workspace.display_name,
      created_at: new Date().toISOString(),
      accepted_at_ms: performance.now(),
      phase_started_ms: performance.now(),
      phase_key: 'waiting_root',
      queue_ms: null,
      controller: new AbortController(),
      waiters: new Set(),
      command: operationCommand(input),
      state: 'queued',
      started_at: null,
      finished_at: null,
      exit_code: null,
      error_code: null,
      message:
        '[EXECUTION_WAITING_ROOT] Waiting for participating folders. The command has not started.',
      used_network: false,
      truncated: false,
      duration_ms: 0,
      output: '',
      cancel_requested: false,
      completion: undefined,
      browser_result: undefined,
      readiness_result: undefined,
      environment_result: undefined,
      receipt_pending: input.goal_id !== undefined,
      terminal_notified: false,
    };
    if (input.goal_id !== undefined) {
      if (this.#goalLifecycle === undefined) {
        throw new ChatSpliceError('BAD_REQUEST', 'Goal runtime is unavailable for this execution.');
      }
      this.#goalLifecycle.onSubmit(this.#summary(job), input);
    }
    this.#jobs.set(job.job_id, job);
    this.#jobsByRequest.set(requestKey, { fingerprint, job_id: job.job_id });
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

  public getScreenshot(
    workspaceId: string,
    jobId: string,
  ): { type: 'image'; data: string; mimeType: 'image/jpeg' } | undefined {
    this.#requireJob(workspaceId, jobId);
    const image = this.#images.get(jobId);
    return image === undefined
      ? undefined
      : { type: 'image', data: image.data.toString('base64'), mimeType: image.mimeType };
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
    return this.waitForCompletion(input.workspace_id, input.job_id, input.timeout_ms);
  }

  /** Internal owner service wait; transport binding validation remains at MCP ingress. */
  public async waitForCompletion(
    workspaceId: string,
    jobId: string,
    timeoutMs = 30_000,
  ): Promise<ProjectExecJob> {
    const job = this.#requireJob(workspaceId, jobId);
    if ((isTerminal(job.state) && !job.receipt_pending) || timeoutMs === 0) {
      return this.#job(job);
    }
    // A retry burst must not create an unbounded set of timers and waiters on
    // a long-running server. Returning its current state is the usual poll
    // result and preserves access to output even when the wait budget is full.
    if (this.#awaitWaiterCount >= EXECUTION_STORAGE_LIMITS.await_waiters) return this.#job(job);

    const boundedTimeoutMs = Math.min(Math.max(timeoutMs, 0), 30_000);
    this.#awaitWaiterCount += 1;
    await new Promise<void>((resolve) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        job.waiters.delete(onTerminal);
        this.#awaitWaiterCount -= 1;
      };
      const settle = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onTerminal = (): void => settle();
      job.waiters.add(onTerminal);
      const timer = setTimeout(settle, boundedTimeoutMs);
      if (isTerminal(job.state) && !job.receipt_pending) settle();
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
      await this.#browser.close();
      this.#images.clear();
      this.#imageBytes = 0;
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
      const runOperation =
        isBackgroundOperation(job.input.operation) || job.input.operation.kind === 'browser'
          ? this.#workspaceService.withConcurrentOperations.bind(this.#workspaceService)
          : this.#workspaceService.withOperations.bind(this.#workspaceService);
      await runOperation(
        job.access.workspaceIds,
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

            const access = resolveProjectExecutionAccess(
              this.#workspaceService,
              job.input,
              this.#referenceService,
            );
            if (access.fingerprint !== job.access.fingerprint) {
              throw new ChatSpliceError(
                'REFERENCE_NOT_ALLOWED',
                'The permitted execution folders changed before this job started. Submit it again.',
              );
            }
            job.state = 'running';
            job.started_at = new Date().toISOString();
            job.queue_ms = Math.max(0, Math.trunc(performance.now() - job.accepted_at_ms));
            this.#setPhase(
              job,
              'preparing',
              '[EXECUTION_PREPARING] Preparing the local operation.',
            );
            if (job.input.goal_id !== undefined) {
              await this.#goalLifecycle!.beforeStart(this.#summary(job), job.input);
            }
            if (job.cancel_requested) return;
            const timeoutMs =
              job.input.goal_id === undefined
                ? job.input.timeout_ms
                : (this.#goalLifecycle!.executionTimeout?.(job.input) ?? job.input.timeout_ms);
            const backendInput = {
              ...job.input,
              timeout_ms: Math.min(job.input.timeout_ms, timeoutMs),
            };
            const result = await this.#backend(this.#workspaceService, backendInput, {
              ...(this.#referenceService === undefined
                ? {}
                : { referenceService: this.#referenceService }),
              signal: job.controller.signal,
              onOutput: (chunk) => this.#appendOutput(job, chunk),
              onStart: (execution) => this.#onStart(job, execution),
              onPreflight: (progress) => this.#onPreflight(job, progress),
            });
            // Failed assertions need their screen evidence too. Cancellation
            // and whole-job timeouts still discard potentially stale results.
            if (result.cargo_cache_repaired === true) {
              // The repair already succeeded. A vanished root cannot hold
              // Goal evidence anyway, so stale marking must not fail the job.
              try {
                this.#goalLifecycle?.onRuntimeChanged?.(job.access.target.workspace_id);
              } catch (error) {
                log('warn', 'goal_runtime_invalidation_failed', {
                  reason: error instanceof Error ? error.name : 'unknown',
                });
              }
            }
            if (!job.cancel_requested && !result.timed_out) {
              job.browser_result = result.browser_result;
              job.readiness_result = result.readiness_result;
              job.environment_result = result.environment_result;
              if (result.image !== undefined) this.#retainImage(job.job_id, result.image);
            }
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
            if (job.cancel_requested && !isTerminal(job.state)) {
              this.#finishCancelled(job, this.#duration(job));
            }
            if (isTerminal(job.state)) await this.#persistReceipt(job);
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
      await this.#persistReceipt(job);
    }
  }

  async #acquireSlot(job: InternalJob): Promise<(() => void) | undefined> {
    if (job.cancel_requested) return undefined;
    if (this.#hasSlot(job)) return this.#takeSlot(job);
    this.#setPhase(
      job,
      'waiting_slot',
      '[EXECUTION_WAITING_SLOT] Waiting for a local execution slot. The command has not started.',
    );
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

  #hasSlot(job: InternalJob): boolean {
    return isBackgroundOperation(job.input.operation)
      ? this.#backgroundCount < this.#concurrency.background
      : this.#runningCount < this.#concurrency.foreground;
  }

  #takeSlot(job: InternalJob): () => void {
    const background = isBackgroundOperation(job.input.operation);
    if (background) this.#backgroundCount += 1;
    else this.#runningCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (background) this.#backgroundCount -= 1;
      else this.#runningCount -= 1;
      this.#drainSlots();
    };
  }

  #drainSlots(): void {
    for (let index = 0; index < this.#slotWaiters.length;) {
      const waiter = this.#slotWaiters[index]!;
      if (!this.#hasSlot(waiter.job)) {
        index += 1;
        continue;
      }
      this.#slotWaiters.splice(index, 1);
      if (waiter.job.cancel_requested || waiter.job.controller.signal.aborted) {
        waiter.onAbort();
        continue;
      }
      waiter.resolve(this.#takeSlot(waiter.job));
    }
  }

  #setPhase(job: InternalJob, key: string, message: string): void {
    if (isTerminal(job.state) || job.cancel_requested) return;
    if (job.phase_key !== key) {
      job.phase_key = key;
      job.phase_started_ms = performance.now();
    }
    job.message = boundedText(message, 850);
  }

  #onPreflight(job: InternalJob, progress: ExecutionPreflightProgress): void {
    this.#setPhase(
      job,
      `preflight:${progress.phase}`,
      '[EXECUTION_PREFLIGHT] ' +
        `phase=${progress.phase}; roots=${progress.roots}; entries=${progress.entries}; ` +
        `directories=${progress.directories}; depth=${progress.depth}; elapsed_ms=${progress.elapsed_ms}; ` +
        `entry_limit=${progress.entry_limit}; depth_limit=${progress.depth_limit}; ` +
        `duration_limit_ms=${progress.duration_limit_ms};`,
    );
  }

  #onStart(job: InternalJob, execution: ProjectExecutionStart): void {
    job.command = boundedText(execution.command, 4096);
    job.used_network = execution.used_network;
    this.#setPhase(job, 'running', '[EXECUTION_RUNNING] The local operation is running.');
  }

  #observedMessage(job: InternalJob): string {
    if (isTerminal(job.state) || job.cancel_requested) return job.message;
    const now = performance.now();
    const phaseElapsed = Math.max(0, Math.trunc(now - job.phase_started_ms));
    const queueMs = job.queue_ms ?? Math.max(0, Math.trunc(now - job.accepted_at_ms));
    return boundedText(
      `${job.message} phase_elapsed_ms=${phaseElapsed}; queue_ms=${queueMs};`,
      1000,
    );
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
    if (!job.receipt_pending) this.#finalizeTerminal(job);
  }

  async #persistReceipt(job: InternalJob): Promise<void> {
    if (!job.receipt_pending || !isTerminal(job.state)) return;
    try {
      await this.#goalLifecycle!.onFinish(this.#summary(job, true), job.input);
    } catch (error) {
      // Do not publish an operation as succeeded when its durable Goal receipt
      // could not be saved. The incomplete receipt also keeps Goal.complete closed.
      job.state = 'failed';
      job.error_code = error instanceof ChatSpliceError ? error.code : 'INTERNAL_ERROR';
      job.message =
        'Goal execution receipt could not be saved; inspect the Goal before continuing.';
    } finally {
      job.receipt_pending = false;
      this.#finalizeTerminal(job);
    }
  }

  #finalizeTerminal(job: InternalJob): void {
    if (job.terminal_notified) return;
    job.terminal_notified = true;
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

  #summary(job: InternalJob, exposeTerminal = false): ProjectExecSummary {
    return ProjectExecSummarySchema.parse({
      job_id: job.job_id,
      workspace_id: job.input.workspace_id,
      workspace_name: job.workspace_name,
      ...(job.input.reference_workspace_id === undefined
        ? {}
        : {
            reference_workspace_id: job.input.reference_workspace_id,
            reference_workspace_name: job.access.target.display_name,
          }),
      operation: job.input.operation,
      cwd: job.input.cwd,
      state:
        job.receipt_pending && isTerminal(job.state) && !exposeTerminal
          ? job.cancel_requested
            ? 'cancelling'
            : job.started_at === null
              ? 'queued'
              : 'running'
          : job.state,
      ...(job.input.goal_id === undefined ? {} : { goal_id: job.input.goal_id }),
      ...(job.input.criterion_id === undefined ? {} : { criterion_id: job.input.criterion_id }),
      command: job.command,
      created_at: job.created_at,
      started_at: job.started_at,
      finished_at: job.finished_at,
      exit_code: job.exit_code,
      error_code: job.error_code,
      message: this.#observedMessage(job),
      used_network: job.used_network,
      truncated: job.truncated,
      duration_ms: isTerminal(job.state) ? job.duration_ms : this.#duration(job),
    });
  }

  #job(job: InternalJob): ProjectExecJob {
    return ProjectExecJobSchema.parse({
      ...this.#summary(job),
      output: job.output,
      ...(job.readiness_result === undefined ? {} : { readiness_result: job.readiness_result }),
      ...(job.environment_result === undefined
        ? {}
        : { environment_result: job.environment_result }),
      ...(job.browser_result === undefined
        ? {}
        : {
            browser_result: {
              ...job.browser_result,
              screenshot_available: this.#images.has(job.job_id),
            },
          }),
    });
  }

  #retainImage(jobId: string, image: { data: Buffer; mimeType: 'image/jpeg' }): void {
    if (image.data.length > 1024 * 1024) return;
    while (this.#imageBytes + image.data.length > MAX_IMAGE_BYTES) {
      const oldest = this.#images.keys().next().value;
      if (oldest === undefined) break;
      this.#removeImage(oldest);
    }
    this.#images.set(jobId, image);
    this.#imageBytes += image.data.length;
  }

  #removeImage(jobId: string): void {
    this.#imageBytes -= this.#images.get(jobId)?.data.length ?? 0;
    this.#images.delete(jobId);
  }

  #trimRetainedJobs(): void {
    while (this.#jobs.size > MAX_RETAINED_JOBS && this.#terminalOrder.length > 0) {
      const jobId = this.#terminalOrder.shift();
      if (jobId === undefined) continue;
      const job = this.#jobs.get(jobId);
      if (job === undefined || !isTerminal(job.state)) continue;
      this.#jobs.delete(jobId);
      this.#removeImage(jobId);
      const requestKey = JSON.stringify([job.input.workspace_id, job.request_id]);
      const request = this.#jobsByRequest.get(requestKey);
      if (request?.job_id === jobId) this.#jobsByRequest.delete(requestKey);
    }
  }
}

export const PROJECT_EXECUTION_LIMITS = {
  max_retained_jobs: MAX_RETAINED_JOBS,
  max_pending_jobs: EMBEDDED_EXECUTION_CONCURRENCY.pending,
  max_running_jobs: EMBEDDED_EXECUTION_CONCURRENCY.foreground,
  max_background_jobs: EMBEDDED_EXECUTION_CONCURRENCY.background,
  max_image_bytes: MAX_IMAGE_BYTES,
  max_output_bytes: MAX_OUTPUT_BYTES,
  max_await_waiters: EXECUTION_STORAGE_LIMITS.await_waiters,
} as const;
