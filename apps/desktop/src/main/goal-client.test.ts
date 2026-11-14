import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import { GoalRecordSchema } from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DaemonClient, DaemonControlError } from './daemon-client.js';

const WORKSPACE_ID = `ws_${'c'.repeat(24)}`;
const GOAL_ID = 'goal_00000000-0000-4000-8000-000000000000';
const goal = GoalRecordSchema.parse({
  goal_id: GOAL_ID,
  workspace_id: WORKSPACE_ID,
  objective: 'Verify the selected project',
  scope: '',
  tracked_paths: ['src/app.ts'],
  criteria: [
    {
      kind: 'file',
      criterion_id: 'source',
      description: 'Current file',
      path: 'src/app.ts',
      status: 'pending',
      evidence: null,
    },
  ],
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
});

describe('owner Goal daemon client', () => {
  let directory: string;
  let server: Server;
  let client: DaemonClient;
  let conflict: boolean;
  let requests: Array<{
    method: string | undefined;
    path: string | undefined;
    token: string | string[] | undefined;
    body: unknown;
  }>;

  beforeEach(async () => {
    // Keep the Unix socket under macOS sun_path even when the runner has a nested TMPDIR.
    directory = await mkdtemp(join(process.cwd(), 'cs-gc-'));
    const socket = join(directory, 'control.sock');
    const tokenPath = join(directory, 'control-mutation-token');
    await writeFile(tokenPath, 'd'.repeat(64), { mode: 0o600 });
    requests = [];
    conflict = false;
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const serialized = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: request.method,
        path: request.url,
        token: request.headers['x-chatsplice-control-mutation-token'],
        body: serialized === '' ? undefined : JSON.parse(serialized),
      });
      response.writeHead(conflict ? 409 : 200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          conflict
            ? {
                error: {
                  code: 'BAD_REQUEST',
                  message: 'Required evidence is stale. Re-run its checks.',
                },
              }
            : request.method === 'GET'
              ? { goals: [goal] }
              : serialized !== '' && JSON.parse(serialized).action === 'delete'
                ? { goal: { ...goal, state: 'cancelled', revision: 2 }, deleted: true }
                : { goal: { ...goal, state: 'paused', revision: 2 } },
        ),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    client = new DaemonClient(socket, tokenPath);
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    await rm(directory, { recursive: true, force: true });
  });

  it('uses the private owner capability and bounded validated response for scoped reads and updates', async () => {
    await expect(
      client.listGoals({ workspace_id: WORKSPACE_ID, goal_id: GOAL_ID }),
    ).resolves.toEqual({ goals: [goal] });
    await expect(
      client.updateGoal({
        workspace_id: WORKSPACE_ID,
        goal_id: GOAL_ID,
        action: 'pause',
        expected_revision: 1,
      }),
    ).resolves.toMatchObject({ goal: { state: 'paused', revision: 2 } });
    expect(requests).toEqual([
      {
        method: 'GET',
        path: `/v1/goals?workspace_id=${WORKSPACE_ID}&goal_id=${GOAL_ID}`,
        token: 'd'.repeat(64),
        body: undefined,
      },
      {
        method: 'POST',
        path: '/v1/goals/update',
        token: 'd'.repeat(64),
        body: {
          workspace_id: WORKSPACE_ID,
          goal_id: GOAL_ID,
          action: 'pause',
          expected_revision: 1,
        },
      },
    ]);
  });

  it('encodes explicit pagination and keeps unlimited resume and terminal deletion structured', async () => {
    await client.listGoals({ workspace_id: WORKSPACE_ID, offset: 17, limit: 7 });
    expect(requests[0]?.path).toBe(`/v1/goals?workspace_id=${WORKSPACE_ID}&offset=17&limit=7`);
    await client.updateGoal({
      workspace_id: WORKSPACE_ID,
      goal_id: GOAL_ID,
      action: 'resume',
      expected_revision: 1,
      max_executions: 0,
    });
    expect(requests[1]?.body).toMatchObject({ action: 'resume', max_executions: 0 });
    await expect(
      client.updateGoal({
        workspace_id: WORKSPACE_ID,
        goal_id: GOAL_ID,
        action: 'delete',
        expected_revision: 2,
      }),
    ).resolves.toMatchObject({ deleted: true, goal: { state: 'cancelled' } });
    expect(requests[2]?.body).toEqual({
      workspace_id: WORKSPACE_ID,
      goal_id: GOAL_ID,
      action: 'delete',
      expected_revision: 2,
    });
  });

  it('preserves the daemon completion rejection reason for the Goal pane', async () => {
    conflict = true;
    await expect(
      client.updateGoal({
        workspace_id: WORKSPACE_ID,
        goal_id: GOAL_ID,
        action: 'complete',
        expected_revision: 1,
      }),
    ).rejects.toBeInstanceOf(DaemonControlError);
    await expect(
      client.updateGoal({
        workspace_id: WORKSPACE_ID,
        goal_id: GOAL_ID,
        action: 'complete',
        expected_revision: 1,
      }),
    ).rejects.toThrow('Required evidence is stale');
  });

  it('rejects renderer-supplied bindings and invalid revisions before transport', async () => {
    await expect(
      client.listGoals({
        workspace_id: WORKSPACE_ID,
        workspace_binding: `wb_${'a'.repeat(64)}`,
      } as never),
    ).rejects.toThrow();
    await expect(
      client.updateGoal({
        workspace_id: WORKSPACE_ID,
        goal_id: GOAL_ID,
        action: 'pause',
        expected_revision: 0,
      }),
    ).rejects.toThrow();
    expect(requests).toEqual([]);
  });
});
