import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SqliteGoalRepository,
  SqliteWorkspaceRepository,
  WorkspaceService,
  type GoalRepository,
} from '@chatsplice/core';
import { expect, it } from 'vitest';
import type { ProjectExecInput } from '@chatsplice/protocol';

import { ProjectExecutionService } from '../execution/service.js';
import { GoalService } from './service.js';

it('allows reading the current Goal revision and cancelling a running foreground execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chatsplice-goal-control-'));
  const root = join(directory, 'project');
  await mkdir(root);
  await writeFile(join(root, 'index.ts'), 'export const current = 1;');
  const workspaceRepository = new SqliteWorkspaceRepository(join(directory, 'state.sqlite'));
  const goalRepository = new SqliteGoalRepository(join(directory, 'state.sqlite'));
  const workspaceService = new WorkspaceService(workspaceRepository);
  const workspaceId = (await workspaceService.register({ root_path: root })).workspace_id;
  const goals = new GoalService(goalRepository, workspaceService, {
    buildId: '0'.repeat(64),
    runId: '00000000-0000-4000-8000-000000000001',
  });
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const execution = new ProjectExecutionService(workspaceService, {
    goalLifecycle: goals,
    backend: async (_workspace, _input, options) => {
      signalStarted();
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { exit_code: 0, duration_ms: 1, timed_out: false };
    },
  });
  goals.setExecutionService(execution);
  try {
    const { goal } = await goals.update({
      workspace_id: workspaceId,
      action: 'create',
      objective: 'Long check',
      scope: '',
      tracked_paths: ['index.ts'],
      criteria: [
        {
          criterion_id: 'check',
          description: 'Run check',
          required: true,
          kind: 'check',
          cwd: '.',
          operation: { kind: 'node_script', script: 'check' },
        },
      ],
      next_step: '',
      max_executions: 64,
      deadline_ms: 60_000,
    });
    execution.submit({
      workspace_id: workspaceId,
      workspace_binding: `wb_${'0'.repeat(64)}`,
      request_id: 'long-goal-check-001',
      goal_id: goal.goal_id,
      criterion_id: 'check',
      cwd: '.',
      operation: { kind: 'node_script', script: 'check' },
      timeout_ms: 60_000,
    });
    await started;
    const current = await Promise.race([
      goals.read({ workspace_id: workspaceId, goal_id: goal.goal_id }),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 250)),
    ]);
    expect(current, 'Goal read must not wait behind the running foreground job').toBeDefined();
    const currentGoal = current!.goals[0]!;
    expect(currentGoal.revision).toBeGreaterThan(goal.revision);
    const cancelled = await goals.update({
      workspace_id: workspaceId,
      action: 'cancel',
      goal_id: goal.goal_id,
      expected_revision: currentGoal.revision,
    });
    expect(cancelled.goal.state).toBe('cancelled');
    expect(cancelled.goal.receipts[0]?.state).toBe('cancelled');
  } finally {
    await execution.shutdown();
    goalRepository.close();
    workspaceRepository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('retains every owned execution and completion space as multilingual checkpoint metadata grows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chatsplice-goal-capacity-'));
  const root = join(directory, 'project');
  await mkdir(root);
  await writeFile(join(root, 'index.ts'), 'export const current = 1;');
  const workspaceRepository = new SqliteWorkspaceRepository(join(directory, 'state.sqlite'));
  const repository = new SqliteGoalRepository(join(directory, 'state.sqlite'));
  const workspaceService = new WorkspaceService(workspaceRepository);
  const workspaceId = (await workspaceService.register({ root_path: root })).workspace_id;
  const goals = new GoalService(repository, workspaceService, {
    buildId: '0'.repeat(64),
    runId: '00000000-0000-4000-8000-000000000001',
  });
  try {
    const { goal } = await goals.update({
      workspace_id: workspaceId,
      action: 'create',
      objective: '가'.repeat(2000),
      scope: '가'.repeat(2000),
      tracked_paths: ['index.ts'],
      criteria: Array.from({ length: 16 }, (_, index) => ({
        criterion_id: `file-${index}`,
        description: '가'.repeat(500),
        required: true,
        kind: 'file' as const,
        path: 'index.ts',
      })),
      next_step: '',
      max_executions: 128,
      deadline_ms: 60_000,
    });
    let accepted = 0;
    for (let index = 0; index < 64; index += 1) {
      const now = new Date().toISOString();
      const input: ProjectExecInput = {
        workspace_id: workspaceId,
        workspace_binding: `wb_${'0'.repeat(64)}`,
        request_id: `capacity-request-${index}`,
        goal_id: goal.goal_id,
        cwd: '.',
        operation: { kind: 'node_script', script: 'dev', background: true },
        timeout_ms: 60_000,
      };
      try {
        goals.onSubmit(
          {
            job_id: `exec_00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
            workspace_id: workspaceId,
            workspace_name: 'Project',
            goal_id: goal.goal_id,
            operation: input.operation,
            cwd: '.',
            state: 'queued',
            command: 'npm run dev',
            created_at: now,
            started_at: null,
            finished_at: null,
            exit_code: null,
            error_code: null,
            message: 'Queued',
            used_network: false,
            truncated: false,
            duration_ms: 0,
          },
          input,
        );
        accepted += 1;
      } catch (error) {
        expect(String(error)).toContain('reserve');
        break;
      }
    }
    expect(accepted).toBeGreaterThan(1);
    expect(accepted).toBe(64);
    const current = repository.find(goal.goal_id)!;
    const summary = '가'.repeat(1000);
    const nextStep = '가'.repeat(1000);
    const checkpointed = await goals.update({
      workspace_id: workspaceId,
      action: 'checkpoint',
      goal_id: goal.goal_id,
      expected_revision: current.revision,
      summary,
      next_step: nextStep,
    });
    expect(checkpointed.goal.checkpoint?.summary).toBe(summary);
    expect(checkpointed.goal.receipts).toHaveLength(64);
    expect(checkpointed.goal.executions_used).toBe(64);
    expect(() => goals.recoverInterrupted()).not.toThrow();
    expect(repository.find(goal.goal_id)?.state).toBe('interrupted');
    expect(
      repository.find(goal.goal_id)?.receipts.every((receipt) => receipt.state === 'interrupted'),
    ).toBe(true);
  } finally {
    repository.close();
    workspaceRepository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('reconciles a cleaned-up execution after one durable receipt write fails without awarding evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chatsplice-goal-receipt-failure-'));
  const root = join(directory, 'project');
  await mkdir(root);
  await writeFile(join(root, 'index.ts'), 'export const current = 1;');
  const workspaceRepository = new SqliteWorkspaceRepository(join(directory, 'state.sqlite'));
  const repository = new SqliteGoalRepository(join(directory, 'state.sqlite'));
  const workspaceService = new WorkspaceService(workspaceRepository);
  const workspaceId = (await workspaceService.register({ root_path: root })).workspace_id;
  let failedWrites = 0;
  const failingRepository: GoalRepository = {
    insert: (record) => repository.insert(record),
    find: (goalId) => repository.find(goalId),
    list: (id, options) => repository.list(id, options),
    listAll: (options) => repository.listAll(options),
    count: (id) => repository.count(id),
    hasExecutionRequest: (goalId, requestHash) =>
      repository.hasExecutionRequest(goalId, requestHash),
    deleteTerminal: (id, goalId, revision) => repository.deleteTerminal(id, goalId, revision),
    close: () => repository.close(),
    replace: (record, expectedRevision) => {
      if (failedWrites === 0 && record.receipts.some((receipt) => receipt.state === 'succeeded')) {
        failedWrites += 1;
        throw new Error('Injected SQLite write failure.');
      }
      return repository.replace(record, expectedRevision);
    },
  };
  const goals = new GoalService(failingRepository, workspaceService, {
    buildId: '0'.repeat(64),
    runId: '00000000-0000-4000-8000-000000000001',
  });
  const execution = new ProjectExecutionService(workspaceService, {
    goalLifecycle: goals,
    backend: async () => ({ exit_code: 0, duration_ms: 1, timed_out: false }),
  });
  goals.setExecutionService(execution);
  try {
    const { goal } = await goals.update({
      workspace_id: workspaceId,
      action: 'create',
      objective: 'Check with durable receipt',
      scope: '',
      tracked_paths: ['index.ts'],
      criteria: [
        {
          criterion_id: 'check',
          description: 'Run check',
          required: true,
          kind: 'check',
          cwd: '.',
          operation: { kind: 'node_script', script: 'check' },
        },
      ],
      next_step: '',
      max_executions: 64,
      deadline_ms: 60_000,
    });
    const job = execution.submit({
      workspace_id: workspaceId,
      workspace_binding: `wb_${'0'.repeat(64)}`,
      request_id: 'receipt-failure-check-001',
      goal_id: goal.goal_id,
      criterion_id: 'check',
      cwd: '.',
      operation: { kind: 'node_script', script: 'check' },
      timeout_ms: 60_000,
    });
    const result = await execution.waitForCompletion(workspaceId, job.job_id, 1000);
    expect(result.state).toBe('failed');
    expect(result.message).toContain('receipt could not be saved');
    expect(failedWrites).toBe(1);
    const currentGoal = (await goals.read({ workspace_id: workspaceId, goal_id: goal.goal_id }))
      .goals[0]!;
    expect(currentGoal.receipts[0]?.state).toBe('running');
    expect(currentGoal.evidence_valid).toBe(false);
    const cancelled = await goals.update({
      workspace_id: workspaceId,
      action: 'cancel',
      goal_id: goal.goal_id,
      expected_revision: currentGoal.revision,
    });
    expect(cancelled.goal.state).toBe('cancelled');
    expect(cancelled.goal.receipts[0]?.state).toBe('failed');
    expect(cancelled.goal.criteria[0]?.status).not.toBe('passed');
    expect(cancelled.goal.evidence_valid).toBe(false);
    expect(workspaceService.isBusy(root)).toBe(false);
  } finally {
    await execution.shutdown();
    repository.close();
    workspaceRepository.close();
    await rm(directory, { recursive: true, force: true });
  }
});
