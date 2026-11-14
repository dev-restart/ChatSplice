import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteWorkspaceRepository, WorkspaceService } from '@chatsplice/core';
import { ProjectExecJobSchema, ProjectExecSummarySchema } from '@chatsplice/protocol';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, it } from 'vitest';

import { startChatSpliceRuntime } from '../runtime.js';
import { workspaceBindingFor } from '../workspace-binding.js';

it('discovers environment and returns bounded inspection through MCP exec/await without running scripts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cs-environment-mcp-'));
  const root = join(directory, 'project');
  const cache = join(directory, 'empty-browser-cache');
  await mkdir(cache);
  const previousCache = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
  await mkdir(root);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      packageManager: 'pnpm@10.33.2',
      scripts: { check: 'never-run-private-command' },
      secretValue: 'do-not-return-private-value',
    }),
  );
  const repository = new SqliteWorkspaceRepository(join(directory, 'chatsplice.sqlite'));
  const workspace = await new WorkspaceService(repository).register({ root_path: root });
  repository.close();
  const runtime = await startChatSpliceRuntime({
    dataDirectory: directory,
    controlSocketPath: join(directory, 'control.sock'),
  });
  const client = new Client({ name: 'environment-workflow-fixture', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(runtime.mcpUrl), {
        requestInit: { headers: { 'x-chatsplice-token': runtime.mcpToken } },
      }),
    );
    const tools = await client.listTools();
    expect(
      JSON.stringify(tools.tools.find((tool) => tool.name === 'project.exec')?.inputSchema),
    ).toContain('"environment"');
    const bound = {
      workspace_id: workspace.workspace_id,
      workspace_binding: workspaceBindingFor(runtime.mcpToken, workspace.workspace_id),
    };
    const submitted = await client.callTool({
      name: 'project.exec',
      arguments: {
        ...bound,
        request_id: 'environment-mcp-fixture-1',
        operation: { kind: 'environment' },
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
      used_network: false,
      environment_result: {
        node: { package_manager: 'pnpm', scripts: ['check'], lockfile_path: null },
        browser: { state: 'missing', launch_verified: false },
      },
    });
    expect(result.environment_result?.issues).toContain('lockfile_missing');
    expect(result.environment_result?.issues).toContain('browser_missing');
    expect(await readdir(cache)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('never-run-private-command');
    expect(JSON.stringify(result)).not.toContain('do-not-return-private-value');
    expect(JSON.stringify(result)).not.toContain(root);
  } finally {
    if (previousCache === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previousCache;
    await client.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
