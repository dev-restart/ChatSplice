import { createHash } from 'node:crypto';

import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from '@chatsplice/protocol';
import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  McpServer,
} from '@modelcontextprotocol/server';

import { registerToolsWithLocalResultValidation } from './result-validation.js';
import type { McpToolContext } from './tool-context.js';
import { registerFsTools } from './tools-fs.js';
import { registerGoalTools } from './tools-goal.js';
import { registerLocalApplyTools } from './tools-local-apply.js';
import { registerProjectTools } from './tools-project.js';
import { registerWorkspaceTools } from './tools-workspace.js';

export interface McpToolCatalogIdentity {
  readonly mcp_descriptor_version: string;
  readonly tool_count: number;
  readonly tool_schema_digest: string;
}

let cachedIdentity: Promise<McpToolCatalogIdentity> | undefined;

/** The runtime and identity discovery always register the same tool definitions. */
export function registerMcpTools(context: McpToolContext): void {
  registerToolsWithLocalResultValidation(context.server);
  registerWorkspaceTools(context);
  registerFsTools(context);
  registerProjectTools(context);
  registerLocalApplyTools(context);
  registerGoalTools(context);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function hashMcpToolCatalog(tools: readonly unknown[]): string {
  if (tools.length < 1 || tools.length > 128) throw new Error('Invalid MCP tool catalog size.');
  // Match HTTP JSON serialization: absent optional metadata must not fingerprint
  // differently when discovery uses the private in-memory transport.
  const wireJson = JSON.stringify(tools);
  if (Buffer.byteLength(wireJson) > 2 * 1024 * 1024)
    throw new Error('MCP tool catalog exceeded its byte limit.');
  const wireTools = JSON.parse(wireJson) as unknown[];
  const named = wireTools
    .map((value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('Invalid MCP tool descriptor.');
      const tool = value as Record<string, unknown>;
      if (typeof tool.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/u.test(tool.name))
        throw new Error('Invalid MCP tool name.');
      return tool;
    })
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  if (new Set(named.map((tool) => tool.name)).size !== named.length)
    throw new Error('Duplicate MCP tool name.');
  const serialized = canonicalJson(named);
  if (Buffer.byteLength(serialized) > 2 * 1024 * 1024)
    throw new Error('MCP tool catalog exceeded its byte limit.');
  return createHash('sha256')
    .update('chatsplice-mcp-tool-catalog-v1\n')
    .update(serialized)
    .digest('hex');
}

async function discoverCatalogIdentity(): Promise<McpToolCatalogIdentity> {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  // Registration only captures service references in callbacks. This private
  // transport sends initialize/tools-list exclusively and never invokes a tool,
  // so metadata discovery needs no workspace, repository, credential or process.
  registerMcpTools({ server } as McpToolContext);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  clientTransport.onmessage = (message) => {
    if (!('id' in message) || typeof message.id !== 'number') return;
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if ('error' in message) waiter.reject(new Error('MCP catalog discovery was rejected.'));
    else if ('result' in message) waiter.resolve(message.result);
  };
  const request = (
    id: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('MCP catalog discovery timed out.'));
      }, 2_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      void clientTransport
        .send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
        .catch((error: unknown) => {
          const waiter = pending.get(id);
          pending.delete(id);
          waiter?.reject(
            error instanceof Error ? error : new Error('MCP catalog discovery failed.'),
          );
        });
    });
  try {
    await server.connect(serverTransport);
    await clientTransport.start();
    await request(1, 'initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'chatsplice-catalog-identity', version: MCP_SERVER_VERSION },
    });
    await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const result = await request(2, 'tools/list');
    if (
      typeof result !== 'object' ||
      result === null ||
      !('tools' in result) ||
      !Array.isArray(result.tools)
    )
      throw new Error('MCP catalog discovery returned an invalid result.');
    return Object.freeze({
      mcp_descriptor_version: MCP_SERVER_VERSION,
      tool_count: result.tools.length,
      tool_schema_digest: hashMcpToolCatalog(result.tools),
    });
  } finally {
    await clientTransport.close();
    await server.close();
  }
}

export function getMcpToolCatalogIdentity(): Promise<McpToolCatalogIdentity> {
  cachedIdentity ??= discoverCatalogIdentity();
  return cachedIdentity;
}
