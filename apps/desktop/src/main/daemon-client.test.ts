import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import { CONTROL_PROTOCOL_VERSION, EXECUTION_CONTRACT_VERSION } from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const identityMocks = vi.hoisted(() => ({
  getDesktopRuntimeIdentity: vi.fn(),
}));
vi.mock('./runtime-identity.js', () => ({
  getDesktopRuntimeIdentity: identityMocks.getDesktopRuntimeIdentity,
}));

import { DaemonClient, IncompatibleDaemonError } from './daemon-client.js';

const WORKSPACE_ID = `ws_${'c'.repeat(24)}`;
const EXECUTION_JOB_ID = 'exec_00000000-0000-4000-8000-000000000000';
const CURRENT_DAEMON_STATUS = {
  protocol_version: CONTROL_PROTOCOL_VERSION,
  execution_contract: EXECUTION_CONTRACT_VERSION,
  healthy: true,
  ready: true,
  mcp_url: 'http://127.0.0.1:53614/mcp',
  workspace_count: 1,
  probe_workspace_id: WORKSPACE_ID,
  latest_direct_edits: [],
  latest_mcp_activities: [],
  execution_jobs: [],
  tunnel: {
    mode: 'none',
    state: 'unconfigured',
    healthy: false,
    ready: false,
    configuration: null,
    detected_executable_path: null,
    detected_tunnel_id: null,
    mcp_url: null,
    admin_url: null,
    error_code: null,
  },
};

const EXECUTION_JOB = {
  job_id: EXECUTION_JOB_ID,
  workspace_id: WORKSPACE_ID,
  workspace_name: 'Workspace',
  operation: { kind: 'node_script' as const, script: 'test' },
  cwd: '.',
  state: 'running' as const,
  command: 'pnpm test',
  created_at: '2026-09-08T00:00:00.000Z',
  started_at: '2026-09-08T00:00:01.000Z',
  finished_at: null,
  exit_code: null,
  error_code: null,
  message: 'Running',
  used_network: false,
  truncated: false,
  duration_ms: 1_000,
  output: 'running',
};

describe('DaemonClient owner-only mutations', () => {
  let temporaryDirectory: string;
  let socketPath: string;
  let server: Server;
  let mutationTokenPath: string;
  let requestHeaders: Array<Record<string, string | string[] | undefined>>;
  let requests: Array<{ method: string | undefined; path: string | undefined }>;
  let editorConflict: boolean;
  let editorBoundaryResponse: boolean;
  let daemonStatusPayload: unknown;
  let referenceDecisionBodies: unknown[];

  beforeEach(async () => {
    identityMocks.getDesktopRuntimeIdentity.mockReset();
    // Keep Unix socket paths short and all fixture writes inside the current workspace.
    temporaryDirectory = await mkdtemp(join(process.cwd(), 'cs-client-'));
    socketPath = join(temporaryDirectory, 'control.sock');
    mutationTokenPath = join(temporaryDirectory, 'control-mutation-token');
    await writeFile(mutationTokenPath, `${'d'.repeat(64)}\n`, { mode: 0o600 });
    requests = [];
    requestHeaders = [];
    referenceDecisionBodies = [];
    editorConflict = false;
    editorBoundaryResponse = false;
    daemonStatusPayload = { protocol_version: 1 };
    server = createServer((request, response) => {
      requests.push({ method: request.method, path: request.url });
      requestHeaders.push(request.headers);
      const isEditorSave = request.method === 'POST' && request.url === '/v1/workspace-editor/save';
      response.writeHead(editorConflict && isEditorSave ? 409 : 200, {
        'content-type': 'application/json',
      });
      if (request.url === '/v1/status') {
        response.end(JSON.stringify(daemonStatusPayload));
      } else if (request.method === 'POST' && request.url === '/v1/reference-requests/decision') {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            request_id: string;
            approved: boolean;
            access_mode?: 'read_only' | 'read_write';
          };
          referenceDecisionBodies.push(body);
          response.end(
            JSON.stringify({
              request_id: body.request_id,
              workspace_id: WORKSPACE_ID,
              workspace_name: 'Workspace',
              path: '/fixture/reference',
              label: null,
              access_mode: body.access_mode ?? 'read_write',
              state: body.approved ? 'approved' : 'denied',
              reference_workspace_id: body.approved ? `ws_${'e'.repeat(24)}` : null,
              created_at: '2026-10-25T00:00:00.000Z',
              expires_at: '2026-10-25T00:15:00.000Z',
              message: body.approved ? 'Approved.' : 'Denied.',
            }),
          );
        });
      } else if (request.method === 'PUT' && request.url === '/v1/workspaces/name') {
        response.end(
          JSON.stringify({
            workspace_id: WORKSPACE_ID,
            display_name: 'Renamed',
            kind: 'user',
            created_at: '2026-08-13T00:00:00.000Z',
          }),
        );
      } else if (request.method === 'DELETE' && request.url?.startsWith('/v1/workspaces/')) {
        response.end(JSON.stringify({ workspaces: [], count: 0 }));
      } else if (
        request.method === 'GET' &&
        request.url ===
          '/v1/execution-jobs/' +
            EXECUTION_JOB_ID +
            '?workspace_id=' +
            encodeURIComponent(WORKSPACE_ID)
      ) {
        response.end(JSON.stringify(EXECUTION_JOB));
      } else if (
        request.method === 'POST' &&
        request.url === '/v1/execution-jobs/' + EXECUTION_JOB_ID + '/cancel'
      ) {
        response.end(JSON.stringify(EXECUTION_JOB));
      } else if (request.method === 'POST' && request.url === '/v1/workspace-editor/read') {
        response.end(
          JSON.stringify({
            workspace_id: WORKSPACE_ID,
            path: 'src/note.md',
            content: editorBoundaryResponse ? '\u0001'.repeat(1024 * 1024) : 'before\n',
            sha256: 'a'.repeat(64),
          }),
        );
      } else if (request.method === 'POST' && request.url === '/v1/workspace-editor/save') {
        response.end(
          JSON.stringify(
            editorConflict
              ? {
                  error: {
                    code: 'BAD_REQUEST',
                    message: 'The file changed after the editor read. Read it again and retry.',
                  },
                }
              : {
                  workspace_id: WORKSPACE_ID,
                  path: 'src/note.md',
                  content: 'after\n',
                  sha256: 'b'.repeat(64),
                },
          ),
        );
      } else {
        response.end(JSON.stringify({}));
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
  });

  afterEach(async () => {
    try {
      if (server?.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        });
      }
    } finally {
      if (temporaryDirectory !== undefined) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  });

  it('adds the private mutation capability to owner-side local mutations', async () => {
    const client = new DaemonClient(socketPath, mutationTokenPath);

    await client.removeWorkspace({ workspace_id: WORKSPACE_ID });
    await expect(
      client.renameWorkspace({ workspace_id: WORKSPACE_ID, display_name: 'Renamed' }),
    ).resolves.toMatchObject({ display_name: 'Renamed' });

    expect(requests).toEqual([
      { method: 'DELETE', path: `/v1/workspaces/${WORKSPACE_ID}` },
      { method: 'PUT', path: '/v1/workspaces/name' },
    ]);
    expect(requestHeaders[0]?.['x-chatsplice-control-mutation-token']).toBe('d'.repeat(64));
    expect(requestHeaders[1]?.['x-chatsplice-control-mutation-token']).toBe('d'.repeat(64));
    expect(requestHeaders[0]?.['x-localchat-control-mutation-token']).toBe('d'.repeat(64));
    expect(requestHeaders[1]?.['x-localchat-control-mutation-token']).toBe('d'.repeat(64));
  });

  it('rejects an old daemon instead of silently mixing execution protocols', async () => {
    const client = new DaemonClient(socketPath, mutationTokenPath);
    await expect(client.status()).rejects.toThrow('different ChatSplice daemon version');
  });

  it('rejects protocol 4 before using the new owner folder decision contract', async () => {
    daemonStatusPayload = { ...CURRENT_DAEMON_STATUS, protocol_version: 4 };
    const client = new DaemonClient(socketPath, mutationTokenPath);
    await expect(client.status()).rejects.toBeInstanceOf(IncompatibleDaemonError);
    expect(requests).toEqual([{ method: 'GET', path: '/v1/status' }]);
  });

  it.each(['read_only', 'read_write'] as const)(
    'sends the owner-selected %s mode with the private capability',
    async (accessMode) => {
      const client = new DaemonClient(socketPath, mutationTokenPath);
      const requestId = `refreq_${'a'.repeat(24)}`;
      await expect(
        client.decideReferenceRequest(requestId, true, accessMode),
      ).resolves.toMatchObject({
        request_id: requestId,
        state: 'approved',
        access_mode: accessMode,
      });
      expect(referenceDecisionBodies).toEqual([
        { request_id: requestId, approved: true, access_mode: accessMode },
      ]);
      expect(requestHeaders.at(-1)?.['x-chatsplice-control-mutation-token']).toBe('d'.repeat(64));
    },
  );

  it('preserves the legacy approval call without inventing an explicit mode', async () => {
    const client = new DaemonClient(socketPath, mutationTokenPath);
    const requestId = `refreq_${'a'.repeat(24)}`;
    await client.decideReferenceRequest(requestId, true);
    expect(referenceDecisionBodies).toEqual([{ request_id: requestId, approved: true }]);
  });

  it('sends a denial without access authority', async () => {
    const client = new DaemonClient(socketPath, mutationTokenPath);
    const requestId = `refreq_${'a'.repeat(24)}`;
    await expect(client.decideReferenceRequest(requestId, false)).resolves.toMatchObject({
      state: 'denied',
      reference_workspace_id: null,
    });
    expect(referenceDecisionBodies).toEqual([{ request_id: requestId, approved: false }]);
  });

  it('rejects a denial with access authority before contacting the daemon', async () => {
    const client = new DaemonClient(socketPath, mutationTokenPath);
    await expect(
      client.decideReferenceRequest(`refreq_${'a'.repeat(24)}`, false, 'read_write'),
    ).rejects.toThrow();
    expect(requests).toEqual([]);
    expect(referenceDecisionBodies).toEqual([]);
  });

  it('accepts a daemon with the current execution contract without a control mutation', async () => {
    daemonStatusPayload = CURRENT_DAEMON_STATUS;
    const client = new DaemonClient(socketPath, mutationTokenPath);
    await expect(client.status()).resolves.toMatchObject({
      protocol_version: CONTROL_PROTOCOL_VERSION,
      execution_contract: EXECUTION_CONTRACT_VERSION,
      ready: true,
    });
    expect(requests).toEqual([{ method: 'GET', path: '/v1/status' }]);
    expect(requestHeaders[0]?.['x-chatsplice-control-mutation-token']).toBe('d'.repeat(64));
  });

  it('rejects a different schema under the same execution contract without stopping the daemon', async () => {
    identityMocks.getDesktopRuntimeIdentity.mockReturnValue({
      status: 'verified',
      expected_tool_schema_digest: 'a'.repeat(64),
    });
    daemonStatusPayload = {
      ...CURRENT_DAEMON_STATUS,
      tool_schema_digest: 'b'.repeat(64),
    };
    const client = new DaemonClient(socketPath, mutationTokenPath);

    await expect(client.status()).rejects.toMatchObject({
      name: 'IncompatibleDaemonError',
      message: expect.stringContaining('different tool schema'),
      runtimeDetails: expect.stringContaining(`Expected tool_schema_digest: ${'a'.repeat(64)}`),
    });
    expect(requests).toEqual([{ method: 'GET', path: '/v1/status' }]);
  });

  it('accepts a matching schema even when only the daemon build identity differs', async () => {
    identityMocks.getDesktopRuntimeIdentity.mockReturnValue({
      status: 'verified',
      expected_tool_schema_digest: 'a'.repeat(64),
      expected_daemon_build_id: 'b'.repeat(64),
    });
    daemonStatusPayload = {
      ...CURRENT_DAEMON_STATUS,
      tool_schema_digest: 'a'.repeat(64),
      build_id: 'c'.repeat(64),
    };
    const client = new DaemonClient(socketPath, mutationTokenPath);

    await expect(client.status()).resolves.toMatchObject({
      execution_contract: EXECUTION_CONTRACT_VERSION,
      tool_schema_digest: 'a'.repeat(64),
      build_id: 'c'.repeat(64),
    });
    expect(requests).toEqual([{ method: 'GET', path: '/v1/status' }]);
  });

  it('fails closed before connecting when the owner capability is missing or malformed', async () => {
    const client = new DaemonClient(socketPath, mutationTokenPath);
    await writeFile(mutationTokenPath, 'invalid-token');
    await expect(client.status()).rejects.toThrow('capability is invalid');
    await rm(mutationTokenPath);
    await expect(client.listWorkspaces()).rejects.toMatchObject({ code: 'ENOENT' });
    expect(requests).toEqual([]);
  });

  it.each([undefined, 'web-verify-1'])(
    'rejects execution contract %s while preserving daemon work',
    async (executionContract) => {
      daemonStatusPayload = { ...CURRENT_DAEMON_STATUS, execution_contract: executionContract };
      const client = new DaemonClient(socketPath, mutationTokenPath);
      await expect(client.status()).rejects.toBeInstanceOf(IncompatibleDaemonError);
      await expect(client.status()).rejects.toThrow(
        'Preserve unsaved work and finish ongoing jobs',
      );
      expect(requests.every((item) => item.method === 'GET' && item.path === '/v1/status')).toBe(
        true,
      );
    },
  );

  it('reads and cancels a scoped execution job through the owner daemon API', async () => {
    const client = new DaemonClient(socketPath, mutationTokenPath);
    const target = { workspace_id: WORKSPACE_ID, job_id: EXECUTION_JOB_ID };

    await expect(client.getExecutionJob(target)).resolves.toMatchObject({
      job_id: EXECUTION_JOB_ID,
      workspace_id: WORKSPACE_ID,
      output: 'running',
    });
    await expect(client.cancelExecutionJob(target)).resolves.toMatchObject({
      job_id: EXECUTION_JOB_ID,
      workspace_id: WORKSPACE_ID,
    });

    expect(requests).toContainEqual({
      method: 'GET',
      path:
        '/v1/execution-jobs/' +
        EXECUTION_JOB_ID +
        '?workspace_id=' +
        encodeURIComponent(WORKSPACE_ID),
    });
    expect(requests).toContainEqual({
      method: 'POST',
      path: '/v1/execution-jobs/' + EXECUTION_JOB_ID + '/cancel',
    });
    expect(requestHeaders.at(-1)?.['x-chatsplice-control-mutation-token']).toBe('d'.repeat(64));
    expect(requestHeaders.at(-1)?.['x-localchat-control-mutation-token']).toBe('d'.repeat(64));
  });

  it('uses the owner token for full editor read and SHA-guarded save routes', async () => {
    const client = new DaemonClient(socketPath, mutationTokenPath);
    await expect(
      client.readWorkspaceEditorFile({ workspace_id: WORKSPACE_ID, path: 'src/note.md' }),
    ).resolves.toMatchObject({ content: 'before\n', sha256: 'a'.repeat(64) });
    await expect(
      client.saveWorkspaceEditorFile({
        workspace_id: WORKSPACE_ID,
        path: 'src/note.md',
        expected_sha256: 'a'.repeat(64),
        content: 'after\n',
      }),
    ).resolves.toMatchObject({ content: 'after\n', sha256: 'b'.repeat(64) });

    expect(requests).toContainEqual({ method: 'POST', path: '/v1/workspace-editor/read' });
    expect(requests).toContainEqual({ method: 'POST', path: '/v1/workspace-editor/save' });
    expect(requestHeaders.at(-1)?.['x-chatsplice-control-mutation-token']).toBe('d'.repeat(64));
    expect(requestHeaders.at(-1)?.['x-localchat-control-mutation-token']).toBe('d'.repeat(64));
  });

  it('preserves the owner editor conflict status and safe control code', async () => {
    editorConflict = true;
    const client = new DaemonClient(socketPath, mutationTokenPath);

    await expect(
      client.saveWorkspaceEditorFile({
        workspace_id: WORKSPACE_ID,
        path: 'src/note.md',
        expected_sha256: 'a'.repeat(64),
        content: 'after\n',
      }),
    ).rejects.toMatchObject({
      name: 'DaemonControlError',
      code: 'BAD_REQUEST',
      statusCode: 409,
      message: 'The file changed after the editor read. Read it again and retry.',
    });
  });

  it('accepts a maximally sized editor response with JSON-escaped control characters', async () => {
    editorBoundaryResponse = true;
    const client = new DaemonClient(socketPath, mutationTokenPath);

    await expect(
      client.readWorkspaceEditorFile({ workspace_id: WORKSPACE_ID, path: 'src/note.md' }),
    ).resolves.toMatchObject({ content: '\u0001'.repeat(1024 * 1024) });
  });
});
