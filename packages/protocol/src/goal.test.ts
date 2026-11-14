import { describe, expect, it } from 'vitest';

import { ProjectExecInputSchema, ProjectExecSubmitInputSchema } from './execution.js';
import {
  GoalOwnerReadInputSchema,
  GoalOwnerUpdateInputSchema,
  GoalReadInputSchema,
  GoalRecordSchema,
  GoalUpdateInputSchema,
} from './goal.js';

const workspaceId = `ws_${'a'.repeat(24)}`;
const binding = `wb_${'b'.repeat(64)}`;
const goalId = 'goal_11111111-1111-4111-8111-111111111111';
const create = {
  action: 'create',
  workspace_id: workspaceId,
  objective: 'Finish and verify the project change.',
  tracked_paths: ['src', 'package.json'],
  criteria: [
    {
      kind: 'file',
      criterion_id: 'source',
      description: 'Read the current source.',
      path: 'src/main.ts',
    },
  ],
};

describe('Goal protocol boundary', () => {
  it('defaults unlimited execution counts and required criteria without exposing a binding to owners', () => {
    const parsed = GoalOwnerUpdateInputSchema.parse(create);
    expect(parsed).toMatchObject({
      scope: '',
      next_step: '',
      max_executions: 0,
      deadline_ms: 3_600_000,
      criteria: [{ required: true }],
    });
    expect(GoalUpdateInputSchema.safeParse(create).success).toBe(false);
    expect(GoalUpdateInputSchema.parse({ ...create, workspace_binding: binding })).toMatchObject({
      workspace_binding: binding,
    });
    expect(
      GoalOwnerUpdateInputSchema.safeParse({ ...create, workspace_binding: binding }).success,
    ).toBe(false);
    expect(GoalOwnerReadInputSchema.parse({ workspace_id: workspaceId })).toEqual({
      workspace_id: workspaceId,
    });
    expect(GoalReadInputSchema.safeParse({ workspace_id: workspaceId }).success).toBe(false);
  });

  it('accepts unlimited and post-128 budgets in the public create and resume contract', () => {
    for (const action of ['create', 'resume'] as const) {
      const fields =
        action === 'create'
          ? { ...create, workspace_binding: binding }
          : {
              workspace_id: workspaceId,
              workspace_binding: binding,
              goal_id: goalId,
              expected_revision: 3,
              action,
            };
      for (const max_executions of [0, 129, 244, 10_000]) {
        expect(
          GoalUpdateInputSchema.safeParse({ ...fields, max_executions }).success,
          `${action} should accept ${max_executions}`,
        ).toBe(true);
      }
      for (const max_executions of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(
          GoalUpdateInputSchema.safeParse({ ...fields, max_executions }).success,
          `${action} should reject ${max_executions}`,
        ).toBe(false);
      }
    }
  });

  it('rejects traversal, absolute, control and oversized tracked paths', () => {
    for (const path of [
      '/tmp',
      '../other',
      'src/../other',
      'src//main.ts',
      'src/./main.ts',
      'C:repo',
      'src\\main.ts',
      'src\u0000main',
      'src\nmain',
      'a'.repeat(513),
    ]) {
      expect(
        GoalOwnerUpdateInputSchema.safeParse({ ...create, tracked_paths: [path] }).success,
        path,
      ).toBe(false);
    }
    expect(GoalOwnerUpdateInputSchema.safeParse({ ...create, tracked_paths: ['.'] }).success).toBe(
      true,
    );
    expect(GoalOwnerUpdateInputSchema.safeParse({ ...create, tracked_paths: [] }).success).toBe(
      false,
    );
    expect(
      GoalOwnerUpdateInputSchema.safeParse({ ...create, tracked_paths: Array(33).fill('src') })
        .success,
    ).toBe(false);
  });

  it('requires unique criterion IDs and at least one required criterion', () => {
    expect(
      GoalOwnerUpdateInputSchema.safeParse({
        ...create,
        criteria: [...create.criteria, ...create.criteria],
      }).success,
    ).toBe(false);
    expect(
      GoalOwnerUpdateInputSchema.safeParse({
        ...create,
        criteria: [{ ...create.criteria[0], required: false }],
      }).success,
    ).toBe(false);
    expect(GoalOwnerUpdateInputSchema.safeParse({ ...create, criteria: [] }).success).toBe(false);
    expect(
      GoalOwnerUpdateInputSchema.safeParse({
        ...create,
        criteria: [{ ...create.criteria[0], criterion_id: 'invalid id' }],
      }).success,
    ).toBe(false);
  });

  it('admits structured checks and local browser assertions while rejecting shell commands and background checks', () => {
    for (const operation of [
      { kind: 'node_script', script: 'test:unit' },
      { kind: 'cargo', task: 'test' },
    ]) {
      expect(
        GoalOwnerUpdateInputSchema.safeParse({
          ...create,
          criteria: [
            { kind: 'check', criterion_id: 'tests', description: 'Tests pass.', operation },
          ],
        }).success,
      ).toBe(true);
    }
    for (const operation of [
      { kind: 'shell', command: 'echo pass' },
      { kind: 'node_script', script: 'test', background: true },
      { kind: 'cargo', task: 'arbitrary' },
    ]) {
      expect(
        GoalOwnerUpdateInputSchema.safeParse({
          ...create,
          criteria: [
            { kind: 'check', criterion_id: 'tests', description: 'Tests pass.', operation },
          ],
        }).success,
      ).toBe(false);
    }
    expect(
      GoalOwnerUpdateInputSchema.safeParse({
        ...create,
        criteria: [
          {
            kind: 'browser',
            criterion_id: 'page',
            description: 'Local page visible.',
            expectation: { kind: 'visible', selector: 'main' },
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      GoalOwnerUpdateInputSchema.safeParse({
        ...create,
        criteria: [
          {
            kind: 'browser',
            criterion_id: 'page',
            description: 'Local page visible.',
            expectation: { kind: 'url', url: 'https://example.com/' },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('guards lifecycle mutations with positive revisions and bounded resume expansion', () => {
    const target = { workspace_id: workspaceId, goal_id: goalId, expected_revision: 2 };
    for (const action of ['pause', 'resume', 'cancel', 'complete', 'delete', 'reset']) {
      expect(GoalOwnerUpdateInputSchema.safeParse({ ...target, action }).success).toBe(true);
      expect(
        GoalOwnerUpdateInputSchema.safeParse({ ...target, action, expected_revision: 0 }).success,
      ).toBe(false);
    }
    for (const max_executions of [0, 129, 10_000]) {
      expect(
        GoalOwnerUpdateInputSchema.safeParse({ ...target, action: 'resume', max_executions })
          .success,
      ).toBe(true);
    }
    for (const max_executions of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        GoalOwnerUpdateInputSchema.safeParse({ ...target, action: 'resume', max_executions })
          .success,
      ).toBe(false);
    }
    expect(
      GoalOwnerUpdateInputSchema.safeParse({ ...target, action: 'resume', deadline_ms: 86_400_001 })
        .success,
    ).toBe(false);
    expect(
      GoalOwnerUpdateInputSchema.safeParse({ ...target, action: 'complete', state: 'completed' })
        .success,
    ).toBe(false);
  });

  it('requires an explicit revision-guarded reset without accepting replacement scope or budget', () => {
    const target = {
      action: 'reset',
      workspace_id: workspaceId,
      goal_id: goalId,
      expected_revision: 4,
    };
    expect(GoalOwnerUpdateInputSchema.parse(target)).toEqual(target);
    expect(GoalUpdateInputSchema.parse({ ...target, workspace_binding: binding })).toMatchObject(
      target,
    );
    for (const extra of [
      { expected_revision: undefined },
      { expected_revision: 0 },
      { objective: 'Replace the task' },
      { tracked_paths: ['elsewhere.ts'] },
      { criteria: [] },
      { max_executions: 0 },
      { deadline_ms: 3600000 },
      { state: 'active' },
    ]) {
      expect(GoalOwnerUpdateInputSchema.safeParse({ ...target, ...extra }).success).toBe(false);
      expect(
        GoalUpdateInputSchema.safeParse({
          ...target,
          ...extra,
          workspace_binding: binding,
        }).success,
      ).toBe(false);
    }
    expect(GoalUpdateInputSchema.safeParse(target).success).toBe(false);
  });

  it('bounds pages independently from the number of stored Goals', () => {
    expect(
      GoalOwnerReadInputSchema.parse({ workspace_id: workspaceId, offset: 64, limit: 32 }),
    ).toMatchObject({ offset: 64, limit: 32 });
    for (const invalid of [{ offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 33 }]) {
      expect(
        GoalOwnerReadInputSchema.safeParse({ workspace_id: workspaceId, ...invalid }).success,
      ).toBe(false);
    }
  });

  it('rejects raw output, commands, bindings and image payloads in durable Goal records', () => {
    const record = {
      goal_id: goalId,
      workspace_id: workspaceId,
      objective: create.objective,
      scope: '',
      tracked_paths: ['src'],
      criteria: [{ ...create.criteria[0], required: true, status: 'pending', evidence: null }],
      state: 'active',
      revision: 1,
      created_at: '2026-10-11T00:00:00.000Z',
      updated_at: '2026-10-11T00:00:00.000Z',
      deadline_at: '2026-10-11T01:00:00.000Z',
      max_executions: 64,
      executions_used: 0,
      checkpoint: null,
      receipts: [],
      message: '',
    };
    expect(GoalRecordSchema.parse(record)).toMatchObject({
      root_matches: true,
      evidence_valid: false,
    });
    for (const extra of [
      { output: 'raw log' },
      { command: 'shell command' },
      { workspace_binding: binding },
      { screenshot: 'base64' },
      { root_path: '/private/workspace' },
    ]) {
      expect(GoalRecordSchema.safeParse({ ...record, ...extra }).success).toBe(false);
    }
    expect(
      GoalRecordSchema.safeParse({
        ...record,
        checkpoint: {
          summary: '',
          next_step: '',
          files: [],
          saved_at: record.updated_at,
          content: 'raw source',
        },
      }).success,
    ).toBe(false);
  });

  it('links execution to an optional Goal and requires the Goal for criterion links', () => {
    const operation = { kind: 'node_script', script: 'test' };
    const execution = { workspace_id: workspaceId, request_id: 'request_001', operation };
    expect(
      ProjectExecSubmitInputSchema.parse({ ...execution, goal_id: goalId, criterion_id: 'tests' }),
    ).toMatchObject({ goal_id: goalId, criterion_id: 'tests' });
    expect(
      ProjectExecInputSchema.parse({ ...execution, workspace_binding: binding, goal_id: goalId }),
    ).toMatchObject({ goal_id: goalId });
    expect(
      ProjectExecSubmitInputSchema.safeParse({ ...execution, criterion_id: 'tests' }).success,
    ).toBe(false);
    expect(
      ProjectExecInputSchema.safeParse({
        ...execution,
        workspace_binding: binding,
        criterion_id: 'tests',
      }).success,
    ).toBe(false);
  });
});
