import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ChatSpliceError,
  GOAL_RECORD_MAX_BYTES,
  readCheckedFile,
  validateWorkspaceRelativePath,
  type GoalRepository,
  type StoredGoalRecord,
  type WorkspaceService,
} from '@chatsplice/core';
import {
  GoalOwnerReadInputSchema,
  GoalOwnerUpdateInputSchema,
  GoalRecordSchema,
  type GoalCheckpoint,
  type GoalCriterion,
  type GoalOwnerReadInput,
  type GoalOwnerUpdateInput,
  type GoalReadResult,
  type GoalReceipt,
  type GoalRecord,
  type GoalUpdateResult,
  type ProjectExecInput,
  type ProjectExecSummary,
} from '@chatsplice/protocol';

import type { ProjectExecutionService } from '../execution/service.js';

const FILE_LIMIT = 1024 * 1024;
const SNAPSHOT_LIMIT = 8 * 1024 * 1024;
const ACTIVE_RECEIPTS = new Set(['queued', 'running']);
const RECENT_RECEIPTS = 32;
const GOAL_PAGE_MAX_BYTES = 2 * 1024 * 1024 - 1024;

function retainedReceipts(record: StoredGoalRecord): GoalReceipt[] {
  const protectedJobs = new Set<string>();
  for (const receipt of record.receipts) {
    if (ACTIVE_RECEIPTS.has(receipt.state)) protectedJobs.add(receipt.job_id);
  }
  for (const criterion of record.criteria) {
    const evidenceJob = criterion.evidence?.job_id;
    if (evidenceJob !== undefined && evidenceJob !== null) protectedJobs.add(evidenceJob);
    // An older concurrent check must never replace a newer outcome after compaction.
    const latest = record.receipts
      .filter((receipt) => receipt.criterion_id === criterion.criterion_id)
      .at(-1);
    if (latest !== undefined) protectedJobs.add(latest.job_id);
  }
  const recentStart = Math.max(0, record.receipts.length - RECENT_RECEIPTS);
  return record.receipts.filter(
    (receipt, index) => index >= recentStart || protectedJobs.has(receipt.job_id),
  );
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(',')}}`;
}

function fail(message: string): never {
  throw new ChatSpliceError('BAD_REQUEST', message);
}

export interface GoalServiceOptions {
  readonly buildId: string;
  readonly runId: string;
  readonly isReadOnly?: () => boolean;
}

/** Durable task state; ChatGPT still owns reasoning and the decision to request each operation. */
export class GoalService {
  readonly #repository: GoalRepository;
  readonly #workspaces: WorkspaceService;
  readonly #options: GoalServiceOptions;
  readonly #beforeDigests = new Map<string, string>();
  #execution: ProjectExecutionService | undefined;

  public constructor(
    repository: GoalRepository,
    workspaces: WorkspaceService,
    options: GoalServiceOptions,
  ) {
    this.#repository = repository;
    this.#workspaces = workspaces;
    this.#options = options;
  }

  public setExecutionService(execution: ProjectExecutionService): void {
    this.#execution = execution;
  }

  public recoverInterrupted(): void {
    let offset = 0;
    while (true) {
      const records = this.#repository.listAll({ offset, limit: 32 });
      if (records.length === 0) break;
      offset += records.length;
      for (const record of records) {
        const interrupted = record.state === 'active' || record.state === 'cancelling';
        const uncertain = record.receipts.some((receipt) => ACTIVE_RECEIPTS.has(receipt.state));
        if (!interrupted && !uncertain) continue;
        this.#save(record, {
          state: interrupted ? 'interrupted' : record.state,
          receipts: record.receipts.map((receipt) =>
            ACTIVE_RECEIPTS.has(receipt.state)
              ? { ...receipt, state: 'interrupted', finished_at: new Date().toISOString() }
              : receipt,
          ),
          criteria: record.criteria.map((criterion) =>
            criterion.kind !== 'file' && criterion.status === 'passed'
              ? { ...criterion, status: 'stale' }
              : criterion,
          ),
          message:
            'Runtime restarted. Inspect current files, explicitly resume, and rerun required checks. Uncertain operations were not replayed.',
        });
      }
    }
  }

  public async read(request: GoalOwnerReadInput): Promise<GoalReadResult> {
    const input = GoalOwnerReadInputSchema.parse(request);
    this.#userWorkspace(input.workspace_id);
    let entered = false;
    const readRecords = async (): Promise<GoalReadResult> => {
      entered = true;
      const records =
        input.goal_id === undefined
          ? this.#repository.list(input.workspace_id, {
              offset: input.offset ?? 0,
              limit: input.limit ?? 32,
            })
          : [this.#get(input.workspace_id, input.goal_id)];
      const goals: GoalRecord[] = [];
      let bytes = 0;
      for (const record of records) {
        const goal = await this.#view(record);
        const size = Buffer.byteLength(JSON.stringify(goal), 'utf8') + 1;
        if (goals.length > 0 && bytes + size > GOAL_PAGE_MAX_BYTES) break;
        bytes += size;
        goals.push(goal);
      }
      const total = input.goal_id === undefined ? this.#repository.count(input.workspace_id) : 1;
      const nextOffset = (input.goal_id === undefined ? (input.offset ?? 0) : 0) + goals.length;
      const hasMore = nextOffset < total;
      return { goals, total, has_more: hasMore, next_offset: hasMore ? nextOffset : null };
    };
    try {
      return await this.#workspaces.withConcurrentOperation(input.workspace_id, readRecords);
    } catch (error) {
      const rootUnavailable =
        error instanceof ChatSpliceError
          ? error.code === 'PATH_OUTSIDE_WORKSPACE'
          : ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(
              (error as NodeJS.ErrnoException).code ?? '',
            );
      // Root validation may prevent a lease, but must not hide saved Goal metadata.
      // Repository/schema errors from inside the read remain explicit failures.
      if (entered || !rootUnavailable) throw error;
      return readRecords();
    }
  }

  public async update(request: GoalOwnerUpdateInput): Promise<GoalUpdateResult> {
    const input = GoalOwnerUpdateInputSchema.parse(request);
    this.#userWorkspace(input.workspace_id);
    if (input.action !== 'pause' && input.action !== 'cancel') {
      this.#assertWritable();
    }
    // Cancellation must not wait behind the very process it needs to stop.
    if (input.action === 'cancel') return this.#cancel(input);
    if (input.action === 'pause') {
      const record = this.#expected(input);
      if (record.state !== 'active') fail('Only an active Goal can be paused.');
      return {
        goal: await this.#view(
          this.#save(record, {
            state: 'paused',
            message: 'Paused. Running operations may finish; new operations are blocked.',
          }),
        ),
      };
    }
    if (input.action === 'delete') {
      const record = this.#expected(input);
      if (record.state !== 'completed' && record.state !== 'cancelled')
        fail('Only completed or cancelled Goals can be deleted.');
      const goal = await this.#view(record);
      this.#assertWritable();
      this.#repository.deleteTerminal(input.workspace_id, input.goal_id, input.expected_revision);
      return { goal, deleted: true };
    }
    // Reject owned work before waiting for the root; reset must not queue behind
    // a process whose history the user is trying to clear.
    if (input.action === 'reset') this.#assertResettable(this.#expected(input));
    return this.#workspaces.withOperation(input.workspace_id, async () => {
      // A queued mutation must honor a policy change while it awaited the root.
      this.#assertWritable();
      if (input.action === 'create') {
        const paths = [
          ...new Set([
            ...input.tracked_paths,
            ...input.criteria.flatMap((criterion) =>
              criterion.kind === 'file' ? [criterion.path] : [],
            ),
          ]),
        ].sort();
        if (paths.length > 32)
          fail('Tracked paths including file criteria exceed the 32-file limit.');
        const files = await this.#files(input.workspace_id, paths);
        this.#assertWritable();
        const now = new Date().toISOString();
        const rootIdentity = this.#rootIdentity(input.workspace_id);
        const record = this.#repository.insert({
          goal_id: `goal_${randomUUID()}`,
          workspace_id: input.workspace_id,
          objective: input.objective,
          scope: input.scope,
          tracked_paths: paths,
          criteria: input.criteria.map((criterion) => ({
            ...criterion,
            status: 'pending',
            evidence: null,
          })),
          state: 'active',
          revision: 1,
          created_at: now,
          updated_at: now,
          deadline_at: new Date(Date.now() + input.deadline_ms).toISOString(),
          max_executions: input.max_executions,
          executions_used: 0,
          checkpoint: { summary: '', next_step: input.next_step, files, saved_at: now },
          receipts: [],
          message: '',
          root_matches: true,
          evidence_valid: false,
          root_identity: rootIdentity,
        });
        return { goal: await this.#view(record) };
      }
      const record = this.#expected(input);
      this.#assertRoot(record);
      if (input.action === 'reset') {
        this.#assertResettable(record);
        const reset = this.#save(record, {
          state: 'paused',
          criteria: record.criteria.map((criterion) => ({
            ...criterion,
            status: 'pending',
            evidence: null,
          })),
          checkpoint:
            record.checkpoint === null
              ? null
              : { ...record.checkpoint, summary: '', next_step: '' },
          receipts: [],
          evidence_valid: false,
          message:
            'Verification results and visible execution history were cleared. Objective, files, execution usage and replay protection were retained. Explicitly resume to revalidate files and start fresh checks.',
        });
        for (const receipt of record.receipts) this.#beforeDigests.delete(receipt.job_id);
        return { goal: await this.#view(reset) };
      }
      if (input.action === 'resume') {
        if (record.state !== 'paused' && record.state !== 'interrupted')
          fail('Only a paused or interrupted Goal can be resumed.');
        if (record.receipts.some((receipt) => ACTIVE_RECEIPTS.has(receipt.state)))
          fail('Wait for running Goal operations to finish before resuming.');
        const deadline =
          input.deadline_ms === undefined
            ? record.deadline_at
            : new Date(Date.now() + input.deadline_ms).toISOString();
        const maxExecutions = input.max_executions ?? record.max_executions;
        if (Date.parse(deadline) <= Date.now())
          fail('Goal deadline expired. Supply deadline_ms to explicitly renew it.');
        if (maxExecutions !== 0 && maxExecutions <= record.executions_used)
          fail(
            'Execution budget is exhausted. Supply a larger max_executions or zero for no count limit to resume.',
          );
        const view = await this.#view(record);
        const files = await this.#files(record.workspace_id, record.tracked_paths);
        this.#assertWritable();
        const changed = stable(files) !== stable(record.checkpoint?.files);
        return {
          goal: await this.#view(
            this.#save(record, {
              state: 'active',
              deadline_at: deadline,
              max_executions: maxExecutions,
              criteria: view.criteria,
              checkpoint: {
                summary: record.checkpoint?.summary ?? '',
                next_step: record.checkpoint?.next_step ?? '',
                files,
                saved_at: new Date().toISOString(),
              },
              message: changed
                ? 'Resumed after detecting changed files. Required stale checks must be rerun.'
                : 'Resumed after revalidating the workspace and tracked files.',
            }),
          ),
        };
      }
      if (record.state !== 'active' && record.state !== 'paused')
        fail('This Goal does not accept checkpoint, verification or completion updates.');
      const files = await this.#files(record.workspace_id, record.tracked_paths);
      this.#assertWritable();
      const scopeDigest = digest(stable(files));
      if (input.action === 'checkpoint') {
        return {
          goal: await this.#view(
            this.#save(record, {
              checkpoint: {
                summary: input.summary,
                next_step: input.next_step,
                files,
                saved_at: new Date().toISOString(),
              },
            }),
          ),
        };
      }
      if (input.action === 'verify_file') {
        const criterion = record.criteria.find(
          (candidate) => candidate.criterion_id === input.criterion_id,
        );
        if (criterion?.kind !== 'file') fail('verify_file requires a registered file criterion.');
        const sha = files.find((file) => file.path === criterion.path)?.sha256;
        if (sha === undefined || sha === null) fail('The required file does not exist.');
        const criteria = record.criteria.map((candidate): GoalCriterion =>
          candidate.criterion_id === criterion.criterion_id
            ? {
                ...candidate,
                status: 'passed',
                evidence: {
                  kind: 'file',
                  job_id: null,
                  sha256: sha,
                  scope_digest: scopeDigest,
                  build_id: this.#options.buildId,
                  run_id: this.#options.runId,
                  verified_at: new Date().toISOString(),
                },
              }
            : candidate,
        );
        return { goal: await this.#view(this.#save(record, { criteria })) };
      }
      if (record.state !== 'active') fail('Resume the Goal before completing it.');
      if (record.receipts.some((receipt) => ACTIVE_RECEIPTS.has(receipt.state)))
        fail('Goal operations are still queued or running. Wait for cleanup before completing.');
      const view = await this.#view(record);
      this.#assertWritable();
      if (!view.evidence_valid)
        fail(
          'Required acceptance evidence is missing, failed or stale. Verify files and rerun the matching checks/browser assertions.',
        );
      return {
        goal: await this.#view(
          this.#save(record, {
            state: 'completed',
            criteria: view.criteria,
            message: 'All required criteria passed against the current tracked files.',
          }),
        ),
      };
    });
  }

  public onSubmit(summary: ProjectExecSummary, input: ProjectExecInput): void {
    if (input.goal_id === undefined) return;
    const record = this.#get(input.workspace_id, input.goal_id);
    this.#assertActive(record);
    this.#assertRoot(record);
    if (record.max_executions !== 0 && record.executions_used >= record.max_executions)
      fail(
        'Goal execution budget is exhausted. Pause and explicitly renew the budget before continuing.',
      );
    if (record.executions_used >= Number.MAX_SAFE_INTEGER)
      fail('Goal execution counter cannot represent another operation.');
    if (this.#repository.hasExecutionRequest(record.goal_id, digest(stable(input))))
      fail(
        'This Goal execution request is already recorded. Read the current Goal before intentionally starting a new request; do not replay uncertain work.',
      );
    if (input.criterion_id !== undefined) {
      const criterion = record.criteria.find(
        (candidate) => candidate.criterion_id === input.criterion_id,
      );
      if (criterion === undefined || criterion.kind === 'file')
        fail('Execution must reference a matching check or browser criterion.');
      if ('background' in input.operation && input.operation.background)
        fail('Acceptance checks must finish in the foreground.');
      const checkOperation =
        input.operation.kind === 'node_script'
          ? { kind: input.operation.kind, script: input.operation.script }
          : input.operation;
      if (
        criterion.kind === 'check' &&
        (input.cwd !== criterion.cwd || stable(checkOperation) !== stable(criterion.operation))
      )
        fail('Execution does not match the declared check criterion.');
      if (
        criterion.kind === 'browser' &&
        (input.operation.kind !== 'browser' ||
          input.operation.action.kind !== 'assert' ||
          stable(input.operation.action.expectation) !== stable(criterion.expectation))
      )
        fail('Execution must assert the declared browser expectation.');
    }
    const changes: Partial<StoredGoalRecord> = {
      executions_used: record.executions_used + 1,
      receipts: [
        ...record.receipts,
        {
          job_id: summary.job_id,
          request_hash: digest(stable(input)),
          criterion_id: input.criterion_id ?? null,
          state: 'queued',
          build_id: this.#options.buildId,
          run_id: this.#options.runId,
          created_at: summary.created_at,
          started_at: null,
          finished_at: null,
          exit_code: null,
        },
      ],
      criteria: record.criteria.map((criterion) =>
        criterion.criterion_id === input.criterion_id
          ? { ...criterion, status: 'pending', evidence: null }
          : criterion,
      ),
    };
    this.#save(record, changes);
  }

  public async beforeStart(summary: ProjectExecSummary, input: ProjectExecInput): Promise<void> {
    if (input.goal_id === undefined) return;
    let record = this.#get(input.workspace_id, input.goal_id);
    this.#assertActive(record);
    this.#assertRoot(record);
    const files = await this.#files(record.workspace_id, record.tracked_paths);
    this.#beforeDigests.set(summary.job_id, digest(stable(files)));
    record = this.#get(input.workspace_id, input.goal_id);
    this.#assertActive(record);
    this.#save(record, {
      receipts: record.receipts.map((receipt) =>
        receipt.job_id === summary.job_id
          ? { ...receipt, state: 'running', started_at: new Date().toISOString() }
          : receipt,
      ),
    });
  }

  /** A published dependency cache changes runtime evidence, including unlinked repairs. */
  public onRuntimeChanged(workspaceId: string): void {
    const identity = this.#rootIdentity(workspaceId);
    let offset = 0;
    while (true) {
      const records = this.#repository.listAll({ offset, limit: 32 });
      if (records.length === 0) return;
      offset += records.length;
      for (const record of records) {
        if (record.root_identity !== identity) continue;
        // A concurrent browser assertion may finish after publication. Its
        // earlier source snapshot must not certify the changed environment.
        for (const receipt of record.receipts) {
          if (ACTIVE_RECEIPTS.has(receipt.state)) this.#beforeDigests.delete(receipt.job_id);
        }
        let changed = false;
        const criteria = record.criteria.map((criterion): GoalCriterion => {
          if (criterion.kind === 'file' || criterion.status !== 'passed') return criterion;
          changed = true;
          return { ...criterion, status: 'stale' };
        });
        if (!changed) continue;
        this.#save(record, {
          criteria,
          message:
            'The managed Cargo cache changed. Rerun runtime checks; file evidence and Goal state were preserved.',
        });
      }
    }
  }

  public executionTimeout(input: ProjectExecInput): number {
    if (input.goal_id === undefined) return input.timeout_ms;
    const record = this.#get(input.workspace_id, input.goal_id);
    const remaining = Date.parse(record.deadline_at) - Date.now();
    if (remaining < 1000)
      fail('Goal deadline is too close to start another operation. Explicitly renew it.');
    return Math.min(input.timeout_ms, remaining);
  }

  public async onFinish(summary: ProjectExecSummary, input: ProjectExecInput): Promise<void> {
    if (input.goal_id === undefined) return;
    const before = this.#beforeDigests.get(summary.job_id);
    this.#beforeDigests.delete(summary.job_id);
    let scopeDigest: string | undefined;
    if (summary.state === 'succeeded' && input.criterion_id !== undefined) {
      try {
        this.#assertRoot(this.#get(input.workspace_id, input.goal_id));
        scopeDigest = digest(
          stable(
            await this.#files(
              input.workspace_id,
              this.#get(input.workspace_id, input.goal_id).tracked_paths,
            ),
          ),
        );
      } catch {
        // Receipt still records the actual execution outcome; invalid files cannot earn evidence.
      }
    }
    const record = this.#get(input.workspace_id, input.goal_id);
    // A late duplicate callback must not recreate history or evidence cleared
    // by an explicit reset (or overwrite a compacted terminal outcome).
    if (!record.receipts.some((receipt) => receipt.job_id === summary.job_id)) return;
    const valid = summary.state === 'succeeded' && before !== undefined && before === scopeDigest;
    const terminalState =
      summary.state === 'queued' || summary.state === 'running' || summary.state === 'cancelling'
        ? 'interrupted'
        : summary.state;
    const latest = record.receipts
      .filter((receipt) => receipt.criterion_id === input.criterion_id)
      .at(-1)?.job_id;
    const criteria = record.criteria.map((criterion): GoalCriterion =>
      criterion.criterion_id === input.criterion_id && latest === summary.job_id
        ? {
            ...criterion,
            status: valid ? 'passed' : summary.state === 'succeeded' ? 'stale' : 'failed',
            evidence: valid
              ? {
                  kind: criterion.kind,
                  job_id: summary.job_id,
                  sha256: null,
                  scope_digest: scopeDigest!,
                  build_id: this.#options.buildId,
                  run_id: this.#options.runId,
                  verified_at: new Date().toISOString(),
                }
              : null,
          }
        : criterion,
    );
    const receipts = record.receipts.map((receipt): GoalReceipt =>
      receipt.job_id === summary.job_id
        ? {
            ...receipt,
            state: terminalState,
            started_at: summary.started_at,
            finished_at: summary.finished_at ?? new Date().toISOString(),
            exit_code: summary.exit_code,
          }
        : receipt,
    );
    this.#save(record, {
      criteria,
      receipts,
      ...(record.state === 'cancelling' &&
      !receipts.some((receipt) => ACTIVE_RECEIPTS.has(receipt.state))
        ? {
            state: 'cancelled',
            message: 'Cancelled after owned process cleanup. File changes were retained.',
          }
        : {}),
    });
  }

  async #cancel(
    input: Extract<GoalOwnerUpdateInput, { action: 'cancel' }>,
  ): Promise<GoalUpdateResult> {
    let record = this.#expected(input);
    if (record.state === 'completed' || record.state === 'cancelled')
      fail('This Goal is already terminal.');
    record = this.#save(record, {
      state: 'cancelling',
      message: 'Cancelling only executions owned by this Goal; waiting for process cleanup.',
    });
    for (const receipt of record.receipts.filter((candidate) =>
      ACTIVE_RECEIPTS.has(candidate.state),
    )) {
      if (receipt.run_id !== this.#options.runId || this.#execution === undefined) continue;
      try {
        this.#execution.cancel(record.workspace_id, receipt.job_id);
      } catch {
        /* A terminal receipt may race with cancellation. */
      }
    }
    const end = Date.now() + 25_000;
    while (Date.now() < end) {
      record = this.#get(input.workspace_id, input.goal_id);
      const active = record.receipts.filter((receipt) => ACTIVE_RECEIPTS.has(receipt.state));
      if (active.length === 0)
        return {
          goal: await this.#view(
            record.state === 'cancelled'
              ? record
              : this.#save(record, {
                  state: 'cancelled',
                  message: 'Cancelled after owned process cleanup. File changes were retained.',
                }),
          ),
        };
      if (this.#execution === undefined) break;
      const results = await Promise.all(
        active.map((receipt) =>
          this.#execution!.waitForCompletion(input.workspace_id, receipt.job_id, 1000).catch(
            () => undefined,
          ),
        ),
      );
      // A failed durable write can leave a running receipt after the execution
      // has cleaned up. Reconcile terminal process state without awarding evidence.
      const terminal = results.filter(
        (job) =>
          job !== undefined &&
          job.goal_id === input.goal_id &&
          job.state !== 'queued' &&
          job.state !== 'running' &&
          job.state !== 'cancelling',
      );
      if (terminal.length > 0) {
        record = this.#get(input.workspace_id, input.goal_id);
        const receipts = record.receipts.map((receipt): GoalReceipt => {
          const job = terminal.find((candidate) => candidate?.job_id === receipt.job_id);
          if (job === undefined || !ACTIVE_RECEIPTS.has(receipt.state)) return receipt;
          const state =
            job.state === 'queued' || job.state === 'running' || job.state === 'cancelling'
              ? 'interrupted'
              : job.state;
          return {
            ...receipt,
            state,
            started_at: job.started_at,
            finished_at: job.finished_at ?? new Date().toISOString(),
            exit_code: job.exit_code,
          };
        });
        if (stable(receipts) !== stable(record.receipts))
          this.#save(record, {
            receipts,
            ...(!receipts.some((receipt) => ACTIVE_RECEIPTS.has(receipt.state))
              ? {
                  state: 'cancelled',
                  message: 'Cancelled after owned process cleanup. File changes were retained.',
                }
              : {}),
          });
      }
      // Missing or unreconciled jobs remain uncertain, and must not cause a busy loop.
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    return { goal: await this.#view(this.#get(input.workspace_id, input.goal_id)) };
  }

  #userWorkspace(workspaceId: string): void {
    if (this.#workspaces.getRecord(workspaceId).kind !== 'user')
      fail('Goals are available only for registered user workspaces.');
  }

  #assertWritable(): void {
    if (this.#options.isReadOnly?.())
      throw new ChatSpliceError(
        'READ_ONLY_MODE_ENABLED',
        'Read-only mode prevents Goal mutation. Pause and cancel remain available.',
      );
  }

  #get(workspaceId: string, goalId: string): StoredGoalRecord {
    const record = this.#repository.find(goalId);
    if (record === undefined || record.workspace_id !== workspaceId)
      fail('Goal does not exist in the selected workspace.');
    return record;
  }

  #expected(input: {
    workspace_id: string;
    goal_id: string;
    expected_revision: number;
  }): StoredGoalRecord {
    const record = this.#get(input.workspace_id, input.goal_id);
    if (record.revision !== input.expected_revision)
      fail('Goal revision changed. Read the current Goal before retrying.');
    return record;
  }

  #assertResettable(record: StoredGoalRecord): void {
    if (
      record.state === 'cancelling' ||
      record.receipts.some((receipt) => ACTIVE_RECEIPTS.has(receipt.state))
    )
      fail(
        'Wait for all owned Goal operations and cancellation cleanup to finish before resetting history.',
      );
  }

  #save(record: StoredGoalRecord, changes: Partial<StoredGoalRecord>): StoredGoalRecord {
    const candidate = {
      ...record,
      ...changes,
      revision: record.revision + 1,
      updated_at: new Date().toISOString(),
    };
    const next = { ...candidate, receipts: retainedReceipts(candidate) };
    if (next.receipts.some((receipt) => ACTIVE_RECEIPTS.has(receipt.state))) {
      // Keep room for completion/recovery on every update, including checkpoints.
      const projected = {
        ...next,
        receipts: next.receipts.map((receipt) => ({
          ...receipt,
          started_at: next.updated_at,
          finished_at: next.updated_at,
          exit_code: -2147483648,
        })),
        criteria: next.criteria.map((criterion) => ({
          ...criterion,
          status: 'passed',
          evidence: {
            kind: criterion.kind,
            job_id: 'exec_00000000-0000-0000-0000-000000000000',
            sha256: '0'.repeat(64),
            scope_digest: '0'.repeat(64),
            build_id: this.#options.buildId,
            run_id: this.#options.runId,
            verified_at: next.updated_at,
          },
        })),
      };
      if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > GOAL_RECORD_MAX_BYTES - 512)
        fail(
          'Goal metadata cannot reserve durable completion evidence. Reduce oversized criteria or checkpoint metadata; retained history was already compacted.',
        );
    }
    return this.#repository.replace(next, record.revision);
  }

  #assertActive(record: StoredGoalRecord): void {
    if (record.state !== 'active')
      fail('Goal is not active. Explicitly resume it before requesting execution.');
    if (Date.parse(record.deadline_at) <= Date.now())
      fail('Goal deadline expired. Pause and explicitly renew it before continuing.');
  }

  #rootIdentity(workspaceId: string): string {
    const root = this.#workspaces.getRecord(workspaceId).rootPath;
    if (realpathSync(root) !== root) fail('The registered workspace root changed.');
    const metadata = lstatSync(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      fail('Workspace root is no longer a real directory.');
    return digest(stable([root, metadata.dev, metadata.ino]));
  }

  #assertRoot(record: StoredGoalRecord): void {
    if (this.#rootIdentity(record.workspace_id) !== record.root_identity)
      fail('Goal workspace root changed. Create a new Goal for the current root.');
  }

  async #files(workspaceId: string, paths: readonly string[]): Promise<GoalCheckpoint['files']> {
    const identity = this.#rootIdentity(workspaceId);
    const root = this.#workspaces.getRecord(workspaceId).rootPath;
    const files: GoalCheckpoint['files'] = [];
    let bytes = 0;
    for (const path of paths) {
      validateWorkspaceRelativePath(path, 'Goal snapshot');
      let missing = false;
      const parts = path.split('/');
      for (let i = 1; i <= parts.length; i += 1) {
        const target = join(root, ...parts.slice(0, i));
        try {
          const metadata = await lstat(target);
          if (metadata.isSymbolicLink() || (i < parts.length && !metadata.isDirectory()))
            fail('Goal snapshots do not follow symbolic links or non-directory parents.');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          missing = true;
          break;
        }
      }
      if (missing) {
        files.push({ path, sha256: null });
        continue;
      }
      const target = join(root, path);
      if ((await realpath(target)) !== target) fail('Goal snapshot path changed.');
      const checked = await readCheckedFile(target, FILE_LIMIT);
      bytes += checked.bytes.length;
      if (bytes > SNAPSHOT_LIMIT)
        fail('Goal tracked files exceed the 8 MiB aggregate snapshot limit.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(checked.bytes);
      if (text.includes('\0')) fail('Goal tracked files must be UTF-8 text files.');
      if ((await realpath(target)) !== target) fail('Goal snapshot path changed during reading.');
      files.push({ path, sha256: digest(checked.bytes) });
    }
    if (identity !== this.#rootIdentity(workspaceId))
      fail('Workspace root changed during Goal snapshot.');
    return files;
  }

  async #view(record: StoredGoalRecord): Promise<GoalRecord> {
    let rootMatches = false;
    let scopeDigest: string | undefined;
    let files: GoalCheckpoint['files'] = [];
    try {
      rootMatches = this.#rootIdentity(record.workspace_id) === record.root_identity;
      if (rootMatches) {
        files = await this.#files(record.workspace_id, record.tracked_paths);
        scopeDigest = digest(stable(files));
      }
    } catch {
      /* A moved root or denied/changed path is visible as invalid evidence. */
    }
    const criteria = record.criteria.map((criterion): GoalCriterion => {
      if (criterion.status !== 'passed') return criterion;
      const evidence = criterion.evidence;
      const receipt =
        evidence?.job_id === null
          ? undefined
          : record.receipts.find((candidate) => candidate.job_id === evidence?.job_id);
      const valid =
        rootMatches &&
        evidence !== null &&
        evidence.kind === criterion.kind &&
        evidence.scope_digest === scopeDigest &&
        (criterion.kind === 'file'
          ? evidence.job_id === null &&
            evidence.sha256 !== null &&
            files.some((file) => file.path === criterion.path && file.sha256 === evidence.sha256)
          : evidence.build_id === this.#options.buildId &&
            evidence.run_id === this.#options.runId &&
            receipt?.criterion_id === criterion.criterion_id &&
            receipt.state === 'succeeded' &&
            receipt.exit_code === 0 &&
            receipt.build_id === evidence.build_id &&
            receipt.run_id === evidence.run_id);
      return valid ? criterion : { ...criterion, status: 'stale' };
    });
    const { root_identity: _rootIdentity, ...publicRecord } = record;
    void _rootIdentity;
    return GoalRecordSchema.parse({
      ...publicRecord,
      criteria,
      root_matches: rootMatches,
      evidence_valid:
        rootMatches &&
        criteria.every((criterion) => !criterion.required || criterion.status === 'passed'),
    });
  }
}
