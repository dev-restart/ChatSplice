import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ChatSpliceError,
  SqliteGoalRepository,
  SqliteWorkspaceRepository,
  WorkspaceService,
} from '@chatsplice/core';
import { GoalOwnerUpdateInputSchema } from '@chatsplice/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ProjectExecutionService } from '../execution/service.js';
import { GoalService } from './service.js';

let directory: string;
let root: string;
let workspaceId: string;
let workspaceRepository: SqliteWorkspaceRepository;
let repository: SqliteGoalRepository;
let workspaces: WorkspaceService;
let goals: GoalService;
let readOnly: boolean;
let execution: ProjectExecutionService | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'chatsplice-goal-audit-'));
  root = join(directory, 'project');
  await mkdir(root);
  await writeFile(join(root, 'source.ts'), 'export const value = 1;\n');
  workspaceRepository = new SqliteWorkspaceRepository(join(directory, 'state.sqlite'));
  repository = new SqliteGoalRepository(join(directory, 'state.sqlite'));
  workspaces = new WorkspaceService(workspaceRepository);
  workspaceId = (await workspaces.register({ root_path: root })).workspace_id;
  readOnly = false;
  execution = undefined;
  goals = new GoalService(repository, workspaces, {
    buildId: 'a'.repeat(64),
    runId: randomUUID(),
    isReadOnly: () => readOnly,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await execution?.shutdown();
  repository.close();
  workspaceRepository.close();
  await rm(directory, { recursive: true, force: true });
});

function createInput() {
  return GoalOwnerUpdateInputSchema.parse({
    workspace_id: workspaceId,
    action: 'create',
    objective: 'Audit lifecycle boundaries',
    tracked_paths: ['source.ts'],
    criteria: [
      { kind: 'file', criterion_id: 'source', description: 'Source exists', path: 'source.ts' },
    ],
  });
}

it('retains Goal metadata access after the registered directory is moved outside its saved path', async () => {
  const { goal } = await goals.update(createInput());
  await rename(root, join(directory, 'moved-project'));
  const result = await goals.read({ workspace_id: workspaceId, goal_id: goal.goal_id });
  expect(result.goals[0]).toMatchObject({
    goal_id: goal.goal_id,
    revision: goal.revision,
    root_matches: false,
    evidence_valid: false,
  });
});

it('does not hide repository failures behind the unavailable-root metadata fallback', async () => {
  await goals.update(createInput());
  const error = new ChatSpliceError('PATH_OUTSIDE_WORKSPACE', 'Injected repository failure.');
  vi.spyOn(repository, 'list').mockImplementation(() => {
    throw error;
  });
  await expect(goals.read({ workspace_id: workspaceId })).rejects.toBe(error);
  await rename(root, join(directory, 'moved-project'));
  await expect(goals.read({ workspace_id: workspaceId })).rejects.toBe(error);
});

it('rechecks read-only policy when a queued Goal mutation receives its root reservation', async () => {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = workspaces.withOperation(workspaceId, async () => {
    started();
    await barrier;
  });
  await ready;
  const queued = goals.update(createInput());
  readOnly = true;
  release();
  await blocker;
  await expect(queued).rejects.toThrow('Read-only');
  expect(repository.list(workspaceId)).toEqual([]);
});

it('finishes Goal cancellation after owned cleanup outlasts the HTTP polling interval', async () => {
  let ready!: () => void;
  let finishCleanup!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const cleanup = new Promise<void>((resolve) => {
    finishCleanup = resolve;
  });
  execution = new ProjectExecutionService(workspaces, {
    goalLifecycle: goals,
    backend: async (_workspace, _input, options) => {
      ready();
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      await cleanup;
      return { exit_code: 0, duration_ms: 1, timed_out: false };
    },
  });
  goals.setExecutionService(execution);
  const { goal } = await goals.update(createInput());
  const job = execution.submit({
    workspace_id: workspaceId,
    workspace_binding: `wb_${'0'.repeat(64)}`,
    goal_id: goal.goal_id,
    request_id: 'late-owned-cleanup-001',
    cwd: '.',
    timeout_ms: 60_000,
    operation: { kind: 'node_script', script: 'test' },
  });
  await started;
  const current = (await goals.read({ workspace_id: workspaceId, goal_id: goal.goal_id }))
    .goals[0]!;
  let clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const cancellation = goals.update({
    workspace_id: workspaceId,
    goal_id: goal.goal_id,
    expected_revision: current.revision,
    action: 'cancel',
  });
  clock += 26_000;
  try {
    expect((await cancellation).goal.state).toBe('cancelling');
  } finally {
    finishCleanup();
    vi.restoreAllMocks();
  }
  expect((await execution.waitForCompletion(workspaceId, job.job_id, 5000)).state).toBe(
    'cancelled',
  );
  const completed = (await goals.read({ workspace_id: workspaceId, goal_id: goal.goal_id }))
    .goals[0]!;
  expect(completed.receipts[0]?.state).toBe('cancelled');
  expect(completed.state).toBe('cancelled');
});
