import { request } from 'node:http';

import {
  SqliteSettingsRepository,
  SqliteWorkspaceRepository,
  WorkspaceReferenceService,
  WorkspaceService,
} from '@chatsplice/core';
import { MCP_AUTH_HEADER } from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DirectEditActivityStore } from '../mutation/direct-edit-activity-store.js';
import { LocalApplyProposalStore } from '../mutation/local-apply-proposal-store.js';
import { ReferenceRequestStore } from '../mutation/reference-request-store.js';
import { startMcpHttpServer, type McpHttpRuntime } from './server.js';

const token = '0'.repeat(64);

function postChunked(url: string, chunks: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const outgoing = request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          [MCP_AUTH_HEADER]: token,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'transfer-encoding': 'chunked',
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    outgoing.on('error', reject);
    for (const chunk of chunks) outgoing.write(chunk);
    outgoing.end();
  });
}

describe('MCP HTTP request bounds', () => {
  let repository: SqliteWorkspaceRepository;
  let settings: SqliteSettingsRepository;
  let http: McpHttpRuntime;

  beforeEach(async () => {
    repository = new SqliteWorkspaceRepository(':memory:');
    settings = new SqliteSettingsRepository(':memory:');
    const workspaces = new WorkspaceService(repository);
    const activity = new DirectEditActivityStore();
    http = await startMcpHttpServer(
      workspaces,
      new WorkspaceReferenceService(workspaces, settings),
      token,
      new LocalApplyProposalStore(workspaces, token, activity),
      new ReferenceRequestStore(workspaces, token, activity),
      activity,
      () => false,
    );
  });

  afterEach(async () => {
    await http.close();
    settings.close();
    repository.close();
  });

  it('rejects an oversized chunked body that has no Content-Length', async () => {
    const chunk = 'x'.repeat(64 * 1024);
    expect(
      await postChunked(
        http.url,
        Array.from({ length: 20 }, () => chunk),
      ),
    ).toBe(413);
  });

  it('still serves a small chunked MCP request', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'bounds-test', version: '0.0.0' },
      },
    });
    expect(await postChunked(http.url, [body.slice(0, 20), body.slice(20)])).toBe(200);
  });
});
