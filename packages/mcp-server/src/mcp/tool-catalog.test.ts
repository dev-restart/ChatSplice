import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MCP_SERVER_VERSION } from '@chatsplice/protocol';
import { startChatSpliceRuntime } from '../runtime.js';
import { getMcpToolCatalogIdentity, hashMcpToolCatalog } from './tool-catalog.js';

describe('actual registered MCP catalog identity', () => {
  it('discovers the complete registered catalog without workspace execution', async () => {
    const catalog = await getMcpToolCatalogIdentity();
    expect(catalog).toMatchObject({ mcp_descriptor_version: MCP_SERVER_VERSION, tool_count: 24 });
    expect(catalog.tool_schema_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(await getMcpToolCatalogIdentity()).toBe(catalog);
  });
  it('fingerprints schema and annotation changes independently of object and tool ordering', () => {
    const first = {
      name: 'project.a',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      annotations: { readOnlyHint: true },
      icons: undefined,
    };
    const second = { name: 'project.b', inputSchema: { type: 'object' } };
    const original = hashMcpToolCatalog([first, second]);
    expect(hashMcpToolCatalog([second, JSON.parse(JSON.stringify(first))])).toBe(original);
    expect(
      hashMcpToolCatalog([{ ...first, annotations: { readOnlyHint: false } }, second]),
    ).not.toBe(original);
    expect(
      hashMcpToolCatalog([
        { ...first, inputSchema: { type: 'object', properties: { value: { type: 'number' } } } },
        second,
      ]),
    ).not.toBe(original);
    expect(() => hashMcpToolCatalog([first, first])).toThrow('Duplicate');
  });
  it('matches the catalog actually advertised by the authenticated local MCP HTTP endpoint', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'cs-c-'));
    let runtime: Awaited<ReturnType<typeof startChatSpliceRuntime>> | undefined;
    const client = new Client({ name: 'catalog-contract-test', version: '1' });
    try {
      runtime = await startChatSpliceRuntime({
        dataDirectory: directory,
        controlSocketPath: join(directory, 'control.sock'),
      });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(runtime.mcpUrl), {
          requestInit: { headers: { 'x-chatsplice-token': runtime.mcpToken } },
        }),
      );
      const { tools } = await client.listTools();
      expect(runtime.status().tool_count).toBe(tools.length);
      expect(runtime.status().goal_count).toBe(0);
      expect(runtime.status().tool_schema_digest).toBe(hashMcpToolCatalog(tools));

      // Inspect the wire contract consumed by remote clients, independently of
      // the server-side Zod parser and the catalog's self-consistent digest.
      const projectExec = tools.find((tool) => tool.name === 'project.exec');
      const operation = projectExec?.inputSchema.properties?.operation as
        | {
            anyOf?: Array<{
              properties?: { kind?: { const?: string }; repair_cache?: { type?: string } };
            }>;
            oneOf?: Array<{
              properties?: { kind?: { const?: string }; repair_cache?: { type?: string } };
            }>;
          }
        | undefined;
      const install = (operation?.anyOf ?? operation?.oneOf)?.find(
        (variant) => variant.properties?.kind?.const === 'install',
      );
      expect(install?.properties?.repair_cache).toMatchObject({ type: 'boolean' });
      expect(projectExec?.description).toContain('repair_cache:true');

      // Result schemas stay server-side; ChatGPT receives only call contracts.
      for (const tool of tools) expect(tool.outputSchema).toBeUndefined();
      // ChatGPT function definitions need one root object, never a root union.
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.oneOf ?? tool.inputSchema.anyOf).toBeUndefined();
        expect(tool.inputSchema.properties).toBeDefined();
      }

      for (const name of ['fs.search', 'fs.reference_search']) {
        const search = tools.find((tool) => tool.name === name);
        expect(search?.inputSchema.properties?.context_lines).toMatchObject({
          type: 'integer',
          minimum: 0,
          maximum: 3,
          default: 0,
        });
        expect(search?.inputSchema.required ?? []).not.toContain('context_lines');
        expect(search?.description).toContain('context_truncated');
      }

      const fsWrite = tools.find((tool) => tool.name === 'fs.write');
      expect(fsWrite?.inputSchema.properties?.mode).toMatchObject({
        enum: ['create', 'replace'],
      });
      expect(fsWrite?.inputSchema.required ?? []).not.toContain('expected_sha256');

      const goalUpdate = tools.find((tool) => tool.name === 'project.goal_update');
      expect(goalUpdate).toBeDefined();
      const goalProperties = goalUpdate?.inputSchema.properties as Record<
        string,
        {
          enum?: string[];
          type?: string;
          minimum?: number;
          maximum?: number;
          exclusiveMinimum?: number;
          default?: number;
          description?: string;
        }
      >;
      expect(goalProperties.action?.enum).toEqual([
        'create',
        'checkpoint',
        'verify_file',
        'pause',
        'resume',
        'cancel',
        'complete',
        'delete',
        'reset',
      ]);
      expect([...(goalUpdate?.inputSchema.required ?? [])].sort()).toEqual([
        'action',
        'workspace_binding',
        'workspace_id',
      ]);
      expect(goalUpdate?.description).toContain('action:reset');
      const budget = goalProperties.max_executions;
      // minimum:0 admits zero and rejects negative input. The upper bound
      // must admit cumulative workloads beyond the obsolete 128 limit. No
      // advertised default: omission on resume preserves the stored budget.
      expect(budget).toMatchObject({ type: 'integer', minimum: 0 });
      expect(budget?.exclusiveMinimum).toBeUndefined();
      expect(budget?.maximum ?? Number.MAX_SAFE_INTEGER).toBeGreaterThanOrEqual(244);
      expect(budget?.default).toBeUndefined();
      expect(budget?.description).toContain('default 0');
    } finally {
      try {
        await client.close();
      } finally {
        try {
          await runtime?.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
  });
});
