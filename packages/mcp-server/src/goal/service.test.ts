import { randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SqliteGoalRepository,
  SqliteWorkspaceRepository,
  WorkspaceService,
} from '@chatsplice/core';
import {
  GoalOwnerUpdateInputSchema,
  type GoalRecord,
  type ProjectExecInput,
} from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProjectExecutionService } from '../execution/service.js';
import type { ProjectExecutionBackend } from '../execution/backend.js';
import { GoalService } from './service.js';

const BUILD = 'a'.repeat(64);
const BINDING = `wb_${'0'.repeat(64)}`;

describe('persistent Goal runtime', () => {
  let temporary: string;
  let root: string;
  let workspaceId: string;
  let workspaceRepository: SqliteWorkspaceRepository;
  let repository: SqliteGoalRepository;
  let workspaces: WorkspaceService;
  let service: GoalService;
  let executions: ProjectExecutionService[];
  let readOnly: boolean;

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'chatsplice-goal-runtime-'));
    root = join(temporary, 'project');
    await mkdir(root);
    await writeFile(join(root, 'source.ts'), 'export const result = 1;\n');
    workspaceRepository = new SqliteWorkspaceRepository(join(temporary, 'state.sqlite'));
    repository = new SqliteGoalRepository(join(temporary, 'state.sqlite'));
    workspaces = new WorkspaceService(workspaceRepository);
    workspaceId = (await workspaces.register({ root_path: root })).workspace_id;
    readOnly = false;
    executions = [];
    service = new GoalService(repository, workspaces, {
      buildId: BUILD,
      runId: randomUUID(),
      isReadOnly: () => readOnly,
    });
  });

  afterEach(async () => {
    for (const execution of executions) await execution.shutdown();
    repository.close();
    workspaceRepository.close();
    await rm(temporary, { recursive: true, force: true });
  });

  async function create(
    criteria: unknown[] = [
      {
        kind: 'file',
        criterion_id: 'source',
        description: 'Source file exists',
        path: 'source.ts',
      },
      {
        kind: 'check',
        criterion_id: 'test',
        description: 'Declared tests pass',
        operation: { kind: 'node_script', script: 'test' },
      },
    ],
    extras: Record<string, unknown> = {},
  ): Promise<GoalRecord> {
    return (
      await service.update(
        GoalOwnerUpdateInputSchema.parse({
          action: 'create',
          workspace_id: workspaceId,
          objective: 'Implement and verify the result',
          tracked_paths: ['source.ts'],
          criteria,
          ...extras,
        }),
      )
    ).goal;
  }

  async function current(goal: GoalRecord): Promise<GoalRecord> {
    return (await service.read({ workspace_id: workspaceId, goal_id: goal.goal_id })).goals[0]!;
  }

  function execution(
    backend: ProjectExecutionBackend = async () => ({
      exit_code: 0,
      duration_ms: 1,
      timed_out: false,
    }),
  ): ProjectExecutionService {
    const result = new ProjectExecutionService(workspaces, { backend, goalLifecycle: service });
    service.setExecutionService(result);
    executions.push(result);
    return result;
  }

  function check(goal: GoalRecord, requestId = `request-${randomUUID()}`): ProjectExecInput {
    return {
      workspace_id: workspaceId,
      workspace_binding: BINDING,
      request_id: requestId,
      goal_id: goal.goal_id,
      criterion_id: 'test',
      cwd: '.',
      timeout_ms: 5000,
      operation: { kind: 'node_script', script: 'test' },
    };
  }

  it('resets verification history while preserving the task, files and last file baseline', async () => {
    let goal = await create(undefined, { scope: 'Keep the declared scope' });
    goal = (
      await service.update({
        action: 'verify_file',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
        criterion_id: 'source',
      })
    ).goal;
    const runner = execution();
    const request = check(goal);
    await runner.waitForCompletion(workspaceId, runner.submit(request).job_id);
    goal = await current(goal);
    goal = (
      await service.update({
        action: 'checkpoint',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
        summary: 'Old conclusions',
        next_step: 'Old next step',
      })
    ).goal;
    expect(goal.evidence_valid).toBe(true);
    const previous = goal;
    const changedSource = 'export const result = 2;\n';
    await writeFile(join(root, 'source.ts'), changedSource);

    goal = (
      await service.update({
        action: 'reset',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
      })
    ).goal;
    expect(goal).toMatchObject({
      goal_id: previous.goal_id,
      workspace_id: previous.workspace_id,
      objective: previous.objective,
      scope: previous.scope,
      tracked_paths: previous.tracked_paths,
      created_at: previous.created_at,
      state: 'paused',
      revision: previous.revision + 1,
      deadline_at: previous.deadline_at,
      max_executions: previous.max_executions,
      executions_used: previous.executions_used,
      receipts: [],
      evidence_valid: false,
    });
    expect(goal.checkpoint).toEqual({
      ...previous.checkpoint,
      summary: '',
      next_step: '',
    });
    expect(goal.criteria).toEqual(
      previous.criteria.map((criterion) => ({
        ...criterion,
        status: 'pending',
        evidence: null,
      })),
    );
    expect(await readFile(join(root, 'source.ts'), 'utf8')).toBe(changedSource);
    expect(repository.count(workspaceId)).toBe(1);
    expect(() => runner.submit(check(goal))).toThrow('not active');

    goal = (
      await service.update({
        action: 'resume',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
        deadline_ms: 10_000,
      })
    ).goal;
    expect(goal.state).toBe('active');
    expect(goal.checkpoint?.files).not.toEqual(previous.checkpoint?.files);
    expect(goal.criteria.every((criterion) => criterion.status === 'pending')).toBe(true);
    expect(goal.evidence_valid).toBe(false);
  });

  it.each(['paused', 'interrupted', 'completed', 'cancelled'] as const)(
    'can explicitly reset an idle %s Goal without replacing its identity or objective',
    async (state) => {
      let goal = await create([
        {
          kind: 'file',
          criterion_id: 'source',
          description: 'Source file exists',
          path: 'source.ts',
        },
      ]);
      goal = (
        await service.update({
          action: 'verify_file',
          workspace_id: workspaceId,
          goal_id: goal.goal_id,
          expected_revision: goal.revision,
          criterion_id: 'source',
        })
      ).goal;
      if (state === 'interrupted') {
        service.recoverInterrupted();
        goal = await current(goal);
      } else {
        goal = (
          await service.update({
            action: state === 'paused' ? 'pause' : state === 'completed' ? 'complete' : 'cancel',
            workspace_id: workspaceId,
            goal_id: goal.goal_id,
            expected_revision: goal.revision,
          })
        ).goal;
      }
      expect(goal.state).toBe(state);
      const before = goal;
      goal = (
        await service.update({
          action: 'reset',
          workspace_id: workspaceId,
          goal_id: goal.goal_id,
          expected_revision: goal.revision,
        })
      ).goal;
      expect(goal).toMatchObject({
        goal_id: before.goal_id,
        objective: before.objective,
        state: 'paused',
        revision: before.revision + 1,
        evidence_valid: false,
      });
      expect(goal.criteria[0]).toMatchObject({ status: 'pending', evidence: null });
      expect(goal.receipts).toEqual([]);
    },
  );

  it('retains durable replay protection after reset and reopening while allowing a fresh request', async () => {
    let goal = await create();
    const runner = execution();
    const original = check(goal, 'reset-retains-request');
    await runner.waitForCompletion(workspaceId, runner.submit(original).job_id);
    goal = await current(goal);
    goal = (
      await service.update({
        action: 'reset',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
      })
    ).goal;
    await runner.shutdown();
    repository.close();
    repository = new SqliteGoalRepository(join(temporary, 'state.sqlite'));
    service = new GoalService(repository, workspaces, { buildId: BUILD, runId: randomUUID() });
    service.recoverInterrupted();
    goal = await current(goal);
    expect(goal).toMatchObject({ state: 'paused', executions_used: 1, receipts: [] });
    goal = (
      await service.update({
        action: 'resume',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
        deadline_ms: 10_000,
      })
    ).goal;
    const restarted = execution();
    expect(() => restarted.submit(original)).toThrow('already recorded');
    expect(restarted.list()).toHaveLength(0);
    await restarted.waitForCompletion(
      workspaceId,
      restarted.submit(check(goal, 'reset-fresh-request')).job_id,
    );
    expect(await current(goal)).toMatchObject({ executions_used: 2 });
    expect((await current(goal)).receipts).toHaveLength(1);
  });

  it('rejects reset while completion evidence is pending and permits it only after cleanup', async () => {
    let goal = await create();
    let entered!: () => void;
    let release!: () => void;
    const completionStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holdCompletion = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finish = service.onFinish.bind(service);
    service.onFinish = async (summary, input) => {
      entered();
      await holdCompletion;
      await finish(summary, input);
    };
    const runner = execution();
    const job = runner.submit(check(goal));
    await completionStarted;
    try {
      goal = await current(goal);
      const before = goal;
      expect(goal.receipts[0]?.state).toBe('running');
      await expect(
        service.update({
          action: 'reset',
          workspace_id: workspaceId,
          goal_id: goal.goal_id,
          expected_revision: goal.revision,
        }),
      ).rejects.toThrow('owned Goal operations');
      expect(await current(goal)).toEqual(before);
    } finally {
      release();
    }
    await runner.waitForCompletion(workspaceId, job.job_id);
    goal = await current(goal);
    expect(
      (
        await service.update({
          action: 'reset',
          workspace_id: workspaceId,
          goal_id: goal.goal_id,
          expected_revision: goal.revision,
        })
      ).goal.receipts,
    ).toEqual([]);
  });

  it('ignores a late duplicate completion after reset instead of recreating evidence or history', async () => {
    let goal = await create();
    const runner = execution();
    const request = check(goal);
    const completed = await runner.waitForCompletion(workspaceId, runner.submit(request).job_id);
    goal = await current(goal);
    goal = (
      await service.update({
        action: 'reset',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
      })
    ).goal;
    await service.onFinish(completed, request);
    expect(await current(goal)).toEqual(goal);
  });

  it('requires a current revision, writable policy and the same workspace root for reset', async () => {
    let goal = await create();
    const original = goal;
    goal = (
      await service.update({
        action: 'checkpoint',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
        summary: 'Keep on rejected reset',
        next_step: 'Continue',
      })
    ).goal;
    const reset = {
      action: 'reset' as const,
      workspace_id: workspaceId,
      goal_id: goal.goal_id,
      expected_revision: goal.revision,
    };
    await expect(
      service.update({ ...reset, expected_revision: original.revision }),
    ).rejects.toThrow('revision changed');
    readOnly = true;
    await expect(service.update(reset)).rejects.toThrow('Read-only');
    readOnly = false;
    expect(await current(goal)).toEqual(goal);

    const otherRoot = join(temporary, 'other');
    await mkdir(otherRoot);
    const otherId = (await workspaces.register({ root_path: otherRoot })).workspace_id;
    await expect(service.update({ ...reset, workspace_id: otherId })).rejects.toThrow(
      'selected workspace',
    );
    const replacementRoot = join(temporary, 'replacement');
    await mkdir(replacementRoot);
    await writeFile(join(replacementRoot, 'source.ts'), 'Different root\n');
    await workspaces.updateRootPath(workspaceId, replacementRoot);
    await expect(service.update(reset)).rejects.toThrow('root changed');
    expect(repository.find(goal.goal_id)?.revision).toBe(goal.revision);
    expect(repository.find(goal.goal_id)?.checkpoint?.summary).toBe('Keep on rejected reset');
  });

  it('does not reset a cancelling Goal even when its receipt list is empty', async () => {
    const goal = await create();
    const saved = repository.find(goal.goal_id)!;
    const cancelling = repository.replace(
      { ...saved, state: 'cancelling', revision: saved.revision + 1 },
      saved.revision,
    );
    await expect(
      service.update({
        action: 'reset',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: cancelling.revision,
      }),
    ).rejects.toThrow('cancellation cleanup');
    expect(repository.find(goal.goal_id)).toEqual(cancelling);
  });

  it('keeps an exhausted explicit budget after reset until the user renews it', async () => {
    let goal = await create(undefined, { max_executions: 1 });
    const runner = execution();
    await runner.waitForCompletion(workspaceId, runner.submit(check(goal)).job_id);
    goal = await current(goal);
    goal = (
      await service.update({
        action: 'reset',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
      })
    ).goal;
    expect(goal).toMatchObject({ max_executions: 1, executions_used: 1, receipts: [] });
    const resume = {
      action: 'resume' as const,
      workspace_id: workspaceId,
      goal_id: goal.goal_id,
      expected_revision: goal.revision,
      deadline_ms: 10_000,
    };
    await expect(service.update(resume)).rejects.toThrow('budget is exhausted');
    expect((await service.update({ ...resume, max_executions: 0 })).goal).toMatchObject({
      state: 'active',
      max_executions: 0,
      executions_used: 1,
    });
  });

  it.each(['paused', 'completed', 'cancelled'] as const)(
    'invalidates runtime evidence after an unlinked successful repair while preserving %s state and file evidence',
    async (state) => {
      let goal = await create();
      goal = (
        await service.update({
          action: 'verify_file',
          workspace_id: workspaceId,
          goal_id: goal.goal_id,
          expected_revision: goal.revision,
          criterion_id: 'source',
        })
      ).goal;
      const runner = execution(async (_service, input) => ({
        exit_code: 0,
        duration_ms: 1,
        timed_out: false,
        ...(input.operation.kind === 'install' && input.operation.repair_cache === true
          ? { cargo_cache_repaired: true as const }
          : {}),
      }));
      await runner.waitForCompletion(workspaceId, runner.submit(check(goal)).job_id);
      goal = await current(goal);
      goal = (
        await service.update({
          action: 'checkpoint',
          workspace_id: workspaceId,
          goal_id: goal.goal_id,
          expected_revision: goal.revision,
          summary: 'Keep this checkpoint',
          next_step: 'Continue after repair',
        })
      ).goal;
      goal = (
        await service.update({
          action: state === 'paused' ? 'pause' : state === 'completed' ? 'complete' : 'cancel',
          workspace_id: workspaceId,
          goal_id: goal.goal_id,
          expected_revision: goal.revision,
        })
      ).goal;
      const before = await current(goal);
      const job = runner.submit({
        workspace_id: workspaceId,
        workspace_binding: BINDING,
        request_id: `repair-unlinked-${state}`,
        cwd: '.',
        timeout_ms: 5000,
        operation: { kind: 'install', ecosystem: 'rust', mode: 'locked', repair_cache: true },
      });
      expect((await runner.waitForCompletion(workspaceId, job.job_id)).state).toBe('succeeded');
      const after = await current(goal);
      expect(after.state).toBe(state);
      expect(after.checkpoint).toEqual(before.checkpoint);
      expect(after.receipts).toEqual(before.receipts);
      expect(after.executions_used).toBe(before.executions_used);
      expect(after.criteria[0]).toEqual(before.criteria[0]);
      expect(after.criteria[1]?.status).toBe('stale');
      expect(after.evidence_valid).toBe(false);
    },
  );

  it.each([0, 101])(
    'does not invalidate evidence from an install exit %i without publication evidence',
    async (exitCode) => {
      const goal = await create();
      const runner = execution(async (_service, input) => ({
        exit_code: input.operation.kind === 'install' ? exitCode : 0,
        duration_ms: 1,
        timed_out: false,
      }));
      await runner.waitForCompletion(workspaceId, runner.submit(check(goal)).job_id);
      const before = await current(goal);
      const job = runner.submit({
        workspace_id: workspaceId,
        workspace_binding: BINDING,
        request_id: `repair-not-published-${exitCode}`,
        cwd: '.',
        timeout_ms: 5000,
        operation: { kind: 'install', ecosystem: 'rust', mode: 'locked', repair_cache: true },
      });
      await runner.waitForCompletion(workspaceId, job.job_id);
      expect((await current(goal)).criteria).toEqual(before.criteria);
    },
  );

  it('does not invalidate another canonical project root', async () => {
    const goal = await create();
    const runner = execution();
    await runner.waitForCompletion(workspaceId, runner.submit(check(goal)).job_id);
    const before = await current(goal);
    const otherRoot = join(temporary, 'other-project');
    await mkdir(otherRoot);
    const other = await workspaces.register({ root_path: otherRoot });
    service.onRuntimeChanged(other.workspace_id);
    expect((await current(goal)).criteria).toEqual(before.criteria);
  });

  it('keeps a concurrent browser assertion stale if it started before cache publication', async () => {
    const expectation = { kind: 'visible' as const, selector: '#result' };
    const goal = await create([
      {
        kind: 'browser',
        criterion_id: 'browser',
        description: 'Result is visible',
        expectation,
      },
    ]);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = execution(async (_service, input) => {
      if (input.operation.kind === 'browser') {
        markStarted();
        await held;
        return { exit_code: 0, duration_ms: 1, timed_out: false };
      }
      return { exit_code: 0, duration_ms: 1, timed_out: false, cargo_cache_repaired: true };
    });
    const browser = runner.submit({
      workspace_id: workspaceId,
      workspace_binding: BINDING,
      request_id: 'browser-before-cache-repair',
      goal_id: goal.goal_id,
      criterion_id: 'browser',
      cwd: '.',
      timeout_ms: 5000,
      operation: { kind: 'browser', action: { kind: 'assert', expectation } },
    });
    try {
      await started;
      const repair = runner.submit({
        workspace_id: workspaceId,
        workspace_binding: BINDING,
        request_id: 'repair-during-browser',
        cwd: '.',
        timeout_ms: 5000,
        operation: { kind: 'install', ecosystem: 'rust', mode: 'locked', repair_cache: true },
      });
      expect((await runner.waitForCompletion(workspaceId, repair.job_id)).state).toBe('succeeded');
    } finally {
      release();
    }
    expect((await runner.waitForCompletion(workspaceId, browser.job_id)).state).toBe('succeeded');
    expect((await current(goal)).criteria[0]?.status).toBe('stale');
  });

  it('requires daemon-owned file and exact check evidence before completing', async () => {
    let goal = await create();
    await expect(
      service.update({
        action: 'complete',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
      }),
    ).rejects.toThrow('evidence');
    goal = (
      await service.update({
        action: 'verify_file',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
        criterion_id: 'source',
      })
    ).goal;
    const runner = execution();
    const job = runner.submit(check(goal));
    expect((await runner.waitForCompletion(workspaceId, job.job_id)).state).toBe('succeeded');
    goal = await current(goal);
    expect(goal.evidence_valid).toBe(true);
    expect(goal.receipts[0]).toMatchObject({
      state: 'succeeded',
      exit_code: 0,
      criterion_id: 'test',
      build_id: BUILD,
    });
    goal = (
      await service.update({
        action: 'complete',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
      })
    ).goal;
    expect(goal.state).toBe('completed');
    const document = await readFile(join(temporary, 'state.sqlite'));
    expect(document.toString()).not.toContain(BINDING);
  });

  it('marks previous evidence stale after a source edit and blocks completion', async () => {
    let goal = await create();
    goal = (
      await service.update({
        action: 'verify_file',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
        criterion_id: 'source',
      })
    ).goal;
    const runner = execution();
    await runner.waitForCompletion(workspaceId, runner.submit(check(goal)).job_id);
    await writeFile(join(root, 'source.ts'), 'export const result = 2;\n');
    goal = await current(goal);
    expect(goal.criteria.map((criterion) => criterion.status)).toEqual(['stale', 'stale']);
    await expect(
      service.update({
        action: 'complete',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
      }),
    ).rejects.toThrow('stale');
  });

  it('does not certify checks whose tracked source changes while the check runs', async () => {
    const goal = await create();
    const runner = execution(async () => {
      await writeFile(join(root, 'source.ts'), 'changed while tests were running\n');
      return { exit_code: 0, duration_ms: 2, timed_out: false };
    });
    await runner.waitForCompletion(workspaceId, runner.submit(check(goal)).job_id);
    const result = await current(goal);
    expect(result.criteria.find((criterion) => criterion.criterion_id === 'test')?.status).toBe(
      'stale',
    );
    expect(result.receipts[0]?.state).toBe('succeeded');
    expect(result.evidence_valid).toBe(false);
  });

  it('rejects mismatched criteria and cross-workspace calls without consuming budget', async () => {
    const goal = await create();
    const runner = execution();
    expect(() =>
      runner.submit({ ...check(goal), operation: { kind: 'node_script', script: 'build' } }),
    ).toThrow('match');
    expect(() =>
      runner.submit({
        ...check(goal),
        operation: { kind: 'shell', command: 'echo ok', network: 'local' },
      }),
    ).toThrow('match');
    const other = join(temporary, 'other');
    await mkdir(other);
    const otherId = (await workspaces.register({ root_path: other })).workspace_id;
    await expect(service.read({ workspace_id: otherId, goal_id: goal.goal_id })).rejects.toThrow(
      'selected workspace',
    );
    expect((await current(goal)).executions_used).toBe(0);
  });

  it('pauses admission and retains running-job receipts while keeping reads responsive', async () => {
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let goal = await create();
    const runner = execution(async () => {
      started();
      await barrier;
      return { exit_code: 0, duration_ms: 1, timed_out: false };
    });
    const job = runner.submit(check(goal));
    await ready;
    goal = await current(goal);
    goal = (
      await service.update({
        action: 'pause',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
      })
    ).goal;
    expect(() => runner.submit(check(goal))).toThrow('not active');
    expect(goal.receipts[0]?.state).toBe('running');
    release();
    await runner.waitForCompletion(workspaceId, job.job_id);
    expect((await current(goal)).state).toBe('paused');
    expect((await current(goal)).receipts[0]?.state).toBe('succeeded');
  });

  it('recovers restart state without replaying an accepted request', async () => {
    let goal = await create();
    const runner = execution();
    const request = check(goal, 'persistent-request-0001');
    await runner.waitForCompletion(workspaceId, runner.submit(request).job_id);
    await runner.shutdown();
    repository.close();
    repository = new SqliteGoalRepository(join(temporary, 'state.sqlite'));
    service = new GoalService(repository, workspaces, { buildId: BUILD, runId: randomUUID() });
    service.recoverInterrupted();
    goal = await current(goal);
    expect(goal.state).toBe('interrupted');
    expect(goal.criteria.find((criterion) => criterion.criterion_id === 'test')?.status).toBe(
      'stale',
    );
    goal = (
      await service.update({
        action: 'resume',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
        deadline_ms: 10000,
      })
    ).goal;
    const restarted = execution();
    expect(() => restarted.submit(request)).toThrow('already recorded');
    expect(restarted.list()).toHaveLength(0);
    expect((await current(goal)).executions_used).toBe(1);
  });

  it('pins a Goal to the original root even when the workspace ID survives root replacement', async () => {
    let goal = await create();
    goal = (
      await service.update({
        action: 'pause',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
      })
    ).goal;
    const newRoot = join(temporary, 'replacement');
    await mkdir(newRoot);
    await writeFile(join(newRoot, 'source.ts'), 'new project\n');
    await workspaces.updateRootPath(workspaceId, newRoot);
    goal = await current(goal);
    expect(goal.root_matches).toBe(false);
    await expect(
      service.update({
        action: 'resume',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
      }),
    ).rejects.toThrow('root changed');
  });

  it('rejects secret, symlink and hard-linked tracked files but permits future missing paths', async () => {
    await expect(create(undefined, { tracked_paths: ['.env'] })).rejects.toThrow('secret');
    await symlink(join(root, 'source.ts'), join(root, 'alias.ts'));
    await expect(create(undefined, { tracked_paths: ['alias.ts'] })).rejects.toThrow('symbolic');
    await link(join(root, 'source.ts'), join(root, 'hard.ts'));
    await expect(create(undefined, { tracked_paths: ['hard.ts'] })).rejects.toThrow(
      'regular files',
    );
    await rm(join(root, 'hard.ts'));
    const goal = await create(
      [
        {
          kind: 'file',
          criterion_id: 'future',
          description: 'New file created',
          path: 'new/deep/file.ts',
        },
      ],
      { tracked_paths: ['new/deep/file.ts'] },
    );
    expect(goal.checkpoint?.files).toEqual([{ path: 'new/deep/file.ts', sha256: null }]);
    await expect(
      service.update({
        action: 'verify_file',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
        criterion_id: 'future',
      }),
    ).rejects.toThrow('does not exist');
  });

  it('enforces execution budgets and explicit revision/budget renewal', async () => {
    let goal = await create(undefined, { max_executions: 1 });
    const runner = execution();
    await runner.waitForCompletion(workspaceId, runner.submit(check(goal)).job_id);
    expect(() => runner.submit(check(goal))).toThrow('budget');
    await expect(
      service.update({
        action: 'pause',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: 1,
      }),
    ).rejects.toThrow('revision changed');
    goal = await current(goal);
    goal = (
      await service.update({
        action: 'pause',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
      })
    ).goal;
    await expect(
      service.update({
        action: 'resume',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
      }),
    ).rejects.toThrow('budget');
    goal = (
      await service.update({
        action: 'resume',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
        max_executions: 2,
      })
    ).goal;
    await runner.waitForCompletion(workspaceId, runner.submit(check(goal)).job_id);
    expect((await current(goal)).executions_used).toBe(2);
  });

  it('accepts an explicitly foreground declared script and rejects background criteria', async () => {
    const goal = await create();
    const runner = execution();
    expect(() =>
      runner.submit({
        ...check(goal),
        operation: { kind: 'node_script', script: 'test', background: true },
      }),
    ).toThrow('foreground');
    const job = runner.submit({
      ...check(goal),
      operation: { kind: 'node_script', script: 'test', background: false },
    });
    await runner.waitForCompletion(workspaceId, job.job_id);
    expect(
      (await current(goal)).criteria.find((criterion) => criterion.criterion_id === 'test')?.status,
    ).toBe('passed');
    expect((await current(goal)).executions_used).toBe(1);
  });

  it('allows pause/cancel in read-only mode but rejects evidence/creation updates', async () => {
    let goal = await create();
    readOnly = true;
    await expect(create()).rejects.toThrow('Read-only');
    await expect(
      service.update({
        action: 'verify_file',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
        criterion_id: 'source',
      }),
    ).rejects.toThrow('Read-only');
    goal = (
      await service.update({
        action: 'pause',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
      })
    ).goal;
    goal = (
      await service.update({
        action: 'cancel',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
      })
    ).goal;
    expect(goal.state).toBe('cancelled');
  });

  it('continues beyond 128 executions while retaining acceptance evidence and durable replay protection', async () => {
    let goal = await create();
    expect(goal.max_executions).toBe(0);
    goal = (
      await service.update({
        action: 'verify_file',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
        criterion_id: 'source',
      })
    ).goal;
    const runner = execution();
    const checkedJob = runner.submit(check(goal));
    await runner.waitForCompletion(workspaceId, checkedJob.job_id);
    let oldRequest: ProjectExecInput | undefined;
    for (let index = 0; index < 140; index += 1) {
      const { criterion_id: _criterionId, ...request } = check(goal, `supporting-${index}`);
      void _criterionId;
      if (index === 0) oldRequest = request;
      await runner.waitForCompletion(workspaceId, runner.submit(request).job_id);
    }
    goal = await current(goal);
    expect(goal.executions_used).toBe(141);
    expect(goal.receipts.length).toBeLessThanOrEqual(33);
    expect(goal.receipts.some((receipt) => receipt.job_id === checkedJob.job_id)).toBe(true);
    expect(goal.evidence_valid).toBe(true);
    await runner.shutdown();
    repository.close();
    repository = new SqliteGoalRepository(join(temporary, 'state.sqlite'));
    service = new GoalService(repository, workspaces, { buildId: BUILD, runId: randomUUID() });
    service.recoverInterrupted();
    goal = await current(goal);
    goal = (
      await service.update({
        action: 'resume',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
      })
    ).goal;
    const restarted = execution();
    expect(() => restarted.submit(oldRequest!)).toThrow('already recorded');
    expect((await current(goal)).executions_used).toBe(141);
  }, 20_000);

  it('explicitly removes an exhausted legacy count budget without resetting cumulative usage', async () => {
    let goal = await create(undefined, { max_executions: 1 });
    const runner = execution();
    await runner.waitForCompletion(workspaceId, runner.submit(check(goal)).job_id);
    goal = await current(goal);
    goal = (
      await service.update({
        action: 'pause',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
      })
    ).goal;
    goal = (
      await service.update({
        action: 'resume',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
        max_executions: 0,
      })
    ).goal;
    await runner.waitForCompletion(workspaceId, runner.submit(check(goal)).job_id);
    expect(await current(goal)).toMatchObject({ max_executions: 0, executions_used: 2 });
  });

  it('pages beyond 32 saved Goals and deletes only terminal records with current revisions', async () => {
    const saved: GoalRecord[] = [];
    for (let index = 0; index < 35; index += 1) saved.push(await create());
    const first = await service.read({ workspace_id: workspaceId });
    expect(first.goals).toHaveLength(32);
    expect(first).toMatchObject({ total: 35, has_more: true, next_offset: 32 });
    const last = await service.read({ workspace_id: workspaceId, offset: first.next_offset! });
    expect(last.goals.map((goal) => goal.goal_id)).toEqual(
      saved.slice(32).map((goal) => goal.goal_id),
    );
    expect(last).toMatchObject({ total: 35, has_more: false, next_offset: null });
    let goal = saved[0]!;
    await expect(
      service.update({
        action: 'delete',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
      }),
    ).rejects.toThrow('completed or cancelled');
    goal = (
      await service.update({
        action: 'cancel',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
      })
    ).goal;
    await expect(
      service.update({
        action: 'delete',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision - 1,
      }),
    ).rejects.toThrow('revision changed');
    readOnly = true;
    await expect(
      service.update({
        action: 'delete',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
      }),
    ).rejects.toThrow('Read-only');
    readOnly = false;
    const deleted = await service.update({
      action: 'delete',
      workspace_id: workspaceId,
      goal_id: goal.goal_id,
      expected_revision: goal.revision,
    });
    expect(deleted).toMatchObject({
      deleted: true,
      goal: { goal_id: goal.goal_id, state: 'cancelled' },
    });
    expect(repository.count(workspaceId)).toBe(34);
    await expect(
      service.read({ workspace_id: workspaceId, goal_id: goal.goal_id }),
    ).rejects.toThrow('does not exist');
    expect(repository.find(saved[1]!.goal_id)?.state).toBe('active');
  });

  it('bounds large Goal pages by bytes and exposes a continuation offset without losing records', async () => {
    for (let index = 0; index < 12; index += 1) {
      await create(
        Array.from({ length: 16 }, (_, criterion) => ({
          kind: 'browser',
          criterion_id: `page_${criterion}`,
          description: 'Verify page.',
          expectation: { kind: 'text', selector: 'main', text: '한'.repeat(4000) },
        })),
      );
    }
    const first = await service.read({ workspace_id: workspaceId, limit: 32 });
    expect(first.goals.length).toBeLessThan(12);
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThan(2 * 1024 * 1024);
    expect(first).toMatchObject({ total: 12, has_more: true, next_offset: first.goals.length });
    const second = await service.read({ workspace_id: workspaceId, offset: first.next_offset! });
    expect(second.has_more).toBe(false);
    expect(new Set([...first.goals, ...second.goals].map((goal) => goal.goal_id)).size).toBe(12);
  });

  it('does not let an older concurrent assertion overwrite a newer failure after history compaction', async () => {
    const expectation = { kind: 'visible' as const, selector: 'main' };
    const goal = await create([
      { kind: 'browser', criterion_id: 'ui', description: 'Page is visible.', expectation },
    ]);
    let releaseOlder!: () => void;
    let signalOlder!: () => void;
    const started = new Promise<void>((resolve) => {
      signalOlder = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    const runner = execution(async (_workspace, input) => {
      if (input.request_id === 'older-assertion') {
        signalOlder();
        await held;
      }
      return {
        exit_code: input.request_id === 'newer-assertion' ? 1 : 0,
        duration_ms: 1,
        timed_out: false,
      };
    });
    const assertion = (request_id: string): ProjectExecInput => ({
      ...check(goal, request_id),
      criterion_id: 'ui',
      operation: { kind: 'browser', action: { kind: 'assert', expectation } },
    });
    const older = runner.submit(assertion('older-assertion'));
    await started;
    try {
      const newer = runner.submit(assertion('newer-assertion'));
      await runner.waitForCompletion(workspaceId, newer.job_id);
      for (let index = 0; index < 40; index += 1) {
        const { criterion_id: _criterionId, ...request } = check(
          goal,
          `concurrent-support-${index}`,
        );
        void _criterionId;
        const submitted = runner.submit({
          ...request,
          operation: { kind: 'node_script', script: 'dev', background: true },
        });
        await runner.waitForCompletion(workspaceId, submitted.job_id);
      }
      const compacted = await current(goal);
      expect(compacted.receipts.find((receipt) => receipt.job_id === older.job_id)?.state).toBe(
        'running',
      );
      expect(compacted.receipts.find((receipt) => receipt.job_id === newer.job_id)?.state).toBe(
        'failed',
      );
      expect(compacted.receipts.length).toBeLessThanOrEqual(34);
    } finally {
      releaseOlder();
    }
    expect((await runner.waitForCompletion(workspaceId, older.job_id)).state).toBe('succeeded');
    const finished = await current(goal);
    expect(finished.criteria[0]?.status).toBe('failed');
    expect(finished.evidence_valid).toBe(false);
    await expect(
      service.update({
        action: 'complete',
        workspace_id: workspaceId,
        goal_id: goal.goal_id,
        expected_revision: finished.revision,
      }),
    ).rejects.toThrow('evidence');
  }, 15_000);
});
