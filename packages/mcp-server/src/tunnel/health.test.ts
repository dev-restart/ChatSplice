import { describe, expect, it } from 'vitest';

import { probeTunnelHealth } from './health.js';

describe('probeTunnelHealth', () => {
  it('requires a ready main channel targeting the current MCP URL', async () => {
    const fetchImplementation = (async (input: URL | RequestInfo) => {
      const url = input.toString();
      if (url.endsWith('/readyz')) {
        return new Response('ready', { status: 200 });
      }
      return Response.json({
        control_plane_tunnel_id: 'tunnel_0123456789abcdef',
        mcp_server_url: 'http://127.0.0.1:3333/mcp',
        channels: [
          {
            name: 'main',
            probe_status: 'ok',
            details: [{ key: 'address', value: 'http://127.0.0.1:3333/mcp' }],
          },
        ],
        tunnel_metadata_error: null,
      });
    }) as typeof fetch;

    const health = await probeTunnelHealth(
      'http://127.0.0.1:8080',
      'http://127.0.0.1:3333/mcp',
      fetchImplementation,
    );
    expect(health).toEqual({
      healthy: true,
      ready: true,
      tunnelId: 'tunnel_0123456789abcdef',
      mcpUrl: 'http://127.0.0.1:3333/mcp',
      errorCode: null,
    });
  });

  it('reports a stale MCP endpoint as degraded', async () => {
    const fetchImplementation = (async (input: URL | RequestInfo) => {
      if (input.toString().endsWith('/readyz')) {
        return new Response('ready', { status: 200 });
      }
      return Response.json({
        channels: [
          {
            name: 'main',
            probe_status: 'ok',
            details: [{ key: 'address', value: 'http://127.0.0.1:1111/mcp' }],
          },
        ],
        tunnel_metadata_error: null,
      });
    }) as typeof fetch;

    const health = await probeTunnelHealth(
      'http://127.0.0.1:8080',
      'http://127.0.0.1:3333/mcp',
      fetchImplementation,
    );
    expect(health.ready).toBe(false);
    expect(health.errorCode).toBe('mcp_endpoint_mismatch');
  });

  it('rejects non-loopback admin URLs', async () => {
    await expect(
      probeTunnelHealth('https://example.com', 'http://127.0.0.1:3333/mcp'),
    ).rejects.toThrow('loopback');
  });
});
