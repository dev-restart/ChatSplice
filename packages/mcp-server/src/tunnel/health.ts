import * as z from 'zod/v4';

const TunnelAdminStatusSchema = z
  .object({
    control_plane_tunnel_id: z.string().optional(),
    mcp_server_url: z.string().optional(),
    channels: z
      .array(
        z
          .object({
            name: z.string(),
            probe_status: z.string().optional(),
            details: z
              .array(z.object({ key: z.string(), value: z.string() }).passthrough())
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
    tunnel_metadata_error: z.unknown().nullable().optional(),
  })
  .passthrough();

export interface TunnelHealthSnapshot {
  readonly healthy: boolean;
  readonly ready: boolean;
  readonly tunnelId: string | null;
  readonly mcpUrl: string | null;
  readonly errorCode: string | null;
}

function safeErrorCode(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return 'tunnel_metadata_error';
  }
  for (const key of ['error_code', 'code', 'status'] as const) {
    const candidate = Reflect.get(value, key);
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate.slice(0, 160);
    }
  }
  return 'tunnel_metadata_error';
}

function assertLoopbackAdminUrl(value: string): URL {
  const url = new URL(value);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== '') {
    throw new Error('Tunnel admin URL must be an unauthenticated loopback HTTP URL.');
  }
  return url;
}

export async function probeTunnelHealth(
  adminUrl: string,
  expectedMcpUrl: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<TunnelHealthSnapshot> {
  const base = assertLoopbackAdminUrl(adminUrl);
  const signal = AbortSignal.timeout(1_500);
  const [readyResponse, statusResponse] = await Promise.all([
    fetchImplementation(new URL('/readyz', base), { signal }),
    fetchImplementation(new URL('/api/status', base), { signal }),
  ]);
  if (!statusResponse.ok) {
    return {
      healthy: false,
      ready: false,
      tunnelId: null,
      mcpUrl: null,
      errorCode: `admin_http_${statusResponse.status}`,
    };
  }

  const payload = TunnelAdminStatusSchema.parse(await statusResponse.json());
  const mainChannel = payload.channels?.find((channel) => channel.name === 'main');
  const address = mainChannel?.details?.find((detail) => detail.key === 'address')?.value;
  const observedMcpUrl = address ?? payload.mcp_server_url ?? null;
  const metadataError = payload.tunnel_metadata_error;
  const endpointMatches = observedMcpUrl === expectedMcpUrl;
  const ready =
    readyResponse.ok &&
    metadataError == null &&
    mainChannel?.probe_status === 'ok' &&
    endpointMatches;

  return {
    healthy: true,
    ready,
    tunnelId: payload.control_plane_tunnel_id ?? null,
    mcpUrl: observedMcpUrl,
    errorCode:
      metadataError != null
        ? safeErrorCode(metadataError)
        : endpointMatches
          ? mainChannel?.probe_status === 'ok'
            ? readyResponse.ok
              ? null
              : `ready_http_${readyResponse.status}`
            : 'mcp_probe_not_ready'
          : 'mcp_endpoint_mismatch',
  };
}
