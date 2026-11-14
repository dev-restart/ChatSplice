import { FsWriteInputSchema, GoalUpdateInputSchema } from '@chatsplice/protocol';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { registerToolsWithLocalResultValidation } from './result-validation.js';
import { parseToolInput } from './tool-input.js';

describe('server-side result validation without advertised output schemas', () => {
  let server: McpServer;
  let client: Client;

  beforeEach(async () => {
    server = new McpServer({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
    registerToolsWithLocalResultValidation(server);
    const outputSchema = z.object({ value: z.number() }).strict();
    const input = z.object({ value: z.unknown() }).strict();
    server.registerTool(
      'fixture.echo',
      { description: 'Echo.', inputSchema: input, outputSchema },
      async ({ value }) => ({
        content: [{ type: 'text', text: JSON.stringify({ value }) }],
        structuredContent: { value } as { value: number },
      }),
    );
    client = new Client({ name: 'fixture-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it('omits the output schema from tools/list', async () => {
    const { tools } = await client.listTools();
    expect(tools[0]?.outputSchema).toBeUndefined();
  });

  it('returns a conforming result unchanged', async () => {
    const result = await client.callTool({ name: 'fixture.echo', arguments: { value: 5 } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ value: 5 });
  });

  it('withholds a result outside the declared shape', async () => {
    const result = await client.callTool({ name: 'fixture.echo', arguments: { value: 'five' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result.content)).toContain('INTERNAL_ERROR');
    expect(JSON.stringify(result.content)).not.toContain('five');
  });
});

describe('per-action rules behind flattened tool inputs', () => {
  const base = {
    workspace_id: 'ws_0123456789abcdef01234567',
    workspace_binding: `wb_${'a'.repeat(64)}`,
  };

  it('requires expected_sha256 only for fs.write replace', () => {
    expect(() =>
      parseToolInput(FsWriteInputSchema, { ...base, path: 'a.txt', mode: 'replace', content: '' }),
    ).toThrow(/BAD_REQUEST|Invalid arguments/u);
    expect(() =>
      parseToolInput(FsWriteInputSchema, {
        ...base,
        path: 'a.txt',
        mode: 'create',
        expected_sha256: 'a'.repeat(64),
        content: '',
      }),
    ).toThrow('Invalid arguments');
    expect(
      parseToolInput(FsWriteInputSchema, { ...base, path: 'a.txt', mode: 'create', content: 'x' }),
    ).toMatchObject({ mode: 'create' });
  });

  it('applies create defaults, keeps resume budgets omitted and rejects foreign fields', () => {
    const created = parseToolInput(GoalUpdateInputSchema, {
      ...base,
      action: 'create',
      objective: 'Fix the add function',
      tracked_paths: ['src/math.js'],
      criteria: [
        { criterion_id: 'file', kind: 'file', path: 'src/math.js', description: 'Updated' },
      ],
    });
    expect(created).toMatchObject({ max_executions: 0, deadline_ms: 3_600_000, scope: '' });
    const resumed = parseToolInput(GoalUpdateInputSchema, {
      ...base,
      action: 'resume',
      goal_id: 'goal_01234567-89ab-4def-8123-456789abcdef',
      expected_revision: 2,
    });
    expect(resumed).not.toHaveProperty('max_executions');
    expect(() =>
      parseToolInput(GoalUpdateInputSchema, {
        ...base,
        action: 'reset',
        goal_id: 'goal_01234567-89ab-4def-8123-456789abcdef',
        expected_revision: 2,
        max_executions: 3,
      }),
    ).toThrow('Invalid arguments');
  });
});
