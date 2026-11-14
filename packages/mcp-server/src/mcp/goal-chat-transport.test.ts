import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ChatSpliceError,
  SqliteGoalRepository,
  SqliteWorkspaceRepository,
  WorkspaceService,
} from '@chatsplice/core';
import {
  EXECUTION_CONTRACT_VERSION,
  MCP_SERVER_VERSION,
  GoalReadResultSchema,
  GoalUpdateResultSchema,
  type GoalRecord,
} from '@chatsplice/protocol';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GoalService } from '../goal/service.js';
import type { McpToolContext } from './tool-context.js';
import { registerGoalTools } from './tools-goal.js';

// Exercise the actual MCP registration/serialization and persistent Goal service.
// The binding guard uses a fixed fixture identity; HTTP auth and model planning
// are separate contracts and are deliberately not simulated by this test.
describe('Goal chat workflow over the registered MCP tools', () => {
  const binding = `wb_${'b'.repeat(64)}`;
  const catalogFixture = {
    mcp_descriptor_version: MCP_SERVER_VERSION,
    tool_count: 2,
    tool_schema_digest: 'c'.repeat(64),
  };
  const readToolCatalogIdentity = vi.fn(async () => catalogFixture);
  let temporary: string;
  let root: string;
  let workspaceId: string;
  let workspaceRepository: SqliteWorkspaceRepository;
  let goalRepository: SqliteGoalRepository;
  let server: McpServer;
  let client: Client;

  beforeEach(async () => {
    readToolCatalogIdentity.mockReset().mockResolvedValue(catalogFixture);
    temporary = await mkdtemp(join(tmpdir(), 'chatsplice-goal-mcp-'));
    root = join(temporary, 'project');
    await mkdir(root);
    await writeFile(join(root, 'source.ts'), 'export const result = 1;\n');
    workspaceRepository = new SqliteWorkspaceRepository(join(temporary, 'state.sqlite'));
    goalRepository = new SqliteGoalRepository(join(temporary, 'state.sqlite'));
    const workspaces = new WorkspaceService(workspaceRepository);
    workspaceId = (await workspaces.register({ root_path: root })).workspace_id;
    const goalService = new GoalService(goalRepository, workspaces, {
      buildId: 'a'.repeat(64),
      runId: randomUUID(),
    });
    server = new McpServer(
      { name: 'goal-workflow-fixture', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    const context = {
      server,
      goalService,
      readToolCatalogIdentity,
      assertSourceBinding: (id: string, suppliedBinding: string): void => {
        if (id !== workspaceId || suppliedBinding !== binding)
          throw new ChatSpliceError('BAD_REQUEST', 'Goal fixture binding mismatch.');
      },
    } satisfies Pick<
      McpToolContext,
      'server' | 'goalService' | 'readToolCatalogIdentity' | 'assertSourceBinding'
    >;
    registerGoalTools(context);
    client = new Client({ name: 'goal-chat-fixture', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client?.close();
    await server?.close();
    goalRepository?.close();
    workspaceRepository?.close();
    await rm(temporary, { recursive: true, force: true });
  });

  async function call(name: string, fields: Record<string, unknown> = {}) {
    return client.callTool({
      name,
      arguments: { workspace_id: workspaceId, workspace_binding: binding, ...fields },
    });
  }

  async function read(goalId?: string): Promise<GoalRecord[]> {
    const result = await call('project.goal', goalId === undefined ? {} : { goal_id: goalId });
    expect(result.isError).not.toBe(true);
    return GoalReadResultSchema.parse(result.structuredContent).goals;
  }

  async function update(fields: Record<string, unknown>): Promise<GoalRecord> {
    const result = await call('project.goal_update', fields);
    expect(result.isError).not.toBe(true);
    return GoalUpdateResultSchema.parse(result.structuredContent).goal;
  }

  function target(goal: GoalRecord) {
    return { goal_id: goal.goal_id, expected_revision: goal.revision };
  }

  it('reports the running contract only after a bound read without changing structured Goal output', async () => {
    await client.listTools();
    expect(readToolCatalogIdentity).not.toHaveBeenCalled();
    const denied = await call('project.goal', { workspace_binding: `wb_${'d'.repeat(64)}` });
    expect(denied.isError).toBe(true);
    expect(readToolCatalogIdentity).not.toHaveBeenCalled();

    const result = await call('project.goal');
    expect(result.isError).not.toBe(true);
    expect(GoalReadResultSchema.parse(result.structuredContent)).toEqual(result.structuredContent);
    expect(result.structuredContent).not.toHaveProperty('goal_tool_contract');
    expect(readToolCatalogIdentity).toHaveBeenCalledTimes(1);
    const blocks = result.content as Array<{ type: string; text?: string }>;
    expect(blocks).toHaveLength(2);
    const diagnostic = JSON.parse(blocks[1]!.text!);
    expect(diagnostic).toMatchObject({
      kind: 'goal_tool_contract',
      source: 'running_mcp_server',
      execution_contract_version: EXECUTION_CONTRACT_VERSION,
      mcp_descriptor_version: MCP_SERVER_VERSION,
      catalog_identity_status: 'available',
      tool_count: catalogFixture.tool_count,
      tool_schema_digest: catalogFixture.tool_schema_digest,
      client_tool_schema_status: 'not_observable',
      max_executions: {
        minimum: 0,
        unlimited_value: 0,
        create_default: 0,
        omitted_resume: 'preserve_stored_value',
      },
    });
    expect(blocks[1]!.text).not.toContain(binding);
    expect(blocks[1]!.text).not.toContain(root);
    expect(blocks[1]!.text!.length).toBeLessThan(2_500);
  });

  it('preserves a valid Goal read when optional catalog diagnostics are unavailable', async () => {
    const goal = await update({
      action: 'create',
      objective: 'Keep the saved Goal readable during diagnostic failure.',
      tracked_paths: ['source.ts'],
      criteria: [
        {
          kind: 'file',
          criterion_id: 'source_identity',
          description: 'Track the real project source.',
          path: 'source.ts',
        },
      ],
    });
    readToolCatalogIdentity.mockRejectedValueOnce(new Error('private-diagnostic-error-marker'));
    const result = await call('project.goal', { goal_id: goal.goal_id });
    expect(result.isError).not.toBe(true);
    const saved = GoalReadResultSchema.parse(result.structuredContent).goals[0];
    expect(saved).toMatchObject({
      goal_id: goal.goal_id,
      revision: goal.revision,
      state: goal.state,
      max_executions: goal.max_executions,
    });
    const blocks = result.content as Array<{ type: string; text?: string }>;
    expect(JSON.parse(blocks[1]!.text!)).toMatchObject({
      catalog_identity_status: 'unavailable',
      tool_count: null,
      tool_schema_digest: null,
      client_tool_schema_status: 'not_observable',
    });
    expect(JSON.stringify(result)).not.toContain('private-diagnostic-error-marker');
  });

  it('preserves an unlimited consumed budget through explicit and omitted MCP resume inputs', async () => {
    const create = {
      action: 'create',
      objective: 'Continue the same unlimited Goal after receipt compaction.',
      tracked_paths: ['source.ts'],
      criteria: [
        {
          kind: 'file',
          criterion_id: 'source_identity',
          description: 'Retain the current source identity during resume.',
          path: 'source.ts',
        },
      ],
    };
    // Explicit zero and positive budgets above the old 128 ceiling must reach
    // the real registered tool handler, not merely pass an owner-only schema.
    const finite = await update({ ...create, max_executions: 256 });
    expect(finite).toMatchObject({ max_executions: 256, executions_used: 0 });
    let goal = await update({ ...create, max_executions: 0 });
    expect(goal).toMatchObject({ state: 'active', max_executions: 0, executions_used: 0 });
    goal = await update({ ...target(goal), action: 'pause' });

    // Model a durable long-running Goal without executing 244 fixture commands:
    // the cumulative count exceeds the retained terminal receipt window.
    const stored = goalRepository.find(goal.goal_id);
    if (stored === undefined) throw new Error('Created fixture Goal was not persisted.');
    const timestamp = new Date().toISOString();
    const receipts = Array.from({ length: 32 }, (_, index) => ({
      job_id: `exec_${randomUUID()}`,
      request_hash: (index + 1).toString(16).padStart(64, '0'),
      criterion_id: null,
      state: 'succeeded' as const,
      build_id: 'a'.repeat(64),
      run_id: randomUUID(),
      created_at: timestamp,
      started_at: timestamp,
      finished_at: timestamp,
      exit_code: 0,
    }));
    goalRepository.replace(
      {
        ...stored,
        revision: stored.revision + 1,
        executions_used: 244,
        receipts,
        updated_at: timestamp,
      },
      stored.revision,
    );
    goal = (await read(goal.goal_id))[0]!;
    expect(goal).toMatchObject({
      state: 'paused',
      max_executions: 0,
      executions_used: 244,
    });
    const goalId = goal.goal_id;
    const receiptIds = goal.receipts.map((receipt) => receipt.job_id);
    expect(receiptIds).toHaveLength(32);

    for (const [index, budget] of [{ max_executions: 0 }, {}].entries()) {
      const revision = goal.revision;
      goal = await update({
        ...target(goal),
        action: 'resume',
        deadline_ms: 1_800_000,
        ...budget,
      });
      expect(goal).toMatchObject({
        goal_id: goalId,
        revision: revision + 1,
        state: 'active',
        max_executions: 0,
        executions_used: 244,
      });
      expect(goal.receipts.map((receipt) => receipt.job_id)).toEqual(receiptIds);
      expect(goal.receipts.every((receipt) => receipt.state === 'succeeded')).toBe(true);
      if (index === 0) {
        await update({ ...target(goal), action: 'pause' });
        goal = (await read(goalId))[0]!;
      }
    }
    expect((await read(goalId))[0]).toMatchObject({
      state: 'active',
      max_executions: 0,
      executions_used: 244,
    });
    expect((await read()).map((saved) => saved.goal_id).sort()).toEqual(
      [finite.goal_id, goalId].sort(),
    );
  });

  it('discovers, registers, checkpoints and resumes the same Goal with revision and evidence guards', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['project.goal', 'project.goal_update']);
    expect(tools.find((tool) => tool.name === 'project.goal')?.annotations?.readOnlyHint).toBe(
      true,
    );
    expect(
      tools.find((tool) => tool.name === 'project.goal_update')?.annotations?.readOnlyHint,
    ).toBe(false);
    expect(await read()).toEqual([]);

    const create = {
      action: 'create',
      objective: 'Record the source file identity and retain the next review step.',
      scope: 'A concrete file criterion for the transport lifecycle fixture.',
      tracked_paths: ['source.ts'],
      criteria: [
        {
          kind: 'file',
          criterion_id: 'source_identity',
          description: 'Hash the current source file; this is not a behavior test.',
          path: 'source.ts',
          required: true,
        },
      ],
      next_step: 'Review the source identity.',
    };
    const denied = await call('project.goal_update', {
      ...create,
      workspace_binding: `wb_${'c'.repeat(64)}`,
    });
    expect(denied.isError).toBe(true);
    expect(await read()).toEqual([]);

    let goal = await update(create);
    const goalId = goal.goal_id;
    expect(goal).toMatchObject({
      state: 'active',
      executions_used: 0,
      evidence_valid: false,
      checkpoint: { next_step: 'Review the source identity.' },
    });
    expect(goal.checkpoint?.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(goal.criteria[0]?.status).toBe('pending');
    expect(goal).not.toHaveProperty('workspace_binding');
    expect((await read()).map((saved) => saved.goal_id)).toEqual([goalId]);

    const initialRevision = goal.revision;
    goal = await update({
      ...target(goal),
      action: 'checkpoint',
      summary: 'Inspected source.ts and selected the concrete file criterion.',
      next_step: 'Verify the current source SHA, then request completion.',
    });
    const stale = await call('project.goal_update', {
      goal_id: goalId,
      expected_revision: initialRevision,
      action: 'checkpoint',
      summary: 'An obsolete editor draft.',
      next_step: 'This must not replace the latest checkpoint.',
    });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toContain('revision changed');

    await update({ ...target(goal), action: 'pause' });
    goal = (await read(goalId))[0]!;
    expect(goal.state).toBe('paused');
    goal = await update({ ...target(goal), action: 'resume', deadline_ms: 3_600_000 });
    expect(goal.goal_id).toBe(goalId);
    expect(goal.checkpoint?.next_step).toBe(
      'Verify the current source SHA, then request completion.',
    );
    expect(goal.receipts).toEqual([]);
    expect((await read()).map((saved) => saved.goal_id)).toEqual([goalId]);

    const incomplete = await call('project.goal_update', { ...target(goal), action: 'complete' });
    expect(incomplete.isError).toBe(true);
    expect(JSON.stringify(incomplete.content)).toContain('evidence');
    goal = await update({
      ...target(goal),
      action: 'verify_file',
      criterion_id: 'source_identity',
    });
    expect(goal.evidence_valid).toBe(true);

    await writeFile(join(root, 'source.ts'), 'export const result = 2;\n');
    goal = (await read(goalId))[0]!;
    expect(goal.criteria[0]?.status).toBe('stale');
    const changed = await call('project.goal_update', {
      ...target(goal),
      action: 'complete',
    });
    expect(changed.isError).toBe(true);
    goal = await update({
      ...target(goal),
      action: 'verify_file',
      criterion_id: 'source_identity',
    });
    goal = await update({ ...target(goal), action: 'complete' });
    expect(goal.state).toBe('completed');
    expect(goal.goal_id).toBe(goalId);
    expect(goal.evidence_valid).toBe(true);
    const terminal = await call('project.goal_update', { ...target(goal), action: 'resume' });
    expect(terminal.isError).toBe(true);
  });
});
