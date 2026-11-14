import {
  CONTROL_PROTOCOL_VERSION,
  EXECUTION_CONTRACT_VERSION,
  type DesktopStatus,
} from '@chatsplice/protocol';

export type RuntimeConnectionState =
  'offline' | 'unverified' | 'changed' | 'incompatible' | 'matched';

export function runtimeConnectionState(status: DesktopStatus | null): RuntimeConnectionState {
  if (status === null || !status.daemon.healthy || !status.daemon.ready) return 'offline';
  const expected = status.runtime_identity;
  if (expected === undefined || expected.status !== 'verified') return 'unverified';
  const actual = status.daemon;
  if (
    actual.protocol_version !== CONTROL_PROTOCOL_VERSION ||
    actual.execution_contract !== EXECUTION_CONTRACT_VERSION ||
    (actual.mcp_descriptor_version !== undefined &&
      actual.mcp_descriptor_version !== expected.expected_mcp_descriptor_version) ||
    (actual.tool_count !== undefined && actual.tool_count !== expected.expected_tool_count) ||
    (actual.tool_schema_digest !== undefined &&
      actual.tool_schema_digest !== expected.expected_tool_schema_digest)
  )
    return 'incompatible';
  if (
    actual.build_id === undefined ||
    actual.run_id === undefined ||
    actual.tool_schema_digest === undefined ||
    actual.mcp_descriptor_version === undefined ||
    actual.tool_count === undefined
  )
    return 'unverified';
  if (actual.build_id !== expected.expected_daemon_build_id) return 'changed';
  return 'matched';
}
