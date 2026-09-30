import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DaemonClient } from './daemon-client.js';

const WORKSPACE_ID = `ws_${'c'.repeat(24)}`;
const EXECUTION_JOB_ID = 'exec_00000000-0000-4000-8000-000000000000';

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

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-daemon-client-'));
    socketPath = join(temporaryDirectory, 'control.sock');
    mutationTokenPath = join(temporaryDirectory, 'control-mutation-token');
    await writeFile(mutationTokenPath, `${'d'.repeat(64)}\n`, { mode: 0o600 });
    requests = [];
    requestHeaders = [];
    editorConflict = false;
    editorBoundaryResponse = false;
    server = createServer((request, response) => {
      requests.push({ method: request.method, path: request.url });
      requestHeaders.push(request.headers);
      const isEditorSave = request.method === 'POST' && request.url === '/v1/workspace-editor/save';
      response.writeHead(editorConflict && isEditorSave ? 409 : 200, {
        'content-type': 'application/json',
      });
      if (request.url === '/v1/status') {
        response.end(JSON.stringify({ protocol_version: 1 }));
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
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    await rm(temporaryDirectory, { recursive: true, force: true });
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
