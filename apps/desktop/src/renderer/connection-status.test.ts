import {
  CONTROL_PROTOCOL_VERSION,
  DesktopStatusSchema,
  EXECUTION_CONTRACT_VERSION,
  MCP_SERVER_VERSION,
} from '@chatsplice/protocol';
import { describe, expect, it } from 'vitest';
import { runtimeConnectionState } from './connection-status.js';

function status() {
  return DesktopStatusSchema.parse({
    runtime_identity: {
      status: 'verified',
      desktop_build_id: 'c'.repeat(64),
      expected_daemon_build_id: 'a'.repeat(64),
      expected_tool_schema_digest: 'b'.repeat(64),
      expected_mcp_descriptor_version: MCP_SERVER_VERSION,
      expected_tool_count: 24,
      app_version: '0.0.2',
    },
    daemon: {
      protocol_version: CONTROL_PROTOCOL_VERSION,
      execution_contract: EXECUTION_CONTRACT_VERSION,
      healthy: true,
      ready: true,
      build_id: 'a'.repeat(64),
      run_id: '00000000-0000-4000-8000-000000000000',
      mcp_descriptor_version: MCP_SERVER_VERSION,
      tool_schema_digest: 'b'.repeat(64),
      tool_count: 24,
      mcp_url: null,
      workspace_count: 0,
      probe_workspace_id: null,
      latest_direct_edits: [],
      latest_mcp_activities: [],
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
    },
    chatgpt_login_confirmed: false,
    credential_store: { available: true, configured: false, error_code: null },
  });
}
describe('local runtime comparison', () => {
  it('requires current ready runtime and complete matching identity evidence', () => {
    expect(runtimeConnectionState(null)).toBe('offline');
    const current = status();
    expect(runtimeConnectionState(current)).toBe('matched');
    current.daemon.ready = false;
    expect(runtimeConnectionState(current)).toBe('offline');
  });
  it('distinguishes older same-contract bytes from catalog incompatibility', () => {
    const current = status();
    current.daemon.build_id = 'd'.repeat(64);
    expect(runtimeConnectionState(current)).toBe('changed');
    current.daemon.tool_schema_digest = 'e'.repeat(64);
    expect(runtimeConnectionState(current)).toBe('incompatible');
  });
  it('does not claim a match when runtime metadata is missing or rebuilt files invalidate the manifest', () => {
    const current = status();
    delete current.daemon.tool_schema_digest;
    expect(runtimeConnectionState(current)).toBe('unverified');
    current.runtime_identity!.status = 'changed';
    expect(runtimeConnectionState(current)).toBe('unverified');
  });
});
