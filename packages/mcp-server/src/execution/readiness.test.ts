import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteWorkspaceRepository, WorkspaceService } from '@chatsplice/core';
import { ProjectExecInputSchema } from '@chatsplice/protocol';
import { describe, expect, it } from 'vitest';

import { ProjectExecutionService } from './service.js';

async function fixture(status: number | null) {
  const directory = await mkdtemp(join(tmpdir(), 'cs-readiness-execution-'));
  const root = join(directory, 'project');
  await mkdir(root);
  const repository = new SqliteWorkspaceRepository(join(directory, 'state.sqlite'));
  const workspace = new WorkspaceService(repository);
  const id = (await workspace.register({ root_path: root })).workspace_id;
  let requests = 0;
  let firstRequest!: () => void;
  const started = new Promise<void>((resolve) => {
    firstRequest = resolve;
  });
  const server = createServer((_request, response) => {
    requests += 1;
    firstRequest();
    if (status !== null) response.writeHead(status).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const service = new ProjectExecutionService(workspace);
  const base = { workspace_id: id, workspace_binding: `wb_${'a'.repeat(64)}` };
  const input = (requestId: string, operation = {}, timeout_ms = 5000) =>
    ProjectExecInputSchema.parse({
      ...base,
      request_id: requestId,
      timeout_ms,
      operation: {
        kind: 'readiness',
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`,
        ...operation,
      },
    });
  return {
    service,
    base,
    input,
    started,
    requests: () => requests,
    async close() {
      await service.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      repository.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe('readiness through project execution lifecycle', () => {
  it('returns structured failure, observes retry bounds and deduplicates finished requests', async () => {
    const context = await fixture(503);
    try {
      const input = context.input('readiness-retry-1', { attempts: 2, interval_ms: 100 });
      const submitted = context.service.submit(input);
      const result = await context.service.awaitJob({
        ...context.base,
        job_id: submitted.job_id,
        timeout_ms: 5000,
      });
      expect(result).toMatchObject({
        state: 'failed',
        exit_code: 1,
        used_network: true,
        readiness_result: {
          ready: false,
          attempts_used: 2,
          status_code: 503,
          failure: 'unexpected_status',
        },
      });
      expect(context.requests()).toBe(2);
      expect(context.service.submit(input).job_id).toBe(submitted.job_id);
      expect(context.requests()).toBe(2);
    } finally {
      await context.close();
    }
  });

  it('cancels retry waiting through cancel_exec and waits for cleanup before terminal state', async () => {
    const context = await fixture(503);
    try {
      const submitted = context.service.submit(
        context.input('readiness-cancel-1', { attempts: 10, interval_ms: 5000 }),
      );
      await context.started;
      context.service.cancel(context.base.workspace_id, submitted.job_id);
      const result = await context.service.awaitJob({
        ...context.base,
        job_id: submitted.job_id,
        timeout_ms: 5000,
      });
      expect(result.state).toBe('cancelled');
      expect(result.readiness_result).toBeUndefined();
      expect(context.requests()).toBe(1);
      expect(
        context.service
          .list()
          .every((job) => !['queued', 'running', 'cancelling'].includes(job.state)),
      ).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('applies the whole execution deadline even when individual requests allow longer', async () => {
    const context = await fixture(null);
    try {
      const submitted = context.service.submit(
        context.input('readiness-deadline-1', { attempts: 10, request_timeout_ms: 10000 }, 1000),
      );
      const result = await context.service.awaitJob({
        ...context.base,
        job_id: submitted.job_id,
        timeout_ms: 5000,
      });
      expect(result.state).toBe('timed_out');
      expect(result.readiness_result).toBeUndefined();
      expect(result.duration_ms).toBeLessThan(3000);
      expect(context.requests()).toBe(1);
      expect(
        context.service
          .list()
          .every((job) => !['queued', 'running', 'cancelling'].includes(job.state)),
      ).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('returns a successful readiness result without equating it to process ownership', async () => {
    const context = await fixture(204);
    try {
      const submitted = context.service.submit(
        context.input('readiness-success-1', { expected_status: 204 }),
      );
      const result = await context.service.awaitJob({
        ...context.base,
        job_id: submitted.job_id,
        timeout_ms: 5000,
      });
      expect(result).toMatchObject({
        state: 'succeeded',
        exit_code: 0,
        readiness_result: { method: 'HEAD', ready: true, attempts_used: 1, status_code: 204 },
      });
      expect(result.command).toMatch(/^HEAD http:\/\/127\.0\.0\.1:/);
    } finally {
      await context.close();
    }
  });
});
