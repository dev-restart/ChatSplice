import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  ProjectBindingResultSchema,
  WorkspaceSummarySchema,
  type WorkspaceBinding,
} from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChatSpliceRuntime } from './runtime.js';
import { resolveRuntimeDatabasePath, startChatSpliceRuntime } from './runtime.js';

function controlRequest(
  socketPath: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  extraHeaders?: Readonly<Record<string, string>>,
): Promise<{ status: number; payload: unknown }> {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method,
        headers: {
          ...extraHeaders,
          ...(serialized === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(serialized),
              }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
          });
        });
      },
    );
    req.on('error', reject);
    if (serialized !== undefined) {
      req.write(serialized);
    }
    req.end();
  });
}

function bindingFromText(text: string): WorkspaceBinding {
  const match = text.match(/^- workspace_binding: (wb_[a-f0-9]{64})$/mu);
  if (match?.[1] === undefined) {
    throw new Error('Project binding text did not contain workspace_binding.');
  }
  return match[1] as WorkspaceBinding;
}

describe('runtime database migration', () => {
  it('reuses legacy state until a current ChatSplice database exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chatsplice-database-'));
    try {
      await writeFile(join(directory, 'localchat.sqlite'), 'legacy');
      expect(resolveRuntimeDatabasePath(directory)).toBe(join(directory, 'localchat.sqlite'));
      await writeFile(join(directory, 'chatsplice.sqlite'), 'current');
      expect(resolveRuntimeDatabasePath(directory)).toBe(join(directory, 'chatsplice.sqlite'));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('chatsplice runtime', () => {
  let temporaryDirectory: string;
  let controlSocketPath: string;
  let runtime: ChatSpliceRuntime;
  let executionCalls: number;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatspliced-'));
    controlSocketPath = join(temporaryDirectory, 'chatspliced.sock');
    executionCalls = 0;
    runtime = await startChatSpliceRuntime({
      dataDirectory: join(temporaryDirectory, 'data'),
      controlSocketPath,
      localApplyStartWaitMs: 0,
      executionBackend: async (_workspaceService, _input, options) => {
        executionCalls += 1;
        options.onStart({ command: 'fake project execution', used_network: false });
        await new Promise<void>((resolve) => {
          if (options.signal.aborted) {
            resolve();
            return;
          }
          options.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { exit_code: 0, duration_ms: 1, timed_out: false };
      },
    });
  });

  afterEach(async () => {
    await runtime.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('serves the bounded ChatSplice tools through authenticated Streamable HTTP', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(runtime.mcpUrl), {
      requestInit: { headers: { 'x-chatsplice-token': runtime.mcpToken } },
    });
    const client = new Client({ name: 'chatsplice-contract-test', version: '0.0.1' });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        'workspace.list',
        'fs.reference_list',
        'fs.reference_paths',
        'fs.reference_search',
        'fs.reference_read',
        'fs.reference_request',
        'fs.reference_request_await',
        'fs.list',
        'fs.search',
        'fs.read',
        'fs.edit',
        'fs.write',
        'fs.mkdir',
        'fs.rename',
        'fs.delete',
        'project.run',
        'project.exec',
        'project.await_exec',
        'project.cancel_exec',
        'project.git',
        'local.prepare_apply',
        'local.await_apply',
      ]);
      expect(tools.tools.find((tool) => tool.name === 'project.git')?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      });
      expect(
        tools.tools
          .filter((tool) =>
            [
              'workspace.list',
              'fs.reference_list',
              'fs.reference_paths',
              'fs.reference_search',
              'fs.reference_read',
              'fs.list',
              'fs.search',
              'fs.read',
              'fs.reference_request_await',
              'local.await_apply',
              'project.await_exec',
            ].includes(tool.name),
          )
          .every((tool) => tool.annotations?.readOnlyHint === true),
      ).toBe(true);
      expect(
        tools.tools.find((tool) => tool.name === 'fs.reference_request')?.annotations,
      ).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      });
      for (const toolName of [
        'fs.edit',
        'fs.write',
        'fs.rename',
        'fs.delete',
        'project.run',
        'project.cancel_exec',
      ]) {
        expect(tools.tools.find((tool) => tool.name === toolName)?.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        });
      }
      expect(tools.tools.find((tool) => tool.name === 'project.exec')?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      });
      expect(tools.tools.find((tool) => tool.name === 'fs.edit')?.description).toContain(
        'bounded exact old_text/new_text replacements',
      );
      expect(tools.tools.find((tool) => tool.name === 'fs.write')?.description).toContain('atomic');
      expect(tools.tools.find((tool) => tool.name === 'project.run')?.description).toContain(
        'not a general shell',
      );
      expect(tools.tools.find((tool) => tool.name === 'fs.list')?.description).toContain(
        'never follow symlinks',
      );
      expect(tools.tools.find((tool) => tool.name === 'fs.search')?.description).toContain(
        'literal search',
      );
      expect(tools.tools.find((tool) => tool.name === 'fs.reference_read')?.description).toContain(
        'never writes',
      );
      expect(
        tools.tools.find((tool) => tool.name === 'local.prepare_apply')?.annotations,
      ).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      });
      expect(
        tools.tools.find((tool) => tool.name === 'local.prepare_apply')?.description,
      ).toContain('Requests automatic local execution');
      expect(tools.tools.find((tool) => tool.name === 'local.prepare_apply')?.title).toBe(
        'Request Automatic ChatSplice Changes',
      );
      expect(
        tools.tools.find((tool) => tool.name === 'local.prepare_apply')?.description,
      ).toContain('follow-ups after image generation');
      expect(
        tools.tools.find((tool) => tool.name === 'local.prepare_apply')?.description,
      ).toContain('without a confirmation dialog');
      expect(
        tools.tools.find((tool) => tool.name === 'local.prepare_apply')?.description,
      ).toContain('bounded git commands');
      expect(tools.tools.find((tool) => tool.name === 'local.await_apply')?.description).toContain(
        'Never use this for a new change request',
      );

      const listed = await client.callTool({ name: 'workspace.list', arguments: {} });
      expect(listed.isError).not.toBe(true);
      expect(JSON.stringify(listed.structuredContent)).toContain(runtime.probeWorkspaceId);

      const unboundRead = await client.callTool({
        name: 'fs.read',
        arguments: { workspace_id: runtime.probeWorkspaceId, path: 'probe.txt' },
      });
      expect(unboundRead.isError).toBe(true);
      expect(JSON.stringify(unboundRead.content)).toContain('workspace_binding');

      const unboundList = await client.callTool({
        name: 'fs.list',
        arguments: { workspace_id: runtime.probeWorkspaceId },
      });
      expect(unboundList.isError).toBe(true);
      expect(JSON.stringify(unboundList.content)).toContain('workspace_binding');

      const bindingResponse = await controlRequest(
        controlSocketPath,
        'POST',
        '/v1/project-binding',
        { workspace_id: runtime.probeWorkspaceId },
      );
      const binding = ProjectBindingResultSchema.parse(bindingResponse.payload);
      const workspaceBinding = bindingFromText(binding.binding_text);
      expect(binding.binding_text).toContain('project_name: "ChatSplice Milestone 0 Probe"');

      const pathList = await client.callTool({
        name: 'fs.list',
        arguments: {
          workspace_id: runtime.probeWorkspaceId,
          workspace_binding: workspaceBinding,
        },
      });
      expect(pathList.isError).not.toBe(true);
      expect(JSON.stringify(pathList.structuredContent)).toContain('probe.txt');

      const search = await client.callTool({
        name: 'fs.search',
        arguments: {
          workspace_id: runtime.probeWorkspaceId,
          workspace_binding: workspaceBinding,
          query: 'Milestone 0 probe',
        },
      });
      expect(search.isError).not.toBe(true);
      expect(JSON.stringify(search.structuredContent)).toContain('probe.txt');

      const mismatchedRead = await client.callTool({
        name: 'fs.read',
        arguments: {
          workspace_id: runtime.probeWorkspaceId,
          workspace_binding: `wb_${'0'.repeat(64)}`,
          path: 'probe.txt',
        },
      });
      expect(mismatchedRead.isError).toBe(true);
      expect(JSON.stringify(mismatchedRead.content)).toContain('WORKSPACE_BINDING_REQUIRED');

      const read = await client.callTool({
        name: 'fs.read',
        arguments: {
          workspace_id: runtime.probeWorkspaceId,
          workspace_binding: workspaceBinding,
          path: 'probe.txt',
        },
      });
      expect(read.isError).not.toBe(true);
      expect(JSON.stringify(read.structuredContent)).toContain(
        'ChatSplice Milestone 0 probe file.',
      );
      expect(JSON.stringify(read.structuredContent)).toContain(
        '"workspace_name":"ChatSplice Milestone 0 Probe"',
      );

      const rejectedProbeEdit = await client.callTool({
        name: 'fs.edit',
        arguments: {
          workspace_id: runtime.probeWorkspaceId,
          workspace_binding: workspaceBinding,
          path: 'probe.txt',
          expected_sha256: (read.structuredContent as { sha256: string }).sha256,
          edits: [{ old_text: 'probe file', new_text: 'changed probe' }],
        },
      });
      expect(rejectedProbeEdit.isError).toBe(true);
      expect(JSON.stringify(rejectedProbeEdit.content)).toContain('user workspaces');
    } finally {
      await client.close();
    }
  });

  it('lets bound Normal Chat apply a direct optimistic edit without a worker handoff', async () => {
    const root = join(temporaryDirectory, 'direct-edit-workspace');
    await mkdir(root);
    await writeFile(join(root, 'README.md'), '# before\n', 'utf8');
    const workspace = WorkspaceSummarySchema.parse(
      (await controlRequest(controlSocketPath, 'POST', '/v1/workspaces', { root_path: root }))
        .payload,
    );
    const bindingResult = ProjectBindingResultSchema.parse(
      (
        await controlRequest(controlSocketPath, 'POST', '/v1/project-binding', {
          workspace_id: workspace.workspace_id,
        })
      ).payload,
    );
    const workspaceBinding = bindingFromText(bindingResult.binding_text);
    const transport = new StreamableHTTPClientTransport(new URL(runtime.mcpUrl), {
      requestInit: { headers: { 'x-chatsplice-token': runtime.mcpToken } },
    });
    const client = new Client({ name: 'chatsplice-direct-edit-test', version: '0.0.1' });
    await client.connect(transport);
    try {
      const read = await client.callTool({
        name: 'fs.read',
        arguments: {
          workspace_id: workspace.workspace_id,
          workspace_binding: workspaceBinding,
          path: 'README.md',
        },
      });
      const sha256 = (read.structuredContent as { sha256: string }).sha256;
      const edited = await client.callTool({
        name: 'fs.edit',
        arguments: {
          workspace_id: workspace.workspace_id,
          workspace_binding: workspaceBinding,
          path: 'README.md',
          expected_sha256: sha256,
          edits: [{ old_text: '# before', new_text: '# after' }],
        },
      });

      expect(edited.isError).not.toBe(true);
      expect(edited.structuredContent).toMatchObject({ path: 'README.md', replacements: 1 });
      expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('# after\n');
      expect((await controlRequest(controlSocketPath, 'GET', '/v1/status')).payload).toMatchObject({
        latest_direct_edits: [
          {
            workspace_id: workspace.workspace_id,
            workspace_name: workspace.display_name,
            path: 'README.md',
            replacements: 1,
          },
        ],
        latest_mcp_activities: expect.arrayContaining([
          expect.objectContaining({
            workspace_id: workspace.workspace_id,
            workspace_name: workspace.display_name,
            tool: 'fs.edit',
            paths: ['README.md'],
            state: 'succeeded',
          }),
        ]),
      });
    } finally {
      await client.close();
    }
  });

  it('blocks every direct-MCP mutation tool while owner read-only mode is on, then allows them once it is off', async () => {
    const root = join(temporaryDirectory, 'read-only-mode-workspace');
    await mkdir(root);
    await writeFile(join(root, 'README.md'), '# before\n', 'utf8');
    const workspace = WorkspaceSummarySchema.parse(
      (await controlRequest(controlSocketPath, 'POST', '/v1/workspaces', { root_path: root }))
        .payload,
    );
    const bindingResult = ProjectBindingResultSchema.parse(
      (
        await controlRequest(controlSocketPath, 'POST', '/v1/project-binding', {
          workspace_id: workspace.workspace_id,
        })
      ).payload,
    );
    const workspaceBinding = bindingFromText(bindingResult.binding_text);
    const mutationToken = (
      await readFile(join(temporaryDirectory, 'data', 'run', 'control-mutation-token'), 'utf8')
    ).trim();
    const mutationHeaders = { 'x-chatsplice-control-mutation-token': mutationToken };

    const rejectedGet = await controlRequest(controlSocketPath, 'GET', '/v1/read-only-mode');
    expect(rejectedGet).toEqual({ status: 200, payload: { enabled: false } });

    const enabled = await controlRequest(
      controlSocketPath,
      'PUT',
      '/v1/read-only-mode',
      { enabled: true },
      mutationHeaders,
    );
    expect(enabled).toEqual({ status: 200, payload: { enabled: true } });
    expect((await controlRequest(controlSocketPath, 'GET', '/v1/status')).payload).toMatchObject({
      read_only_mode: true,
    });

    const transport = new StreamableHTTPClientTransport(new URL(runtime.mcpUrl), {
      requestInit: { headers: { 'x-chatsplice-token': runtime.mcpToken } },
    });
    const client = new Client({ name: 'chatsplice-read-only-mode-test', version: '0.0.1' });
    await client.connect(transport);
    try {
      const read = await client.callTool({
        name: 'fs.read',
        arguments: {
          workspace_id: workspace.workspace_id,
          workspace_binding: workspaceBinding,
          path: 'README.md',
        },
      });
      expect(read.isError).not.toBe(true);
      const sha256 = (read.structuredContent as { sha256: string }).sha256;

      const blockedEdit = await client.callTool({
        name: 'fs.edit',
        arguments: {
          workspace_id: workspace.workspace_id,
          workspace_binding: workspaceBinding,
          path: 'README.md',
          expected_sha256: sha256,
          edits: [{ old_text: '# before', new_text: '# after' }],
        },
      });
      expect(blockedEdit.isError).toBe(true);
      expect((blockedEdit.content as Array<{ text: string }>)[0]?.text).toContain(
        'READ_ONLY_MODE_ENABLED',
      );
      expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('# before\n');

      const disabled = await controlRequest(
        controlSocketPath,
        'PUT',
        '/v1/read-only-mode',
        { enabled: false },
        mutationHeaders,
      );
      expect(disabled).toEqual({ status: 200, payload: { enabled: false } });
      expect((await controlRequest(controlSocketPath, 'GET', '/v1/status')).payload).toMatchObject({
        read_only_mode: false,
      });

      const allowedEdit = await client.callTool({
        name: 'fs.edit',
        arguments: {
          workspace_id: workspace.workspace_id,
          workspace_binding: workspaceBinding,
          path: 'README.md',
          expected_sha256: sha256,
          edits: [{ old_text: '# before', new_text: '# after' }],
        },
      });
      expect(allowedEdit.isError).not.toBe(true);
      expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('# after\n');
    } finally {
      await client.close();
    }
  });

  it('rejects owner read-only mode changes without the desktop mutation capability', async () => {
    const rejected = await controlRequest(controlSocketPath, 'PUT', '/v1/read-only-mode', {
      enabled: true,
    });
    expect(rejected.status).toBe(403);
    expect((await controlRequest(controlSocketPath, 'GET', '/v1/read-only-mode')).payload).toEqual({
      enabled: false,
    });
  });

  it('lets the owner toggle per-project auto-attach and clears it when the workspace is removed', async () => {
    const root = join(temporaryDirectory, 'auto-attach-workspace');
    await mkdir(root);
    const workspace = WorkspaceSummarySchema.parse(
      (await controlRequest(controlSocketPath, 'POST', '/v1/workspaces', { root_path: root }))
        .payload,
    );
    const mutationToken = (
      await readFile(join(temporaryDirectory, 'data', 'run', 'control-mutation-token'), 'utf8')
    ).trim();

    const rejected = await controlRequest(controlSocketPath, 'PUT', '/v1/auto-attach', {
      workspace_id: workspace.workspace_id,
      enabled: true,
    });
    expect(rejected.status).toBe(403);
    expect((await controlRequest(controlSocketPath, 'GET', '/v1/status')).payload).toMatchObject({
      auto_attach_workspace_ids: [],
    });

    const enabled = await controlRequest(
      controlSocketPath,
      'PUT',
      '/v1/auto-attach',
      { workspace_id: workspace.workspace_id, enabled: true },
      { 'x-chatsplice-control-mutation-token': mutationToken },
    );
    expect(enabled.status).toBe(200);
    expect(enabled.payload).toEqual([workspace.workspace_id]);
    expect((await controlRequest(controlSocketPath, 'GET', '/v1/status')).payload).toMatchObject({
      auto_attach_workspace_ids: [workspace.workspace_id],
    });

    await controlRequest(
      controlSocketPath,
      'DELETE',
      `/v1/workspaces/${workspace.workspace_id}`,
      undefined,
      { 'x-chatsplice-control-mutation-token': mutationToken },
    );
    expect((await controlRequest(controlSocketPath, 'GET', '/v1/status')).payload).toMatchObject({
      auto_attach_workspace_ids: [],
    });
  });

  it('rejects the retired synchronous apply endpoint even with owner authority', async () => {
    const root = join(temporaryDirectory, 'local-apply-workspace');
    await mkdir(root);
    await writeFile(join(root, 'README.md'), '# before\n', 'utf8');
    const workspace = WorkspaceSummarySchema.parse(
      (await controlRequest(controlSocketPath, 'POST', '/v1/workspaces', { root_path: root }))
        .payload,
    );
    const mutationToken = (
      await readFile(join(temporaryDirectory, 'data', 'run', 'control-mutation-token'), 'utf8')
    ).trim();
    const payload = {
      format: 'chatsplice.apply.v1',
      workspace_id: workspace.workspace_id,
      operations: [
        {
          tool: 'fs.edit',
          path: 'README.md',
          expected_sha256: createHash('sha256').update('# before\n').digest('hex'),
          edits: [{ old_text: '# before', new_text: '# after', replace_all: false }],
        },
      ],
      checks: [],
    };

    const rejected = await controlRequest(controlSocketPath, 'POST', '/v1/local-apply', payload);
    expect(rejected.status).toBe(404);
    const ownerRejected = await controlRequest(
      controlSocketPath,
      'POST',
      '/v1/local-apply',
      payload,
      {
        'x-chatsplice-control-mutation-token': mutationToken,
      },
    );
    expect(ownerRejected.status).toBe(404);
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('# before\n');
  });

  it('prepares a Pro apply proposal without mutating until the desktop control path claims it', async () => {
    const root = join(temporaryDirectory, 'local-apply-proposal-workspace');
    await mkdir(root);
    await writeFile(join(root, 'README.md'), '# before\n', 'utf8');
    const workspace = WorkspaceSummarySchema.parse(
      (await controlRequest(controlSocketPath, 'POST', '/v1/workspaces', { root_path: root }))
        .payload,
    );
    const binding = bindingFromText(
      ProjectBindingResultSchema.parse(
        (
          await controlRequest(controlSocketPath, 'POST', '/v1/project-binding', {
            workspace_id: workspace.workspace_id,
          })
        ).payload,
      ).binding_text,
    );
    const mutationToken = (
      await readFile(join(temporaryDirectory, 'data', 'run', 'control-mutation-token'), 'utf8')
    ).trim();
    const transport = new StreamableHTTPClientTransport(new URL(runtime.mcpUrl), {
      requestInit: { headers: { 'x-chatsplice-token': runtime.mcpToken } },
    });
    const client = new Client({ name: 'chatsplice-apply-proposal-test', version: '0.0.1' });
    await client.connect(transport);
    try {
      const proposalResult = await client.callTool({
        name: 'local.prepare_apply',
        arguments: {
          format: 'chatsplice.apply.v1',
          workspace_id: workspace.workspace_id,
          workspace_binding: binding,
          operations: [
            {
              tool: 'fs.edit',
              path: 'README.md',
              expected_sha256: createHash('sha256').update('# before\n').digest('hex'),
              edits: [{ old_text: '# before', new_text: '# after', replace_all: false }],
            },
          ],
          checks: [],
        },
      });
      expect(proposalResult.isError).not.toBe(true);
      expect(proposalResult.structuredContent).toMatchObject({
        workspace_id: workspace.workspace_id,
        state: 'pending_apply',
      });
      expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('# before\n');

      const listed = await controlRequest(controlSocketPath, 'GET', '/v1/local-apply-proposals');
      const proposalId = (listed.payload as { proposals: Array<{ proposal_id: string }> })
        .proposals[0]?.proposal_id;
      expect(proposalId).toBeDefined();
      const headers = { 'x-chatsplice-control-mutation-token': mutationToken };
      const denied = await controlRequest(
        controlSocketPath,
        'POST',
        `/v1/local-apply-proposals/${proposalId}/claim`,
        {},
      );
      expect(denied.status).toBe(403);
      const claimed = await controlRequest(
        controlSocketPath,
        'POST',
        `/v1/local-apply-proposals/${proposalId}/claim`,
        {},
        headers,
      );
      const claim = claimed.payload as { claim_id: string };
      const applied = await controlRequest(
        controlSocketPath,
        'POST',
        `/v1/local-apply-claims/${claim.claim_id}/execute`,
        {},
        headers,
      );
      expect(applied.status).toBe(202);
      const retry = await controlRequest(
        controlSocketPath,
        'POST',
        `/v1/local-apply-claims/${claim.claim_id}/execute`,
        {},
        headers,
      );
      expect(retry.status).toBe(202);

      const terminal = await client.callTool({
        name: 'local.await_apply',
        arguments: {
          workspace_id: workspace.workspace_id,
          workspace_binding: binding,
          proposal_id: proposalId,
          timeout_ms: 30_000,
        },
      });
      expect(terminal.structuredContent).toMatchObject({
        proposal_id: proposalId,
        state: 'succeeded',
        result: { changed_paths: ['README.md'] },
      });
      expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('# after\n');
    } finally {
      await client.close();
    }
  });

  it('records Local MCP discovery and reads without storing the search text or file content', async () => {
    const root = join(temporaryDirectory, 'direct-read-activity-workspace');
    await mkdir(root);
    await writeFile(join(root, 'README.md'), '# ChatSplice activity\n', 'utf8');
    const workspace = WorkspaceSummarySchema.parse(
      (await controlRequest(controlSocketPath, 'POST', '/v1/workspaces', { root_path: root }))
        .payload,
    );
    const binding = ProjectBindingResultSchema.parse(
      (
        await controlRequest(controlSocketPath, 'POST', '/v1/project-binding', {
          workspace_id: workspace.workspace_id,
        })
      ).payload,
    );
    const transport = new StreamableHTTPClientTransport(new URL(runtime.mcpUrl), {
      requestInit: { headers: { 'x-chatsplice-token': runtime.mcpToken } },
    });
    const client = new Client({ name: 'chatsplice-read-activity-test', version: '0.0.1' });
    await client.connect(transport);
    try {
      const workspaceBinding = bindingFromText(binding.binding_text);
      await client.callTool({
        name: 'fs.list',
        arguments: { workspace_id: workspace.workspace_id, workspace_binding: workspaceBinding },
      });
      await client.callTool({
        name: 'fs.search',
        arguments: {
          workspace_id: workspace.workspace_id,
          workspace_binding: workspaceBinding,
          query: 'ChatSplice activity',
        },
      });
      await client.callTool({
        name: 'fs.read',
        arguments: {
          workspace_id: workspace.workspace_id,
          workspace_binding: workspaceBinding,
          path: 'README.md',
        },
      });

      const status = await controlRequest(controlSocketPath, 'GET', '/v1/status');
      const activities = (status.payload as { latest_mcp_activities: unknown[] })
        .latest_mcp_activities;
      expect(activities).toMatchObject([
        {
          workspace_id: workspace.workspace_id,
          tool: 'fs.read',
          paths: ['README.md'],
          summary: '파일 읽음',
          state: 'succeeded',
        },
        {
          workspace_id: workspace.workspace_id,
          tool: 'fs.search',
          paths: ['.'],
          summary: '1개 위치 찾음',
          state: 'succeeded',
        },
        {
          workspace_id: workspace.workspace_id,
          tool: 'fs.list',
          paths: ['.'],
          summary: '1개 경로 확인',
          state: 'succeeded',
        },
      ]);
      expect(JSON.stringify(activities)).not.toContain('ChatSplice activity');
    } finally {
      await client.close();
    }
  });

  it('allows only an explicitly linked project to be searched and read through read-only reference tools', async () => {
    const sourceRoot = join(temporaryDirectory, 'reference-source-workspace');
    const targetRoot = join(temporaryDirectory, 'reference-target-workspace');
    await mkdir(sourceRoot);
    await mkdir(targetRoot);
    await writeFile(
      join(targetRoot, 'shared-contract.md'),
      '# Shared contract\nreference-only value\n',
      'utf8',
    );
    const source = WorkspaceSummarySchema.parse(
      (await controlRequest(controlSocketPath, 'POST', '/v1/workspaces', { root_path: sourceRoot }))
        .payload,
    );
    const target = WorkspaceSummarySchema.parse(
      (await controlRequest(controlSocketPath, 'POST', '/v1/workspaces', { root_path: targetRoot }))
        .payload,
    );
    const sourceBinding = bindingFromText(
      ProjectBindingResultSchema.parse(
        (
          await controlRequest(controlSocketPath, 'POST', '/v1/project-binding', {
            workspace_id: source.workspace_id,
          })
        ).payload,
      ).binding_text,
    );
    const mutationToken = (
      await readFile(join(temporaryDirectory, 'data', 'run', 'control-mutation-token'), 'utf8')
    ).trim();
    const transport = new StreamableHTTPClientTransport(new URL(runtime.mcpUrl), {
      requestInit: { headers: { 'x-chatsplice-token': runtime.mcpToken } },
    });
    const client = new Client({ name: 'chatsplice-reference-test', version: '0.0.1' });
    await client.connect(transport);
    try {
      const beforeLink = await client.callTool({
        name: 'fs.reference_list',
        arguments: {
          workspace_id: source.workspace_id,
          workspace_binding: sourceBinding,
        },
      });
      expect(beforeLink.isError).not.toBe(true);
      expect(beforeLink.structuredContent).toMatchObject({ references: [], count: 0 });

      const rejected = await client.callTool({
        name: 'fs.reference_read',
        arguments: {
          workspace_id: source.workspace_id,
          workspace_binding: sourceBinding,
          reference_workspace_id: target.workspace_id,
          path: 'shared-contract.md',
        },
      });
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected.content)).toContain('REFERENCE_NOT_ALLOWED');

      const created = await controlRequest(
        controlSocketPath,
        'PUT',
        '/v1/workspace-references',
        {
          source_workspace_id: source.workspace_id,
          reference_workspace_id: target.workspace_id,
        },
        { 'x-chatsplice-control-mutation-token': mutationToken },
      );
      expect(created.status).toBe(200);
      expect(JSON.stringify(created.payload)).not.toContain(targetRoot);

      const references = await client.callTool({
        name: 'fs.reference_list',
        arguments: {
          workspace_id: source.workspace_id,
          workspace_binding: sourceBinding,
        },
      });
      expect(references.isError).not.toBe(true);
      expect(references.structuredContent).toMatchObject({
        source_workspace_id: source.workspace_id,
        references: [{ workspace_id: target.workspace_id, workspace_name: target.display_name }],
      });
      expect(JSON.stringify(references.structuredContent)).not.toContain('workspace_binding');
      expect(JSON.stringify(references.structuredContent)).not.toContain(targetRoot);

      const paths = await client.callTool({
        name: 'fs.reference_paths',
        arguments: {
          workspace_id: source.workspace_id,
          workspace_binding: sourceBinding,
          reference_workspace_id: target.workspace_id,
        },
      });
      expect(paths.isError).not.toBe(true);
      expect(paths.structuredContent).toMatchObject({
        workspace_id: target.workspace_id,
        source_workspace_id: source.workspace_id,
      });
      expect(JSON.stringify(paths.structuredContent)).toContain('shared-contract.md');

      const search = await client.callTool({
        name: 'fs.reference_search',
        arguments: {
          workspace_id: source.workspace_id,
          workspace_binding: sourceBinding,
          reference_workspace_id: target.workspace_id,
          query: 'reference-only value',
        },
      });
      expect(search.isError).not.toBe(true);
      expect(search.structuredContent).toMatchObject({
        workspace_id: target.workspace_id,
        source_workspace_id: source.workspace_id,
        count: 1,
      });

      const read = await client.callTool({
        name: 'fs.reference_read',
        arguments: {
          workspace_id: source.workspace_id,
          workspace_binding: sourceBinding,
          reference_workspace_id: target.workspace_id,
          path: 'shared-contract.md',
        },
      });
      expect(read.isError).not.toBe(true);
      expect(read.structuredContent).toMatchObject({
        workspace_id: target.workspace_id,
        source_workspace_id: source.workspace_id,
        path: 'shared-contract.md',
      });
      expect(JSON.stringify(read.structuredContent)).toContain('reference-only value');

      const status = await controlRequest(controlSocketPath, 'GET', '/v1/status');
      expect(status.payload).toMatchObject({
        latest_mcp_activities: expect.arrayContaining([
          expect.objectContaining({
            workspace_id: source.workspace_id,
            tool: 'fs.reference_read',
            paths: [`${target.display_name}: shared-contract.md`],
            state: 'succeeded',
          }),
        ]),
      });
      expect(
        JSON.stringify(
          (status.payload as { latest_mcp_activities: unknown[] }).latest_mcp_activities,
        ),
      ).not.toContain('reference-only value');
    } finally {
      await client.close();
    }
  });

  it('turns an approved ad-hoc fs.reference_request into a usable reference without registering a project', async () => {
    const sourceRoot = join(temporaryDirectory, 'reference-request-source');
    const adHocRoot = join(temporaryDirectory, 'reference-request-adhoc');
    await mkdir(sourceRoot);
    await mkdir(adHocRoot);
    await writeFile(join(adHocRoot, 'notes.md'), 'ad-hoc reference value\n', 'utf8');
    const source = WorkspaceSummarySchema.parse(
      (await controlRequest(controlSocketPath, 'POST', '/v1/workspaces', { root_path: sourceRoot }))
        .payload,
    );
    const sourceBinding = bindingFromText(
      ProjectBindingResultSchema.parse(
        (
          await controlRequest(controlSocketPath, 'POST', '/v1/project-binding', {
            workspace_id: source.workspace_id,
          })
        ).payload,
      ).binding_text,
    );
    const mutationToken = (
      await readFile(join(temporaryDirectory, 'data', 'run', 'control-mutation-token'), 'utf8')
    ).trim();
    const transport = new StreamableHTTPClientTransport(new URL(runtime.mcpUrl), {
      requestInit: { headers: { 'x-chatsplice-token': runtime.mcpToken } },
    });
    const client = new Client({ name: 'chatsplice-reference-request-test', version: '0.0.1' });
    await client.connect(transport);
    try {
      const requested = await client.callTool({
        name: 'fs.reference_request',
        arguments: {
          workspace_id: source.workspace_id,
          workspace_binding: sourceBinding,
          path: adHocRoot,
          label: 'ad-hoc reference test',
        },
      });
      expect(requested.isError).not.toBe(true);
      const requestId = (requested.structuredContent as { request_id: string }).request_id;
      expect((requested.structuredContent as { state: string }).state).toBe('pending_approval');

      const pendingList = await controlRequest(controlSocketPath, 'GET', '/v1/reference-requests');
      expect(pendingList.payload).toMatchObject({
        requests: [expect.objectContaining({ request_id: requestId, path: adHocRoot })],
      });

      const unauthorizedDecision = await controlRequest(
        controlSocketPath,
        'POST',
        '/v1/reference-requests/decision',
        { request_id: requestId, approved: true },
      );
      expect(unauthorizedDecision.status).toBe(403);

      const decided = await controlRequest(
        controlSocketPath,
        'POST',
        '/v1/reference-requests/decision',
        { request_id: requestId, approved: true },
        { 'x-chatsplice-control-mutation-token': mutationToken },
      );
      expect(decided.status).toBe(200);
      expect(decided.payload).toMatchObject({ state: 'approved', request_id: requestId });
      const referenceWorkspaceId = (decided.payload as { reference_workspace_id: string })
        .reference_workspace_id;
      expect(referenceWorkspaceId).toBeTruthy();

      const awaited = await client.callTool({
        name: 'fs.reference_request_await',
        arguments: {
          workspace_id: source.workspace_id,
          workspace_binding: sourceBinding,
          request_id: requestId,
        },
      });
      expect(awaited.structuredContent).toMatchObject({
        state: 'approved',
        reference_workspace_id: referenceWorkspaceId,
      });

      const listed = await controlRequest(controlSocketPath, 'GET', '/v1/workspaces');
      expect(listed.payload).toMatchObject({
        workspaces: expect.arrayContaining([
          expect.objectContaining({ workspace_id: referenceWorkspaceId, kind: 'reference' }),
        ]),
      });
      expect(listed.payload).not.toMatchObject({
        workspaces: expect.arrayContaining([
          expect.objectContaining({ workspace_id: referenceWorkspaceId, kind: 'user' }),
        ]),
      });

      const references = await client.callTool({
        name: 'fs.reference_list',
        arguments: { workspace_id: source.workspace_id, workspace_binding: sourceBinding },
      });
      expect(references.structuredContent).toMatchObject({
        references: [expect.objectContaining({ workspace_id: referenceWorkspaceId })],
      });

      const read = await client.callTool({
        name: 'fs.reference_read',
        arguments: {
          workspace_id: source.workspace_id,
          workspace_binding: sourceBinding,
          reference_workspace_id: referenceWorkspaceId,
          path: 'notes.md',
        },
      });
      expect(read.isError).not.toBe(true);
      expect(JSON.stringify(read.structuredContent)).toContain('ad-hoc reference value');
    } finally {
      await client.close();
    }
  });

  it('lets the owner deny an ad-hoc fs.reference_request and never grants access', async () => {
    const sourceRoot = join(temporaryDirectory, 'reference-deny-source');
    const deniedRoot = join(temporaryDirectory, 'reference-deny-target');
    await mkdir(sourceRoot);
    await mkdir(deniedRoot);
    const source = WorkspaceSummarySchema.parse(
      (await controlRequest(controlSocketPath, 'POST', '/v1/workspaces', { root_path: sourceRoot }))
        .payload,
    );
    const sourceBinding = bindingFromText(
      ProjectBindingResultSchema.parse(
        (
          await controlRequest(controlSocketPath, 'POST', '/v1/project-binding', {
            workspace_id: source.workspace_id,
          })
        ).payload,
      ).binding_text,
    );
    const mutationToken = (
      await readFile(join(temporaryDirectory, 'data', 'run', 'control-mutation-token'), 'utf8')
    ).trim();
    const transport = new StreamableHTTPClientTransport(new URL(runtime.mcpUrl), {
      requestInit: { headers: { 'x-chatsplice-token': runtime.mcpToken } },
    });
    const client = new Client({ name: 'chatsplice-reference-deny-test', version: '0.0.1' });
    await client.connect(transport);
    try {
      const requested = await client.callTool({
        name: 'fs.reference_request',
        arguments: {
          workspace_id: source.workspace_id,
          workspace_binding: sourceBinding,
          path: deniedRoot,
        },
      });
      const requestId = (requested.structuredContent as { request_id: string }).request_id;

      const decided = await controlRequest(
        controlSocketPath,
        'POST',
        '/v1/reference-requests/decision',
        { request_id: requestId, approved: false },
        { 'x-chatsplice-control-mutation-token': mutationToken },
      );
      expect(decided.status).toBe(200);
      expect(decided.payload).toMatchObject({
        state: 'denied',
        reference_workspace_id: null,
      });

      const references = await client.callTool({
        name: 'fs.reference_list',
        arguments: { workspace_id: source.workspace_id, workspace_binding: sourceBinding },
      });
      expect(references.structuredContent).toMatchObject({ references: [], count: 0 });
    } finally {
      await client.close();
    }
  });

  it('blocks fs.reference_request while owner read-only mode is on', async () => {
    const root = join(temporaryDirectory, 'reference-request-read-only');
    await mkdir(root);
    const workspace = WorkspaceSummarySchema.parse(
      (await controlRequest(controlSocketPath, 'POST', '/v1/workspaces', { root_path: root }))
        .payload,
    );
    const binding = bindingFromText(
      ProjectBindingResultSchema.parse(
        (
          await controlRequest(controlSocketPath, 'POST', '/v1/project-binding', {
            workspace_id: workspace.workspace_id,
          })
        ).payload,
      ).binding_text,
    );
    const mutationToken = (
      await readFile(join(temporaryDirectory, 'data', 'run', 'control-mutation-token'), 'utf8')
    ).trim();
    await controlRequest(
      controlSocketPath,
      'PUT',
      '/v1/read-only-mode',
      { enabled: true },
      { 'x-chatsplice-control-mutation-token': mutationToken },
    );
    const transport = new StreamableHTTPClientTransport(new URL(runtime.mcpUrl), {
      requestInit: { headers: { 'x-chatsplice-token': runtime.mcpToken } },
    });
    const client = new Client({ name: 'chatsplice-reference-request-ro-test', version: '0.0.1' });
    await client.connect(transport);
    try {
      const blocked = await client.callTool({
        name: 'fs.reference_request',
        arguments: {
          workspace_id: workspace.workspace_id,
          workspace_binding: binding,
          path: root,
        },
      });
      expect(blocked.isError).toBe(true);
      expect((blocked.content as Array<{ text: string }>)[0]?.text).toContain(
        'READ_ONLY_MODE_ENABLED',
      );
    } finally {
      await client.close();
    }
  });

  it('lets bound Chat use direct MCP file lifecycle tools without Codex or Pi', async () => {
    const root = join(temporaryDirectory, 'direct-lifecycle-workspace');
    await mkdir(root);
    const workspace = WorkspaceSummarySchema.parse(
      (await controlRequest(controlSocketPath, 'POST', '/v1/workspaces', { root_path: root }))
        .payload,
    );
    const binding = ProjectBindingResultSchema.parse(
      (
        await controlRequest(controlSocketPath, 'POST', '/v1/project-binding', {
          workspace_id: workspace.workspace_id,
        })
      ).payload,
    );
    const workspaceBinding = bindingFromText(binding.binding_text);
    const transport = new StreamableHTTPClientTransport(new URL(runtime.mcpUrl), {
      requestInit: { headers: { 'x-chatsplice-token': runtime.mcpToken } },
    });
    const client = new Client({ name: 'chatsplice-direct-lifecycle-test', version: '0.0.1' });
    await client.connect(transport);
    try {
      expect(
        (
          await client.callTool({
            name: 'fs.mkdir',
            arguments: {
              workspace_id: workspace.workspace_id,
              workspace_binding: workspaceBinding,
              path: 'src',
            },
          })
        ).isError,
      ).not.toBe(true);
      expect(
        (
          await client.callTool({
            name: 'fs.write',
            arguments: {
              workspace_id: workspace.workspace_id,
              workspace_binding: workspaceBinding,
              path: 'src/first.ts',
              mode: 'create',
              content: 'export const value = 1;\n',
            },
          })
        ).isError,
      ).not.toBe(true);
      const read = await client.callTool({
        name: 'fs.read',
        arguments: {
          workspace_id: workspace.workspace_id,
          workspace_binding: workspaceBinding,
          path: 'src/first.ts',
        },
      });
      const renamed = await client.callTool({
        name: 'fs.rename',
        arguments: {
          workspace_id: workspace.workspace_id,
          workspace_binding: workspaceBinding,
          source_path: 'src/first.ts',
          destination_path: 'src/final.ts',
          expected_sha256: (read.structuredContent as { sha256: string }).sha256,
        },
      });
      expect(renamed.isError).not.toBe(true);
      const renamedRead = await client.callTool({
        name: 'fs.read',
        arguments: {
          workspace_id: workspace.workspace_id,
          workspace_binding: workspaceBinding,
          path: 'src/final.ts',
        },
      });
      const deleted = await client.callTool({
        name: 'fs.delete',
        arguments: {
          workspace_id: workspace.workspace_id,
          workspace_binding: workspaceBinding,
          path: 'src/final.ts',
          expected_sha256: (renamedRead.structuredContent as { sha256: string }).sha256,
        },
      });
      expect(deleted.isError).not.toBe(true);
      await expect(readFile(join(root, 'src', 'final.ts'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect((await controlRequest(controlSocketPath, 'GET', '/v1/status')).payload).toMatchObject({
        latest_mcp_activities: expect.arrayContaining([
          expect.objectContaining({
            workspace_id: workspace.workspace_id,
            tool: 'fs.delete',
            paths: ['src/final.ts'],
            state: 'succeeded',
          }),
        ]),
      });
    } finally {
      await client.close();
    }
  });

  it('lets bound Chat run an allowlisted project check without a worker handoff', async () => {
    if (process.platform !== 'darwin') return;
    const root = join(temporaryDirectory, 'direct-project-run-workspace');
    await mkdir(root);
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager: 'npm@10.0.0',
        scripts: { check: 'node -e "console.log(\'mcp-check-passed\')"' },
      }),
      'utf8',
    );
    const workspace = WorkspaceSummarySchema.parse(
      (await controlRequest(controlSocketPath, 'POST', '/v1/workspaces', { root_path: root }))
        .payload,
    );
    const binding = ProjectBindingResultSchema.parse(
      (
        await controlRequest(controlSocketPath, 'POST', '/v1/project-binding', {
          workspace_id: workspace.workspace_id,
        })
      ).payload,
    );
    const transport = new StreamableHTTPClientTransport(new URL(runtime.mcpUrl), {
      requestInit: { headers: { 'x-chatsplice-token': runtime.mcpToken } },
    });
    const client = new Client({ name: 'chatsplice-direct-project-run-test', version: '0.0.1' });
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: 'project.run',
        arguments: {
          workspace_id: workspace.workspace_id,
          workspace_binding: bindingFromText(binding.binding_text),
          task: 'check',
          timeout_ms: 10_000,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        workspace_id: workspace.workspace_id,
        task: 'check',
        exit_code: 0,
        timed_out: false,
      });
      expect((result.structuredContent as { stdout: string }).stdout).toContain('mcp-check-passed');
      expect((await controlRequest(controlSocketPath, 'GET', '/v1/status')).payload).toMatchObject({
        latest_mcp_activities: [
          {
            workspace_id: workspace.workspace_id,
            tool: 'project.run',
            paths: ['package.json'],
            summary: 'check 통과',
            state: 'succeeded',
          },
        ],
      });
    } finally {
      await client.close();
    }
  });

  it('rejects MCP requests without the local token', async () => {
    const response = await fetch(runtime.mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(response.status).toBe(401);
  });

  it('accepts the legacy MCP auth header during the rename window', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(runtime.mcpUrl), {
      requestInit: { headers: { 'x-localchat-token': runtime.mcpToken } },
    });
    const client = new Client({ name: 'legacy-header-test', version: '0.0.1' });
    await client.connect(transport);
    try {
      expect((await client.listTools()).tools).toHaveLength(22);
    } finally {
      await client.close();
    }
  });

  it('registers a user workspace through the owner-only control socket', async () => {
    const root = join(temporaryDirectory, 'user-workspace');
    await mkdir(root);
    await writeFile(join(root, 'README.md'), '# fixture\n', 'utf8');
    const created = await controlRequest(controlSocketPath, 'POST', '/v1/workspaces', {
      root_path: root,
    });
    const status = await controlRequest(controlSocketPath, 'GET', '/v1/status');

    expect(created.status).toBe(201);
    expect(JSON.stringify(created.payload)).toContain('workspace_id');
    expect(status.status).toBe(200);
    expect(JSON.stringify(status.payload)).toContain(runtime.mcpUrl);
  });

  it('renames only the sidebar label of a registered workspace with owner authority', async () => {
    const root = join(temporaryDirectory, 'rename-workspace');
    await mkdir(root);
    const created = WorkspaceSummarySchema.parse(
      (await controlRequest(controlSocketPath, 'POST', '/v1/workspaces', { root_path: root }))
        .payload,
    );
    const mutationToken = (
      await readFile(join(temporaryDirectory, 'data', 'run', 'control-mutation-token'), 'utf8')
    ).trim();

    const rejected = await controlRequest(controlSocketPath, 'PUT', '/v1/workspaces/name', {
      workspace_id: created.workspace_id,
      display_name: 'Should be refused',
    });
    expect(rejected.status).toBe(403);

    const renamed = await controlRequest(
      controlSocketPath,
      'PUT',
      '/v1/workspaces/name',
      { workspace_id: created.workspace_id, display_name: 'Renamed via control socket' },
      { 'x-chatsplice-control-mutation-token': mutationToken },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.payload).toMatchObject({
      workspace_id: created.workspace_id,
      display_name: 'Renamed via control socket',
    });

    const listed = await controlRequest(controlSocketPath, 'GET', '/v1/workspaces');
    expect(listed.payload).toMatchObject({
      workspaces: expect.arrayContaining([
        expect.objectContaining({
          workspace_id: created.workspace_id,
          display_name: 'Renamed via control socket',
          root_path: await realpath(root),
        }),
      ]),
    });
  });

  it('repoints a registered project at a new local folder with owner authority', async () => {
    const oldRoot = join(temporaryDirectory, 'root-path-old');
    const newRoot = join(temporaryDirectory, 'root-path-new');
    await mkdir(oldRoot);
    await mkdir(newRoot);
    const created = WorkspaceSummarySchema.parse(
      (await controlRequest(controlSocketPath, 'POST', '/v1/workspaces', { root_path: oldRoot }))
        .payload,
    );
    const mutationToken = (
      await readFile(join(temporaryDirectory, 'data', 'run', 'control-mutation-token'), 'utf8')
    ).trim();

    const rejected = await controlRequest(controlSocketPath, 'PUT', '/v1/workspaces/root-path', {
      workspace_id: created.workspace_id,
      root_path: newRoot,
    });
    expect(rejected.status).toBe(403);

    const updated = await controlRequest(
      controlSocketPath,
      'PUT',
      '/v1/workspaces/root-path',
      { workspace_id: created.workspace_id, root_path: newRoot },
      { 'x-chatsplice-control-mutation-token': mutationToken },
    );
    expect(updated.status).toBe(200);
    expect(updated.payload).toMatchObject({
      workspace_id: created.workspace_id,
      root_path: await realpath(newRoot),
    });

    const listed = await controlRequest(controlSocketPath, 'GET', '/v1/workspaces');
    expect(listed.payload).toMatchObject({
      workspaces: expect.arrayContaining([
        expect.objectContaining({
          workspace_id: created.workspace_id,
          root_path: await realpath(newRoot),
        }),
      ]),
    });
  });

  it('removes a user workspace registration without deleting its folder', async () => {
    const root = join(temporaryDirectory, 'remove-workspace');
    await mkdir(root);
    const created = WorkspaceSummarySchema.parse(
      (await controlRequest(controlSocketPath, 'POST', '/v1/workspaces', { root_path: root }))
        .payload,
    );

    const removed = await controlRequest(
      controlSocketPath,
      'DELETE',
      `/v1/workspaces/${created.workspace_id}`,
      undefined,
      {
        'x-chatsplice-control-mutation-token': (
          await readFile(join(temporaryDirectory, 'data', 'run', 'control-mutation-token'), 'utf8')
        ).trim(),
      },
    );
    const listed = await controlRequest(controlSocketPath, 'GET', '/v1/workspaces');

    expect(removed.status).toBe(200);
    expect(JSON.stringify(listed.payload)).not.toContain(created.workspace_id);
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it('rejects direct workspace removal without the desktop mutation capability', async () => {
    const root = join(temporaryDirectory, 'protected-workspace');
    await mkdir(root);
    const created = WorkspaceSummarySchema.parse(
      (await controlRequest(controlSocketPath, 'POST', '/v1/workspaces', { root_path: root }))
        .payload,
    );

    const rejected = await controlRequest(
      controlSocketPath,
      'DELETE',
      `/v1/workspaces/${created.workspace_id}`,
    );
    const listed = await controlRequest(controlSocketPath, 'GET', '/v1/workspaces');

    expect(rejected.status).toBe(403);
    expect(JSON.stringify(listed.payload)).toContain(created.workspace_id);
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it('rejects a binding copied for a different workspace', async () => {
    const firstRoot = join(temporaryDirectory, 'first-workspace');
    const secondRoot = join(temporaryDirectory, 'second-workspace');
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    await writeFile(join(firstRoot, 'README.md'), '# first\n', 'utf8');
    await writeFile(join(secondRoot, 'README.md'), '# second\n', 'utf8');

    const first = WorkspaceSummarySchema.parse(
      (await controlRequest(controlSocketPath, 'POST', '/v1/workspaces', { root_path: firstRoot }))
        .payload,
    );
    const second = WorkspaceSummarySchema.parse(
      (await controlRequest(controlSocketPath, 'POST', '/v1/workspaces', { root_path: secondRoot }))
        .payload,
    );
    const firstBindingResult = ProjectBindingResultSchema.parse(
      (
        await controlRequest(controlSocketPath, 'POST', '/v1/project-binding', {
          workspace_id: first.workspace_id,
        })
      ).payload,
    );
    const firstBinding = bindingFromText(firstBindingResult.binding_text);

    const transport = new StreamableHTTPClientTransport(new URL(runtime.mcpUrl), {
      requestInit: { headers: { 'x-chatsplice-token': runtime.mcpToken } },
    });
    const client = new Client({ name: 'chatsplice-cross-project-test', version: '0.0.1' });
    await client.connect(transport);
    try {
      const read = await client.callTool({
        name: 'fs.read',
        arguments: {
          workspace_id: second.workspace_id,
          workspace_binding: firstBinding,
          path: 'README.md',
        },
      });
      expect(read.isError).toBe(true);
      expect(JSON.stringify(read.content)).toContain('WORKSPACE_BINDING_REQUIRED');
      expect(JSON.stringify(read.structuredContent ?? null)).not.toContain('# second');
    } finally {
      await client.close();
    }
  });

  it('runs project.exec through the shared runtime with binding, read-only, idempotency, and cancel guards', async () => {
    const root = join(temporaryDirectory, 'execution-workspace');
    await mkdir(root);
    const workspace = WorkspaceSummarySchema.parse(
      (await controlRequest(controlSocketPath, 'POST', '/v1/workspaces', { root_path: root }))
        .payload,
    );
    const bindingResult = ProjectBindingResultSchema.parse(
      (
        await controlRequest(controlSocketPath, 'POST', '/v1/project-binding', {
          workspace_id: workspace.workspace_id,
        })
      ).payload,
    );
    const workspaceBinding = bindingFromText(bindingResult.binding_text);
    const mutationToken = (
      await readFile(join(temporaryDirectory, 'data', 'run', 'control-mutation-token'), 'utf8')
    ).trim();
    const transport = new StreamableHTTPClientTransport(new URL(runtime.mcpUrl), {
      requestInit: { headers: { 'x-chatsplice-token': runtime.mcpToken } },
    });
    const client = new Client({ name: 'chatsplice-project-exec-test', version: '0.0.1' });
    await client.connect(transport);
    try {
      const wrongBinding = await client.callTool({
        name: 'project.exec',
        arguments: {
          workspace_id: workspace.workspace_id,
          workspace_binding: `wb_${'1'.repeat(64)}`,
          request_id: 'runtime-binding-1',
          cwd: '.',
          operation: { kind: 'cargo', task: 'check' },
          timeout_ms: 5_000,
        },
      });
      expect(wrongBinding.isError).toBe(true);
      expect(JSON.stringify(wrongBinding.content)).toContain('WORKSPACE_BINDING_REQUIRED');

      expect(
        (
          await controlRequest(
            controlSocketPath,
            'PUT',
            '/v1/read-only-mode',
            { enabled: true },
            { 'x-chatsplice-control-mutation-token': mutationToken },
          )
        ).status,
      ).toBe(200);
      const readOnly = await client.callTool({
        name: 'project.exec',
        arguments: {
          workspace_id: workspace.workspace_id,
          workspace_binding: workspaceBinding,
          request_id: 'runtime-readonly-1',
          cwd: '.',
          operation: { kind: 'cargo', task: 'check' },
          timeout_ms: 5_000,
        },
      });
      expect(readOnly.isError).toBe(true);
      expect(JSON.stringify(readOnly.content)).toContain('READ_ONLY_MODE_ENABLED');
      await controlRequest(
        controlSocketPath,
        'PUT',
        '/v1/read-only-mode',
        { enabled: false },
        { 'x-chatsplice-control-mutation-token': mutationToken },
      );

      const arguments_ = {
        workspace_id: workspace.workspace_id,
        workspace_binding: workspaceBinding,
        request_id: 'runtime-idempotent-1',
        cwd: '.',
        operation: { kind: 'cargo', task: 'check' },
        timeout_ms: 5_000,
      };
      const first = await client.callTool({ name: 'project.exec', arguments: arguments_ });
      const firstJobId = (first.structuredContent as { job_id: string }).job_id;
      const retry = await client.callTool({ name: 'project.exec', arguments: arguments_ });
      expect((retry.structuredContent as { job_id: string }).job_id).toBe(firstJobId);
      expect(executionCalls).toBe(1);
      const changedRequest = await client.callTool({
        name: 'project.exec',
        arguments: { ...arguments_, operation: { kind: 'cargo', task: 'test' } },
      });
      expect(changedRequest.isError).toBe(true);
      expect(JSON.stringify(changedRequest.content)).toContain('request_id is already associated');

      await controlRequest(
        controlSocketPath,
        'PUT',
        '/v1/read-only-mode',
        { enabled: true },
        { 'x-chatsplice-control-mutation-token': mutationToken },
      );

      const cancelling = await client.callTool({
        name: 'project.cancel_exec',
        arguments: {
          workspace_id: workspace.workspace_id,
          workspace_binding: workspaceBinding,
          job_id: firstJobId,
        },
      });
      expect((cancelling.structuredContent as { state: string }).state).toBe('cancelling');
      const finished = await client.callTool({
        name: 'project.await_exec',
        arguments: {
          workspace_id: workspace.workspace_id,
          workspace_binding: workspaceBinding,
          job_id: firstJobId,
          timeout_ms: 1_000,
        },
      });
      expect((finished.structuredContent as { state: string }).state).toBe('cancelled');
      expect(JSON.stringify(finished.structuredContent)).not.toContain(
        'fake project execution logs',
      );

      const controlJob = await controlRequest(
        controlSocketPath,
        'GET',
        `/v1/execution-jobs/${firstJobId}?workspace_id=${encodeURIComponent(workspace.workspace_id)}`,
      );
      expect(controlJob.status).toBe(200);
      expect(controlJob.payload).toMatchObject({
        job_id: firstJobId,
        workspace_id: workspace.workspace_id,
        state: 'cancelled',
      });
      expect((await controlRequest(controlSocketPath, 'GET', '/v1/status')).payload).toMatchObject({
        execution_jobs: expect.arrayContaining([
          expect.objectContaining({ job_id: firstJobId, state: 'cancelled' }),
        ]),
      });
    } finally {
      await client.close();
    }
  });

  it('guards owner file browsing and execution without exposing the workspace binding', async () => {
    const root = join(temporaryDirectory, 'owner-workspace');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'note.txt'), 'owner preview');
    const fullEditorContent = 'line\n'.repeat(20_000);
    await writeFile(join(root, 'src', 'full.md'), fullEditorContent, 'utf8');
    const escapedEditorContent = '\u0001'.repeat(1024 * 1024);
    await writeFile(join(root, 'control-boundary.txt'), escapedEditorContent, 'utf8');
    await writeFile(join(root, '.env'), 'DO_NOT_EXPOSE=private');
    await writeFile(join(temporaryDirectory, 'outside.txt'), 'outside');
    await symlink(join(temporaryDirectory, 'outside.txt'), join(root, 'escape.txt'));
    const workspace = WorkspaceSummarySchema.parse(
      (await controlRequest(controlSocketPath, 'POST', '/v1/workspaces', { root_path: root }))
        .payload,
    );
    const token = (
      await readFile(join(temporaryDirectory, 'data', 'run', 'control-mutation-token'), 'utf8')
    ).trim();
    const headers = { 'x-chatsplice-control-mutation-token': token };
    const scope = { workspace_id: workspace.workspace_id };
    const submit = {
      ...scope,
      request_id: 'owner-control-execution-1',
      operation: { kind: 'cargo', task: 'check' },
    };
    for (const [path, body] of [
      ['/v1/workspace-files/list', scope],
      ['/v1/workspace-files/read', { ...scope, path: 'src/note.txt' }],
      ['/v1/workspace-editor/read', { ...scope, path: 'src/full.md' }],
      [
        '/v1/workspace-editor/save',
        { ...scope, path: 'src/full.md', expected_sha256: '0'.repeat(64), content: 'blocked' },
      ],
      ['/v1/execution-jobs', submit],
    ] as const) {
      expect((await controlRequest(controlSocketPath, 'POST', path, body)).status).toBe(403);
    }
    const ownerPost = (path: string, body: unknown) =>
      controlRequest(controlSocketPath, 'POST', path, body, headers);
    const listing = await ownerPost('/v1/workspace-files/list', { ...scope, path: '.' });
    expect(listing.status).toBe(200);
    expect(listing.payload).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ path: 'src', type: 'directory' }),
      ]),
    });
    expect(JSON.stringify(listing.payload)).not.toContain('.env');
    expect(JSON.stringify(listing.payload)).not.toContain('src/note.txt');
    expect(JSON.stringify(listing.payload)).not.toContain('workspace_binding');
    const nested = await ownerPost('/v1/workspace-files/list', { ...scope, path: 'src' });
    expect(nested.payload).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ path: 'src/note.txt', type: 'file' }),
      ]),
    });
    expect(
      (await ownerPost('/v1/workspace-files/read', { ...scope, path: 'src/note.txt' })).payload,
    ).toMatchObject({ content: 'owner preview', workspace_id: workspace.workspace_id });
    const editorRead = await ownerPost('/v1/workspace-editor/read', {
      ...scope,
      path: 'src/full.md',
    });
    expect(editorRead.status).toBe(200);
    expect(editorRead.payload).toMatchObject({
      workspace_id: workspace.workspace_id,
      path: 'src/full.md',
      content: fullEditorContent,
    });
    const boundarySave = await ownerPost('/v1/workspace-editor/save', {
      ...scope,
      path: 'control-boundary.txt',
      expected_sha256: createHash('sha256').update(escapedEditorContent).digest('hex'),
      content: escapedEditorContent,
    });
    expect(boundarySave.status).toBe(200);
    expect(boundarySave.payload).toMatchObject({
      workspace_id: workspace.workspace_id,
      path: 'control-boundary.txt',
      content: escapedEditorContent,
      sha256: createHash('sha256').update(escapedEditorContent).digest('hex'),
    });
    const editorSha = (editorRead.payload as { sha256: string }).sha256;
    const editedEditorContent = `${fullEditorContent}tail\n`;
    const editorSave = await ownerPost('/v1/workspace-editor/save', {
      ...scope,
      path: 'src/full.md',
      expected_sha256: editorSha,
      content: editedEditorContent,
    });
    expect(editorSave.status).toBe(200);
    expect(editorSave.payload).toMatchObject({
      workspace_id: workspace.workspace_id,
      path: 'src/full.md',
      content: editedEditorContent,
    });
    expect(await readFile(join(root, 'src', 'full.md'), 'utf8')).toBe(editedEditorContent);
    const staleEditorSave = await ownerPost('/v1/workspace-editor/save', {
      ...scope,
      path: 'src/full.md',
      expected_sha256: editorSha,
      content: 'stale editor content',
    });
    expect(staleEditorSave.status).toBe(409);
    expect(staleEditorSave.payload).toEqual({
      error: {
        code: 'BAD_REQUEST',
        message: 'The file changed after the editor read. Read it again and retry.',
      },
    });
    for (const path of ['.env', '../outside.txt', 'escape.txt']) {
      const denied = await ownerPost('/v1/workspace-files/read', { ...scope, path });
      expect(denied.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(denied.payload)).not.toContain('DO_NOT_EXPOSE');
    }
    expect(
      (await ownerPost('/v1/workspace-files/list', { ...scope, recursive: true })).status,
    ).toBeGreaterThanOrEqual(400);
    await controlRequest(
      controlSocketPath,
      'PUT',
      '/v1/read-only-mode',
      { enabled: false },
      headers,
    );
    const submitted = await ownerPost('/v1/execution-jobs', submit);
    expect(submitted.status).toBe(202);
    const job = submitted.payload as { job_id: string };
    expect(job.job_id).toMatch(/^exec_/);
    expect(JSON.stringify(submitted.payload)).not.toContain('workspace_binding');
    expect((await ownerPost('/v1/execution-jobs', submit)).payload).toMatchObject({
      job_id: job.job_id,
    });
    expect(executionCalls).toBe(1);
    await controlRequest(
      controlSocketPath,
      'PUT',
      '/v1/read-only-mode',
      { enabled: true },
      headers,
    );
    expect(
      (await ownerPost('/v1/execution-jobs', { ...submit, request_id: 'owner-readonly-2' })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await ownerPost('/v1/workspace-files/read', { ...scope, path: 'src/note.txt' })).status,
    ).toBe(200);
    const cancelled = await ownerPost(`/v1/execution-jobs/${job.job_id}/cancel`, {
      ...scope,
      job_id: job.job_id,
    });
    expect(cancelled.status).toBe(200);
    await expect
      .poll(() => runtime.status().execution_jobs.find((item) => item.job_id === job.job_id)?.state)
      .toBe('cancelled');
  });

  it('persists only ChatSplice browser tab navigation metadata on the control plane', async () => {
    const timestamp = new Date().toISOString();
    const state = {
      tabs: [
        {
          chatgpt_tab_id: 'tab_0123456789abcdef01234567',
          workspace_id: null,
          project_instructions_confirmed: false,
          label: '일반 대화',
          url: 'https://chatgpt.com/',
          created_at: timestamp,
          updated_at: timestamp,
        },
      ],
      active_tab_id: 'tab_0123456789abcdef01234567',
    };

    const saved = await controlRequest(controlSocketPath, 'PUT', '/v1/chatgpt-tabs', state);
    const restored = await controlRequest(controlSocketPath, 'GET', '/v1/chatgpt-tabs');

    expect(saved.status).toBe(200);
    expect(restored.payload).toEqual(state);
    expect(JSON.stringify(restored.payload)).not.toContain('message');
  });
});
