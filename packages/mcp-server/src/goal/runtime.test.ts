import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  GoalReadResultSchema,
  GoalUpdateResultSchema,
  ProjectExecJobSchema,
  ProjectExecSummarySchema,
  WorkspaceSummarySchema,
  type GoalRecord,
} from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startChatSpliceRuntime, type ChatSpliceRuntime } from '../runtime.js';
import { workspaceBindingFor } from '../workspace-binding.js';

function control(
  socketPath: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  token?: string,
) {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<{ status: number; payload: unknown }>((resolve, reject) => {
    const outgoing = request(
      {
        socketPath,
        method,
        path,
        headers: {
          ...(serialized === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(serialized),
              }),
          ...(token === undefined ? {} : { 'x-chatsplice-control-mutation-token': token }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end(serialized);
  });
}

describe('Persistent Goal runtime through MCP and owner control', () => {
  let directory: string;
  let root: string;
  let data: string;
  let socket: string;
  let runtime: ChatSpliceRuntime;
  let client: Client;
  let workspaceId: string;
  let mutationToken: string;

  async function connect() {
    client = new Client({ name: 'goal-runtime-test', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(runtime.mcpUrl), {
        requestInit: { headers: { 'x-chatsplice-token': runtime.mcpToken } },
      }),
    );
  }

  beforeEach(async () => {
    // A short fixture path keeps the actual owner socket below macOS sun_path.
    directory = await mkdtemp(join(process.cwd(), 'cs-gr-'));
    root = join(directory, 'project');
    data = join(directory, 'data');
    socket = join(directory, 'daemon.sock');
    await mkdir(root);
    await writeFile(join(root, 'source.txt'), 'accepted source\n');
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e "console.log(123)"' } }),
    );
    runtime = await startChatSpliceRuntime({ dataDirectory: data, controlSocketPath: socket });
    mutationToken = (await readFile(join(data, 'run', 'control-mutation-token'), 'utf8')).trim();
    const registered = await control(
      socket,
      'POST',
      '/v1/workspaces',
      { root_path: root },
      mutationToken,
    );
    workspaceId = WorkspaceSummarySchema.parse(registered.payload).workspace_id;
    await connect();
  });

  afterEach(async () => {
    await client?.close();
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  });

  function bound() {
    return {
      workspace_id: workspaceId,
      workspace_binding: workspaceBindingFor(runtime.mcpToken, workspaceId),
    };
  }

  async function create(): Promise<GoalRecord> {
    const result = await client.callTool({
      name: 'project.goal_update',
      arguments: {
        ...bound(),
        action: 'create',
        objective: 'Verify and finish the local change.',
        tracked_paths: ['source.txt', 'package.json'],
        criteria: [
          {
            criterion_id: 'source',
            kind: 'file',
            path: 'source.txt',
            description: 'Current source exists.',
          },
          {
            criterion_id: 'test',
            kind: 'check',
            cwd: '.',
            operation: { kind: 'node_script', script: 'test' },
            description: 'The declared test succeeds.',
          },
        ],
        next_step: 'Verify the source and run the test.',
      },
    });
    expect(result.isError).not.toBe(true);
    return GoalUpdateResultSchema.parse(result.structuredContent).goal;
  }

  async function read(goalId: string): Promise<GoalRecord> {
    const result = await client.callTool({
      name: 'project.goal',
      arguments: { ...bound(), goal_id: goalId },
    });
    expect(result.isError).not.toBe(true);
    return GoalReadResultSchema.parse(result.structuredContent).goals[0]!;
  }

  it('requires fresh file and real check evidence before completing, then detects changed files', async () => {
    let goal = await create();
    const missing = await client.callTool({
      name: 'project.goal_update',
      arguments: {
        ...bound(),
        action: 'complete',
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
      },
    });
    expect(missing.isError).toBe(true);

    const verified = await client.callTool({
      name: 'project.goal_update',
      arguments: {
        ...bound(),
        action: 'verify_file',
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
        criterion_id: 'source',
      },
    });
    goal = GoalUpdateResultSchema.parse(verified.structuredContent).goal;
    const submitted = await client.callTool({
      name: 'project.exec',
      arguments: {
        ...bound(),
        goal_id: goal.goal_id,
        criterion_id: 'test',
        request_id: 'goal-runtime-check-001',
        cwd: '.',
        operation: { kind: 'node_script', script: 'test' },
        timeout_ms: 10_000,
      },
    });
    const summary = ProjectExecSummarySchema.parse(submitted.structuredContent);
    const waited = await client.callTool({
      name: 'project.await_exec',
      arguments: { ...bound(), job_id: summary.job_id, timeout_ms: 15_000 },
    });
    expect(ProjectExecJobSchema.parse(waited.structuredContent)).toMatchObject({
      state: 'succeeded',
      exit_code: 0,
      goal_id: goal.goal_id,
    });
    goal = await read(goal.goal_id);
    expect(goal).toMatchObject({ evidence_valid: true, executions_used: 1 });
    expect(goal.receipts[0]).toMatchObject({
      state: 'succeeded',
      job_id: summary.job_id,
      criterion_id: 'test',
    });
    const completed = await client.callTool({
      name: 'project.goal_update',
      arguments: {
        ...bound(),
        action: 'complete',
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
      },
    });
    expect(GoalUpdateResultSchema.parse(completed.structuredContent).goal.state).toBe('completed');
    await writeFile(join(root, 'source.txt'), 'changed after verification\n');
    const stale = await read(goal.goal_id);
    expect(stale.evidence_valid).toBe(false);
    expect(stale.criteria.map((criterion) => criterion.status)).toEqual(['stale', 'stale']);
  }, 20_000);

  it('preserves checkpoints across restart and requires explicit resume without replaying work', async () => {
    let goal = await create();
    const checkpoint = await control(
      socket,
      'POST',
      '/v1/goals/update',
      {
        workspace_id: workspaceId,
        action: 'checkpoint',
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
        summary: 'Source was inspected.',
        next_step: 'Run the declared test once.',
      },
      mutationToken,
    );
    expect(checkpoint.status).toBe(200);
    goal = GoalUpdateResultSchema.parse(checkpoint.payload).goal;
    const previousRunId = runtime.status().run_id;
    await client.close();
    await runtime.close();
    runtime = await startChatSpliceRuntime({ dataDirectory: data, controlSocketPath: socket });
    expect(runtime.status().run_id).not.toBe(previousRunId);
    await connect();
    const recovered = await read(goal.goal_id);
    expect(recovered).toMatchObject({
      state: 'interrupted',
      executions_used: 0,
      checkpoint: { summary: 'Source was inspected.', next_step: 'Run the declared test once.' },
    });
    expect(recovered.receipts).toHaveLength(0);
    const resumed = await client.callTool({
      name: 'project.goal_update',
      arguments: {
        ...bound(),
        action: 'resume',
        goal_id: goal.goal_id,
        expected_revision: recovered.revision,
      },
    });
    expect(GoalUpdateResultSchema.parse(resumed.structuredContent).goal.state).toBe('active');
    expect(runtime.status().execution_jobs).toHaveLength(0);
  });

  it('transports bounded Goal pagination through MCP and authenticated owner HTTP', async () => {
    const goals = [await create(), await create(), await create()];
    const page = await control(
      socket,
      'GET',
      `/v1/goals?workspace_id=${workspaceId}&offset=1&limit=1`,
      undefined,
      mutationToken,
    );
    expect(page.status).toBe(200);
    const parsed = GoalReadResultSchema.parse(page.payload);
    expect(parsed.goals.map((goal) => goal.goal_id)).toEqual([goals[1]!.goal_id]);
    expect(parsed).toMatchObject({ total: 3, has_more: true, next_offset: 2 });
    const mcp = await client.callTool({
      name: 'project.goal',
      arguments: { ...bound(), offset: 2, limit: 1 },
    });
    expect(mcp.isError).not.toBe(true);
    expect(GoalReadResultSchema.parse(mcp.structuredContent)).toMatchObject({
      goals: [{ goal_id: goals[2]!.goal_id }],
      total: 3,
      has_more: false,
      next_offset: null,
    });
    for (const suffix of [
      'offset=-1',
      'offset=1.5',
      'offset=',
      'limit=0',
      'limit=33',
      'offset=01',
    ]) {
      expect(
        (
          await control(
            socket,
            'GET',
            `/v1/goals?workspace_id=${workspaceId}&${suffix}`,
            undefined,
            mutationToken,
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (await control(socket, 'GET', `/v1/goals?workspace_id=${workspaceId}&offset=1&limit=1`))
        .status,
    ).toBe(403);
  });

  it('enforces exact binding, workspace ownership and owner mutation capability', async () => {
    const goal = await create();
    const denied = await client.callTool({
      name: 'project.goal',
      arguments: { ...bound(), goal_id: goal.goal_id, workspace_binding: `wb_${'0'.repeat(64)}` },
    });
    expect(denied.isError).toBe(true);
    const unauthorized = await control(socket, 'POST', '/v1/goals/update', {
      workspace_id: workspaceId,
      action: 'pause',
      goal_id: goal.goal_id,
      expected_revision: goal.revision,
    });
    expect(unauthorized.status).toBe(403);
    const invalidOwner = await control(
      socket,
      'POST',
      '/v1/goals/update',
      { ...bound(), action: 'pause', goal_id: goal.goal_id, expected_revision: goal.revision },
      mutationToken,
    );
    expect(invalidOwner.status).toBe(400);
    const otherRoot = join(directory, 'other-project');
    await mkdir(otherRoot);
    const other = WorkspaceSummarySchema.parse(
      (await control(socket, 'POST', '/v1/workspaces', { root_path: otherRoot }, mutationToken))
        .payload,
    );
    const crossWorkspace = await client.callTool({
      name: 'project.goal',
      arguments: {
        workspace_id: other.workspace_id,
        workspace_binding: workspaceBindingFor(runtime.mcpToken, other.workspace_id),
        goal_id: goal.goal_id,
      },
    });
    expect(crossWorkspace.isError).toBe(true);
    expect((await read(goal.goal_id)).state).toBe('active');
  });

  it.skipIf(process.env.CHATSPLICE_BROWSER_TESTS !== '1')(
    'records actual Chromium assertions and blocks completion until the declared UI outcome passes',
    async () => {
      const html =
        '<!doctype html><h1 id="status">Waiting</h1><button id="finish" onclick="document.querySelector(\'#status\').textContent=\'Ready\'">Finish</button>';
      await writeFile(join(root, 'page.html'), html);
      const app = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(html);
      });
      await new Promise<void>((resolve, reject) => {
        app.once('error', reject);
        app.listen(0, '127.0.0.1', resolve);
      });
      const address = app.address();
      if (address === null || typeof address === 'string')
        throw new Error('Browser fixture did not listen.');
      try {
        const expectation = { kind: 'text', selector: '#status', text: 'Ready', exact: true };
        const created = await client.callTool({
          name: 'project.goal_update',
          arguments: {
            ...bound(),
            action: 'create',
            objective: 'Verify the actual browser outcome.',
            tracked_paths: ['page.html'],
            criteria: [
              {
                criterion_id: 'ui',
                kind: 'browser',
                expectation,
                description: 'The finish action displays Ready.',
              },
            ],
          },
        });
        let goal = GoalUpdateResultSchema.parse(created.structuredContent).goal;
        let sequence = 0;
        async function browser(action: Record<string, unknown>, criterionId?: string) {
          const started = await client.callTool({
            name: 'project.exec',
            arguments: {
              ...bound(),
              goal_id: goal.goal_id,
              ...(criterionId === undefined ? {} : { criterion_id: criterionId }),
              request_id: `goal-browser-${++sequence}`,
              operation: { kind: 'browser', action },
              timeout_ms: 10_000,
            },
          });
          expect(started.isError).not.toBe(true);
          const summary = ProjectExecSummarySchema.parse(started.structuredContent);
          const waited = await client.callTool({
            name: 'project.await_exec',
            arguments: { ...bound(), job_id: summary.job_id, timeout_ms: 15_000 },
          });
          return { job: ProjectExecJobSchema.parse(waited.structuredContent), result: waited };
        }
        expect(
          (await browser({ kind: 'open', url: `http://127.0.0.1:${address.port}/` })).job.state,
        ).toBe('succeeded');
        const failed = await browser({ kind: 'assert', expectation, timeout_ms: 100 }, 'ui');
        expect(failed.job.state).toBe('failed');
        expect(failed.job.browser_result?.screenshot_available).toBe(true);
        goal = await read(goal.goal_id);
        expect(goal.criteria[0]?.status).toBe('failed');
        expect(
          (
            await client.callTool({
              name: 'project.goal_update',
              arguments: {
                ...bound(),
                action: 'complete',
                goal_id: goal.goal_id,
                expected_revision: goal.revision,
              },
            })
          ).isError,
        ).toBe(true);
        expect((await browser({ kind: 'click', selector: '#finish' })).job.state).toBe('succeeded');
        expect((await browser({ kind: 'assert', expectation }, 'ui')).job.state).toBe('succeeded');
        goal = await read(goal.goal_id);
        expect(goal.evidence_valid).toBe(true);
        const complete = await client.callTool({
          name: 'project.goal_update',
          arguments: {
            ...bound(),
            action: 'complete',
            goal_id: goal.goal_id,
            expected_revision: goal.revision,
          },
        });
        expect(GoalUpdateResultSchema.parse(complete.structuredContent).goal.state).toBe(
          'completed',
        );
      } finally {
        app.closeAllConnections();
        await new Promise<void>((resolve) => app.close(() => resolve()));
      }
    },
    30_000,
  );
});
