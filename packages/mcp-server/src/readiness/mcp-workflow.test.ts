import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteWorkspaceRepository, WorkspaceService } from '@chatsplice/core';
import { ProjectExecJobSchema, ProjectExecSummarySchema } from '@chatsplice/protocol';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, it } from 'vitest';

import { startChatSpliceRuntime } from '../runtime.js';
import { workspaceBindingFor } from '../workspace-binding.js';

it('discovers readiness and returns actual endpoint evidence through MCP exec/await', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cs-readiness-mcp-'));
  const root = join(directory, 'project');
  await mkdir(root);
  const repository = new SqliteWorkspaceRepository(join(directory, 'chatsplice.sqlite'));
  const workspace = await new WorkspaceService(repository).register({ root_path: root });
  repository.close();
  const runtime = await startChatSpliceRuntime({
    dataDirectory: directory,
    controlSocketPath: join(directory, 'control.sock'),
  });
  const client = new Client({ name: 'readiness-workflow-fixture', version: '1' });
  let requests = 0;
  const endpoint = createServer((request, response) => {
    expect(request.method).toBe('HEAD');
    requests += 1;
    response.writeHead(requests === 1 ? 503 : 200).end();
  });
  await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(runtime.mcpUrl), {
        requestInit: { headers: { 'x-chatsplice-token': runtime.mcpToken } },
      }),
    );
    const tools = await client.listTools();
    expect(
      JSON.stringify(tools.tools.find((tool) => tool.name === 'project.exec')?.inputSchema),
    ).toContain('"readiness"');
    const bound = {
      workspace_id: workspace.workspace_id,
      workspace_binding: workspaceBindingFor(runtime.mcpToken, workspace.workspace_id),
    };
    const submitted = await client.callTool({
      name: 'project.exec',
      arguments: {
        ...bound,
        request_id: 'readiness-mcp-fixture-1',
        operation: {
          kind: 'readiness',
          url: `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/health`,
          attempts: 3,
          interval_ms: 100,
        },
      },
    });
    expect(submitted.isError).not.toBe(true);
    const { job_id } = ProjectExecSummarySchema.parse(submitted.structuredContent);
    const awaited = await client.callTool({
      name: 'project.await_exec',
      arguments: { ...bound, job_id, timeout_ms: 5000 },
    });
    expect(awaited.isError).not.toBe(true);
    const result = ProjectExecJobSchema.parse(awaited.structuredContent);
    expect(result).toMatchObject({
      state: 'succeeded',
      exit_code: 0,
      readiness_result: { ready: true, attempts_used: 2, status_code: 200 },
    });
    expect(requests).toBe(2);
  } finally {
    await client.close();
    await runtime.close();
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
