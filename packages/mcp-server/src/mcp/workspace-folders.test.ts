import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WorkspaceReferenceService } from '@chatsplice/core';
import {
  FsReadResultSchema,
  FsEditResultSchema,
  FsWriteResultSchema,
  FsReferenceListResultSchema,
  ProjectExecJobSchema,
  ProjectExecSummarySchema,
  ReferenceRequestListResultSchema,
  ReferenceRequestStatusSchema,
  WorkspaceReferenceSchema,
  WorkspaceSummarySchema,
} from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startChatSpliceRuntime, type ChatSpliceRuntime } from '../runtime.js';
import { workspaceBindingFor } from '../workspace-binding.js';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

function control(
  socketPath: string,
  method: Method,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; payload: unknown }> {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        socketPath,
        method,
        path,
        headers: {
          ...(token === undefined ? {} : { 'x-chatsplice-control-mutation-token': token }),
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
          try {
            resolve({
              status: response.statusCode ?? 0,
              payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(serialized);
  });
}

describe('shared folder owner and MCP workflow', () => {
  let directory: string;
  let sourceRoot: string;
  let targetRoot: string;
  let socketPath: string;
  let ownerToken: string;
  let runtime: ChatSpliceRuntime;
  let client: Client;
  let source: ReturnType<typeof WorkspaceSummarySchema.parse>;
  let bound: { workspace_id: string; workspace_binding: string };
  let executionInputs: Array<{ workspace_id: string; reference_workspace_id?: string }>;
  let executionGate: Promise<void> | undefined;
  let releaseExecution: (() => void) | undefined;
  let executionStarted: Promise<void>;
  let markExecutionStarted: () => void;
  let fixtureCleanup: {
    directory?: string;
    client?: Client;
    runtime?: ChatSpliceRuntime;
  } = {};

  async function owner(method: Method, path: string, body?: unknown) {
    return control(socketPath, method, path, body, ownerToken);
  }

  async function invoke(name: string, input: Record<string, unknown> = {}) {
    return client.callTool({ name, arguments: { ...bound, ...input } });
  }

  async function success(name: string, input: Record<string, unknown> = {}) {
    const result = await invoke(name, input);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toBeDefined();
    return result.structuredContent;
  }

  async function grant(accessMode: 'read_only' | 'read_write') {
    const response = await owner('POST', '/v1/workspace-reference-folders', {
      source_workspace_id: source.workspace_id,
      root_path: targetRoot,
      access_mode: accessMode,
    });
    expect(response.status, JSON.stringify(response.payload)).toBe(201);
    return WorkspaceReferenceSchema.parse(response.payload);
  }

  async function readTarget(referenceId: string, path = 'README.md') {
    return FsReadResultSchema.parse(
      await success('fs.read', {
        reference_workspace_id: referenceId,
        path,
      }),
    );
  }

  async function terminal(jobId: string) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const job = ProjectExecJobSchema.parse(
        await success('project.await_exec', {
          job_id: jobId,
          timeout_ms: 1000,
        }),
      );
      if (!['queued', 'running', 'cancelling'].includes(job.state)) return job;
    }
    throw new Error('Folder test execution did not settle.');
  }

  beforeEach(async () => {
    fixtureCleanup = {};
    releaseExecution = undefined;
    // Atomic rename uses a hard link; fixtures belong in the job-private runtime.
    directory = await mkdtemp(join(tmpdir(), 'cs-f-'));
    fixtureCleanup.directory = directory;
    sourceRoot = join(directory, 'source');
    targetRoot = join(directory, 'extra');
    socketPath = join(directory, 'control.sock');
    await mkdir(sourceRoot);
    await mkdir(targetRoot);
    await writeFile(join(sourceRoot, 'README.md'), 'source intact\n');
    await writeFile(join(targetRoot, 'README.md'), 'before external\n');
    await writeFile(join(targetRoot, 'delete-me.md'), 'delete this\n');
    executionInputs = [];
    executionGate = undefined;
    releaseExecution = undefined;
    executionStarted = new Promise<void>((resolve) => {
      markExecutionStarted = resolve;
    });
    runtime = await startChatSpliceRuntime({
      dataDirectory: join(directory, 'data'),
      controlSocketPath: socketPath,
      localApplyStartWaitMs: 0,
      executionBackend: async (workspaces, input, options) => {
        executionInputs.push({
          workspace_id: input.workspace_id,
          ...(input.reference_workspace_id === undefined
            ? {}
            : {
                reference_workspace_id: input.reference_workspace_id,
              }),
        });
        const target =
          input.reference_workspace_id === undefined
            ? workspaces.getRecord(input.workspace_id)
            : options.referenceService?.requireTarget(
                input.workspace_id,
                input.reference_workspace_id,
                'read_write',
              );
        if (target === undefined) throw new Error('Missing execution reference service.');
        options.onStart({ command: 'fixture folder check', used_network: false });
        options.onOutput(await readFile(join(target.rootPath, 'README.md'), 'utf8'));
        markExecutionStarted();
        if (executionGate !== undefined) {
          await Promise.race([
            executionGate,
            new Promise<void>((resolve) => {
              if (options.signal.aborted) resolve();
              else options.signal.addEventListener('abort', () => resolve(), { once: true });
            }),
          ]);
        }
        return { exit_code: 0, duration_ms: 1, timed_out: false };
      },
    });
    fixtureCleanup.runtime = runtime;
    ownerToken = (
      await readFile(join(directory, 'data/run/control-mutation-token'), 'utf8')
    ).trim();
    const registered = await owner('POST', '/v1/workspaces', { root_path: sourceRoot });
    expect(registered.status).toBe(201);
    source = WorkspaceSummarySchema.parse(registered.payload);
    bound = {
      workspace_id: source.workspace_id,
      workspace_binding: workspaceBindingFor(runtime.mcpToken, source.workspace_id),
    };
    client = new Client({ name: 'shared-folders-workflow', version: '1' });
    fixtureCleanup.client = client;
    await client.connect(
      new StreamableHTTPClientTransport(new URL(runtime.mcpUrl), {
        requestInit: { headers: { 'x-chatsplice-token': runtime.mcpToken } },
      }),
    );
  });

  afterEach(async () => {
    try {
      releaseExecution?.();
      await fixtureCleanup.client?.close();
    } finally {
      try {
        await fixtureCleanup.runtime?.close();
      } finally {
        if (fixtureCleanup.directory !== undefined) {
          await rm(fixtureCleanup.directory, { recursive: true, force: true });
        }
      }
    }
  });

  it('requires the private owner capability and rejects an invalid or self source', async () => {
    const input = {
      source_workspace_id: source.workspace_id,
      root_path: targetRoot,
      access_mode: 'read_write',
    };
    expect(
      (await control(socketPath, 'POST', '/v1/workspace-reference-folders', input)).status,
    ).toBe(403);
    expect(
      (
        await control(
          socketPath,
          'POST',
          '/v1/workspace-reference-folders',
          input,
          runtime.mcpToken,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await owner('POST', '/v1/workspace-reference-folders', {
          ...input,
          source_workspace_id: 'ws_ffffffffffffffffffffffff',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await owner('POST', '/v1/workspace-reference-folders', {
          ...input,
          root_path: sourceRoot,
        })
      ).status,
    ).toBe(400);
    expect(FsReferenceListResultSchema.parse(await success('fs.reference_list')).count).toBe(0);
  });

  it('preserves the bound source, legacy result shape and read-only access to a granted folder', async () => {
    const reference = await grant('read_only');
    const targetId = reference.reference_workspace_id;
    const catalog = await client.listTools();
    expect(catalog.tools).toHaveLength(24);
    const listed = FsReferenceListResultSchema.parse(await success('fs.reference_list'));
    expect(listed).toMatchObject({
      source_workspace_id: source.workspace_id,
      references: [
        {
          workspace_id: targetId,
          access_mode: 'read_only',
          root_path: await realpath(targetRoot),
        },
      ],
    });
    const read = await readTarget(targetId);
    expect(read).toMatchObject({
      workspace_id: source.workspace_id,
      workspace_name: source.display_name,
      reference_workspace_id: targetId,
      reference_workspace_name: 'extra',
      content: 'before external',
    });
    expect(await success('fs.list', { reference_workspace_id: targetId, path: '.' })).toMatchObject(
      {
        workspace_id: source.workspace_id,
        reference_workspace_id: targetId,
        entries: expect.arrayContaining([{ path: 'README.md', type: 'file' }]),
      },
    );
    expect(
      await success('fs.search', {
        reference_workspace_id: targetId,
        path: '.',
        query: 'external',
      }),
    ).toMatchObject({
      workspace_id: source.workspace_id,
      reference_workspace_id: targetId,
      count: 1,
    });
    expect(
      await success('fs.reference_read', {
        reference_workspace_id: targetId,
        path: 'README.md',
      }),
    ).toMatchObject({
      source_workspace_id: source.workspace_id,
      workspace_id: targetId,
      workspace_name: 'extra',
      content: 'before external',
    });
    const mutations: Array<[string, Record<string, unknown>]> = [
      [
        'fs.edit',
        {
          path: 'README.md',
          expected_sha256: read.sha256,
          edits: [{ old_text: 'before', new_text: 'after' }],
        },
      ],
      [
        'fs.write',
        { path: 'README.md', mode: 'replace', expected_sha256: read.sha256, content: 'changed\n' },
      ],
      ['fs.mkdir', { path: 'generated' }],
      [
        'fs.rename',
        { source_path: 'README.md', destination_path: 'renamed.md', expected_sha256: read.sha256 },
      ],
      ['fs.delete', { path: 'README.md', expected_sha256: read.sha256 }],
    ];
    for (const [name, input] of mutations) {
      expect((await invoke(name, { ...input, reference_workspace_id: targetId })).isError).toBe(
        true,
      );
    }
    expect(
      (
        await invoke('fs.read', {
          reference_workspace_id: targetId,
          path: 'README.md',
          workspace_binding: workspaceBindingFor(runtime.mcpToken, targetId),
        })
      ).isError,
    ).toBe(true);
    expect(await readFile(join(targetRoot, 'README.md'), 'utf8')).toBe('before external\n');
    expect(FsReadResultSchema.parse(await success('fs.read', { path: 'README.md' })).content).toBe(
      'source intact',
    );
  });

  it('returns bounded search context through both APIs for a read-only linked folder', async () => {
    const reference = await grant('read_only');
    const targetId = reference.reference_workspace_id;
    await writeFile(join(targetRoot, 'context.ts'), 'before\r\nexternal();\r\nafter\r\n');
    const input = {
      reference_workspace_id: targetId,
      path: '.',
      glob: 'context.ts',
      query: 'external',
      context_lines: 1,
    };
    const expectedMatch = {
      path: 'context.ts',
      line_number: 2,
      column: 1,
      line: 'external();',
      context_before: [{ line_number: 1, line: 'before', truncated: false }],
      context_after: [{ line_number: 3, line: 'after', truncated: false }],
    };
    expect(await success('fs.search', input)).toMatchObject({
      workspace_id: source.workspace_id,
      reference_workspace_id: targetId,
      matches: [expectedMatch],
      context_truncated: false,
    });
    expect(await success('fs.reference_search', input)).toMatchObject({
      source_workspace_id: source.workspace_id,
      workspace_id: targetId,
      matches: [expectedMatch],
      context_truncated: false,
    });
    expect((await invoke('fs.search', { ...input, context_lines: 4 })).isError).toBe(true);
    expect((await invoke('fs.reference_search', { ...input, context_lines: 4 })).isError).toBe(
      true,
    );
    const suffix = FsReadResultSchema.parse(
      await success('fs.read', {
        reference_workspace_id: targetId,
        path: 'context.ts',
        start_line: 2,
      }),
    );
    expect(suffix.truncated).toBe(true);
    const partialEdit = await invoke('fs.edit', {
      reference_workspace_id: targetId,
      path: 'context.ts',
      expected_sha256: suffix.sha256,
      edits: [{ old_text: 'external', new_text: 'blocked' }],
    });
    expect(partialEdit.isError).toBe(true);
    expect(await readFile(join(targetRoot, 'context.ts'), 'utf8')).toBe(
      'before\r\nexternal();\r\nafter\r\n',
    );
  });

  it('edits and replaces only a writable target, preserving SHA conflicts and the read-only switch', async () => {
    const reference = await grant('read_write');
    const targetId = reference.reference_workspace_id;
    const before = await readTarget(targetId);
    const edited = FsEditResultSchema.parse(
      await success('fs.edit', {
        reference_workspace_id: targetId,
        path: 'README.md',
        expected_sha256: before.sha256,
        edits: [{ old_text: 'before', new_text: 'after' }],
      }),
    );
    expect(edited).toMatchObject({
      workspace_id: source.workspace_id,
      reference_workspace_id: targetId,
      previous_sha256: before.sha256,
    });
    expect(
      (
        await invoke('fs.edit', {
          reference_workspace_id: targetId,
          path: 'README.md',
          expected_sha256: before.sha256,
          edits: [{ old_text: 'after', new_text: 'stale' }],
        })
      ).isError,
    ).toBe(true);
    const replaced = FsWriteResultSchema.parse(
      await success('fs.write', {
        reference_workspace_id: targetId,
        path: 'README.md',
        mode: 'replace',
        expected_sha256: edited.sha256,
        content: 'replaced external\n',
      }),
    );
    await success('fs.mkdir', { reference_workspace_id: targetId, path: 'generated' });
    expect((await stat(join(targetRoot, 'generated'))).isDirectory()).toBe(true);
    const removed = await readTarget(targetId, 'delete-me.md');
    await success('fs.delete', {
      reference_workspace_id: targetId,
      path: 'delete-me.md',
      expected_sha256: removed.sha256,
    });
    await expect(stat(join(targetRoot, 'delete-me.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await owner('PUT', '/v1/read-only-mode', { enabled: true })).status).toBe(200);
    expect(
      (
        await invoke('fs.edit', {
          reference_workspace_id: targetId,
          path: 'README.md',
          expected_sha256: replaced.sha256,
          edits: [{ old_text: 'replaced', new_text: 'blocked' }],
        })
      ).isError,
    ).toBe(true);
    expect((await readTarget(targetId)).content).toBe('replaced external');
    expect(await readFile(join(sourceRoot, 'README.md'), 'utf8')).toBe('source intact\n');
  });

  it('creates and renames files within the selected writable folder without changing the source', async () => {
    const reference = await grant('read_write');
    const targetId = reference.reference_workspace_id;
    const created = FsWriteResultSchema.parse(
      await success('fs.write', {
        reference_workspace_id: targetId,
        path: 'new.md',
        mode: 'create',
        content: 'new external\n',
      }),
    );
    expect(created.reference_workspace_id).toBe(targetId);
    const read = await readTarget(targetId, 'new.md');
    expect(
      await success('fs.rename', {
        reference_workspace_id: targetId,
        source_path: 'new.md',
        destination_path: 'renamed.md',
        expected_sha256: read.sha256,
      }),
    ).toMatchObject({ workspace_id: source.workspace_id, reference_workspace_id: targetId });
    expect((await readTarget(targetId, 'renamed.md')).content).toBe('new external');
    await expect(stat(join(targetRoot, 'new.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(sourceRoot, 'renamed.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps read and write requests distinct and applies only the mode approved by the owner', async () => {
    const pending = ReferenceRequestStatusSchema.parse(
      await success('fs.reference_request', { path: targetRoot, access_mode: 'read_only' }),
    );
    const duplicate = ReferenceRequestStatusSchema.parse(
      await success('fs.reference_request', {
        path: targetRoot,
        access_mode: 'read_only',
      }),
    );
    const write = ReferenceRequestStatusSchema.parse(
      await success('fs.reference_request', {
        path: targetRoot,
        access_mode: 'read_write',
      }),
    );
    expect(pending.access_mode).toBe('read_only');
    expect(duplicate.request_id).toBe(pending.request_id);
    expect(write.request_id).not.toBe(pending.request_id);
    const ownerRequests = ReferenceRequestListResultSchema.parse(
      (await owner('GET', '/v1/reference-requests')).payload,
    );
    expect(ownerRequests.requests.map((value) => value.access_mode)).toEqual([
      'read_only',
      'read_write',
    ]);
    expect(
      (
        await owner('POST', '/v1/reference-requests/decision', {
          request_id: pending.request_id,
          approved: true,
          access_mode: 'full_access',
        })
      ).status,
    ).toBe(400);
    const approvedRead = await owner('POST', '/v1/reference-requests/decision', {
      request_id: pending.request_id,
      approved: true,
    });
    expect(approvedRead.status).toBe(200);
    const readStatus = ReferenceRequestStatusSchema.parse(approvedRead.payload);
    expect(readStatus.access_mode).toBe('read_only');
    const targetId = readStatus.reference_workspace_id!;
    const before = await readTarget(targetId);
    expect(
      (
        await invoke('fs.edit', {
          reference_workspace_id: targetId,
          path: 'README.md',
          expected_sha256: before.sha256,
          edits: [{ old_text: 'before', new_text: 'unauthorized' }],
        })
      ).isError,
    ).toBe(true);
    const approvedWrite = await owner('POST', '/v1/reference-requests/decision', {
      request_id: write.request_id,
      approved: true,
    });
    expect(approvedWrite.status).toBe(200);
    expect(ReferenceRequestStatusSchema.parse(approvedWrite.payload)).toMatchObject({
      reference_workspace_id: targetId,
      access_mode: 'read_write',
      state: 'approved',
    });
    expect(
      ReferenceRequestStatusSchema.parse(
        await success('fs.reference_request_await', {
          request_id: pending.request_id,
          timeout_ms: 0,
        }),
      ).access_mode,
    ).toBe('read_only');
    await success('fs.edit', {
      reference_workspace_id: targetId,
      path: 'README.md',
      expected_sha256: before.sha256,
      edits: [{ old_text: 'before', new_text: 'approved' }],
    });
    expect(await readFile(join(targetRoot, 'README.md'), 'utf8')).toBe('approved external\n');
  });

  it.each([
    ['read_only', 'read_write'],
    ['read_write', 'read_only'],
  ] as const)(
    'applies owner-selected %s request -> %s access to real filesystem tools',
    async (requestedMode, selectedMode) => {
      const pending = ReferenceRequestStatusSchema.parse(
        await success('fs.reference_request', {
          path: targetRoot,
          access_mode: requestedMode,
        }),
      );
      expect(pending.state).toBe('pending_approval');
      expect(FsReferenceListResultSchema.parse(await success('fs.reference_list')).count).toBe(0);
      const decision = {
        request_id: pending.request_id,
        approved: true,
        access_mode: selectedMode,
      };
      for (const token of [undefined, runtime.mcpToken]) {
        expect(
          (await control(socketPath, 'POST', '/v1/reference-requests/decision', decision, token))
            .status,
        ).toBe(403);
      }
      expect(FsReferenceListResultSchema.parse(await success('fs.reference_list')).count).toBe(0);

      const response = await owner('POST', '/v1/reference-requests/decision', decision);
      expect(response.status, JSON.stringify(response.payload)).toBe(200);
      const approved = ReferenceRequestStatusSchema.parse(response.payload);
      expect(approved).toMatchObject({
        state: 'approved',
        access_mode: selectedMode,
        path: targetRoot,
        workspace_id: source.workspace_id,
      });
      const targetId = approved.reference_workspace_id;
      if (targetId === null) throw new Error('Missing approved reference ID.');
      const awaited = ReferenceRequestStatusSchema.parse(
        await success('fs.reference_request_await', {
          request_id: pending.request_id,
          timeout_ms: 0,
        }),
      );
      expect(awaited.access_mode).toBe(selectedMode);
      expect(
        FsReferenceListResultSchema.parse(await success('fs.reference_list')).references,
      ).toEqual([expect.objectContaining({ workspace_id: targetId, access_mode: selectedMode })]);

      const before = await readTarget(targetId);
      const edit = await invoke('fs.edit', {
        reference_workspace_id: targetId,
        path: 'README.md',
        expected_sha256: before.sha256,
        edits: [{ old_text: 'before external', new_text: 'owner-approved edit' }],
      });
      if (selectedMode === 'read_write') {
        expect(edit.isError, JSON.stringify(edit)).not.toBe(true);
        expect((await readTarget(targetId)).content).toContain('owner-approved edit');
      } else {
        expect(edit.isError).toBe(true);
        expect((await readTarget(targetId)).content).toContain('before external');
      }

      const replay = await owner('POST', '/v1/reference-requests/decision', decision);
      expect(replay.status).toBe(200);
      expect(ReferenceRequestStatusSchema.parse(replay.payload)).toEqual(approved);
      const conflict = await owner('POST', '/v1/reference-requests/decision', {
        ...decision,
        access_mode: selectedMode === 'read_write' ? 'read_only' : 'read_write',
      });
      expect(conflict.status).toBe(400);
      expect(
        FsReferenceListResultSchema.parse(await success('fs.reference_list')).references[0]
          ?.access_mode,
      ).toBe(selectedMode);
    },
  );

  it('keeps an existing grant unchanged when the owner denies a new request', async () => {
    const existing = await grant('read_write');
    const pending = ReferenceRequestStatusSchema.parse(
      await success('fs.reference_request', { path: targetRoot, access_mode: 'read_only' }),
    );
    const invalid = await owner('POST', '/v1/reference-requests/decision', {
      request_id: pending.request_id,
      approved: false,
      access_mode: 'read_only',
    });
    expect(invalid.status).toBe(400);
    expect(
      ReferenceRequestStatusSchema.parse(
        await success('fs.reference_request_await', {
          request_id: pending.request_id,
          timeout_ms: 0,
        }),
      ).state,
    ).toBe('pending_approval');
    const response = await owner('POST', '/v1/reference-requests/decision', {
      request_id: pending.request_id,
      approved: false,
    });
    expect(response.status).toBe(200);
    expect(ReferenceRequestStatusSchema.parse(response.payload)).toMatchObject({
      state: 'denied',
      reference_workspace_id: null,
    });
    expect(
      FsReferenceListResultSchema.parse(await success('fs.reference_list')).references,
    ).toEqual([
      expect.objectContaining({
        workspace_id: existing.reference_workspace_id,
        access_mode: 'read_write',
      }),
    ]);
  });

  it('keeps the source registered and unchanged while an owner grant is being applied', async () => {
    const pending = ReferenceRequestStatusSchema.parse(
      await success('fs.reference_request', { path: targetRoot }),
    );
    expect(pending.access_mode).toBe('read_write');
    const movedRoot = join(directory, 'moved-source');
    await mkdir(movedRoot);
    let release: () => void = () => {};
    let markStarted: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const original = WorkspaceReferenceService.prototype.addFolder;
    const spy = vi
      .spyOn(WorkspaceReferenceService.prototype, 'addFolder')
      .mockImplementation(async function (this: WorkspaceReferenceService, input) {
        markStarted();
        await gate;
        return original.call(this, input);
      });
    const applying = owner('POST', '/v1/reference-requests/decision', {
      request_id: pending.request_id,
      approved: true,
      access_mode: 'read_write',
    });
    try {
      await started;
      const moved = await owner('PUT', '/v1/workspaces/root-path', {
        workspace_id: source.workspace_id,
        root_path: movedRoot,
      });
      expect(moved.status).toBe(400);
      expect(moved.payload).toMatchObject({ error: { code: 'BAD_REQUEST' } });
      const removed = await owner('DELETE', '/v1/workspaces/' + source.workspace_id);
      expect(removed.status).toBe(400);
      expect(removed.payload).toMatchObject({ error: { code: 'BAD_REQUEST' } });
      expect(
        FsReadResultSchema.parse(await success('fs.read', { path: 'README.md' })).content,
      ).toBe('source intact');
    } finally {
      release();
      await applying;
      spy.mockRestore();
    }
    const result = await applying;
    expect(result.status, JSON.stringify(result.payload)).toBe(200);
    expect(ReferenceRequestStatusSchema.parse(result.payload).state).toBe('approved');
    expect(FsReferenceListResultSchema.parse(await success('fs.reference_list')).count).toBe(1);
  });

  it('routes model-free execution through the granted target while retaining source job ownership', async () => {
    const reference = await grant('read_only');
    const targetId = reference.reference_workspace_id;
    const input = {
      reference_workspace_id: targetId,
      request_id: 'folder_execution_read',
      operation: { kind: 'shell', command: 'fixture-only', network: 'local' },
    };
    expect((await invoke('project.exec', input)).isError).toBe(true);
    expect(executionInputs).toHaveLength(0);
    expect(
      (
        await owner('PUT', '/v1/workspace-references', {
          source_workspace_id: source.workspace_id,
          reference_workspace_id: targetId,
          access_mode: 'read_write',
        })
      ).status,
    ).toBe(200);
    const submitted = ProjectExecSummarySchema.parse(
      await success('project.exec', {
        ...input,
        request_id: 'folder_execution_write',
      }),
    );
    expect(submitted).toMatchObject({
      workspace_id: source.workspace_id,
      workspace_name: source.display_name,
      reference_workspace_id: targetId,
      reference_workspace_name: 'extra',
    });
    expect(await terminal(submitted.job_id)).toMatchObject({
      state: 'succeeded',
      exit_code: 0,
      workspace_id: source.workspace_id,
      reference_workspace_id: targetId,
      reference_workspace_name: 'extra',
      output: 'before external\n',
    });
    expect(executionInputs).toEqual([
      {
        workspace_id: source.workspace_id,
        reference_workspace_id: targetId,
      },
    ]);
  });

  it('blocks grant downgrade and removal during work, then enforces revocation and legacy read-only linking', async () => {
    const reference = await grant('read_write');
    const targetId = reference.reference_workspace_id;
    executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const submitted = ProjectExecSummarySchema.parse(
      await success('project.exec', {
        reference_workspace_id: targetId,
        request_id: 'folder_execution_busy',
        operation: { kind: 'shell', command: 'fixture-only', network: 'local' },
      }),
    );
    await executionStarted;
    const link = { source_workspace_id: source.workspace_id, reference_workspace_id: targetId };
    expect(
      (
        await owner('PUT', '/v1/workspace-references', {
          ...link,
          access_mode: 'read_only',
        })
      ).status,
    ).toBe(400);
    expect((await owner('DELETE', '/v1/workspace-references', link)).status).toBe(400);
    releaseExecution!();
    expect((await terminal(submitted.job_id)).state).toBe('succeeded');
    expect((await owner('DELETE', '/v1/workspace-references', link)).status).toBe(200);
    expect(
      (await invoke('fs.read', { reference_workspace_id: targetId, path: 'README.md' })).isError,
    ).toBe(true);
    const legacy = await owner('PUT', '/v1/workspace-references', link);
    expect(legacy.status).toBe(200);
    expect(WorkspaceReferenceSchema.parse(legacy.payload).access_mode ?? 'read_only').toBe(
      'read_only',
    );
    expect((await readTarget(targetId)).content).toBe('before external');
    expect(
      (await invoke('fs.mkdir', { reference_workspace_id: targetId, path: 'blocked' })).isError,
    ).toBe(true);
  });
});
