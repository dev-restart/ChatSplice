import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';

import {
  SqliteGoalRepository,
  ChatSpliceError,
  type WorkspaceReferenceService,
  type WorkspaceService,
} from '@chatsplice/core';
import { LEGACY_MCP_AUTH_HEADER, MCP_AUTH_HEADER } from '@chatsplice/protocol';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import type { NodeIncomingMessageLike } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { log } from '../logging.js';
import { createChatSpliceMcpServer } from '../mcp/server.js';
import type { DirectEditActivityStore } from '../mutation/direct-edit-activity-store.js';
import type { LocalApplyProposalStore } from '../mutation/local-apply-proposal-store.js';
import type { ReferenceRequestStore } from '../mutation/reference-request-store.js';
import { DESKTOP_EXECUTION_CONCURRENCY, ProjectExecutionService } from '../execution/service.js';
import { GoalService } from '../goal/service.js';
import { getRuntimeIdentity } from '../runtime-identity.js';
import { observeMcpResponse, type McpRequestObservation } from './request-observation.js';

const MAX_REQUEST_BYTES = 1024 * 1024;

async function readBoundedBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  // Keep the socket alive long enough to return 413 when the byte cap is reached.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > MAX_REQUEST_BYTES) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

export interface McpHttpRuntime {
  readonly url: string;
  close(): Promise<void>;
}

function tokenMatches(candidate: string | string[] | undefined, expected: string): boolean {
  if (typeof candidate !== 'string') {
    return false;
  }
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return (
    candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer)
  );
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

export async function startMcpHttpServer(
  workspaceService: WorkspaceService,
  workspaceReferenceService: WorkspaceReferenceService,
  token: string,
  localApplyProposalStore: LocalApplyProposalStore,
  referenceRequestStore: ReferenceRequestStore,
  directEditActivityStore: DirectEditActivityStore,
  isReadOnly: () => boolean,
  options: {
    readonly localApplyStartWaitMs?: number;
    readonly executionService?: ProjectExecutionService;
    readonly goalService?: GoalService;
  } = {},
): Promise<McpHttpRuntime> {
  if (options.executionService !== undefined && options.goalService === undefined) {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      'A caller-owned execution service requires its shared caller-owned Goal service.',
    );
  }
  const ownsExecutionService = options.executionService === undefined;
  const executionService =
    options.executionService ??
    new ProjectExecutionService(workspaceService, {
      isReadOnly,
      concurrency: DESKTOP_EXECUTION_CONCURRENCY,
      referenceService: workspaceReferenceService,
    });
  const embeddedRepository =
    options.goalService === undefined ? new SqliteGoalRepository(':memory:') : undefined;
  const identity = { ...(await getRuntimeIdentity()), run_id: randomUUID() };
  const goalService =
    options.goalService ??
    new GoalService(embeddedRepository!, workspaceService, {
      buildId: identity.build_id,
      runId: identity.run_id,
      isReadOnly,
    });
  goalService.setExecutionService(executionService);
  executionService.setGoalLifecycle(goalService);
  const requestObservations = new AsyncLocalStorage<McpRequestObservation>();
  const reportTransportError = (source: 'handler' | 'adapter'): void => {
    const observation = requestObservations.getStore();
    if (observation !== undefined) observation.error(source);
    else log('error', 'mcp_unscoped_transport_error', { source });
  };
  const handler = createMcpHandler(
    () =>
      createChatSpliceMcpServer(
        workspaceService,
        workspaceReferenceService,
        token,
        localApplyProposalStore,
        referenceRequestStore,
        directEditActivityStore,
        isReadOnly,
        { ...options, executionService, goalService },
      ),
    {
      legacy: 'stateless',
      onerror: () => reportTransportError('handler'),
    },
  );
  const nodeHandler = toNodeHandler(handler, {
    onerror: () => reportTransportError('adapter'),
  });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  let ready = false;

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ healthy: true }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/readyz') {
      response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ready }));
      return;
    }
    if (url.pathname !== '/mcp') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    if (!validateHost(request, response) || !validateOrigin(request, response)) {
      return;
    }
    const contentLength = Number(request.headers['content-length'] ?? 0);
    if (!Number.isFinite(contentLength) || contentLength > MAX_REQUEST_BYTES) {
      response.writeHead(413, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'request_too_large' }));
      return;
    }
    if (
      !tokenMatches(request.headers[MCP_AUTH_HEADER], token) &&
      !tokenMatches(request.headers[LEGACY_MCP_AUTH_HEADER], token)
    ) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const dispatch = (boundedRequest: NodeIncomingMessageLike): void => {
      const observation = observeMcpResponse(response);
      requestObservations.run(observation, () => {
        void nodeHandler(boundedRequest, response).catch(() => {
          observation.error('request');
          if (!response.headersSent) {
            response.writeHead(500, { 'content-type': 'application/json' });
          }
          response.end();
        });
      });
    };
    // Content-Length alone does not bound chunked bodies, so the adapter only
    // receives bytes that were counted against the cap.
    void readBoundedBody(request).then(
      (body) => {
        if (body === undefined) {
          response.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
          response.end(JSON.stringify({ error: 'request_too_large' }));
          return;
        }
        dispatch({
          ...(request.method === undefined ? {} : { method: request.method }),
          ...(request.url === undefined ? {} : { url: request.url }),
          headers: request.headers,
          async *[Symbol.asyncIterator]() {
            if (body.length > 0) yield body;
          },
        });
      },
      () => {
        if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'bad_request' }));
      },
    );
  });
  // MCP calls such as local.await_apply intentionally remain open while the
  // bounded wait enforces its own timeout. A server-level 30 second timeout
  // interrupted those calls before the requested result could arrive.
  server.requestTimeout = 0;
  server.headersTimeout = 10_000;

  const address = await new Promise<{ port: number }>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const bound = server.address();
      if (bound === null || typeof bound === 'string') {
        reject(new Error('MCP HTTP server did not return a TCP port.'));
        return;
      }
      resolve({ port: bound.port });
    });
  });
  ready = true;

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close(): Promise<void> {
      ready = false;
      await handler.close();
      if (ownsExecutionService) await executionService.shutdown();
      await closeServer(server);
      embeddedRepository?.close();
    },
  };
}
